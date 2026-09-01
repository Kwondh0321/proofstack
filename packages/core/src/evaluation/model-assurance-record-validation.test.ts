import { readFileSync } from "node:fs";
import type { EvidenceScope } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  digestModelAssuranceRecordDefinition,
  modelAssuranceRecordId,
  validateModelAssuranceRecord,
} from "./model-assurance-record-validation.js";
import {
  InvalidModelAssuranceRecordInputError,
  type ModelAssuranceRecord,
  type ModelAssuranceRecordKind,
} from "./model-assurance-repository.js";

interface PublicVector {
  readonly input: { readonly definition: Record<string, unknown>; readonly scope: EvidenceScope };
  readonly sha256: string;
}

interface ValidationCase {
  readonly expectedId: string;
  readonly filename: string;
  readonly kind: ModelAssuranceRecordKind;
  readonly receipt: Readonly<Record<string, unknown>>;
}

const publishedBy = { publishedByPrincipalId: "usr_assurance_publisher" } as const;
const recordedBy = { recordedByPrincipalId: "usr_assurance_recorder" } as const;
const cases: readonly ValidationCase[] = [
  {
    expectedId: "mpv_safety_v1",
    filename: "evaluation-model-assurance-definition-v1.json",
    kind: "model_evaluator_profile",
    receipt: { publishedAt: "2026-09-01T23:59:59.000Z", ...publishedBy },
  },
  {
    expectedId: "evv_model_safety_v1",
    filename: "evaluation-model-assisted-spec-definition-v1.json",
    kind: "model_assisted_evaluator",
    receipt: { publishedAt: "2026-09-02T00:04:59.000Z", ...publishedBy },
  },
  {
    expectedId: "ind_model_safety_v1",
    filename: "evaluation-independence-definition-v1.json",
    kind: "independence_declaration",
    receipt: { recordedAt: "2026-09-02T00:10:01.000Z" },
  },
  {
    expectedId: "cal_model_safety_v1",
    filename: "evaluation-calibration-definition-v1.json",
    kind: "calibration_report",
    receipt: { recordedAt: "2026-09-02T00:20:01.000Z" },
  },
  {
    expectedId: "blv_safety_v1",
    filename: "evaluation-blinded-plan-definition-v1.json",
    kind: "blinded_evaluation_plan",
    receipt: { publishedAt: "2026-09-02T00:29:59.000Z", ...publishedBy },
  },
  {
    expectedId: "blr_safety_v1",
    filename: "evaluation-blinded-result-definition-v1.json",
    kind: "blinded_evaluation_result",
    receipt: { recordedAt: "2026-09-02T00:45:02.000Z", ...recordedBy },
  },
  {
    expectedId: "crq_observation_safety_v1",
    filename: "evaluation-independent-critique-definition-v1.json",
    kind: "independent_critique",
    receipt: { recordedAt: "2026-09-02T01:01:01.000Z", ...recordedBy },
  },
  {
    expectedId: "hrv_agent_safety_v1",
    filename: "evaluation-human-review-protocol-definition-v1.json",
    kind: "human_review_protocol",
    receipt: { publishedAt: "2026-09-02T01:59:59.000Z", ...publishedBy },
  },
  {
    expectedId: "hri_reviewer_v1",
    filename: "evaluation-human-reviewer-independence-definition-v1.json",
    kind: "human_reviewer_independence",
    receipt: { recordedAt: "2026-09-02T02:30:01.000Z" },
  },
  {
    expectedId: "hrr_agent_safety_reviewer_one",
    filename: "evaluation-human-review-record-definition-v1.json",
    kind: "human_review_record",
    receipt: { recordedAt: "2026-09-02T03:20:01.000Z" },
  },
  {
    expectedId: "mqv_model_safety_v1",
    filename: "evaluation-model-qualification-suite-definition-v1.json",
    kind: "model_qualification_suite",
    receipt: { publishedAt: "2026-09-02T03:59:59.000Z", ...publishedBy },
  },
  {
    expectedId: "mqr_model_safety_v1",
    filename: "evaluation-model-qualification-report-definition-v1.json",
    kind: "model_qualification_report",
    receipt: { recordedAt: "2026-09-02T05:30:01.000Z" },
  },
  {
    expectedId: "maa_agent_safety_v1",
    filename: "evaluation-model-assurance-assessment-definition-v1.json",
    kind: "model_assurance_assessment",
    receipt: { recordedAt: "2026-09-02T06:00:01.000Z" },
  },
] as const;

function publicVector(filename: string): PublicVector {
  const document = JSON.parse(
    readFileSync(new URL(`../../../contracts/vectors/${filename}`, import.meta.url), "utf8"),
  ) as { readonly vectors: readonly PublicVector[] };
  const value = document.vectors[0];
  if (!value) throw new Error(`Expected vector ${filename}`);
  return value;
}

function candidate(value: ValidationCase): ModelAssuranceRecord {
  const vector = publicVector(value.filename);
  return {
    ...structuredClone(vector.input.definition),
    ...value.receipt,
    definitionSha256: vector.sha256,
    schemaVersion: "0.1",
    scope: structuredClone(vector.input.scope),
  } as ModelAssuranceRecord;
}

describe("model assurance record validation", () => {
  it("accepts every fixed public vector with its receipt metadata and exact id", () => {
    for (const value of cases) {
      const record = candidate(value);
      expect(validateModelAssuranceRecord(value.kind, record)).toEqual(record);
      expect(modelAssuranceRecordId(value.kind, record)).toBe(value.expectedId);
    }
  });

  it("recomputes every canonical digest from definition and scope", () => {
    for (const value of cases) {
      const vector = publicVector(value.filename);
      expect(
        digestModelAssuranceRecordDefinition(
          value.kind,
          vector.input.scope,
          vector.input.definition,
        ),
      ).toBe(vector.sha256);
    }
  });

  it("rejects schema-valid records with a forged definition digest", () => {
    for (const value of cases) {
      const record = candidate(value);
      record.definitionSha256 = "0".repeat(64);
      expect(() => validateModelAssuranceRecord(value.kind, record)).toThrow(
        InvalidModelAssuranceRecordInputError,
      );
    }
  });

  it("rejects malformed records and owns the parsed value", () => {
    expect(() => validateModelAssuranceRecord("calibration_report", {})).toThrow(
      InvalidModelAssuranceRecordInputError,
    );

    const value = cases[0];
    if (!value) throw new Error("Expected a validation case");
    const record = candidate(value);
    const validated = validateModelAssuranceRecord(value.kind, record);
    record.scope.environmentId = "env_mutated";
    expect(validated.scope.environmentId).not.toBe("env_mutated");
  });
});
