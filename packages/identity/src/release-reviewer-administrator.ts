import type { ReleaseReviewerPublicationMaterial } from "@proofstack/contracts";
import type { ReleaseDecisionVerificationUsage } from "@proofstack/core";
import type { ReleaseBrowserMutationCredentials } from "./release-mutation-authentication.js";

export interface ReleaseReviewerAdministratorResult {
  readonly created: boolean;
  readonly record: ReleaseReviewerPublicationMaterial["source"]["record"];
  readonly publication: ReleaseReviewerPublicationMaterial["publication"];
  readonly usage: ReleaseDecisionVerificationUsage;
}

/** Actual user authentication and original atomic declaration publication, not reviewer expertise,
 * approval, current basis-content verification or authority to publish a release decision.
 */
export interface ReleaseReviewerAdministrator {
  publishReviewerAuthority(
    credentials: ReleaseBrowserMutationCredentials,
    intent: unknown,
  ): Promise<ReleaseReviewerAdministratorResult>;
  publishReviewerAuthorityLifecycle(
    credentials: ReleaseBrowserMutationCredentials,
    intent: unknown,
  ): Promise<ReleaseReviewerAdministratorResult>;
}
