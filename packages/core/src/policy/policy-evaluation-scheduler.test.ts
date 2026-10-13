import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  policyEvaluationTimestampOrderKey,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationUsage,
} from "@proofstack/contracts";
import {
  claimPolicyEvaluationJob,
  heartbeatPolicyEvaluationJob,
  PolicyEvaluationSchedulerTransitionError,
} from "./policy-evaluation-scheduler-claim.js";
import { reservePolicyEvaluationUsage } from "./policy-evaluation-scheduler-budget.js";
import { cancelPolicyEvaluationJob } from "./policy-evaluation-scheduler-cancel.js";
import { interruptPolicyEvaluationJob } from "./policy-evaluation-scheduler-interrupt.js";
import { reclaimPolicyEvaluationJob } from "./policy-evaluation-scheduler-reclaim.js";
import {
  addPolicyEvaluationMilliseconds,
  addPolicyEvaluationMillisecondsUpTo,
  earlierPolicyEvaluationTime,
} from "./policy-evaluation-scheduler-time.js";

const vector = JSON.parse(
  readFileSync(
    new URL("../../../contracts/vectors/policy-evaluation-job-v1.json", import.meta.url),
    "utf8",
  ),
) as { snapshot: PolicyEvaluationJobSnapshot };
const start = "2026-09-07T12:00:01.000000000000000000000000000001Z";
const zero: PolicyEvaluationUsage = {
  reads: 0,
  records: 0,
  recordBytes: 0,
  references: 0,
  referenceBytes: 0,
  artifactReadBytes: 0,
  ruleEvaluations: 0,
};
function queued() {
  return structuredClone(vector.snapshot);
}
function claim(snapshot = queued(), now = start, sequence = 0) {
  return claimPolicyEvaluationJob({
    snapshot,
    now,
    recoveryEpoch: 0,
    attemptId: `attempt_${sequence}`,
    leaseId: `lease_${sequence}`,
    workerId: "worker_scheduler",
  });
}
function sealed() {
  const result = claim();
  result.job.snapshot = { snapshotId: "snapshot_retained", definitionSha256: "3".repeat(64) };
  result.job.status = "running";
  result.attempts[0]!.snapshot = { ...result.job.snapshot };
  result.attempts[0]!.phase = "computing";
  return result;
}
describe("scheduler admission and retained snapshot boundaries", () => {
  it("retries computing on its original snapshot and rejects source revision recapture", () => {
    const original = sealed();
    const fence = original.job.currentLease!.mutationFence;
    expect(() =>
      interruptPolicyEvaluationJob({
        snapshot: original,
        now: start,
        recoveryEpoch: 0,
        fence,
        reason: "source_revision_changed",
      }),
    ).toThrow();
    const interrupted = interruptPolicyEvaluationJob({
      snapshot: original,
      now: start,
      recoveryEpoch: 0,
      fence,
      reason: "worker_interrupted",
    });
    const retried = claim(interrupted, interrupted.job.retryAt!, 1);
    expect(retried.job.status).toBe("running");
    expect(retried.attempts[1]!.snapshot).toEqual(original.job.snapshot);
    expect(retried.request).toEqual(original.request);
    const spent = reservePolicyEvaluationUsage({
      snapshot: retried,
      now: retried.job.updatedAt,
      recoveryEpoch: 0,
      fence: retried.job.currentLease!.mutationFence,
      delta: { ...zero, ruleEvaluations: 1 },
    });
    expect(spent.usage.ruleEvaluations).toBe(1);
  });
  it.each(["reclaim", "interrupt"] as const)(
    "honors the original finite attempts for %s",
    (operation) => {
      const initial = queued();
      initial.request.limits.maxAttempts = 1;
      initial.request.limits.maxRuleEvaluations = 128;
      initial.request.limits.retryableErrors = [];
      initial.request.limits.retryBackoffMilliseconds = 0;
      const original = claim(initial);
      const result =
        operation === "reclaim"
          ? reclaimPolicyEvaluationJob({
              snapshot: original,
              now: original.job.currentLease!.expiresAt,
              recoveryEpoch: 0,
            })
          : interruptPolicyEvaluationJob({
              snapshot: original,
              now: start,
              recoveryEpoch: 0,
              fence: original.job.currentLease!.mutationFence,
              reason: "worker_interrupted",
            });
      expect(result.job.status).toBe("failed");
      expect(result.job.terminal!.code).toBe("retries_exhausted");
      expect(result.job.retryAt).toBeNull();
    },
  );
  it("reclaim preserves the sealed snapshot and rejects epoch/backward/counter changes", () => {
    const original = sealed();
    const expiry = original.job.currentLease!.expiresAt;
    const result = reclaimPolicyEvaluationJob({
      snapshot: original,
      now: expiry,
      recoveryEpoch: 0,
    });
    expect(result.job.snapshot).toEqual(original.job.snapshot);
    expect(() =>
      reclaimPolicyEvaluationJob({ snapshot: original, now: expiry, recoveryEpoch: 1 }),
    ).toThrow();
    expect(() =>
      reclaimPolicyEvaluationJob({
        snapshot: original,
        now: "2026-09-07T12:00:00.000Z",
        recoveryEpoch: 0,
      }),
    ).toThrow();
    original.job.stateVersion = Number.MAX_SAFE_INTEGER;
    expect(() =>
      reclaimPolicyEvaluationJob({ snapshot: original, now: expiry, recoveryEpoch: 0 }),
    ).toThrow();
  });
  it.each(["heartbeat", "reserve", "interrupt"] as const)(
    "rejects %s when its native receipt moves backwards or state counter exhausts",
    (operation) => {
      const original = claim();
      const run = (snapshot: PolicyEvaluationJobSnapshot, now: string) => {
        const common = {
          snapshot,
          now,
          recoveryEpoch: 0,
          fence: snapshot.job.currentLease!.mutationFence,
        };
        return operation === "heartbeat"
          ? heartbeatPolicyEvaluationJob(common)
          : operation === "reserve"
            ? reservePolicyEvaluationUsage({ ...common, delta: { ...zero, reads: 1 } })
            : interruptPolicyEvaluationJob({ ...common, reason: "worker_interrupted" });
      };
      expect(() => run(original, "2026-09-07T12:00:00.000Z")).toThrow();
      original.job.stateVersion = Number.MAX_SAFE_INTEGER;
      expect(() => run(original, addPolicyEvaluationMilliseconds(start, 5000))).toThrow();
    },
  );
  it("rejects reused attempt/lease identities without erasing prior work", () => {
    const original = claim();
    const interrupted = interruptPolicyEvaluationJob({
      snapshot: original,
      now: start,
      recoveryEpoch: 0,
      fence: original.job.currentLease!.mutationFence,
      reason: "worker_interrupted",
    });
    expect(() => claim(interrupted, interrupted.job.retryAt!, 0)).toThrow();
    expect(interrupted.attempts).toHaveLength(1);
  });
  it("rejects stale budget and interruption fences and explicit worker expiry closure", () => {
    const original = claim();
    const fence = { ...original.job.currentLease!.mutationFence, fencingToken: 2 };
    expect(() =>
      reservePolicyEvaluationUsage({
        snapshot: original,
        now: start,
        recoveryEpoch: 0,
        fence,
        delta: { ...zero, reads: 1 },
      }),
    ).toThrow();
    expect(() =>
      interruptPolicyEvaluationJob({
        snapshot: original,
        now: start,
        recoveryEpoch: 0,
        fence,
        reason: "worker_interrupted",
      }),
    ).toThrow();
    expect(() =>
      interruptPolicyEvaluationJob({
        snapshot: original,
        now: start,
        recoveryEpoch: 0,
        fence: original.job.currentLease!.mutationFence,
        reason: "lease_expired",
      }),
    ).toThrow();
  });
});
describe("exact native policy scheduler time", () => {
  it.each([
    [
      "2026-09-07T12:00:00.000000000000000000000000000001Z",
      1000,
      "2026-09-07T12:00:01.000000000000000000000000000001Z",
    ],
    ["1969-12-31T23:59:59.999999Z", 1, "1970-01-01T00:00:00.000999Z"],
    ["0001-01-01T00:00:00.0001Z", 1, "0001-01-01T00:00:00.0011Z"],
    ["2026-09-07T12:00:00.000Z", 0, "2026-09-07T12:00:00.000Z"],
  ] as const)("preserves exact source fraction at %s +%i", (value, duration, expected) => {
    expect(addPolicyEvaluationMilliseconds(value, duration)).toBe(expected);
  });
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid duration %s",
    (duration) => {
      expect(() => addPolicyEvaluationMilliseconds(start, duration)).toThrow();
    },
  );
  it("caps before formatting an out-of-range year and preserves earlier original text", () => {
    const near = "9999-12-31T23:59:59.998000000000000000000000000001Z";
    const limit = "9999-12-31T23:59:59.999Z";
    expect(addPolicyEvaluationMillisecondsUpTo(near, 60_000, limit)).toBe(limit);
    expect(earlierPolicyEvaluationTime(start, addPolicyEvaluationMilliseconds(start, 1))).toBe(
      start,
    );
    expect(earlierPolicyEvaluationTime(addPolicyEvaluationMilliseconds(start, 1), start)).toBe(
      start,
    );
  });
});
describe("fixed policy scheduler transitions", () => {
  it("claims a detached exact request with server-derived frozen lease/attempt deadline", () => {
    const initial = queued();
    const result = claim(initial);
    expect(initial).toEqual(vector.snapshot);
    expect(result.job.status).toBe("acquiring");
    expect(result.job.currentLease!.expiresAt).toBe(addPolicyEvaluationMilliseconds(start, 30_000));
    expect(result.attempts[0]!.deadlineAt).toBe(addPolicyEvaluationMilliseconds(start, 120_000));
    expect(result.job.request).toEqual(initial.job.request);
    expect(result.job.deadlineAt).toBe(initial.job.deadlineAt);
    expect(result.job.lastFencingToken).toBe(1);
  });
  it.each(["epoch", "deadline", "clock_backwards", "already_claimed"])(
    "rejects invalid claim %s",
    (kind) => {
      const input = {
        snapshot: kind === "already_claimed" ? claim() : queued(),
        now: start,
        recoveryEpoch: 0,
        attemptId: "attempt_new",
        leaseId: "lease_new",
        workerId: "worker_scheduler",
      };
      if (kind === "epoch") input.recoveryEpoch = 1;
      else if (kind === "deadline") input.now = input.snapshot.job.deadlineAt;
      else if (kind === "clock_backwards") input.now = "2026-09-07T12:00:00.000Z";
      expect(() => claimPolicyEvaluationJob(input)).toThrow(
        PolicyEvaluationSchedulerTransitionError,
      );
    },
  );
  it("caps a claim's original attempt and lease at the remaining job deadline", () => {
    const initial = queued();
    const now = "2026-09-07T12:09:59.999999Z";
    const result = claim(initial, now);
    expect(result.attempts[0]!.deadlineAt).toBe(initial.job.deadlineAt);
    expect(result.job.currentLease!.expiresAt).toBe(initial.job.deadlineAt);
  });
  it("heartbeats without changing acquiredAt, attempt deadline or semantic request", () => {
    const original = claim();
    const lease = original.job.currentLease!;
    const now = addPolicyEvaluationMilliseconds(start, 5000);
    const result = heartbeatPolicyEvaluationJob({
      snapshot: original,
      now,
      recoveryEpoch: 0,
      fence: lease.mutationFence,
    });
    expect(result.job.currentLease!.acquiredAt).toBe(start);
    expect(result.job.currentLease!.attemptDeadlineAt).toBe(lease.attemptDeadlineAt);
    expect(result.job.currentLease!.expiresAt).toBe(addPolicyEvaluationMilliseconds(now, 30_000));
    expect(original.job.currentLease!.heartbeatAt).toBe(start);
  });
  it.each(["jobId", "attemptId", "workerId", "leaseId", "fencingToken", "recoveryEpoch"] as const)(
    "rejects heartbeat fence substitution %s",
    (field) => {
      const original = claim();
      const fence = {
        ...original.job.currentLease!.mutationFence,
        [field]: field === "fencingToken" || field === "recoveryEpoch" ? 2 : "outside_scope",
      };
      expect(() =>
        heartbeatPolicyEvaluationJob({
          snapshot: original,
          now: addPolicyEvaluationMilliseconds(start, 5000),
          recoveryEpoch: 0,
          fence,
        }),
      ).toThrow(PolicyEvaluationSchedulerTransitionError);
    },
  );
  it("rejects heartbeat before cadence and exactly at lease expiry", () => {
    const original = claim();
    const fence = original.job.currentLease!.mutationFence;
    expect(() =>
      heartbeatPolicyEvaluationJob({
        snapshot: original,
        now: addPolicyEvaluationMilliseconds(start, 4999),
        recoveryEpoch: 0,
        fence,
      }),
    ).toThrow(PolicyEvaluationSchedulerTransitionError);
    expect(() =>
      heartbeatPolicyEvaluationJob({
        snapshot: original,
        now: original.job.currentLease!.expiresAt,
        recoveryEpoch: 0,
        fence,
      }),
    ).toThrow(PolicyEvaluationSchedulerTransitionError);
  });
  it("reserves cumulative work before I/O without changing caller graph", () => {
    const original = claim();
    const fence = original.job.currentLease!.mutationFence;
    const result = reservePolicyEvaluationUsage({
      snapshot: original,
      now: start,
      recoveryEpoch: 0,
      fence,
      delta: { ...zero, reads: 1, records: 1, recordBytes: 100 },
    });
    expect(result.usage).toEqual({ ...zero, reads: 1, records: 1, recordBytes: 100 });
    expect(original.usage).toEqual(zero);
    const second = reservePolicyEvaluationUsage({
      snapshot: result,
      now: start,
      recoveryEpoch: 0,
      fence,
      delta: { ...zero, reads: 1, records: 1, recordBytes: 100 },
    });
    expect(second.usage.records).toBe(2);
  });
  it.each(["records", "recordBytes", "artifactReadBytes", "ruleEvaluations", "empty"])(
    "rejects unsafe reservation %s without mutation",
    (kind) => {
      const original = claim();
      const before = structuredClone(original);
      const fence = original.job.currentLease!.mutationFence;
      const delta = { ...zero };
      if (kind === "records") delta.records = original.request.limits.maxAcquisitionRecords + 1;
      else if (kind === "recordBytes")
        delta.recordBytes = original.request.limits.maxAcquisitionRecordBytes + 1;
      else if (kind === "artifactReadBytes")
        delta.artifactReadBytes = original.request.limits.maxArtifactReadBytes + 1;
      else if (kind === "ruleEvaluations") delta.ruleEvaluations = 1;
      expect(() =>
        reservePolicyEvaluationUsage({
          snapshot: original,
          now: start,
          recoveryEpoch: 0,
          fence,
          delta,
        }),
      ).toThrow(PolicyEvaluationSchedulerTransitionError);
      expect(original).toEqual(before);
    },
  );
  it("closes original work before finite retry and retains spent budget", () => {
    const original = claim();
    const fence = original.job.currentLease!.mutationFence;
    const spent = reservePolicyEvaluationUsage({
      snapshot: original,
      now: start,
      recoveryEpoch: 0,
      fence,
      delta: { ...zero, records: 2 },
    });
    const closed = interruptPolicyEvaluationJob({
      snapshot: spent,
      now: addPolicyEvaluationMilliseconds(start, 1000),
      recoveryEpoch: 0,
      fence,
      reason: "worker_interrupted",
    });
    expect(closed.job.status).toBe("retry_ready");
    expect(closed.attempts[0]!.closure?.status).toBe("interrupted");
    expect(() => claim(closed, addPolicyEvaluationMilliseconds(start, 1999), 1)).toThrow(
      PolicyEvaluationSchedulerTransitionError,
    );
    const resumed = claim(closed, closed.job.retryAt!, 1);
    expect(resumed.attempts[1]!.usageAtStart.records).toBe(2);
    expect(resumed.job.lastFencingToken).toBe(2);
    expect(resumed.job.request).toEqual(original.job.request);
    expect(resumed.job.deadlineAt).toBe(original.job.deadlineAt);
  });
  it("expires stale workers without allowing them to close or refund their attempt", () => {
    const original = claim();
    const fence = original.job.currentLease!.mutationFence;
    expect(() =>
      interruptPolicyEvaluationJob({
        snapshot: original,
        now: original.job.currentLease!.expiresAt,
        recoveryEpoch: 0,
        fence,
        reason: "lease_expired",
      }),
    ).toThrow(PolicyEvaluationSchedulerTransitionError);
    expect(() =>
      interruptPolicyEvaluationJob({
        snapshot: original,
        now: start,
        recoveryEpoch: 0,
        fence,
        reason: "lease_expired",
      }),
    ).toThrow(PolicyEvaluationSchedulerTransitionError);
  });
  it("cancels before claim and returns the exact original cancellation receipt on retry", () => {
    const original = queued();
    const at = "2026-09-07T12:00:00.234567Z";
    const intent = {
      jobId: original.job.jobId,
      scope: original.job.scope,
      cancellationId: "cancel_scheduler",
      requestedAt: at,
      requestedByPrincipalId: "principal_operator",
      reason: "operator_requested" as const,
    };
    const result = cancelPolicyEvaluationJob({ snapshot: original, intent });
    expect(result.job.status).toBe("cancelled");
    expect(result.attempts).toHaveLength(0);
    expect(
      cancelPolicyEvaluationJob({
        snapshot: result,
        intent: { ...intent, requestedAt: "2026-09-07T12:00:05.000Z" },
      }),
    ).toEqual(result);
    expect(() =>
      cancelPolicyEvaluationJob({
        snapshot: result,
        intent: { ...intent, requestedByPrincipalId: "principal_other" },
      }),
    ).toThrow(PolicyEvaluationSchedulerTransitionError);
  });
  it("cancels active work atomically with spent usage and fences the old heartbeat", () => {
    const original = claim();
    const fence = original.job.currentLease!.mutationFence;
    const spent = reservePolicyEvaluationUsage({
      snapshot: original,
      now: start,
      recoveryEpoch: 0,
      fence,
      delta: { ...zero, records: 1 },
    });
    const at = addPolicyEvaluationMilliseconds(start, 1000);
    const result = cancelPolicyEvaluationJob({
      snapshot: spent,
      intent: {
        jobId: spent.job.jobId,
        scope: spent.job.scope,
        cancellationId: "cancel_scheduler",
        requestedAt: at,
        requestedByPrincipalId: "principal_operator",
        reason: "incident_response",
      },
    });
    expect(result.attempts[0]!.usageAtClose!.records).toBe(1);
    expect(result.job.currentLease).toBeNull();
    expect(() =>
      heartbeatPolicyEvaluationJob({ snapshot: result, now: at, recoveryEpoch: 0, fence }),
    ).toThrow(PolicyEvaluationSchedulerTransitionError);
  });
  it("never changes exact semantic time when advancing native operational receipts", () => {
    const initial = queued();
    const result = claim(initial);
    expect(result.request.evaluationTime).toBe(initial.request.evaluationTime);
    expect(policyEvaluationTimestampOrderKey(result.job.currentLease!.expiresAt)).toBeGreaterThan(
      policyEvaluationTimestampOrderKey(start),
    );
  });
});
