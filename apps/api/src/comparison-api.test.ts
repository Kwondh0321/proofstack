import { readFileSync } from "node:fs";
import type {
  ComparisonDefinition,
  ComparisonDefinitionInput,
  ComparisonEvidenceSnapshotDefinition,
} from "@proofstack/contracts";
import {
  type ComparisonEvidenceResolution,
  type ComparisonEvidenceResolver,
  MemoryComparisonRepository,
} from "@proofstack/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

interface StoredVector<Definition> {
  readonly input: { readonly definition: Definition };
}

function vector<Definition>(filename: string): Definition {
  const document = JSON.parse(
    readFileSync(
      new URL(`../../../packages/contracts/vectors/${filename}`, import.meta.url),
      "utf8",
    ),
  ) as { readonly vectors: readonly StoredVector<Definition>[] };
  const first = document.vectors[0];
  if (!first) throw new Error(`Expected ${filename}`);
  return structuredClone(first.input.definition);
}

const definitionTemplate = vector<ComparisonDefinitionInput>(
  "evaluation-comparison-definition-v1.json",
);
const snapshotTemplate = vector<ComparisonEvidenceSnapshotDefinition>(
  "evaluation-comparison-snapshot-definition-v1.json",
);
const { comparisonId, predecessor: _predecessor, ...definitionInput } = definitionTemplate;
const config = loadConfig({ PROOFSTACK_ENV: "test", PROOFSTACK_LOG_LEVEL: "silent" });
const scopeUrl = "/v1/projects/prj_local/environments/env_local/comparisons";
const definitionUrl = `${scopeUrl}/${comparisonId}/definitions/${definitionInput.comparisonVersionId}`;
const apps: Awaited<ReturnType<typeof createApp>>[] = [];

function resolution(
  comparison: ComparisonDefinition,
  role: "baseline" | "candidate",
): ComparisonEvidenceResolution {
  const subject = comparison[role];
  const fixture = subject.fixtures[0];
  const templateFixture = snapshotTemplate.fixtures[0];
  if (!fixture || !templateFixture) throw new Error("Expected one comparison fixture");
  return {
    dataset: structuredClone(subject.dataset),
    fixtures: [
      {
        artifacts: [
          { artifact: structuredClone(fixture.replay.result), availability: "available" },
        ],
        assurance: [
          ...fixture.assessments.map((reference) => ({
            eligibility: "ineligible" as const,
            kind: "assessment" as const,
            reasons: ["human_review_required" as const],
            reference: structuredClone(reference),
          })),
          ...fixture.modelAssuranceAssessments.map((reference) => ({
            eligibility: "eligible" as const,
            kind: "model_assurance" as const,
            reasons: [],
            reference: structuredClone(reference),
          })),
        ],
        evaluationOutcomes: [],
        fixture: structuredClone(fixture.fixture),
        numericObservations: [],
        replay: structuredClone(fixture.replay),
        safetyEvents: [],
        trace: structuredClone(templateFixture.trace),
        usage: [
          {
            dimension: "elapsedMilliseconds",
            value: {
              amount: role === "baseline" ? 125 : 100,
              observedCount: 1,
              sources: ["measured"],
              status: "available",
              unavailableCount: 0,
            },
          },
        ],
      },
    ],
    integrity: "verified",
    knownLimitations: ["Synthetic API integration source"],
    omissions: [],
    sourceCutoff: fixture.replay.completedAt,
  };
}

