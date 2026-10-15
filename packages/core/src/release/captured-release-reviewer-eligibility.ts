import {
  EvidenceScopeSchema,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
  OpaqueIdSchema,
  PolicyApprovalRequirementSchema,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
  ReleaseApprovalReviewerReceiptSchema,
  ReleaseDecisionIdentityReferenceSchema,
  ReleaseDecisionCredentialObservationSchema,
  ReleaseReviewerAuthorityReferenceSchema,
  type EvidenceScope,
  type ReleaseApprovalReviewerReceipt,
  type ReleaseDecisionCredentialObservation,
  type ReleaseDecisionIdentityObservation,
  type ReleaseDecisionIdentityReference,
  type ReleaseReviewerAuthorityReference,
} from "@proofstack/contracts";
import { inspectCapturedReleaseIdentityState } from "./captured-release-identity-state.js";
import {
  resolveCapturedReleaseReviewerCensus,
  type ReleaseReviewerCensus,
} from "./release-reviewer-census.js";
import {
  type ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "./release-decision-verification-budget.js";

export interface CapturedReleaseReviewContext {
  readonly purpose: "normal_approval" | "rule_exception";
  readonly requirement: ReturnType<typeof PolicyApprovalRequirementSchema.parse>;
  readonly candidateAuthorPrincipalId: string;
  readonly policyAuthorPrincipalId: string;
  readonly evaluatorPrincipalIds: readonly string[] | null;
}
export function validateCapturedReleaseReviewContext(
  input: CapturedReleaseReviewContext,
): CapturedReleaseReviewContext {
  const value = structuredClone(input);
  const keys = [
    "purpose",
    "requirement",
    "candidateAuthorPrincipalId",
    "policyAuthorPrincipalId",
    "evaluatorPrincipalIds",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key)) ||
    !["normal_approval", "rule_exception"].includes(value.purpose)
  )
    throw new InvalidCapturedReleaseReviewerError();
  const evaluators = value.evaluatorPrincipalIds;
  if (
    evaluators !== null &&
    (!Array.isArray(evaluators) ||
      evaluators.length > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS ||
      evaluators.some((id) => !OpaqueIdSchema.safeParse(id).success) ||
      new Set(evaluators).size !== evaluators.length)
  )
    throw new InvalidCapturedReleaseReviewerError();
  return {
    purpose: value.purpose,
    requirement: PolicyApprovalRequirementSchema.parse(value.requirement),
    candidateAuthorPrincipalId: OpaqueIdSchema.parse(value.candidateAuthorPrincipalId),
    policyAuthorPrincipalId: OpaqueIdSchema.parse(value.policyAuthorPrincipalId),
    evaluatorPrincipalIds: evaluators === null ? null : [...evaluators],
  };
}
export type CapturedReleaseReviewerEligibility =
  | {
      readonly state: "eligible";
      readonly principalId: string;
      readonly groupIds: readonly string[];
      readonly independentHuman: boolean;
      readonly assurance: "operator_verified" | "synthetic_reference";
      readonly authorityExpiresAt: string;
    }
  | {
      readonly state: "unavailable";
      readonly reason:
        | "authority_unavailable"
        | "identity_unavailable"
        | "evaluator_provenance_unavailable";
    }
  | {
      readonly state: "ineligible";
      readonly reason:
        | "authority_inactive"
        | "authority_unverified"
        | "role_missing"
        | "group_missing"
        | "identity_ineligible"
        | "subject_author"
        | "subject_evaluator";
    };
export class InvalidCapturedReleaseReviewerError extends Error {
  readonly code = "captured_release_reviewer_invalid";
  constructor(options?: ErrorOptions) {
    super("Invalid captured release reviewer eligibility", options);
    this.name = "InvalidCapturedReleaseReviewerError";
  }
}

/**
 * Inspect captured preimages only, never authenticate or hold publication guards. The fixed owning
 * composition must derive context from the original policy/candidate/result and exact sealed source
 * bodies; callers cannot supply author/evaluator lists or reviewer power through a public request.
 * A null evaluator inventory cannot qualify an exception. Declarations never certify expertise.
 */
