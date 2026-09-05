import { describe, expect, it } from "vitest";
import { ComparisonExperimentScenario } from "./scenario.js";
import { runComparisonExperiment } from "./workflow.js";

describe("comparison control-flow experiment", () => {
  it("executes the real comparison engine and reads back an exact negative latency delta", async () => {
    await expect(
      runComparisonExperiment({
        baselineMilliseconds: 125,
        candidateMilliseconds: 100,
        namespace: "test",
      }),
    ).resolves.toMatchObject({
      evidence: {
        baselineMilliseconds: 125,
        candidateMilliseconds: 100,
        integrity: "verified",
        source: "synthetic",
      },
      outcome: {
        delta: {
          denominator: "1",
          numerator: "-25",
          representation: "rational",
          unit: "milliseconds",
        },
        direction: "decreased",
        metricId: "metric_elapsed",
        status: "available",
      },
      readBack: {
        resultId: "result_latency_test",
        resultSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("shows a positive delta when the candidate is slower", async () => {
    await expect(
      runComparisonExperiment({
        baselineMilliseconds: 80,
        candidateMilliseconds: 110,
        namespace: "slower",
      }),
    ).resolves.toMatchObject({
      outcome: {
        delta: { denominator: "1", numerator: "30" },
        direction: "increased",
      },
    });
  });

  it("rejects ambiguous namespaces and unsafe measurements", () => {
    expect(
      () =>
        new ComparisonExperimentScenario({
          baselineMilliseconds: -1,
          candidateMilliseconds: 100,
          namespace: "test",
        }),
    ).toThrow("baselineMilliseconds");
    expect(
      () =>
        new ComparisonExperimentScenario({
          baselineMilliseconds: 125,
          candidateMilliseconds: Number.MAX_SAFE_INTEGER + 1,
          namespace: "test",
        }),
    ).toThrow("candidateMilliseconds");
    expect(
      () =>
        new ComparisonExperimentScenario({
          baselineMilliseconds: 125,
          candidateMilliseconds: 100,
          namespace: "Not Exact",
        }),
    ).toThrow("namespace");
  });
});
