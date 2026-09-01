import { randomUUID } from "node:crypto";
import { type ApiConfig, createApp } from "@proofstack/api/composition";
import { SystemClock } from "@proofstack/core";
import {
  createPostgresEvaluationWorker,
  type PostgresEvaluationWorkerRuntime,
} from "@proofstack/evaluation-worker";
import {
  createPostgresPool,
  migrateDatabase,
  provisionRuntimeRoles,
  type RuntimeRoleProvisioningOptions,
} from "@proofstack/postgres";
import { ProofStackEvaluationClient } from "@proofstack/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runEvaluationControlFlow } from "./workflow.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for evaluation control-flow integration tests`);
  return value;
}

const databaseUrl = requiredEnvironment("PROOFSTACK_TEST_DATABASE_URL");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const environmentId = `env_evaluation_${runKey}`;
const projectId = `prj_evaluation_${runKey}`;

function credentials(kind: string) {
  return {
    name: `proofstack_eval_${runKey}_${kind}`,
    password: randomUUID(),
  };
}

const runtimeRoles: RuntimeRoleProvisioningOptions = {
  api: credentials("api"),
  artifact: credentials("artifact"),
  consumer: credentials("consumer"),
  evaluationWorker: credentials("evaluation"),
  identity: credentials("identity"),
  publisher: credentials("publisher"),
  replayWorker: credentials("replay"),
};

function roleDatabaseUrl(role: { readonly name: string; readonly password: string }): string {
  const value = new URL(databaseUrl);
  value.username = role.name;
  value.password = role.password;
  return value.toString();
}

const adminPool = createPostgresPool({
  applicationName: "proofstack-evaluation-control-flow-integration-setup",
  connectionString: databaseUrl,
  maxConnections: 1,
  onIdleError: (error) => {
    throw error;
  },
});

const apiConfig: ApiConfig = {
  authMode: "development",
  environment: "test",
  host: "127.0.0.1",
  logLevel: "silent",
  otlp: { compressedBodyLimitBytes: 1_048_576, decompressedBodyLimitBytes: 1_048_576 },
  port: 4318,
  storage: {
    artifacts: { mode: "disabled" },
    databaseUrl: roleDatabaseUrl(runtimeRoles.api),
    mode: "postgres",
  },
};

let apiUrl: string;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let worker: PostgresEvaluationWorkerRuntime | undefined;
let rolesCreated = false;

function client(): ProofStackEvaluationClient {
  return new ProofStackEvaluationClient({
    authentication: { mode: "development" },
    endpoint: apiUrl,
    environmentId,
    projectId,
  });
}

beforeAll(async () => {
  await migrateDatabase(adminPool);
  await provisionRuntimeRoles(adminPool, runtimeRoles);
  rolesCreated = true;
  app = await createApp(apiConfig);
  apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  worker = await createPostgresEvaluationWorker({
    clock: new SystemClock(),
    databaseUrl: roleDatabaseUrl(runtimeRoles.evaluationWorker),
    onIdleError: (error) => {
      throw error;
    },
  });
}, 60_000);

afterAll(async () => {
  try {
    await app?.close();
    await worker?.close();
    if (rolesCreated) {
      for (const role of Object.values(runtimeRoles)) {
        await adminPool.query(`DROP OWNED BY "${role.name}"`);
        await adminPool.query(`DROP ROLE "${role.name}"`);
      }
    }
  } finally {
    await adminPool.end();
  }
}, 30_000);

describe("service-backed evaluation control flow", () => {
  it("survives API restart with exact evidence, conservative aggregation, and role separation", async () => {
    if (!worker) throw new Error("The evaluation worker is unavailable");
    const summary = await runEvaluationControlFlow({
      client: client(),
      environmentId,
      namespace: runKey,
      projectId,
      worker,
    });

    expect(summary.aggregate.counts).toMatchObject({
      abstainCount: 1,
      applicableCount: 4,
      decidedCount: 2,
      errorCount: 1,
      failCount: 1,
      notApplicableCount: 1,
      passCount: 1,
      selectedCount: 5,
    });
    expect(summary.aggregate.coverage).toEqual({
      denominator: 4,
      numerator: 2,
      status: "available",
    });
    expect(summary.assessment).toMatchObject({
      eligibility: {
        reasons: [
          "critical_counterevidence",
          "human_review_required",
          "insufficient_coverage",
          "source_review_not_current",
          "unresolved_disagreement",
        ],
        status: "ineligible",
      },
      supportStatus: "inconclusive",
    });
    expect(summary.sources).toEqual({
      criticalConflictStatus: "unresolved",
      freshnessConclusion: "expired",
      outcome: "require_approval",
    });
    expect(summary.verdicts).toEqual({
      abstain: 1,
      error: 1,
      fail: 1,
      not_applicable: 1,
      pass: 1,
    });
    expect(summary.readBack.recordCount).toBe(30);
    expect(summary.readBack.kinds).toHaveLength(15);

    await app?.close();
    app = await createApp(apiConfig);
    apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const persisted = await client().readRecord({
      kind: "assessment",
      recordId: summary.assessment.assessmentId,
    });
    expect(persisted.result.kind).toBe("assessment");
    expect(persisted.result.record.definitionSha256).toBe(summary.assessment.definitionSha256);
    if (persisted.result.kind !== "assessment") {
      throw new TypeError("Persisted record changed kind after restart");
    }
    expect(persisted.result.record.eligibility).toEqual(summary.assessment.eligibility);
  });
});
