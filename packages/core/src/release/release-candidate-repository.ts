import type { EvidenceScope, ReleaseCandidate } from "@proofstack/contracts";

export interface PublishReleaseCandidateResult {
  readonly candidate: ReleaseCandidate;
  readonly created: boolean;
}

/**
 * Exact-scope persistence boundary for immutable release candidate versions.
 *
 * Implementations must strict-parse and independently recompute the canonical definition digest.
 * Identical retries return the original authoritative record, conflicting retries write nothing,
 * and inaccessible scopes are indistinguishable from absent records.
 */
export interface ReleaseCandidateRepository {
  findReleaseCandidate(
    scope: EvidenceScope,
    candidateVersionId: string,
  ): Promise<ReleaseCandidate | null>;
  publishReleaseCandidate(candidate: ReleaseCandidate): Promise<PublishReleaseCandidateResult>;
}
