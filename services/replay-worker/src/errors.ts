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
