import { ArtifactMetadataSchema, PrincipalContextSchema } from "@proofstack/contracts";
import { ForbiddenError } from "@proofstack/core";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactCatalogEntry, ArtifactCatalogRepository } from "./artifact-ports.js";
import { ArtifactNotFoundError, InvalidArtifactLifecycleInputError } from "./errors.js";
import { ReadArtifactMetadata } from "./read-artifact-metadata.js";

const scope = {
  environmentId: "env_metadata",
  projectId: "prj_metadata",
  tenantId: "ten_metadata",
} as const;

const metadata = ArtifactMetadataSchema.parse({
  availableAt: "2026-08-29T05:00:01.000Z",
  contentReference: {
    artifactId: "art_metadata",
    classification: "restricted",
    mediaType: "application/json",
    sha256: "a".repeat(64),
    sizeBytes: 32,
  },
  createdAt: "2026-08-29T05:00:00.000Z",
  redaction: { status: "not_required" },
  retention: { mode: "retain" },
  schemaVersion: "0.1",
  scope,
  state: "available",
});

const entry: ArtifactCatalogEntry = {
  createdByPrincipalId: "usr_metadata_writer",
  encryption: {
    contentNonce: "AAAAAAAAAAAAAAAA",
    version: "a256gcm-v1",
    wrappedDataKey: {
      algorithm: "A256GCM",
      ciphertext: "B".repeat(43),
      keyId: "key_metadata",
      nonce: "C".repeat(16),
      tag: "D".repeat(22),
    },
  },
  metadata,
  objectKey: "objects/v1/metadata",
  objectReceipt: { sha256: "b".repeat(64), sizeBytes: 52 },
  ownership: {
    artifactId: metadata.contentReference.artifactId,
    boundAt: "2026-08-29T05:01:00.000Z",
    boundByPrincipalId: "usr_metadata_manager",
    owner: {
      fixtureId: "fix_metadata",
      fixtureVersionId: "fixv_metadata_001",
      kind: "regression_fixture_version",
    },
    schemaVersion: "0.1",
    scope,
  },
};

function principal(capabilities: readonly string[] = ["artifact:read"]) {
  return PrincipalContextSchema.parse({
    authentication: { authenticatedAt: "2026-08-29T05:02:00.000Z", method: "development" },
    capabilities,
    principalId: "usr_metadata_reader",
    principalType: "user",
    requestId: "req_metadata",
    resourceScope: {
      mode: "restricted",
      projects: [{ environmentIds: [scope.environmentId], projectId: scope.projectId }],
    },
    roles: ["viewer"],
    tenantId: scope.tenantId,
  });
}

function repository(
  find: ArtifactCatalogRepository["find"] = vi.fn(async () => entry),
): ArtifactCatalogRepository {
  return {
    activate: vi.fn(),
    find,
    listAbandoned: vi.fn(),
    listExpired: vi.fn(),
    listKeyReferences: vi.fn(),
    listPendingPurge: vi.fn(),
    recordPurge: vi.fn(),
    reserve: vi.fn(),
    tombstone: vi.fn(),
  };
}

describe("ReadArtifactMetadata", () => {
  it("returns detached metadata and ownership without object storage access", async () => {
    const find = vi.fn(async () => entry);
    const result = await new ReadArtifactMetadata(repository(find)).execute({
      artifactId: metadata.contentReference.artifactId,
      environmentId: scope.environmentId,
      principal: principal(),
      projectId: scope.projectId,
    });

    expect(result).toEqual({ metadata, ownership: entry.ownership });
    expect(result.metadata).not.toBe(entry.metadata);
    expect(result.ownership).not.toBe(entry.ownership);
    expect(find).toHaveBeenCalledWith(scope, metadata.contentReference.artifactId);

    const { ownership: _ownership, ...unownedEntry } = entry;
    await expect(
      new ReadArtifactMetadata(repository(vi.fn(async () => unownedEntry))).execute({
        artifactId: metadata.contentReference.artifactId,
        environmentId: scope.environmentId,
        principal: principal(),
        projectId: scope.projectId,
      }),
    ).resolves.toEqual({ metadata });
  });

  it("requires metadata read capability and exact environment access before lookup", async () => {
    const find = vi.fn(async () => entry);
    const service = new ReadArtifactMetadata(repository(find));
    await expect(
      service.execute({
        artifactId: metadata.contentReference.artifactId,
        environmentId: scope.environmentId,
        principal: principal([]),
        projectId: scope.projectId,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.execute({
        artifactId: metadata.contentReference.artifactId,
        environmentId: "env_hidden",
        principal: principal(),
        projectId: scope.projectId,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(find).not.toHaveBeenCalled();
  });

  it("fails closed for invalid identifiers, scopes, and absent rows", async () => {
    const service = new ReadArtifactMetadata(repository(vi.fn(async () => null)));
    await expect(
      service.execute({
        artifactId: "INVALID",
        environmentId: scope.environmentId,
        principal: principal(),
        projectId: scope.projectId,
      }),
    ).rejects.toBeInstanceOf(InvalidArtifactLifecycleInputError);
    await expect(
      service.execute({
        artifactId: metadata.contentReference.artifactId,
        environmentId: scope.environmentId,
        principal: { ...principal(), tenantId: "INVALID" },
        projectId: scope.projectId,
      }),
    ).rejects.toBeInstanceOf(InvalidArtifactLifecycleInputError);
    await expect(
      service.execute({
        artifactId: metadata.contentReference.artifactId,
        environmentId: scope.environmentId,
        principal: principal(),
        projectId: scope.projectId,
      }),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });
});
