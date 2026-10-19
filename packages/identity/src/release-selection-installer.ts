import type { ReleaseSelectionPublicationMaterial } from "@proofstack/contracts";
import type { ReleaseDecisionVerificationUsage } from "@proofstack/core";
import type { ReleaseBrowserMutationCredentials } from "./release-mutation-authentication.js";

export interface ReleaseSelectionInstallerResult {
  readonly created: boolean;
  readonly record: ReleaseSelectionPublicationMaterial["source"]["record"];
  readonly publication: ReleaseSelectionPublicationMaterial["publication"];
  readonly usage: ReleaseDecisionVerificationUsage;
}

/** Installed authentication and atomic original publication, never a caller-supplied principal.
 * Native implementations retain their guarded transaction; an explicit synthetic memory reference
 * commits one complete owning state. A returned receipt is historical, not current gate authority.
 */
export interface ReleaseSelectionInstaller {
  publishSelection(
    credentials: ReleaseBrowserMutationCredentials,
    intent: unknown,
  ): Promise<ReleaseSelectionInstallerResult>;
  publishLifecycle(
    credentials: ReleaseBrowserMutationCredentials,
    intent: unknown,
  ): Promise<ReleaseSelectionInstallerResult>;
}
