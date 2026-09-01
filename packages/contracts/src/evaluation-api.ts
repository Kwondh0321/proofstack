import { z } from "zod";
import { RequestIdSchema } from "./api.js";
import {
  AssessmentDefinitionSchema,
  AssessmentSchema,
  EvaluationAggregateDefinitionSchema,
  EvaluationAggregateSchema,
  EvaluationAggregationPolicyDefinitionSchema,
  EvaluationAggregationPolicySchema,
} from "./evaluation-assessment.js";
import {
  CriterionSetDefinitionSchema,
  CriterionSetSchema,
  CriterionSetStatusDefinitionSchema,
  CriterionSetStatusRecordSchema,
} from "./evaluation-criteria.js";
import {
  EvaluationRunDefinitionSchema,
  EvaluationRunRejectionDefinitionSchema,
  EvaluationRunRejectionSchema,
  EvaluationRunResultDefinitionSchema,
  EvaluationRunResultSchema,
  EvaluationRunSchema,
  RawObservationDefinitionSchema,
  RawObservationSchema,
} from "./evaluation-run.js";
import {
  DiscoveryRecordDefinitionSchema,
  DiscoveryRecordSchema,
  SourceReviewDefinitionSchema,
  SourceReviewRecordSchema,
  SourceSnapshotDefinitionSchema,
  SourceSnapshotSchema,
} from "./evaluation-source.js";
import {
  EvaluatorSpecDefinitionSchema,
  EvaluatorSpecSchema,
  OracleSpecDefinitionSchema,
  OracleSpecSchema,
  QualificationFixtureSetDefinitionSchema,
  QualificationFixtureSetSchema,
  QualificationReportDefinitionSchema,
  QualificationReportSchema,
} from "./evaluation-spec.js";

export const EvaluationRecordKindSchema = z.enum([
  "aggregation_policy",
  "assessment",
  "criterion_set",
  "criterion_set_status",
  "discovery_record",
  "evaluation_aggregate",
  "evaluation_run",
  "evaluation_run_rejection",
  "evaluation_run_result",
  "evaluator_spec",
  "oracle_spec",
  "qualification_fixture_set",
  "qualification_report",
  "raw_observation",
  "source_review",
  "source_snapshot",
]);

export const EvaluationDefinitionPublicationKindSchema = z.enum([
  "aggregation_policy",
  "criterion_set",
  "discovery_record",
  "evaluator_spec",
  "oracle_spec",
  "qualification_fixture_set",
  "source_review",
  "source_snapshot",
]);

function mutationRequest<Kind extends string, Definition extends z.ZodType>(
  kind: Kind,
  definition: Definition,
) {
  return z.object({ definition, kind: z.literal(kind) }).strict();
}

export const PublishEvaluationDefinitionRequestSchema = z.discriminatedUnion("kind", [
  mutationRequest("aggregation_policy", EvaluationAggregationPolicyDefinitionSchema),
  mutationRequest("criterion_set", CriterionSetDefinitionSchema),
  mutationRequest("discovery_record", DiscoveryRecordDefinitionSchema),
  mutationRequest("evaluator_spec", EvaluatorSpecDefinitionSchema),
  mutationRequest("oracle_spec", OracleSpecDefinitionSchema),
  mutationRequest("qualification_fixture_set", QualificationFixtureSetDefinitionSchema),
  mutationRequest("source_review", SourceReviewDefinitionSchema),
  mutationRequest("source_snapshot", SourceSnapshotDefinitionSchema),
]);

export const RecordCriterionSetStatusRequestSchema = mutationRequest(
  "criterion_set_status",
  CriterionSetStatusDefinitionSchema,
);

export const RecordEvaluationRunDecisionRequestSchema = z.discriminatedUnion("kind", [
  mutationRequest("evaluation_run", EvaluationRunDefinitionSchema),
  mutationRequest("evaluation_run_rejection", EvaluationRunRejectionDefinitionSchema),
]);

export const RecordQualificationReportRequestSchema = mutationRequest(
  "qualification_report",
  QualificationReportDefinitionSchema,
);

