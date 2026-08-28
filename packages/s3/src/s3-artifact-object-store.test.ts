import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES } from "@proofstack/artifacts";
import { artifactObjectStoreConformanceCases } from "@proofstack/artifacts/testing";
import { describe, expect, it, vi } from "vitest";
import {
  createS3ArtifactObjectStore,
  S3ArtifactObjectInputError,
  S3ArtifactObjectIntegrityError,
  S3ArtifactObjectStore,
  S3ArtifactObjectStoreError,
} from "./s3-artifact-object-store.js";

type S3ArtifactClient = Pick<S3Client, "destroy" | "send">;

function sdkError(status: number, name = "S3ServiceError"): Error {
  return Object.assign(new Error(name), {
    $metadata: { httpStatusCode: status },
    name,
  });
}

function sha256Base64(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("base64");
}

function responseBody(
  value: Uint8Array,
  options: { readonly cancel?: () => unknown; readonly destroy?: () => unknown } = {},
): GetObjectCommandOutput["Body"] {
  return {
    ...options,
    async *[Symbol.asyncIterator]() {
      yield Uint8Array.from(value);
    },
    transformToByteArray: async () => Uint8Array.from(value),
  } as unknown as GetObjectCommandOutput["Body"];
}

class StatefulFakeS3Client {
  readonly commands: unknown[] = [];
  readonly destroy = vi.fn();
  readonly objects = new Map<string, Uint8Array>();

  async send(command: unknown): Promise<unknown> {
    this.commands.push(command);
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key ?? "";
      const existing = this.objects.get(key);
      if (command.input.IfNoneMatch === "*" && existing) throw sdkError(412, "PreconditionFailed");
      const body = command.input.Body;
      if (!(body instanceof Uint8Array)) throw sdkError(400, "InvalidBody");
      this.objects.set(key, Uint8Array.from(body));
      return { ChecksumSHA256: command.input.ChecksumSHA256, $metadata: { httpStatusCode: 200 } };
    }
    if (command instanceof GetObjectCommand) {
      const value = this.objects.get(command.input.Key ?? "");
      if (!value) throw sdkError(404, "NoSuchKey");
      return {
        Body: responseBody(value),
        ChecksumSHA256: sha256Base64(value),
        ContentLength: value.byteLength,
        $metadata: { httpStatusCode: 200 },
      };
    }
    if (command instanceof DeleteObjectCommand) {
      const key = command.input.Key ?? "";
      if (!this.objects.has(key)) throw sdkError(412, "PreconditionFailed");
      this.objects.delete(key);
      return { $metadata: { httpStatusCode: 204 } };
    }
    throw new Error("unsupported command");
  }

  asClient(): S3ArtifactClient {
    return this as unknown as S3ArtifactClient;
  }
}

function scriptedClient(implementation: (command: unknown) => Promise<unknown>): S3ArtifactClient {
  return {
    destroy: vi.fn(),
    send: vi.fn(implementation) as unknown as S3ArtifactClient["send"],
  };
}

