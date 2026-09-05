import type { ComparisonRecordKind } from "./comparison-repository.js";

export class ComparisonRecordConflictError extends Error {
  readonly code = "comparison_record_conflict";

  constructor(
    readonly recordKind: ComparisonRecordKind,
    readonly recordId: string,
  ) {
    super(`${recordKind} record ${recordId} is already bound to different immutable semantics`);
    this.name = "ComparisonRecordConflictError";
  }
}

export class ComparisonResourceConflictError extends Error {
  readonly code = "comparison_resource_conflict";

  constructor(readonly comparisonId: string) {
    super(`Comparison resource ${comparisonId} is already bound to a different tenant scope`);
    this.name = "ComparisonResourceConflictError";
  }
}

export class ComparisonLineageError extends Error {
  readonly code = "comparison_lineage_invalid";

  constructor(
    readonly recordKind: ComparisonRecordKind,
    readonly recordId: string,
    readonly referenceKind: ComparisonRecordKind,
    readonly referenceId: string,
  ) {
    super(
      `${recordKind} record ${recordId} references unavailable or conflicting ${referenceKind} record ${referenceId}`,
    );
    this.name = "ComparisonLineageError";
  }
}

export class InvalidComparisonRecordInputError extends TypeError {
  readonly code = "comparison_record_input_invalid";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidComparisonRecordInputError";
  }
}

export class ComparisonRepositoryContractError extends Error {
  readonly code = "comparison_repository_contract_violation";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ComparisonRepositoryContractError";
  }
}