export function inspectCapturedReleaseReviewerEligibility(input: {
  readonly scope: EvidenceScope;
  readonly reference: ReleaseReviewerAuthorityReference;
  readonly census: ReleaseReviewerCensus;
  readonly receipt: ReleaseApprovalReviewerReceipt;
  readonly identity: ReleaseDecisionIdentityReference;
  readonly grant: ReleaseDecisionIdentityObservation;
  readonly credential: ReleaseDecisionCredentialObservation;
  readonly context: CapturedReleaseReviewContext;
  readonly recordedAt: string;
  readonly capturedAt: string;
  readonly budget: ReleaseDecisionVerificationBudget;
}): CapturedReleaseReviewerEligibility {
  try {
    const scope = EvidenceScopeSchema.parse(input.scope);
    const reference = ReleaseReviewerAuthorityReferenceSchema.parse(input.reference);
    const receipt = ReleaseApprovalReviewerReceiptSchema.parse(input.receipt);
    const identity = ReleaseDecisionIdentityReferenceSchema.parse(input.identity);
    const context = validateCapturedReleaseReviewContext(input.context);
    const at = PolicyEvaluationTimeSchema.parse(input.capturedAt);
    const recordedAt = policyEvaluationTimestampOrderKey(
      PolicyEvaluationTimeSchema.parse(input.recordedAt),
    );
    if (
      recordedAt < policyEvaluationTimestampOrderKey(receipt.authenticatedAt) ||
      recordedAt > policyEvaluationTimestampOrderKey(at)
    )
      throw new InvalidCapturedReleaseReviewerError();
    if (reference.reviewerPrincipalId !== receipt.principalId || identity.kind !== "oidc_binding")
      throw new InvalidCapturedReleaseReviewerError();
    const census = resolveCapturedReleaseReviewerCensus({
      scope,
      reference,
      census: input.census,
      capturedAt: at,
      budget: input.budget,
    });
    const currentIdentity = inspectCapturedReleaseIdentityState({
      scope,
      receipt,
      identity,
      grant: input.grant,
      credential: input.credential,
      capturedAt: at,
      operation: "retain_review",
      budget: input.budget,
    });
    if (census.state === "unavailable" || census.state === "conflicting" || !census.original)
      return { state: "unavailable", reason: "authority_unavailable" };
    const authority = census.original;
    if (census.state !== "current") return { state: "ineligible", reason: "authority_inactive" };
    if (
      policyEvaluationTimestampOrderKey(authority.publishedAt) > recordedAt ||
      policyEvaluationTimestampOrderKey(authority.effectiveAt) > recordedAt ||
      policyEvaluationTimestampOrderKey(authority.expiresAt) <= recordedAt
    )
      return { state: "ineligible", reason: "authority_inactive" };
    if (authority.status !== "verified" || authority.conflicts.length > 0)
      return { state: "ineligible", reason: "authority_unverified" };
    if (currentIdentity.state === "unavailable")
      return { state: "unavailable", reason: "identity_unavailable" };
    if (currentIdentity.state !== "eligible")
      return { state: "ineligible", reason: "identity_ineligible" };
    const credential = ReleaseDecisionCredentialObservationSchema.parse(input.credential);
    if (
      credential.state !== "observed" ||
      credential.record.kind !== "oidc_session" ||
      policyEvaluationTimestampOrderKey(credential.record.createdAt) > recordedAt ||
      policyEvaluationTimestampOrderKey(credential.record.absoluteExpiresAt) <= recordedAt
    )
      return { state: "ineligible", reason: "identity_ineligible" };
    if (!authority.roleIds.some((role) => context.requirement.reviewerRoleIds.includes(role)))
      return { state: "ineligible", reason: "role_missing" };
    const groupIds = authority.independenceGroupIds.filter((group) =>
      context.requirement.independenceGroupIds.includes(group),
    );
    if (groupIds.length === 0) return { state: "ineligible", reason: "group_missing" };
    const principal = receipt.principalId;
    const independentHuman =
      principal !== context.candidateAuthorPrincipalId &&
      principal !== context.policyAuthorPrincipalId;
    if (
      principal === context.policyAuthorPrincipalId ||
      ((context.requirement.excludeCandidateAuthor || context.purpose === "rule_exception") &&
        principal === context.candidateAuthorPrincipalId)
    )
      return { state: "ineligible", reason: "subject_author" };
    if (context.purpose === "rule_exception") {
      if (context.evaluatorPrincipalIds === null)
        return { state: "unavailable", reason: "evaluator_provenance_unavailable" };
      if (context.evaluatorPrincipalIds.includes(principal))
        return { state: "ineligible", reason: "subject_evaluator" };
    }
    return {
      state: "eligible",
      principalId: principal,
      groupIds,
      independentHuman,
      assurance: authority.assurance,
      authorityExpiresAt: authority.expiresAt,
    };
  } catch (cause) {
    if (
      cause instanceof InvalidCapturedReleaseReviewerError ||
      cause instanceof ReleaseDecisionVerificationBudgetError
    )
      throw cause;
    throw new InvalidCapturedReleaseReviewerError({ cause });
  }
}
