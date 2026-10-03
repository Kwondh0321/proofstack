import { randomUUID } from "node:crypto";
import type { DiscoveryRecord, EvidenceEnvelope, EvidenceScope } from "@proofstack/contracts";
import {
  createEvaluationRepositoryTestHarness,
  publishEvaluationFixture,
} from "@proofstack/core/testing";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresEvaluationRepository } from "./postgres-evaluation-repository.js";
import { PostgresEvidenceRepository } from "./postgres-evidence-repository.js";
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
      name: `ps_meta_${kind.toLowerCase()}_${runKey}`,
      password: `proofstack-metadata-test-${kind}-${runKey}`,
    },
  ]),
) as unknown as RuntimeRoleProvisioningOptions;
const admin = new Pool({ connectionString: databaseUrl, max: 8 });
const apiUrl = new URL(databaseUrl);
apiUrl.username = credentials.api.name;
apiUrl.password = credentials.api.password;
const api = new Pool({ connectionString: apiUrl.toString(), max: 4 });
const signatures = [
  "public.proofstack_try_lock_policy_evaluation_metadata()",
  "public.proofstack_lock_policy_evaluation_metadata_write()",
  "public.proofstack_lock_policy_evaluation_recovery_write()",
];
const acquireSql = "SELECT public.proofstack_try_lock_policy_evaluation_metadata() AS acquired";
const recoveryLockSql =
  "SELECT pg_try_advisory_xact_lock(hashtextextended('proofstack:replay-recovery-epoch', 0)) AS acquired";

