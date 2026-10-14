import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PolicyEvaluationJobSnapshotSchema,
  MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationJobHistoryEntry,
} from "@proofstack/contracts";
import { claimPolicyEvaluationJob } from "./policy-evaluation-scheduler-claim.js";
import { reservePolicyEvaluationUsage } from "./policy-evaluation-scheduler-budget.js";
import {
  reservePolicyEvaluationAcquisition as reserve,
  settlePolicyEvaluationAcquisition as settle,
} from "./policy-evaluation-acquisition-allowance.js";
import { cancelPolicyEvaluationJob } from "./policy-evaluation-scheduler-cancel.js";
import { interruptPolicyEvaluationJob } from "./policy-evaluation-scheduler-interrupt.js";
import { reclaimPolicyEvaluationJob } from "./policy-evaluation-scheduler-reclaim.js";
import { recoverPolicyEvaluationJob } from "./policy-evaluation-job-recovery.js";
import { exhaustPolicyEvaluationJobHistory } from "./policy-evaluation-history-limit.js";
import {
  createPolicyEvaluationJobHistoryEntry,
  digestPolicyEvaluationJobGraph,
} from "./policy-evaluation-job-history.js";
import { replayPolicyEvaluationJobHistoryEntry } from "./policy-evaluation-job-history-replay.js";

const vectors = JSON.parse(
  readFileSync(
    new URL("../../../contracts/vectors/policy-evaluation-job-history-v1.json", import.meta.url),
    "utf8",
  ),
).vectors as { snapshot: PolicyEvaluationJobSnapshot; entry: PolicyEvaluationJobHistoryEntry }[];
const now = "2026-09-07T12:00:03.000003Z";
const settlementAt = "2026-09-07T12:00:04.000004Z";
const spent = {
  reads: 5,
  records: 3,
  references: 2,
  recordBytes: 20,
  referenceBytes: 10,
  artifactReadBytes: 4,
  ruleEvaluations: 0,
};
function ready() {
  const claimed = claimPolicyEvaluationJob({
    snapshot: vectors[0]!.snapshot,
    now: "2026-09-07T12:00:01.000001Z",
    recoveryEpoch: 0,
    workerId: "worker_allowance",
    attemptId: "attempt_allowance",
    leaseId: "lease_allowance",
  });
  const fence = claimed.job.currentLease!.mutationFence;
  const snapshot = reservePolicyEvaluationUsage({
    snapshot: claimed,
    now: "2026-09-07T12:00:02.000002Z",
    recoveryEpoch: 0,
    fence,
    delta: spent,
  });
  const command = { snapshot, now, recoveryEpoch: 0, fence, allowanceId: "allowance_metadata" };
  return { snapshot, fence, command };
}
function held() {
  const f = ready();
  const snapshot = reserve(f.command);
  return {
    ...f,
    snapshot,
    settlement: {
      ...f.command,
      snapshot,
      now: settlementAt,
      usage: { reads: 2, records: 1, references: 3, recordBytes: 40, referenceBytes: 30 },
    },
  };
}
function expectFullCharge(snapshot: PolicyEvaluationJobSnapshot) {
  expect(snapshot.usage.reads).toBe(snapshot.request.limits.maxAcquisitionRecords);
  expect(snapshot.usage.records).toBe(snapshot.request.limits.maxAcquisitionRecords);
  expect(snapshot.usage.references).toBe(snapshot.request.limits.maxAcquisitionRecords);
  expect(snapshot.usage.recordBytes + snapshot.usage.referenceBytes).toBe(
    snapshot.request.limits.maxAcquisitionRecordBytes,
  );
  expect(snapshot.usage.referenceBytes).toBe(spent.referenceBytes);
  expect(snapshot.usage.artifactReadBytes).toBe(spent.artifactReadBytes);
  expect(snapshot.acquisitionAllowance).toBeNull();
  expect(snapshot.attempts.at(-1)?.usageAtClose).toEqual(snapshot.usage);
}

