import type {
  EvidenceScope,
  ReleasePolicySelection,
  ReleasePolicySelectionLifecycleEvent,
} from "@proofstack/contracts";
import type { ReleaseDecisionVerificationBudget } from "./release-decision-verification-budget.js";

export interface ReleasePolicySelectionTarget {
  readonly installationId: string;
  readonly gateTargetId: string;
}
export interface OwnedReleasePolicySelectionTarget {
  /** Original stored root, not a caller-chosen version or latest effective selection. */
  readonly root: ReleasePolicySelection | null;
  readonly records: readonly ReleasePolicySelection[];
  readonly lifecycle: readonly ReleasePolicySelectionLifecycleEvent[];
}

/** Trusted persistence only. Installation authorization/private authentication and guarded native publication are separate. */
export interface ReleasePolicySelectionRepository {
  findReleasePolicySelection(
    scope: EvidenceScope,
    versionId: string,
  ): Promise<ReleasePolicySelection | null>;
  findReleasePolicySelectionLifecycleEvent(
    scope: EvidenceScope,
    eventId: string,
  ): Promise<ReleasePolicySelectionLifecycleEvent | null>;
  publishReleasePolicySelection(record: ReleasePolicySelection): Promise<{
    readonly created: boolean;
    readonly selection: ReleasePolicySelection;
  }>;
  publishReleasePolicySelectionLifecycleEvent(
    event: ReleasePolicySelectionLifecycleEvent,
  ): Promise<{
    readonly created: boolean;
    readonly event: ReleasePolicySelectionLifecycleEvent;
  }>;
  /** Derive the immutable logical owner from the exact target, then read its ENTIRE version/history inventory.
   * Charge the original shared meter before returning any data; never truncate, select latest, or
   * omit withdrawals/competing/future-effective versions. An exception taints that same cut.
   * This read alone supplies neither current publication authority nor a held native guard.
   */
  readReleasePolicySelectionTarget(
    scope: EvidenceScope,
    target: ReleasePolicySelectionTarget,
    budget: ReleaseDecisionVerificationBudget,
  ): Promise<OwnedReleasePolicySelectionTarget>;
}

export class ReleasePolicySelectionRepositoryError extends Error {
  readonly code = "release_policy_selection_repository_invalid";
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
    super(`Invalid release policy selection persistence: ${reason}`, options);
    this.name = "ReleasePolicySelectionRepositoryError";
  }
}
