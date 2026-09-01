export type EvaluationRecordKind =
  | "aggregation_policy"
  | "assessment"
  | "criterion_set"
  | "criterion_set_status"
  | "discovery_record"
  | "evaluation_aggregate"
  | "evaluation_run"
  | "evaluation_run_rejection"
  | "evaluation_run_result"
  | "evaluator_spec"
  | "oracle_spec"
  | "qualification_fixture_set"
  | "qualification_report"
  | "raw_observation"
  | "source_review"
  | "source_snapshot";

export type EvaluationResourceKind =
  | "aggregation_policy"
  | "criterion_set"
  | "evaluator"
  | "oracle"
  | "qualification_fixture_set";

export class EvaluationRecordConflictError extends Error {
  readonly code = "evaluation_record_conflict";

  constructor(
    readonly recordKind: EvaluationRecordKind,
    readonly recordId: string,
  ) {
    super(`${recordKind} record ${recordId} is already bound to different immutable semantics`);
    this.name = "EvaluationRecordConflictError";
  }
}

export class EvaluationResourceConflictError extends Error {
  readonly code = "evaluation_resource_conflict";

  constructor(
    readonly resourceKind: EvaluationResourceKind,
    readonly resourceId: string,
  ) {
    super(`${resourceKind} resource ${resourceId} is already bound to a different tenant scope`);
    this.name = "EvaluationResourceConflictError";
  }
}

export class EvaluationLineageError extends Error {
  readonly code = "evaluation_lineage_invalid";

  constructor(
    readonly recordKind: EvaluationRecordKind,
    readonly recordId: string,
    readonly referenceKind: EvaluationRecordKind,
    readonly referenceId: string,
  ) {
    super(
      `${recordKind} record ${recordId} references unavailable or conflicting ${referenceKind} record ${referenceId}`,
    );
    this.name = "EvaluationLineageError";
  }
}

export class EvaluationRecordNotFoundError extends Error {
  readonly code = "evaluation_record_not_found";

  constructor(
    readonly recordKind: EvaluationRecordKind,
    readonly recordId: string,
  ) {
    super(`${recordKind} record ${recordId} was not found in the authorized scope`);
    this.name = "EvaluationRecordNotFoundError";
  }
}

export class EvaluationRepositoryContractError extends Error {
  readonly code = "evaluation_repository_contract_violation";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EvaluationRepositoryContractError";
  }
}
