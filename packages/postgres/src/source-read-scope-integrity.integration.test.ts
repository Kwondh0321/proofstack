import { createHash, randomUUID } from "node:crypto";
import type { EvidenceScope } from "@proofstack/contracts";
import {
  comparisonRecordId,
  type EvaluationRecordKind,
  evaluationRecordId,
} from "@proofstack/core";
import {
  createComparisonRepositoryTestHarness,
  createEvaluationRepositoryTestHarness,
  createReleaseCandidateRepositoryTestHarness,
  publishComparisonFixture,
  publishEvaluationFixture,
} from "@proofstack/core/testing";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import {
  PostgresComparisonRepository,
  readPostgresComparisonRecordOnClient,
} from "./postgres-comparison-repository.js";
import {
  PostgresEvaluationRepository,
  readPostgresEvaluationRecordOnClient,
} from "./postgres-evaluation-repository.js";
import {
  PostgresReleaseCandidateRepository,
  readPostgresReleaseCandidateOnClient,
} from "./postgres-release-candidate-repository.js";
import { provisionRuntimeRoles, type RuntimeRoleProvisioningOptions } from "./runtime-roles.js";
import { withExactScopeTransaction } from "./tenant-transaction.js";

const databaseUrl = process.env["PROOFSTACK_TEST_DATABASE_URL"];
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
const key = randomUUID().replaceAll("-", "").slice(0, 12);
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
      name: `ps_scope_${kind.toLowerCase()}_${key}`,
      password: `proofstack-scope-fixture-${key}`,
    },
  ]),
) as unknown as RuntimeRoleProvisioningOptions;
const admin = new Pool({ connectionString: databaseUrl, max: 2 });
function runtime(kind: "api" | "evaluationWorker") {
  const url = new URL(databaseUrl as string);
  url.username = credentials[kind].name;
  url.password = credentials[kind].password;
  return new Pool({ connectionString: url.toString(), max: 2 });
}
const api = runtime("api");
const worker = runtime("evaluationWorker");
const evaluation = createEvaluationRepositoryTestHarness(`sc_${key}`);
const comparison = createComparisonRepositoryTestHarness(`sc_${key}`);
const candidate = createReleaseCandidateRepositoryTestHarness(`sc_${key}`);
const evaluationRepository = new PostgresEvaluationRepository(api);
const comparisonRepository = new PostgresComparisonRepository(api);
const candidateRepository = new PostgresReleaseCandidateRepository(api);

const evaluationMethods = {
  aggregation_policy: "findAggregationPolicy",
  assessment: "findAssessment",
  criterion_set: "findCriterionSet",
  criterion_set_status: "findCriterionSetStatus",
  discovery_record: "findDiscoveryRecord",
  evaluation_aggregate: "findEvaluationAggregate",
  evaluation_run: "findEvaluationRun",
  evaluation_run_rejection: "findEvaluationRunRejection",
  evaluation_run_result: "findEvaluationRunResult",
  evaluator_spec: "findEvaluatorSpec",
  oracle_spec: "findOracleSpec",
  qualification_fixture_set: "findQualificationFixtureSet",
  qualification_report: "findQualificationReport",
  raw_observation: "findRawObservation",
  source_review: "findSourceReview",
  source_reviewer_qualification: "findSourceReviewerQualification",
  source_snapshot: "findSourceSnapshot",
} as const satisfies Record<EvaluationRecordKind, string>;

beforeAll(async () => {
  expect((await admin.query("SELECT current_database() AS name")).rows[0]?.name).toBe(
    "proofstack_test",
  );
  await migrateDatabase(admin);
  await provisionRuntimeRoles(admin, credentials);
  const execution = new Set([
    "evaluation_aggregate",
    "evaluation_run_result",
    "qualification_report",
    "raw_observation",
  ]);
  for (const f of evaluation.records)
    await publishEvaluationFixture(
      execution.has(f.kind) ? new PostgresEvaluationRepository(worker) : evaluationRepository,
      f,
    );
  for (const f of comparison.records) await publishComparisonFixture(comparisonRepository, f);
  await candidateRepository.publishReleaseCandidate(candidate.candidate);
});
afterAll(async () => {
  await Promise.all([api.end(), worker.end()]);
  for (const role of Object.values(credentials)) {
    await admin.query(`DROP OWNED BY "${role.name}"`);
    await admin.query(`DROP ROLE "${role.name}"`);
  }
  await admin.end();
});

