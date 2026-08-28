import assert from "node:assert/strict";
import type { ArtifactMetadata, ArtifactTombstone, EvidenceScope } from "@proofstack/contracts";
import type {
  ArtifactCatalogEntry,
  ArtifactCatalogRepository,
  ArtifactObjectReceipt,
  ArtifactPurgeReceipt,
} from "../artifact-ports.js";
import {
  ArtifactConflictError,
  ArtifactNotFoundError,
  ArtifactStateTransitionError,
} from "../errors.js";

export interface ArtifactCatalogRepositoryTestHarness {
  readonly dispose?: () => Promise<void>;
  readonly repository: ArtifactCatalogRepository;
}

export type ArtifactCatalogRepositoryTestFactory = (
  namespace: string,
) => ArtifactCatalogRepositoryTestHarness | Promise<ArtifactCatalogRepositoryTestHarness>;

export interface ArtifactCatalogRepositoryConformanceCase {
  readonly name: string;
  readonly run: (factory: ArtifactCatalogRepositoryTestFactory) => Promise<void>;
}

function scope(namespace: string, overrides: Partial<EvidenceScope> = {}): EvidenceScope {
  return {
    environmentId: `env_${namespace}`,
    projectId: `prj_${namespace}`,
    tenantId: `ten_${namespace}`,
    ...overrides,
  };
}

function encryption(seed: number) {
  return {
    contentNonce: Buffer.alloc(12, seed).toString("base64url"),
    version: "a256gcm-v1" as const,
    wrappedDataKey: {
      algorithm: "A256GCM" as const,
      ciphertext: Buffer.alloc(32, seed).toString("base64url"),
      keyId: `key_${seed}`,
      nonce: Buffer.alloc(12, seed + 1).toString("base64url"),
      tag: Buffer.alloc(16, seed + 2).toString("base64url"),
    },
  };
}

function reserved(
  namespace: string,
  options: {
    readonly artifactId?: string;
    readonly createdAt?: string;
    readonly expiresAt?: string;
    readonly retention?: "expire" | "retain";
    readonly scope?: Partial<EvidenceScope>;
    readonly seed?: number;
    readonly sha256?: string;
  } = {},
): ArtifactCatalogEntry {
  const artifactId = options.artifactId ?? `art_${namespace}`;
  const metadata: ArtifactMetadata = {
    contentReference: {
      artifactId,
      classification: "confidential",
      mediaType: "application/json",
      sha256: options.sha256 ?? "1".repeat(64),
      sizeBytes: 18,
    },
    createdAt: options.createdAt ?? "2026-08-28T03:00:00.000Z",
    redaction: { status: "not_required" },
    retention:
      options.retention === "retain"
        ? { mode: "retain" }
        : {
            expiresAt: options.expiresAt ?? "2026-09-28T03:00:00.000Z",
            mode: "expire",
          },
    schemaVersion: "0.1",
    scope: scope(namespace, options.scope),
    state: "reserved",
  };
  return {
    createdByPrincipalId: `usr_${namespace}`,
    encryption: encryption(options.seed ?? 1),
    metadata,
    objectKey: `artifacts/${namespace}/${artifactId}`,
  };
}

function objectReceipt(seed = "a"): ArtifactObjectReceipt {
  return { sha256: seed.repeat(64), sizeBytes: 38 };
}

function tombstone(
  artifactId: string,
  trigger: ArtifactTombstone["trigger"],
  overrides: Partial<ArtifactTombstone> = {},
): ArtifactTombstone {
  return {
    actorPrincipalId: "usr_maintainer",
    artifactId,
    occurredAt: "2026-09-29T03:00:00.000Z",
    reason: "Lifecycle contract cleanup",
    tombstoneId: `del_${artifactId}`,
    trigger,
    ...overrides,
  };
}