describe("S3ArtifactObjectStore", () => {
  for (const testCase of artifactObjectStoreConformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(() => {
        const client = new StatefulFakeS3Client();
        return {
          dispose: async () => client.destroy(),
          store: new S3ArtifactObjectStore(client.asClient(), { bucket: "proofstack-test" }),
        };
      });
    });
  }

  it("uses only conditional exact-key commands with an expected owner and end-to-end checksum", async () => {
    const client = new StatefulFakeS3Client();
    const store = new S3ArtifactObjectStore(client.asClient(), {
      bucket: "proofstack-test",
      expectedBucketOwner: "123456789012",
    });
    const value = Uint8Array.from([1, 2, 3]);

    await store.putIfAbsent("objects/v1/ab/object", value);
    await store.get("objects/v1/ab/object");
    await store.delete("objects/v1/ab/object");

    const put = client.commands[0];
    const get = client.commands[1];
    const deletion = client.commands[2];
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(get).toBeInstanceOf(GetObjectCommand);
    expect(deletion).toBeInstanceOf(DeleteObjectCommand);
    if (!(put instanceof PutObjectCommand)) throw new Error("expected put command");
    if (!(get instanceof GetObjectCommand)) throw new Error("expected get command");
    if (!(deletion instanceof DeleteObjectCommand)) throw new Error("expected delete command");
    expect(put.input).toMatchObject({
      Body: value,
      Bucket: "proofstack-test",
      ChecksumAlgorithm: "SHA256",
      ChecksumSHA256: sha256Base64(value),
      ContentLength: 3,
      ContentType: "application/octet-stream",
      ExpectedBucketOwner: "123456789012",
      IfNoneMatch: "*",
      Key: "objects/v1/ab/object",
    });
    expect(get.input).toEqual({
      Bucket: "proofstack-test",
      ChecksumMode: "ENABLED",
      ExpectedBucketOwner: "123456789012",
      Key: "objects/v1/ab/object",
      Range: `bytes=0-${MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES}`,
    });
    expect(deletion.input).toEqual({
      Bucket: "proofstack-test",
      ExpectedBucketOwner: "123456789012",
      IfMatch: "*",
      Key: "objects/v1/ab/object",
    });
  });

  it.each([
    "ab",
    "UPPERCASE",
    "bucket_name",
    "192.0.2.1",
    "-leading",
    "trailing-",
    "two..dots",
    "bad.-label",
    "x".repeat(64),
  ])("rejects invalid bucket %s before accessing S3", (bucket) => {
    const client = new StatefulFakeS3Client();
    expect(() => new S3ArtifactObjectStore(client.asClient(), { bucket })).toThrow(
      S3ArtifactObjectInputError,
    );
    expect(client.commands).toHaveLength(0);
  });

  it.each([
    "",
    "/leading",
    "trailing/",
    "objects//double",
    "objects/../escape",
    "objects/object.json",
    "한글",
    `objects/${"a".repeat(1_017)}`,
  ])("rejects invalid service object key %s", async (objectKey) => {
    const client = new StatefulFakeS3Client();
    const store = new S3ArtifactObjectStore(client.asClient(), { bucket: "proofstack-test" });
    await expect(store.get(objectKey)).rejects.toBeInstanceOf(S3ArtifactObjectInputError);
    expect(client.commands).toHaveLength(0);
  });

  it("rejects invalid runtime store limits and identifiers", () => {
    const client = new StatefulFakeS3Client().asClient();
    expect(
      () =>
        new S3ArtifactObjectStore(client, {
          bucket: "proofstack-test",
          conditionalRequestAttempts: 0,
        }),
    ).toThrow(S3ArtifactObjectInputError);
    expect(
      () =>
        new S3ArtifactObjectStore(client, {
          bucket: "proofstack-test",
          conditionalRequestAttempts: 6,
        }),
    ).toThrow(S3ArtifactObjectInputError);
    expect(
      () => new S3ArtifactObjectStore(client, { bucket: "proofstack-test", maxObjectBytes: 0 }),
    ).toThrow(S3ArtifactObjectInputError);
    expect(
      () =>
        new S3ArtifactObjectStore(client, {
          bucket: "proofstack-test",
          maxObjectBytes: MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES + 1,
        }),
    ).toThrow(S3ArtifactObjectInputError);
    expect(
      () =>
        new S3ArtifactObjectStore(client, {
          bucket: "proofstack-test",
          expectedBucketOwner: "not-an-account",
        }),
    ).toThrow(S3ArtifactObjectInputError);
  });

  it("rejects oversized or non-byte ciphertext before accessing S3", async () => {
    const client = new StatefulFakeS3Client();
    const store = new S3ArtifactObjectStore(client.asClient(), {
      bucket: "proofstack-test",
      maxObjectBytes: 3,
    });

    await expect(
      store.putIfAbsent("objects/v1/ab/object", Uint8Array.from([1, 2, 3, 4])),
    ).rejects.toBeInstanceOf(S3ArtifactObjectInputError);
    await expect(
      store.putIfAbsent("objects/v1/ab/object", "bytes" as unknown as Uint8Array),
    ).rejects.toBeInstanceOf(S3ArtifactObjectInputError);
    expect(client.commands).toHaveLength(0);
  });

  it("retries conditional write conflicts and resolves the winning object", async () => {
    const existing = Uint8Array.from([9, 8, 7]);
    let sends = 0;
    const client = scriptedClient(async (command) => {
      sends += 1;
      if (command instanceof PutObjectCommand) throw sdkError(409, "ConditionalRequestConflict");
      if (command instanceof GetObjectCommand && sends < 4) throw sdkError(404, "NoSuchKey");
      if (command instanceof GetObjectCommand) {
        return {
          Body: responseBody(existing),
          ContentLength: existing.byteLength,
          $metadata: { httpStatusCode: 200 },
        };
      }
      throw new Error("unexpected command");
    });
    const store = new S3ArtifactObjectStore(client, {
      bucket: "proofstack-test",
      conditionalRequestAttempts: 3,
    });

    await expect(
      store.putIfAbsent("objects/v1/ab/object", Uint8Array.from([1, 2, 3])),
    ).resolves.toEqual({
      created: false,
      receipt: {
        sha256: createHash("sha256").update(existing).digest("hex"),
        sizeBytes: existing.byteLength,
      },
    });
    expect(sends).toBe(4);
  });

  it("fails closed after bounded conditional write and delete conflicts", async () => {
    const conflict = sdkError(409, "ConditionalRequestConflict");
    const client = scriptedClient(async (command) => {
      if (command instanceof GetObjectCommand) throw sdkError(404, "NoSuchKey");
      throw conflict;
    });
    const store = new S3ArtifactObjectStore(client, {
      bucket: "proofstack-test",
      conditionalRequestAttempts: 2,
    });

    await expect(
      store.putIfAbsent("objects/v1/ab/write", Uint8Array.from([1])),
    ).rejects.toMatchObject({ cause: conflict, operation: "put" });
    await expect(store.delete("objects/v1/ab/delete")).rejects.toMatchObject({
      cause: conflict,
      operation: "delete",
    });
  });

  it.each([404, 412])("reports a missing conditional delete for HTTP %i", async (status) => {
    const client = scriptedClient(async () => {
      throw sdkError(status);
    });
    const store = new S3ArtifactObjectStore(client, { bucket: "proofstack-test" });

    await expect(store.delete("objects/v1/ab/object")).resolves.toEqual({ deleted: false });
  });

  it("wraps unexpected SDK failures without exposing the object key", async () => {
    const cause = new Error("credential provider failed");
    const client = scriptedClient(async () => {
      throw cause;
    });
    const store = new S3ArtifactObjectStore(client, { bucket: "proofstack-test" });

    const failure = await store.get("objects/v1/ab/private-token").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(S3ArtifactObjectStoreError);
    expect(failure).toMatchObject({ cause, operation: "get" });
    expect(String(failure)).not.toContain("private-token");

    await expect(store.delete("objects/v1/ab/private-token")).rejects.toMatchObject({
      cause,
      operation: "delete",
    });
    await expect(
      store.putIfAbsent("objects/v1/ab/private-token", Uint8Array.from([1])),
    ).rejects.toMatchObject({ cause, operation: "put" });
  });

  it("normalizes a non-Error SDK rejection", async () => {
    const client = scriptedClient(async () => {
      throw "transport unavailable";
    });
    const store = new S3ArtifactObjectStore(client, { bucket: "proofstack-test" });

    await expect(store.get("objects/v1/ab/object")).rejects.toMatchObject({
      cause: "transport unavailable",
      operation: "get",
    });
  });

  it.each([
    { Body: undefined, ContentLength: 1 },
    {
      Body: {
        transformToByteArray: async () => Uint8Array.from([1]),
      } as unknown as GetObjectCommandOutput["Body"],
      ContentLength: 1,
    },
    { Body: responseBody(Uint8Array.from([1])), ContentLength: undefined },
    { Body: responseBody(Uint8Array.from([1])), ContentLength: -1 },
    { Body: responseBody(Uint8Array.from([])), ContentLength: 1 },
    { Body: responseBody(Uint8Array.from([1, 2])), ContentLength: 1 },
    {
      Body: responseBody(Uint8Array.from([1])),
      ChecksumSHA256: sha256Base64(Uint8Array.from([2])),
      ContentLength: 1,
    },
    {
      Body: {
        async *[Symbol.asyncIterator]() {
          yield "not bytes";
        },
        transformToByteArray: async () => Uint8Array.from([1]),
      } as unknown as GetObjectCommandOutput["Body"],
      ContentLength: 1,
    },
  ])("rejects a malformed or integrity-mismatched read response %#", async (output) => {
    const client = scriptedClient(async () => output);
    const store = new S3ArtifactObjectStore(client, { bucket: "proofstack-test" });

    await expect(store.get("objects/v1/ab/object")).rejects.toBeInstanceOf(
      S3ArtifactObjectIntegrityError,
    );
  });

  it("rejects oversized response metadata without consuming the body and releases its stream", async () => {
    const destroy = vi.fn();
    const iterate = vi.fn();
    const body = {
      destroy,
      [Symbol.asyncIterator]: iterate,
      transformToByteArray: vi.fn(async () => Uint8Array.from([1])),
    } as unknown as GetObjectCommandOutput["Body"];
    const client = scriptedClient(async () => ({
      Body: body,
      ContentLength: MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES + 1,
    }));
    const store = new S3ArtifactObjectStore(client, { bucket: "proofstack-test" });

    await expect(store.get("objects/v1/ab/object")).rejects.toBeInstanceOf(
      S3ArtifactObjectIntegrityError,
    );
    expect(destroy).toHaveBeenCalledOnce();
    expect(iterate).not.toHaveBeenCalled();
  });

  it("releases a delete-marker stream and treats it as missing", async () => {
    const cancel = vi.fn(async () => undefined);
    const client = scriptedClient(async () => ({
      Body: responseBody(Uint8Array.from([1]), { cancel }),
      DeleteMarker: true,
    }));
    const store = new S3ArtifactObjectStore(client, { bucket: "proofstack-test" });

    await expect(store.get("objects/v1/ab/object")).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not let a stream release failure hide the integrity error", async () => {
    const client = scriptedClient(async () => ({
      Body: responseBody(Uint8Array.from([1]), {
        destroy: () => {
          throw new Error("destroy failed");
        },
      }),
      ContentLength: undefined,
    }));
    const store = new S3ArtifactObjectStore(client, { bucket: "proofstack-test" });

    await expect(store.get("objects/v1/ab/object")).rejects.toBeInstanceOf(
      S3ArtifactObjectIntegrityError,
    );
  });

  it("rejects a mismatched write response checksum", async () => {
    const client = scriptedClient(async () => ({ ChecksumSHA256: "incorrect" }));
    const store = new S3ArtifactObjectStore(client, { bucket: "proofstack-test" });

    await expect(
      store.putIfAbsent("objects/v1/ab/object", Uint8Array.from([1, 2, 3])),
    ).rejects.toBeInstanceOf(S3ArtifactObjectIntegrityError);
  });

  it("destroys an owned client and cleans it up when factory validation fails", () => {
    const client = new StatefulFakeS3Client();
    const store = new S3ArtifactObjectStore(client.asClient(), { bucket: "proofstack-test" });
    store.destroy();
    expect(client.destroy).toHaveBeenCalledOnce();

    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    try {
      expect(() =>
        createS3ArtifactObjectStore({
          bucket: "invalid_bucket",
          credentials: { accessKeyId: "test", secretAccessKey: "test" },
          region: "local-1",
        }),
      ).toThrow(S3ArtifactObjectInputError);
      const created = createS3ArtifactObjectStore({
        bucket: "proofstack-test",
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
        region: "local-1",
      });
      created.destroy();
      expect(destroy).toHaveBeenCalledTimes(2);
    } finally {
      destroy.mockRestore();
    }
  });
});
