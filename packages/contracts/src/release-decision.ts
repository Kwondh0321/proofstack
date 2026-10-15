import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { AssuranceRationaleSchema } from "./evaluation-source.js";
import { EvidenceScopeSchema } from "./evidence.js";
import {
  PolicyEvaluationJobReferenceSchema,
  PolicyEvaluationJobStatusSchema,
} from "./policy-evaluation-job.js";
import {
  MAX_POLICY_EVALUATION_DEADLINE_MILLISECONDS,
  PolicyEvaluationRequestReferenceSchema,
} from "./policy-evaluation-request.js";
import {
  PolicyEvaluationResultReferenceSchema,
  PolicyEvaluationRuleOutcomeSchema,
  PolicyEvaluationRuleResultSchema,
} from "./policy-evaluation-result.js";
import { PolicyEvaluationSnapshotReferenceSchema } from "./policy-evaluation-snapshot.js";
import {
  POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { OpaqueIdSchema, Sha256Schema } from "./primitives.js";
import { ReleaseApprovalReferenceSchema } from "./release-approval.js";
import { ReleaseCandidateReferenceSchema } from "./release-candidate.js";
import {
  ReleaseDecisionInputReferenceSchema,
  ReleaseDecisionPublisherReceiptSchema,
  MAX_RELEASE_DECISION_APPROVAL_READS,
} from "./release-decision-input.js";
import {
  MAX_POLICY_RULES,
  MAX_POLICY_APPROVAL_GROUPS,
  ReleasePolicyModeSchema,
  ReleasePolicyReferenceSchema,
} from "./release-policy.js";
import {
  MAX_RELEASE_POLICY_SELECTION_POLICIES,
  ReleasePolicySelectionReferenceSchema,
} from "./release-policy-selection.js";

export const RELEASE_DECISION_SCHEMA_VERSION = "0.1" as const;
export const RELEASE_DECISION_ALGORITHM_VERSION = "1.0.0" as const;
export const MAX_RELEASE_DECISION_DEFINITION_BYTES = 2 * 1024 * 1024;
export const MAX_RELEASE_DECISION_RESPONSE_BYTES = MAX_RELEASE_DECISION_DEFINITION_BYTES + 4 * 1024;

export const ReleaseDecisionDispositionSchema = z.enum(["advisory", "proceed", "hold", "reject"]);
export const ReleaseDecisionRuleStatusSchema = z.enum([
  "satisfied",
  "unresolved",
  "non_waivable_violation",
]);
export const ReleaseDecisionRuleReasonSchema = z.enum([
  "evaluation_satisfied",
  "normal_approval_applied",
  "scoped_exception_applied",
  "original_policy_unavailable",
  "current_policy_unavailable",
  "candidate_authority_unverified",
  "policy_inapplicable",
  "policy_applicability_unknown",
  "evidence_indeterminate",
  "non_waivable_violation",
  "normal_approval_unavailable",
  "exception_unavailable",
  "review_opposed",
  "review_escalated",
]);
export const ReleaseDecisionSelectionStateSchema = z.enum([
  "current",
  "unavailable",
  "not_effective",
  "expired",
  "withdrawn",
  "superseded",
  "conflicting",
]);

/** Refers to a distinct immutable publication-cut graph, not a reusable authority report. */
export const ReleaseDecisionAuthoritySnapshotReferenceSchema = z
  .object({
    authoritySnapshotId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
  })
  .strict();

/** Server derives target, cut, validity, publisher, original results and every computed finding. */
export const CreateReleaseDecisionRequestSchema = z
  .object({
    decisionId: OpaqueIdSchema,
    input: ReleaseDecisionInputReferenceSchema,
    rationale: AssuranceRationaleSchema,
  })
  .strict();

function ordered(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

export const ReleaseDecisionRuleFindingSchema = z
  .object({
    ruleId: OpaqueIdSchema,
    ruleIndex: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_POLICY_RULES - 1),
    predicateKind: PolicyEvaluationRuleResultSchema.shape.predicateKind,
    originalOutcome: PolicyEvaluationRuleOutcomeSchema,
    nonWaivable: z.boolean(),
    status: ReleaseDecisionRuleStatusSchema,
    reason: ReleaseDecisionRuleReasonSchema,
    supportingApprovals: z
      .array(ReleaseApprovalReferenceSchema)
      .max(MAX_POLICY_APPROVAL_GROUPS)
      .refine(
        (values) => ordered(values.map(({ approvalId }) => approvalId)),
        "Supporting approvals must have unique ordered IDs",
      ),
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    const approval = value.reason === "normal_approval_applied";
    const exception = value.reason === "scoped_exception_applied";
    if (value.status === "satisfied") {
      if (!approval && !exception && value.reason !== "evaluation_satisfied")
        issue("Satisfied findings require their exact resolution basis");
      if (
        approval &&
        (value.predicateKind !== "approval_required" || value.originalOutcome !== "indeterminate")
      )
        issue("Normal approval resolves only the original approval prerequisite");
      if (
        exception &&
        (value.predicateKind === "approval_required" ||
          value.originalOutcome !== "violated" ||
          value.nonWaivable)
      )
        issue("A scoped exception resolves only a known waivable non-approval violation");
      if (
        value.reason === "evaluation_satisfied" &&
        (value.originalOutcome !== "satisfied" || value.predicateKind === "approval_required")
      )
        issue("Evaluation satisfaction must retain its original non-approval outcome");
    } else if (value.status === "non_waivable_violation") {
      if (
        value.originalOutcome !== "violated" ||
        !value.nonWaivable ||
        value.reason !== "non_waivable_violation" ||
        value.predicateKind === "approval_required"
      )
        issue("Non-waivable violations must retain the original known violation");
    } else if (
      approval ||
      exception ||
      value.reason === "evaluation_satisfied" ||
      value.reason === "non_waivable_violation"
    )
      issue("An unresolved finding cannot claim a resolved requirement");
    if ((approval || exception) !== value.supportingApprovals.length > 0)
      issue("Only applied approvals/exceptions retain nonempty supporting references");
    if (value.predicateKind === "approval_required" && value.originalOutcome !== "indeterminate")
      issue("Original approval evaluation remains indeterminate");
  });

const PolicyShape = {
  policy: ReleasePolicyReferenceSchema,
  request: PolicyEvaluationRequestReferenceSchema,
  mode: ReleasePolicyModeSchema,
};
export const ReleaseDecisionPolicyFindingSchema = z
  .discriminatedUnion("state", [
    z
      .object({
        ...PolicyShape,
        state: z.literal("evaluated"),
        job: PolicyEvaluationJobReferenceSchema,
        snapshot: PolicyEvaluationSnapshotReferenceSchema,
        evaluation: PolicyEvaluationResultReferenceSchema,
        ruleCount: z.number().int().min(1).max(MAX_POLICY_RULES),
        rules: z.array(ReleaseDecisionRuleFindingSchema).min(1).max(MAX_POLICY_RULES),
      })
      .strict(),
    z
      .object({
        ...PolicyShape,
        state: z.literal("unavailable"),
        reason: z.enum([
          "request_missing",
          "result_missing",
          "original_graph_unavailable",
          "original_graph_ambiguous",
          "original_graph_invalid",
        ]),
        job: PolicyEvaluationJobReferenceSchema.optional(),
        jobStatus: PolicyEvaluationJobStatusSchema.optional(),
        snapshot: PolicyEvaluationSnapshotReferenceSchema.optional(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    if (value.state === "unavailable") {
      if ((value.job !== undefined) !== (value.jobStatus !== undefined))
        issue("A known original job requires both identity and status");
      if (value.snapshot && !value.job) issue("A retained seal requires its owning original job");
      if (value.reason === "request_missing" && (value.job || value.snapshot))
        issue("A missing original request cannot invent a job or seal");
      return;
    }
    if (value.ruleCount !== value.rules.length) issue("Every original rule requires one finding");
    if (!ordered(value.rules.map(({ ruleId }) => ruleId)))
      issue("Original rules must have unique ordered IDs");
    if (value.rules.some(({ ruleIndex }, index) => ruleIndex !== index))
      issue("Rule findings require contiguous original indices");
  });

const DefinitionShape = {
  decisionId: OpaqueIdSchema,
  scope: EvidenceScopeSchema,
  input: ReleaseDecisionInputReferenceSchema,
  candidate: ReleaseCandidateReferenceSchema,
  selection: ReleasePolicySelectionReferenceSchema,
  mode: z.enum(["observation_only", "enforce"]),
  selectionState: ReleaseDecisionSelectionStateSchema,
  authoritySnapshot: ReleaseDecisionAuthoritySnapshotReferenceSchema,
  algorithm: z
    .object({
      id: z.literal("proofstack.accountable-release-decision"),
      version: z.literal(RELEASE_DECISION_ALGORITHM_VERSION),
    })
    .strict(),
  publisher: ReleaseDecisionPublisherReceiptSchema,
  decidedAt: PolicyEvaluationTimeSchema,
  expiresAt: PolicyEvaluationTimeSchema,
  rationale: AssuranceRationaleSchema,
  disposition: ReleaseDecisionDispositionSchema,
  policies: z.array(ReleaseDecisionPolicyFindingSchema).max(MAX_RELEASE_POLICY_SELECTION_POLICIES),
};

/** Intrinsic consistency only; owning readers must recompute against the original input/cut graph. */
export const ReleaseDecisionDefinitionSchema = z
  .object(DefinitionShape)
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    const cut = policyEvaluationTimestampOrderKey(value.decidedAt);
    if (
      policyEvaluationTimestampOrderKey(value.publisher.authenticatedAt) > cut ||
      cut >= policyEvaluationTimestampOrderKey(value.expiresAt)
    )
      issue("Decision must follow actual authentication and precede exact expiry");
    if (
      policyEvaluationTimestampOrderKey(value.expiresAt) - cut >
      BigInt(MAX_POLICY_EVALUATION_DEADLINE_MILLISECONDS) *
        POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND
    )
      issue("Decision validity cannot exceed one hour or its owning input/authority intervals");
    if (!ordered(value.policies.map(({ policy }) => policy.policyId)))
      issue("Decision must retain every unique original policy in order");
    const mandatory = value.policies.filter(({ mode }) => mode === "mandatory");
    if ((value.mode === "enforce") !== mandatory.length > 0)
      issue("Decision mode cannot omit or downgrade mandatory policies");
    const requestIds = value.policies.map(({ request }) => request.evaluationRequestId);
    if (new Set(requestIds).size !== requestIds.length)
      issue("Decision must retain unique original requests");
    for (const ids of [
      value.policies.flatMap((policy) => (policy.job ? [policy.job.jobId] : [])),
      value.policies.flatMap((policy) => (policy.snapshot ? [policy.snapshot.snapshotId] : [])),
      value.policies.flatMap((policy) =>
        policy.state === "evaluated" ? [policy.evaluation.evaluationId] : [],
      ),
    ])
      if (new Set(ids).size !== ids.length)
        issue("Distinct original requests cannot share owning jobs, seals or results");
    const supports = value.policies.flatMap((policy) =>
      policy.state === "evaluated"
        ? policy.rules.flatMap(({ supportingApprovals }) => supportingApprovals)
        : [],
    );
    if (
      supports.length > MAX_RELEASE_DECISION_APPROVAL_READS ||
      new Set(supports.map(({ approvalId }) => approvalId)).size !== supports.length
    )
      issue("Supporting approvals cannot be reused across rules or exceed the aggregate bound");
    const rejected = mandatory.some(
      (policy) =>
        policy.state === "evaluated" &&
        policy.rules.some(({ status }) => status === "non_waivable_violation"),
    );
    const unresolved = mandatory.some(
      (policy) =>
        policy.state === "unavailable" ||
        policy.rules.some(({ status }) => status === "unresolved"),
    );
    const expected =
      value.selectionState !== "current"
        ? "hold"
        : value.mode === "observation_only"
          ? "advisory"
          : rejected
            ? "reject"
            : unresolved
              ? "hold"
              : "proceed";
    if (value.disposition !== expected)
      issue("Disposition must preserve the complete conservative decision table");
    const definition = Object.fromEntries(
      Object.keys(DefinitionShape).map((key) => [key, value[key as keyof typeof value]]),
    );
    if (
      encodeEvaluationCanonicalJson(JSON.parse(JSON.stringify(definition))).byteLength >
      MAX_RELEASE_DECISION_DEFINITION_BYTES
    )
      issue("Decision exceeds its canonical UTF-8 byte ceiling");
  });

export const ReleaseDecisionSchema = ReleaseDecisionDefinitionSchema.safeExtend({
  schemaVersion: z.literal(RELEASE_DECISION_SCHEMA_VERSION),
  definitionSha256: Sha256Schema,
});
export const ReleaseDecisionReferenceSchema = z
  .object({ decisionId: OpaqueIdSchema, definitionSha256: Sha256Schema })
  .strict();

export type ReleaseDecisionDisposition = z.infer<typeof ReleaseDecisionDispositionSchema>;
export type ReleaseDecisionRuleFinding = z.infer<typeof ReleaseDecisionRuleFindingSchema>;
export type ReleaseDecisionPolicyFinding = z.infer<typeof ReleaseDecisionPolicyFindingSchema>;
export type ReleaseDecisionDefinition = z.infer<typeof ReleaseDecisionDefinitionSchema>;
export type ReleaseDecision = z.infer<typeof ReleaseDecisionSchema>;
export type ReleaseDecisionReference = z.infer<typeof ReleaseDecisionReferenceSchema>;
export type CreateReleaseDecisionRequest = z.infer<typeof CreateReleaseDecisionRequestSchema>;
export type ReleaseDecisionAuthoritySnapshotReference = z.infer<
  typeof ReleaseDecisionAuthoritySnapshotReferenceSchema
>;