export const RecordRawObservationRequestSchema = mutationRequest(
  "raw_observation",
  RawObservationDefinitionSchema,
);

export const RecordEvaluationRunResultRequestSchema = mutationRequest(
  "evaluation_run_result",
  EvaluationRunResultDefinitionSchema,
);

export const CreateEvaluationAggregateRequestSchema = mutationRequest(
  "evaluation_aggregate",
  EvaluationAggregateDefinitionSchema,
);

export const CreateAssessmentRequestSchema = mutationRequest(
  "assessment",
  AssessmentDefinitionSchema,
);

function recordEnvelope<Kind extends string, RecordSchema extends z.ZodType>(
  kind: Kind,
  record: RecordSchema,
) {
  return z.object({ kind: z.literal(kind), record }).strict();
}

export const EvaluationRecordEnvelopeSchema = z.discriminatedUnion("kind", [
  recordEnvelope("aggregation_policy", EvaluationAggregationPolicySchema),
  recordEnvelope("assessment", AssessmentSchema),
  recordEnvelope("criterion_set", CriterionSetSchema),
  recordEnvelope("criterion_set_status", CriterionSetStatusRecordSchema),
  recordEnvelope("discovery_record", DiscoveryRecordSchema),
  recordEnvelope("evaluation_aggregate", EvaluationAggregateSchema),
  recordEnvelope("evaluation_run", EvaluationRunSchema),
  recordEnvelope("evaluation_run_rejection", EvaluationRunRejectionSchema),
  recordEnvelope("evaluation_run_result", EvaluationRunResultSchema),
  recordEnvelope("evaluator_spec", EvaluatorSpecSchema),
  recordEnvelope("oracle_spec", OracleSpecSchema),
  recordEnvelope("qualification_fixture_set", QualificationFixtureSetSchema),
  recordEnvelope("qualification_report", QualificationReportSchema),
  recordEnvelope("raw_observation", RawObservationSchema),
  recordEnvelope("source_review", SourceReviewRecordSchema),
  recordEnvelope("source_snapshot", SourceSnapshotSchema),
]);

export const PublishEvaluationRecordResponseSchema = z
  .object({
    created: z.boolean(),
    requestId: RequestIdSchema,
    result: EvaluationRecordEnvelopeSchema,
  })
  .strict();

export const ReadEvaluationRecordResponseSchema = z
  .object({
    requestId: RequestIdSchema,
    result: EvaluationRecordEnvelopeSchema,
  })
  .strict();

export type CreateAssessmentRequest = z.infer<typeof CreateAssessmentRequestSchema>;
export type CreateEvaluationAggregateRequest = z.infer<
  typeof CreateEvaluationAggregateRequestSchema
>;
export type EvaluationDefinitionPublicationKind = z.infer<
  typeof EvaluationDefinitionPublicationKindSchema
>;
export type EvaluationRecordEnvelope = z.infer<typeof EvaluationRecordEnvelopeSchema>;
export type EvaluationRecordKind = z.infer<typeof EvaluationRecordKindSchema>;
export type PublishEvaluationDefinitionRequest = z.infer<
  typeof PublishEvaluationDefinitionRequestSchema
>;
export type PublishEvaluationRecordResponse = z.infer<typeof PublishEvaluationRecordResponseSchema>;
export type ReadEvaluationRecordResponse = z.infer<typeof ReadEvaluationRecordResponseSchema>;
export type RecordCriterionSetStatusRequest = z.infer<typeof RecordCriterionSetStatusRequestSchema>;
export type RecordEvaluationRunDecisionRequest = z.infer<
  typeof RecordEvaluationRunDecisionRequestSchema
>;
export type RecordEvaluationRunResultRequest = z.infer<
  typeof RecordEvaluationRunResultRequestSchema
>;
export type RecordRawObservationRequest = z.infer<typeof RecordRawObservationRequestSchema>;
export type RecordQualificationReportRequest = z.infer<
  typeof RecordQualificationReportRequestSchema
>;
