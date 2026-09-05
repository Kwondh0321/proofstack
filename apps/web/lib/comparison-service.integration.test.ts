import { randomUUID } from "node:crypto";
import { type ApiConfig, createApp } from "@proofstack/api/composition";
import { AdversarialComparisonScenario } from "@proofstack/example-comparison-control-flow/adversarial-scenario";
import {
  createPostgresPool,
  migrateDatabase,
  provisionRuntimeRoles,
  type RuntimeRoleProvisioningOptions,
} from "@proofstack/postgres";
import { ProofStackComparisonClient } from "@proofstack/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildComparisonDisplay } from "./comparison-view-model.js";
import { getComparisonView } from "./proofstack-api.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for comparison service integration tests`);
  return value;
}

const databaseUrl = requiredEnvironment("PROOFSTACK_TEST_DATABASE_URL");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const environmentId = `env_comparison_${runKey}`;
const projectId = `prj_comparison_${runKey}`;
const scenario = new AdversarialComparisonScenario(runKey);
const fixedClock = { now: () => new Date("2026-09-02T04:00:00.000Z") };
const webEnvironment = process.env as NodeJS.ProcessEnv & {
  PROOFSTACK_API_URL?: string;
  PROOFSTACK_ENVIRONMENT_ID?: string;
  PROOFSTACK_PROJECT_ID?: string;
};

function credentials(kind: string) {
  return { name: `proofstack_cmp_${runKey}_${kind}`, password: randomUUID() };
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
  applicationName: "proofstack-comparison-service-integration-setup",
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

const originalWebEnvironment = {
  apiUrl: webEnvironment.PROOFSTACK_API_URL,
  environmentId: webEnvironment.PROOFSTACK_ENVIRONMENT_ID,
  projectId: webEnvironment.PROOFSTACK_PROJECT_ID,
};

let apiUrl: string;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let rolesCreated = false;

function client(): ProofStackComparisonClient {
  return new ProofStackComparisonClient({
    authentication: { mode: "development" },
    endpoint: apiUrl,
    environmentId,
    projectId,
  });
}

async function startApi(withEvidenceResolver: boolean): Promise<void> {
  app = await createApp(apiConfig, {
    clock: fixedClock,
    ...(withEvidenceResolver
      ? {
          comparisonEvidenceResolver: {
            resolve: async ({ comparison, role }) => scenario.resolve(comparison, role),
          },
        }
      : {}),
  });
  apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  await migrateDatabase(adminPool);
  await provisionRuntimeRoles(adminPool, runtimeRoles);
  rolesCreated = true;
  await startApi(true);
}, 60_000);

afterAll(async () => {
  try {
    await app?.close();
    if (rolesCreated) {
      for (const role of Object.values(runtimeRoles)) {
        await adminPool.query(`DROP OWNED BY "${role.name}"`);
        await adminPool.query(`DROP ROLE "${role.name}"`);
      }
    }
  } finally {
    restoreEnvironment("PROOFSTACK_API_URL", originalWebEnvironment.apiUrl);
    restoreEnvironment("PROOFSTACK_ENVIRONMENT_ID", originalWebEnvironment.environmentId);
    restoreEnvironment("PROOFSTACK_PROJECT_ID", originalWebEnvironment.projectId);
    await adminPool.end();
  }
}, 30_000);

