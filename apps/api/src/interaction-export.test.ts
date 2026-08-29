import type {
  ArtifactCatalogEntry,
  ArtifactCatalogRepository,
  ArtifactPurgeReceipt,
} from "@proofstack/artifacts";
import { ArtifactObjectMissingError, ArtifactUnavailableError } from "@proofstack/artifacts";
import {
  PrincipalContextSchema,
  type RecordedInteractionFixtureVersion,
  RecordedInteractionFixtureVersionDefinitionSchema,
} from "@proofstack/contracts";
import { ForbiddenError } from "@proofstack/core";
import type { StoredInteractionFixtureContent } from "@proofstack/datasets";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ExportRecordedInteractionFixtureContent,
  ExportRecordedInteractionFixtureMetadata,
  InteractionContentExportTooLargeError,
  InteractionExportStateChangedError,
} from "./interaction-export.js";

const definition = RecordedInteractionFixtureVersionDefinitionSchema.parse(
  (
    JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/datasets/vectors/interaction-fixture-definition-v2.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { readonly vectors: readonly { readonly input: unknown }[] }
  ).vectors[0]?.input,
);

const version: RecordedInteractionFixtureVersion = {
  ...definition,
  createdAt: "2026-08-29T00:01:00.000Z",
  createdByPrincipalId: "usr_export_test",
  definitionSha256: "c".repeat(64),
  source: { ...definition.source, capturedAt: "2026-08-29T00:00:30.000Z" },
};

function principal(capabilities: readonly string[]) {
  return PrincipalContextSchema.parse({
    authentication: { authenticatedAt: "2026-08-29T00:04:00.000Z", method: "development" },
    capabilities,
    principalId: "usr_export_test",
    principalType: "user",
    requestId: "req_export_test",
    resourceScope: { mode: "tenant" },
    roles: ["viewer"],
    tenantId: version.scope.tenantId,
  });
}

function ownerships(currentVersion: RecordedInteractionFixtureVersion) {
  return currentVersion.interactionCapture.artifacts.map(({ contentReference }) => ({
    artifactId: contentReference.artifactId,
    boundAt: currentVersion.createdAt,
    boundByPrincipalId: currentVersion.createdByPrincipalId,
    owner: {
      fixtureId: currentVersion.fixtureId,
      fixtureVersionId: currentVersion.fixtureVersionId,
      kind: "regression_fixture_version" as const,
    },
    schemaVersion: "0.1" as const,
    scope: currentVersion.scope,
  }));
}

function availableEntry(
  currentVersion: RecordedInteractionFixtureVersion,
  index: number,
): ArtifactCatalogEntry {
  const binding = currentVersion.interactionCapture.artifacts[index];
  const ownership = ownerships(currentVersion)[index];
  if (!binding || !ownership) throw new Error("Export test artifact is missing");
  return {
    createdByPrincipalId: currentVersion.createdByPrincipalId,
    encryption: {
      contentNonce: Buffer.alloc(12, 1).toString("base64url"),
      version: "a256gcm-v1",
      wrappedDataKey: {
        algorithm: "A256GCM",
        ciphertext: Buffer.alloc(32, 2).toString("base64url"),
        keyId: "key_export_test",
        nonce: Buffer.alloc(12, 3).toString("base64url"),
        tag: Buffer.alloc(16, 4).toString("base64url"),
      },
    },
    metadata: {
      availableAt: "2026-08-29T00:00:45.000Z",
      contentReference: binding.contentReference,
      createdAt: "2026-08-29T00:00:40.000Z",
      redaction: binding.redaction,
      retention: binding.retention,
      schemaVersion: "0.1",
      scope: currentVersion.scope,
      state: "available",
    },
    objectKey: `objects/export/${binding.contentReference.artifactId}`,
    objectReceipt: {
      sha256: "d".repeat(64),
      sizeBytes: binding.contentReference.sizeBytes + 20,
    },
    ownership,
  };
}

function availableStored(
  currentVersion: RecordedInteractionFixtureVersion = version,
): StoredInteractionFixtureContent {
  return {
    contentAvailability: "available",
    ownerships: ownerships(currentVersion),
    revocation: null,
    tombstones: [],
    version: currentVersion,
  };
}

