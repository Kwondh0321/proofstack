import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  ArtifactMetadataSchema,
  type ArtifactMetadata,
  OpaqueIdSchema,
} from "@proofstack/contracts";
import {
  ARTIFACT_ENCRYPTION_VERSION,
  type ArtifactDataKeyContext,
  type ArtifactEncryptionPlan,
  type ArtifactKeyProvider,
  type EncryptedArtifactObject,
  type ArtifactObjectReceipt,
  type WrappedArtifactDataKey,
} from "./artifact-ports.js";
import {
  ArtifactContentMismatchError,
  ArtifactKeyringConfigurationError,
  ArtifactProtectionError,
} from "./errors.js";

const ARTIFACT_AAD_VERSION = "proofstack-artifact-aad-v1";
const ARTIFACT_KEY_WRAP_AAD_VERSION = "proofstack-artifact-key-wrap-v1";
const ARTIFACT_OBJECT_MAGIC = Buffer.from("PSA1", "ascii");
const DATA_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_LOCAL_ARTIFACT_KEYS = 8;

export type ArtifactRandomSource = (size: number) => Uint8Array;

export interface LocalArtifactKeyringOptions {
  readonly activeKeyId: string;
  readonly keys: Readonly<Record<string, Uint8Array>>;
  readonly randomSource?: ArtifactRandomSource;
}

function protectionError(cause?: unknown): ArtifactProtectionError {
  return new ArtifactProtectionError(cause === undefined ? undefined : { cause });
}

function exactRandomBytes(source: ArtifactRandomSource, size: number): Buffer {
  let value: Uint8Array;
  try {
    value = source(size);
  } catch (error) {
    throw protectionError(error);
  }
  if (!(value instanceof Uint8Array) || value.byteLength !== size) throw protectionError();
  return Buffer.from(value);
}

function decodeBase64Url(value: string, expectedBytes: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw protectionError();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== expectedBytes || decoded.toString("base64url") !== value) {
    throw protectionError();
  }
  return decoded;
}

function validateContext(context: ArtifactDataKeyContext): void {
  if (
    !OpaqueIdSchema.safeParse(context.tenantId).success ||
    !OpaqueIdSchema.safeParse(context.artifactId).success ||
    !(context.authenticatedData instanceof Uint8Array) ||
    context.authenticatedData.byteLength === 0 ||
    context.authenticatedData.byteLength > 65_536
  ) {
    throw protectionError();
  }
}

function validateWrappedDataKey(wrapped: WrappedArtifactDataKey): void {
  if (wrapped.algorithm !== "A256GCM" || !OpaqueIdSchema.safeParse(wrapped.keyId).success) {
    throw protectionError();
  }
  decodeBase64Url(wrapped.ciphertext, DATA_KEY_BYTES);
  decodeBase64Url(wrapped.nonce, GCM_NONCE_BYTES);
  decodeBase64Url(wrapped.tag, GCM_TAG_BYTES);
}

function canonicalRedaction(metadata: ArtifactMetadata): unknown {
  if (metadata.redaction.status !== "applied") return { status: metadata.redaction.status };
  return {
    records: metadata.redaction.records.map((record) => ({
      changedPaths: [...record.changedPaths],
      matchCount: record.matchCount,
      rulesetId: record.rulesetId,
      rulesetVersion: record.rulesetVersion,
      stage: record.stage,
    })),
    status: metadata.redaction.status,
  };
}

function canonicalRetention(metadata: ArtifactMetadata): unknown {
  return metadata.retention.mode === "retain"
    ? { mode: metadata.retention.mode }
    : { expiresAt: metadata.retention.expiresAt, mode: metadata.retention.mode };
}

export function artifactAuthenticatedData(metadata: ArtifactMetadata): Uint8Array {
  const parsed = ArtifactMetadataSchema.safeParse(metadata);
  if (!parsed.success) throw protectionError(parsed.error);
  const value = parsed.data;
  return Buffer.from(
    JSON.stringify({
      artifactId: value.contentReference.artifactId,
      classification: value.contentReference.classification,
      environmentId: value.scope.environmentId,
      mediaType: value.contentReference.mediaType,
      projectId: value.scope.projectId,
      redaction: canonicalRedaction(value),
      retention: canonicalRetention(value),
      schemaVersion: value.schemaVersion,
      sha256: value.contentReference.sha256,
      sizeBytes: value.contentReference.sizeBytes,
      tenantId: value.scope.tenantId,
      version: ARTIFACT_AAD_VERSION,
    }),
    "utf8",
  );
}

