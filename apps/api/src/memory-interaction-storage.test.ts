import { readFileSync } from "node:fs";
import { ArtifactOwnedDeletionError } from "@proofstack/artifacts";
import {
  type RecordedInteractionFixtureVersionDefinition,
  RecordedInteractionFixtureVersionDefinitionSchema,
  RecordedInteractionFixtureVersionSchema,
  type RegressionFixtureVersionDefinition,
  RegressionFixtureVersionSchema,
} from "@proofstack/contracts";
import {
  digestRecordedInteractionFixtureVersionDefinition,
  digestRegressionFixtureVersionDefinition,
} from "@proofstack/datasets";
import { describe, expect, it } from "vitest";
import { createMemoryInteractionStorage } from "./memory-interaction-storage.js";

const vector = RecordedInteractionFixtureVersionDefinitionSchema.parse(
  (
    JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/datasets/vectors/interaction-fixture-definition-v2.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      readonly vectors: readonly {
        readonly input: RecordedInteractionFixtureVersionDefinition;
      }[];
    }
  ).vectors[0]?.input,
);

function predecessor() {
  const definition: RegressionFixtureVersionDefinition = {
    fixtureId: vector.fixtureId,
    fixtureVersionId: vector.predecessor.fixtureVersionId,
    name: "Checkout evidence predecessor",
    replayability: "evidence_only",
    schemaVersion: "0.1",
    scope: vector.scope,
    source: vector.source,
  };
  return RegressionFixtureVersionSchema.parse({
    ...definition,
    createdAt: "2026-08-29T04:59:00.000Z",
    createdByPrincipalId: "usr_evidence_manager",
    definitionSha256: digestRegressionFixtureVersionDefinition(definition),
    source: { ...definition.source, capturedAt: "2026-08-29T04:58:00.000Z" },
  });
}

function recordedVersion() {
  const prior = predecessor();
  const definition = RecordedInteractionFixtureVersionDefinitionSchema.parse({
    ...vector,
    predecessor: {
      definitionSha256: prior.definitionSha256,
      fixtureVersionId: prior.fixtureVersionId,
    },
  });
  return RecordedInteractionFixtureVersionSchema.parse({
    ...definition,
    createdAt: "2026-08-29T05:00:00.000Z",
    createdByPrincipalId: "usr_fixture_manager",
    definitionSha256: digestRecordedInteractionFixtureVersionDefinition(definition),
    source: prior.source,
  });
}