async function testApp(
  dependencies: Parameters<typeof createApp>[1] = {},
): Promise<Awaited<ReturnType<typeof createApp>>> {
  const app = await createApp(config, {
    clock: { now: () => new Date("2026-09-02T04:00:00.000Z") },
    ...dependencies,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("comparison control-plane API", () => {
  it("publishes exact sources, freezes snapshots, derives a result, and reads it back", async () => {
    const evidenceResolver: ComparisonEvidenceResolver = {
      resolve: async ({ comparison, role }) => resolution(comparison, role),
    };
    const app = await testApp({ comparisonEvidenceResolver: evidenceResolver });
    const definitionResponse = await app.inject({
      body: definitionInput,
      method: "POST",
      url: definitionUrl,
    });
    expect(definitionResponse.statusCode).toBe(201);
    const definition = definitionResponse.json().result.record;
    const comparison = {
      comparisonId: definition.comparisonId,
      comparisonVersionId: definition.comparisonVersionId,
      definitionSha256: definition.definitionSha256,
    };
    const snapshots = await Promise.all(
      (["baseline", "candidate"] as const).map(async (role) => {
        const snapshotId = `snapshot_${role}_api`;
        const response = await app.inject({
          body: { comparison, role, snapshotId },
          method: "POST",
          url: `${scopeUrl}/evidence-snapshots/${snapshotId}`,
        });
        expect(response.statusCode).toBe(201);
        expect(response.headers["cache-control"]).toBe("no-store");
        return response.json().result.record;
      }),
    );
    const [baseline, candidate] = snapshots;
    if (!baseline || !candidate) throw new Error("Expected two snapshots");
    const resultInput = {
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
      resultId: "result_api",
    };
    const resultResponse = await app.inject({
      body: resultInput,
      method: "POST",
      url: `${scopeUrl}/results/${resultInput.resultId}`,
    });
    const retryResponse = await app.inject({
      body: resultInput,
      method: "POST",
      url: `${scopeUrl}/results/${resultInput.resultId}`,
    });
    const readResponse = await app.inject({
      method: "GET",
      url: `${scopeUrl}/records/comparison_result/${resultInput.resultId}`,
    });

    expect(resultResponse.statusCode).toBe(201);
    expect(retryResponse.statusCode).toBe(200);
    expect(retryResponse.json()).toMatchObject({ created: false });
    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.json()).toMatchObject({
      result: {
        kind: "comparison_result",
        record: {
          metricResults: [
            {
              metricId: "metric_elapsed",
              value: {
                delta: { denominator: "1", numerator: "-25", unit: "milliseconds" },
                direction: "decreased",
                status: "available",
              },
            },
            { metricId: "metric_trace_events" },
          ],
          resultId: resultInput.resultId,
        },
      },
    });
  });

  it("maps route mismatch, missing sources, absent records, and storage corruption", async () => {
    const app = await testApp();
    const routeMismatch = await app.inject({
      body: definitionInput,
      method: "POST",
      url: `${scopeUrl}/${comparisonId}/definitions/comparison_different`,
    });
    const definitionResponse = await app.inject({
      body: definitionInput,
      method: "POST",
      url: definitionUrl,
    });
    const definition = definitionResponse.json().result.record;
    const unavailable = await app.inject({
      body: {
        comparison: {
          comparisonId: definition.comparisonId,
          comparisonVersionId: definition.comparisonVersionId,
          definitionSha256: definition.definitionSha256,
        },
        role: "baseline",
        snapshotId: "snapshot_unavailable",
      },
      method: "POST",
      url: `${scopeUrl}/evidence-snapshots/snapshot_unavailable`,
    });
    const missing = await app.inject({
      method: "GET",
      url: `${scopeUrl}/records/comparison_result/result_missing`,
    });

    expect(routeMismatch.json()).toMatchObject({
      code: "comparison_record_input_invalid",
      status: 400,
    });
    expect(unavailable.json()).toMatchObject({
      code: "comparison_source_unavailable",
      status: 409,
    });
    expect(missing.json()).toMatchObject({ code: "comparison_record_not_found", status: 404 });

    const repository = new MemoryComparisonRepository();
    vi.spyOn(repository, "findComparisonResult").mockResolvedValue({ secret: "corrupt" } as never);
    const corrupted = await testApp({ comparisonRepository: repository });
    const corruption = await corrupted.inject({
      method: "GET",
      url: `${scopeUrl}/records/comparison_result/result_corrupt`,
    });
    expect(corruption.json()).toMatchObject({
      code: "comparison_storage_unavailable",
      detail: "Comparison storage is unavailable",
      status: 503,
    });
    expect(corruption.body).not.toContain("corrupt");
  });
});
