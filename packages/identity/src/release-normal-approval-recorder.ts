import type { ReleaseApproval, ReleaseApprovalPublication } from "@proofstack/contracts";
import type { ReleaseDecisionVerificationUsage } from "@proofstack/core";
import type { ReleaseBrowserMutationCredentials } from "./release-mutation-authentication.js";

export interface ReleaseNormalApprovalRecorderResult {
  readonly created: boolean;
  readonly record: ReleaseApproval;
  readonly publication: ReleaseApprovalPublication;
  readonly usage: ReleaseDecisionVerificationUsage;
}

/** Actual OIDC action plus owning current subject, selection, policy, reviewer and basis reads.
 * The four normal-review dispositions are attributable actions, never a release decision or an
 * exception. Implementations must reject rule_exception rather than invent evaluator authority.
 */
export interface ReleaseNormalApprovalRecorder {
  recordNormalApproval(
    credentials: ReleaseBrowserMutationCredentials,
    intent: unknown,
  ): Promise<ReleaseNormalApprovalRecorderResult>;
}
