import {
  digestEvaluationRecordDefinition,
  EvaluationRecordConflictError,
  EvaluationRepositoryContractError,
} from "@proofstack/core";
import {
  createEvaluationRepositoryTestHarness,
  criterionStatusHistoryConformanceCases,
  criterionStatusHistoryFixture,
  evaluationRepositoryConformanceCases,
  publishEvaluationFixture,
} from "@proofstack/core/testing";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import {
  listPostgresCriterionSetStatusesOnClient,
  PostgresEvaluationRepository,
  readPostgresEvaluationRecordOnClient,
} from "./postgres-evaluation-repository.js";
import { withExactReadCommittedScopeTransaction } from "./tenant-transaction.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const runtimeRole = "proofstack_test_evaluation";
const runtimePassword = "proofstack_test_evaluation";
const controlRole = "proofstack_test_evaluation_control";
const executionRole = "proofstack_test_evaluation_worker";
const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
const runtimeDatabaseUrl = new URL(databaseUrl);
runtimeDatabaseUrl.username = runtimeRole;
runtimeDatabaseUrl.password = runtimePassword;
const runtimePool = new Pool({ connectionString: runtimeDatabaseUrl.toString(), max: 8 });

function rolePool(role: string): Pool {
  const url = new URL(databaseUrl as string);
  url.username = role;
  url.password = runtimePassword;
  return new Pool({ connectionString: url.toString(), max: 2 });
}

const controlPool = rolePool(controlRole);
const executionPool = rolePool(executionRole);

beforeAll(async () => {
  await migrateDatabase(adminPool);
  for (const role of [runtimeRole, controlRole, executionRole]) {
    await adminPool.query(`
      DO $$
      BEGIN
        CREATE ROLE ${role} LOGIN PASSWORD '${runtimePassword}';
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END
      $$
    `);
    await adminPool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await adminPool.query(`
      GRANT SELECT ON TABLE
        public.proofstack_evaluation_record_registry,
        public.proofstack_evaluation_resource_bindings,
        public.proofstack_evaluation_lineage,
        public.proofstack_evaluation_unique_bindings,
        public.proofstack_evaluation_records
      TO ${role}
    `);
    await adminPool.query(
      `GRANT EXECUTE ON FUNCTION public.proofstack_evaluation_intent_status(
        text, text, text, text, jsonb, timestamptz
      ) TO ${role}`,
    );
  }
  await adminPool.query(`
    GRANT SELECT ON TABLE
      public.proofstack_evaluation_record_registry,
      public.proofstack_evaluation_resource_bindings,
      public.proofstack_evaluation_lineage,
      public.proofstack_evaluation_unique_bindings,
      public.proofstack_evaluation_records
    TO ${runtimeRole}
  `);
  await adminPool.query(
    `GRANT EXECUTE ON FUNCTION public.proofstack_publish_evaluation_control_record(jsonb),
      public.proofstack_publish_evaluation_execution_record(jsonb) TO ${runtimeRole}`,
  );
  await adminPool.query(
    `GRANT EXECUTE ON FUNCTION public.proofstack_publish_evaluation_control_record(jsonb)
      TO ${controlRole}`,
  );
  await adminPool.query(
    `GRANT EXECUTE ON FUNCTION public.proofstack_publish_evaluation_execution_record(jsonb)
      TO ${executionRole}`,
  );
});

afterAll(async () => {
  await Promise.all([runtimePool.end(), controlPool.end(), executionPool.end(), adminPool.end()]);
});

function harness(namespace: string) {
  const fixture = createEvaluationRepositoryTestHarness(`pg_${namespace}`);
  return { ...fixture, repository: new PostgresEvaluationRepository(runtimePool) };
}

