import { z } from "zod";
import { ApplicabilityContextSchema } from "./evaluation-criteria.js";
import { OpaqueIdSchema, UtcMillisecondTimestampSchema } from "./primitives.js";

export const MAX_CRITERIA_TRUST_QUALIFICATION_REPORTS = 128;

export const CRITERIA_TRUST_REASONS = [
  "criterion_not_approved",
  "criterion_status_not_current",
  "criterion_status_unavailable",
  "qualification_evidence_unavailable",
  "qualification_fixture_not_independent",
  "qualification_fixture_mismatch",
  "qualification_fixture_set_unavailable",
  "qualification_not_current",
  "qualification_not_independent",
  "qualification_reference_mismatch",
  "qualification_report_unavailable",
  "qualification_unqualified",
  "requester_only_review",
  "reviewer_qualification_evidence_unavailable",
  "reviewer_qualification_not_independent",
  "reviewer_qualification_not_current",
  "reviewer_qualification_reference_mismatch",
  "reviewer_qualification_scope_mismatch",
  "reviewer_qualification_source_kind_mismatch",
  "reviewer_qualification_unavailable",
  "reviewer_qualification_unverifiable",
  "reviewer_unqualified",
  "source_applicability_not_approved",
  "source_authority_not_accepted",
  "source_conflict_review_incomplete",
  "source_conflict_unresolved",
  "source_content_unavailable",
  "source_identity_disputed",
  "source_identity_evidence_unavailable",
  "source_identity_not_current",
  "source_identity_not_independent",
  "source_identity_unverified",
  "source_license_unusable",
  "source_not_current",
  "source_not_effective",
  "source_reference_mismatch",
  "source_review_basis_unavailable",
  "source_review_not_current",
  "source_review_relationship_disclosed",
  "source_review_requires_approval",
  "source_review_unavailable",
  "source_review_unverifiable",
  "source_scope_mismatch",
  "source_snapshot_unavailable",
] as const;

export const CriteriaTrustReasonSchema = z.enum(CRITERIA_TRUST_REASONS);
export const CriteriaTrustStatusSchema = z.enum([
  "eligible",
  "ineligible",
  "require_approval",
  "unverifiable",
]);

function strictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

export const EvaluateCriteriaTrustRequestSchema = z
  .object({
    context: ApplicabilityContextSchema,
    criterionStatusRecordId: OpaqueIdSchema,
    qualificationReportIds: z
      .array(OpaqueIdSchema)
      .max(MAX_CRITERIA_TRUST_QUALIFICATION_REPORTS)
      .refine((values) => new Set(values).size === values.length, {
        message: "Qualification report identifiers must be unique",
      }),
  })
  .strict();

export const CriteriaTrustEvaluationSchema = z
  .object({
    evaluatedAt: UtcMillisecondTimestampSchema,
    reasons: z
      .array(CriteriaTrustReasonSchema)
      .max(CRITERIA_TRUST_REASONS.length)
      .refine(strictlySortedUnique, {
        message: "Criteria-trust reasons must be unique and ordered",
      }),
    status: CriteriaTrustStatusSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.status === "eligible") !== (value.reasons.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "Eligible criteria trust requires no adverse reasons and vice versa",
        path: ["status"],
      });
    }
  });

export type CriteriaTrustEvaluation = z.infer<typeof CriteriaTrustEvaluationSchema>;
export type CriteriaTrustReason = z.infer<typeof CriteriaTrustReasonSchema>;
export type CriteriaTrustStatus = z.infer<typeof CriteriaTrustStatusSchema>;
export type EvaluateCriteriaTrustRequest = z.infer<typeof EvaluateCriteriaTrustRequestSchema>;
