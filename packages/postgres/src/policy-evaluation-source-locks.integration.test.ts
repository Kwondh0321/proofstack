import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ArtifactCatalogEntry } from "@proofstack/artifacts";
import {
  type EvidenceScope,
  RecordedInteractionFixtureVersionDefinitionSchema,
  RecordedInteractionFixtureVersionSchema,
  RegressionFixtureVersionDefinitionSchema,
  RegressionFixtureVersionSchema,
} from "@proofstack/contracts";
import { createReleasePolicyRepositoryTestHarness } from "@proofstack/core/testing";
import {
  digestRecordedInteractionFixtureVersionDefinition,
  digestRegressionFixtureVersionDefinition,
} from "@proofstack/datasets";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { loadBundledMigrations } from "./migrations.js";
import { PostgresArtifactCatalogRepository } from "./postgres-artifact-catalog-repository.js";
import { PostgresRegressionVersionRepository } from "./postgres-regression-version-repository.js";
import { PostgresReleasePolicyRepository } from "./postgres-release-policy-repository.js";
import { provisionRuntimeRoles, type RuntimeRoleProvisioningOptions } from "./runtime-roles.js";
import { withExactScopeTransaction } from "./tenant-transaction.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const credentials = Object.fromEntries(
  [
    "api",
    "artifact",
    "consumer",
    "evaluationWorker",
    "humanReviewer",
    "identity",
    "modelEvaluationWorker",
    "policyAuthor",
    "publisher",
    "replayWorker",
  ].map((kind) => [
    kind,
    {
      name: `ps_guard_${kind.toLowerCase()}_${runKey}`,
      password: `proofstack-source-guard-${kind}-${runKey}`,
    },
  ]),
) as unknown as RuntimeRoleProvisioningOptions;
const admin = new Pool({ connectionString: databaseUrl, max: 8 });
function runtime(kind: keyof RuntimeRoleProvisioningOptions): Pool {
  const url = new URL(databaseUrl as string);
  url.username = credentials[kind].name;
  url.password = credentials[kind].password;
  return new Pool({ connectionString: url.toString(), max: 4 });
}
const api = runtime("api");
const maintainer = runtime("artifact");
const author = runtime("policyAuthor");
const artifacts = new PostgresArtifactCatalogRepository(api);
const maintenance = new PostgresArtifactCatalogRepository(maintainer);
const policies = new PostgresReleasePolicyRepository(author);
const migrationId = "0050_policy_evaluation_source_locks";
const guardSql = "SELECT public.proofstack_try_lock_policy_evaluation_source($1, $2) AS acquired";
type Kind = "artifact" | "release_policy";

function scope(): EvidenceScope {
  const id = randomUUID().replaceAll("-", "").slice(0, 12);
  return { tenantId: `ten_guard_${id}`, projectId: "prj_guard", environmentId: "env_guard" };
}

function reserved(target: EvidenceScope, artifactId = "art_guard"): ArtifactCatalogEntry {
  return {
    createdByPrincipalId: "usr_guard",
    encryption: {
      contentNonce: Buffer.alloc(12, 1).toString("base64url"),
      version: "a256gcm-v1",
      wrappedDataKey: {
        algorithm: "A256GCM",
        keyId: "key_guard",
        ciphertext: Buffer.alloc(32, 2).toString("base64url"),
        nonce: Buffer.alloc(12, 3).toString("base64url"),
        tag: Buffer.alloc(16, 4).toString("base64url"),
      },
    },
    metadata: {
      contentReference: {
        artifactId,
        classification: "confidential",
        mediaType: "application/json",
        sha256: "1".repeat(64),
        sizeBytes: 18,
      },
      createdAt: "2026-08-29T05:00:40.000Z",
      redaction: { status: "not_required" },
      retention: { mode: "retain" },
      schemaVersion: "0.1",
      scope: target,
      state: "reserved",
    },
    objectKey: `objects/${target.tenantId}/${artifactId}`,
  };
}

async function begin(client: PoolClient, target: EvidenceScope, isolation = "READ COMMITTED") {
  // Isolation values below are fixed test cases, never external input.
  await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  await client.query(
    `SELECT set_config('proofstack.tenant_id', $1, true),
      set_config('proofstack.project_id', $2, true),
      set_config('proofstack.environment_id', $3, true)`,
    [target.tenantId, target.projectId, target.environmentId],
  );
}

async function acquire(client: PoolClient, kind: Kind, id: string): Promise<boolean> {
  return (
    (await client.query<{ acquired: boolean }>(guardSql, [kind, id])).rows[0]?.acquired === true
  );
}

