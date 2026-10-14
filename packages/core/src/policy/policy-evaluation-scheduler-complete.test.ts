import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_POLICY_RULES, type PolicyEvaluationJobSnapshot } from "@proofstack/contracts";
import { claimPolicyEvaluationJob } from "./policy-evaluation-scheduler-claim.js";
import {
  sealPolicyEvaluationJob,
  startPolicyEvaluationComputation,
} from "./policy-evaluation-scheduler-seal.js";
import { reservePolicyEvaluationUsage } from "./policy-evaluation-scheduler-budget.js";
import { completePolicyEvaluationJob as complete } from "./policy-evaluation-scheduler-complete.js";
import { buildPolicyEvaluationJobOutboxIntents } from "./policy-evaluation-job-outbox.js";
import { createPolicyEvaluationJobHistoryEntry } from "./policy-evaluation-job-history.js";
import { replayPolicyEvaluationJobHistoryEntry } from "./policy-evaluation-job-history-replay.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../contracts/vectors/policy-evaluation-job-v1.json", import.meta.url),
    "utf8",
  ),
) as { snapshot: PolicyEvaluationJobSnapshot };
const snapshotRef = { snapshotId: "snapshot_completion", definitionSha256: "3".repeat(64) };
const resultRef = { evaluationId: "evaluation_completion", definitionSha256: "4".repeat(64) };
function ready(work = 7) {
  const claimed = claimPolicyEvaluationJob({
    snapshot: fixture.snapshot,
    now: "2026-09-07T12:00:01.000001Z",
    recoveryEpoch: 0,
    workerId: "worker_complete",
    attemptId: "attempt_complete",
    leaseId: "lease_complete",
  });
  const fence = claimed.job.currentLease?.mutationFence;
  if (!fence) throw new Error("Missing owning fixture lease");
  const common = { recoveryEpoch: 0, fence };
  const sealed = sealPolicyEvaluationJob({
    ...common,
    snapshot: claimed,
    now: "2026-09-07T12:00:02.000002Z",
    sealedSnapshot: snapshotRef,
  });
  const started = startPolicyEvaluationComputation({
    ...common,
    snapshot: sealed,
    now: "2026-09-07T12:00:03.000003Z",
  });
  const snapshot =
    work === 0
      ? started
      : reservePolicyEvaluationUsage({
          ...common,
          snapshot: started,
          now: "2026-09-07T12:00:04.000004Z",
          delta: {
            reads: 0,
            records: 0,
            recordBytes: 0,
            references: 0,
            referenceBytes: 0,
            artifactReadBytes: 0,
            ruleEvaluations: work,
          },
        });
  const initial = createPolicyEvaluationJobHistoryEntry({
    previous: null,
    previousEntry: null,
    next: fixture.snapshot,
    operation: { kind: "created" },
  });
  const claimEntry = createPolicyEvaluationJobHistoryEntry({
    previous: fixture.snapshot,
    previousEntry: initial,
    next: claimed,
    operation: { kind: "claim", fence },
  });
  const sealEntry = createPolicyEvaluationJobHistoryEntry({
    previous: claimed,
    previousEntry: claimEntry,
    next: sealed,
    operation: { kind: "seal", fence, snapshot: snapshotRef },
  });
  const startEntry = createPolicyEvaluationJobHistoryEntry({
    previous: sealed,
    previousEntry: sealEntry,
    next: started,
    operation: { kind: "start_computation", fence },
  });
  const previousEntry =
    work === 0
      ? startEntry
      : createPolicyEvaluationJobHistoryEntry({
          previous: started,
          previousEntry: startEntry,
          next: snapshot,
          operation: {
            kind: "reserve",
            fence,
            reservationId: "reservation_rules",
            delta: {
              reads: 0,
              records: 0,
              recordBytes: 0,
              references: 0,
              referenceBytes: 0,
              artifactReadBytes: 0,
              ruleEvaluations: work,
            },
          },
        });
  return {
    previousEntry,
    ...common,
    snapshot,
    now: "2026-09-07T12:00:05.000005Z",
    result: resultRef,
    ruleCount: 7,
  };
}
describe("logical completion of one sealed, prepaid policy computation", () => {
  it("replays completed history from the sealed original graph and refuses a substituted result reference", () => {
    const value = ready();
    const result = complete(value);
    const entry = createPolicyEvaluationJobHistoryEntry({
      previous: value.snapshot,
      previousEntry: value.previousEntry,
      next: result,
      operation: { kind: "complete", fence: value.fence, result: resultRef, ruleCount: 7 },
    });
    expect(replayPolicyEvaluationJobHistoryEntry(value.snapshot, entry)).toEqual(result);
    const wrong = createPolicyEvaluationJobHistoryEntry({
      previous: value.snapshot,
      previousEntry: value.previousEntry,
      next: result,
      operation: {
        kind: "complete",
        fence: value.fence,
        result: { ...resultRef, evaluationId: "evaluation_other" },
        ruleCount: 7,
      },
    });
    expect(() => replayPolicyEvaluationJobHistoryEntry(value.snapshot, wrong)).toThrow();
  });
  it("closes the original attempt and binds the result without erasing costs, snapshot or input", () => {
    const value = ready();
    const before = structuredClone(value);
    const result = complete(value);
    expect(value).toEqual(before);
    expect(result.job).toMatchObject({
      status: "completed",
      result: resultRef,
      snapshot: snapshotRef,
      currentLease: null,
      terminal: {
        status: "completed",
        code: "evaluation_completed",
        attemptId: value.fence.attemptId,
        committedAt: value.now,
      },
    });
    expect(result.request).toEqual(value.snapshot.request);
    expect(result.usage).toEqual(value.snapshot.usage);
    expect(result.attempts[0]).toMatchObject({
      mutationFence: value.fence,
      snapshot: snapshotRef,
      closure: { status: "completed", committedAt: value.now },
      usageAtClose: value.snapshot.usage,
    });
    expect(result.job.stateVersion).toBe(value.snapshot.job.stateVersion + 1);
    const intents = buildPolicyEvaluationJobOutboxIntents(value.snapshot, result);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      eventType: "policy.evaluation.job.terminal",
      createdAt: value.now,
      payload: {
        status: "completed",
        resultId: resultRef.evaluationId,
        resultDefinitionSha256: resultRef.definitionSha256,
      },
    });
  });
  it.each([0, 6])("refuses completion when only %s rules were paid before work", (count) => {
    expect(() => complete(ready(count))).toThrow("budget_exhausted");
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_POLICY_RULES + 1])(
    "refuses an invalid complete rule count %s",
    (ruleCount) => {
      expect(() => complete({ ...ready(), ruleCount })).toThrow("state_conflict");
    },
  );
  it.each(["workerId", "attemptId", "leaseId", "fencingToken", "recoveryEpoch"] as const)(
    "refuses another %s",
    (field) => {
      const value = ready();
      const fence = {
        ...value.fence,
        [field]:
          typeof value.fence[field] === "number"
            ? Number(value.fence[field]) + 1
            : "foreign_completion",
      };
      expect(() => complete({ ...value, fence })).toThrow("stale_fence");
    },
  );
  it("rejects exact lease expiry and a stale restored epoch", () => {
    const value = ready();
    const expiry = value.snapshot.job.currentLease?.expiresAt;
    if (!expiry) throw new Error("Missing fixture expiry");
    expect(() => complete({ ...value, now: expiry })).toThrow("lease_expired");
    expect(() => complete({ ...value, recoveryEpoch: 1 })).toThrow("stale_fence");
  });
  it("rejects a backwards completion cut and duplicated logical completion", () => {
    const value = ready();
    expect(() => complete({ ...value, now: "2026-09-07T12:00:00.000000Z" })).toThrow();
    expect(() => complete({ ...value, snapshot: complete(value) })).toThrow("state_conflict");
  });
});
