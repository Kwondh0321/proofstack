import type {
  ComparisonDefinition,
  ComparisonEvidenceSnapshot,
  ComparisonResult,
  EvidenceScope,
} from "@proofstack/contracts";

export type ComparisonRecordKind =
  | "comparison_definition"
  | "comparison_evidence_snapshot"
  | "comparison_result";

export type ComparisonRecord = ComparisonDefinition | ComparisonEvidenceSnapshot | ComparisonResult;

export interface PublishComparisonRecordResult<Record> {
  readonly created: boolean;
  readonly record: Record;
}

/**
 * Exact-scope persistence boundary for immutable comparison definitions, evidence snapshots, and
 * derived results.
 *
 * Implementations must strict-parse and independently recompute the canonical definition digest
 * before publication. Identical retries return the original authoritative record; conflicting
 * retries write nothing. Reads deliberately return `null` for both absence and inaccessible scope.
 */
export interface ComparisonRepository {
  findComparisonDefinition(
    scope: EvidenceScope,
    comparisonVersionId: string,
  ): Promise<ComparisonDefinition | null>;
  findComparisonEvidenceSnapshot(
    scope: EvidenceScope,
    snapshotId: string,
  ): Promise<ComparisonEvidenceSnapshot | null>;
  findComparisonResult(scope: EvidenceScope, resultId: string): Promise<ComparisonResult | null>;
  publishComparisonDefinition(
    candidate: ComparisonDefinition,
  ): Promise<PublishComparisonRecordResult<ComparisonDefinition>>;
  publishComparisonEvidenceSnapshot(
    candidate: ComparisonEvidenceSnapshot,
  ): Promise<PublishComparisonRecordResult<ComparisonEvidenceSnapshot>>;
  publishComparisonResult(
    candidate: ComparisonResult,
  ): Promise<PublishComparisonRecordResult<ComparisonResult>>;
}
