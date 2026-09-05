import { ReadComparisonRecordResponseSchema } from "@proofstack/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AdversarialComparisonScenario } from "./adversarial-scenario.js";
import {
  createComparisonDemoApp,
  createComparisonScenarioApp,
  seedComparisonDemo,
} from "./service.js";

const openApps: Awaited<ReturnType<typeof createComparisonDemoApp>>[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(({ app }) => app.close()));
});

describe("comparison service demo", () => {
  it("crosses real HTTP routes and preserves idempotent server-derived evidence", async () => {
    const demo = await createComparisonDemoApp({
      baselineMilliseconds: 125,
      candidateMilliseconds: 100,
      namespace: "service",
    });
    openApps.push(demo);

    await expect(seedComparisonDemo(demo)).resolves.toEqual({
      created: true,
      resultId: "result_latency_service",
    });
    await expect(seedComparisonDemo(demo)).resolves.toEqual({
      created: false,
      resultId: "result_latency_service",
    });

    const read = await demo.app.inject({
      method: "GET",
      url: "/v1/projects/prj_local/environments/env_local/comparisons/records/comparison_result/result_latency_service",
    });
    expect(read.statusCode).toBe(200);
    expect(read.headers["cache-control"]).toBe("no-store");
    expect(read.json()).toMatchObject({
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
          resultId: "result_latency_service",
        },
      },
    });
  });

  it("surfaces route publication failures instead of starting with partial data", async () => {
    const demo = await createComparisonDemoApp({
      baselineMilliseconds: 125,
      candidateMilliseconds: 100,
      namespace: "failure",
    });
    openApps.push(demo);
    await demo.app.close();
    openApps.pop();

    await expect(seedComparisonDemo(demo)).rejects.toThrow();
  });

  it("preserves adversarial missingness, mismatch, artifact, safety, and disagreement evidence", async () => {
    const demo = await createComparisonScenarioApp(new AdversarialComparisonScenario("serviceadv"));
    openApps.push(demo);

    await expect(seedComparisonDemo(demo)).resolves.toEqual({
      created: true,
      resultId: "result_adversarial_serviceadv",
    });
    const read = await demo.app.inject({
      method: "GET",
      url: "/v1/projects/prj_local/environments/env_local/comparisons/records/comparison_result/result_adversarial_serviceadv",
    });
    expect(read.statusCode).toBe(200);
    const response = ReadComparisonRecordResponseSchema.parse(read.json());
    if (response.result.kind !== "comparison_result") throw new Error("Expected comparison result");
    const result = response.result.record;
    expect(result.artifactChanges).toEqual([
      expect.objectContaining({
        artifactId: "artifact_adversarial_serviceadv",
        status: "metadata_changed",
      }),
    ]);
    expect(result.comparability).toEqual({
      reasons: ["fixture_mismatch"],
      status: "partially_comparable",
    });
    expect(result.pairing).toEqual({
      baselineOnlyCount: 0,
      candidateOnlyCount: 0,
      invalidCount: 0,
      pairedCount: 1,
      requestedCount: 1,
    });
    expect(
      result.metricResults.find(({ metricId }) => metricId === "metric_disagreement"),
    ).toMatchObject({
      value: {
        baseline: { numerator: "0" },
        candidate: { numerator: "1" },
        delta: { numerator: "1" },
        status: "available",
      },
    });
    expect(
      result.metricResults.find(({ metricId }) => metricId === "metric_provider_cost"),
    ).toMatchObject({
      usageProvenance: {
        baseline: { completeCount: 1, observedSources: ["provider_reported"] },
        candidate: {
          completeCount: 0,
          unavailableCount: 1,
          unavailableReasons: ["provider_did_not_report"],
        },
      },
      value: {
        reasons: ["candidate_missing", "insufficient_observations", "measurement_unavailable"],
        status: "unavailable",
      },
    });
    expect(result.safetyCounts.find(({ kind }) => kind === "guardrail_check")).toEqual({
      counts: { baseline: 1, candidate: 2, delta: 1 },
      kind: "guardrail_check",
    });
    expect(result.verdictTransitions).toEqual([]);
    expect(result.verdictMarginals).toEqual([
      expect.objectContaining({ transition: expect.objectContaining({ status: "unavailable" }) }),
    ]);
  });
});
