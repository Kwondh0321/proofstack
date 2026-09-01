import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { EvidenceScopeSchema, evidenceTimestampOrderKey } from "./evidence.js";
import { AssessmentReferenceSchema } from "./evaluation-assessment.js";
import { EvaluationRiskTierSchema, OracleReferenceSchema } from "./evaluation-criteria.js";
import {
  BlindedEvaluationPlanReferenceSchema,
  BlindedEvaluationResultReferenceSchema,
  CalibrationReportReferenceSchema,
  HumanReviewProtocolReferenceSchema,
  HumanReviewRecordReferenceSchema,
  IndependenceDeclarationReferenceSchema,
  IndependentCritiqueReferenceSchema,
} from "./evaluation-model-assurance.js";
import { ModelQualificationReportReferenceSchema } from "./evaluation-model-qualification.js";
import { RawObservationReferenceSchema } from "./evaluation-run.js";
import { AssuranceSummarySchema } from "./evaluation-source.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";

export const MODEL_ASSURANCE_ASSESSMENT_SCHEMA_VERSION = "0.1" as const;

function isStrictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function exactArtifacts(minimum: number, maximum: number, label: string) {
  return z
    .array(ArtifactContentReferenceSchema)
    .min(minimum)
    .max(maximum)
    .refine(
      (references) =>
        isStrictlySortedUnique(
          references.map(({ artifactId, sha256 }) => `${artifactId}:${sha256}`),
        ),
      { message: `${label} must be unique and ordered by exact artifact reference` },
    );
}

export const ModelAssuranceIneligibilityReasonSchema = z.enum([
  "base_assessment_ineligible",
  "blind_incomplete",
  "blind_invalid",
  "calibration_incompatible",
  "calibration_stale",
  "calibration_unavailable",
  "critical_counterevidence",
  "human_review_conflicted",
  "human_review_expired",
  "human_review_missing",
  "human_review_protocol_mismatch",
  "human_review_quorum_shortfall",
  "independence_correlated",
  "independence_unverified",
  "injection_qualification_failed",
  "model_qualification_stale",
  "model_qualification_unqualified",
  "non_model_evidence_missing",
  "order_sensitive_result",
  "source_stale",
  "unresolved_disagreement",
]);

export const ModelAssuranceAssessmentReferenceSchema = z
  .object({
    assessmentExtensionId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
  })
  .strict();

const modelAssuranceAssessmentDefinitionShape = {
  assessmentExtensionId: OpaqueIdSchema,
  baseAssessment: AssessmentReferenceSchema,
  blindedPlan: BlindedEvaluationPlanReferenceSchema,
  blindedResult: BlindedEvaluationResultReferenceSchema,
  calibrationReport: CalibrationReportReferenceSchema,
  counterevidence: exactArtifacts(0, 64, "Model assurance counterevidence"),
  critiques: z
    .array(IndependentCritiqueReferenceSchema)
    .min(1)
    .max(32)
    .refine(
      (references) =>
        isStrictlySortedUnique(
          references.map(({ critiqueId, definitionSha256 }) => `${critiqueId}:${definitionSha256}`),
        ),
      { message: "Model assurance critiques must be unique and ordered by exact reference" },
    ),
  disagreementEvidence: exactArtifacts(0, 64, "Model assurance disagreement evidence"),
  eligibility: z.enum(["eligible", "ineligible"]),
  evaluatedAt: UtcMillisecondTimestampSchema,
  humanReviewProtocol: HumanReviewProtocolReferenceSchema,
  humanReviews: z
    .array(HumanReviewRecordReferenceSchema)
    .max(64)
    .refine(
      (references) =>
        isStrictlySortedUnique(
          references.map(({ reviewId, definitionSha256 }) => `${reviewId}:${definitionSha256}`),
        ),
      { message: "Human reviews must be unique and ordered by exact reference" },
    ),
  independenceDeclarations: z
    .array(IndependenceDeclarationReferenceSchema)
    .min(2)
    .max(64)
    .refine(
      (references) =>
        isStrictlySortedUnique(
          references.map(
            ({ independenceDeclarationId, definitionSha256 }) =>
              `${independenceDeclarationId}:${definitionSha256}`,
          ),
        ),
      { message: "Independence declarations must be unique and ordered by exact reference" },
    ),
  knownLimitations: z.array(AssuranceSummarySchema).max(64).refine(isStrictlySortedUnique, {
    message: "Model assurance assessment limitations must be unique and ordered",
  }),
  modelQualificationReport: ModelQualificationReportReferenceSchema,
  nonModelEvidence: z
    .object({
      observations: z
        .array(RawObservationReferenceSchema)
        .min(1)
        .max(64)
        .refine(
          (references) =>
            isStrictlySortedUnique(
              references.map(
                ({ observationId, definitionSha256 }) => `${observationId}:${definitionSha256}`,
              ),
            ),
          { message: "Non-model observations must be unique and ordered by exact reference" },
        ),
      oracles: z
        .array(OracleReferenceSchema)
        .min(1)
        .max(32)
        .refine(
          (references) =>
            isStrictlySortedUnique(
              references.map(({ oracleId, oracleVersionId }) => `${oracleId}:${oracleVersionId}`),
            ),
          { message: "Non-model oracles must be unique and ordered" },
        ),
    })
    .strict(),
  policy: ArtifactContentReferenceSchema,
  reasons: z
    .array(ModelAssuranceIneligibilityReasonSchema)
    .max(ModelAssuranceIneligibilityReasonSchema.options.length)
    .refine(isStrictlySortedUnique, {
      message: "Model assurance reasons must be unique and ordered",
    }),
  riskTier: EvaluationRiskTierSchema,
  validUntil: UtcMillisecondTimestampSchema,
};

