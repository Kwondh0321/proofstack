import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RecordedInteractionFixtureVersionDefinitionSchema } from "./dataset.js";
import {
  ExportRecordedInteractionFixtureContentRequestSchema,
  RecordedInteractionFixtureContentExportSchema,
  RecordedInteractionFixtureMetadataExportSchema,
} from "./interaction-export.js";

const definition = RecordedInteractionFixtureVersionDefinitionSchema.parse(
  (
    JSON.parse(
      readFileSync(
        new URL("../../datasets/vectors/interaction-fixture-definition-v2.json", import.meta.url),
        "utf8",
      ),
    ) as { readonly vectors: readonly { readonly input: unknown }[] }
  ).vectors[0]?.input,
);

const version = {
  ...definition,
  createdAt: "2026-08-29T00:01:00.000Z",
  createdByPrincipalId: "usr_export_test",
  definitionSha256: "c".repeat(64),
  source: { ...definition.source, capturedAt: "2026-08-29T00:00:30.000Z" },
} as const;

const ownerships = version.interactionCapture.artifacts.map(({ contentReference }) => ({
  artifactId: contentReference.artifactId,
  boundAt: version.createdAt,
  boundByPrincipalId: version.createdByPrincipalId,
  owner: {
    fixtureId: version.fixtureId,
    fixtureVersionId: version.fixtureVersionId,
    kind: "regression_fixture_version" as const,
  },
  schemaVersion: "0.1" as const,
  scope: version.scope,
}));

const revocation = {
  fixtureId: version.fixtureId,
  fixtureVersionId: version.fixtureVersionId,
  reason: "Remove the complete captured content set",
  revocationId: "rev_export_test",
  revokedAt: "2026-08-29T00:02:00.000Z",
  revokedByPrincipalId: "usr_export_test",
  schemaVersion: "0.1" as const,
  scope: version.scope,
};

function availableArtifact(index: number) {
  const binding = version.interactionCapture.artifacts[index];
  const ownership = ownerships[index];
  if (!binding || !ownership) throw new Error("Export test artifact is missing");
  return {
    binding,
    lifecycleStatus: "available" as const,
    metadata: {
      availableAt: "2026-08-29T00:00:45.000Z",
      contentReference: binding.contentReference,
      createdAt: "2026-08-29T00:00:40.000Z",
      redaction: binding.redaction,
      retention: binding.retention,
      schemaVersion: "0.1" as const,
      scope: version.scope,
      state: "available" as const,
    },
    ownership,
    purgeReceipt: null,
    tombstone: null,
  };
}

function unavailableArtifact(index: number) {
  const artifact = availableArtifact(index);
  return {
    ...artifact,
    lifecycleStatus: "unavailable" as const,
    metadata: null,
  };
}

function revokedArtifact(index: number, purged = false) {
  const artifact = availableArtifact(index);
  const tombstone = {
    actorPrincipalId: revocation.revokedByPrincipalId,
    artifactId: artifact.binding.contentReference.artifactId,
    occurredAt: revocation.revokedAt,
    reason: revocation.reason,
    tombstoneId: `del_export_test_${index}`,
    trigger: "fixture_revocation" as const,
  };
  if (purged) {
    return {
      ...artifact,
      lifecycleStatus: "purged" as const,
      metadata: {
        ...artifact.metadata,
        purgedAt: "2026-08-29T00:03:00.000Z",
        state: "purged" as const,
        tombstonedAt: revocation.revokedAt,
      },
      purgeReceipt: {
        artifactId: artifact.binding.contentReference.artifactId,
        objectWasPresent: true,
        occurredAt: "2026-08-29T00:03:00.000Z",
        purgeId: `purge_export_test_${index}`,
        schemaVersion: "0.1" as const,
      },
      tombstone,
    };
  }
  return {
    ...artifact,
    lifecycleStatus: "revoked" as const,
    metadata: {
      ...artifact.metadata,
      state: "tombstoned" as const,
      tombstonedAt: revocation.revokedAt,
    },
    tombstone,
  };
}

function metadataExport() {
  return {
    artifacts: version.interactionCapture.artifacts.map((_artifact, index) =>
      availableArtifact(index),
    ),
    contentAvailability: "available" as const,
    mode: "metadata" as const,
    revocation: null,
    schemaVersion: "0.1" as const,
    version,
  };
}

function availableContent(index: number) {
  const artifact = availableArtifact(index);
  return {
    artifact,
    content: {
      bytes: Buffer.alloc(artifact.binding.contentReference.sizeBytes, index + 1).toString(
        "base64url",
      ),
      encoding: "base64url" as const,
      status: "available" as const,
    },
  };
}

