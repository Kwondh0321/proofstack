import { z } from "zod";
import { RequestIdSchema } from "./api.js";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { AssuranceRationaleSchema } from "./evaluation-source.js";
import { EvidenceScopeSchema } from "./evidence.js";
import {
  MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
  MAX_POLICY_EVALUATION_DEADLINE_MILLISECONDS,
  PolicyEvaluationRequestDefinitionSchema,
} from "./policy-evaluation-request.js";
import {
  POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";
import { ReleaseApprovalReviewerReceiptSchema } from "./release-approval.js";
import { ReleaseCandidateReferenceSchema } from "./release-candidate.js";
import { ReleasePolicyModeSchema } from "./release-policy.js";
import {
  MAX_RELEASE_POLICY_SELECTION_POLICIES,
  ReleasePolicySelectionReferenceSchema,
} from "./release-policy-selection.js";

export const RELEASE_DECISION_INPUT_SCHEMA_VERSION = "0.1" as const;
export const MAX_RELEASE_DECISION_INPUT_DEFINITION_BYTES = 64 * 1024;
export const MAX_RELEASE_DECISION_INPUT_RESPONSE_BYTES =
  MAX_RELEASE_DECISION_INPUT_DEFINITION_BYTES + 4 * 1024;
export const MAX_RELEASE_DECISION_APPROVAL_READS = 4_096;

/** Original server receipt, never a credential or proof of current publication authority. */
export const ReleaseDecisionPublisherReceiptSchema = z.discriminatedUnion("principalType", [
  ReleaseApprovalReviewerReceiptSchema,
  z
    .object({
      principalId: OpaqueIdSchema,
      principalType: z.literal("service"),
      authenticationMethod: z.literal("service_token"),
      authenticatedAt: UtcMillisecondTimestampSchema,
      credentialId: OpaqueIdSchema,
      requestId: RequestIdSchema.refine(
        (value) => !/[\uD800-\uDFFF]/u.test(value),
        "Canonical authentication receipts require Unicode scalar request IDs",
      ),
    })
    .strict(),
]);

const IntentShape = {
  decisionInputRequestId: OpaqueIdSchema,
  candidate: ReleaseCandidateReferenceSchema,
  selection: ReleasePolicySelectionReferenceSchema,
  rationale: AssuranceRationaleSchema,
};

/** No policy/result list, clock, worker, limits, actor, authority report or computed disposition. */
export const CreateReleaseDecisionInputRequestSchema = z.object(IntentShape).strict();

/** Aggregate metadata/approval admission across the entire selection, including repeated reads. */
export const ReleaseDecisionVerificationLimitsSchema = z
  .object({
    maxAcquisitionRecords: z.number().int().min(2).max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    maxAcquisitionRecordBytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES),
    maxApprovalRecords: z.number().int().min(0).max(MAX_RELEASE_DECISION_APPROVAL_READS),
  })
  .strict();

export const PlannedReleasePolicyEvaluationSchema = z
  .object({
    mode: ReleasePolicyModeSchema,
    request: PolicyEvaluationRequestDefinitionSchema,
    requestSha256: Sha256Schema,
  })
  .strict();

const DefinitionShape = {
  ...IntentShape,
  scope: EvidenceScopeSchema,
  mode: z.enum(["observation_only", "enforce"]),
  publisher: ReleaseDecisionPublisherReceiptSchema,
  createdAt: PolicyEvaluationTimeSchema,
  expiresAt: PolicyEvaluationTimeSchema,
  verificationLimits: ReleaseDecisionVerificationLimitsSchema,
  evaluations: z
    .array(PlannedReleasePolicyEvaluationSchema)
    .max(MAX_RELEASE_POLICY_SELECTION_POLICIES),
};

/** Shape admission does not establish complete selection, correct digests or absent requests. */
export const ReleaseDecisionInputDefinitionSchema = z
  .object(DefinitionShape)
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const issue = (message: string, field: string) =>
      context.addIssue({ code: "custom", message, path: [field] });
    const created = policyEvaluationTimestampOrderKey(value.createdAt);
    const expires = policyEvaluationTimestampOrderKey(value.expiresAt);
    if (
      expires <= created ||
      expires - created >
        BigInt(MAX_POLICY_EVALUATION_DEADLINE_MILLISECONDS) *
          POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND
    )
      issue("Input validity must be positive and at most one hour", "expiresAt");
    if (policyEvaluationTimestampOrderKey(value.publisher.authenticatedAt) > created)
      issue("Input creation cannot precede its original authentication receipt", "publisher");
    if ((value.mode === "enforce") !== value.evaluations.some(({ mode }) => mode === "mandatory"))
      issue("Enforcement requires a mandatory policy; observation cannot downgrade one", "mode");
    const requestIds = new Set<string>();
    for (const [index, evaluation] of value.evaluations.entries()) {
      const request = evaluation.request;
      const previous = value.evaluations[index - 1];
      if (previous && previous.request.policy.policyId >= request.policy.policyId)
        issue("Planned policies must have distinct logical IDs in ascending order", "evaluations");
      if (requestIds.has(request.evaluationRequestId))
        issue("Planned evaluation request IDs must be distinct", "evaluations");
      requestIds.add(request.evaluationRequestId);
      if (
        request.candidate.candidateId !== value.candidate.candidateId ||
        request.candidate.candidateVersionId !== value.candidate.candidateVersionId ||
        request.candidate.definitionSha256 !== value.candidate.definitionSha256
      )
        issue("Every planned request must bind the exact original candidate", "evaluations");
      if (request.evaluationTime !== value.createdAt)
        issue(
          "Every planned request must retain the exact original semantic cut text",
          "evaluations",
        );
    }
    // safeExtend adds receipt fields; byte admission must still measure only the definition.
    const definition = Object.fromEntries(
      Object.keys(DefinitionShape).map((key) => [key, value[key as keyof typeof value]]),
    );
    if (
      encodeEvaluationCanonicalJson(definition).byteLength >
      MAX_RELEASE_DECISION_INPUT_DEFINITION_BYTES
    )
      issue("Input definition exceeds its canonical UTF-8 byte ceiling", "evaluations");
  });

export const ReleaseDecisionInputSchema = ReleaseDecisionInputDefinitionSchema.safeExtend({
  schemaVersion: z.literal(RELEASE_DECISION_INPUT_SCHEMA_VERSION),
  definitionSha256: Sha256Schema,
});

export const ReleaseDecisionInputReferenceSchema = z
  .object({ decisionInputRequestId: OpaqueIdSchema, definitionSha256: Sha256Schema })
  .strict();

export type CreateReleaseDecisionInputRequest = z.infer<
  typeof CreateReleaseDecisionInputRequestSchema
>;
export type ReleaseDecisionInputDefinition = z.infer<typeof ReleaseDecisionInputDefinitionSchema>;
export type ReleaseDecisionInput = z.infer<typeof ReleaseDecisionInputSchema>;
export type ReleaseDecisionInputReference = z.infer<typeof ReleaseDecisionInputReferenceSchema>;
export type ReleaseDecisionPublisherReceipt = z.infer<typeof ReleaseDecisionPublisherReceiptSchema>;
export type ReleaseDecisionVerificationLimits = z.infer<
  typeof ReleaseDecisionVerificationLimitsSchema
>;