function purgeReceipt(artifactId: string, overrides: Partial<ArtifactPurgeReceipt> = {}) {
  return {
    artifactId,
    objectWasPresent: true,
    occurredAt: "2026-09-29T03:01:00.000Z",
    purgeId: `purge_${artifactId}`,
    ...overrides,
  };
}

async function withRepository(
  factory: ArtifactCatalogRepositoryTestFactory,
  namespace: string,
  test: (repository: ArtifactCatalogRepository) => Promise<void>,
): Promise<void> {
  const harness = await factory(namespace);
  try {
    await test(harness.repository);
  } finally {
    await harness.dispose?.();
  }
}

export const artifactCatalogRepositoryConformanceCases: readonly ArtifactCatalogRepositoryConformanceCase[] =
  [
    {
      name: "reserves immutable metadata idempotently and isolates every scope dimension",
      async run(factory) {
        await withRepository(factory, "catalog_reserve", async (repository) => {
          const candidate = reserved("catalog_reserve");
          const retry = {
            ...reserved("catalog_reserve", {
              createdAt: "2026-08-28T03:01:00.000Z",
              expiresAt: "2026-09-27T23:00:00.000-04:00",
              seed: 8,
            }),
            createdByPrincipalId: "usr_retry",
            objectKey: "artifacts/retry/different-object",
          };

          const first = await repository.reserve(candidate);
          const duplicate = await repository.reserve(retry);
          assert.equal(first.created, true);
          assert.equal(duplicate.created, false);
          assert.deepEqual(duplicate.entry, first.entry);
          assert.deepEqual(
            await repository.find(
              candidate.metadata.scope,
              candidate.metadata.contentReference.artifactId,
            ),
            first.entry,
          );
          assert.equal(
            await repository.find(
              { ...candidate.metadata.scope, projectId: "prj_other" },
              candidate.metadata.contentReference.artifactId,
            ),
            null,
          );
          assert.equal(
            await repository.find(
              { ...candidate.metadata.scope, environmentId: "env_other" },
              candidate.metadata.contentReference.artifactId,
            ),
            null,
          );
          assert.equal(
            await repository.find(
              { ...candidate.metadata.scope, tenantId: "ten_other" },
              candidate.metadata.contentReference.artifactId,
            ),
            null,
          );

          const otherTenant = reserved("catalog_reserve", {
            scope: { tenantId: "ten_other" },
          });
          assert.equal((await repository.reserve(otherTenant)).created, true);

          const retained = reserved("catalog_reserve", {
            artifactId: "art_retained_retry",
            retention: "retain",
          });
          const retainedFirst = await repository.reserve(retained);
          const retainedRetry = await repository.reserve({
            ...reserved("catalog_reserve", {
              artifactId: "art_retained_retry",
              createdAt: "2026-08-28T03:02:00.000Z",
              retention: "retain",
              seed: 9,
            }),
            createdByPrincipalId: "usr_retry",
            objectKey: "artifacts/retry/retained-object",
          });
          assert.equal(retainedRetry.created, false);
          assert.deepEqual(retainedRetry.entry, retainedFirst.entry);
        });
      },
    },
    {
      name: "rejects conflicting identifiers and invalid reservation states",
      async run(factory) {
        await withRepository(factory, "catalog_conflict", async (repository) => {
          const candidate = reserved("catalog_conflict");
          await repository.reserve(candidate);

          await assert.rejects(
            repository.reserve(reserved("catalog_conflict", { sha256: "2".repeat(64) })),
            ArtifactConflictError,
          );
          await assert.rejects(
            repository.reserve(reserved("catalog_conflict", { scope: { projectId: "prj_other" } })),
            ArtifactConflictError,
          );
          await assert.rejects(
            repository.reserve({
              ...candidate,
              metadata: {
                ...candidate.metadata,
                availableAt: "2026-08-28T03:01:00.000Z",
                state: "available",
              },
            }),
            ArtifactStateTransitionError,
          );
          await assert.rejects(
            repository.reserve({ ...reserved("catalog_receipt"), objectReceipt: objectReceipt() }),
            ArtifactStateTransitionError,
          );
        });
      },
    },
    {
      name: "activates one receipt idempotently and blocks conflicting or late activation",
      async run(factory) {
        await withRepository(factory, "catalog_activate", async (repository) => {
          const candidate = reserved("catalog_activate");
          const artifactId = candidate.metadata.contentReference.artifactId;
          const receipt = objectReceipt();
          await repository.reserve(candidate);

          const activated = await repository.activate(
            candidate.metadata.scope,
            artifactId,
            receipt,
            "2026-08-28T03:02:00.000Z",
          );
          assert.equal(activated.metadata.state, "available");
          assert.equal(activated.metadata.availableAt, "2026-08-28T03:02:00.000Z");
          assert.deepEqual(activated.objectReceipt, receipt);
          assert.deepEqual(
            await repository.activate(
              candidate.metadata.scope,
              artifactId,
              receipt,
              "2026-08-28T03:03:00.000Z",
            ),
            activated,
          );
          await assert.rejects(
            repository.activate(
              candidate.metadata.scope,
              artifactId,
              objectReceipt("b"),
              "2026-08-28T03:03:00.000Z",
            ),
            ArtifactConflictError,
          );
          await repository.tombstone(candidate.metadata.scope, tombstone(artifactId, "manual"));
          await assert.rejects(
            repository.activate(
              candidate.metadata.scope,
              artifactId,
              receipt,
              "2026-09-29T03:03:00.000Z",
            ),
            ArtifactStateTransitionError,
          );
          await assert.rejects(
            repository.activate(
              candidate.metadata.scope,
              "art_missing",
              receipt,
              activated.metadata.availableAt,
            ),
            ArtifactNotFoundError,
          );
        });
      },
    },
    {
      name: "records one state-appropriate tombstone and preserves its first attribution",
      async run(factory) {
        await withRepository(factory, "catalog_tombstone", async (repository) => {
          const abandoned = reserved("catalog_tombstone", { artifactId: "art_abandoned" });
          await repository.reserve(abandoned);
          await assert.rejects(
            repository.tombstone(abandoned.metadata.scope, tombstone("art_abandoned", "manual")),
            ArtifactStateTransitionError,
          );

          const first = await repository.tombstone(
            abandoned.metadata.scope,
            tombstone("art_abandoned", "abandoned"),
          );
          const retry = await repository.tombstone(
            abandoned.metadata.scope,
            tombstone("art_abandoned", "abandoned", {
              occurredAt: "2026-09-29T03:05:00.000Z",
              tombstoneId: "del_retry",
            }),
          );
          assert.equal(first.created, true);
          assert.equal(retry.created, false);
          assert.deepEqual(retry, { ...first, created: false });
          await assert.rejects(
            repository.tombstone(
              abandoned.metadata.scope,
              tombstone("art_abandoned", "abandoned", { reason: "Different reason" }),
            ),
            ArtifactConflictError,
          );

          const available = reserved("catalog_tombstone", { artifactId: "art_available" });
          await repository.reserve(available);
          await repository.activate(
            available.metadata.scope,
            "art_available",
            objectReceipt(),
            "2026-08-28T03:02:00.000Z",
          );
          await assert.rejects(
            repository.tombstone(available.metadata.scope, tombstone("art_available", "abandoned")),
            ArtifactStateTransitionError,
          );
          assert.equal(
            (
              await repository.tombstone(
                available.metadata.scope,
                tombstone("art_available", "retention"),
              )
            ).entry.metadata.state,
            "tombstoned",
          );
          await assert.rejects(
            repository.tombstone(available.metadata.scope, tombstone("art_missing", "manual")),
            ArtifactNotFoundError,
          );
        });
      },
    },
    {
      name: "records purge completion once and only after a tombstone",
      async run(factory) {
        await withRepository(factory, "catalog_purge", async (repository) => {
          const candidate = reserved("catalog_purge");
          const artifactId = candidate.metadata.contentReference.artifactId;
          await repository.reserve(candidate);
          await assert.rejects(
            repository.recordPurge(candidate.metadata.scope, purgeReceipt(artifactId)),
            ArtifactStateTransitionError,
          );
          await repository.tombstone(candidate.metadata.scope, tombstone(artifactId, "abandoned"));

          const purged = await repository.recordPurge(
            candidate.metadata.scope,
            purgeReceipt(artifactId),
          );
          assert.equal(purged.metadata.state, "purged");
          assert.equal(purged.metadata.purgedAt, "2026-09-29T03:01:00.000Z");
          assert.deepEqual(
            await repository.recordPurge(
              candidate.metadata.scope,
              purgeReceipt(artifactId, {
                objectWasPresent: false,
                occurredAt: "2026-09-29T03:02:00.000Z",
                purgeId: "purge_retry",
              }),
            ),
            purged,
          );
          await assert.rejects(
            repository.recordPurge(candidate.metadata.scope, purgeReceipt("art_missing")),
            ArtifactNotFoundError,
          );

          const available = reserved("catalog_purge", { artifactId: "art_available" });
          await repository.reserve(available);
          await repository.activate(
            available.metadata.scope,
            "art_available",
            objectReceipt(),
            "2026-08-28T03:02:00.000Z",
          );
          await assert.rejects(
            repository.recordPurge(available.metadata.scope, purgeReceipt("art_available")),
            ArtifactStateTransitionError,
          );
        });
      },
    },
    {
      name: "lists expired and purge-pending work in deterministic bounded order",
      async run(factory) {
        await withRepository(factory, "catalog_list", async (repository) => {
          const entries = [
            reserved("catalog_list", {
              artifactId: "art_b",
              expiresAt: "2026-08-31T20:00:00.000-04:00",
            }),
            reserved("catalog_list", {
              artifactId: "art_a",
              expiresAt: "2026-09-01T00:00:00.000Z",
            }),
            reserved("catalog_list", {
              artifactId: "art_later",
              expiresAt: "2026-10-01T00:00:00.000Z",
            }),
            reserved("catalog_list", { artifactId: "art_retain", retention: "retain" }),
            reserved("catalog_list", {
              artifactId: "art_other_scope",
              scope: { environmentId: "env_other" },
            }),
            reserved("catalog_list", {
              artifactId: "art_reserved_c",
              createdAt: "2026-08-28T02:59:00.000Z",
            }),
            reserved("catalog_list", { artifactId: "art_reserved_b" }),
            reserved("catalog_list", { artifactId: "art_reserved_a" }),
            reserved("catalog_list", {
              artifactId: "art_reserved_future",
              createdAt: "2026-08-28T04:00:00.000Z",
            }),
          ];
          for (const entry of entries) await repository.reserve(entry);
          for (const entry of entries.slice(0, 5)) {
            await repository.activate(
              entry.metadata.scope,
              entry.metadata.contentReference.artifactId,
              objectReceipt(),
              "2026-08-28T03:02:00.000Z",
            );
          }

          const expired = await repository.listExpired(
            scope("catalog_list"),
            "2026-09-01T00:00:00.000Z",
            1,
          );
          assert.deepEqual(
            expired.map(({ metadata }) => metadata.contentReference.artifactId),
            ["art_a"],
          );

          await repository.tombstone(
            scope("catalog_list"),
            tombstone("art_a", "retention", { occurredAt: "2026-09-02T00:00:00.000Z" }),
          );
          await repository.tombstone(
            scope("catalog_list"),
            tombstone("art_b", "retention", {
              occurredAt: "2026-09-01T20:00:00.000-04:00",
            }),
          );
          await repository.tombstone(
            scope("catalog_list"),
            tombstone("art_later", "retention", {
              occurredAt: "2026-09-03T00:00:00.000Z",
            }),
          );
          const pending = await repository.listPendingPurge(scope("catalog_list"), 10);
          assert.deepEqual(
            pending.map(({ metadata }) => metadata.contentReference.artifactId),
            ["art_a", "art_b", "art_later"],
          );

          await repository.recordPurge(
            scope("catalog_list"),
            purgeReceipt("art_a", { occurredAt: "2026-09-04T00:00:00.000Z" }),
          );
          assert.deepEqual(
            (await repository.listPendingPurge(scope("catalog_list"), 10)).map(
              ({ metadata }) => metadata.contentReference.artifactId,
            ),
            ["art_b", "art_later"],
          );

          assert.deepEqual(
            (
              await repository.listAbandoned(scope("catalog_list"), "2026-08-28T03:00:00.000Z", 2)
            ).map(({ metadata }) => metadata.contentReference.artifactId),
            ["art_reserved_c", "art_reserved_a"],
          );

          for (const invalidLimit of [0, 101, 1.5]) {
            await assert.rejects(
              repository.listAbandoned(
                scope("catalog_list"),
                "2026-08-28T03:00:00.000Z",
                invalidLimit,
              ),
              RangeError,
            );
            await assert.rejects(
              repository.listExpired(
                scope("catalog_list"),
                "2026-09-01T00:00:00.000Z",
                invalidLimit,
              ),
              RangeError,
            );
            await assert.rejects(
              repository.listPendingPurge(scope("catalog_list"), invalidLimit),
              RangeError,
            );
          }
        });
      },
    },
    {
      name: "summarizes encryption-key references by exact scope and lifecycle state",
      async run(factory) {
        await withRepository(factory, "catalog_keys", async (repository) => {
          const entries = [
            reserved("catalog_keys", { artifactId: "art_reserved", seed: 1 }),
            reserved("catalog_keys", { artifactId: "art_available", seed: 1 }),
            reserved("catalog_keys", { artifactId: "art_tombstoned", seed: 1 }),
            reserved("catalog_keys", { artifactId: "art_purged", seed: 1 }),
            reserved("catalog_keys", { artifactId: "art_second_key", seed: 2 }),
            reserved("catalog_keys", {
              artifactId: "art_other_environment",
              scope: { environmentId: "env_other" },
              seed: 3,
            }),
          ];
          for (const entry of entries) await repository.reserve(entry);
          for (const artifactId of [
            "art_available",
            "art_tombstoned",
            "art_purged",
            "art_second_key",
          ]) {
            await repository.activate(
              scope("catalog_keys"),
              artifactId,
              objectReceipt(),
              "2026-08-28T03:02:00.000Z",
            );
          }
          await repository.tombstone(scope("catalog_keys"), tombstone("art_tombstoned", "manual"));
          await repository.tombstone(scope("catalog_keys"), tombstone("art_purged", "manual"));
          await repository.recordPurge(scope("catalog_keys"), purgeReceipt("art_purged"));

          assert.deepEqual(await repository.listKeyReferences(scope("catalog_keys")), [
            {
              counts: { available: 1, purged: 1, reserved: 1, tombstoned: 1, total: 4 },
              keyId: "key_1",
            },
            {
              counts: { available: 1, purged: 0, reserved: 0, tombstoned: 0, total: 1 },
              keyId: "key_2",
            },
          ]);
          assert.deepEqual(
            await repository.listKeyReferences({
              ...scope("catalog_keys"),
              environmentId: "env_other",
            }),
            [
              {
                counts: { available: 0, purged: 0, reserved: 1, tombstoned: 0, total: 1 },
                keyId: "key_3",
              },
            ],
          );
          assert.deepEqual(
            await repository.listKeyReferences({
              ...scope("catalog_keys"),
              projectId: "prj_empty",
            }),
            [],
          );
        });
      },
    },
  ];
