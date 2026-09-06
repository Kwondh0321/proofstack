import { describe, expect, it } from "vitest";
import { EvaluateCriteriaTrustResponseSchema } from "./evaluation-api.js";
import {
  CriteriaTrustEvaluationSchema,
  EvaluateCriteriaTrustRequestSchema,
  MAX_CRITERIA_TRUST_QUALIFICATION_REPORTS,
} from "./evaluation-criteria-trust.js";

const request = {
  context: {
    environmentId: "env_local",
    jurisdiction: "kr",
    locale: "ko-kr",
    populationTags: ["adult users"],
    riskTier: "high",
    taskKind: "task_support",
  },
  criterionStatusRecordId: "csr_approved",
  qualificationReportIds: ["qlr_evaluator", "qlr_oracle"],
} as const;

const evaluation = {
  evaluatedAt: "2026-09-02T00:01:00.000Z",
  reasons: [] as const,
  status: "eligible" as const,
};

describe("criteria trust API contracts", () => {
  it("accepts selectors and applicability context without caller-authored trust fields", () => {
    expect(EvaluateCriteriaTrustRequestSchema.parse(request)).toEqual(request);
    expect(
      EvaluateCriteriaTrustRequestSchema.safeParse({ ...request, status: "eligible" }).success,
    ).toBe(false);
    expect(EvaluateCriteriaTrustRequestSchema.safeParse({ ...request, sources: [] }).success).toBe(
      false,
    );
  });

  it("rejects duplicate, invalid, and unbounded qualification report selections", () => {
    expect(
      EvaluateCriteriaTrustRequestSchema.safeParse({
        ...request,
        qualificationReportIds: ["qlr_evaluator", "qlr_evaluator"],
      }).success,
    ).toBe(false);
    expect(
      EvaluateCriteriaTrustRequestSchema.safeParse({
        ...request,
        qualificationReportIds: ["invalid id"],
      }).success,
    ).toBe(false);
    expect(
      EvaluateCriteriaTrustRequestSchema.safeParse({
        ...request,
        qualificationReportIds: Array.from(
          { length: MAX_CRITERIA_TRUST_QUALIFICATION_REPORTS + 1 },
          (_, index) => `qlr_${index}`,
        ),
      }).success,
    ).toBe(false);
  });

  it("requires canonical, unique reasons and a status consistent with an empty decision", () => {
    expect(CriteriaTrustEvaluationSchema.parse(evaluation)).toEqual(evaluation);
    expect(
      CriteriaTrustEvaluationSchema.safeParse({
        ...evaluation,
        reasons: ["source_scope_mismatch", "criterion_not_approved"],
        status: "ineligible",
      }).success,
    ).toBe(false);
    expect(
      CriteriaTrustEvaluationSchema.safeParse({
        ...evaluation,
        reasons: ["criterion_not_approved", "criterion_not_approved"],
        status: "ineligible",
      }).success,
    ).toBe(false);
    expect(
      CriteriaTrustEvaluationSchema.safeParse({ ...evaluation, status: "unverifiable" }).success,
    ).toBe(false);
    expect(
      CriteriaTrustEvaluationSchema.safeParse({
        ...evaluation,
        reasons: ["criterion_not_approved"],
      }).success,
    ).toBe(false);
  });

  it("wraps the derived decision in an authenticated request response", () => {
    expect(
      EvaluateCriteriaTrustResponseSchema.parse({
        requestId: "req_criteria_trust",
        result: evaluation,
      }),
    ).toEqual({ requestId: "req_criteria_trust", result: evaluation });
  });
});
