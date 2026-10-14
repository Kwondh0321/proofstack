import { readFileSync } from "node:fs";
import type {
  PolicyEvaluationJobHistoryEntry,
  PolicyEvaluationJobSnapshot,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { createPolicyEvaluationJobHistoryEntry } from "./policy-evaluation-job-history.js";
import { replayPolicyEvaluationJobHistoryEntry } from "./policy-evaluation-job-history-replay.js";
import { recoverPolicyEvaluationJob } from "./policy-evaluation-job-recovery.js";
import { cancelPolicyEvaluationJob } from "./policy-evaluation-scheduler-cancel.js";
import {
  claimPolicyEvaluationJob,
  heartbeatPolicyEvaluationJob,
} from "./policy-evaluation-scheduler-claim.js";
import { interruptPolicyEvaluationJob } from "./policy-evaluation-scheduler-interrupt.js";

const vectors = JSON.parse(
  readFileSync(
    new URL("../../../contracts/vectors/policy-evaluation-job-history-v1.json", import.meta.url),
    "utf8",
  ),
).vectors as {
  snapshot: PolicyEvaluationJobSnapshot;
  entry: PolicyEvaluationJobHistoryEntry;
}[];
const now = "2026-09-07T12:00:02.123456Z";
function original(index = 0) {
  return structuredClone(vectors[index]!.snapshot);
}
function recover(snapshot: PolicyEvaluationJobSnapshot, cut = now) {
  return recoverPolicyEvaluationJob({ snapshot, now: cut, recoveryEpoch: 1 });
}
describe("trusted policy job recovery retains frozen inputs and invalidates old workers", () => {
  it("updates a queued job without manufacturing an attempt or semantic cut", () => {
    const before = original();
    const after = recover(before);
    expect(after.request).toEqual(before.request);
    expect(after.usage).toEqual(before.usage);
    expect(after.attempts).toEqual([]);
    expect(after.job).toMatchObject({
      status: "queued",
      recoveryEpoch: 1,
      currentLease: null,
      stateVersion: 2,
      updatedAt: now,
    });
    expect(before.job.recoveryEpoch).toBe(0);
  });
  it("closes an acquiring attempt, keeps cumulative charges and fences a new claim", () => {
    const before = original(2);
    const after = recover(before);
    expect(after.job.status).toBe("retry_ready");
    expect(after.usage).toEqual(before.usage);
    expect(after.request).toEqual(before.request);
    expect(after.attempts[0]!.closure).toEqual({
      status: "interrupted",
      reason: "worker_interrupted",
      committedAt: now,
    });
    expect(after.attempts[0]!.usageAtClose).toEqual(before.usage);
    expect(() =>
      heartbeatPolicyEvaluationJob({
        snapshot: after,
        now,
        recoveryEpoch: 1,
        fence: before.job.currentLease!.mutationFence,
      }),
    ).toThrow();
    const next = claimPolicyEvaluationJob({
      snapshot: after,
      now: after.job.retryAt!,
      recoveryEpoch: 1,
      workerId: "worker_recovered",
      attemptId: "attempt_recovered",
      leaseId: "lease_recovered",
    });
    expect(next.job.currentLease!.mutationFence.recoveryEpoch).toBe(1);
    expect(next.job.lastFencingToken).toBe(before.job.lastFencingToken + 1);
    expect(next.usage).toEqual(before.usage);
  });
  it.each(["sealed", "running"] as const)(
    "preserves the exact retained snapshot in synthetic %s state",
    (status) => {
      const before = original(2);
      before.job.status = status;
      before.job.snapshot = { snapshotId: "snapshot_retained", definitionSha256: "3".repeat(64) };
      before.attempts[0]!.snapshot = { ...before.job.snapshot };
      before.attempts[0]!.phase = "computing";
      const after = recover(before);
      expect(after.job.snapshot).toEqual(before.job.snapshot);
      expect(after.attempts[0]!.snapshot).toEqual(before.job.snapshot);
      expect(after.request.evaluationTime).toBe(before.request.evaluationTime);
      expect(after.usage).toEqual(before.usage);
    },
  );
  it("retains closed retry history and only rebases an elapsed scheduling receipt", () => {
    const before = original(1);
    const retry = interruptPolicyEvaluationJob({
      snapshot: before,
      now,
      recoveryEpoch: 0,
      fence: before.job.currentLease!.mutationFence,
      reason: "worker_interrupted",
    });
    const after = recover(retry, "2026-09-07T12:00:05.123456Z");
    expect(after.attempts).toEqual(retry.attempts);
    expect(after.job.retryAt).toBe(after.job.updatedAt);
    expect(after.request).toEqual(before.request);
  });
  it("preserves a terminal receipt without changing its epoch or history", () => {
    const before = original();
    const terminal = cancelPolicyEvaluationJob({
      snapshot: before,
      intent: {
        scope: before.job.scope,
        jobId: before.job.jobId,
        cancellationId: "cancel_recovery",
        requestedByPrincipalId: "principal_operator",
        reason: "operator_requested",
        requestedAt: now,
      },
    });
    expect(recover(terminal)).toEqual(terminal);
  });
  it("uses the original deadline and cumulative budget when recovery becomes terminal", () => {
    const before = original(2);
    const deadline = recover(before, before.job.deadlineAt);
    expect(deadline.job.status).toBe("timed_out");
    expect(deadline.attempts[0]!.closure?.status).toBe("timed_out");
    expect(deadline.usage).toEqual(before.usage);
    before.job.stateVersion = 99999;
    const capped = recover(before);
    expect(capped.job.status).toBe("budget_exhausted");
    expect(capped.job.stateVersion).toBe(100000);
    expect(capped.usage).toEqual(before.usage);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects a non-forward or invalid epoch %s",
    (recoveryEpoch) => {
      expect(() =>
        recoverPolicyEvaluationJob({ snapshot: original(), now, recoveryEpoch }),
      ).toThrow();
    },
  );
  it("rejects a backward database receipt", () => {
    expect(() => recover(original(1), "2026-09-07T11:59:59.999999Z")).toThrow();
  });
  it("reconstructs a recovery event from the exact preceding graph", () => {
    const before = original(2);
    const after = recover(before);
    const entry = createPolicyEvaluationJobHistoryEntry({
      previous: before,
      previousEntry: vectors[2]!.entry,
      next: after,
      operation: { kind: "recovery", recoveryEpoch: 1 },
    });
    expect(replayPolicyEvaluationJobHistoryEntry(before, entry)).toEqual(after);
  });
});