function scope(): EvidenceScope {
  return {
    tenantId: `ten_meta_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    projectId: "prj_meta",
    environmentId: "env_meta",
  };
}

function evidence(target: EvidenceScope, eventId = "evt_metadata"): EvidenceEnvelope {
  return {
    schemaVersion: "0.1",
    scope: target,
    receivedAt: "2026-10-03T00:00:01.000Z",
    evidence: {
      attributes: {},
      contentReferences: [],
      extensions: {},
      eventId,
      kind: "agent.run",
      name: "Metadata barrier fixture",
      status: "ok",
      source: { sdkName: "@proofstack/testkit", sdkVersion: "0.0.0", serviceName: "metadata-test" },
      spanId: "40f067aa0ba902b7",
      traceId: "5bf92f3577b34da6a3ce929d0e0e4736",
      startedAt: "2026-10-03T00:00:00.000Z",
    },
  };
}

async function begin(client: PoolClient, target: EvidenceScope, isolation = "READ COMMITTED") {
  // Fixed test cases only; this is not an external SQL input.
  await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  await client.query(
    `SELECT set_config('proofstack.tenant_id', $1, true),
      set_config('proofstack.project_id', $2, true),
      set_config('proofstack.environment_id', $3, true)`,
    [target.tenantId, target.projectId, target.environmentId],
  );
}

async function acquire(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ acquired: boolean }>(acquireSql);
  expect(typeof result.rows[0]?.acquired).toBe("boolean");
  return result.rows[0]?.acquired === true;
}

async function insertEvidence(client: PoolClient, entry: EvidenceEnvelope): Promise<void> {
  await client.query(
    `INSERT INTO public.proofstack_evidence_events (
      tenant_id, project_id, environment_id, event_id, trace_id, span_id,
      started_at, sequence, received_at, schema_version, evidence
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10::jsonb)`,
    [
      entry.scope.tenantId,
      entry.scope.projectId,
      entry.scope.environmentId,
      entry.evidence.eventId,
      entry.evidence.traceId,
      entry.evidence.spanId,
      entry.evidence.startedAt,
      entry.receivedAt,
      entry.schemaVersion,
      JSON.stringify(entry.evidence),
    ],
  );
}

async function count(client: PoolClient, target: EvidenceScope): Promise<number> {
  return (
    (
      await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM public.proofstack_evidence_events WHERE tenant_id=$1",
        [target.tenantId],
      )
    ).rows[0]?.count ?? -1
  );
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query("ROLLBACK");
  client.release();
}

async function probe(target: EvidenceScope): Promise<boolean> {
  const client = await admin.connect();
  try {
    await begin(client, target);
    return await acquire(client);
  } finally {
    // Failed acquisition always abandons the complete transaction, including partial guards.
    await rollback(client);
  }
}

/** Observe an actual advisory wait through PostgreSQL, never an elapsed-time guess. */
async function blocksWriter<T>(
  target: EvidenceScope,
  write: () => Promise<T>,
  inspect: (client: PoolClient) => Promise<void>,
  end: "COMMIT" | "ROLLBACK" = "COMMIT",
): Promise<T> {
  const guard = await admin.connect();
  let pending: Promise<{ value: T } | { error: unknown }> | undefined;
  let writerFailed = false;
  let writerError: unknown;
  try {
    await begin(guard, target);
    expect(await acquire(guard)).toBe(true);
    const pid = (await guard.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    pending = write().then(
      (value) => ({ value }),
      (error: unknown) => {
        writerFailed = true;
        writerError = error;
        return { error };
      },
    );
    await expect
      .poll(
        async () => {
          if (writerFailed) throw writerError;
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
    await rollback(guard);
    await pending;
  }
}

beforeAll(async () => {
  expect((await admin.query("SELECT current_database() AS name")).rows[0]?.name).toBe(
    "proofstack_test",
  );
  await migrateDatabase(admin);
  await provisionRuntimeRoles(admin, credentials);
});
afterAll(async () => {
  await api.end();
  for (const { name } of Object.values(credentials)) {
    await admin.query(`DROP OWNED BY "${name}"`);
    await admin.query(`DROP ROLE "${name}"`);
  }
  await admin.end();
});

describe("complete policy metadata publication barrier", () => {
  it("covers every source relation and inherited partition with enabled mandatory writer triggers", async () => {
    // A new tenant table requires a deliberate inventory decision. These six tables are
    // identity or derived delivery progress, not source records or canonical publication intent.
    const excluded = [
      "proofstack_api_key_credentials",
      "proofstack_browser_sessions",
      "proofstack_consumer_receipts",
      "proofstack_identity_audit_events",
      "proofstack_oidc_bindings",
      "proofstack_projection_cursors",
    ];
    const tables = await admin.query<{ name: string; partition: boolean }>(
      `SELECT c.relname AS name, c.relispartition AS partition
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped
       WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname LIKE 'proofstack_%'
         AND NOT (c.relname=ANY($1::text[])) ORDER BY c.relname`,
      [excluded],
    );
    expect(tables.rows).toHaveLength(85);
    expect(tables.rows.filter(({ partition }) => partition)).toHaveLength(33);
    const triggers = await admin.query<{
      name: string;
      enabled: string;
      type: number;
      inherited: boolean;
    }>(
      `SELECT c.relname AS name, t.tgenabled AS enabled, t.tgtype AS type,
         t.tgparentid <> 0 AS inherited
       FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
       WHERE t.tgname='proofstack_policy_evaluation_metadata_write_lock' ORDER BY c.relname`,
    );
    expect(triggers.rows).toEqual(
      tables.rows.map(({ name, partition }) => ({
        name,
        enabled: "O",
        type: 29,
        inherited: partition,
      })),
    );
    const recovery = await admin.query(
      `SELECT tgtype::int AS type, tgenabled AS enabled FROM pg_trigger
       WHERE tgname='proofstack_policy_evaluation_recovery_write_lock'`,
    );
    expect(recovery.rows).toEqual([{ type: 62, enabled: "O" }]);
    for (const { name } of Object.values(credentials)) {
      const truncate = await admin.query<{ allowed: boolean }>(
        "SELECT bool_or(has_table_privilege($1, table_name, 'TRUNCATE')) AS allowed FROM unnest($2::text[]) AS tables(table_name)",
        [name, tables.rows.map(({ name: table }) => table)],
      );
      expect(truncate.rows[0]?.allowed).toBe(false);
    }
  });

  it("uses fixed-search-path invoker functions with no existing runtime execution grant", async () => {
    const functions = await admin.query(
      `SELECT prosecdef, proconfig FROM pg_proc WHERE oid=ANY($1::regprocedure[])`,
      [signatures],
    );
    expect(functions.rows).toEqual(
      signatures.map(() => ({
        prosecdef: false,
        proconfig: ["search_path=pg_catalog"],
      })),
    );
    const permissions = await admin.query<{ allowed: boolean }>(
      `SELECT has_function_privilege(role_name, signature, 'EXECUTE') AS allowed
       FROM unnest($1::text[]) roles(role_name) CROSS JOIN unnest($2::text[]) functions(signature)`,
      [Object.values(credentials).map(({ name }) => name), signatures],
    );
    expect(permissions.rows).toEqual(Array.from({ length: 30 }, () => ({ allowed: false })));
    await expect(withExactScopeTransaction(api, scope(), acquire)).rejects.toMatchObject({
      code: "42501",
    });
  });

  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "requires exact %s context",
    async (field) => {
      await expect(
        withExactScopeTransaction(admin, { ...scope(), [field]: "" }, acquire),
      ).rejects.toMatchObject({ code: "42501" });
    },
  );

  it.each(["REPEATABLE READ", "SERIALIZABLE"])("rejects a stale %s snapshot", async (isolation) => {
    const client = await admin.connect();
    try {
      await begin(client, scope(), isolation);
      await expect(acquire(client)).rejects.toMatchObject({ code: "0A000" });
    } finally {
      await rollback(client);
    }
  });

  it.each(["COMMIT", "ROLLBACK"] as const)(
    "holds absent trace/event creation until %s",
    async (end) => {
      const target = scope();
      const entry = evidence(target);
      const repository = new PostgresEvidenceRepository(api);
      await blocksWriter(
        target,
        () => repository.append([entry]),
        async (client) => {
          expect(await count(client, target)).toBe(0);
          expect(
            (await repository.listByTrace(target, entry.evidence.traceId, { limit: 10 })).events,
          ).toEqual([]);
        },
        end,
      );
      expect(
        (await repository.listByTrace(target, entry.evidence.traceId, { limit: 10 })).events,
      ).toEqual([entry]);
    },
  );

  it("allows concurrent same-tenant writers but rejects publication until both finish", async () => {
    const target = scope();
    const first = await api.connect();
    const second = await api.connect();
    try {
      await begin(first, target);
      await begin(second, target);
      await second.query("SET LOCAL statement_timeout = '1000ms'");
      await insertEvidence(first, evidence(target, "evt_first"));
      await insertEvidence(second, evidence(target, "evt_second"));
      expect(await probe(target)).toBe(false);
      await first.query("COMMIT");
      expect(await probe(target)).toBe(false);
      await second.query("COMMIT");
      await withExactScopeTransaction(admin, target, async (client) => {
        expect(await acquire(client)).toBe(true);
        expect(await count(client, target)).toBe(2);
      });
    } finally {
      await rollback(first);
      await rollback(second);
    }
  });

  it("isolates three tenants but serializes different projects/environments in one tenant", async () => {
    const target = scope();
    const guard = await admin.connect();
    try {
      await begin(guard, target);
      expect(await acquire(guard)).toBe(true);
      expect(await probe({ ...target, projectId: "prj_other", environmentId: "env_other" })).toBe(
        false,
      );
      for (const tenant of [scope(), scope()]) {
        await withExactScopeTransaction(admin, tenant, async (client) => {
          expect(await acquire(client)).toBe(true);
          await client.query("SET LOCAL statement_timeout = '1000ms'");
          await insertEvidence(client, evidence(tenant));
        });
      }
    } finally {
      await rollback(guard);
    }
  });

  it("retries from a new READ COMMITTED transaction after an intervening writer commits", async () => {
    const target = scope();
    const writer = await api.connect();
    const reader = await admin.connect();
    try {
      await begin(reader, target);
      expect(await count(reader, target)).toBe(0);
      await begin(writer, target);
      await insertEvidence(writer, evidence(target));
      await reader.query("SET LOCAL statement_timeout = '1000ms'");
      expect(await acquire(reader)).toBe(false);
      await reader.query("ROLLBACK");
      await writer.query("COMMIT");
      await begin(reader, target);
      expect(await acquire(reader)).toBe(true);
      expect(await count(reader, target)).toBe(1);
    } finally {
      await rollback(reader);
      await rollback(writer);
    }
  });

  it("protects new criterion status and reverse lineage without knowing the successor ID", async () => {
    const fixture = createEvaluationRepositoryTestHarness(`meta_${runKey}`);
    const repository = new PostgresEvaluationRepository(api);
    const statuses = fixture.records.filter(({ kind }) => kind === "criterion_set_status");
    const next = statuses[1];
    if (next?.kind !== "criterion_set_status") throw new Error("Missing retained status fixture");
    for (const record of fixture.records) {
      if (record === next) break;
      await publishEvaluationFixture(repository, record);
    }
    await blocksWriter(
      fixture.scope,
      () => repository.publishCriterionSetStatus(next.record),
      async (client) => {
        const history = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM public.proofstack_evaluation_records
         WHERE tenant_id=$1 AND record_kind='criterion_set_status'`,
          [fixture.scope.tenantId],
        );
        expect(history.rows[0]?.count).toBe(1);
        expect(
          await repository.findCriterionSetStatus(fixture.scope, next.record.statusRecordId),
        ).toBeNull();
        const lineage = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM public.proofstack_evaluation_lineage
         WHERE tenant_id=$1 AND child_record_kind='criterion_set_status' AND child_record_id=$2`,
          [fixture.scope.tenantId, next.record.statusRecordId],
        );
        expect(lineage.rows[0]?.count).toBe(0);
      },
    );
    expect(
      await repository.findCriterionSetStatus(fixture.scope, next.record.statusRecordId),
    ).toEqual(next.record);
  });

  it("blocks direct child partition insertion before its deferred registry row exists", async () => {
    const fixture = createEvaluationRepositoryTestHarness(`part_${runKey}`);
    const item = fixture.records[0];
    if (item?.kind !== "discovery_record") throw new Error("Missing discovery fixture");
    const record: DiscoveryRecord = item.record;
    await blocksWriter(
      fixture.scope,
      async () => {
        const writer = await admin.connect();
        try {
          await begin(writer, fixture.scope);
          await writer.query(
            `INSERT INTO public.proofstack_evaluation_discovery_records (
            tenant_id, project_id, environment_id, record_kind, record_id, schema_version,
            definition_sha256, recorded_at, recorded_at_lexical, actor_principal_id, lineage_count, record
          ) VALUES ($1,$2,$3,'discovery_record',$4,'0.1',$5,$6::text::timestamptz,$6::text,$7,0,$8::jsonb)`,
            [
              fixture.scope.tenantId,
              fixture.scope.projectId,
              fixture.scope.environmentId,
              record.discoveryId,
              record.definitionSha256,
              record.recordedAt,
              record.recordedByPrincipalId,
              JSON.stringify(record),
            ],
          );
          await writer.query(
            `INSERT INTO public.proofstack_evaluation_record_registry (
            tenant_id, project_id, environment_id, record_kind, record_id, schema_version, definition_sha256
          ) VALUES ($1,$2,$3,'discovery_record',$4,'0.1',$5)`,
            [
              fixture.scope.tenantId,
              fixture.scope.projectId,
              fixture.scope.environmentId,
              record.discoveryId,
              record.definitionSha256,
            ],
          );
          await writer.query("COMMIT");
        } finally {
          await rollback(writer);
        }
      },
      async (client) => {
        const rows = await client.query(
          "SELECT record FROM public.proofstack_evaluation_records WHERE tenant_id=$1",
          [fixture.scope.tenantId],
        );
        expect(rows.rows).toEqual([]);
      },
    );
    const retained = await admin.query(
      "SELECT record FROM public.proofstack_evaluation_records WHERE tenant_id=$1",
      [fixture.scope.tenantId],
    );
    expect(retained.rows).toEqual([{ record }]);
  });

  it("protects absent canonical outbox intent independently of source insertion", async () => {
    const target = scope();
    await blocksWriter(
      target,
      () =>
        withExactScopeTransaction(api, target, (client) =>
          client.query(
            `INSERT INTO public.proofstack_outbox (
        tenant_id,event_type,aggregate_type,aggregate_id,schema_version,payload,created_at
      ) VALUES ($1,'evidence.appended','evidence','evt_metadata','0.1','{}'::jsonb,clock_timestamp())`,
            [target.tenantId],
          ),
        ),
      async (client) => {
        expect(
          (
            await client.query(
              "SELECT outbox_id FROM public.proofstack_outbox WHERE tenant_id=$1",
              [target.tenantId],
            )
          ).rows,
        ).toEqual([]);
      },
    );
  });

  it("guards existing outbox delivery updates while preserving the old committed observation", async () => {
    const target = scope();
    await new PostgresEvidenceRepository(api).append([evidence(target)]);
    const before = (
      await admin.query(
        "SELECT available_at::text AS instant FROM public.proofstack_outbox WHERE tenant_id=$1",
        [target.tenantId],
      )
    ).rows;
    expect(before).toHaveLength(1);
    await blocksWriter(
      target,
      () =>
        withExactScopeTransaction(admin, target, (client) =>
          client.query(
            "UPDATE public.proofstack_outbox SET available_at=available_at + interval '1 millisecond' WHERE tenant_id=$1",
            [target.tenantId],
          ),
        ),
      async (client) => {
        expect(
          (
            await client.query(
              "SELECT available_at::text AS instant FROM public.proofstack_outbox WHERE tenant_id=$1",
              [target.tenantId],
            )
          ).rows,
        ).toEqual(before);
      },
    );
    expect(
      (
        await admin.query(
          "SELECT available_at > $2::timestamptz AS advanced FROM public.proofstack_outbox WHERE tenant_id=$1",
          [target.tenantId, before[0]?.instant],
        )
      ).rows,
    ).toEqual([{ advanced: true }]);
  });

  it.each(["old", "new", "delete"] as const)(
    "retains the %s tenant guard for permitted row mutations",
    async (kind) => {
      // Real source identities are immutable. A connection-local fixture exercises the trigger's
      // OLD/NEW handling without disabling any product constraint or granting runtime DML.
      const original = scope();
      const replacement = scope();
      const writer = await admin.connect();
      try {
        await writer.query("CREATE TEMP TABLE metadata_identity_fixture (tenant_id text NOT NULL)");
        await writer.query(`CREATE TRIGGER metadata_identity_write AFTER INSERT OR UPDATE OR DELETE
        ON metadata_identity_fixture FOR EACH ROW
        EXECUTE FUNCTION public.proofstack_lock_policy_evaluation_metadata_write()`);
        await writer.query("INSERT INTO metadata_identity_fixture VALUES ($1)", [
          original.tenantId,
        ]);
        await blocksWriter(
          kind === "new" ? replacement : original,
          async () => {
            await writer.query("BEGIN");
            try {
              if (kind === "delete") await writer.query("DELETE FROM metadata_identity_fixture");
              else
                await writer.query("UPDATE metadata_identity_fixture SET tenant_id=$1", [
                  replacement.tenantId,
                ]);
            } finally {
              await writer.query("ROLLBACK");
            }
          },
          async (client) => {
            expect(await acquire(client)).toBe(true);
          },
        );
        expect(
          (await writer.query("SELECT tenant_id FROM metadata_identity_fixture")).rows,
        ).toEqual([{ tenant_id: original.tenantId }]);
      } finally {
        await writer.query("ROLLBACK");
        await writer.query("DROP TABLE IF EXISTS metadata_identity_fixture");
        writer.release();
      }
    },
  );

  it.each(["migration", "recovery", "tenant"] as const)(
    "rolls back partial locks when %s has a writer",
    async (kind) => {
      const target = scope();
      const writer = await admin.connect();
      const reader = await admin.connect();
      try {
        await begin(writer, target);
        if (kind === "migration") await writer.query("SELECT pg_advisory_xact_lock(1347579483,1)");
        else if (kind === "recovery")
          await writer.query(
            "UPDATE public.proofstack_recovery_state SET recovery_epoch=recovery_epoch",
          );
        else await insertEvidence(writer, evidence(target));
        await begin(reader, target);
        await reader.query("SET LOCAL statement_timeout = '1000ms'");
        expect(await acquire(reader)).toBe(false);
        await reader.query("ROLLBACK");
        const locks = await reader.query(
          "SELECT mode FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'",
        );
        expect(locks.rows).toEqual([]);
        await writer.query("ROLLBACK");
        await begin(reader, target);
        expect(
          (await reader.query("SELECT pg_try_advisory_xact_lock(1347579483,1) AS acquired")).rows[0]
            ?.acquired,
        ).toBe(true);
        expect((await reader.query(recoveryLockSql)).rows[0]?.acquired).toBe(true);
        expect(await acquire(reader)).toBe(true);
      } finally {
        await rollback(reader);
        await rollback(writer);
      }
    },
  );

  it("holds the migration runner's real session lock until the metadata transaction ends", async () => {
    await blocksWriter(
      scope(),
      () => migrateDatabase(admin),
      async (client) => {
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS count FROM public.proofstack_schema_migrations",
            )
          ).rows[0]?.count,
        ).toBe(52);
      },
    );
  });

  it.each(["direct", "procedure"] as const)(
    "holds the global recovery epoch against %s writes",
    async (kind) => {
      const before = (
        await admin.query("SELECT recovery_epoch FROM public.proofstack_recovery_state")
      ).rows;
      await blocksWriter(
        scope(),
        async () => {
          const writer = await admin.connect();
          try {
            await writer.query("BEGIN");
            if (kind === "direct")
              await writer.query(
                "UPDATE public.proofstack_recovery_state SET recovery_epoch=recovery_epoch+1",
              );
            else await writer.query("SELECT * FROM public.proofstack_begin_replay_recovery()");
            // This fixture proves blocking and deliberately rolls the isolated recovery back.
          } finally {
            await rollback(writer);
          }
        },
        async (client) => {
          expect(
            (await client.query("SELECT recovery_epoch FROM public.proofstack_recovery_state"))
              .rows,
          ).toEqual(before);
        },
      );
      expect(
        (await admin.query("SELECT recovery_epoch FROM public.proofstack_recovery_state")).rows,
      ).toEqual(before);
    },
  );
});