function keyContext(
  metadata: ArtifactMetadata,
  authenticatedData: Uint8Array,
): ArtifactDataKeyContext {
  return {
    artifactId: metadata.contentReference.artifactId,
    authenticatedData,
    tenantId: metadata.scope.tenantId,
  };
}

function contentReceipt(value: Uint8Array): ArtifactObjectReceipt {
  return {
    sha256: createHash("sha256").update(value).digest("hex"),
    sizeBytes: value.byteLength,
  };
}

function assertReservedContent(metadata: ArtifactMetadata, plaintext: Uint8Array): void {
  const actual = contentReceipt(plaintext);
  if (
    actual.sizeBytes !== metadata.contentReference.sizeBytes ||
    actual.sha256 !== metadata.contentReference.sha256
  ) {
    throw new ArtifactContentMismatchError();
  }
}

function validatePlan(plan: ArtifactEncryptionPlan): Buffer {
  if (plan.version !== ARTIFACT_ENCRYPTION_VERSION) throw protectionError();
  validateWrappedDataKey(plan.wrappedDataKey);
  return decodeBase64Url(plan.contentNonce, GCM_NONCE_BYTES);
}

function validDataKey(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== DATA_KEY_BYTES) {
    throw protectionError();
  }
  return Buffer.from(value);
}

function parseEncryptedObject(value: Uint8Array): {
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
} {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength <= ARTIFACT_OBJECT_MAGIC.length + GCM_TAG_BYTES
  ) {
    throw protectionError();
  }
  const bytes = Buffer.from(value);
  const magic = bytes.subarray(0, ARTIFACT_OBJECT_MAGIC.length);
  if (!timingSafeEqual(magic, ARTIFACT_OBJECT_MAGIC)) throw protectionError();
  return {
    ciphertext: bytes.subarray(ARTIFACT_OBJECT_MAGIC.length + GCM_TAG_BYTES),
    tag: bytes.subarray(ARTIFACT_OBJECT_MAGIC.length, ARTIFACT_OBJECT_MAGIC.length + GCM_TAG_BYTES),
  };
}

export class ArtifactCipher {
  constructor(
    private readonly keyProvider: ArtifactKeyProvider,
    private readonly randomSource: ArtifactRandomSource = randomBytes,
  ) {}

  async createPlan(metadata: ArtifactMetadata): Promise<ArtifactEncryptionPlan> {
    const authenticatedData = artifactAuthenticatedData(metadata);
    const context = keyContext(metadata, authenticatedData);
    const dataKey = exactRandomBytes(this.randomSource, DATA_KEY_BYTES);
    try {
      const wrappedDataKey = await this.keyProvider.wrapDataKey(dataKey, context);
      validateWrappedDataKey(wrappedDataKey);
      return {
        contentNonce: exactRandomBytes(this.randomSource, GCM_NONCE_BYTES).toString("base64url"),
        version: ARTIFACT_ENCRYPTION_VERSION,
        wrappedDataKey,
      };
    } catch (error) {
      if (error instanceof ArtifactProtectionError) throw error;
      throw protectionError(error);
    } finally {
      dataKey.fill(0);
    }
  }

  async encrypt(
    metadata: ArtifactMetadata,
    plan: ArtifactEncryptionPlan,
    plaintext: Uint8Array,
  ): Promise<EncryptedArtifactObject> {
    assertReservedContent(metadata, plaintext);
    const authenticatedData = artifactAuthenticatedData(metadata);
    const nonce = validatePlan(plan);
    let dataKey: Buffer | undefined;
    try {
      dataKey = validDataKey(
        await this.keyProvider.unwrapDataKey(
          plan.wrappedDataKey,
          keyContext(metadata, authenticatedData),
        ),
      );
      const cipher = createCipheriv("aes-256-gcm", dataKey, nonce, {
        authTagLength: GCM_TAG_BYTES,
      });
      cipher.setAAD(authenticatedData, { plaintextLength: plaintext.byteLength });
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const bytes = Buffer.concat([ARTIFACT_OBJECT_MAGIC, cipher.getAuthTag(), ciphertext]);
      return { bytes, receipt: contentReceipt(bytes) };
    } catch (error) {
      if (error instanceof ArtifactProtectionError) throw error;
      throw protectionError(error);
    } finally {
      dataKey?.fill(0);
    }
  }