describe("PostgresEvaluationRepository contract", () => {
  it.each([
    ["lineage count", "lineage_count = lineage_count + 1"],
    ["unexpected attempt projection", "attempt_id = 'att_corrupt_history', attempt_sequence = 1"],
  ])(
    "rejects stored %s corruption without returning a valid history prefix",
    async (_label, mutation) => {
      const fixture = harness(
        `history_corrupt_${_label === "lineage count" ? "count" : "attempt"}`,
      );
      for (const record of fixture.records)
        await publishEvaluationFixture(fixture.repository, record);
      const status = fixture.records.find((record) => record.kind === "criterion_set_status");
      if (status?.kind !== "criterion_set_status") throw new Error("Missing status fixture");
      const limits = { maxRecords: 10, maxRecordBytes: 100_000 };
      const before = await fixture.repository.listCriterionSetStatuses(fixture.scope, limits);
      const client = await adminPool.connect();
      try {
        await client.query("BEGIN");
        // Isolated admin corruption fixture. CHECK constraints remain enabled; rollback restores
        // the row and session setting. This is not a runtime-role bypass or a changed migration.
        await client.query("SET LOCAL session_replication_role = 'replica'");
        await client.query(
          `UPDATE public.proofstack_evaluation_records SET ${mutation}
        WHERE tenant_id = $1 AND record_kind = 'criterion_set_status' AND record_id = $2`,
          [fixture.scope.tenantId, status.record.statusRecordId],
        );
        await expect(
          listPostgresCriterionSetStatusesOnClient(client, fixture.scope, limits),
        ).rejects.toBeInstanceOf(EvaluationRepositoryContractError);
        await expect(
          readPostgresEvaluationRecordOnClient(
            client,
            fixture.scope,
            "criterion_set_status",
            status.record.statusRecordId,
          ),
        ).rejects.toBeInstanceOf(EvaluationRepositoryContractError);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      expect(await fixture.repository.listCriterionSetStatuses(fixture.scope, limits)).toEqual(
        before,
      );
    },
  );

  it("prevents a new status phantom from committing across a held complete metadata cut", async () => {
    const fixture = harness("history_guarded_cut");
    for (const record of fixture.records)
      await publishEvaluationFixture(fixture.repository, record);
    const previous = fixture.records.find(
      (record) => record.kind === "criterion_set_status" && record.record.status === "approved",
    );
    if (previous?.kind !== "criterion_set_status") throw new Error("Missing approved status");
    const next = criterionStatusHistoryFixture(previous.record, {
      statusRecordId: "csr_guarded_withdrawal",
      status: "withdrawn",
      expiresAt: undefined,
      previousStatus: {
        statusRecordId: previous.record.statusRecordId,
        definitionSha256: previous.record.definitionSha256,
      },
    });
    const limits = { maxRecords: 10, maxRecordBytes: 100_000 };
    const before = await fixture.repository.listCriterionSetStatuses(fixture.scope, limits);
    let pending: Promise<unknown> | undefined;
    let failed = false;
    let failure: unknown;
    try {
      await withExactReadCommittedScopeTransaction(adminPool, fixture.scope, async (client) => {
        expect(
          (
            await client.query(
              "SELECT public.proofstack_try_lock_policy_evaluation_metadata() AS acquired",
            )
          ).rows,
        ).toEqual([{ acquired: true }]);
        const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        pending = fixture.repository.publishCriterionSetStatus(next).catch((error: unknown) => {
          failed = true;
          failure = error;
        });
        await expect
          .poll(
            async () => {
              if (failed) throw failure;
              return (
                await adminPool.query<{ count: number }>(
                  "SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND wait_event = 'advisory'",
                  [pid],
                )
              ).rows[0]?.count;
            },
            { timeout: 5_000, interval: 20 },
          )
          .toBeGreaterThan(0);
        const suppliedScope = { ...fixture.scope };
        const suppliedLimits = { ...limits };
        const view = {
          query: async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            suppliedScope.tenantId = "ten_changed_during_read";
            suppliedLimits.maxRecords = 0;
            suppliedLimits.maxRecordBytes = 2;
            return result;
          },
        } as Pick<PoolClient, "query">;
        expect(
          await listPostgresCriterionSetStatusesOnClient(view, suppliedScope, suppliedLimits),
        ).toEqual(before);
      });
      await pending;
      if (failed) throw failure;
      const after = await fixture.repository.listCriterionSetStatuses(fixture.scope, limits);
      expect(after).toHaveLength(before.length + 1);
      expect(after.some(({ statusRecordId }) => statusRecordId === next.statusRecordId)).toBe(true);
    } finally {
      // The owning transaction helper has already committed or rolled back before draining.
      await pending;
    }
  });

  for (const testCase of criterionStatusHistoryConformanceCases) {
    it(testCase.name, () => testCase.run(harness));
  }
  for (const testCase of evaluationRepositoryConformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(harness);
    });
  }

  it("serializes concurrent identical publication into one record and one outbox intent", async () => {
    const fixture = harness("concurrent_retry");
    const first = fixture.records[0];
    expect(first?.kind).toBe("discovery_record");
    if (first?.kind !== "discovery_record") throw new Error("Missing discovery fixture");

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        fixture.repository.publishDiscoveryRecord(structuredClone(first.record)),
      ),
    );
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(results.filter(({ created }) => !created)).toHaveLength(7);

    const persisted = await adminPool.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count
       FROM public.proofstack_evaluation_records
       WHERE tenant_id = $1 AND record_kind = 'discovery_record' AND record_id = $2`,
      [first.record.scope.tenantId, first.record.discoveryId],
    );
    const intents = await adminPool.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count
       FROM public.proofstack_outbox
       WHERE tenant_id = $1 AND aggregate_type = 'evaluation_discovery_record'
         AND aggregate_id = $2`,
      [first.record.scope.tenantId, first.record.discoveryId],
    );
    expect(persisted.rows[0]?.count).toBe("1");
    expect(intents.rows[0]?.count).toBe("1");
  });

  it("retains the complete graph across runtime pool restarts", async () => {
    const fixture = harness("restart");
    const first = fixture.records[0];
    if (first?.kind !== "discovery_record") throw new Error("Missing discovery fixture");
    await fixture.repository.publishDiscoveryRecord(first.record);

    const restartedPool = new Pool({ connectionString: runtimeDatabaseUrl.toString(), max: 1 });
    try {
      await expect(
        new PostgresEvaluationRepository(restartedPool).findDiscoveryRecord(
          fixture.scope,
          first.record.discoveryId,
        ),
      ).resolves.toEqual(first.record);
    } finally {
      await restartedPool.end();
    }
  });

  it("separates control-plane publication from worker result authority", async () => {
    const fixture = harness("authority_split");
    for (const record of fixture.records) {
      await publishEvaluationFixture(fixture.repository, record);
    }
    const controlRepository = new PostgresEvaluationRepository(controlPool);
    const executionRepository = new PostgresEvaluationRepository(executionPool);
    const observationConflict = fixture.uniquenessConflicts.find(
      ({ kind }) => kind === "raw_observation",
    );
    const aggregateFixture = fixture.records.find(({ kind }) => kind === "evaluation_aggregate");
    if (observationConflict?.kind !== "raw_observation") {
      throw new Error("Missing raw-observation authority fixture");
    }
    if (fixture.resourceConflict.kind !== "aggregation_policy") {
      throw new Error("Missing aggregation-policy authority fixture");
    }
    if (aggregateFixture?.kind !== "evaluation_aggregate") {
      throw new Error("Missing evaluation-aggregate authority fixture");
    }
    const controlCandidate = structuredClone(fixture.resourceConflict.record);
    controlCandidate.policyId = "agp_authority_split_new";
    controlCandidate.policyVersionId = "agv_authority_split_new";
    controlCandidate.scope = fixture.scope;
    const controlDefinition = structuredClone(controlCandidate) as Record<string, unknown>;
    for (const key of [
      "definitionSha256",
      "publishedAt",
      "publishedByPrincipalId",
      "schemaVersion",
      "scope",
    ]) {
      delete controlDefinition[key];
    }
    controlCandidate.definitionSha256 = digestEvaluationRecordDefinition(
      "aggregation_policy",
      fixture.scope,
      controlDefinition,
    );
    const deniedControlDefinition = {
      ...controlDefinition,
      policyId: "agp_authority_split_denied",
      policyVersionId: "agv_authority_split_denied",
    };
    const aggregateCandidate = structuredClone(aggregateFixture.record);
    aggregateCandidate.aggregateId = "eva_authority_split_worker";
    const aggregateDefinition = structuredClone(aggregateCandidate) as Record<string, unknown>;
    for (const key of [
      "createdAt",
      "createdByPrincipalId",
      "definitionSha256",
      "schemaVersion",
      "scope",
    ]) {
      delete aggregateDefinition[key];
    }
    aggregateCandidate.definitionSha256 = digestEvaluationRecordDefinition(
      "evaluation_aggregate",
      fixture.scope,
      aggregateDefinition,
    );

    await expect(
      controlRepository.publishAggregationPolicy(controlCandidate),
    ).resolves.toMatchObject({ created: true });
    await expect(
      executionRepository.publishAggregationPolicy({
        ...controlCandidate,
        ...deniedControlDefinition,
        definitionSha256: digestEvaluationRecordDefinition(
          "aggregation_policy",
          fixture.scope,
          deniedControlDefinition,
        ),
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      executionRepository.publishRawObservation(observationConflict.record),
    ).rejects.toBeInstanceOf(EvaluationRecordConflictError);
    await expect(
      controlRepository.publishRawObservation(observationConflict.record),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      controlRepository.publishEvaluationAggregate(aggregateCandidate),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      executionRepository.publishEvaluationAggregate(aggregateCandidate),
    ).resolves.toMatchObject({ created: true });
  });
});
