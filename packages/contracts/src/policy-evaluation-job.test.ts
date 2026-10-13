import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_POLICY_EVALUATION_JOB_RESPONSE_BYTES,
  ReadPolicyEvaluationJobResponseSchema,
  RequestPolicyEvaluationCancellationSchema,
} from "./policy-evaluation-job-api.js";
import {
  PolicyEvaluationAttemptSchema,
  type PolicyEvaluationUsage,
} from "./policy-evaluation-attempt.js";
import { encodePolicyEvaluationJobDefinition } from "./policy-evaluation-job-encoding.js";
import { encodePolicyEvaluationRequestDefinition } from "./policy-evaluation-request-encoding.js";
import { PolicyEvaluationLeaseSchema } from "./policy-evaluation-job-fence.js";
import {
  PolicyEvaluationJobSchema,
  PolicyEvaluationJobDefinitionSchema,
} from "./policy-evaluation-job.js";
import {
  PolicyEvaluationJobSnapshotSchema,
  type PolicyEvaluationJobSnapshot,
} from "./policy-evaluation-job-snapshot.js";

const vector = JSON.parse(
  readFileSync(
    new URL("../vectors/policy-evaluation-request-definition-v1.json", import.meta.url),
    "utf8",
  ),
).vectors[0];
const zero: PolicyEvaluationUsage = {
  reads: 0,
  records: 0,
  recordBytes: 0,
  references: 0,
  referenceBytes: 0,
  artifactReadBytes: 0,
  ruleEvaluations: 0,
};
export function initialPolicyJobFixture(): PolicyEvaluationJobSnapshot {
  const request = {
    ...structuredClone(vector.input.definition),
    scope: structuredClone(vector.input.scope),
    definitionSha256: vector.sha256,
    schemaVersion: "0.1",
    createdAt: "2026-09-07T12:00:00.000Z",
    createdByPrincipalId: "principal_controller",
  };
  const definition = {
    jobId: "job_policy",
    request: {
      evaluationRequestId: request.evaluationRequestId,
      definitionSha256: request.definitionSha256,
    },
  };
  return PolicyEvaluationJobSnapshotSchema.parse({
    request,
    attempts: [],
    cancellation: null,
    usage: { ...zero },
    job: {
      ...definition,
      scope: request.scope,
      definitionSha256: createHash("sha256")
        .update(encodePolicyEvaluationJobDefinition({ definition, scope: request.scope }))
        .digest("hex"),
      schemaVersion: "0.1",
      createdAt: "2026-09-07T12:00:00.123456Z",
      createdByPrincipalId: request.createdByPrincipalId,
      deadlineAt: "2026-09-07T12:10:00.000Z",
      updatedAt: "2026-09-07T12:00:00.123456Z",
      stateVersion: 1,
      recoveryEpoch: 0,
      lastFencingToken: 0,
      attemptCount: 0,
      status: "queued",
      currentLease: null,
      snapshot: null,
      result: null,
      retryAt: null,
      terminal: null,
    },
  });
}
function active(computing = false): PolicyEvaluationJobSnapshot {
  const result = initialPolicyJobFixture();
  const fence = {
    jobId: result.job.jobId,
    attemptId: "attempt_policy",
    workerId: "worker_policy",
    leaseId: "lease_policy",
    fencingToken: 1,
    recoveryEpoch: 0,
  };
  const snapshot = computing
    ? { snapshotId: "snapshot_policy", definitionSha256: "3".repeat(64) }
    : null;
  result.job = {
    ...result.job,
    status: computing ? "running" : "acquiring",
    stateVersion: 2,
    attemptCount: 1,
    lastFencingToken: 1,
    snapshot,
    updatedAt: "2026-09-07T12:00:01.000000Z",
    currentLease: {
      scope: result.job.scope,
      schemaVersion: "0.1",
      mutationFence: fence,
      attemptSequence: 0,
      acquiredAt: "2026-09-07T12:00:01.000000Z",
      heartbeatAt: "2026-09-07T12:00:01.000000Z",
      expiresAt: "2026-09-07T12:00:31.000000Z",
      attemptDeadlineAt: "2026-09-07T12:02:01.000000Z",
      jobDeadlineAt: result.job.deadlineAt,
    },
  };
  result.attempts = [
    {
      schemaVersion: "0.1",
      scope: result.job.scope,
      mutationFence: fence,
      attemptSequence: 0,
      phase: computing ? "computing" : "acquiring",
      snapshot,
      startedAt: "2026-09-07T12:00:01.000000Z",
      deadlineAt: "2026-09-07T12:02:01.000000Z",
      usageAtStart: { ...zero },
      usageAtClose: null,
      closure: null,
    },
  ];
  return result;
}
function completed(): PolicyEvaluationJobSnapshot {
  const result = active(true);
  const at = "2026-09-07T12:00:02.123456Z";
  result.usage = { ...zero, reads: 2, records: 2, recordBytes: 100, ruleEvaluations: 7 };
  result.attempts[0]!.usageAtClose = { ...result.usage };
  result.attempts[0]!.closure = { status: "completed", committedAt: at };
  result.job = {
    ...result.job,
    status: "completed",
    currentLease: null,
    updatedAt: at,
    stateVersion: 3,
    result: { evaluationId: "evaluation_policy", definitionSha256: "4".repeat(64) },
    terminal: {
      status: "completed",
      code: "evaluation_completed",
      attemptId: "attempt_policy",
      committedAt: at,
    },
  };
  return result;
}
function retry(computing = false): PolicyEvaluationJobSnapshot {
  const result = active(computing);
  const at = "2026-09-07T12:00:02.000000Z";
  result.usage = { ...zero, reads: 2, records: 2, recordBytes: 100 };
  result.attempts[0]!.usageAtClose = { ...result.usage };
  result.attempts[0]!.closure = {
    status: "interrupted",
    reason: "worker_interrupted",
    committedAt: at,
  };
  result.job = {
    ...result.job,
    status: "retry_ready",
    currentLease: null,
    updatedAt: at,
    stateVersion: 3,
    retryAt: "2026-09-07T12:00:03.000000Z",
  };
  return result;
}
describe("request-owned policy scheduler graph contracts", () => {
  it.each(["queued", "acquiring", "running", "completed", "retry_before", "retry_after", "sealed"])(
    "retains valid %s graph without granting publication authority",
    (kind) => {
      const result =
        kind === "queued"
          ? initialPolicyJobFixture()
          : kind === "completed"
            ? completed()
            : kind === "retry_before"
              ? retry()
              : kind === "retry_after"
                ? retry(true)
                : active(kind !== "acquiring");
      if (kind === "sealed") result.job.status = "sealed";
      expect(PolicyEvaluationJobSnapshotSchema.parse(result)).toEqual(result);
      expect(PolicyEvaluationJobDefinitionSchema.safeParse(result.job).success).toBe(false);
    },
  );
  it("retains cancellation before the first claim without fabricating attempt or lease", () => {
    const result = initialPolicyJobFixture();
    const at = "2026-09-07T12:00:00.234567Z";
    result.cancellation = {
      jobId: result.job.jobId,
      cancellationId: "cancel_policy",
      scope: result.job.scope,
      requestedAt: at,
      requestedByPrincipalId: "principal_operator",
      reason: "operator_requested",
    };
    result.job = {
      ...result.job,
      status: "cancelled",
      updatedAt: at,
      terminal: {
        status: "cancelled",
        code: "cancellation_committed",
        attemptId: null,
        committedAt: at,
      },
    };
    expect(PolicyEvaluationJobSnapshotSchema.parse(result)).toEqual(result);
    expect(
      PolicyEvaluationJobSnapshotSchema.safeParse({ ...result, cancellation: null }).success,
    ).toBe(false);
  });
  it.each(["heartbeat", "expiry_equal", "expiry_after_timeout", "timeout_after_job"])(
    "rejects native lease receipt violation %s",
    (kind) => {
      const lease = active().job.currentLease!;
      if (kind === "heartbeat") lease.heartbeatAt = "2026-09-07T12:00:00.999999Z";
      else if (kind === "expiry_equal") lease.expiresAt = lease.heartbeatAt;
      else if (kind === "expiry_after_timeout") lease.expiresAt = "2026-09-07T12:02:01.000001Z";
      else lease.attemptDeadlineAt = "2026-09-07T12:10:00.000001Z";
      expect(PolicyEvaluationLeaseSchema.safeParse(lease).success).toBe(false);
    },
  );
  it.each(["tenant", "project", "environment", "job", "fence", "epoch", "sequence", "deadline"])(
    "rejects substituted lease binding %s",
    (kind) => {
      const result = active();
      const lease = result.job.currentLease!;
      if (kind === "tenant") lease.scope = { ...lease.scope, tenantId: "outside_tenant" };
      else if (kind === "project") lease.scope = { ...lease.scope, projectId: "outside_project" };
      else if (kind === "environment")
        lease.scope = { ...lease.scope, environmentId: "outside_environment" };
      else if (kind === "job")
        lease.mutationFence = { ...lease.mutationFence, jobId: "outside_job" };
      else if (kind === "fence") lease.mutationFence = { ...lease.mutationFence, fencingToken: 2 };
      else if (kind === "epoch") lease.mutationFence = { ...lease.mutationFence, recoveryEpoch: 1 };
      else if (kind === "sequence") lease.attemptSequence = 1;
      else lease.jobDeadlineAt = "2026-09-07T12:09:00.000Z";
      expect(PolicyEvaluationJobSchema.safeParse(result.job).success).toBe(false);
    },
  );
  it.each([
    "request",
    "deadline",
    "creator",
    "attempt_omitted",
    "timeout_extended",
    "usage_refund",
    "result_missing",
    "completion_interrupted",
  ])("rejects contradictory complete graph %s", (kind) => {
    const result = completed();
    if (kind === "request")
      result.job.request = { ...result.job.request, evaluationRequestId: "request_other" };
    else if (kind === "deadline") result.job.deadlineAt = "2026-09-07T12:11:00.000Z";
    else if (kind === "creator") result.job.createdByPrincipalId = "principal_other";
    else if (kind === "attempt_omitted") result.attempts = [];
    else if (kind === "timeout_extended")
      result.attempts[0]!.deadlineAt = "2026-09-07T12:03:00.000Z";
    else if (kind === "usage_refund") result.usage.records = 1;
    else if (kind === "result_missing") result.job.result = null;
    else
      result.attempts[0]!.closure = {
        status: "interrupted",
        reason: "worker_interrupted",
        committedAt: result.job.updatedAt,
      };
    expect(PolicyEvaluationJobSnapshotSchema.safeParse(result).success).toBe(false);
  });
  it("refuses source recapture or budget refund after sealing", () => {
    const result = retry(true);
    const attempt = result.attempts[0]!;
    expect(
      PolicyEvaluationAttemptSchema.safeParse({
        ...attempt,
        closure: {
          status: "interrupted",
          reason: "source_revision_changed",
          committedAt: result.job.updatedAt,
        },
      }).success,
    ).toBe(false);
    expect(
      PolicyEvaluationAttemptSchema.safeParse({ ...attempt, usageAtStart: { ...zero, records: 3 } })
        .success,
    ).toBe(false);
  });
  it("cannot discard starting usage while an attempt remains open", () => {
    const result = active();
    result.attempts[0]!.usageAtStart.records = 1;
    expect(PolicyEvaluationJobSnapshotSchema.safeParse(result).success).toBe(false);
  });
  it("cannot extend a live lease beyond its frozen request duration", () => {
    const result = active();
    result.job.currentLease!.expiresAt = "2026-09-07T12:00:31.000001Z";
    expect(PolicyEvaluationJobSnapshotSchema.safeParse(result).success).toBe(false);
  });
  it("rejects over-limit attempt history before inspecting nested bodies", () => {
    const getter = vi.fn(() => {
      throw new Error("Do not read oversized nested history");
    });
    expect(
      PolicyEvaluationJobSnapshotSchema.safeParse({
        ...initialPolicyJobFixture(),
        attempts: Array.from({ length: 9 }, () => ({
          get mutationFence() {
            return getter();
          },
        })),
      }).success,
    ).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
  it("bounds compact scheduler response and cancellation input without accepting worker identity", () => {
    const response = { snapshot: completed(), requestId: "\u0000".repeat(128) };
    expect(ReadPolicyEvaluationJobResponseSchema.parse(response)).toEqual(response);
    expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThan(
      MAX_POLICY_EVALUATION_JOB_RESPONSE_BYTES,
    );
    expect(
      RequestPolicyEvaluationCancellationSchema.parse({ reason: "operator_requested" }),
    ).toEqual({ reason: "operator_requested" });
    expect(
      RequestPolicyEvaluationCancellationSchema.safeParse({
        reason: "operator_requested",
        workerId: "worker_forged",
      }).success,
    ).toBe(false);
  });
  it("preserves maximum complete attempt history within independent response headroom", () => {
    const result = retry(true);
    result.request.limits.maxAttempts = 8;
    const {
      createdAt: _createdAt,
      createdByPrincipalId: _by,
      scope,
      definitionSha256: _sha,
      schemaVersion: _version,
      ...definition
    } = result.request;
    result.request.definitionSha256 = createHash("sha256")
      .update(encodePolicyEvaluationRequestDefinition({ definition, scope }))
      .digest("hex");
    result.job.request.definitionSha256 = result.request.definitionSha256;
    result.job.definitionSha256 = createHash("sha256")
      .update(
        encodePolicyEvaluationJobDefinition({
          scope,
          definition: { jobId: result.job.jobId, request: result.job.request },
        }),
      )
      .digest("hex");
    const first = result.attempts[0]!;
    result.attempts = Array.from({ length: 8 }, (_, index) => {
      const attempt = structuredClone(first);
      attempt.attemptSequence = index;
      attempt.mutationFence = {
        ...attempt.mutationFence,
        fencingToken: index + 1,
        attemptId: `attempt_${String(index).padStart(2, "0")}_${"a".repeat(53)}`,
        leaseId: `lease_${String(index).padStart(2, "0")}_${"a".repeat(55)}`,
      };
      attempt.startedAt = new Date(Date.UTC(2026, 8, 7, 12, 0, index + 1)).toISOString();
      attempt.deadlineAt = new Date(Date.UTC(2026, 8, 7, 12, 2, index + 1)).toISOString();
      attempt.closure = {
        status: "interrupted",
        reason: "worker_interrupted",
        committedAt: new Date(Date.UTC(2026, 8, 7, 12, 0, index + 2)).toISOString(),
      };
      attempt.usageAtStart = { ...result.usage };
      return attempt;
    });
    result.job.status = "failed";
    result.job.attemptCount = 8;
    result.job.lastFencingToken = 8;
    result.job.retryAt = null;
    result.job.updatedAt = "2026-09-07T12:00:09.000Z";
    result.job.terminal = {
      status: "failed",
      code: "retries_exhausted",
      attemptId: result.attempts[7]!.mutationFence.attemptId,
      committedAt: result.job.updatedAt,
    };
    const response = { snapshot: result, requestId: "\u0000".repeat(128) };
    expect(ReadPolicyEvaluationJobResponseSchema.parse(response)).toEqual(response);
    expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThan(
      MAX_POLICY_EVALUATION_JOB_RESPONSE_BYTES,
    );
    expect(
      PolicyEvaluationJobSnapshotSchema.safeParse({
        ...result,
        job: {
          ...result.job,
          status: "retry_ready",
          terminal: null,
          retryAt: "2026-09-07T12:00:10.000Z",
        },
      }).success,
    ).toBe(false);
  });
  it.each([
    "missing_closure",
    "overlap",
    "snapshot_changed",
    "budget_reset",
    "attempt_reused",
    "lease_reused",
  ])("rejects retry history violation %s", (kind) => {
    const result = retry(true);
    const first = result.attempts[0]!;
    const second = structuredClone(first);
    second.attemptSequence = 1;
    second.mutationFence = {
      ...second.mutationFence,
      attemptId: "attempt_second",
      leaseId: "lease_second",
      fencingToken: 2,
    };
    second.startedAt = "2026-09-07T12:00:03.000000Z";
    second.deadlineAt = "2026-09-07T12:02:03.000000Z";
    second.usageAtStart = { ...result.usage };
    second.closure = {
      status: "interrupted",
      reason: "worker_interrupted",
      committedAt: "2026-09-07T12:00:04.000000Z",
    };
    result.attempts.push(second);
    result.job.attemptCount = 2;
    result.job.lastFencingToken = 2;
    result.job.updatedAt = "2026-09-07T12:00:04.000000Z";
    result.job.retryAt = "2026-09-07T12:00:05.000000Z";
    expect(PolicyEvaluationJobSnapshotSchema.safeParse(result).success).toBe(true);
    if (kind === "missing_closure") {
      first.closure = null;
      first.usageAtClose = null;
    } else if (kind === "overlap")
      first.closure = {
        status: "interrupted",
        reason: "worker_interrupted",
        committedAt: "2026-09-07T12:00:03.000001Z",
      };
    else if (kind === "snapshot_changed")
      second.snapshot = { snapshotId: "snapshot_other", definitionSha256: "5".repeat(64) };
    else if (kind === "budget_reset") second.usageAtStart.records = 0;
    else if (kind === "attempt_reused")
      second.mutationFence.attemptId = first.mutationFence.attemptId;
    else second.mutationFence.leaseId = first.mutationFence.leaseId;
    expect(PolicyEvaluationJobSnapshotSchema.safeParse(result).success).toBe(false);
  });
});
