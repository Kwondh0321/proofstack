import { createApp, type ApiConfig } from "@proofstack/api/composition";
import {
  PublishComparisonRecordResponseSchema,
  type PublishComparisonRecordResponse,
} from "@proofstack/contracts";
import { ComparisonExperimentScenario, type ComparisonScenario } from "./scenario.js";

const scopeUrl = "/v1/projects/prj_local/environments/env_local/comparisons";

export interface ComparisonDemoOptions {
  readonly baselineMilliseconds: number;
  readonly candidateMilliseconds: number;
  readonly namespace: string;
}

export interface ComparisonDemoApp {
  readonly app: Awaited<ReturnType<typeof createApp>>;
  readonly scenario: ComparisonScenario;
}

export const comparisonDemoConfig: ApiConfig = {
  authMode: "development",
  environment: "development",
  host: "127.0.0.1",
  logLevel: "silent",
  otlp: {
    compressedBodyLimitBytes: 1024 * 1024,
    decompressedBodyLimitBytes: 1024 * 1024,
  },
  port: 4318,
  storage: { mode: "memory" },
};

async function acceptedRecord(
  response: { readonly statusCode: number; json(): unknown },
  operation: string,
): Promise<PublishComparisonRecordResponse> {
  if (response.statusCode !== 200 && response.statusCode !== 201) {
    throw new Error(`${operation} failed with HTTP ${response.statusCode}`);
  }
  return PublishComparisonRecordResponseSchema.parse(response.json());
}

export async function createComparisonDemoApp(
  options: ComparisonDemoOptions,
): Promise<ComparisonDemoApp> {
  const scenario = new ComparisonExperimentScenario(options);
  return createComparisonScenarioApp(scenario);
}

export async function createComparisonScenarioApp(
  scenario: ComparisonScenario,
): Promise<ComparisonDemoApp> {
  const app = await createApp(comparisonDemoConfig, {
    clock: { now: () => new Date("2026-09-02T04:00:00.000Z") },
    comparisonEvidenceResolver: {
      resolve: async ({ comparison, role }) => scenario.resolve(comparison, role),
    },
  });
  return { app, scenario };
}

export async function seedComparisonDemo(
  demo: Awaited<ReturnType<typeof createComparisonDemoApp>>,
): Promise<{ readonly created: boolean; readonly resultId: string }> {
  const { app, scenario } = demo;
  const definitionResponse = await acceptedRecord(
    await app.inject({
      body: scenario.definition(),
      method: "POST",
      url: `${scopeUrl}/${scenario.ids.comparison}/definitions/${scenario.ids.comparisonVersion}`,
    }),
    "Comparison definition publication",
  );
  if (definitionResponse.result.kind !== "comparison_definition") {
    throw new Error("Comparison definition route returned the wrong record kind");
  }
  const definition = definitionResponse.result.record;
  const comparison = {
    comparisonId: definition.comparisonId,
    comparisonVersionId: definition.comparisonVersionId,
    definitionSha256: definition.definitionSha256,
  };
  const publishSnapshot = async (role: "baseline" | "candidate", snapshotId: string) => {
    const response = await acceptedRecord(
      await app.inject({
        body: { comparison, role, snapshotId },
        method: "POST",
        url: `${scopeUrl}/evidence-snapshots/${snapshotId}`,
      }),
      `${role} snapshot publication`,
    );
    if (response.result.kind !== "comparison_evidence_snapshot") {
      throw new Error(`${role} snapshot route returned the wrong record kind`);
    }
    return response.result.record;
  };
  const [baseline, candidate] = await Promise.all([
    publishSnapshot("baseline", scenario.ids.snapshotBaseline),
    publishSnapshot("candidate", scenario.ids.snapshotCandidate),
  ]);
  const resultInput = {
    baselineSnapshot: {
      definitionSha256: baseline.definitionSha256,
      role: "baseline" as const,
      snapshotId: baseline.snapshotId,
    },
    candidateSnapshot: {
      definitionSha256: candidate.definitionSha256,
      role: "candidate" as const,
      snapshotId: candidate.snapshotId,
    },
    comparison,
    resultId: scenario.ids.result,
  };
  const resultResponse = await acceptedRecord(
    await app.inject({
      body: resultInput,
      method: "POST",
      url: `${scopeUrl}/results/${scenario.ids.result}`,
    }),
    "Comparison result derivation",
  );
  if (resultResponse.result.kind !== "comparison_result") {
    throw new Error("Comparison result route returned the wrong record kind");
  }
  return { created: resultResponse.created, resultId: resultResponse.result.record.resultId };
}