interface Fixture {
  readonly presenceQuery?: "retained_candidate" | "retained_evaluation";
  readonly record: { readonly scope: EvidenceScope; readonly definitionSha256: string };
  readonly read: (
    client: Pick<PoolClient, "query">,
    scope: EvidenceScope,
    id?: string,
  ) => Promise<unknown>;
  readonly find: (scope: EvidenceScope) => Promise<unknown>;
  readonly damage: (client: PoolClient) => Promise<void>;
}
function evaluationFixture(kind: EvaluationRecordKind): Fixture {
  const f = evaluation.records.find((f) => f.kind === kind);
  if (!f) throw new Error("Missing evaluation scope fixture");
  const id = evaluationRecordId(kind, f.record);
  return {
    presenceQuery: "retained_evaluation",
    record: f.record,
    read: (client, scope, requestedId = id) =>
      readPostgresEvaluationRecordOnClient(client, scope, kind, requestedId),
    find: (scope) => evaluationRepository[evaluationMethods[kind]](scope, id),
    damage: async (client) => {
      const result = await client.query(
        `UPDATE public.proofstack_evaluation_records
         SET definition_sha256 = $4::text, record = jsonb_set(record, '{definitionSha256}', to_jsonb($4::text))
         WHERE tenant_id = $1 AND record_kind = $2 AND record_id = $3`,
        [f.record.scope.tenantId, kind, id, corruptDigest(f.record.definitionSha256)],
      );
      expect(result.rowCount).toBe(1);
    },
  };
}
const comparisonKinds = [
  "comparison_definition",
  "comparison_evidence_snapshot",
  "comparison_result",
] as const;
function comparisonFixture(kind: (typeof comparisonKinds)[number]): Fixture {
  const f = comparison.records.find((f) => f.kind === kind);
  if (!f) throw new Error("Missing comparison scope fixture");
  const id = comparisonRecordId(kind, f.record);
  return {
    record: f.record,
    read: (client, scope, requestedId = id) =>
      readPostgresComparisonRecordOnClient(client, scope, kind, requestedId),
    find: (scope) => {
      switch (kind) {
        case "comparison_definition":
          return comparisonRepository.findComparisonDefinition(scope, id);
        case "comparison_evidence_snapshot":
          return comparisonRepository.findComparisonEvidenceSnapshot(scope, id);
        case "comparison_result":
          return comparisonRepository.findComparisonResult(scope, id);
      }
    },
    damage: async (client) => {
      const result = await client.query(
        `UPDATE public.proofstack_comparison_records
         SET definition_sha256 = $4::text, record = jsonb_set(record, '{definitionSha256}', to_jsonb($4::text))
         WHERE tenant_id = $1 AND record_kind = $2 AND record_id = $3`,
        [f.record.scope.tenantId, kind, id, corruptDigest(f.record.definitionSha256)],
      );
      expect(result.rowCount).toBe(1);
    },
  };
}
function candidateFixture(): Fixture {
  const record = candidate.candidate;
  return {
    presenceQuery: "retained_candidate",
    record,
    read: (client, scope, id = record.candidateVersionId) =>
      readPostgresReleaseCandidateOnClient(client, scope, id),
    find: (scope) => candidateRepository.findReleaseCandidate(scope, record.candidateVersionId),
    damage: async (client) => {
      const result = await client.query(
        `UPDATE public.proofstack_release_candidates
         SET definition_sha256 = $3::text, record = jsonb_set(record, '{definitionSha256}', to_jsonb($3::text))
         WHERE tenant_id = $1 AND candidate_version_id = $2`,
        [record.scope.tenantId, record.candidateVersionId, corruptDigest(record.definitionSha256)],
      );
      expect(result.rowCount).toBe(1);
    },
  };
}
function corruptDigest(original: string) {
  return `${original[0] === "f" ? "e" : "f"}${original.slice(1)}`;
}
function outsideScopes(scope: EvidenceScope) {
  return ["tenantId", "projectId", "environmentId"].map((dimension) => ({
    ...scope,
    [dimension]: "other_scope",
  }));
}
async function fingerprint(scope: EvidenceScope) {
  const state = [];
  for (const table of [
    "proofstack_evaluation_records",
    "proofstack_evaluation_record_registry",
    "proofstack_evaluation_lineage",
    "proofstack_comparison_records",
    "proofstack_comparison_record_registry",
    "proofstack_comparison_lineage",
    "proofstack_release_candidates",
    "proofstack_release_candidate_registry",
    "proofstack_release_candidate_lineage",
    "proofstack_outbox",
  ])
    state.push(
      (
        await admin.query(
          `SELECT to_jsonb(item) AS record FROM public.${table} AS item WHERE tenant_id = $1 ORDER BY to_jsonb(item)::text`,
          [scope.tenantId],
        )
      ).rows,
    );
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

async function verifyScope(f: Fixture) {
  const before = await fingerprint(f.record.scope);
  await expect(f.find(f.record.scope)).resolves.toEqual(f.record);
  for (const scope of outsideScopes(f.record.scope))
    await expect(f.find(scope)).resolves.toBeNull();
  try {
    for (const [index, scope] of [...outsideScopes(f.record.scope), f.record.scope].entries()) {
      await withExactScopeTransaction(admin, scope, async (client) => {
        await client.query("SAVEPOINT retained_original");
        try {
          // Privileged disposable damage only. CHECK constraints remain enabled.
          await client.query("SET LOCAL session_replication_role = 'replica'");
          await f.damage(client);
          await client.query(`SET LOCAL ROLE "${credentials.api.name}"`);
          const calls: { sql: string; rows: number }[] = [];
          const view = {
            query: async (sql: string, values?: unknown[]) => {
              expect(sql.trim()).toMatch(/^SELECT\b/);
              const result = await client.query(sql, values);
              calls.push({ sql, rows: result.rows.length });
              return result;
            },
          } as Pick<PoolClient, "query">;
          if (index < 3) {
            await expect(f.read(view, scope)).resolves.toBeNull();
            expect(calls).toHaveLength(1);
            if (f.presenceQuery) {
              expect(calls[0]?.sql).toContain(`AS ${f.presenceQuery}_body`);
              expect(calls[0]?.sql).toContain(`AS ${f.presenceQuery}_storage`);
              expect(calls[0]?.rows).toBe(1);
            } else expect(calls[0]?.rows).toBe(0);
          } else await expect(f.read(view, scope)).rejects.toThrow(/canonical|contract/);
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT retained_original");
        }
      });
    }
    await withExactScopeTransaction(api, f.record.scope, async (client) => {
      await expect(f.read(client, f.record.scope)).resolves.toEqual(f.record);
      await expect(f.read(client, f.record.scope, "missing_record")).resolves.toBeNull();
    });
  } finally {
    expect(await fingerprint(f.record.scope)).toBe(before);
    await expect(f.find(f.record.scope)).resolves.toEqual(f.record);
  }
}

describe("exact scope precedes owning storage validation under forced RLS", () => {
  for (const kind of Object.keys(evaluationMethods) as EvaluationRecordKind[])
    it(`keeps outside ${kind} corruption opaque and rejects exact-scope corruption`, () =>
      verifyScope(evaluationFixture(kind)));
  for (const kind of comparisonKinds)
    it(`keeps outside ${kind} corruption opaque and rejects exact-scope corruption`, () =>
      verifyScope(comparisonFixture(kind)));
  it("keeps outside release candidate corruption opaque and rejects exact-scope corruption", () =>
    verifyScope(candidateFixture()));
});
