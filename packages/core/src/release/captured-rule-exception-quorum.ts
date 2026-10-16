import {
  type CapturedReleaseReviewQuorum,
  type CapturedReleaseReviewQuorumInput,
  resolveCapturedReleaseReviewQuorum,
} from "./captured-normal-approval-quorum.js";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "./release-decision-verification-budget.js";

export class InvalidCapturedRuleExceptionError extends Error {
  readonly code = "captured_rule_exception_invalid";
  constructor(options?: ErrorOptions) {
    super("Invalid complete captured rule-exception census", options);
    this.name = "InvalidCapturedRuleExceptionError";
  }
}

/** Captured eligibility and evidence only; the owning composer derives the installed requirement,
 * known waivable rule and full subject. This does not authenticate or publish a waiver/decision.
 */
export function resolveCapturedRuleExceptionQuorum(
  input: CapturedReleaseReviewQuorumInput & { readonly controls: readonly unknown[] },
): CapturedReleaseReviewQuorum {
  try {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length !== 7 ||
      !["subject", "context", "census", "actors", "capturedAt", "budget", "controls"].every((key) =>
        Object.hasOwn(input, key),
      ) ||
      !(input.budget instanceof ReleaseDecisionVerificationBudget)
    )
      throw new InvalidCapturedRuleExceptionError();
    const { controls, ...review } = input;
    return resolveCapturedReleaseReviewQuorum(review, "rule_exception", controls);
  } catch (cause) {
    if (
      cause instanceof InvalidCapturedRuleExceptionError ||
      cause instanceof ReleaseDecisionVerificationBudgetError
    )
      throw cause;
    throw new InvalidCapturedRuleExceptionError({ cause });
  }
}
