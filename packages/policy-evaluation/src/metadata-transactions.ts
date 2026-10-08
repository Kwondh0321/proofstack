import type { EvidenceScope } from "@proofstack/contracts";
import type { CriterionStatusHistoryRepository, ExactEvidenceRepository } from "@proofstack/core";
import type { InteractionFixtureVersionRepository } from "@proofstack/datasets";
import type { PolicyEvaluationSourceRecheckPorts } from "./recheck-captured-sources.js";
import type { PolicyRecordGraphRepositories } from "./record-routing.js";

/** Fixed read-only ports, valid only within one guarded exact-scope transaction. */
export interface PolicyEvaluationMetadataPorts {
  readonly sources: PolicyEvaluationSourceRecheckPorts;
  readonly records: PolicyRecordGraphRepositories;
  readonly evidence: Pick<ExactEvidenceRepository, "resolveExactEvents">;
  readonly criterionStatusHistory: CriterionStatusHistoryRepository;
  /** Database ownership/availability metadata only; never object or key I/O. */
  readonly fixtureContent: Pick<
    InteractionFixtureVersionRepository,
    "findRecordedInteractionFixtureContent"
  >;
}

/**
 * The adapter acquires the complete metadata barrier and verifies the migration ledger before
 * exposing ports. Read-only callback results are historical after transaction completion, not
 * complete authority, a sealed snapshot, or permission to publish later.
 */
export interface PolicyEvaluationMetadataTransactions {
  runMetadata<T>(
    scope: EvidenceScope,
    operation: (ports: PolicyEvaluationMetadataPorts) => Promise<T>,
  ): Promise<T>;
}
