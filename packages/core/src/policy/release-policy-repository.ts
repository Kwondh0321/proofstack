import type {
  EvidenceScope,
  ReleasePolicy,
  ReleasePolicyLifecycleEvent,
} from "@proofstack/contracts";

export interface PublishReleasePolicyResult {
  readonly created: boolean;
  readonly policy: ReleasePolicy;
}

export interface PublishReleasePolicyLifecycleResult {
  readonly created: boolean;
  readonly event: ReleasePolicyLifecycleEvent;
}

/**
 * Exact-scope persistence boundary for immutable policy versions and terminal lifecycle events.
 *
 * Implementations must independently validate records, preserve the first authoritative receipt
 * on identical retries, reject conflicting identifiers atomically, and return null for both
 * absence and data outside the exact authorized scope. Lifecycle history is ordered by
 * `(occurredAt, eventId)` and a policy version accepts at most one terminal event.
 */
export interface ReleasePolicyRepository {
  findReleasePolicy(scope: EvidenceScope, policyVersionId: string): Promise<ReleasePolicy | null>;
  findReleasePolicyLifecycleEvent(
    scope: EvidenceScope,
    eventId: string,
  ): Promise<ReleasePolicyLifecycleEvent | null>;
  listReleasePolicyLifecycleEvents(
    scope: EvidenceScope,
    policyVersionId: string,
  ): Promise<readonly ReleasePolicyLifecycleEvent[]>;
  publishReleasePolicy(policy: ReleasePolicy): Promise<PublishReleasePolicyResult>;
  publishReleasePolicyLifecycleEvent(
    event: ReleasePolicyLifecycleEvent,
  ): Promise<PublishReleasePolicyLifecycleResult>;
}

/**
 * Read-only access to the original logical resource binding of an exact stored policy version.
 * The owner derives the root from retained storage, never from a caller-selected version,
 * publication timestamp, predecessor traversal, or latest lookup. The complete original root
 * receipt is returned as an owned copy after validating both the requested version and its root.
 * Absence and outside-scope versions return null; incomplete or corrupt in-scope storage fails.
 * This observation does not establish current authority or retain publication guards.
 */
export interface ReleasePolicyLogicalRootReader {
  findReleasePolicyLogicalRoot(
    scope: EvidenceScope,
    policyVersionId: string,
  ): Promise<ReleasePolicy | null>;
}
