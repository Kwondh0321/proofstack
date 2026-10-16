import type {
  EvidenceScope,
  ReleaseReviewerAuthority,
  ReleaseReviewerAuthorityLifecycleEvent,
} from "@proofstack/contracts";
import type { ReleaseDecisionVerificationBudget } from "./release-decision-verification-budget.js";

export interface ReleaseReviewerAuthorityTarget {
  readonly installationId: string;
  readonly gateTargetId: string;
  readonly reviewerPrincipalId: string;
}
export interface OwnedReleaseReviewerAuthorityTarget {
  /** Original stored reviewer root, not a caller-chosen version or latest effective authority. */
  readonly root: ReleaseReviewerAuthority | null;
  readonly records: readonly ReleaseReviewerAuthority[];
  readonly lifecycle: readonly ReleaseReviewerAuthorityLifecycleEvent[];
}

/** Trusted persistence only. Authority issuer authorization/private authentication and guarded native publication are separate. */
export interface ReleaseReviewerAuthorityRepository {
  findReleaseReviewerAuthority(
    scope: EvidenceScope,
    versionId: string,
  ): Promise<ReleaseReviewerAuthority | null>;
  findReleaseReviewerAuthorityLifecycleEvent(
    scope: EvidenceScope,
    eventId: string,
  ): Promise<ReleaseReviewerAuthorityLifecycleEvent | null>;
  publishReleaseReviewerAuthority(record: ReleaseReviewerAuthority): Promise<{
    readonly created: boolean;
    readonly authority: ReleaseReviewerAuthority;
  }>;
  publishReleaseReviewerAuthorityLifecycleEvent(
    event: ReleaseReviewerAuthorityLifecycleEvent,
  ): Promise<{
    readonly created: boolean;
    readonly event: ReleaseReviewerAuthorityLifecycleEvent;
  }>;
  /** Derive the immutable logical owner from the exact target, then read its ENTIRE version/history inventory.
   * Charge the original shared meter before returning any data; never truncate, select latest, or
   * omit revocations/competing/future-effective versions. An exception taints that same cut.
   * This read alone supplies neither current publication authority nor a held native guard.
   */
  readReleaseReviewerAuthorityTarget(
    scope: EvidenceScope,
    target: ReleaseReviewerAuthorityTarget,
    budget: ReleaseDecisionVerificationBudget,
  ): Promise<OwnedReleaseReviewerAuthorityTarget>;
}

export class ReleaseReviewerAuthorityRepositoryError extends Error {
  readonly code = "release_reviewer_authority_repository_invalid";
  constructor(
    readonly reason:
      | "version_conflict"
      | "target_conflict"
      | "lineage_invalid"
      | "event_conflict"
      | "terminal_conflict"
      | "receipt_invalid"
      | "storage_invalid",
    options?: ErrorOptions,
  ) {
    super(`Invalid release reviewer authority persistence: ${reason}`, options);
    this.name = "ReleaseReviewerAuthorityRepositoryError";
  }
}
