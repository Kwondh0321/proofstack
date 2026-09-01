import { randomUUID } from "node:crypto";
import { type ApiConfig, createApp } from "@proofstack/api/composition";
import type { PrincipalContext } from "@proofstack/contracts";
import { AuthoritySplitModelAssuranceRepository } from "@proofstack/core";
import { FixedClock } from "@proofstack/core/testing";
import {
  createPostgresEvaluationWorker,
  type PostgresEvaluationWorkerRuntime,
} from "@proofstack/evaluation-worker";
import {
  createPostgresModelEvaluationWorker,
  type PostgresModelEvaluationWorkerRuntime,
} from "@proofstack/model-evaluation-worker";
import {
  createPostgresPool,
  migrateDatabase,
  PostgresModelAssuranceRepository,
  provisionRuntimeRoles,
  type RuntimeRoleProvisioningOptions,
} from "@proofstack/postgres";
import { ProofStackEvaluationClient, ProofStackModelAssuranceClient } from "@proofstack/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runModelAssuranceControlFlow } from "./workflow.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for model-assurance integration tests`);
  return value;
}

const databaseUrl = requiredEnvironment("PROOFSTACK_TEST_DATABASE_URL");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const environmentId = `env_${runKey}_primary`;
const projectId = `prj_${runKey}_primary`;
const tenantId = `ten_${runKey}`;

function credentials(kind: string) {
  return { name: `proofstack_model_${runKey}_${kind}`, password: randomUUID() };
}

const runtimeRoles: RuntimeRoleProvisioningOptions = {
  api: credentials("api"),
  artifact: credentials("artifact"),
  consumer: credentials("consumer"),
  evaluationWorker: credentials("evaluation"),
  humanReviewer: credentials("human"),
  identity: credentials("identity"),
  modelEvaluationWorker: credentials("model"),
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
  applicationName: "proofstack-model-assurance-control-flow-setup",
  connectionString: databaseUrl,
  maxConnections: 1,
  onIdleError: (error) => {
    throw error;
  },
});
const assuranceControlPool = createPostgresPool({
  applicationName: "proofstack-model-assurance-control-authority",
  connectionString: roleDatabaseUrl(runtimeRoles.api),
  maxConnections: 2,
  onIdleError: (error) => {
    throw error;
  },
});
const assuranceExecutionPool = createPostgresPool({
  applicationName: "proofstack-model-assurance-execution-authority",
  connectionString: roleDatabaseUrl(runtimeRoles.modelEvaluationWorker),
  maxConnections: 2,
  onIdleError: (error) => {
    throw error;
  },
});
const assuranceHumanReviewPool = createPostgresPool({
  applicationName: "proofstack-model-assurance-human-review-authority",
  connectionString: roleDatabaseUrl(runtimeRoles.humanReviewer),
  maxConnections: 2,
  onIdleError: (error) => {
    throw error;
  },
});
const assuranceRepository = new AuthoritySplitModelAssuranceRepository({
  control: new PostgresModelAssuranceRepository(assuranceControlPool),
  execution: new PostgresModelAssuranceRepository(assuranceExecutionPool),
  humanReview: new PostgresModelAssuranceRepository(assuranceHumanReviewPool),
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

let selectedPrincipal: PrincipalContext = {
  authentication: { authenticatedAt: "2026-09-02T05:59:00.000Z", method: "development" },
  capabilities: ["evaluation:manage"],
  principalId: "usr_initial",
  principalType: "user",
  requestId: "req_initial",
  resourceScope: { mode: "tenant" },
  roles: ["admin"],
  tenantId,
};
const authenticator = { authenticate: async () => structuredClone(selectedPrincipal) };
const clock = new FixedClock(new Date("2026-09-02T06:00:00.000Z"));

let apiUrl: string;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let evaluationWorker: PostgresEvaluationWorkerRuntime | undefined;
let modelWorker: PostgresModelEvaluationWorkerRuntime | undefined;
let rolesCreated = false;

function evaluationClient(): ProofStackEvaluationClient {
  return new ProofStackEvaluationClient({
    authentication: { mode: "development" },
    endpoint: apiUrl,
    environmentId,
    projectId,
  });
}

function modelClient(): ProofStackModelAssuranceClient {
  return new ProofStackModelAssuranceClient({
    authentication: { mode: "development" },
    endpoint: apiUrl,
    environmentId,
    projectId,
  });
}

async function startApi(): Promise<void> {
  app = await createApp(apiConfig, {
    authenticator,
    clock,
    modelAssuranceRepository: assuranceRepository,
  });
  apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
}

beforeAll(async () => {
  await migrateDatabase(adminPool);
  await provisionRuntimeRoles(adminPool, runtimeRoles);
  rolesCreated = true;
  await startApi();
  evaluationWorker = await createPostgresEvaluationWorker({
    clock,
    databaseUrl: roleDatabaseUrl(runtimeRoles.evaluationWorker),
    onIdleError: (error) => {
      throw error;
    },
  });
  modelWorker = await createPostgresModelEvaluationWorker({
    clock,
    databaseUrl: roleDatabaseUrl(runtimeRoles.modelEvaluationWorker),
    onIdleError: (error) => {
      throw error;
    },
  });
}, 60_000);

afterAll(async () => {
  try {
    await app?.close();
    await evaluationWorker?.close();
    await modelWorker?.close();
    await Promise.all([
      assuranceControlPool.end(),
      assuranceExecutionPool.end(),
      assuranceHumanReviewPool.end(),
    ]);
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

describe("service-backed model-assurance control flow", () => {
  it("fails closed across adversarial model, evidence, independence, and human-review paths", async () => {
    if (!evaluationWorker || !modelWorker) throw new Error("Assurance workers are unavailable");
    const summary = await runModelAssuranceControlFlow({
      evaluationClient: evaluationClient(),
      evaluationWorker,
      modelClient: modelClient(),
      modelWorker,
      namespace: runKey,
      selectApiPrincipal: (principal) => {
        selectedPrincipal = principal;
      },
    });

    expect(summary.assessment.eligibility).toBe("ineligible");
    expect(summary.assessment.reasons).toEqual(
      expect.arrayContaining([
        "base_assessment_ineligible",
        "calibration_unavailable",
        "critical_counterevidence",
        "human_review_conflicted",
        "independence_correlated",
        "injection_qualification_failed",
        "model_qualification_unqualified",
        "order_sensitive_result",
      ]),
    );
    expect(summary.localProvider).toMatchObject({
      failureCode: "provider_unavailable",
      recordedToolRequestCount: 1,
      status: "completed",
    });
    expect(summary.localProvider.requestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(summary.localProvider.responseSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(summary.readBack.evaluationRecordCount).toBeGreaterThan(16);
    expect(summary.readBack.modelRecordCount).toBeGreaterThan(20);
    expect(summary.safeguards).toEqual({
      calibrationStatus: "unavailable",
      criticIndependence: "correlated",
      humanActions: ["oppose", "recuse", "support", "support"],
      qualificationStatus: "unqualified",
      reversalStatus: "disagreement",
    });

    await app?.close();
    await startApi();
    for (const reference of summary.readBack.evaluationRecords) {
      const persisted = await evaluationClient().readRecord(reference);
      expect(persisted.result.record.definitionSha256).toBe(reference.definitionSha256);
    }
    for (const reference of summary.readBack.modelRecords) {
      const persisted = await modelClient().readRecord(reference);
      expect(persisted.result.record.definitionSha256).toBe(reference.definitionSha256);
    }
  });
});
