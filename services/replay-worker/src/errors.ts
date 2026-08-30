export type ReplayTargetChannelErrorCode =
  | "channel_closed"
  | "frame_too_large"
  | "incomplete_frame"
  | "invalid_frame"
  | "invalid_utf8"
  | "invalid_worker_message";

export class ReplayTargetChannelError extends Error {
  readonly code: ReplayTargetChannelErrorCode;

  constructor(code: ReplayTargetChannelErrorCode, options?: ErrorOptions) {
    super(`Replay target channel failed: ${code}`, options);
    this.name = "ReplayTargetChannelError";
    this.code = code;
  }
}

export type ReplayTargetLaunchErrorCode =
  | "environment_invalid"
  | "executable_invalid"
  | "executable_mismatch"
  | "implementation_mismatch"
  | "implementation_unavailable"
  | "invalid_target_release"
  | "launch_cancelled"
  | "runtime_incompatible"
  | "start_message_mismatch"
  | "unsupported_execution"
  | "unsupported_mounts"
  | "unsupported_subprocess_policy";

export class ReplayTargetLaunchError extends Error {
  readonly code: ReplayTargetLaunchErrorCode;

  constructor(code: ReplayTargetLaunchErrorCode, options?: ErrorOptions) {
    super(`Replay target launch preparation failed: ${code}`, options);
    this.name = "ReplayTargetLaunchError";
    this.code = code;
  }
}

export type ReplayTargetSupervisorFailureCode =
  | "boundary_resolution_failed"
  | "deadline_reached"
  | "invalid_supervisor_options"
  | "output_limit_exceeded"
  | "protocol_failed"
  | "spawn_failed"
  | "target_exit_failed"
  | "target_incomplete"
  | "worker_cancelled";

export class ReplayTargetSupervisorError extends Error {
  readonly code: ReplayTargetSupervisorFailureCode;

  constructor(code: ReplayTargetSupervisorFailureCode, options?: ErrorOptions) {
    super(`Replay target supervision failed: ${code}`, options);
    this.name = "ReplayTargetSupervisorError";
    this.code = code;
  }
}

export type ReplayAttemptPreflightErrorCode =
  | "attempt_timeout_unsupported"
  | "invocation_digest_mismatch"
  | "invalid_plan"
  | "invalid_target_release"
  | "isolation_profile_unsupported"
  | "runtime_profile_mismatch"
  | "scope_mismatch"
  | "session_invalid"
  | "target_reference_mismatch"
  | "unsupported_boundary_kind"
  | "unsupported_boundary_mode";

export class ReplayAttemptPreflightError extends Error {
  readonly code: ReplayAttemptPreflightErrorCode;

  constructor(code: ReplayAttemptPreflightErrorCode, options?: ErrorOptions) {
    super(`Replay attempt preflight failed: ${code}`, options);
    this.name = "ReplayAttemptPreflightError";
    this.code = code;
  }
}

export type ReplayLeaseHeartbeatErrorCode = "heartbeat_failed" | "invalid_heartbeat_policy";

export class ReplayLeaseHeartbeatError extends Error {
  readonly code: ReplayLeaseHeartbeatErrorCode;

  constructor(code: ReplayLeaseHeartbeatErrorCode, options?: ErrorOptions) {
    super(`Replay lease heartbeat failed: ${code}`, options);
    this.name = "ReplayLeaseHeartbeatError";
    this.code = code;
  }
}

export type ReplayAttemptObservationErrorCode =
  | "invalid_lease_policy"
  | "invalid_observation_batch";

export class ReplayAttemptObservationError extends Error {
  readonly code: ReplayAttemptObservationErrorCode;

  constructor(code: ReplayAttemptObservationErrorCode, options?: ErrorOptions) {
    super(`Replay attempt observation recording failed: ${code}`, options);
    this.name = "ReplayAttemptObservationError";
    this.code = code;
  }
}

export type ReplayAttemptAccountingErrorCode =
  | "budget_exhausted_before_attempt"
  | "invalid_accounting_context"
  | "invalid_lease_policy"
  | "invalid_usage";

export class ReplayAttemptAccountingError extends Error {
  readonly code: ReplayAttemptAccountingErrorCode;

  constructor(code: ReplayAttemptAccountingErrorCode, options?: ErrorOptions) {
    super(`Replay attempt accounting failed: ${code}`, options);
    this.name = "ReplayAttemptAccountingError";
    this.code = code;
  }
}

export type ReplayAttemptCancellationErrorCode =
  | "invalid_cancellation_context"
  | "invalid_lease_policy";

export class ReplayAttemptCancellationError extends Error {
  readonly code: ReplayAttemptCancellationErrorCode;

  constructor(code: ReplayAttemptCancellationErrorCode, options?: ErrorOptions) {
    super(`Replay attempt cancellation failed: ${code}`, options);
    this.name = "ReplayAttemptCancellationError";
    this.code = code;
  }
}

export type ReplayAttemptCompletionErrorCode =
  | "incomplete_accounting"
  | "invalid_completion_context"
  | "invalid_lease_policy"
  | "missing_result";

export class ReplayAttemptCompletionError extends Error {
  readonly code: ReplayAttemptCompletionErrorCode;

  constructor(code: ReplayAttemptCompletionErrorCode, options?: ErrorOptions) {
    super(`Replay attempt completion failed: ${code}`, options);
    this.name = "ReplayAttemptCompletionError";
    this.code = code;
  }
}

export type ReplayAttemptReportErrorCode =
  | "invalid_process_result"
  | "invalid_report_context"
  | "invalid_report_size"
  | "publish_cancelled"
  | "publish_failed"
  | "publisher_mismatch";

export class ReplayAttemptReportError extends Error {
  readonly code: ReplayAttemptReportErrorCode;

  constructor(code: ReplayAttemptReportErrorCode, options?: ErrorOptions) {
    super(`Replay attempt report failed: ${code}`, options);
    this.name = "ReplayAttemptReportError";
    this.code = code;
  }
}
