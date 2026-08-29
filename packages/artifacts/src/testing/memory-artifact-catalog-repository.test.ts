import { describe, expect, it } from "vitest";
import type { ArtifactCatalogEntry } from "../artifact-ports.js";
import {
  ArtifactOwnedDeletionError,
  ArtifactOwnershipConflictError,
  ArtifactStateTransitionError,
} from "../errors.js";
import { MemoryArtifactCatalogRepository } from "./memory-artifact-catalog-repository.js";

function candidate(): ArtifactCatalogEntry {
  return {
    createdByPrincipalId: "usr_mutation",
    encryption: {
      contentNonce: "AAAAAAAAAAAAAAAA",
      version: "a256gcm-v1",
      wrappedDataKey: {
        algorithm: "A256GCM",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        keyId: "key_mutation",
        nonce: "AAAAAAAAAAAAAAAA",
        tag: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    },
    metadata: {
      contentReference: {
        artifactId: "art_mutation",
        classification: "internal",
        mediaType: "text/plain",
        sha256: "1".repeat(64),
        sizeBytes: 1,
      },
      createdAt: "2026-08-28T03:00:00.000Z",
      redaction: { status: "not_performed" },
      retention: { mode: "retain" },
      schemaVersion: "0.1",
      scope: {
        environmentId: "env_mutation",
        projectId: "prj_mutation",
        tenantId: "ten_mutation",
      },
      state: "reserved",
    },
    objectKey: "artifacts/mutation/art_mutation",
  };
}

function ownership(overrides: Record<string, unknown> = {}) {
  return {
    artifactId: "art_mutation",
    boundAt: "2026-08-28T03:02:00.000Z",
    boundByPrincipalId: "usr_dataset_manager",
    owner: {
      fixtureId: "fix_mutation",
      fixtureVersionId: "fixv_mutation_recorded",
      kind: "regression_fixture_version" as const,
    },
    schemaVersion: "0.1" as const,
    scope: candidate().metadata.scope,
    ...overrides,
  };
}

describe("MemoryArtifactCatalogRepository", () => {
  it("returns defensive copies instead of mutable catalog state", async () => {
    const repository = new MemoryArtifactCatalogRepository();
    const input = candidate();
    const reserved = await repository.reserve(input);
    input.metadata.scope.projectId = "prj_changed";
    reserved.entry.metadata.scope.projectId = "prj_changed";

    const stored = await repository.find(
      candidate().metadata.scope,
      candidate().metadata.contentReference.artifactId,
    );
    expect(stored?.metadata.scope.projectId).toBe("prj_mutation");
  });

  it("claims retain-mode available content once and returns defensive ownership copies", async () => {
    const repository = new MemoryArtifactCatalogRepository();
    const input = candidate();
    await repository.reserve(input);
    await repository.activate(
      input.metadata.scope,
      input.metadata.contentReference.artifactId,
      { sha256: "2".repeat(64), sizeBytes: 21 },
      "2026-08-28T03:01:00.000Z",
    );

    const first = repository.claimFixtureOwnershipForTesting(ownership());
    const retry = repository.claimFixtureOwnershipForTesting(ownership());
    expect(retry).toEqual(first);
    if (!first.ownership) throw new Error("Expected fixture ownership");
    first.ownership.scope.projectId = "prj_mutated";
    expect(
      (await repository.find(input.metadata.scope, input.metadata.contentReference.artifactId))
        ?.ownership?.scope.projectId,
    ).toBe("prj_mutation");

    expect(() =>
      repository.claimFixtureOwnershipForTesting(
        ownership({
          owner: { ...ownership().owner, fixtureVersionId: "fixv_mutation_other" },
        }),
      ),
    ).toThrow(ArtifactOwnershipConflictError);
  });

  it("rejects ordinary tombstones for fixture-owned content", async () => {
    const repository = new MemoryArtifactCatalogRepository();
    const input = candidate();
    await repository.reserve(input);
    await repository.activate(
      input.metadata.scope,
      input.metadata.contentReference.artifactId,
      { sha256: "2".repeat(64), sizeBytes: 21 },
      "2026-08-28T03:01:00.000Z",
    );
    repository.claimFixtureOwnershipForTesting(ownership());

    await expect(
      repository.tombstone(input.metadata.scope, {
        actorPrincipalId: "usr_owner",
        artifactId: input.metadata.contentReference.artifactId,
        occurredAt: "2026-08-28T03:03:00.000Z",
        reason: "Ordinary deletion must not bypass fixture revocation",
        tombstoneId: "del_owned",
        trigger: "manual",
      }),
    ).rejects.toBeInstanceOf(ArtifactOwnedDeletionError);
  });

  it("refuses ownership during reservation, before activation, or with expiry", async () => {
    const preowned = { ...candidate(), ownership: ownership() };
    await expect(new MemoryArtifactCatalogRepository().reserve(preowned)).rejects.toBeInstanceOf(
      ArtifactStateTransitionError,
    );

    const reservedRepository = new MemoryArtifactCatalogRepository();
    await reservedRepository.reserve(candidate());
    expect(() => reservedRepository.claimFixtureOwnershipForTesting(ownership())).toThrow(
      ArtifactStateTransitionError,
    );

    const expiringRepository = new MemoryArtifactCatalogRepository();
    const expiring = {
      ...candidate(),
      metadata: {
        ...candidate().metadata,
        retention: { expiresAt: "2026-09-28T00:00:00.000Z", mode: "expire" as const },
      },
    };
    await expiringRepository.reserve(expiring);
    await expiringRepository.activate(
      expiring.metadata.scope,
      expiring.metadata.contentReference.artifactId,
      { sha256: "2".repeat(64), sizeBytes: 21 },
      "2026-08-28T03:01:00.000Z",
    );
    expect(() => expiringRepository.claimFixtureOwnershipForTesting(ownership())).toThrow(
      ArtifactStateTransitionError,
    );
  });
});
