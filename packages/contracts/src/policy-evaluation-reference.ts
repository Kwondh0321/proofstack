import { z } from "zod";
import { ArtifactContentReferenceSchema, JsonPointerSchema } from "./artifact.js";
import {
  ComparisonDefinitionPredecessorSchema,
  ComparisonSafetyEventSchema,
} from "./evaluation-comparison.js";
import { CriterionVersionSelectorSchema } from "./evaluation-criteria.js";
import { ModelEvaluatorSelectorSchema } from "./evaluation-model-assurance.js";
import { RegisteredEvaluationImplementationSchema } from "./evaluation-spec.js";
import { RegressionTraceSnapshotSchema } from "./dataset.js";
import {
  InteractionCaptureSourceSchema,
  InteractionPromptReferenceSchema,
  InteractionToolContractReferenceSchema,
  ModelInteractionAttemptSchema,
} from "./interaction.js";
import { PolicyEvaluationSourceReferenceSchema } from "./policy-evaluation-source-reference.js";
import { OpaqueIdSchema, Sha256Schema } from "./primitives.js";
import { QualificationPolicyReferenceSchema } from "./qualification-policy.js";
import {
  ReleaseCandidateModelDeclarationSchema,
  ReleaseCandidateSourceSchema,
} from "./release-candidate.js";
import { PolicyApprovalRequirementSchema, ReleasePolicyPredicateSchema } from "./release-policy.js";
import { RecordedBoundaryReplayInvocationDefinitionSchema } from "./replay.js";
import {
  ReplayReleaseTargetAdapterReferenceSchema,
  ReplayBoundaryDeclarationSchema,
  TargetReleaseSchema,
  WorkerProtocolReferenceSchema,
} from "./replay-plan.js";

/** Immutable declarations only: no lookup, credential resolution, byte access or execution. */
export const PolicyEvaluationControlDeclarationSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("approval_requirement"), reference: PolicyApprovalRequirementSchema })
    .strict(),
  z.object({ kind: z.literal("artifact_identity"), reference: OpaqueIdSchema }).strict(),
  z
    .object({
      kind: z.literal("artifact_requirement"),
      reference: ReleasePolicyPredicateSchema.options[4],
    })
    .strict(),
  z
    .object({ kind: z.literal("candidate_source"), reference: ReleaseCandidateSourceSchema })
    .strict(),
  z
    .object({
      kind: z.literal("comparison_predecessor"),
      reference: ComparisonDefinitionPredecessorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("model_declaration"),
      reference: ReleaseCandidateModelDeclarationSchema,
    })
    .strict(),
  z.object({ kind: z.literal("safety_event"), reference: ComparisonSafetyEventSchema }).strict(),
]);

/** Uses the existing owning shapes, including their distinct protocol/token bounds. */
export const PolicyEvaluationReplayDeclarationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("artifact_identity"), reference: OpaqueIdSchema }).strict(),
  z
    .object({
      kind: z.literal("credential_selector"),
      reference: ReplayBoundaryDeclarationSchema.options[0].shape.credential,
    })
    .strict(),
  z.object({ kind: z.literal("digest"), reference: Sha256Schema }).strict(),
  z
    .object({
      kind: z.literal("endpoint_profile"),
      reference: ReplayBoundaryDeclarationSchema.options[0].shape.endpointProfile,
    })
    .strict(),
  z
    .object({
      kind: z.literal("preinstalled_target"),
      reference: TargetReleaseSchema.shape.execution.options[1],
    })
    .strict(),
  z
    .object({
      kind: z.literal("recorded_adapter"),
      reference: RecordedBoundaryReplayInvocationDefinitionSchema.shape.targetAdapter,
    })
    .strict(),
  z
    .object({
      kind: z.literal("subprocess_implementation"),
      reference:
        TargetReleaseSchema.shape.subprocessPolicy.options[1].shape.allowedImplementations.element,
    })
    .strict(),
  z
    .object({
      kind: z.literal("target_adapter"),
      reference: ReplayReleaseTargetAdapterReferenceSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("worker_protocol"), reference: WorkerProtocolReferenceSchema })
    .strict(),
]);

/** Parent-bound JSON-pointer occurrence, never a fetch URL or evidence/authority assertion. */
export const PolicyEvaluationReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("control_declaration"),
      path: JsonPointerSchema,
      declaration: PolicyEvaluationControlDeclarationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("replay_declaration"),
      path: JsonPointerSchema,
      declaration: PolicyEvaluationReplayDeclarationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("record"),
      path: JsonPointerSchema,
      source: PolicyEvaluationSourceReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("artifact"),
      path: JsonPointerSchema,
      reference: ArtifactContentReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("criterion_selector"),
      path: JsonPointerSchema,
      selector: CriterionVersionSelectorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("model_evaluator_selector"),
      path: JsonPointerSchema,
      selector: ModelEvaluatorSelectorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("evaluation_run_identity"),
      path: JsonPointerSchema,
      evaluationRunId: OpaqueIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("qualification_policy"),
      path: JsonPointerSchema,
      reference: QualificationPolicyReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("registered_implementation"),
      path: JsonPointerSchema,
      reference: RegisteredEvaluationImplementationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("trace_snapshot_selector"),
      path: JsonPointerSchema,
      selector: RegressionTraceSnapshotSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("protocol_declaration"),
      path: JsonPointerSchema,
      reference: InteractionCaptureSourceSchema.shape.captureAdapter,
    })
    .strict(),
  z
    .object({
      kind: z.literal("endpoint_profile_selector"),
      path: JsonPointerSchema,
      selector: ModelInteractionAttemptSchema.shape.provider
        .pick({ endpointProfileId: true, endpointProfileVersion: true })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("interaction_prompt"),
      path: JsonPointerSchema,
      reference: InteractionPromptReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("interaction_tool_contract"),
      path: JsonPointerSchema,
      reference: InteractionToolContractReferenceSchema,
    })
    .strict(),
]);

export type PolicyEvaluationControlDeclaration = z.infer<
  typeof PolicyEvaluationControlDeclarationSchema
>;
export type PolicyEvaluationReplayDeclaration = z.infer<
  typeof PolicyEvaluationReplayDeclarationSchema
>;
export type PolicyEvaluationReference = z.infer<typeof PolicyEvaluationReferenceSchema>;