function revokedStored(currentVersion: RecordedInteractionFixtureVersion = version) {
  const currentOwnerships = ownerships(currentVersion);
  const revocation = {
    fixtureId: currentVersion.fixtureId,
    fixtureVersionId: currentVersion.fixtureVersionId,
    reason: "Remove the complete captured content set",
    revocationId: "rev_export_test",
    revokedAt: "2026-08-29T00:02:00.000Z",
    revokedByPrincipalId: "usr_export_test",
    schemaVersion: "0.1" as const,
    scope: currentVersion.scope,
  };
  return {
    contentAvailability: "revoked" as const,
    ownerships: currentOwnerships,
    revocation,
    tombstones: currentOwnerships.map(({ artifactId }, index) => ({
      actorPrincipalId: revocation.revokedByPrincipalId,
      artifactId,
      occurredAt: revocation.revokedAt,
      reason: revocation.reason,
      tombstoneId: `del_export_test_${index}`,
      trigger: "fixture_revocation" as const,
    })),
    version: currentVersion,
  };
}

function catalog(
  entries: readonly ArtifactCatalogEntry[],
  receipts: readonly ArtifactPurgeReceipt[] = [],
): ArtifactCatalogRepository {
  const entriesById = new Map(
    entries.map((entry) => [entry.metadata.contentReference.artifactId, entry] as const),
  );
  const receiptsById = new Map(receipts.map((receipt) => [receipt.artifactId, receipt] as const));
  return {
    activate: vi.fn(),
    find: vi.fn(async (_scope, artifactId) => structuredClone(entriesById.get(artifactId) ?? null)),
    findPurgeReceipt: vi.fn(async (_scope, artifactId) =>
      structuredClone(receiptsById.get(artifactId) ?? null),
    ),
    listAbandoned: vi.fn(),
    listExpired: vi.fn(),
    listKeyReferences: vi.fn(),
    listPendingPurge: vi.fn(),
    recordPurge: vi.fn(),
    reserve: vi.fn(),
    tombstone: vi.fn(),
  };
}

function command(capabilities: readonly string[]) {
  return {
    environmentId: version.scope.environmentId,
    fixtureId: version.fixtureId,
    fixtureVersionId: version.fixtureVersionId,
    principal: principal(capabilities),
    projectId: version.scope.projectId,
  };
}

