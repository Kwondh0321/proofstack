import { z } from "zod";
import { RequestIdSchema } from "./api.js";
import {
  ModelAssuranceAssessmentInputSchema,
  ModelAssuranceAssessmentSchema,
} from "./evaluation-model-assessment.js";
import {
  BlindedEvaluationPlanDefinitionSchema,
  BlindedEvaluationPlanSchema,
  BlindedEvaluationResultDefinitionSchema,
  BlindedEvaluationResultSchema,
  CalibrationReportDefinitionSchema,
  CalibrationReportSchema,
  HumanReviewerIndependenceDefinitionSchema,
  HumanReviewerIndependenceSchema,
  HumanReviewProtocolDefinitionSchema,
  HumanReviewProtocolSchema,
  HumanReviewRecordDefinitionSchema,
  HumanReviewRecordSchema,
  IndependenceDeclarationDefinitionSchema,
  IndependenceDeclarationSchema,
  IndependentCritiqueDefinitionSchema,
  IndependentCritiqueSchema,
  ModelAssistedEvaluatorSpecDefinitionSchema,
  ModelAssistedEvaluatorSpecSchema,
  ModelEvaluatorProfileDefinitionSchema,
  ModelEvaluatorProfileSchema,
} from "./evaluation-model-assurance.js";
import {
  ModelQualificationReportDefinitionSchema,
  ModelQualificationReportSchema,
  ModelQualificationSuiteDefinitionSchema,
  ModelQualificationSuiteSchema,
} from "./evaluation-model-qualification.js";

export const ModelAssuranceRecordKindSchema = z.enum([
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

export const ModelAssuranceManagementKindSchema = z.enum([
  "blinded_evaluation_plan",
  "calibration_report",
  "human_review_protocol",
  "human_reviewer_independence",
  "independence_declaration",
  "model_assisted_evaluator",
  "model_evaluator_profile",
  "model_qualification_suite",
]);

export const ModelAssuranceExecutionKindSchema = z.enum([
  "blinded_evaluation_result",
  "independent_critique",
  "model_qualification_report",
]);

function mutationRequest<Kind extends string, Definition extends z.ZodType>(
  kind: Kind,
  definition: Definition,
) {
  return z.object({ definition, kind: z.literal(kind) }).strict();
}

export const PublishModelAssuranceDefinitionRequestSchema = z.discriminatedUnion("kind", [
  mutationRequest("blinded_evaluation_plan", BlindedEvaluationPlanDefinitionSchema),
  mutationRequest("calibration_report", CalibrationReportDefinitionSchema),
  mutationRequest("human_review_protocol", HumanReviewProtocolDefinitionSchema),
  mutationRequest("human_reviewer_independence", HumanReviewerIndependenceDefinitionSchema),
  mutationRequest("independence_declaration", IndependenceDeclarationDefinitionSchema),
  mutationRequest("model_assisted_evaluator", ModelAssistedEvaluatorSpecDefinitionSchema),
  mutationRequest("model_evaluator_profile", ModelEvaluatorProfileDefinitionSchema),
  mutationRequest("model_qualification_suite", ModelQualificationSuiteDefinitionSchema),
]);

export const RecordModelAssuranceExecutionRequestSchema = z.discriminatedUnion("kind", [
  mutationRequest("blinded_evaluation_result", BlindedEvaluationResultDefinitionSchema),
  mutationRequest("independent_critique", IndependentCritiqueDefinitionSchema),
  mutationRequest("model_qualification_report", ModelQualificationReportDefinitionSchema),
]);

export const RecordHumanReviewRequestSchema = mutationRequest(
  "human_review_record",
  HumanReviewRecordDefinitionSchema,
);

export const CreateModelAssuranceAssessmentRequestSchema = mutationRequest(
  "model_assurance_assessment",
  ModelAssuranceAssessmentInputSchema,
);

function recordEnvelope<Kind extends string, RecordSchema extends z.ZodType>(
  kind: Kind,
  record: RecordSchema,
) {
  return z.object({ kind: z.literal(kind), record }).strict();
}

export const ModelAssuranceRecordEnvelopeSchema = z.discriminatedUnion("kind", [
  recordEnvelope("blinded_evaluation_plan", BlindedEvaluationPlanSchema),
  recordEnvelope("blinded_evaluation_result", BlindedEvaluationResultSchema),
  recordEnvelope("calibration_report", CalibrationReportSchema),
  recordEnvelope("human_review_protocol", HumanReviewProtocolSchema),
  recordEnvelope("human_review_record", HumanReviewRecordSchema),
  recordEnvelope("human_reviewer_independence", HumanReviewerIndependenceSchema),
  recordEnvelope("independence_declaration", IndependenceDeclarationSchema),
  recordEnvelope("independent_critique", IndependentCritiqueSchema),
  recordEnvelope("model_assisted_evaluator", ModelAssistedEvaluatorSpecSchema),
  recordEnvelope("model_assurance_assessment", ModelAssuranceAssessmentSchema),
  recordEnvelope("model_evaluator_profile", ModelEvaluatorProfileSchema),
  recordEnvelope("model_qualification_report", ModelQualificationReportSchema),
  recordEnvelope("model_qualification_suite", ModelQualificationSuiteSchema),
]);

export const PublishModelAssuranceRecordResponseSchema = z
  .object({
    created: z.boolean(),
    requestId: RequestIdSchema,
    result: ModelAssuranceRecordEnvelopeSchema,
  })
  .strict();

export const ReadModelAssuranceRecordResponseSchema = z
  .object({
    requestId: RequestIdSchema,
    result: ModelAssuranceRecordEnvelopeSchema,
  })
  .strict();

export type CreateModelAssuranceAssessmentRequest = z.infer<
  typeof CreateModelAssuranceAssessmentRequestSchema
>;
export type ModelAssuranceExecutionKind = z.infer<typeof ModelAssuranceExecutionKindSchema>;
export type ModelAssuranceManagementKind = z.infer<typeof ModelAssuranceManagementKindSchema>;
export type ModelAssuranceRecordEnvelope = z.infer<typeof ModelAssuranceRecordEnvelopeSchema>;
export type ModelAssuranceRecordKind = z.infer<typeof ModelAssuranceRecordKindSchema>;
export type PublishModelAssuranceDefinitionRequest = z.infer<
  typeof PublishModelAssuranceDefinitionRequestSchema
>;
export type PublishModelAssuranceRecordResponse = z.infer<
  typeof PublishModelAssuranceRecordResponseSchema
>;
export type ReadModelAssuranceRecordResponse = z.infer<
  typeof ReadModelAssuranceRecordResponseSchema
>;
export type RecordHumanReviewRequest = z.infer<typeof RecordHumanReviewRequestSchema>;
export type RecordModelAssuranceExecutionRequest = z.infer<
  typeof RecordModelAssuranceExecutionRequestSchema
>;
