import { z } from "zod";
import { OpaqueIdSchema } from "./primitives.js";
import {
  AssessmentReferenceSchema,
  EvaluationAggregateReferenceSchema,
} from "./evaluation-assessment.js";
import {
  ComparisonDefinitionReferenceSchema,
  ComparisonEvidenceSnapshotReferenceSchema,
} from "./evaluation-comparison.js";
import {
  CriterionSetReferenceSchema,
  CriterionSetStatusReferenceSchema,
  EvaluatorReferenceSchema,
  OracleReferenceSchema,
} from "./evaluation-criteria.js";
import { ModelAssuranceAssessmentReferenceSchema } from "./evaluation-model-assessment.js";
import {
  BlindedEvaluationPlanReferenceSchema,
  BlindedEvaluationResultReferenceSchema,
  CalibrationReportReferenceSchema,
  HumanReviewProtocolReferenceSchema,
  HumanReviewRecordReferenceSchema,
  HumanReviewerIndependenceReferenceSchema,
  IndependenceDeclarationReferenceSchema,
  IndependentCritiqueReferenceSchema,
  ModelEvaluatorProfileReferenceSchema,
  ModelQualificationReportReferenceSchema,
} from "./evaluation-model-assurance.js";
import { ModelQualificationSuiteReferenceSchema } from "./evaluation-model-qualification.js";
import {
  EvaluationAggregationPolicyReferenceSchema,
  EvaluationDatasetVersionReferenceSchema,
  EvaluationRunRejectionSchema,
  EvaluationRunReferenceSchema,
  EvaluationRunResultReferenceSchema,
  RawObservationReferenceSchema,
  EvaluationReplayResultReferenceSchema,
} from "./evaluation-run.js";
import {
  DiscoveryRecordSchema,
  SourceReferenceSchema,
  SourceReviewReferenceSchema,
  SourceReviewerQualificationReferenceSchema,
} from "./evaluation-source.js";
import {
  QualificationFixtureSetReferenceSchema,
  QualificationReportReferenceSchema,
} from "./evaluation-spec.js";
import { RegressionFixtureVersionReferenceSchema } from "./dataset.js";
import {
  ReleaseCandidateReferenceSchema,
  ReleaseCandidateComparisonReferenceSchema,
  ReleaseCandidateAdapterReferenceSchema,
} from "./release-candidate.js";
import {
  ReleasePolicyReferenceSchema,
  PolicyInstallationBindingReferenceSchema,
} from "./release-policy.js";
import { ReplayPlanJobReferenceSchema } from "./replay-job.js";
import {
  TargetReleaseReferenceSchema,
  ReplayRuntimeProfileReferenceSchema,
  ReplayIsolationProfileReferenceSchema,
} from "./replay-plan.js";

