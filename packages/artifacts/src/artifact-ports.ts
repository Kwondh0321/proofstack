import type { ArtifactMetadata, ArtifactTombstone, EvidenceScope } from "@proofstack/contracts";

export const ARTIFACT_ENCRYPTION_VERSION = "a256gcm-v1" as const;
export const MAX_ARTIFACT_MAINTENANCE_BATCH_SIZE = 100;

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

export interface ArtifactCatalogRepository {
  activate(
    scope: EvidenceScope,
    artifactId: string,
    objectReceipt: ArtifactObjectReceipt,
    availableAt: string,
  ): Promise<ArtifactCatalogEntry>;
  find(scope: EvidenceScope, artifactId: string): Promise<ArtifactCatalogEntry | null>;
  listExpired(
    scope: EvidenceScope,
    expiresBefore: string,
    limit: number,
  ): Promise<readonly ArtifactCatalogEntry[]>;
  listPendingPurge(scope: EvidenceScope, limit: number): Promise<readonly ArtifactCatalogEntry[]>;
  recordPurge(scope: EvidenceScope, receipt: ArtifactPurgeReceipt): Promise<ArtifactCatalogEntry>;
  reserve(candidate: ArtifactCatalogEntry): Promise<ReserveArtifactCatalogResult>;
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
