import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MODEL_ASSURANCE_ASSESSMENT_SCHEMA_VERSION,
  type ModelAssuranceAssessmentDefinition,
} from "./evaluation-model-assessment.js";
import {
  encodeModelAssuranceAssessmentDefinition,
  MODEL_ASSURANCE_ASSESSMENT_DEFINITION_DOMAIN,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";

interface AssessmentVector {
  readonly encodedByteLength: number;
  readonly input: ScopedEvaluationDefinition<ModelAssuranceAssessmentDefinition>;
  readonly kind: "model_assurance_assessment";
  readonly name: string;
  readonly sha256: string;
}

interface VectorDocument {
  readonly format: string;
  readonly vectors: readonly AssessmentVector[];
}

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/evaluation-model-assurance-assessment-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as VectorDocument;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function vector(): AssessmentVector {
  const value = document.vectors[0];
  if (!value) throw new Error("Expected a model assurance assessment vector");
  return value;
}

describe("canonical model assurance assessment encoding", () => {
  it("matches the fixed public UTF-8 and SHA-256 vector", () => {
    expect(document.format).toBe("proofstack.evaluation-model-assurance-assessment-definition.v1");
    expect(document.vectors.map(({ kind }) => kind)).toEqual(["model_assurance_assessment"]);
    const value = vector();
    const encoded = encodeModelAssuranceAssessmentDefinition(value.input);
    expect(encoded.byteLength).toBe(value.encodedByteLength);
    expect(sha256(encoded)).toBe(value.sha256);
  });

  it("binds every assurance layer while excluding approval and release authority", () => {
    const value = vector();
    const original = encodeModelAssuranceAssessmentDefinition(value.input);
    const text = Buffer.from(original).toString("utf8");
    expect(text).toContain(MODEL_ASSURANCE_ASSESSMENT_DEFINITION_DOMAIN);
    expect(text).toContain(`"schemaVersion":"${MODEL_ASSURANCE_ASSESSMENT_SCHEMA_VERSION}"`);

    const mutations: ((candidate: AssessmentVector["input"]) => void)[] = [
      (candidate) => {
        candidate.scope.tenantId = "ten_other";
      },
      (candidate) => {
        candidate.definition.modelQualificationReport.definitionSha256 = "0".repeat(64);
      },
      (candidate) => {
        candidate.definition.calibrationReport.definitionSha256 = "1".repeat(64);
      },
      (candidate) => {
        const review = candidate.definition.humanReviews[0];
        if (!review) throw new Error("Expected human review");
        review.definitionSha256 = "2".repeat(64);
      },
      (candidate) => {
        candidate.definition.policy.sha256 = "3".repeat(64);
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(value.input);
      mutate(changed);
      expect(encodeModelAssuranceAssessmentDefinition(changed)).not.toEqual(original);
    }
  });
});