describe("recorded interaction export contracts", () => {
  it("accepts an exact metadata-only export and rejects content or reordered provenance", () => {
    const value = metadataExport();
    expect(RecordedInteractionFixtureMetadataExportSchema.safeParse(value).success).toBe(true);
    expect(
      RecordedInteractionFixtureMetadataExportSchema.safeParse({ ...value, content: "plaintext" })
        .success,
    ).toBe(false);
    expect(
      RecordedInteractionFixtureMetadataExportSchema.safeParse({
        ...value,
        artifacts: [...value.artifacts].reverse(),
      }).success,
    ).toBe(false);
    expect(
      RecordedInteractionFixtureMetadataExportSchema.safeParse({
        ...value,
        artifacts: [
          { ...value.artifacts[0], ownership: ownerships[1] },
          ...value.artifacts.slice(1),
        ],
      }).success,
    ).toBe(false);
  });

  it("represents fixture unavailability without inventing catalog metadata", () => {
    const value = metadataExport();
    expect(
      RecordedInteractionFixtureMetadataExportSchema.safeParse({
        ...value,
        artifacts: [unavailableArtifact(0), ...value.artifacts.slice(1)],
        contentAvailability: "unavailable",
      }).success,
    ).toBe(true);
    expect(
      RecordedInteractionFixtureMetadataExportSchema.safeParse({
        ...value,
        contentAvailability: "unavailable",
      }).success,
    ).toBe(false);
  });

  it("requires an explicit sensitive-content acknowledgement", () => {
    expect(
      ExportRecordedInteractionFixtureContentRequestSchema.safeParse({
        acknowledgeSensitiveContent: true,
      }).success,
    ).toBe(true);
    expect(
      ExportRecordedInteractionFixtureContentRequestSchema.safeParse({
        acknowledgeSensitiveContent: false,
      }).success,
    ).toBe(false);
    expect(
      ExportRecordedInteractionFixtureContentRequestSchema.safeParse({
        acknowledgeSensitiveContent: true,
        reason: "unexpected",
      }).success,
    ).toBe(false);
  });

  it("exports bounded content while preserving explicit missing and unavailable states", () => {
    const artifacts = version.interactionCapture.artifacts.map((_artifact, index) =>
      availableContent(index),
    );
    expect(
      RecordedInteractionFixtureContentExportSchema.safeParse({
        artifacts,
        contentAvailability: "available",
        mode: "content",
        revocation: null,
        schemaVersion: "0.1",
        version,
      }).success,
    ).toBe(true);
    expect(
      RecordedInteractionFixtureContentExportSchema.safeParse({
        artifacts: [
          { artifact: availableArtifact(0), content: { status: "missing" } },
          { artifact: availableArtifact(1), content: { status: "unavailable" } },
          ...artifacts.slice(2),
        ],
        contentAvailability: "available",
        mode: "content",
        revocation: null,
        schemaVersion: "0.1",
        version,
      }).success,
    ).toBe(true);
    expect(
      RecordedInteractionFixtureContentExportSchema.safeParse({
        artifacts: [
          {
            ...artifacts[0],
            content: {
              ...artifacts[0]?.content,
              bytes: Buffer.from("short").toString("base64url"),
            },
          },
          ...artifacts.slice(1),
        ],
        contentAvailability: "available",
        mode: "content",
        revocation: null,
        schemaVersion: "0.1",
        version,
      }).success,
    ).toBe(false);
  });

  it("preserves complete revocation, tombstone, and purge evidence", () => {
    const artifacts = version.interactionCapture.artifacts.map((_artifact, index) => ({
      artifact: revokedArtifact(index, index === 0),
      content: { status: index === 0 ? ("purged" as const) : ("revoked" as const) },
    }));
    const value = {
      artifacts,
      contentAvailability: "revoked" as const,
      mode: "content" as const,
      revocation,
      schemaVersion: "0.1" as const,
      version,
    };
    expect(RecordedInteractionFixtureContentExportSchema.safeParse(value).success).toBe(true);
    expect(
      RecordedInteractionFixtureContentExportSchema.safeParse({
        ...value,
        artifacts: [{ ...artifacts[0], content: { status: "revoked" } }, ...artifacts.slice(1)],
      }).success,
    ).toBe(false);
    expect(
      RecordedInteractionFixtureMetadataExportSchema.safeParse({
        artifacts: artifacts.map(({ artifact }) => artifact),
        contentAvailability: "revoked",
        mode: "metadata",
        revocation,
        schemaVersion: "0.1",
        version,
      }).success,
    ).toBe(true);
  });
});