  async decrypt(
    metadata: ArtifactMetadata,
    plan: ArtifactEncryptionPlan,
    encryptedObject: Uint8Array,
  ): Promise<Uint8Array> {
    const authenticatedData = artifactAuthenticatedData(metadata);
    const nonce = validatePlan(plan);
    const encrypted = parseEncryptedObject(encryptedObject);
    let dataKey: Buffer | undefined;
    try {
      dataKey = validDataKey(
        await this.keyProvider.unwrapDataKey(
          plan.wrappedDataKey,
          keyContext(metadata, authenticatedData),
        ),
      );
      const decipher = createDecipheriv("aes-256-gcm", dataKey, nonce, {
        authTagLength: GCM_TAG_BYTES,
      });
      decipher.setAAD(authenticatedData, {
        plaintextLength: metadata.contentReference.sizeBytes,
      });
      decipher.setAuthTag(encrypted.tag);
      const plaintext = Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
      const actual = contentReceipt(plaintext);
      if (
        actual.sizeBytes !== metadata.contentReference.sizeBytes ||
        actual.sha256 !== metadata.contentReference.sha256
      ) {
        throw protectionError();
      }
      return Uint8Array.from(plaintext);
    } catch (error) {
      if (error instanceof ArtifactProtectionError) throw error;
      throw protectionError(error);
    } finally {
      dataKey?.fill(0);
    }
  }
}

function keyWrapAuthenticatedData(context: ArtifactDataKeyContext): Buffer {
  validateContext(context);
  return Buffer.concat([
    Buffer.from(`${ARTIFACT_KEY_WRAP_AAD_VERSION}\0`, "utf8"),
    Buffer.from(context.authenticatedData),
  ]);
}

export class LocalArtifactKeyring implements ArtifactKeyProvider {
  private readonly active: string;
  private readonly keys = new Map<string, Buffer>();
  private readonly randomSource: ArtifactRandomSource;

  constructor(options: LocalArtifactKeyringOptions) {
    const entries = Object.entries(options.keys);
    if (
      !OpaqueIdSchema.safeParse(options.activeKeyId).success ||
      entries.length === 0 ||
      entries.length > MAX_LOCAL_ARTIFACT_KEYS
    ) {
      throw new ArtifactKeyringConfigurationError();
    }

    const material = new Set<string>();
    for (const [keyId, key] of entries) {
      if (
        !OpaqueIdSchema.safeParse(keyId).success ||
        !(key instanceof Uint8Array) ||
        key.byteLength !== DATA_KEY_BYTES
      ) {
        throw new ArtifactKeyringConfigurationError();
      }
      const copied = Buffer.from(key);
      const fingerprint = createHash("sha256").update(copied).digest("hex");
      if (material.has(fingerprint)) throw new ArtifactKeyringConfigurationError();
      material.add(fingerprint);
      this.keys.set(keyId, copied);
    }
    if (!this.keys.has(options.activeKeyId)) throw new ArtifactKeyringConfigurationError();

    this.active = options.activeKeyId;
    this.randomSource = options.randomSource ?? randomBytes;
  }

  async activeKeyId(): Promise<string> {
    return this.active;
  }

  async wrapDataKey(
    dataKey: Uint8Array,
    context: ArtifactDataKeyContext,
  ): Promise<WrappedArtifactDataKey> {
    const key = this.keys.get(this.active);
    if (!key || !(dataKey instanceof Uint8Array) || dataKey.byteLength !== DATA_KEY_BYTES) {
      throw protectionError();
    }
    const nonce = exactRandomBytes(this.randomSource, GCM_NONCE_BYTES);
    try {
      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: GCM_TAG_BYTES });
      cipher.setAAD(keyWrapAuthenticatedData(context), { plaintextLength: dataKey.byteLength });
      const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
      return {
        algorithm: "A256GCM",
        ciphertext: ciphertext.toString("base64url"),
        keyId: this.active,
        nonce: nonce.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
      };
    } catch (error) {
      if (error instanceof ArtifactProtectionError) throw error;
      throw protectionError(error);
    }
  }

  async unwrapDataKey(
    wrapped: WrappedArtifactDataKey,
    context: ArtifactDataKeyContext,
  ): Promise<Uint8Array> {
    validateWrappedDataKey(wrapped);
    const key = this.keys.get(wrapped.keyId);
    if (!key) throw protectionError();
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        decodeBase64Url(wrapped.nonce, GCM_NONCE_BYTES),
        { authTagLength: GCM_TAG_BYTES },
      );
      decipher.setAAD(keyWrapAuthenticatedData(context), { plaintextLength: DATA_KEY_BYTES });
      decipher.setAuthTag(decodeBase64Url(wrapped.tag, GCM_TAG_BYTES));
      const dataKey = Buffer.concat([
        decipher.update(decodeBase64Url(wrapped.ciphertext, DATA_KEY_BYTES)),
        decipher.final(),
      ]);
      return Uint8Array.from(dataKey);
    } catch (error) {
      if (error instanceof ArtifactProtectionError) throw error;
      throw protectionError(error);
    }
  }
}
