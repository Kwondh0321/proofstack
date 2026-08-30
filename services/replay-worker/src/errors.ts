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