describe("coordinated memory interaction storage", () => {
  it("serializes publication ownership, ordinary deletion, and full-fixture revocation", async () => {
    const storage = createMemoryInteractionStorage();
    const version = recordedVersion();
    await storage.regressionVersionRepository.publishFixtureVersion(predecessor());
    for (const [index, binding] of version.interactionCapture.artifacts.entries()) {
      const metadata = {
        contentReference: binding.contentReference,
        createdAt: "2026-08-29T04:59:30.000Z",
        redaction: binding.redaction,
        retention: binding.retention,
        schemaVersion: "0.1" as const,
        scope: version.scope,
        state: "reserved" as const,
      };
      await storage.artifactCatalogRepository.reserve({
        createdByPrincipalId: "usr_capture_writer",
        encryption: {
          contentNonce: "A".repeat(16),
          version: "a256gcm-v1",
          wrappedDataKey: {
            algorithm: "A256GCM",
            ciphertext: "B".repeat(43),
            keyId: "key_memory",
            nonce: "C".repeat(16),
            tag: "D".repeat(22),
          },
        },
        metadata,
        objectKey: `objects/v1/test/${binding.contentReference.artifactId}`,
      });
      await storage.artifactCatalogRepository.activate(
        version.scope,
        binding.contentReference.artifactId,
        { sha256: index.toString(16).padStart(64, "0"), sizeBytes: 84 + index },
        "2026-08-29T04:59:40.000Z",
      );
    }

    const [first, retry] = await Promise.all([
      storage.regressionVersionRepository.publishRecordedInteractionFixtureVersion(version),
      storage.regressionVersionRepository.publishRecordedInteractionFixtureVersion(version),
    ]);
    expect([first.created, retry.created].sort()).toEqual([false, true]);
    for (const ownership of first.ownerships) {
      await expect(
        storage.artifactCatalogRepository.find(ownership.scope, ownership.artifactId),
      ).resolves.toMatchObject({ ownership });
    }
    await expect(
      storage.regressionVersionRepository.fixtureResourceExists(version.scope, version.fixtureId),
    ).resolves.toBe(true);
    await expect(
      storage.regressionVersionRepository.findFixtureVersion(
        version.scope,
        version.predecessor.fixtureVersionId,
      ),
    ).resolves.toMatchObject({ fixtureId: version.fixtureId });
    await expect(
      storage.regressionVersionRepository.findRecordedInteractionFixtureVersion(
        version.scope,
        version.fixtureVersionId,
      ),
    ).resolves.toMatchObject({ version });
    await expect(
      storage.regressionVersionRepository.resolveFixtureVersionReferences(version.scope, [
        { fixtureId: version.fixtureId, fixtureVersionId: version.fixtureVersionId },
      ]),
    ).resolves.toEqual([
      {
        definitionSha256: version.definitionSha256,
        fixtureId: version.fixtureId,
        fixtureVersionId: version.fixtureVersionId,
      },
    ]);
    await expect(
      storage.regressionVersionRepository.datasetResourceExists(version.scope, "dat_absent"),
    ).resolves.toBe(false);
    await expect(
      storage.regressionVersionRepository.findDatasetVersion(version.scope, "datv_absent"),
    ).resolves.toBeNull();
    await expect(
      storage.artifactCatalogRepository.listAbandoned(
        version.scope,
        "2026-08-29T06:00:00.000Z",
        10,
      ),
    ).resolves.toEqual([]);
    await expect(
      storage.artifactCatalogRepository.listExpired(version.scope, "2026-08-29T06:00:00.000Z", 10),
    ).resolves.toEqual([]);
    await expect(
      storage.artifactCatalogRepository.listKeyReferences(version.scope),
    ).resolves.toEqual([
      {
        counts: { available: 7, purged: 0, reserved: 0, tombstoned: 0, total: 7 },
        keyId: "key_memory",
      },
    ]);

    const revokedAt = "2026-08-29T05:01:00.000Z";
    const reason = "Remove the complete captured interaction content set";
    const revocation = {
      fixtureId: version.fixtureId,
      fixtureVersionId: version.fixtureVersionId,
      reason,
      revocationId: "rev_memory_001",
      revokedAt,
      revokedByPrincipalId: "usr_privacy_operator",
      schemaVersion: "0.1" as const,
      scope: version.scope,
    };
    const tombstones = first.ownerships.map((ownership, index) => ({
      actorPrincipalId: revocation.revokedByPrincipalId,
      artifactId: ownership.artifactId,
      occurredAt: revokedAt,
      reason,
      tombstoneId: `del_memory_${index}`,
      trigger: "fixture_revocation" as const,
    }));
    const firstTombstone = tombstones[0];
    if (!firstTombstone) throw new Error("Expected captured artifact ownership");
    const ordinaryDeletion = storage.artifactCatalogRepository.tombstone(version.scope, {
      ...firstTombstone,
      reason: "Attempt to bypass fixture authority",
      tombstoneId: "del_manual_bypass",
      trigger: "manual",
    });
    const revocationResult =
      storage.regressionVersionRepository.revokeRecordedInteractionFixtureContent({
        revocation,
        tombstones,
      });

    await expect(ordinaryDeletion).rejects.toBeInstanceOf(ArtifactOwnedDeletionError);
    await expect(revocationResult).resolves.toMatchObject({
      contentAvailability: "revoked",
      created: true,
      revocation,
      tombstones,
    });
    for (const tombstone of tombstones) {
      await expect(
        storage.artifactCatalogRepository.find(version.scope, tombstone.artifactId),
      ).resolves.toMatchObject({
        metadata: { state: "tombstoned", tombstonedAt: revokedAt },
        ownership: expect.any(Object),
      });
    }
    await expect(
      storage.regressionVersionRepository.findRecordedInteractionFixtureContent(
        version.scope,
        version.fixtureVersionId,
      ),
    ).resolves.toMatchObject({ contentAvailability: "revoked", tombstones });
    await expect(
      storage.artifactCatalogRepository.listPendingPurge(version.scope, 10),
    ).resolves.toHaveLength(tombstones.length);
    await expect(
      storage.artifactCatalogRepository.recordPurge(version.scope, {
        artifactId: firstTombstone.artifactId,
        objectWasPresent: true,
        occurredAt: "2026-08-29T05:02:00.000Z",
        purgeId: "pur_memory_001",
      }),
    ).resolves.toMatchObject({ metadata: { state: "purged" } });

    await expect(
      storage.regressionVersionRepository.revokeRecordedInteractionFixtureContent({
        revocation,
        tombstones,
      }),
    ).resolves.toMatchObject({ created: false });
  });
});
