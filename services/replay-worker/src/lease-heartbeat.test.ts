import type { ReplayJobSnapshot } from "@proofstack/replay";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REPLAY_CANCELLATION_ABORT_REASON, runUnderReplayLease } from "./lease-heartbeat.js";

function snapshot(cancellationRequest: ReplayJobSnapshot["cancellationRequest"] = null) {
  return { cancellationRequest } as ReplayJobSnapshot;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runUnderReplayLease", () => {
  it("heartbeats before execution and returns the latest authoritative snapshot", async () => {
    const authoritative = snapshot();
    const heartbeat = vi.fn(async () => authoritative);
    const execute = vi.fn(async (signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      return "completed";
    });
    await expect(
      runUnderReplayLease({
        execute,
        heartbeat,
        heartbeatIntervalMilliseconds: 50,
        leaseDurationMilliseconds: 100,
      }),
    ).resolves.toEqual({ latestSnapshot: authoritative, result: "completed" });
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("serializes periodic heartbeats and returns the last one", async () => {
    vi.useFakeTimers();
    const first = snapshot();
    const second = snapshot();
    let finishExecution: ((value: string) => void) | undefined;
    let callCount = 0;
    const heartbeat = async () => {
      callCount += 1;
      if (callCount === 2) finishExecution?.("done");
      return callCount === 1 ? first : second;
    };
    const resultPromise = runUnderReplayLease({
      execute: async () =>
        await new Promise<string>((resolve) => {
          finishExecution = resolve;
        }),
      heartbeat,
      heartbeatIntervalMilliseconds: 50,
      leaseDurationMilliseconds: 100,
    });
    await vi.advanceTimersByTimeAsync(50);
    await expect(resultPromise).resolves.toEqual({ latestSnapshot: second, result: "done" });
    expect(callCount).toBe(2);
  });

  it("passes an already observed cancellation into execution", async () => {
    const cancellationRequest = { cancellationId: "can_heartbeat_001" } as never;
    const result = await runUnderReplayLease({
      execute: async (signal) => ({ aborted: signal.aborted, reason: signal.reason }),
      heartbeat: async () => snapshot(cancellationRequest),
      heartbeatIntervalMilliseconds: 50,
      leaseDurationMilliseconds: 100,
    });
    expect(result.result).toEqual({
      aborted: true,
      reason: REPLAY_CANCELLATION_ABORT_REASON,
    });
  });

  it("forwards an external abort before execution starts", async () => {
    const controller = new AbortController();
    controller.abort("operator_shutdown");
    const result = await runUnderReplayLease({
      execute: async (signal) => ({ aborted: signal.aborted, reason: signal.reason }),
      heartbeat: async () => snapshot(),
      heartbeatIntervalMilliseconds: 50,
      leaseDurationMilliseconds: 100,
      signal: controller.signal,
    });
    expect(result.result).toEqual({ aborted: true, reason: "operator_shutdown" });
  });

  it("aborts active execution and rejects when a periodic heartbeat fails", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const resultPromise = runUnderReplayLease({
      execute: async (signal) =>
        await new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve("stopped"), { once: true });
        }),
      heartbeat: async () => {
        callCount += 1;
        if (callCount > 1) throw new Error("lease lost");
        return snapshot();
      },
      heartbeatIntervalMilliseconds: 50,
      leaseDurationMilliseconds: 100,
    });
    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: "heartbeat_failed",
      name: "ReplayLeaseHeartbeatError",
    });
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
  });

  it("does not enter execution when the initial heartbeat fails", async () => {
    const execute = vi.fn(async () => "unreachable");
    await expect(
      runUnderReplayLease({
        execute,
        heartbeat: async () => {
          throw new Error("stale fence");
        },
        heartbeatIntervalMilliseconds: 50,
        leaseDurationMilliseconds: 100,
      }),
    ).rejects.toMatchObject({ code: "heartbeat_failed" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects heartbeat intervals that cannot safely renew the lease", async () => {
    for (const [heartbeatIntervalMilliseconds, leaseDurationMilliseconds] of [
      [0, 100],
      [1.5, 100],
      [50, 1],
      [51, 100],
      [1, Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      await expect(
        runUnderReplayLease({
          execute: async () => "unreachable",
          heartbeat: async () => snapshot(),
          heartbeatIntervalMilliseconds,
          leaseDurationMilliseconds,
        }),
      ).rejects.toMatchObject({ code: "invalid_heartbeat_policy" });
    }
  });
});
