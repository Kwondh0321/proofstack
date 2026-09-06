import { describe, expect, it } from "vitest";
import { resolveAssessmentOracleReferences } from "./workflow.js";

const digest = (character: string) => character.repeat(64);

function clientWithGraph(options: { readonly corruptObservation?: boolean } = {}) {
  const records = new Map([
    [
      "raw_observation:obs_b",
      {
        kind: "raw_observation",
        record: {
          definitionSha256: options.corruptObservation ? digest("f") : digest("b"),
          run: { definitionSha256: digest("2"), evaluationRunId: "run_b" },
        },
      },
    ],
    [
      "raw_observation:obs_a",
      {
        kind: "raw_observation",
        record: {
          definitionSha256: digest("a"),
          run: { definitionSha256: digest("1"), evaluationRunId: "run_a" },
        },
      },
    ],
    [
      "evaluation_run:run_b",
      {
        kind: "evaluation_run",
        record: {
          definitionSha256: digest("2"),
          oracle: {
            definitionSha256: digest("d"),
            oracleId: "oracle_shared",
            oracleVersionId: "oracle_shared_v1",
          },
        },
      },
    ],
    [
      "evaluation_run:run_a",
      {
        kind: "evaluation_run",
        record: {
          definitionSha256: digest("1"),
          oracle: {
            definitionSha256: digest("c"),
            oracleId: "oracle_alpha",
            oracleVersionId: "oracle_alpha_v1",
          },
        },
      },
    ],
    [
      "oracle_spec:oracle_shared_v1",
      {
        kind: "oracle_spec",
        record: {
          definitionSha256: digest("d"),
          oracleId: "oracle_shared",
        },
      },
    ],
    [
      "oracle_spec:oracle_alpha_v1",
      {
        kind: "oracle_spec",
        record: {
          definitionSha256: digest("c"),
          oracleId: "oracle_alpha",
        },
      },
    ],
  ]);
  return {
    readRecord: async ({
      kind,
      recordId,
    }: {
      readonly kind: string;
      readonly recordId: string;
    }) => {
      const result = records.get(`${kind}:${recordId}`);
      if (!result) throw new Error(`Missing test record ${kind}:${recordId}`);
      return { requestId: "req_oracle_resolution", result };
    },
  };
}

const assessment = {
  observations: [
    { definitionSha256: digest("a"), observationId: "obs_a" },
    { definitionSha256: digest("b"), observationId: "obs_b" },
  ],
};

describe("model-assurance assessment oracle resolution", () => {
  it("derives ordered exact oracles from the assessment observation graph", async () => {
    await expect(
      resolveAssessmentOracleReferences(clientWithGraph() as never, assessment as never),
    ).resolves.toEqual([
      {
        definitionSha256: digest("c"),
        oracleId: "oracle_alpha",
        oracleVersionId: "oracle_alpha_v1",
      },
      {
        definitionSha256: digest("d"),
        oracleId: "oracle_shared",
        oracleVersionId: "oracle_shared_v1",
      },
    ]);
  });

  it("rejects an observation that no longer matches the assessment digest", async () => {
    await expect(
      resolveAssessmentOracleReferences(
        clientWithGraph({ corruptObservation: true }) as never,
        assessment as never,
      ),
    ).rejects.toThrow(/did not resolve to its exact record/);
  });
});
