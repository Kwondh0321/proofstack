import { readFileSync } from "node:fs";
import { ComparisonDefinitionSchema } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { createWorkflow1ComparisonDefinition } from "./comparison-definition.js";

interface StoredVector {
  readonly input: { readonly definition: unknown };
}

const stored = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/contracts/vectors/evaluation-comparison-definition-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { readonly vectors: readonly StoredVector[] };
const first = stored.vectors[0];
if (!first) throw new Error("Comparison contract vector is unavailable");
const vector = ComparisonDefinitionSchema.parse(first.input.definition);

function exactEvidence() {
  const baseline = vector.baseline.fixtures[0];
  const candidate = vector.candidate.fixtures[0];
  if (!baseline || !candidate) throw new Error("Comparison contract vector fixtures are missing");
  const assessment = baseline.assessments[0];
  const modelAssuranceAssessment = baseline.modelAssuranceAssessments[0];
  if (!assessment || !modelAssuranceAssessment) {
    throw new Error("Comparison contract vector assurance references are missing");
  }
  return {
    assessment,
    baselineReplay: baseline.replay,
    candidateReplay: candidate.replay,
    dataset: vector.baseline.dataset,
    fixture: baseline.fixture,
    modelAssuranceAssessment,
  };
}

describe("Workflow 1 exact comparison definition", () => {
  it("binds distinct replay results to one shared retained evidence graph", () => {
    const result = createWorkflow1ComparisonDefinition("acceptance1", exactEvidence());

    expect(result).toMatchObject({
      comparisonId: "cmp_workflow1_acceptance1",
      comparisonVersionId: "cmpv_workflow1_acceptance1",
      resultId: "cmpr_workflow1_acceptance1",
      snapshotIds: {
        baseline: "cmps_baseline_acceptance1",
        candidate: "cmps_candidate_acceptance1",
      },
    });
    expect(result.request.baseline.dataset).toEqual(result.request.candidate.dataset);
    expect(result.request.baseline.fixtures[0]?.fixture).toEqual(
      result.request.candidate.fixtures[0]?.fixture,
    );
    expect(result.request.baseline.fixtures[0]?.replay).not.toEqual(
      result.request.candidate.fixtures[0]?.replay,
    );
    expect(result.request.metrics.map(({ metricId }) => metricId)).toEqual([
      "met_elapsed_acceptance1",
      "met_trace_acceptance1",
    ]);
  });

  it("rejects identical baseline and candidate subjects", () => {
    const evidence = exactEvidence();
    expect(() =>
      createWorkflow1ComparisonDefinition("identical", {
        ...evidence,
        candidateReplay: evidence.baselineReplay,
      }),
    ).toThrow();
  });

  it("rejects generated identifiers that exceed the public contract", () => {
    expect(() => createWorkflow1ComparisonDefinition("x".repeat(64), exactEvidence())).toThrow();
  });
});