describe("bounded acquisition allowance logical transitions", () => {
  it("preserves every historical graph hash and does not inject a default allowance field", () => {
    for (const vector of vectors) {
      expect(PolicyEvaluationJobSnapshotSchema.parse(vector.snapshot)).toEqual(vector.snapshot);
      expect(
        Object.hasOwn(
          PolicyEvaluationJobSnapshotSchema.parse(vector.snapshot),
          "acquisitionAllowance",
        ),
      ).toBe(false);
      expect(digestPolicyEvaluationJobGraph(vector.snapshot)).toBe(
        vector.entry.definition.graphSha256,
      );
    }
  });
  it("reserves exact independent remaining counts and one shared byte ceiling without charging unused work", () => {
    const f = ready();
    const before = structuredClone(f.snapshot);
    const result = reserve(f.command);
    expect(f.snapshot).toEqual(before);
    expect(result.usage).toEqual(spent);
    expect(result.job.stateVersion).toBe(f.snapshot.job.stateVersion + 1);
    expect(result.acquisitionAllowance).toEqual({
      schemaVersion: "0.1",
      allowanceId: f.command.allowanceId,
      mutationFence: f.fence,
      reservedAt: now,
      usageAtReservation: {
        reads: 5,
        records: 3,
        references: 2,
        recordBytes: 20,
        referenceBytes: 10,
      },
      limits: { reads: 9995, records: 9997, references: 9998, recordAndReferenceBytes: 16777186 },
    });
    expect(result.job.currentLease).toEqual(f.snapshot.job.currentLease);
    expect(result.attempts).toEqual(f.snapshot.attempts);
  });
  it("settles observed work monotonically and releases unconsumed allowance for a bounded retry", () => {
    const f = held();
    const result = settle(f.settlement);
    expect(result.usage).toEqual({
      ...spent,
      reads: 7,
      records: 4,
      references: 5,
      recordBytes: 60,
      referenceBytes: 40,
    });
    expect(result.acquisitionAllowance).toBeNull();
    expect(result.job.status).toBe("acquiring");
    const next = reserve({
      ...f.command,
      snapshot: result,
      now: "2026-09-07T12:00:05.000005Z",
      allowanceId: "allowance_retry",
    });
    expect(next.acquisitionAllowance?.limits.recordAndReferenceBytes).toBe(16777116);
    expect(next.usage).toEqual(result.usage);
  });
  it("settles drained zero work without reducing any previously spent counter", () => {
    const f = held();
    const result = settle({
      ...f.settlement,
      usage: { reads: 0, records: 0, references: 0, recordBytes: 0, referenceBytes: 0 },
    });
    expect(result.usage).toEqual(spent);
    expect(result.acquisitionAllowance).toBeNull();
  });
  it("consumes unknown work conservatively and closes the attempt/job instead of reviving unused credit", () => {
    const f = held();
    const result = settle({ ...f.settlement, usage: null });
    expectFullCharge(result);
    expect(result.job.status).toBe("budget_exhausted");
    expect(result.job.currentLease).toBeNull();
    expect(result.job.terminal?.code).toBe("budget_limit_reached");
    expect(() =>
      reserve({ ...f.command, snapshot: result, now: "2026-09-07T12:00:05.000005Z" }),
    ).toThrow();
  });
  it("replays reservation and observed settlement against their exact prior graphs", () => {
    const f = ready();
    const claimed = claimPolicyEvaluationJob({
      snapshot: vectors[0]!.snapshot,
      now: "2026-09-07T12:00:01.000001Z",
      recoveryEpoch: 0,
      workerId: f.fence.workerId,
      attemptId: f.fence.attemptId,
      leaseId: f.fence.leaseId,
    });
    const claimEntry = createPolicyEvaluationJobHistoryEntry({
      previous: vectors[0]!.snapshot,
      previousEntry: vectors[0]!.entry,
      next: claimed,
      operation: { kind: "claim", fence: f.fence },
    });
    const paidEntry = createPolicyEvaluationJobHistoryEntry({
      previous: claimed,
      previousEntry: claimEntry,
      next: f.snapshot,
      operation: {
        kind: "reserve",
        fence: f.fence,
        delta: spent,
        reservationId: "reservation_before_allowance",
      },
    });
    const reserved = reserve(f.command);
    const entry = createPolicyEvaluationJobHistoryEntry({
      previous: f.snapshot,
      previousEntry: paidEntry,
      next: reserved,
      operation: {
        kind: "reserve_acquisition",
        fence: f.fence,
        allowanceId: f.command.allowanceId,
      },
    });
    expect(replayPolicyEvaluationJobHistoryEntry(f.snapshot, entry)).toEqual(reserved);
    const usage = { reads: 2, records: 1, references: 3, recordBytes: 40, referenceBytes: 30 };
    const settled = settle({ ...f.command, snapshot: reserved, now: settlementAt, usage });
    const settledEntry = createPolicyEvaluationJobHistoryEntry({
      previous: reserved,
      previousEntry: entry,
      next: settled,
      operation: {
        kind: "settle_acquisition",
        fence: f.fence,
        allowanceId: f.command.allowanceId,
        usage,
      },
    });
    expect(replayPolicyEvaluationJobHistoryEntry(reserved, settledEntry)).toEqual(settled);
  });
  it("rejects a second open allowance and out-of-band metadata spending", () => {
    const f = held();
    expect(() =>
      reserve({ ...f.command, snapshot: f.snapshot, allowanceId: "allowance_second" }),
    ).toThrow();
    expect(() =>
      reservePolicyEvaluationUsage({
        ...f.command,
        snapshot: f.snapshot,
        now: settlementAt,
        delta: { ...spent, artifactReadBytes: 0 },
      }),
    ).toThrow();
    const artifact = reservePolicyEvaluationUsage({
      ...f.command,
      snapshot: f.snapshot,
      now: settlementAt,
      delta: {
        reads: 0,
        records: 0,
        references: 0,
        recordBytes: 0,
        referenceBytes: 0,
        artifactReadBytes: 10,
        ruleEvaluations: 0,
      },
    });
    expect(artifact.acquisitionAllowance).toEqual(f.snapshot.acquisitionAllowance);
    expect(artifact.usage.artifactReadBytes).toBe(14);
  });
  it.each(["reads", "records", "references", "recordAndReferenceBytes"] as const)(
    "rejects settlement beyond remaining %s",
    (key) => {
      const f = held();
      const limit = f.snapshot.acquisitionAllowance!.limits[key];
      const usage = { reads: 0, records: 0, references: 0, recordBytes: 0, referenceBytes: 0 };
      if (key === "recordAndReferenceBytes") usage.recordBytes = limit + 1;
      else usage[key] = limit + 1;
      expect(() => settle({ ...f.settlement, usage })).toThrow();
      expect(f.snapshot.acquisitionAllowance).not.toBeNull();
    },
  );
  it("shares the byte allowance between records and references at the exact boundary", () => {
    const f = held();
    const limit = f.snapshot.acquisitionAllowance!.limits.recordAndReferenceBytes;
    const usage = {
      reads: 0,
      records: 0,
      references: 0,
      recordBytes: limit - 1,
      referenceBytes: 1,
    };
    expect(
      settle({ ...f.settlement, usage }).usage.recordBytes +
        settle({ ...f.settlement, usage }).usage.referenceBytes,
    ).toBe(f.snapshot.request.limits.maxAcquisitionRecordBytes);
    expect(() => settle({ ...f.settlement, usage: { ...usage, referenceBytes: 2 } })).toThrow();
  });
  it.each(["workerId", "attemptId", "leaseId"] as const)(
    "rejects a substituted %s without modifying the pending graph",
    (key) => {
      const f = held();
      const before = structuredClone(f.snapshot);
      expect(() =>
        settle({ ...f.settlement, fence: { ...f.fence, [key]: "identity_other" } }),
      ).toThrow();
      expect(f.snapshot).toEqual(before);
    },
  );
  it("rejects foreign epoch, allowance ID, expiry and negative observed costs", () => {
    const f = held();
    expect(() => settle({ ...f.settlement, recoveryEpoch: 1 })).toThrow();
    expect(() => settle({ ...f.settlement, allowanceId: "allowance_other" })).toThrow();
    expect(() =>
      settle({ ...f.settlement, now: f.snapshot.job.currentLease!.expiresAt }),
    ).toThrow();
    expect(() =>
      settle({ ...f.settlement, usage: { ...f.settlement.usage, reads: -1 } }),
    ).toThrow();
  });
  it("rejects tampered remaining limits, baseline costs, fence and receipt ordering", () => {
    const f = held();
    for (const mutate of [
      (value: PolicyEvaluationJobSnapshot) => {
        value.acquisitionAllowance!.limits.reads--;
      },
      (value: PolicyEvaluationJobSnapshot) => {
        value.acquisitionAllowance!.usageAtReservation.reads--;
      },
      (value: PolicyEvaluationJobSnapshot) => {
        value.acquisitionAllowance!.mutationFence.workerId = "worker_other";
      },
      (value: PolicyEvaluationJobSnapshot) => {
        value.acquisitionAllowance!.reservedAt = "2026-09-07T12:00:04.000004Z";
      },
    ]) {
      const copy = structuredClone(f.snapshot);
      mutate(copy);
      expect(PolicyEvaluationJobSnapshotSchema.safeParse(copy).success).toBe(false);
    }
  });
  it("cancellation retains unknown spend and the original cancellation authority", () => {
    const f = held();
    const result = cancelPolicyEvaluationJob({
      snapshot: f.snapshot,
      intent: {
        scope: f.snapshot.job.scope,
        jobId: f.snapshot.job.jobId,
        cancellationId: "cancel_allowance",
        requestedByPrincipalId: "operator_allowance",
        reason: "operator_requested",
        requestedAt: settlementAt,
      },
    });
    expectFullCharge(result);
    expect(result.job.status).toBe("cancelled");
  });
  it("operational interruption closes unknown acquisition as budget exhausted", () => {
    const f = held();
    const result = interruptPolicyEvaluationJob({
      ...f.command,
      snapshot: f.snapshot,
      now: settlementAt,
      reason: "worker_interrupted",
    });
    expectFullCharge(result);
    expect(result.job.status).toBe("budget_exhausted");
  });
  it("lease reclaim and forward recovery conservatively retain all in-flight allowance", () => {
    const f = held();
    const reclaimed = reclaimPolicyEvaluationJob({
      snapshot: f.snapshot,
      now: f.snapshot.job.currentLease!.expiresAt,
      recoveryEpoch: 0,
    });
    expectFullCharge(reclaimed);
    expect(reclaimed.job.status).toBe("budget_exhausted");
    const recovered = recoverPolicyEvaluationJob({
      snapshot: f.snapshot,
      now: settlementAt,
      recoveryEpoch: 1,
    });
    expectFullCharge(recovered);
    expect(recovered.job.recoveryEpoch).toBe(1);
    expect(recovered.job.status).toBe("budget_exhausted");
  });
  it("deadline and history exhaustion retain pending spend without extending authority", () => {
    const f = held();
    const timedOut = reclaimPolicyEvaluationJob({
      snapshot: f.snapshot,
      now: f.snapshot.job.deadlineAt,
      recoveryEpoch: 0,
    });
    expectFullCharge(timedOut);
    expect(timedOut.job.status).toBe("timed_out");
    const capped = structuredClone(f.snapshot);
    capped.job.stateVersion = MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES - 1;
    const exhausted = exhaustPolicyEvaluationJobHistory(capped, settlementAt);
    expectFullCharge(exhausted);
    expect(exhausted.job.status).toBe("budget_exhausted");
  });
});