function refineModelAssuranceAssessment(
  value: {
    readonly eligibility: "eligible" | "ineligible";
    readonly evaluatedAt: string;
    readonly humanReviews: readonly unknown[];
    readonly reasons: readonly string[];
    readonly riskTier: "critical" | "high" | "low" | "moderate";
    readonly validUntil: string;
  },
  context: z.RefinementCtx,
): void {
  if (value.eligibility === "eligible" && value.reasons.length > 0) {
    context.addIssue({
      code: "custom",
      message: "Eligible model assurance assessments cannot contain ineligibility reasons",
      path: ["reasons"],
    });
  }
  if (value.eligibility === "ineligible" && value.reasons.length === 0) {
    context.addIssue({
      code: "custom",
      message: "Ineligible model assurance assessments require at least one reason",
      path: ["reasons"],
    });
  }
  if (
    (value.riskTier === "high" || value.riskTier === "critical") &&
    value.humanReviews.length === 0
  ) {
    context.addIssue({
      code: "custom",
      message: "High-risk model assurance requires at least one human review",
      path: ["humanReviews"],
    });
  }
  if (evidenceTimestampOrderKey(value.validUntil) <= evidenceTimestampOrderKey(value.evaluatedAt)) {
    context.addIssue({
      code: "custom",
      message: "Model assurance assessment validity must follow evaluation",
      path: ["validUntil"],
    });
  }
}

export const ModelAssuranceAssessmentDefinitionSchema = z
  .object(modelAssuranceAssessmentDefinitionShape)
  .strict()
  .superRefine(refineModelAssuranceAssessment);

export const ModelAssuranceAssessmentSchema = z
  .object({
    ...modelAssuranceAssessmentDefinitionShape,
    definitionSha256: Sha256Schema,
    recordedAt: UtcMillisecondTimestampSchema,
    schemaVersion: z.literal(MODEL_ASSURANCE_ASSESSMENT_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineModelAssuranceAssessment);

export type ModelAssuranceIneligibilityReason = z.infer<
  typeof ModelAssuranceIneligibilityReasonSchema
>;
export type ModelAssuranceAssessmentReference = z.infer<
  typeof ModelAssuranceAssessmentReferenceSchema
>;
export type ModelAssuranceAssessmentDefinition = z.infer<
  typeof ModelAssuranceAssessmentDefinitionSchema
>;
export type ModelAssuranceAssessment = z.infer<typeof ModelAssuranceAssessmentSchema>;