describe("interaction fixture exports", () => {
  it("exports metadata through dataset authority without crossing the plaintext boundary", async () => {
    const stored = availableStored();
    const entries = version.interactionCapture.artifacts.map((_artifact, index) =>
      availableEntry(version, index),
    );
    const artifactCatalog = catalog(entries);
    const readRecordedFixtureMetadata = { execute: vi.fn(async () => stored) };
    const result = await new ExportRecordedInteractionFixtureMetadata({
      catalog: artifactCatalog,
      readRecordedFixtureMetadata,
    }).execute(command(["dataset:read"]));

    expect(result.mode).toBe("metadata");
    expect(result.artifacts).toHaveLength(entries.length);
    expect(JSON.stringify(result)).not.toContain('"content"');
    expect(artifactCatalog.find).toHaveBeenCalledTimes(entries.length);
    expect(artifactCatalog.findPurgeReceipt).not.toHaveBeenCalled();
  });

  it("represents unavailable catalog state and rejects contradictory ownership", async () => {
    const unavailable = {
      ...availableStored(),
      contentAvailability: "unavailable" as const,
    };
    const entries = version.interactionCapture.artifacts
      .slice(1)
      .map((_artifact, index) => availableEntry(version, index + 1));
    const result = await new ExportRecordedInteractionFixtureMetadata({
      catalog: catalog(entries),
      readRecordedFixtureMetadata: { execute: vi.fn(async () => unavailable) },
    }).execute(command(["dataset:read"]));
    expect(result.artifacts[0]).toMatchObject({ lifecycleStatus: "unavailable", metadata: null });

    const conflictingBase = availableEntry(version, 0);
    if (!conflictingBase.ownership) throw new Error("Export test ownership is missing");
    const conflicting = {
      ...conflictingBase,
      ownership: { ...conflictingBase.ownership, boundByPrincipalId: "usr_other" },
    };
    await expect(
      new ExportRecordedInteractionFixtureMetadata({
        catalog: catalog([
          conflicting,
          ...version.interactionCapture.artifacts
            .slice(1)
            .map((_artifact, index) => availableEntry(version, index + 1)),
        ]),
        readRecordedFixtureMetadata: { execute: vi.fn(async () => availableStored()) },
      }).execute(command(["dataset:read"])),
    ).rejects.toBeInstanceOf(InteractionExportStateChangedError);
  });

  it("exports tombstone and purge receipts without reading revoked plaintext", async () => {
    const stored = revokedStored();
    const entries = version.interactionCapture.artifacts.map((_artifact, index) => {
      const entry = availableEntry(version, index);
      return {
        ...entry,
        metadata:
          index === 0
            ? {
                ...entry.metadata,
                purgedAt: "2026-08-29T00:03:00.000Z",
                state: "purged" as const,
                tombstonedAt: stored.revocation.revokedAt,
              }
            : {
                ...entry.metadata,
                state: "tombstoned" as const,
                tombstonedAt: stored.revocation.revokedAt,
              },
      };
    });
    const firstEntry = entries[0];
    if (!firstEntry) throw new Error("Export test purge artifact is missing");
    const receipt = {
      artifactId: firstEntry.metadata.contentReference.artifactId,
      objectWasPresent: true,
      occurredAt: "2026-08-29T00:03:00.000Z",
      purgeId: "purge_export_test",
    };
    const readArtifact = { execute: vi.fn() };
    const result = await new ExportRecordedInteractionFixtureContent({
      catalog: catalog(entries, [receipt]),
      readArtifact,
      readRecordedFixtureMetadata: { execute: vi.fn(async () => stored) },
    }).execute(command(["dataset:read", "artifact:read"]));

    expect(result.artifacts[0]).toMatchObject({
      artifact: { lifecycleStatus: "purged", purgeReceipt: { purgeId: receipt.purgeId } },
      content: { status: "purged" },
    });
    expect(result.artifacts[1]).toMatchObject({
      artifact: { lifecycleStatus: "revoked" },
      content: { status: "revoked" },
    });
    expect(readArtifact.execute).not.toHaveBeenCalled();
  });

  it("denies missing plaintext authority before any fixture or artifact storage access", async () => {
    const artifactCatalog = catalog([]);
    const readArtifact = { execute: vi.fn() };
    const readRecordedFixtureMetadata = { execute: vi.fn(async () => availableStored()) };
    await expect(
      new ExportRecordedInteractionFixtureContent({
        catalog: artifactCatalog,
        readArtifact,
        readRecordedFixtureMetadata,
      }).execute(command(["dataset:read"])),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(readRecordedFixtureMetadata.execute).not.toHaveBeenCalled();
    expect(artifactCatalog.find).not.toHaveBeenCalled();
    expect(readArtifact.execute).not.toHaveBeenCalled();
  });

  it("requires restricted authority before crossing the artifact storage boundary", async () => {
    const restrictedVersion: RecordedInteractionFixtureVersion = {
      ...version,
      interactionCapture: {
        ...version.interactionCapture,
        artifacts: version.interactionCapture.artifacts.map((artifact, index) =>
          index === 0
            ? {
                ...artifact,
                contentReference: {
                  ...artifact.contentReference,
                  classification: "restricted" as const,
                },
              }
            : artifact,
        ),
      },
    };
    const artifactCatalog = catalog([]);
    const readArtifact = { execute: vi.fn() };
    const readRecordedFixtureMetadata = {
      execute: vi.fn(async () => availableStored(restrictedVersion)),
    };
    await expect(
      new ExportRecordedInteractionFixtureContent({
        catalog: artifactCatalog,
        readArtifact,
        readRecordedFixtureMetadata,
      }).execute(command(["dataset:read", "artifact:read"])),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(readRecordedFixtureMetadata.execute).toHaveBeenCalledOnce();
    expect(artifactCatalog.find).not.toHaveBeenCalled();
    expect(readArtifact.execute).not.toHaveBeenCalled();
  });

  it("exports verified content and reports a missing object explicitly", async () => {
    const entries = version.interactionCapture.artifacts.map((_artifact, index) =>
      availableEntry(version, index),
    );
    const readArtifact = {
      execute: vi.fn(async ({ artifactId }: { readonly artifactId: string }) => {
        const index = entries.findIndex(
          ({ metadata }) => metadata.contentReference.artifactId === artifactId,
        );
        const entry = entries[index];
        if (!entry) throw new Error("Unexpected export artifact");
        if (index === 0) throw new ArtifactObjectMissingError();
        return {
          content: Uint8Array.from({ length: entry.metadata.contentReference.sizeBytes }, () => 7),
          metadata: entry.metadata,
        };
      }),
    };
    const result = await new ExportRecordedInteractionFixtureContent({
      catalog: catalog(entries),
      readArtifact,
      readRecordedFixtureMetadata: { execute: vi.fn(async () => availableStored()) },
    }).execute(command(["dataset:read", "artifact:read"]));

    expect(result.artifacts[0]?.content).toEqual({ status: "missing" });
    expect(result.artifacts[1]?.content).toMatchObject({
      encoding: "base64url",
      status: "available",
    });
    expect(readArtifact.execute).toHaveBeenCalledTimes(entries.length);
  });

  it("reports a concurrent unavailable read and rejects changed catalog metadata", async () => {
    const entries = version.interactionCapture.artifacts.map((_artifact, index) =>
      availableEntry(version, index),
    );
    const unavailableRead = {
      execute: vi.fn(async ({ artifactId }: { readonly artifactId: string }) => {
        const index = entries.findIndex(
          ({ metadata }) => metadata.contentReference.artifactId === artifactId,
        );
        const entry = entries[index];
        if (!entry) throw new Error("Unexpected export artifact");
        if (index === 0) throw new ArtifactUnavailableError();
        return {
          content: Uint8Array.from({ length: entry.metadata.contentReference.sizeBytes }, () => 7),
          metadata: entry.metadata,
        };
      }),
    };
    const unavailable = await new ExportRecordedInteractionFixtureContent({
      catalog: catalog(entries),
      readArtifact: unavailableRead,
      readRecordedFixtureMetadata: { execute: vi.fn(async () => availableStored()) },
    }).execute(command(["dataset:read", "artifact:read"]));
    expect(unavailable.artifacts[0]?.content).toEqual({ status: "unavailable" });

    const firstEntry = entries[0];
    if (!firstEntry) throw new Error("Export test artifact is missing");
    await expect(
      new ExportRecordedInteractionFixtureContent({
        catalog: catalog(entries),
        readArtifact: {
          execute: vi.fn(async () => ({
            content: new Uint8Array(64),
            metadata: { ...firstEntry.metadata, createdAt: "2026-08-29T00:00:41.000Z" },
          })),
        },
        readRecordedFixtureMetadata: { execute: vi.fn(async () => availableStored()) },
      }).execute(command(["dataset:read", "artifact:read"])),
    ).rejects.toBeInstanceOf(InteractionExportStateChangedError);
  });

  it("rejects aggregate content size before reading object storage", async () => {
    const oversizedVersion: RecordedInteractionFixtureVersion = {
      ...version,
      interactionCapture: {
        ...version.interactionCapture,
        artifacts: version.interactionCapture.artifacts.map((artifact) => ({
          ...artifact,
          contentReference: {
            ...artifact.contentReference,
            sizeBytes: 3 * 1024 * 1024,
          },
        })),
      },
    };
    const entries = oversizedVersion.interactionCapture.artifacts.map((_artifact, index) =>
      availableEntry(oversizedVersion, index),
    );
    const readArtifact = { execute: vi.fn() };
    await expect(
      new ExportRecordedInteractionFixtureContent({
        catalog: catalog(entries),
        readArtifact,
        readRecordedFixtureMetadata: {
          execute: vi.fn(async () => availableStored(oversizedVersion)),
        },
      }).execute(command(["dataset:read", "artifact:read"])),
    ).rejects.toBeInstanceOf(InteractionContentExportTooLargeError);
    expect(readArtifact.execute).not.toHaveBeenCalled();
  });
});
