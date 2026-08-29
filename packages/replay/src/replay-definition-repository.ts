import type { EvidenceScope, ReplayPlan, TargetRelease } from "@proofstack/contracts";

export interface PublishReplayDefinitionResult<Definition> {
  readonly created: boolean;
  readonly definition: Definition;
}

/**
 * Atomic control-plane persistence boundary for immutable replay definitions.
 *
 * Implementations bind logical and version identifiers tenant-wide, hide values outside the exact
 * authorized scope, validate semantic digests, resolve every target-release reference, and append
 * one canonical publication intent with each newly stored definition. Identical retries return the
 * authoritative original value; conflicting retries write nothing.
 */
export interface ReplayDefinitionRepository {
  findReplayPlan(scope: EvidenceScope, planVersionId: string): Promise<ReplayPlan | null>;

  findTargetRelease(scope: EvidenceScope, targetReleaseId: string): Promise<TargetRelease | null>;

  publishReplayPlan(candidate: ReplayPlan): Promise<PublishReplayDefinitionResult<ReplayPlan>>;

  publishTargetRelease(
    candidate: TargetRelease,
  ): Promise<PublishReplayDefinitionResult<TargetRelease>>;
}
