import { z } from "zod";
import { RequestIdSchema } from "./api.js";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { AssuranceRationaleSchema, AssuranceSummarySchema } from "./evaluation-source.js";
import { EvidenceScopeSchema } from "./evidence.js";
import { PolicyEvaluationRequestReferenceSchema } from "./policy-evaluation-request.js";
import { PolicyEvaluationResultReferenceSchema } from "./policy-evaluation-result.js";
import { PolicyEvaluationSnapshotReferenceSchema } from "./policy-evaluation-snapshot.js";
import {
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";
import { ReleaseCandidateReferenceSchema } from "./release-candidate.js";
import { ReleasePolicyReferenceSchema } from "./release-policy.js";
import { ReleasePolicySelectionReferenceSchema } from "./release-policy-selection.js";
import { ReleaseReviewerAuthorityReferenceSchema } from "./release-reviewer-authority.js";

export const RELEASE_APPROVAL_SCHEMA_VERSION = "0.1" as const;
export const MAX_RELEASE_APPROVAL_DEFINITION_BYTES = 64 * 1024;
export const MAX_RELEASE_APPROVAL_INTENT_BYTES = MAX_RELEASE_APPROVAL_DEFINITION_BYTES - 4 * 1024;
export const MAX_RELEASE_APPROVAL_RESPONSE_BYTES = MAX_RELEASE_APPROVAL_DEFINITION_BYTES + 4 * 1024;

function ordered(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

/** Complete immutable subject; owning readers must rederive every original relationship. */
export const ReleaseApprovalSubjectSchema = z
  .object({
    scope: EvidenceScopeSchema,
    selection: ReleasePolicySelectionReferenceSchema,
    candidate: ReleaseCandidateReferenceSchema,
    policy: ReleasePolicyReferenceSchema,
    request: PolicyEvaluationRequestReferenceSchema,
    snapshot: PolicyEvaluationSnapshotReferenceSchema,
    evaluation: PolicyEvaluationResultReferenceSchema,
    jobId: OpaqueIdSchema,
    ruleId: OpaqueIdSchema,
  })
  .strict();

export const ReleaseApprovalReferenceSchema = z
  .object({
    approvalId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
  })
  .strict();

const IntentShape = {
  approvalId: OpaqueIdSchema,
  kind: z.enum(["normal_approval", "rule_exception"]),
  action: z.enum(["approve", "oppose", "escalate", "abstain"]),
  subject: ReleaseApprovalSubjectSchema,
  rationale: AssuranceRationaleSchema,
  conditions: z
    .array(AssuranceSummarySchema)
    .max(32)
    .refine(ordered, "Approval conditions must be unique and ordered"),
  compensatingControls: z
    .array(ArtifactContentReferenceSchema)
    .max(16)
    .refine(
      (values) => ordered(values.map(({ artifactId, sha256 }) => `${artifactId}:${sha256}`)),
      "Compensating control references must be unique and ordered",
    ),
  declaredConflicts: z
    .array(AssuranceSummarySchema)
    .max(32)
    .refine(ordered, "Declared approval conflicts must be unique and ordered"),
  expiresAt: PolicyEvaluationTimeSchema,
  supersedes: ReleaseApprovalReferenceSchema.optional(),
};
type Intent = z.infer<z.ZodObject<typeof IntentShape>>;

function checkIntent(value: Intent, context: z.RefinementCtx): void {
  if (context.issues.length > 0) return;
  if (value.supersedes?.approvalId === value.approvalId)
    context.addIssue({ code: "custom", message: "An approval cannot supersede itself" });
  if (value.kind === "normal_approval" && value.compensatingControls.length > 0)
    context.addIssue({
      code: "custom",
      message: "Normal approval cannot claim a rule exception's compensating controls",
    });
  if (
    value.kind === "rule_exception" &&
    value.action === "approve" &&
    value.compensatingControls.length === 0
  )
    context.addIssue({
      code: "custom",
      message: "A proposed exception requires retained compensating-control evidence",
    });
  const intent = Object.fromEntries(
    Object.keys(IntentShape)
      .filter((key) => value[key as keyof Intent] !== undefined)
      .map((key) => [key, value[key as keyof Intent]]),
  );
  if (
    encodeEvaluationCanonicalJson(JSON.parse(JSON.stringify(intent))).byteLength >
    MAX_RELEASE_APPROVAL_INTENT_BYTES
  )
    context.addIssue({
      code: "custom",
      message: "Approval intent exceeds its canonical UTF-8 byte ceiling",
    });
}

/** Public intent cannot choose its reviewer, authority, authentication receipt or recording time. */
export const ReleaseApprovalIntentSchema = z.object(IntentShape).strict().superRefine(checkIntent);

/** Server-derived original receipt; identifiers alone cannot authenticate a subsequent action. */
export const ReleaseApprovalReviewerReceiptSchema = z
  .object({
    principalId: OpaqueIdSchema,
    principalType: z.literal("user"),
    authenticationMethod: z.literal("oidc"),
    authenticatedAt: UtcMillisecondTimestampSchema,
    credentialId: OpaqueIdSchema,
    requestId: RequestIdSchema.refine(
      (value) => !/[\uD800-\uDFFF]/u.test(value),
      "Canonical authentication receipts require Unicode scalar request IDs",
    ),
  })
  .strict();

const DefinitionShape = {
  ...IntentShape,
  reviewer: ReleaseApprovalReviewerReceiptSchema,
  authority: ReleaseReviewerAuthorityReferenceSchema,
  recordedAt: PolicyEvaluationTimeSchema,
};

/** The canonical definition includes the original server-owned authentication and native cut. */
export const ReleaseApprovalDefinitionSchema = z
  .object(DefinitionShape)
  .strict()
  .superRefine((value, context) => {
    checkIntent(value, context);
    if (context.issues.length > 0) return;
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    if (
      value.authority.reviewerPrincipalId !== value.reviewer.principalId ||
      value.authority.installationId !== value.subject.selection.installationId ||
      value.authority.gateTargetId !== value.subject.selection.gateTargetId
    )
      issue("Original reviewer authority must bind the same reviewer and installation target");
    const at = policyEvaluationTimestampOrderKey(value.recordedAt);
    if (at >= policyEvaluationTimestampOrderKey(value.expiresAt))
      issue("Approval action must be recorded before its exact expiry");
    if (policyEvaluationTimestampOrderKey(value.reviewer.authenticatedAt) > at)
      issue("An approval action cannot precede its actual authentication receipt");
    const definition = Object.fromEntries(
      Object.keys(DefinitionShape)
        .filter((key) => value[key as keyof typeof value] !== undefined)
        .map((key) => [key, value[key as keyof typeof value]]),
    );
    if (
      encodeEvaluationCanonicalJson(JSON.parse(JSON.stringify(definition))).byteLength >
      MAX_RELEASE_APPROVAL_DEFINITION_BYTES
    )
      issue("Approval definition exceeds its canonical UTF-8 byte ceiling");
  });

export const ReleaseApprovalSchema = ReleaseApprovalDefinitionSchema.safeExtend({
  definitionSha256: Sha256Schema,
  schemaVersion: z.literal(RELEASE_APPROVAL_SCHEMA_VERSION),
});

/** Revocation does not rewrite the original action, authentication receipt or evaluation. */
export const ReleaseApprovalRevocationSchema = z
  .object({
    eventId: OpaqueIdSchema,
    approval: ReleaseApprovalReferenceSchema,
    scope: EvidenceScopeSchema,
    reviewer: ReleaseApprovalReviewerReceiptSchema,
    occurredAt: PolicyEvaluationTimeSchema,
    reason: AssuranceRationaleSchema,
    schemaVersion: z.literal(RELEASE_APPROVAL_SCHEMA_VERSION),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    if (
      policyEvaluationTimestampOrderKey(value.reviewer.authenticatedAt) >
      policyEvaluationTimestampOrderKey(value.occurredAt)
    )
      context.addIssue({
        code: "custom",
        message: "Revocation cannot precede its actual authentication",
      });
  });

export type ReleaseApprovalIntent = z.infer<typeof ReleaseApprovalIntentSchema>;
export type ReleaseApprovalSubject = z.infer<typeof ReleaseApprovalSubjectSchema>;
export type ReleaseApprovalDefinition = z.infer<typeof ReleaseApprovalDefinitionSchema>;
export type ReleaseApproval = z.infer<typeof ReleaseApprovalSchema>;
export type ReleaseApprovalReference = z.infer<typeof ReleaseApprovalReferenceSchema>;
export type ReleaseApprovalReviewerReceipt = z.infer<typeof ReleaseApprovalReviewerReceiptSchema>;
export type ReleaseApprovalRevocation = z.infer<typeof ReleaseApprovalRevocationSchema>;
