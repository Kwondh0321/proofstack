import { z } from "zod";
import { MAX_POLICY_SOURCES } from "./release-policy.js";
import { EvidenceScopeSchema } from "./evidence.js";
import {
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { OpaqueIdSchema, Sha256Schema } from "./primitives.js";
import {
  ReleasePolicyLifecycleEventSchema,
  ReleasePolicyReferenceSchema,
  ReleasePolicySchema,
} from "./release-policy.js";
import { serializeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";

export const RELEASE_POLICY_AUTHORITY_REASONS = [
  "installation_authority_evidence_unavailable",
  "installation_binding_interval_mismatch",
  "installation_binding_not_current",
  "installation_binding_not_registered",
  "installation_binding_reference_mismatch",
  "installation_binding_scope_mismatch",
  "installation_binding_unavailable",
  "issuer_not_authorized",
  "policy_expired_at_evaluation",
  "policy_mode_not_authorized",
  "policy_not_effective_at_evaluation",
  "policy_not_publishable_at_time",
  "reviewer_qualification_evidence_unavailable",
  "reviewer_qualification_not_current",
  "reviewer_qualification_not_independent",
  "reviewer_qualification_not_qualified",
  "reviewer_qualification_reference_mismatch",
  "reviewer_qualification_scope_mismatch",
  "reviewer_qualification_source_kind_mismatch",
  "reviewer_qualification_unavailable",
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
  "source_review_not_approved",
  "source_review_not_current",
  "source_review_not_independent",
  "source_review_relationship_disclosed",
  "source_review_unavailable",
  "source_scope_mismatch",
  "source_snapshot_unavailable",
] as const;

/** Owning retained-source findings; these do not replace lifecycle or current guarded authority. */
export const PolicyEvaluationAuthorityFindingSchema = z
  .object({
    reason: z.enum(RELEASE_POLICY_AUTHORITY_REASONS),
    sourceReviewId: OpaqueIdSchema.optional(),
    sourceSnapshotId: OpaqueIdSchema.optional(),
  })
  .strict();

export const PolicyEvaluationAuthorityRequirementsSchema = z
  .object({
    status: z.enum(["invalid", "valid"]),
    findings: z
      .array(PolicyEvaluationAuthorityFindingSchema)
      .max((MAX_POLICY_SOURCES + 1) * RELEASE_POLICY_AUTHORITY_REASONS.length),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    if ((value.status === "valid") !== (value.findings.length === 0))
      context.addIssue({
        code: "custom",
        message: "Authority status must preserve every retained finding",
      });
  });

/** Complete original terminal history and later successor metadata; not a publication token. */
export const PolicyEvaluationLifecycleInputsSchema = z
  .object({
    scope: EvidenceScopeSchema,
    policy: ReleasePolicyReferenceSchema,
    policyRecordSha256: Sha256Schema,
    evaluationTime: PolicyEvaluationTimeSchema,
    startedAt: PolicyEvaluationTimeSchema,
    completedAt: PolicyEvaluationTimeSchema,
    observationSha256: Sha256Schema,
    state: z.enum([
      "no_terminal_event_at_evaluation",
      "withdrawn_at_evaluation",
      "superseded_at_evaluation",
    ]),
    history: z
      .array(
        z
          .object({
            record: ReleasePolicyLifecycleEventSchema,
            recordSha256: Sha256Schema,
            successor: z
              .object({ record: ReleasePolicySchema, recordSha256: Sha256Schema })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .max(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const same = (left: unknown, right: unknown) =>
      serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    const cut = policyEvaluationTimestampOrderKey(value.evaluationTime);
    const start = policyEvaluationTimestampOrderKey(value.startedAt);
    const end = policyEvaluationTimestampOrderKey(value.completedAt);
    if (start < cut || end < start)
      issue("Lifecycle receipts must follow the semantic cut in capture order");
    const event = value.history[0];
    let state: typeof value.state = "no_terminal_event_at_evaluation";
    if (event) {
      const record = event.record;
      if (!same(record.scope, value.scope) || !same(record.policy, value.policy))
        issue("Terminal history must bind the exact original policy and scope");
      if (policyEvaluationTimestampOrderKey(record.occurredAt) > end)
        issue("Terminal history cannot contain a future authoritative receipt");
      if (record.kind === "superseded") {
        const successor = event.successor?.record;
        if (
          !successor ||
          !same(successor.scope, value.scope) ||
          !same(successor.predecessor, value.policy) ||
          !same(
            {
              policyId: successor.policyId,
              policyVersionId: successor.policyVersionId,
              definitionSha256: successor.definitionSha256,
            },
            record.successor,
          ) ||
          policyEvaluationTimestampOrderKey(successor.publishedAt) >
            policyEvaluationTimestampOrderKey(record.occurredAt)
        )
          issue("Supersession must retain its exact originally published successor lineage");
      } else if (event.successor !== null)
        issue("Withdrawal cannot introduce a replacement policy");
      if (policyEvaluationTimestampOrderKey(record.occurredAt) <= cut)
        state =
          record.kind === "withdrawn" ? "withdrawn_at_evaluation" : "superseded_at_evaluation";
    }
    if (value.state !== state)
      issue("Lifecycle state must be derived at the original semantic cut");
  });

export type PolicyEvaluationAuthorityRequirements = z.infer<
  typeof PolicyEvaluationAuthorityRequirementsSchema
>;
export type PolicyEvaluationLifecycleInputs = z.infer<typeof PolicyEvaluationLifecycleInputsSchema>;
