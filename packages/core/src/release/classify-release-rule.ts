import {
  PolicyEvaluationRuleResultSchema,
  ReleasePolicyRuleSchema,
  type PolicyEvaluationRuleResult,
  type ReleasePolicyRule,
} from "@proofstack/contracts";

const POLICY_STATES = [
  "active",
  "not_effective",
  "expired",
  "withdrawn",
  "superseded",
  "authority_unavailable",
] as const;
const REVIEW_STATES = [
  "unavailable",
  "insufficient",
  "conditions_unresolved",
  "conflicted",
  "opposed",
  "escalated",
  "matched",
] as const;

export interface ReleaseRuleClassificationInput {
  readonly rule: ReleasePolicyRule;
  readonly result: PolicyEvaluationRuleResult;
  readonly applicability: "match" | "mismatch" | "unknown";
  readonly candidateAuthority: "qualified" | "unqualified" | "unavailable";
  readonly originalPolicyState: (typeof POLICY_STATES)[number];
  readonly currentPolicyState: (typeof POLICY_STATES)[number];
  readonly normalApproval: (typeof REVIEW_STATES)[number];
  readonly ruleException: (typeof REVIEW_STATES)[number];
}

export class InvalidReleaseRuleObservationError extends Error {
  readonly code = "release_rule_observation_invalid";
  constructor(options?: ErrorOptions) {
    super("Invalid original rule or decision-table observations", options);
    this.name = "InvalidReleaseRuleObservationError";
  }
}

function member<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value))
    throw new InvalidReleaseRuleObservationError();
  return value;
}

function parse(input: ReleaseRuleClassificationInput): ReleaseRuleClassificationInput {
  try {
    const keys = [
      "rule",
      "result",
      "applicability",
      "candidateAuthority",
      "originalPolicyState",
      "currentPolicyState",
      "normalApproval",
      "ruleException",
    ] as const;
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      Object.keys(input).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(input, key))
    )
      throw new InvalidReleaseRuleObservationError();
    const rule = ReleasePolicyRuleSchema.parse(input.rule);
    const result = PolicyEvaluationRuleResultSchema.parse(input.result);
    if (rule.ruleId !== result.ruleId || rule.predicate.kind !== result.predicateKind)
      throw new InvalidReleaseRuleObservationError();
    return {
      rule,
      result,
      applicability: member(input.applicability, ["match", "mismatch", "unknown"] as const),
      candidateAuthority: member(input.candidateAuthority, [
        "qualified",
        "unqualified",
        "unavailable",
      ] as const),
      originalPolicyState: member(input.originalPolicyState, POLICY_STATES),
      currentPolicyState: member(input.currentPolicyState, POLICY_STATES),
      normalApproval: member(input.normalApproval, REVIEW_STATES),
      ruleException: member(input.ruleException, REVIEW_STATES),
    };
  } catch (cause) {
    if (cause instanceof InvalidReleaseRuleObservationError) throw cause;
    throw new InvalidReleaseRuleObservationError({ cause });
  }
}
export type ReleaseRuleClassification = {
  readonly status: "satisfied" | "unresolved" | "non_waivable_violation";
  readonly originalOutcome: ReleaseRuleClassificationInput["result"]["outcome"];
  readonly reason:
    | "evaluation_satisfied"
    | "normal_approval_applied"
    | "scoped_exception_applied"
    | "original_policy_unavailable"
    | "current_policy_unavailable"
    | "candidate_authority_unverified"
    | "policy_inapplicable"
    | "policy_applicability_unknown"
    | "evidence_indeterminate"
    | "non_waivable_violation"
    | "normal_approval_unavailable"
    | "exception_unavailable"
    | "review_opposed"
    | "review_escalated";
};

/**
 * Internal decision-table primitive, not an authority resolver or public input contract.
 * The owning composer must derive original/current policy and review states from the complete
 * actual graph. A matched label is not proof of a quorum, session, human or publication authority.
 * Native publication must independently retain current guards through its atomic write.
 */
export function classifyReleaseRule(
  input: ReleaseRuleClassificationInput,
): ReleaseRuleClassification {
  const value = parse(input);
  const unresolved = (reason: ReleaseRuleClassification["reason"]): ReleaseRuleClassification => ({
    status: "unresolved",
    originalOutcome: value.result.outcome,
    reason,
  });
  const satisfied = (reason: ReleaseRuleClassification["reason"]): ReleaseRuleClassification => ({
    status: "satisfied",
    originalOutcome: value.result.outcome,
    reason,
  });
  // C3 deliberately leaves approval_required unresolved before these original-policy checks.
  // A matching review must not launder an approval-only incompatible or unauthorized policy.
  if (value.originalPolicyState !== "active") return unresolved("original_policy_unavailable");
  if (value.currentPolicyState !== "active") return unresolved("current_policy_unavailable");
  if (value.candidateAuthority !== "qualified") return unresolved("candidate_authority_unverified");
  if (value.applicability === "mismatch" || value.result.outcome === "not_applicable")
    return unresolved("policy_inapplicable");
  if (value.applicability === "unknown") return unresolved("policy_applicability_unknown");

  if (value.rule.predicate.kind === "approval_required") {
    if (value.normalApproval === "opposed") return unresolved("review_opposed");
    if (value.normalApproval === "escalated") return unresolved("review_escalated");
    return value.normalApproval === "matched"
      ? satisfied("normal_approval_applied")
      : unresolved("normal_approval_unavailable");
  }
  if (value.result.outcome === "satisfied") return satisfied("evaluation_satisfied");
  if (value.result.outcome === "indeterminate") return unresolved("evidence_indeterminate");
  if (value.rule.nonWaivable)
    return {
      status: "non_waivable_violation",
      originalOutcome: value.result.outcome,
      reason: "non_waivable_violation",
    };
  if (value.ruleException === "opposed") return unresolved("review_opposed");
  if (value.ruleException === "escalated") return unresolved("review_escalated");
  return value.ruleException === "matched"
    ? satisfied("scoped_exception_applied")
    : unresolved("exception_unavailable");
}
