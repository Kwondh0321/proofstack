import type { ReplayJobSnapshot } from "@proofstack/replay";
import { ReplayLeaseHeartbeatError } from "./errors.js";

export const REPLAY_CANCELLATION_ABORT_REASON = "proofstack_replay_cancellation_observed" as const;

export interface RunUnderReplayLeaseOptions<Result> {
  readonly execute: (signal: AbortSignal) => Promise<Result>;
  readonly heartbeat: () => Promise<ReplayJobSnapshot>;
  readonly heartbeatIntervalMilliseconds: number;
  readonly leaseDurationMilliseconds: number;
  readonly signal?: AbortSignal;
}

export interface RunUnderReplayLeaseResult<Result> {
  readonly latestSnapshot: ReplayJobSnapshot;
  readonly result: Result;
}

function validatePolicy(interval: number, duration: number): void {
  if (
    !Number.isSafeInteger(interval) ||
    interval < 1 ||
    !Number.isSafeInteger(duration) ||
    duration < 2 ||
    interval > Math.floor(duration / 2)
  ) {
    throw new ReplayLeaseHeartbeatError("invalid_heartbeat_policy");
  }
}

export async function runUnderReplayLease<Result>(
  options: RunUnderReplayLeaseOptions<Result>,
): Promise<RunUnderReplayLeaseResult<Result>> {
  validatePolicy(options.heartbeatIntervalMilliseconds, options.leaseDurationMilliseconds);
  const controller = new AbortController();
  let heartbeatFailure: ReplayLeaseHeartbeatError | undefined;
  let latestSnapshot: ReplayJobSnapshot | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = Promise.resolve();

  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal?.aborted) forwardAbort();

  const heartbeat = async (): Promise<void> => {
    try {
      latestSnapshot = await options.heartbeat();
      if (latestSnapshot.cancellationRequest !== null) {
        controller.abort(REPLAY_CANCELLATION_ABORT_REASON);
      }
    } catch (error) {
      heartbeatFailure = new ReplayLeaseHeartbeatError("heartbeat_failed", { cause: error });
      controller.abort(heartbeatFailure);
    }
    if (!stopped && !heartbeatFailure) {
      timer = setTimeout(() => {
        timer = undefined;
        inFlight = heartbeat();
      }, options.heartbeatIntervalMilliseconds);
    }
  };

  try {
    await heartbeat();
    if (heartbeatFailure) throw heartbeatFailure;
    const result = await options.execute(controller.signal);
    stopped = true;
    if (timer) clearTimeout(timer);
    await inFlight;
    if (heartbeatFailure) throw heartbeatFailure;
    return Object.freeze({ latestSnapshot: latestSnapshot as ReplayJobSnapshot, result });
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    await inFlight;
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}
