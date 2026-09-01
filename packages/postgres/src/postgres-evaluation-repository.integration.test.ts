import { digestEvaluationRecordDefinition, EvaluationRecordConflictError } from "@proofstack/core";
import {
  createEvaluationRepositoryTestHarness,
  evaluationRepositoryConformanceCases,
  publishEvaluationFixture,
} from "@proofstack/core/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresEvaluationRepository } from "./postgres-evaluation-repository.js";

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
    if (observationConflict?.kind !== "raw_observation") {
      throw new Error("Missing raw-observation authority fixture");
    }
    if (fixture.resourceConflict.kind !== "aggregation_policy") {
      throw new Error("Missing aggregation-policy authority fixture");
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
  });
});
