import { createHash } from "node:crypto";
import type {
  ArtifactCatalogRepository,
  ArtifactContentDecryptor,
  ArtifactObjectReceipt,
  ArtifactObjectStore,
} from "@proofstack/artifacts";
import { ArtifactMetadataSchema, type EvidenceScope } from "@proofstack/contracts";
import type {
  CriteriaTrustArtifactAvailability,
  CriteriaTrustArtifactReference,
  CriteriaTrustArtifactResolver,
  ResolveCriteriaTrustArtifactsCommand,
} from "@proofstack/core";

interface RepositoryCriteriaTrustArtifactResolverDependencies {
  readonly catalog?: ArtifactCatalogRepository;
  readonly encryption?: ArtifactContentDecryptor;
  readonly objects?: ArtifactObjectStore;
}

function digest(value: Uint8Array): ArtifactObjectReceipt {
  return {
    sha256: createHash("sha256").update(value).digest("hex"),
    sizeBytes: value.byteLength,
  };
}

function sameReceipt(left: ArtifactObjectReceipt, right: ArtifactObjectReceipt): boolean {
  return left.sha256 === right.sha256 && left.sizeBytes === right.sizeBytes;
}

function sameScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function availability(
  reference: CriteriaTrustArtifactReference,
  state: CriteriaTrustArtifactAvailability["state"],
): CriteriaTrustArtifactAvailability {
  return { ...reference, state };
}

/**
 * Proves point-in-time artifact readability from the exact catalog row and retained encrypted
 * object. A reference is available only when both ciphertext and decrypted plaintext receipts
 * match; every absence, lifecycle transition, corruption, or backend error fails closed.
 */
export class RepositoryCriteriaTrustArtifactResolver implements CriteriaTrustArtifactResolver {
  constructor(private readonly dependencies: RepositoryCriteriaTrustArtifactResolverDependencies) {}

  async resolve(
    command: ResolveCriteriaTrustArtifactsCommand,
  ): Promise<readonly CriteriaTrustArtifactAvailability[]> {
    const { catalog, encryption, objects } = this.dependencies;
    if (!catalog || !encryption || !objects) {
      return command.references.map((reference) => availability(reference, "unavailable"));
    }
    return Promise.all(
      command.references.map(async (reference) => {
        try {
          const entry = await catalog.find(structuredClone(command.scope), reference.artifactId);
          if (!entry || typeof entry.objectKey !== "string" || entry.objectKey.length === 0) {
            return availability(reference, "unavailable");
          }
          const metadata = ArtifactMetadataSchema.safeParse(entry.metadata);
          if (
            !metadata.success ||
            metadata.data.state !== "available" ||
            !sameScope(metadata.data.scope, command.scope) ||
            metadata.data.contentReference.artifactId !== reference.artifactId ||
            metadata.data.contentReference.sha256 !== reference.sha256 ||
            !entry.objectReceipt ||
            !/^[a-f0-9]{64}$/.test(entry.objectReceipt.sha256) ||
            !Number.isSafeInteger(entry.objectReceipt.sizeBytes) ||
            entry.objectReceipt.sizeBytes < 1
          ) {
            return availability(reference, "unavailable");
          }
          const encrypted = await objects.get(entry.objectKey);
          if (!encrypted || !sameReceipt(digest(encrypted), entry.objectReceipt)) {
            return availability(reference, "unavailable");
          }
          const plaintext = await encryption.decrypt(metadata.data, entry.encryption, encrypted);
          if (!(plaintext instanceof Uint8Array)) {
            return availability(reference, "unavailable");
          }
          const plaintextReceipt = digest(plaintext);
          return availability(
            reference,
            plaintextReceipt.sha256 === reference.sha256 &&
              plaintextReceipt.sizeBytes === metadata.data.contentReference.sizeBytes
              ? "available"
              : "unavailable",
          );
        } catch {
          return availability(reference, "unavailable");
        }
      }),
    );
  }
}
