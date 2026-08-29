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