/** Proves a real advisory wait, not merely a promise that has not resolved after a timer. */
async function blocksWriter<T>(
  target: EvidenceScope,
  kind: Kind,
  id: string,
  write: () => Promise<T>,
  inspect: (client: PoolClient) => Promise<void>,
  end: "COMMIT" | "ROLLBACK" = "COMMIT",
): Promise<T> {
  const guard = await admin.connect();
  let pending: Promise<{ value: T } | { error: unknown }> | undefined;
  try {
    await begin(guard, target);
    expect(await acquire(guard, kind, id)).toBe(true);
    const pid = (await guard.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    pending = write().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await expect
      .poll(
        async () => {
          const result = await admin.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM pg_stat_activity
         WHERE $1 = ANY(pg_blocking_pids(pid)) AND wait_event = 'advisory'`,
            [pid],
          );
          return result.rows[0]?.count;
        },
        { timeout: 5_000, interval: 20 },
      )
      .toBeGreaterThan(0);
    await inspect(guard);
    await guard.query(end);
    const outcome = await pending;
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  } finally {
    await guard.query("ROLLBACK");
    guard.release();
    await pending;
  }
}

beforeAll(async () => {
  await migrateDatabase(admin);
  await provisionRuntimeRoles(admin, credentials);
});
afterAll(async () => {
  await Promise.all([api.end(), maintainer.end(), author.end()]);
  for (const { name } of Object.values(credentials)) {
    await admin.query(`DROP OWNED BY "${name}"`);
    await admin.query(`DROP ROLE "${name}"`);
  }
  await admin.end();
});

describe("policy evaluation database source serialization", () => {
  it("installs enabled invoker triggers without granting existing runtime roles a seal capability", async () => {
    const triggers = await admin.query<{ table_name: string; tgenabled: string }>(
      `SELECT tgrelid::regclass::text AS table_name, tgenabled
       FROM pg_trigger WHERE tgname = 'proofstack_policy_evaluation_source_write_lock'
       ORDER BY table_name`,
    );
    expect(triggers.rows).toEqual(
      [
        "proofstack_artifact_catalog",
        "proofstack_interaction_fixture_artifact_ownerships",
        "proofstack_release_policies",
        "proofstack_release_policy_lifecycle_events",
      ].map((table_name) => ({ table_name, tgenabled: "O" })),
    );
    const functions = await admin.query<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[];
    }>(
      `SELECT proname, prosecdef, proconfig FROM pg_proc WHERE proname IN (
        'proofstack_try_lock_policy_evaluation_source', 'proofstack_lock_policy_evaluation_source_write'
      ) ORDER BY proname`,
    );
    expect(functions.rows).toHaveLength(2);
    for (const row of functions.rows) {
      expect(row.prosecdef).toBe(false);
      expect(row.proconfig).toEqual(["search_path=pg_catalog"]);
      for (const { name } of Object.values(credentials)) {
        const signature = `${row.proname}(${row.proname.includes("try_lock") ? "text,text" : ""})`;
        expect(
          (
            await admin.query<{ allowed: boolean }>(
              "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
              [name, signature],
            )
          ).rows[0]?.allowed,
        ).toBe(false);
      }
    }
    await expect(
      withExactScopeTransaction(api, scope(), (client) => acquire(client, "artifact", "art_guard")),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it.each([
    [null, "art_valid"],
    ["unknown", "art_valid"],
    ["artifact", null],
    ["artifact", ""],
    ["artifact", "art invalid"],
    ["artifact", "a".repeat(65)],
    ["release_policy", "ABC"],
  ])("rejects invalid source identity %s / %s", async (kind, id) => {
    await expect(
      withExactScopeTransaction(admin, scope(), (client) => client.query(guardSql, [kind, id])),
    ).rejects.toMatchObject({ code: "22023" });
  });

  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "requires exact %s context",
    async (field) => {
      await expect(
        withExactScopeTransaction(admin, { ...scope(), [field]: "" }, (client) =>
          acquire(client, "artifact", "art_guard"),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    },
  );

  it.each(["REPEATABLE READ", "SERIALIZABLE"])(
    "rejects a potentially stale %s snapshot",
    async (isolation) => {
      const client = await admin.connect();
      try {
        await begin(client, scope(), isolation);
        await expect(acquire(client, "artifact", "art_guard")).rejects.toMatchObject({
          code: "0A000",
        });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    },
  );

  it.each(["COMMIT", "ROLLBACK"] as const)(
    "guards absent artifact creation until %s",
    async (end) => {
      const target = scope();
      const entry = reserved(target);
      const result = await blocksWriter(
        target,
        "artifact",
        "art_guard",
        () => artifacts.reserve(entry),
        async () => {
          expect(await artifacts.find(target, "art_guard")).toBeNull();
        },
        end,
      );
      expect(result).toEqual({ created: true, entry });
      expect(await artifacts.find(target, "art_guard")).toEqual(entry);
    },
  );

  it.each(["available", "tombstoned", "purged"] as const)(
    "serializes the runtime %s transition",
    async (state) => {
      const target = scope();
      await artifacts.reserve(reserved(target));
      const activate = () =>
        artifacts.activate(
          target,
          "art_guard",
          { sha256: "a".repeat(64), sizeBytes: 38 },
          "2026-08-29T05:00:50.000Z",
        );
      const tombstone = () =>
        maintenance.tombstone(target, {
          artifactId: "art_guard",
          tombstoneId: "del_guard",
          actorPrincipalId: "usr_guard",
          reason: "Source lock test",
          trigger: "manual",
          occurredAt: "2026-08-29T06:00:00.000Z",
        });
      if (state !== "available") await activate();
      if (state === "purged") await tombstone();
      const before = await artifacts.find(target, "art_guard");
      await blocksWriter(
        target,
        "artifact",
        "art_guard",
        async () => {
          if (state === "available") await activate();
          else if (state === "tombstoned") await tombstone();
          else
            await maintenance.recordPurge(target, {
              artifactId: "art_guard",
              purgeId: "pur_guard",
              objectWasPresent: true,
              occurredAt: "2026-08-29T07:00:00.000Z",
            });
        },
        async () => {
          expect(await artifacts.find(target, "art_guard")).toEqual(before);
        },
      );
      expect((await artifacts.find(target, "art_guard"))?.metadata.state).toBe(state);
    },
  );

  it("covers direct SQL activation and returns false without waiting when the writer wins", async () => {
    const target = scope();
    await artifacts.reserve(reserved(target));
    const write = (client: PoolClient) =>
      client.query(
        `UPDATE public.proofstack_artifact_catalog SET state = 'available',
       available_at = '2026-08-29T05:00:50.000Z', object_receipt_sha256 = $3,
       object_receipt_size_bytes = 38 WHERE tenant_id = $1 AND artifact_id = $2`,
        [target.tenantId, "art_guard", "a".repeat(64)],
      );
    const writer = await api.connect();
    try {
      await begin(writer, target);
      await write(writer);
      await withExactScopeTransaction(admin, target, async (client) => {
        await client.query("SET LOCAL statement_timeout = '1000ms'");
        expect(await acquire(client, "artifact", "art_guard")).toBe(false);
      });
      await writer.query("ROLLBACK");
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
    }
    await blocksWriter(
      target,
      "artifact",
      "art_guard",
      () => withExactScopeTransaction(api, target, write),
      async () => {
        expect((await artifacts.find(target, "art_guard"))?.metadata.state).toBe("reserved");
      },
    );
    expect((await artifacts.find(target, "art_guard"))?.metadata.state).toBe("available");
  });

  it("lets shared observers coexist and keeps unrelated tenants and source kinds independent", async () => {
    const target = scope();
    const first = await admin.connect();
    const second = await admin.connect();
    try {
      await begin(first, target);
      expect(await acquire(first, "artifact", "art_guard")).toBe(true);
      await begin(second, target);
      expect(await acquire(second, "artifact", "art_guard")).toBe(true);
      await second.query("COMMIT");
      await artifacts.reserve(reserved(scope()));
      await artifacts.reserve(reserved(target, "art_other"));
      await first.query("COMMIT");
      await begin(first, target);
      expect(await acquire(first, "release_policy", "art_guard")).toBe(true);
      await artifacts.reserve(reserved(target));
    } finally {
      await first.query("ROLLBACK");
      await second.query("ROLLBACK");
      first.release();
      second.release();
    }
  });

  it.each(["withdrawn", "superseded"] as const)(
    "guards %s publication through both adapter and SQL entry points",
    async (kind) => {
      for (const raw of [false, true]) {
        const fixture = createReleasePolicyRepositoryTestHarness(
          `guard_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
        );
        await policies.publishReleasePolicy(fixture.policy);
        if (kind === "superseded") await policies.publishReleasePolicy(fixture.successor);
        const event = kind === "withdrawn" ? fixture.withdrawal : fixture.supersession;
        await blocksWriter(
          fixture.scope,
          "release_policy",
          fixture.policy.policyVersionId,
          async () => {
            if (!raw) {
              await policies.publishReleasePolicyLifecycleEvent(event);
              return;
            }
            await withExactScopeTransaction(author, fixture.scope, (client) =>
              client.query("SELECT public.proofstack_publish_release_policy_lifecycle($1::jsonb)", [
                JSON.stringify({
                  actorPrincipalId: event.actorPrincipalId,
                  environmentId: event.scope.environmentId,
                  eventId: event.eventId,
                  occurredAt: event.occurredAt,
                  projectId: event.scope.projectId,
                  record: event,
                  schemaVersion: event.schemaVersion,
                  tenantId: event.scope.tenantId,
                }),
              ]),
            );
          },
          async () => {
            expect(
              await policies.listReleasePolicyLifecycleEvents(
                fixture.scope,
                fixture.policy.policyVersionId,
              ),
            ).toEqual([]);
          },
        );
        expect(
          await policies.listReleasePolicyLifecycleEvents(
            fixture.scope,
            fixture.policy.policyVersionId,
          ),
        ).toEqual([event]);
      }
    },
  );

  it("rolls back earlier shared guards after a later conflict without a wait cycle", async () => {
    const target = scope();
    await artifacts.reserve(reserved(target, "art_second"));
    const writer = await api.connect();
    const observer = await admin.connect();
    try {
      await begin(writer, target);
      await writer.query(
        `UPDATE public.proofstack_artifact_catalog SET state = 'available',
         available_at = '2026-08-29T05:00:50.000Z', object_receipt_sha256 = $2,
         object_receipt_size_bytes = 38 WHERE tenant_id = $1 AND artifact_id = 'art_second'`,
        [target.tenantId, "a".repeat(64)],
      );
      await begin(observer, target);
      await observer.query("SET LOCAL statement_timeout = '1000ms'");
      expect(await acquire(observer, "artifact", "art_first")).toBe(true);
      expect(await acquire(observer, "artifact", "art_second")).toBe(false);
      await observer.query("ROLLBACK");
      // A different writer can now create the earlier, absent guarded resource.
      expect((await artifacts.reserve(reserved(target, "art_first"))).created).toBe(true);
      await writer.query("COMMIT");
      await begin(observer, target);
      expect(await acquire(observer, "artifact", "art_second")).toBe(true);
      expect(
        (
          await observer.query<{ state: string }>(
            "SELECT state FROM public.proofstack_artifact_catalog WHERE tenant_id = $1 AND artifact_id = 'art_second'",
            [target.tenantId],
          )
        ).rows[0]?.state,
      ).toBe("available");
    } finally {
      await observer.query("ROLLBACK");
      await writer.query("ROLLBACK");
      observer.release();
      writer.release();
    }
  });

  it("uses the tenant-wide resource identity across project contexts without granting visibility", async () => {
    const target = scope();
    const guardScope = { ...target, projectId: "prj_other", environmentId: "env_other" };
    await blocksWriter(
      guardScope,
      "artifact",
      "art_guard",
      () => artifacts.reserve(reserved(target)),
      async () => {
        expect(await artifacts.find(guardScope, "art_guard")).toBeNull();
      },
    );
    expect(await artifacts.find(guardScope, "art_guard")).toBeNull();
    expect(await artifacts.find(target, "art_guard")).toEqual(reserved(target));
  });

  it("releases a guarded transaction on failure without changing the source", async () => {
    const target = scope();
    const failure = new Error("Abort before publication");
    await expect(
      withExactScopeTransaction(admin, target, async (client) => {
        expect(await acquire(client, "artifact", "art_guard")).toBe(true);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await artifacts.find(target, "art_guard")).toBeNull();
    expect((await artifacts.reserve(reserved(target))).created).toBe(true);
  });

  it("guards a previously missing policy version", async () => {
    const fixture = createReleasePolicyRepositoryTestHarness(
      `guard_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    );
    await blocksWriter(
      fixture.scope,
      "release_policy",
      fixture.policy.policyVersionId,
      () => policies.publishReleasePolicy(fixture.policy),
      async () => {
        expect(
          await policies.findReleasePolicy(fixture.scope, fixture.policy.policyVersionId),
        ).toBeNull();
      },
    );
    expect(await policies.findReleasePolicy(fixture.scope, fixture.policy.policyVersionId)).toEqual(
      fixture.policy,
    );
  });

  it("serializes fixture ownership even when catalog state does not change", async () => {
    const document = JSON.parse(
      readFileSync(
        new URL("../../datasets/vectors/interaction-fixture-definition-v2.json", import.meta.url),
        "utf8",
      ),
    ) as { vectors: { input: unknown }[] };
    const vector = RecordedInteractionFixtureVersionDefinitionSchema.parse(
      document.vectors[0]?.input,
    );
    const target = scope();
    const source = { ...vector.source, capturedAt: "2026-08-29T05:00:00.000Z" };
    const predecessorDefinition = RegressionFixtureVersionDefinitionSchema.parse({
      schemaVersion: "0.1",
      scope: target,
      fixtureId: vector.fixtureId,
      fixtureVersionId: vector.predecessor.fixtureVersionId,
      name: "Guard predecessor",
      replayability: "evidence_only",
      source: vector.source,
    });
    const predecessor = RegressionFixtureVersionSchema.parse({
      ...predecessorDefinition,
      source,
      createdAt: "2026-08-29T05:00:30.000Z",
      createdByPrincipalId: "usr_guard",
      definitionSha256: digestRegressionFixtureVersionDefinition(predecessorDefinition),
    });
    const definition = RecordedInteractionFixtureVersionDefinitionSchema.parse({
      ...vector,
      scope: target,
      predecessor: {
        fixtureVersionId: predecessor.fixtureVersionId,
        definitionSha256: predecessor.definitionSha256,
      },
    });
    const fixture = RecordedInteractionFixtureVersionSchema.parse({
      ...definition,
      source,
      createdAt: "2026-08-29T05:01:00.000Z",
      createdByPrincipalId: "usr_guard",
      definitionSha256: digestRecordedInteractionFixtureVersionDefinition(definition),
    });
    const repository = new PostgresRegressionVersionRepository(api);
    await repository.publishFixtureVersion(predecessor);
    for (const binding of fixture.interactionCapture.artifacts) {
      const entry = reserved(target, binding.contentReference.artifactId);
      await artifacts.reserve({
        ...entry,
        metadata: {
          ...entry.metadata,
          contentReference: binding.contentReference,
          redaction: binding.redaction,
          retention: binding.retention,
        },
      });
      await artifacts.activate(
        target,
        binding.contentReference.artifactId,
        { sha256: "a".repeat(64), sizeBytes: binding.contentReference.sizeBytes + 20 },
        "2026-08-29T05:00:50.000Z",
      );
    }
    const artifactId = fixture.interactionCapture.artifacts[0]?.contentReference.artifactId;
    if (!artifactId) throw new Error("Fixture needs an owned artifact");
    const before = await artifacts.find(target, artifactId);
    await blocksWriter(
      target,
      "artifact",
      artifactId,
      () => repository.publishRecordedInteractionFixtureVersion(fixture),
      async () => {
        expect(await artifacts.find(target, artifactId)).toEqual(before);
      },
    );
    expect((await artifacts.find(target, artifactId))?.ownership?.owner.fixtureVersionId).toBe(
      fixture.fixtureVersionId,
    );
  });

  it("upgrades existing catalog and lifecycle rows without rewriting them", async () => {
    const name = `ps_guard_upgrade_${runKey}`;
    const url = new URL(databaseUrl as string);
    url.pathname = `/${name}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    const upgrade = new Pool({ connectionString: url.toString(), max: 1 });
    try {
      const migrations = await loadBundledMigrations();
      const index = migrations.findIndex(({ id }) => id === migrationId);
      expect(index).toBeGreaterThan(0);
      await migrateDatabase(upgrade, migrations.slice(0, index));
      const catalog = new PostgresArtifactCatalogRepository(upgrade);
      const entry = reserved(scope());
      await catalog.reserve(entry);
      const repository = new PostgresReleasePolicyRepository(upgrade);
      const fixture = createReleasePolicyRepositoryTestHarness("guard_upgrade");
      await repository.publishReleasePolicy(fixture.policy);
      await repository.publishReleasePolicyLifecycleEvent(fixture.withdrawal);
      const ledger = await upgrade.query(
        "SELECT id, checksum FROM proofstack_schema_migrations ORDER BY id",
      );
      expect((await migrateDatabase(upgrade)).newlyAppliedIds).toEqual([migrationId]);
      expect(
        (
          await upgrade.query("SELECT id, checksum FROM proofstack_schema_migrations ORDER BY id")
        ).rows.slice(0, index),
      ).toEqual(ledger.rows);
      expect(await catalog.find(entry.metadata.scope, "art_guard")).toEqual(entry);
      expect(
        await repository.findReleasePolicy(fixture.scope, fixture.policy.policyVersionId),
      ).toEqual(fixture.policy);
      expect(
        await repository.listReleasePolicyLifecycleEvents(
          fixture.scope,
          fixture.policy.policyVersionId,
        ),
      ).toEqual([fixture.withdrawal]);
      expect((await migrateDatabase(upgrade)).newlyAppliedIds).toEqual([]);
    } finally {
      await upgrade.end();
      await admin.query(`DROP DATABASE "${name}"`);
    }
  });
});
