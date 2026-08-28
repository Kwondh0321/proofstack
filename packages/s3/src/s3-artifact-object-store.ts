import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  type ArtifactObjectPutResult,
  type ArtifactObjectReceipt,
  type ArtifactObjectStore,
  MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES,
} from "@proofstack/artifacts";
import { createS3Client, type S3ClientConnectionOptions } from "./s3-client.js";

const DEFAULT_CONDITIONAL_REQUEST_ATTEMPTS = 3;
const MAX_CONDITIONAL_REQUEST_ATTEMPTS = 5;
const MAX_OBJECT_KEY_BYTES = 1_024;

type S3ArtifactClient = Pick<S3Client, "destroy" | "send">;
export type S3ArtifactObjectOperation = "delete" | "get" | "put";

export class S3ArtifactObjectInputError extends Error {
  override readonly name: string = "S3ArtifactObjectInputError";
}

export class S3ArtifactObjectStoreError extends Error {
  override readonly name: string = "S3ArtifactObjectStoreError";

  constructor(
    readonly operation: S3ArtifactObjectOperation,
    options?: ErrorOptions,
  ) {
    super(`S3 artifact object ${operation} operation failed`, options);
  }
}

export class S3ArtifactObjectIntegrityError extends S3ArtifactObjectStoreError {
  override readonly name: string = "S3ArtifactObjectIntegrityError";
}

export interface S3ArtifactObjectStoreOptions {
  readonly bucket: string;
  readonly conditionalRequestAttempts?: number;
  readonly expectedBucketOwner?: string;
  readonly maxObjectBytes?: number;
}

export interface CreateS3ArtifactObjectStoreOptions
  extends S3ArtifactObjectStoreOptions,
    S3ClientConnectionOptions {}

interface ObjectDigest {
  readonly base64: string;
  readonly receipt: ArtifactObjectReceipt;
}

interface RetrievedObject extends ObjectDigest {
  readonly bytes: Uint8Array;
}

function inputError(message: string): S3ArtifactObjectInputError {
  return new S3ArtifactObjectInputError(message);
}

function validateBucket(bucket: string): string {
  if (
    typeof bucket !== "string" ||
    bucket.length < 3 ||
    bucket.length > 63 ||
    bucket.includes("..") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket) ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(bucket) ||
    bucket.split(".").some((label) => label.startsWith("-") || label.endsWith("-"))
  ) {
    throw inputError("S3 artifact bucket must be a valid DNS-style bucket name");
  }
  return bucket;
}

function validateExpectedBucketOwner(value: string | undefined): string | undefined {
  if (value !== undefined && !/^\d{12}$/.test(value)) {
    throw inputError("S3 expected bucket owner must be a 12-digit account identifier");
  }
  return value;
}

function validatePositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw inputError(`${label} must be an integer from 1 to ${maximum}`);
  }
  return resolved;
}

function validateObjectKey(objectKey: string): string {
  if (
    typeof objectKey !== "string" ||
    objectKey.length === 0 ||
    Buffer.byteLength(objectKey, "utf8") > MAX_OBJECT_KEY_BYTES ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9/_-]*[A-Za-z0-9_-])?$/.test(objectKey) ||
    objectKey.includes("//")
  ) {
    throw inputError("S3 artifact object key is invalid");
  }
  return objectKey;
}

