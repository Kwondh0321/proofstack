import type {
  RecordedBoundaryMismatchCode,
  RecordedBoundaryReplayObservation,
} from "@proofstack/contracts";

export type RecordedBoundaryReplayPreflightErrorCode =
  | "invalid_invocation"
  | "invalid_target_adapter"
  | "target_adapter_mismatch"
  | "invalid_content_export"
  | "fixture_identity_mismatch"
  | "fixture_definition_invalid"
  | "fixture_content_unavailable"
  | "artifact_content_invalid"
  | "runtime_profile_unsupported";

export class RecordedBoundaryReplayPreflightError extends Error {
  readonly code: RecordedBoundaryReplayPreflightErrorCode;

  constructor(code: RecordedBoundaryReplayPreflightErrorCode, options?: ErrorOptions) {
    super(`Recorded-boundary replay preflight failed: ${code}`, options);
    this.name = "RecordedBoundaryReplayPreflightError";
    this.code = code;
  }
}

export type RecordedBoundaryTargetContractErrorCode =
  | "invalid_boundary_request"
  | "duplicate_boundary_request_id"
  | "resolver_closed";

export class RecordedBoundaryTargetContractError extends Error {
  readonly code: RecordedBoundaryTargetContractErrorCode;

  constructor(code: RecordedBoundaryTargetContractErrorCode, options?: ErrorOptions) {
    super(`Recorded-boundary target contract failed: ${code}`, options);
    this.name = "RecordedBoundaryTargetContractError";
    this.code = code;
  }
}

export class RecordedBoundaryMismatchError extends Error {
  readonly code: RecordedBoundaryMismatchCode;
  readonly observation: Extract<RecordedBoundaryReplayObservation, { status: "mismatch" }>;

  constructor(
    code: RecordedBoundaryMismatchCode,
    observation: Extract<RecordedBoundaryReplayObservation, { status: "mismatch" }>,
  ) {
    super(`Recorded boundary request mismatch: ${code}`);
    this.name = "RecordedBoundaryMismatchError";
    this.code = code;
    this.observation = structuredClone(observation);
  }
}

export type RecordedBoundaryRuntimeControlErrorCode =
  | "random_request_out_of_range"
  | "random_budget_exhausted"
  | "runtime_controls_closed";

export class RecordedBoundaryRuntimeControlError extends Error {
  readonly code: RecordedBoundaryRuntimeControlErrorCode;

  constructor(code: RecordedBoundaryRuntimeControlErrorCode) {
    super(`Recorded-boundary runtime control failed: ${code}`);
    this.name = "RecordedBoundaryRuntimeControlError";
    this.code = code;
  }
}

export type ReplayTargetProcessProtocolErrorCode =
  | "boundary_response_mismatch"
  | "duplicate_request_id"
  | "invalid_start_message"
  | "invalid_target_message"
  | "invalid_worker_message"
  | "random_response_mismatch"
  | "request_sequence_mismatch"
  | "session_closed"
  | "session_mismatch"
  | "target_adapter_mismatch"
  | "unexpected_message"
  | "unknown_boundary"
  | "worker_protocol_mismatch";

export class ReplayTargetProcessProtocolError extends Error {
  readonly code: ReplayTargetProcessProtocolErrorCode;

  constructor(code: ReplayTargetProcessProtocolErrorCode, options?: ErrorOptions) {
    super(`Replay target process protocol failed: ${code}`, options);
    this.name = "ReplayTargetProcessProtocolError";
    this.code = code;
  }
}

export type DurableReplayStateErrorCode =
  | "attempt_limit_reached"
  | "cancellation_conflict"
  | "cancellation_required"
  | "counter_exhausted"
  | "effect_uncertain"
  | "invalid_attempt_state"
  | "invalid_lease_duration"
  | "lease_active"
  | "lease_expired"
  | "stale_fence"
  | "state_conflict";

export class DurableReplayStateError extends Error {
  readonly code: DurableReplayStateErrorCode;

  constructor(code: DurableReplayStateErrorCode, options?: ErrorOptions) {
    super(`Durable replay state transition failed: ${code}`, options);
    this.name = "DurableReplayStateError";
    this.code = code;
  }
}

export type DurableReplayAccountingErrorCode =
  | "accounting_conflict"
  | "arithmetic_overflow"
  | "duplicate_entry"
  | "invalid_amounts"
  | "invalid_budget"
  | "invalid_usage"
  | "ledger_order"
  | "missing_reservation";

export class DurableReplayAccountingError extends Error {
  readonly code: DurableReplayAccountingErrorCode;

  constructor(code: DurableReplayAccountingErrorCode, options?: ErrorOptions) {
    super(`Durable replay accounting failed: ${code}`, options);
    this.name = "DurableReplayAccountingError";
    this.code = code;
  }
}

export class ReplayDefinitionConflictError extends Error {
  readonly code = "replay_definition_conflict";

  constructor() {
    super("Replay definition identifier is already bound to different immutable semantics");
    this.name = "ReplayDefinitionConflictError";
  }
}

export class ReplayDefinitionLineageError extends Error {
  readonly code = "replay_definition_lineage_invalid";

  constructor() {
    super("Replay definition references unavailable or conflicting immutable lineage");
    this.name = "ReplayDefinitionLineageError";
  }
}

export class InvalidReplayDefinitionInputError extends TypeError {
  readonly code = "replay_definition_input_invalid";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidReplayDefinitionInputError";
  }
}

export class ReplayRepositoryContractError extends Error {
  readonly code = "replay_repository_contract_violation";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReplayRepositoryContractError";
  }
}

export class ReplayJobConflictError extends Error {
  readonly code = "replay_job_conflict";

  constructor() {
    super("Replay job identifier or immutable mutation identifier is already bound differently");
    this.name = "ReplayJobConflictError";
  }
}

export class ReplayJobNotFoundError extends Error {
  readonly code = "replay_job_not_found";

  constructor() {
    super("Replay job was not found in the authorized scope");
    this.name = "ReplayJobNotFoundError";
  }
}