/** Exact immutable source references; artifact observations and lifecycle guards are separate. */
export const PolicyEvaluationSourceReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("aggregation_policy"),
      reference: EvaluationAggregationPolicyReferenceSchema,
    })
    .strict(),
  z.object({ kind: z.literal("assessment"), reference: AssessmentReferenceSchema }).strict(),
  z
    .object({
      kind: z.literal("discovery_record"),
      reference: z
        .object({
          discoveryId: DiscoveryRecordSchema.shape.discoveryId,
          definitionSha256: DiscoveryRecordSchema.shape.definitionSha256,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("evaluation_run_rejection"),
      reference: z
        .object({
          rejectionId: EvaluationRunRejectionSchema.shape.rejectionId,
          definitionSha256: EvaluationRunRejectionSchema.shape.definitionSha256,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("model_assisted_evaluator_spec"),
      reference: EvaluatorReferenceSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("blinded_plan"), reference: BlindedEvaluationPlanReferenceSchema })
    .strict(),
  z
    .object({
      kind: z.literal("blinded_result"),
      reference: BlindedEvaluationResultReferenceSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("calibration_report"), reference: CalibrationReportReferenceSchema })
    .strict(),
  z
    .object({
      kind: z.literal("comparison_definition"),
      reference: ComparisonDefinitionReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("comparison_result"),
      reference: ReleaseCandidateComparisonReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("comparison_snapshot"),
      reference: ComparisonEvidenceSnapshotReferenceSchema,
    })
    .strict(),
  z.object({ kind: z.literal("criterion_set"), reference: CriterionSetReferenceSchema }).strict(),
  z
    .object({
      kind: z.literal("criterion_set_status"),
      reference: CriterionSetStatusReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("dataset_version"),
      reference: EvaluationDatasetVersionReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("evaluation_aggregate"),
      reference: EvaluationAggregateReferenceSchema,
    })
    .strict(),
  z.object({ kind: z.literal("evaluation_run"), reference: EvaluationRunReferenceSchema }).strict(),
  z
    .object({
      kind: z.literal("evaluation_run_result"),
      reference: EvaluationRunResultReferenceSchema,
    })
    .strict(),
  z.object({ kind: z.literal("evaluator_spec"), reference: EvaluatorReferenceSchema }).strict(),
  z
    .object({
      kind: z.literal("human_review_protocol"),
      reference: HumanReviewProtocolReferenceSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("human_review_record"), reference: HumanReviewRecordReferenceSchema })
    .strict(),
  z
    .object({
      kind: z.literal("human_reviewer_independence"),
      reference: HumanReviewerIndependenceReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("independence_declaration"),
      reference: IndependenceDeclarationReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("independent_critique"),
      reference: IndependentCritiqueReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("model_assurance_assessment"),
      reference: ModelAssuranceAssessmentReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("model_evaluator_profile"),
      reference: ModelEvaluatorProfileReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("model_qualification_report"),
      reference: ModelQualificationReportReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("model_qualification_suite"),
      reference: ModelQualificationSuiteReferenceSchema,
    })
    .strict(),
  z.object({ kind: z.literal("oracle_spec"), reference: OracleReferenceSchema }).strict(),
  z
    .object({
      kind: z.literal("policy_installation_binding"),
      reference: PolicyInstallationBindingReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("qualification_fixture_set"),
      reference: QualificationFixtureSetReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("qualification_report"),
      reference: QualificationReportReferenceSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("raw_observation"), reference: RawObservationReferenceSchema })
    .strict(),
  z
    .object({
      kind: z.literal("regression_fixture_version"),
      reference: RegressionFixtureVersionReferenceSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("release_candidate"), reference: ReleaseCandidateReferenceSchema })
    .strict(),
  z.object({ kind: z.literal("release_policy"), reference: ReleasePolicyReferenceSchema }).strict(),
  z
    .object({
      kind: z.literal("replay_isolation_profile"),
      reference: ReplayIsolationProfileReferenceSchema,
    })
    .strict(),
  z.object({ kind: z.literal("replay_plan"), reference: ReplayPlanJobReferenceSchema }).strict(),
  z
    .object({ kind: z.literal("replay_result"), reference: EvaluationReplayResultReferenceSchema })
    .strict(),
  z
    .object({
      kind: z.literal("replay_runtime_profile"),
      reference: ReplayRuntimeProfileReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("runtime_adapter"),
      reference: ReleaseCandidateAdapterReferenceSchema,
    })
    .strict(),
  z.object({ kind: z.literal("source_review"), reference: SourceReviewReferenceSchema }).strict(),
  z
    .object({
      kind: z.literal("source_reviewer_qualification"),
      reference: SourceReviewerQualificationReferenceSchema,
    })
    .strict(),
  z.object({ kind: z.literal("source_snapshot"), reference: SourceReferenceSchema }).strict(),
  z.object({ kind: z.literal("target_release"), reference: TargetReleaseReferenceSchema }).strict(),
]);

export type PolicyEvaluationSourceReference = z.infer<typeof PolicyEvaluationSourceReferenceSchema>;

/**
 * Repository identity, deliberately excluding digests and redundant logical IDs. Changing a
 * digest, parent ID, or comparison role under one record identity is a conflict, not a new entry.
 * Runtime/isolation profiles use their existing (id, version) repository identity.
 */
export function policyEvaluationSourceReferenceKey(value: PolicyEvaluationSourceReference): string {
  switch (value.kind) {
    case "discovery_record":
      return `${value.kind}:${value.reference.discoveryId}`;
    case "evaluation_run_rejection":
      return `${value.kind}:${value.reference.rejectionId}`;
    case "model_assisted_evaluator_spec":
      return `${value.kind}:${value.reference.evaluatorVersionId}`;
    case "aggregation_policy":
      return `${value.kind}:${value.reference.policyVersionId}`;
    case "assessment":
      return `${value.kind}:${value.reference.assessmentId}`;
    case "blinded_plan":
      return `${value.kind}:${value.reference.blindedPlanVersionId}`;
    case "blinded_result":
      return `${value.kind}:${value.reference.resultId}`;
    case "calibration_report":
      return `${value.kind}:${value.reference.calibrationReportId}`;
    case "comparison_definition":
      return `${value.kind}:${value.reference.comparisonVersionId}`;
    case "comparison_result":
      return `${value.kind}:${value.reference.resultId}`;
    case "comparison_snapshot":
      return `${value.kind}:${value.reference.snapshotId}`;
    case "criterion_set":
      return `${value.kind}:${value.reference.criterionSetVersionId}`;
    case "criterion_set_status":
      return `${value.kind}:${value.reference.statusRecordId}`;
    case "dataset_version":
      return `${value.kind}:${value.reference.datasetVersionId}`;
    case "evaluation_aggregate":
      return `${value.kind}:${value.reference.aggregateId}`;
    case "evaluation_run":
      return `${value.kind}:${value.reference.evaluationRunId}`;
    case "evaluation_run_result":
      return `${value.kind}:${value.reference.resultId}`;
    case "evaluator_spec":
      return `${value.kind}:${value.reference.evaluatorVersionId}`;
    case "human_review_protocol":
      return `${value.kind}:${value.reference.protocolVersionId}`;
    case "human_review_record":
      return `${value.kind}:${value.reference.reviewId}`;
    case "human_reviewer_independence":
      return `${value.kind}:${value.reference.declarationId}`;
    case "independence_declaration":
      return `${value.kind}:${value.reference.independenceDeclarationId}`;
    case "independent_critique":
      return `${value.kind}:${value.reference.critiqueId}`;
    case "model_assurance_assessment":
      return `${value.kind}:${value.reference.assessmentExtensionId}`;
    case "model_evaluator_profile":
      return `${value.kind}:${value.reference.modelProfileVersionId}`;
    case "model_qualification_report":
      return `${value.kind}:${value.reference.reportId}`;
    case "model_qualification_suite":
      return `${value.kind}:${value.reference.suiteVersionId}`;
    case "oracle_spec":
      return `${value.kind}:${value.reference.oracleVersionId}`;
    case "policy_installation_binding":
      return `${value.kind}:${value.reference.bindingVersionId}`;
    case "qualification_fixture_set":
      return `${value.kind}:${value.reference.fixtureSetVersionId}`;
    case "qualification_report":
      return `${value.kind}:${value.reference.qualificationReportId}`;
    case "raw_observation":
      return `${value.kind}:${value.reference.observationId}`;
    case "regression_fixture_version":
      return `${value.kind}:${value.reference.fixtureVersionId}`;
    case "release_candidate":
      return `${value.kind}:${value.reference.candidateVersionId}`;
    case "release_policy":
      return `${value.kind}:${value.reference.policyVersionId}`;
    case "replay_isolation_profile":
      return `${value.kind}:${value.reference.id}:${value.reference.version}`;
    case "replay_plan":
      return `${value.kind}:${value.reference.planVersionId}`;
    case "replay_result":
      return `${value.kind}:${value.reference.attemptId}`;
    case "replay_runtime_profile":
      return `${value.kind}:${value.reference.id}:${value.reference.version}`;
    case "runtime_adapter":
      return `${value.kind}:${value.reference.adapterVersionId}`;
    case "source_review":
      return `${value.kind}:${value.reference.sourceReviewId}`;
    case "source_reviewer_qualification":
      return `${value.kind}:${value.reference.qualificationId}`;
    case "source_snapshot":
      return `${value.kind}:${value.reference.sourceSnapshotId}`;
    case "target_release":
      return `${value.kind}:${value.reference.targetReleaseId}`;
  }
}

/** ASCII keys ordered by code units, never by locale or a digest. */
export const PolicyEvaluationSourceKeySchema = z
  .string()
  .min(7)
  .max(160)
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const [kind, id, version, ...extra] = value.split(":");
    const knownKind = PolicyEvaluationSourceReferenceSchema.options.some(
      (schema) => schema.shape.kind.value === kind,
    );
    const profile = kind === "replay_runtime_profile" || kind === "replay_isolation_profile";
    if (
      !knownKind ||
      !OpaqueIdSchema.safeParse(id).success ||
      extra.length > 0 ||
      (profile
        ? !ReplayRuntimeProfileReferenceSchema.shape.version.safeParse(version).success
        : version !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Expected an exact registered source repository identity",
      });
    }
  });
