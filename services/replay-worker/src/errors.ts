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
