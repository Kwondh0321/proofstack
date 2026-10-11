import type { ComparisonDefinition, EvidenceScope } from "@proofstack/contracts";
import type { ComparisonRecordKind } from "./comparison-repository.js";
import { InvalidComparisonRecordInputError } from "./comparison-repository-errors.js";

export function requireComparisonLogicalRootKind(kind: unknown): ComparisonRecordKind {
  switch (kind) {
    case "comparison_definition":
    case "comparison_evidence_snapshot":
    case "comparison_result":
      return kind;
    default:
      throw new InvalidComparisonRecordInputError(
        "Comparison logical-root reads require a supported record kind",
      );
  }
}

/**
 * Read the owning original definition bound to an exact stored definition, snapshot or result.
 * Keep its full original receipt and return an owned body. Absence and foreign scope return null;
 * corrupt in-scope storage fails. This is a storage observation, not current release authority.
 */
export interface ComparisonLogicalRootReader {
  findComparisonLogicalRoot(
    scope: EvidenceScope,
    kind: ComparisonRecordKind,
    recordId: string,
  ): Promise<ComparisonDefinition | null>;
}
