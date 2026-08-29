import {
  type ArtifactMetadata,
  type ArtifactOwnership,
  type ArtifactTombstone,
  type EvidenceScope,
  MAX_ARTIFACT_CONTENT_BYTES,
} from "@proofstack/contracts";

export const ARTIFACT_ENCRYPTION_VERSION = "a256gcm-v1" as const;
export const ARTIFACT_OBJECT_FORMAT_OVERHEAD_BYTES = 20;
export const MAX_ENCRYPTED_ARTIFACT_OBJECT_BYTES =
  MAX_ARTIFACT_CONTENT_BYTES + ARTIFACT_OBJECT_FORMAT_OVERHEAD_BYTES;
export const MAX_ARTIFACT_MAINTENANCE_BATCH_SIZE = 100;

export function artifactReservationIdentity(metadata: ArtifactMetadata): unknown {
  return {
    contentReference: metadata.contentReference,
    redaction: metadata.redaction,
    retention:
      metadata.retention.mode === "expire"
        ? {
            expiresAt: new Date(metadata.retention.expiresAt).toISOString(),
            mode: metadata.retention.mode,
          }
        : metadata.retention,
    schemaVersion: metadata.schemaVersion,
    scope: metadata.scope,
  };
}

export interface WrappedArtifactDataKey {
  readonly algorithm: "A256GCM";
  readonly ciphertext: string;
  readonly keyId: string;
  readonly nonce: string;
  readonly tag: string;
}

export interface ArtifactEncryptionPlan {
  readonly contentNonce: string;
  readonly version: typeof ARTIFACT_ENCRYPTION_VERSION;
  readonly wrappedDataKey: WrappedArtifactDataKey;
}

export interface ArtifactEncryptionPlanner {
  createPlan(metadata: ArtifactMetadata): Promise<ArtifactEncryptionPlan>;
}

export interface EncryptedArtifactObject {
  readonly bytes: Uint8Array;
  readonly receipt: ArtifactObjectReceipt;
}

export interface ArtifactContentEncryptor {
  encrypt(
    metadata: ArtifactMetadata,
    plan: ArtifactEncryptionPlan,
    plaintext: Uint8Array,
  ): Promise<EncryptedArtifactObject>;
}

export interface ArtifactContentDecryptor {
  decrypt(
    metadata: ArtifactMetadata,
    plan: ArtifactEncryptionPlan,
    encryptedObject: Uint8Array,
  ): Promise<Uint8Array>;
}

export interface ArtifactObjectReceipt {
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ArtifactCatalogEntry {
  readonly createdByPrincipalId: string;
  readonly encryption: ArtifactEncryptionPlan;
  readonly metadata: ArtifactMetadata;
  readonly objectKey: string;
  readonly objectReceipt?: ArtifactObjectReceipt;
  /** Append-only fixture ownership, when the artifact has been claimed by a coordinated publisher. */
  readonly ownership?: ArtifactOwnership;
}

export interface ReserveArtifactCatalogResult {
  readonly created: boolean;
  readonly entry: ArtifactCatalogEntry;
}

export interface TombstoneArtifactCatalogResult {
  readonly created: boolean;
  readonly entry: ArtifactCatalogEntry;
  readonly tombstone: ArtifactTombstone;
}

export interface ArtifactPurgeReceipt {
  readonly artifactId: string;
  readonly objectWasPresent: boolean;
  readonly occurredAt: string;
  readonly purgeId: string;
}

export interface ArtifactKeyReferenceCounts {
  readonly available: number;
  readonly purged: number;
  readonly reserved: number;
  readonly tombstoned: number;
  readonly total: number;
}

export interface ArtifactKeyReferenceSummary {
  readonly counts: ArtifactKeyReferenceCounts;
  readonly keyId: string;
}

export interface ArtifactCatalogRepository {
  activate(
    scope: EvidenceScope,
    artifactId: string,
    objectReceipt: ArtifactObjectReceipt,
    availableAt: string,
  ): Promise<ArtifactCatalogEntry>;
  find(scope: EvidenceScope, artifactId: string): Promise<ArtifactCatalogEntry | null>;
  listAbandoned(
    scope: EvidenceScope,
    createdBefore: string,
    limit: number,
  ): Promise<readonly ArtifactCatalogEntry[]>;
  listExpired(
    scope: EvidenceScope,
    expiresBefore: string,
    limit: number,
  ): Promise<readonly ArtifactCatalogEntry[]>;
  listPendingPurge(scope: EvidenceScope, limit: number): Promise<readonly ArtifactCatalogEntry[]>;
  listKeyReferences(scope: EvidenceScope): Promise<readonly ArtifactKeyReferenceSummary[]>;
  findPurgeReceipt(scope: EvidenceScope, artifactId: string): Promise<ArtifactPurgeReceipt | null>;
  recordPurge(scope: EvidenceScope, receipt: ArtifactPurgeReceipt): Promise<ArtifactCatalogEntry>;
  reserve(candidate: ArtifactCatalogEntry): Promise<ReserveArtifactCatalogResult>;
  /** Atomically rejects fixture-owned content; only coordinated fixture revocation may tombstone it. */
  tombstone(
    scope: EvidenceScope,
    tombstone: ArtifactTombstone,
  ): Promise<TombstoneArtifactCatalogResult>;
}

export interface ArtifactObjectPutResult {
  readonly created: boolean;
  readonly receipt: ArtifactObjectReceipt;
}

export interface ArtifactObjectStore {
  delete(objectKey: string): Promise<{ readonly deleted: boolean }>;
  get(objectKey: string): Promise<Uint8Array | null>;
  putIfAbsent(objectKey: string, ciphertext: Uint8Array): Promise<ArtifactObjectPutResult>;
}

export interface ArtifactDataKeyContext {
  readonly authenticatedData: Uint8Array;
  readonly artifactId: string;
  readonly tenantId: string;
}

export interface ArtifactKeyProvider {
  activeKeyId(): Promise<string>;
  unwrapDataKey(
    wrapped: WrappedArtifactDataKey,
    context: ArtifactDataKeyContext,
  ): Promise<Uint8Array>;
  wrapDataKey(
    dataKey: Uint8Array,
    context: ArtifactDataKeyContext,
  ): Promise<WrappedArtifactDataKey>;
}

export interface ArtifactKeyInventory {
  activeKeyId(): Promise<string>;
  configuredKeyIds(): Promise<readonly string[]>;
}
