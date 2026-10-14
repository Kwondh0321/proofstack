import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PolicyEvaluationJobSnapshot } from "@proofstack/contracts";
import { claimPolicyEvaluationJob } from "./policy-evaluation-scheduler-claim.js";
import {
  sealPolicyEvaluationJob,
  startPolicyEvaluationComputation,
} from "./policy-evaluation-scheduler-seal.js";
import { reclaimPolicyEvaluationJob } from "./policy-evaluation-scheduler-reclaim.js";
import { createPolicyEvaluationJobHistoryEntry } from "./policy-evaluation-job-history.js";
import { replayPolicyEvaluationJobHistoryEntry } from "./policy-evaluation-job-history-replay.js";
import { cancelPolicyEvaluationJob } from "./policy-evaluation-scheduler-cancel.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../contracts/vectors/policy-evaluation-job-v1.json", import.meta.url),
    "utf8",
  ),
) as { snapshot: PolicyEvaluationJobSnapshot };
const at = "2026-09-07T12:00:01.000001Z";
const reference = { snapshotId: "snapshot_admitted", definitionSha256: "3".repeat(64) };
function claimed() {
  return claimPolicyEvaluationJob({
    snapshot: fixture.snapshot,
    now: at,
    recoveryEpoch: 0,
    workerId: "worker_seal",
    attemptId: "attempt_seal",
    leaseId: "lease_seal",
  });
}
function command() {
  const snapshot = claimed();
  return {
    snapshot,
    now: at,
    recoveryEpoch: 0,
    fence: snapshot.job.currentLease!.mutationFence,
    sealedSnapshot: reference,
  };
}
describe("same-attempt logical seal and computation transitions", () => {
  it("reconstructs seal/start history from exact preceding graphs and rejects substituted binding", () => {
    const queued = structuredClone(fixture.snapshot);
    const initial = createPolicyEvaluationJobHistoryEntry({
      previous: null,
      previousEntry: null,
      next: queued,
      operation: { kind: "created" },
    });
    const input = command();
    const claimedEntry = createPolicyEvaluationJobHistoryEntry({
      previous: queued,
      previousEntry: initial,
      next: input.snapshot,
      operation: { kind: "claim", fence: input.fence },
    });
    const sealed = sealPolicyEvaluationJob(input);
    const sealEntry = createPolicyEvaluationJobHistoryEntry({
      previous: input.snapshot,
      previousEntry: claimedEntry,
      next: sealed,
      operation: { kind: "seal", fence: input.fence, snapshot: reference },
    });
    expect(replayPolicyEvaluationJobHistoryEntry(input.snapshot, sealEntry)).toEqual(sealed);
    const running = startPolicyEvaluationComputation({ ...input, snapshot: sealed });
    const started = createPolicyEvaluationJobHistoryEntry({
      previous: sealed,
      previousEntry: sealEntry,
      next: running,
      operation: { kind: "start_computation", fence: input.fence },
    });
    expect(replayPolicyEvaluationJobHistoryEntry(sealed, started)).toEqual(running);
    const substituted = createPolicyEvaluationJobHistoryEntry({
      previous: input.snapshot,
      previousEntry: claimedEntry,
      next: sealed,
      operation: {
        kind: "seal",
        fence: input.fence,
        snapshot: { ...reference, snapshotId: "snapshot_other" },
      },
    });
    expect(() => replayPolicyEvaluationJobHistoryEntry(input.snapshot, substituted)).toThrow(
      "re-derived transition",
    );
  });
  it("preserves attempt admission, live lease, original request and spent work", () => {
    const input = command(),
      original = structuredClone(input.snapshot);
    const sealed = sealPolicyEvaluationJob(input);
    expect(sealed.job.status).toBe("sealed");
    expect(sealed.job.stateVersion).toBe(original.job.stateVersion + 1);
    expect(sealed.job.currentLease).toEqual(original.job.currentLease);
    expect(sealed.request).toEqual(original.request);
    expect(sealed.usage).toEqual(original.usage);
    expect(sealed.attempts).toEqual([
      { ...original.attempts[0], phase: "computing", snapshot: reference },
    ]);
    expect(input.snapshot).toEqual(original);
    const running = startPolicyEvaluationComputation({ ...input, snapshot: sealed });
    expect(running.job.status).toBe("running");
    expect(running.attempts).toEqual(sealed.attempts);
    expect(running.job.currentLease).toEqual(sealed.job.currentLease);
    expect(running.job.snapshot).toEqual(reference);
  });
  it.each([
    "worker",
    "attempt",
    "lease",
    "epoch",
    "expiry",
    "backward",
    "cancelled",
    "already_sealed",
  ])("rejects %s without changing the retained graph", (kind) => {
    const input = command();
    if (kind === "worker") input.fence = { ...input.fence, workerId: "worker_other" };
    if (kind === "attempt") input.fence = { ...input.fence, attemptId: "attempt_other" };
    if (kind === "lease") input.fence = { ...input.fence, leaseId: "lease_other" };
    if (kind === "epoch") input.recoveryEpoch++;
    if (kind === "expiry") input.now = input.snapshot.job.currentLease!.expiresAt;
    if (kind === "backward") input.now = "2026-09-07T12:00:00.000Z";
    if (kind === "already_sealed") input.snapshot = sealPolicyEvaluationJob(input);
    if (kind === "cancelled")
      input.snapshot = cancelPolicyEvaluationJob({
        snapshot: input.snapshot,
        intent: {
          scope: input.snapshot.job.scope,
          jobId: input.fence.jobId,
          cancellationId: "cancellation_seal",
          requestedByPrincipalId: "principal_cancel",
          reason: "operator_requested",
          requestedAt: at,
        },
      });
    const original = structuredClone(input.snapshot);
    expect(() => sealPolicyEvaluationJob(input)).toThrow();
    expect(input.snapshot).toEqual(original);
  });
  it("cannot start unsealed work or start computation twice", () => {
    const input = command();
    expect(() => startPolicyEvaluationComputation(input)).toThrow();
    const sealed = sealPolicyEvaluationJob(input);
    const running = startPolicyEvaluationComputation({ ...input, snapshot: sealed });
    expect(() => startPolicyEvaluationComputation({ ...input, snapshot: running })).toThrow();
  });
  it("reclaim and a later attempt retain the original sealed snapshot", () => {
    const input = command(),
      sealed = sealPolicyEvaluationJob(input);
    const reclaimed = reclaimPolicyEvaluationJob({
      snapshot: sealed,
      now: sealed.job.currentLease!.expiresAt,
      recoveryEpoch: 0,
    });
    const retry = claimPolicyEvaluationJob({
      snapshot: reclaimed,
      now: reclaimed.job.retryAt!,
      recoveryEpoch: 0,
      workerId: "worker_seal",
      attemptId: "attempt_seal_retry",
      leaseId: "lease_seal_retry",
    });
    expect(retry.job.status).toBe("running");
    expect(retry.job.snapshot).toEqual(reference);
    expect(retry.attempts[1]!.snapshot).toEqual(reference);
    expect(() =>
      sealPolicyEvaluationJob({
        ...input,
        snapshot: retry,
        now: retry.job.updatedAt,
        fence: retry.job.currentLease!.mutationFence,
      }),
    ).toThrow();
  });
});
