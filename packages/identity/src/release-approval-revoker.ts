import type {
  ReleaseApprovalPublicationMaterial,
  ReleaseApprovalRevocation,
} from "@proofstack/contracts";
import type { ReleaseDecisionVerificationUsage } from "@proofstack/core";
import type { ReleaseBrowserMutationCredentials } from "./release-mutation-authentication.js";

export interface ReleaseApprovalRevokerResult {
  readonly created: boolean;
  readonly record: ReleaseApprovalRevocation;
  readonly publication: ReleaseApprovalPublicationMaterial["publication"];
  readonly usage: ReleaseDecisionVerificationUsage;
}

/** A currently authenticated reviewer withdraws only their own exact original approval. This
 * does not require retaining expertise or an active target and never creates release authority.
 */
export interface ReleaseApprovalRevoker {
  revokeApproval(
    credentials: ReleaseBrowserMutationCredentials,
    intent: unknown,
  ): Promise<ReleaseApprovalRevokerResult>;
}