describe("persistent comparison service flow", () => {
  it("survives API restart and reaches the operator projection without losing adverse evidence", async () => {
    const firstClient = client();
    const published = await firstClient.publishDefinition({
      comparisonId: scenario.ids.comparison,
      request: scenario.definition(),
    });
    if (published.result.kind !== "comparison_definition") {
      throw new TypeError("Comparison definition publication returned the wrong record kind");
    }
    const definition = published.result.record;
    const comparison = {
      comparisonId: definition.comparisonId,
      comparisonVersionId: definition.comparisonVersionId,
      definitionSha256: definition.definitionSha256,
    };
    const createSnapshot = async (role: "baseline" | "candidate", snapshotId: string) => {
      const response = await firstClient.createEvidenceSnapshot({
        request: { comparison, role, snapshotId },
        snapshotId,
      });
      if (response.result.kind !== "comparison_evidence_snapshot") {
        throw new TypeError(`${role} publication returned the wrong record kind`);
      }
      return response.result.record;
    };
    const [baseline, candidate] = await Promise.all([
      createSnapshot("baseline", scenario.ids.snapshotBaseline),
      createSnapshot("candidate", scenario.ids.snapshotCandidate),
    ]);
    const derived = await firstClient.deriveResult({
      request: {
        baselineSnapshot: {
          definitionSha256: baseline.definitionSha256,
          role: "baseline",
          snapshotId: baseline.snapshotId,
        },
        candidateSnapshot: {
          definitionSha256: candidate.definitionSha256,
          role: "candidate",
          snapshotId: candidate.snapshotId,
        },
        comparison,
        resultId: scenario.ids.result,
      },
      resultId: scenario.ids.result,
    });
    if (derived.result.kind !== "comparison_result") {
      throw new TypeError("Comparison derivation returned the wrong record kind");
    }

    const references = [
      { kind: "comparison_definition" as const, recordId: definition.comparisonVersionId },
      { kind: "comparison_evidence_snapshot" as const, recordId: baseline.snapshotId },
      { kind: "comparison_evidence_snapshot" as const, recordId: candidate.snapshotId },
      { kind: "comparison_result" as const, recordId: derived.result.record.resultId },
    ];
    const beforeRestart = await Promise.all(
      references.map((reference) => firstClient.readRecord(reference)),
    );

    await app?.close();
    app = undefined;
    await startApi(false);

    const restartedClient = client();
    const afterRestart = await Promise.all(
      references.map((reference) => restartedClient.readRecord(reference)),
    );
    expect(afterRestart.map(({ result }) => result)).toEqual(
      beforeRestart.map(({ result }) => result),
    );
    expect(afterRestart.map(({ result }) => result.record.definitionSha256)).toEqual([
      definition.definitionSha256,
      baseline.definitionSha256,
      candidate.definitionSha256,
      derived.result.record.definitionSha256,
    ]);

    webEnvironment.PROOFSTACK_API_URL = apiUrl;
    webEnvironment.PROOFSTACK_ENVIRONMENT_ID = environmentId;
    webEnvironment.PROOFSTACK_PROJECT_ID = projectId;
    const view = await getComparisonView(scenario.ids.result);
    expect(view).toMatchObject({ ok: true });
    if (!view.ok)
      throw new Error(`Operator projection rejected persisted evidence: ${view.message}`);
    const model = buildComparisonDisplay(view.data);

    expect(model.comparability).toEqual({
      reasons: ["fixture_mismatch"],
      status: "partially_comparable",
    });
    expect(model.pairing).toEqual({
      baselineOnly: 0,
      candidateOnly: 0,
      invalid: 0,
      paired: 1,
      requested: 1,
    });
    expect(model.cases).toEqual([
      expect.objectContaining({
        baselineVersion: expect.stringContaining("_v1_"),
        candidateVersion: expect.stringContaining("_v2_"),
        fixtureId: scenario.fixtureId,
        state: "paired",
      }),
    ]);
    expect(model.artifacts).toEqual([
      expect.objectContaining({
        artifactId: `artifact_adversarial_${runKey}`,
        baseline: expect.objectContaining({ sha256: "6".repeat(64), sizeBytes: 256 }),
        candidate: expect.objectContaining({ sha256: "b".repeat(64), sizeBytes: 384 }),
        status: "metadata_changed",
      }),
    ]);
    expect(model.metrics.find(({ metricId }) => metricId === "metric_elapsed")).toMatchObject({
      baseline: { text: "125/1 milliseconds" },
      candidate: { text: "100/1 milliseconds" },
      delta: { text: "-25/1 milliseconds" },
      direction: "decreased",
      status: "available",
    });
    expect(model.metrics.find(({ metricId }) => metricId === "metric_disagreement")).toMatchObject({
      baseline: { numerator: "0" },
      candidate: { numerator: "1" },
      delta: { numerator: "1" },
      status: "available",
    });
    expect(model.metrics.find(({ metricId }) => metricId === "metric_provider_cost")).toMatchObject(
      {
        reasons: ["candidate_missing", "insufficient_observations", "measurement_unavailable"],
        status: "unavailable",
        usageProvenance: {
          baseline: expect.stringContaining("sources provider_reported"),
          candidate: expect.stringContaining("reasons provider_did_not_report"),
        },
      },
    );
    expect(model.safety).toEqual([
      { baseline: 1, candidate: 2, delta: 1, kind: "guardrail_check" },
      { baseline: 0, candidate: 0, delta: 0, kind: "replay_safety_intervention" },
      { baseline: 0, candidate: 0, delta: 0, kind: "uncertain_side_effect" },
    ]);
    expect(model.verdictTransitions).toEqual([]);
    expect(model.verdictMarginals).toEqual([
      expect.objectContaining({ transition: expect.stringContaining("unavailable") }),
    ]);
    expect(model.sources).toEqual([
      expect.objectContaining({
        definitionSha256: baseline.definitionSha256,
        integrity: "verified",
        role: "baseline",
        snapshotId: baseline.snapshotId,
      }),
      expect.objectContaining({
        definitionSha256: candidate.definitionSha256,
        integrity: "verified",
        omissionReasons: ["classified_content_excluded"],
        role: "candidate",
        snapshotId: candidate.snapshotId,
      }),
    ]);
    expect(model.comparison.definitionSha256).toBe(definition.definitionSha256);
    expect(model.result.definitionSha256).toBe(derived.result.record.definitionSha256);
    expect(model).not.toHaveProperty("approval");
    expect(model).not.toHaveProperty("releaseDecision");
  }, 30_000);
});
