import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CreateModelAssuranceAssessmentRequestSchema,
  ModelAssuranceExecutionKindSchema,
  ModelAssuranceManagementKindSchema,
  ModelAssuranceRecordKindSchema,
  PublishModelAssuranceDefinitionRequestSchema,
  RecordHumanReviewRequestSchema,
  RecordModelAssuranceExecutionRequestSchema,
} from "./evaluation-model-assurance-api.js";

interface VectorDocument {
  readonly vectors: readonly {
    readonly input: { readonly definition: Record<string, unknown> };
  }[];
}

function definition(filename: string): Record<string, unknown> {
  const document = JSON.parse(
    readFileSync(new URL(`../vectors/${filename}`, import.meta.url), "utf8"),
  ) as VectorDocument;
  const vector = document.vectors[0];
  if (!vector) throw new Error(`Expected ${filename}`);
  return structuredClone(vector.input.definition);
}

const management = [
  ["blinded_evaluation_plan", "evaluation-blinded-plan-definition-v1.json"],
  ["calibration_report", "evaluation-calibration-definition-v1.json"],
  ["human_review_protocol", "evaluation-human-review-protocol-definition-v1.json"],
  ["human_reviewer_independence", "evaluation-human-reviewer-independence-definition-v1.json"],
  ["independence_declaration", "evaluation-independence-definition-v1.json"],
  ["model_assisted_evaluator", "evaluation-model-assisted-spec-definition-v1.json"],
  ["model_evaluator_profile", "evaluation-model-assurance-definition-v1.json"],
  ["model_qualification_suite", "evaluation-model-qualification-suite-definition-v1.json"],
] as const;

const execution = [
  ["blinded_evaluation_result", "evaluation-blinded-result-definition-v1.json"],
  ["independent_critique", "evaluation-independent-critique-definition-v1.json"],
  ["model_qualification_report", "evaluation-model-qualification-report-definition-v1.json"],
] as const;

describe("model assurance API contracts", () => {
  it("keeps exact management, execution, human, assessment, and read kind partitions", () => {
    expect(ModelAssuranceManagementKindSchema.options).toEqual(management.map(([kind]) => kind));
    expect(ModelAssuranceExecutionKindSchema.options).toEqual(execution.map(([kind]) => kind));
    expect(ModelAssuranceRecordKindSchema.options).toEqual([
      "blinded_evaluation_plan",
      "blinded_evaluation_result",
      "calibration_report",
      "human_review_protocol",
      "human_review_record",
      "human_reviewer_independence",
      "independence_declaration",
      "independent_critique",
      "model_assisted_evaluator",
      "model_assurance_assessment",
      "model_evaluator_profile",
      "model_qualification_report",
      "model_qualification_suite",
    ]);
  });

  it("accepts every strict management and model-execution definition", () => {
    for (const [kind, filename] of management) {
      expect(
        PublishModelAssuranceDefinitionRequestSchema.parse({
          definition: definition(filename),
          kind,
        }).kind,
      ).toBe(kind);
    }
    for (const [kind, filename] of execution) {
      expect(
        RecordModelAssuranceExecutionRequestSchema.parse({
          definition: definition(filename),
          kind,
        }).kind,
      ).toBe(kind);
    }
  });

  it("accepts human review and server-derived assessment input without receipt fields", () => {
    expect(
      RecordHumanReviewRequestSchema.parse({
        definition: definition("evaluation-human-review-record-definition-v1.json"),
        kind: "human_review_record",
      }).kind,
    ).toBe("human_review_record");

    const assessment = definition("evaluation-model-assurance-assessment-definition-v1.json");
    Reflect.deleteProperty(assessment, "eligibility");
    Reflect.deleteProperty(assessment, "evaluatedAt");
    Reflect.deleteProperty(assessment, "reasons");
    expect(
      CreateModelAssuranceAssessmentRequestSchema.parse({
        definition: assessment,
        kind: "model_assurance_assessment",
      }).kind,
    ).toBe("model_assurance_assessment");
  });

  it("rejects unknown fields, authority crossings, and caller-authored assessment outcomes", () => {
    expect(() =>
      PublishModelAssuranceDefinitionRequestSchema.parse({
        definition: definition("evaluation-independent-critique-definition-v1.json"),
        kind: "independent_critique",
      }),
    ).toThrow();
    expect(() =>
      RecordHumanReviewRequestSchema.parse({
        definition: {
          ...definition("evaluation-human-review-record-definition-v1.json"),
          releaseAuthority: "allow",
        },
        kind: "human_review_record",
      }),
    ).toThrow();
    expect(() =>
      CreateModelAssuranceAssessmentRequestSchema.parse({
        definition: {
          ...definition("evaluation-model-assurance-assessment-definition-v1.json"),
          eligibility: "eligible",
        },
        kind: "model_assurance_assessment",
      }),
    ).toThrow();
  });
});