function objectDigest(value: Uint8Array): ObjectDigest {
  const digest = createHash("sha256").update(value).digest();
  return {
    base64: digest.toString("base64"),
    receipt: {
      sha256: digest.toString("hex"),
      sizeBytes: value.byteLength,
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function property(value: unknown, key: string): unknown {
  const object = record(value);
  return object ? Reflect.get(object, key) : undefined;
}

function errorStatus(error: unknown): number | undefined {
  const status = property(property(error, "$metadata"), "httpStatusCode");
  return typeof status === "number" ? status : undefined;
}

function errorName(error: unknown): string | undefined {
  const name = property(error, "name");
  return typeof name === "string" ? name : undefined;
}

function isMissing(error: unknown): boolean {
  const name = errorName(error);
  return (
    errorStatus(error) === 404 ||
    name === "NoSuchKey" ||
    name === "NotFound" ||
    name === "NoSuchObject"
  );
}

function isPreconditionFailed(error: unknown): boolean {
  return errorStatus(error) === 412 || errorName(error) === "PreconditionFailed";
}

function isConditionalConflict(error: unknown): boolean {
  return errorStatus(error) === 409 || errorName(error) === "ConditionalRequestConflict";
}

async function releaseBody(body: unknown): Promise<void> {
  try {
    const destroy = property(body, "destroy");
    if (typeof destroy === "function") {
      destroy.call(body);
      return;
    }
    const cancel = property(body, "cancel");
    if (typeof cancel === "function") await cancel.call(body);
  } catch {
    // Releasing a rejected response body must not hide the integrity failure.
  }
}

async function readBoundedBody(
  body: NonNullable<GetObjectCommandOutput["Body"]>,
  expectedBytes: number,
): Promise<Uint8Array> {
  const iterator = Reflect.get(body, Symbol.asyncIterator);
  if (typeof iterator !== "function") throw new S3ArtifactObjectIntegrityError("get");

  const bytes = Buffer.allocUnsafe(expectedBytes);
  let offset = 0;
  try {
    for await (const chunk of body as AsyncIterable<unknown>) {
      if (!(chunk instanceof Uint8Array) || offset + chunk.byteLength > expectedBytes) {
        throw new S3ArtifactObjectIntegrityError("get");
      }
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== expectedBytes) throw new S3ArtifactObjectIntegrityError("get");
    return Uint8Array.from(bytes);
  } catch (error) {
    await releaseBody(body);
    throw error;
  }
}

export class S3ArtifactObjectStore implements ArtifactObjectStore {
  private readonly bucket: string;
  private readonly conditionalRequestAttempts: number;
  private readonly expectedBucketOwner: string | undefined;
  private readonly maxObjectBytes: number;

  constructor(
    private readonly client: S3ArtifactClient,
    options: S3ArtifactObjectStoreOptions,
  ) {
    this.bucket = validateBucket(options.bucket);
    this.conditionalRequestAttempts = validatePositiveInteger(
      options.conditionalRequestAttempts,
      DEFAULT_CONDITIONAL_REQUEST_ATTEMPTS,
      MAX_CONDITIONAL_REQUEST_ATTEMPTS,
      "S3 conditional request attempts",
    );
    this.expectedBucketOwner = validateExpectedBucketOwner(options.expectedBucketOwner);
    this.maxObjectBytes = validatePositiveInteger(
      options.maxObjectBytes,
      MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES,
      MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES,
      "S3 artifact object byte limit",
    );
  }

  destroy(): void {
    this.client.destroy();
  }

  async delete(objectKey: string): Promise<{ readonly deleted: boolean }> {
    const key = validateObjectKey(objectKey);
    let lastError: unknown;
    for (let attempt = 0; attempt < this.conditionalRequestAttempts; attempt += 1) {
      try {
        const input = { Bucket: this.bucket, IfMatch: "*", Key: key };
        if (this.expectedBucketOwner !== undefined) {
          Object.assign(input, { ExpectedBucketOwner: this.expectedBucketOwner });
        }
        await this.client.send(new DeleteObjectCommand(input));
        return { deleted: true };
      } catch (error) {
        if (isMissing(error) || isPreconditionFailed(error)) return { deleted: false };
        if (!isConditionalConflict(error)) {
          throw new S3ArtifactObjectStoreError("delete", { cause: error });
        }
        lastError = error;
      }
    }
    throw new S3ArtifactObjectStoreError("delete", { cause: lastError });
  }

  async get(objectKey: string): Promise<Uint8Array | null> {
    const retrieved = await this.retrieve(validateObjectKey(objectKey));
    return retrieved?.bytes ?? null;
  }

  async putIfAbsent(objectKey: string, ciphertext: Uint8Array): Promise<ArtifactObjectPutResult> {
    const key = validateObjectKey(objectKey);
    if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength > this.maxObjectBytes) {
      throw inputError("S3 artifact ciphertext is invalid or exceeds the configured byte limit");
    }
    const bytes = Uint8Array.from(ciphertext);
    const digest = objectDigest(bytes);
    let lastError: unknown;

    for (let attempt = 0; attempt < this.conditionalRequestAttempts; attempt += 1) {
      try {
        const input = {
          Body: bytes,
          Bucket: this.bucket,
          ChecksumAlgorithm: "SHA256" as const,
          ChecksumSHA256: digest.base64,
          ContentLength: bytes.byteLength,
          ContentType: "application/octet-stream",
          IfNoneMatch: "*",
          Key: key,
        };
        if (this.expectedBucketOwner !== undefined) {
          Object.assign(input, { ExpectedBucketOwner: this.expectedBucketOwner });
        }
        const output = await this.client.send(new PutObjectCommand(input));
        if (output.ChecksumSHA256 !== undefined && output.ChecksumSHA256 !== digest.base64) {
          throw new S3ArtifactObjectIntegrityError("put");
        }
        return { created: true, receipt: digest.receipt };
      } catch (error) {
        if (error instanceof S3ArtifactObjectIntegrityError) throw error;
        if (!isMissing(error) && !isPreconditionFailed(error) && !isConditionalConflict(error)) {
          throw new S3ArtifactObjectStoreError("put", { cause: error });
        }
        lastError = error;
        const existing = await this.retrieve(key);
        if (existing) return { created: false, receipt: existing.receipt };
      }
    }
    throw new S3ArtifactObjectStoreError("put", { cause: lastError });
  }

  private async retrieve(key: string): Promise<RetrievedObject | null> {
    try {
      const input = {
        Bucket: this.bucket,
        ChecksumMode: "ENABLED" as const,
        Key: key,
        Range: `bytes=0-${this.maxObjectBytes}`,
      };
      if (this.expectedBucketOwner !== undefined) {
        Object.assign(input, { ExpectedBucketOwner: this.expectedBucketOwner });
      }
      const output: GetObjectCommandOutput = await this.client.send(new GetObjectCommand(input));
      if (output.DeleteMarker === true) {
        await releaseBody(output.Body);
        return null;
      }
      const contentLength = output.ContentLength;
      if (
        typeof contentLength !== "number" ||
        !Number.isSafeInteger(contentLength) ||
        contentLength < 0 ||
        contentLength > this.maxObjectBytes ||
        output.Body === undefined
      ) {
        await releaseBody(output.Body);
        throw new S3ArtifactObjectIntegrityError("get");
      }

      const bytes = await readBoundedBody(output.Body, contentLength);
      const digest = objectDigest(bytes);
      if (output.ChecksumSHA256 !== undefined && output.ChecksumSHA256 !== digest.base64) {
        throw new S3ArtifactObjectIntegrityError("get");
      }
      return { ...digest, bytes: Uint8Array.from(bytes) };
    } catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof S3ArtifactObjectStoreError) throw error;
      throw new S3ArtifactObjectStoreError("get", { cause: error });
    }
  }
}

export function createS3ArtifactObjectStore(
  options: CreateS3ArtifactObjectStoreOptions,
): S3ArtifactObjectStore {
  const client = createS3Client(options);
  try {
    return new S3ArtifactObjectStore(client, options);
  } catch (error) {
    client.destroy();
    throw error;
  }
}
