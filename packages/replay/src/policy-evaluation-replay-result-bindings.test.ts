import { readFileSync } from "node:fs";
import {
  type ReplayJobSnapshot,
  type ReplayPlan,
  type ReplayPlanDefinition,
  type TargetReleaseDefinition,
  REPLAY_BUDGET_DIMENSIONS,
} from "@proofstack/contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { inspectPolicyEvaluationReplayDefinition } from "./policy-evaluation-replay-definition-reader.js";
import { inspectPolicyEvaluationReplayResultBindings as inspect } from "./policy-evaluation-replay-result-bindings.js";
import {
  inspectPolicyEvaluationReplayResult,
  type PolicyEvaluationReplayResultReadInput,
} from "./policy-evaluation-replay-result-reader.js";
import { digestReplayPlanDefinition } from "./replay-definition-digest.js";
import type { ReplayBudgetAmounts, ReplayUsageMeasurements } from "./replay-budget.js";
import { MemoryReplayDefinitionRepository } from "./testing/memory-replay-definition-repository.js";
import { MemoryReplayJobRepository } from "./testing/memory-replay-job-repository.js";

const time = (ms: number) => new Date(Date.parse("2026-09-08T00:00:00.000Z") + ms).toISOString();
const limits = { maximumRecords: 1000, maximumRecordBytes: 4 * 1024 * 1024 };
async function history(retry: boolean) {
  const { vectors } = JSON.parse(
    readFileSync(new URL("../vectors/replay-definition-v1.json", import.meta.url), "utf8"),
  ) as {
    vectors: {
      kind: string;
      input: ReplayPlanDefinition | TargetReleaseDefinition;
      sha256: string;
    }[];
  };
  const targetVector = vectors.find((v) => v.kind === "target_release");
  if (!targetVector) throw new Error("Missing target vector");
  const planDefinition = vectors.find((v) => v.kind === "replay_plan")
    ?.input as ReplayPlanDefinition;
  planDefinition.retryPolicy = {
    automatic: true,
    backoff: { kind: "fixed", delayMilliseconds: 200 },
    idempotencyRequirement: "no_external_effect",
    maxAttempts: 3,
    perAttemptTimeoutMilliseconds: 1000,
    totalDeadlineMilliseconds: 10000,
    retryableErrors: ["target_process_interrupted", "target_temporary_failure"],
  };
  planDefinition.budget.jobAttempts.limit = 3;
  const receipt = { createdAt: time(0), createdByPrincipalId: "principal_result_binding" };
  const plan = {
    ...planDefinition,
    ...receipt,
    definitionSha256: digestReplayPlanDefinition(planDefinition),
  };
  const definitions = new MemoryReplayDefinitionRepository();
  await definitions.publishTargetRelease({
    ...(targetVector.input as TargetReleaseDefinition),
    ...receipt,
    definitionSha256: targetVector.sha256,
  });
  await definitions.publishReplayPlan(plan);
  let now = time(0);
  const repository = new MemoryReplayJobRepository({ definitions, now: () => now });
  const jobId = "job_result_binding";
  const scope = plan.scope;
  await repository.createJob({
    createdByPrincipalId: "principal_result_binding",
    jobId,
    scope,
    plan: {
      planId: plan.planId,
      planVersionId: plan.planVersionId,
      definitionSha256: plan.definitionSha256,
    },
  });
  const claim = async (n: number) => {
    const result = await repository.claimJob({
      attemptId: `attempt_binding_${n}`,
      jobId,
      leaseDurationMilliseconds: n === 0 && retry ? 100 : 1000,
      leaseId: `lease_binding_${n}`,
      scope,
      workerBuildSha256: "a".repeat(64),
      workerId: "worker_binding",
      workerProtocol: plan.workerProtocol,
    });
    if (!result.claimed) throw new Error("Expected a real claimed attempt");
    return result.workerFence;
  };
  now = time(100);
  let workerFence = await claim(0);
  if (retry) {
    now = time(400);
    workerFence = await claim(1);
  }
  now = time(500);
  const boundary = plan.boundaries[0];
  if (!boundary) throw new Error("Missing boundary");
  const amounts = Object.fromEntries(
    REPLAY_BUDGET_DIMENSIONS.map((d) => [d, d === "jobAttempts" || d === "modelRequests" ? 1 : 0]),
  ) as ReplayBudgetAmounts;
  await repository.reserveBudget({
    reservationId: "reservation_binding",
    scope,
    workerFence,
    work: { kind: "boundary_call", boundaryId: boundary.boundaryId, boundaryKind: boundary.kind },
    requested: amounts,
  });
  await repository.appendExecutionObservation({
    observationId: "observation_boundary",
    scope,
    workerFence,
    payload: {
      kind: "boundary",
      boundaryId: boundary.boundaryId,
      boundaryKind: boundary.kind,
      mode: "recorded_stub",
      executionOrigin: "recorded",
      effectCertainty: "none",
      phase: "request_started",
      afterCancellationRequest: false,
      evidenceSha256: "b".repeat(64),
    },
  });
  await repository.appendExecutionObservation({
    observationId: "observation_target",
    scope,
    workerFence,
    payload: {
      kind: "target",
      event: "started",
      afterCancellationRequest: false,
      evidenceSha256: "c".repeat(64),
    },
  });
  await repository.appendUsageObservation({
    observationId: "observation_usage",
    scope,
    workerFence,
    boundaryId: boundary.boundaryId,
    sourceEventSha256: "d".repeat(64),
    measurements: [
      { dimension: "modelRequests", usage: { status: "observed", amount: 1, source: "measured" } },
    ],
  });
  now = time(600);
  await repository.reconcileBudget({
    reconciliationId: "reconciliation_binding",
    reservationId: "reservation_binding",
    scope,
    workerFence,
    usage: Object.fromEntries(
      REPLAY_BUDGET_DIMENSIONS.map((d) => [
        d,
        { status: "observed", source: "measured", amount: amounts[d] },
      ]),
    ) as ReplayUsageMeasurements,
  });
  now = time(700);
  const snapshot = await repository.completeJob({
    scope,
    workerFence,
    code: "completed",
    status: "succeeded",
    result: {
      artifactId: "artifact_binding_result",
      sha256: "e".repeat(64),
      sizeBytes: 1,
      mediaType: "application/json",
      classification: "internal",
    },
  });
  return { snapshot, plan };
}
let single: Awaited<ReturnType<typeof history>>;
let retried: Awaited<ReturnType<typeof history>>;
beforeAll(async () => {
  single = await history(false);
  retried = await history(true);
});

function harness(
  options: {
    retry?: boolean;
    mutate?: (snapshot: ReplayJobSnapshot, plan: ReplayPlan) => void;
  } = {},
) {
  const base = options.retry ? retried : single;
  const snapshot = JSON.parse(JSON.stringify(base.snapshot)) as ReplayJobSnapshot;
  const plan = structuredClone(base.plan);
  options.mutate?.(snapshot, plan);
  const { createdAt: _at, createdByPrincipalId: _by, definitionSha256: _sha, ...definition } = plan;
  plan.definitionSha256 = digestReplayPlanDefinition(definition);
  const planReference = {
    planId: plan.planId,
    planVersionId: plan.planVersionId,
    definitionSha256: plan.definitionSha256,
  };
  snapshot.job.plan = planReference;
  for (const attempt of snapshot.attempts) attempt.plan = planReference;
  const latest = snapshot.attempts.at(-1);
  if (!latest?.endedAt || !latest.result) throw new Error("Expected successful history");
  const input: PolicyEvaluationReplayResultReadInput = {
    scope: plan.scope,
    evaluationTime: time(20000),
    limits: { ...limits },
    source: {
      kind: "replay_result",
      reference: {
        attemptId: latest.attemptId,
        completedAt: latest.endedAt,
        jobId: snapshot.job.jobId,
        plan: planReference,
        result: latest.result,
        targetRelease: latest.targetRelease,
        terminalCode: "completed",
        terminalStatus: "succeeded",
      },
    },
  };
  const read = inspectPolicyEvaluationReplayResult(input, snapshot);
  const planRead = inspectPolicyEvaluationReplayDefinition(
    {
      scope: plan.scope,
      evaluationTime: input.evaluationTime,
      source: { kind: "replay_plan", reference: planReference },
    },
    plan,
  );
  expect(read.observation.status).toBe("verified");
  expect(planRead.observation.status).toBe("verified");
  return { input, read, planRead, snapshot, plan, execute: () => inspect(input, read, planRead) };
}
const mismatches = (h: ReturnType<typeof harness>) =>
  h
    .execute()
    .checks.filter((c) => c.observation.status === "mismatch")
    .map((c) => c.kind);

describe("captured replay result to plan bindings", () => {
  it("validates a real memory-published completed history and preserves detached full hashes", () => {
    const h = harness();
    const report = h.execute();
    expect(report.checks.length).toBeGreaterThan(20);
    expect(report.checks.every((c) => c.observation.status === "matched")).toBe(true);
    expect(report.recordSha256).toBe(
      h.read.observation.status === "verified" ? h.read.observation.recordSha256 : "",
    );
    expect(report.source).toEqual(h.read.source);
    expect(report.plan).toEqual({
      source: h.planRead.source,
      recordObservation: h.planRead.observation,
    });
    const original = structuredClone([h.read, h.planRead]);
    report.source.reference.jobId = "job_changed";
    report.plan.source.reference.planVersionId = "plan_changed";
    Object.assign(report.plan.recordObservation, { recordSha256: "f".repeat(64) });
    expect([h.read, h.planRead]).toEqual(original);
    expect(report).not.toHaveProperty("eligible");
    expect(report).not.toHaveProperty("sealed");
  });
  it("keeps actual lease-replacement timing unknown without inventing a failure timestamp", () => {
    const h = harness({ retry: true });
    const report = h.execute();
    expect(mismatches(h)).toEqual([]);
    expect(report.checks.filter((c) => c.observation.status === "unavailable")).toEqual([
      {
        kind: "retry_timing",
        path: "/attempts/0",
        observation: { status: "unavailable", reason: "lease_expiry_unretained" },
      },
    ]);
    expect(report.checks.filter((c) => c.kind === "runtime_profile")).toHaveLength(2);
    expect(h.snapshot.attempts[0]?.endedAt).toBe(h.snapshot.attempts[1]?.startedAt);
  });
  it.each(["runtime_profile", "isolation_profile", "target_release", "worker_protocol"] as const)(
    "detects %s substitutions in the prior attempt, not only the successful last attempt",
    (kind) => {
      const h = harness({
        retry: true,
        mutate: (s) => {
          const a = s.attempts[0];
          if (!a) throw new Error("Missing attempt");
          if (kind === "runtime_profile") a.runtimeProfile.definitionSha256 = "f".repeat(64);
          if (kind === "isolation_profile") a.isolationProfile.definitionSha256 = "f".repeat(64);
          if (kind === "target_release") a.targetRelease.targetReleaseId = "target_other";
          if (kind === "worker_protocol") {
            a.workerProtocol.version = "99";
            a.targetRelease.workerProtocol.version = "99";
          }
        },
      });
      expect(mismatches(h)).toContain(kind);
      expect(
        h
          .execute()
          .checks.filter((c) => c.observation.status === "mismatch")
          .every((c) => c.path.startsWith("/attempts/0/")),
      ).toBe(true);
    },
  );
  it.each(["plan_receipt", "start_receipt", "attempt_count", "retry_declaration"])(
    "detects inconsistent %s with valid record-level hashes",
    (kind) => {
      const h = harness({
        retry: true,
        mutate: (s, p) => {
          if (kind === "plan_receipt") p.createdAt = time(50);
          if (kind === "start_receipt") s.job.startedAt = time(99);
          if (kind === "attempt_count") {
            p.retryPolicy.maxAttempts = 1;
            p.retryPolicy.automatic = false;
            p.retryPolicy.retryableErrors = [];
            p.retryPolicy.backoff = { kind: "none" };
            p.budget.jobAttempts.limit = 1;
          }
          if (kind === "retry_declaration") p.retryPolicy.retryableErrors = [];
        },
      });
      expect(mismatches(h)).toContain(kind);
    },
  );
  it.each([
    "limit",
    "measurement",
    "budget_id",
    "budget_kind",
    "execution_id",
    "execution_kind",
    "execution_mode",
    "usage_id",
  ])("detects declared boundary or budget mismatch: %s", (kind) => {
    const h = harness({
      mutate: (s) => {
        const r = s.budgetLedger[0];
        const e = s.executionObservations[0];
        const u = s.usageObservations[0];
        if (
          r?.entryType !== "reservation" ||
          r.work.kind !== "boundary_call" ||
          e?.payload.kind !== "boundary" ||
          !u
        )
          throw new Error("Missing history");
        if (kind === "limit") r.dimensions.modelRequests.limit++;
        if (kind === "measurement") r.dimensions.modelRequests.measurement = "unavailable";
        if (kind === "budget_id") r.work.boundaryId = "boundary_other";
        if (kind === "budget_kind") r.work.boundaryKind = "tool";
        if (kind === "execution_id") e.payload.boundaryId = "boundary_other";
        if (kind === "execution_kind") e.payload.boundaryKind = "tool";
        if (kind === "execution_mode") {
          e.payload.mode = "simulation";
          e.payload.executionOrigin = "simulated";
        }
        if (kind === "usage_id") u.boundaryId = "boundary_other";
      },
    });
    expect(mismatches(h)).toEqual([
      kind === "limit" || kind === "measurement"
        ? "budget_policy"
        : kind.startsWith("budget")
          ? "budget_boundary"
          : kind.startsWith("execution")
            ? "execution_boundary"
            : "usage_boundary",
    ]);
  });
  it.each([
    "reservation_early",
    "reservation_late",
    "reconciliation_late",
    "execution_late",
    "usage_late",
  ])("detects causally impossible receipt: %s", (kind) => {
    const h = harness({
      mutate: (s) => {
        const reservation = s.budgetLedger[0];
        const reconciliation = s.budgetLedger[1];
        if (
          reservation?.entryType !== "reservation" ||
          reconciliation?.entryType !== "reconciliation" ||
          !s.executionObservations[0] ||
          !s.usageObservations[0]
        )
          throw new Error("Missing history");
        if (kind === "reservation_early") reservation.reservedAt = time(50);
        if (kind === "reservation_late") reservation.reservedAt = time(800);
        if (kind === "reconciliation_late") reconciliation.reconciledAt = time(800);
        if (kind === "execution_late") s.executionObservations[0].observedAt = time(800);
        if (kind === "usage_late") s.usageObservations[0].observedAt = time(800);
      },
    });
    expect(mismatches(h)).toContain("history_receipt");
  });

  it.each(REPLAY_BUDGET_DIMENSIONS)(
    "binds the exact plan limit for budget dimension %s",
    (dimension) => {
      const h = harness({
        mutate: (s) => {
          const entry = s.budgetLedger[0];
          if (entry?.entryType !== "reservation") throw new Error("Missing reservation");
          entry.dimensions[dimension].limit++;
        },
      });
      expect(h.execute().checks.filter((c) => c.observation.status === "mismatch")).toEqual([
        {
          kind: "budget_policy",
          path: `/budgetLedger/0/dimensions/${dimension}`,
          observation: { status: "mismatch" },
        },
      ]);
    },
  );

  it("accepts exact inclusive attempt receipt boundaries", () => {
    const h = harness({
      mutate: (s) => {
        const start = s.attempts[0]?.startedAt;
        const end = s.attempts[0]?.endedAt;
        const reservation = s.budgetLedger[0];
        const reconciliation = s.budgetLedger[1];
        if (
          !start ||
          !end ||
          reservation?.entryType !== "reservation" ||
          reconciliation?.entryType !== "reconciliation"
        )
          throw new Error("Missing history");
        reservation.reservedAt = start;
        reconciliation.reconciledAt = end;
      },
    });
    expect(mismatches(h)).toEqual([]);
  });
  it.each(["open", "overrun", "disputed"])(
    "does not erase %s accounting from a successful result",
    (kind) => {
      const h = harness({
        mutate: (s) => {
          if (kind === "open") {
            s.budgetLedger.pop();
            return;
          }
          const entry = s.budgetLedger[1];
          if (entry?.entryType !== "reconciliation") throw new Error("Missing reconciliation");
          const d = entry.dimensions.inputTokens;
          if (kind === "overrun") {
            d.actualUsage = { status: "observed", amount: 1, source: "measured" };
            d.disposition = "overrun";
            d.overrunAmount = 1;
          } else {
            d.actualUsage = { status: "unavailable", reason: "measurement_failed" };
            d.disposition = "disputed";
          }
        },
      });
      if (kind === "disputed")
        expect(h.execute().checks.find((c) => c.kind === "budget_usage")?.observation).toEqual({
          status: "unavailable",
          reason: "usage_unavailable",
        });
      else expect(mismatches(h)).toEqual([kind === "open" ? "budget_closed" : "budget_overrun"]);
    },
  );
  it.each(["valid", "early", "deadline", "ineligible", "successful_prior", "control_prior"])(
    "checks declared failure retries without losing %s evidence",
    (kind) => {
      const h = harness({
        retry: true,
        mutate: (s, p) => {
          const prior = s.attempts[0];
          if (!prior) throw new Error("Missing prior attempt");
          prior.status = "failed";
          prior.endedAt = time(kind === "early" ? 300 : 200);
          prior.error = {
            code: "target_temporary_failure",
            message: "Retained failure",
            effectCertainty: "none",
          };
          if (kind === "deadline") {
            p.retryPolicy.totalDeadlineMilliseconds = 1000;
          }
          if (kind === "ineligible") prior.retryDisposition = "retry_eligible";
          if (kind === "successful_prior") {
            prior.status = "succeeded";
            delete prior.error;
            prior.result = s.attempts[1]?.result;
            prior.retryDisposition = "not_retryable";
          }
          if (kind === "control_prior") {
            prior.status = "timed_out";
            prior.error = {
              code: "deadline_exceeded",
              message: "Retained timeout",
              effectCertainty: "none",
            };
            prior.retryDisposition = "not_retryable";
          }
        },
      });
      if (kind === "valid") expect(mismatches(h)).toEqual([]);
      else expect(mismatches(h)).toContain("retry_timing");
    },
  );
  it("permits global usage and non-boundary work without manufacturing boundary checks", () => {
    const h = harness({
      mutate: (s) => {
        if (s.usageObservations[0]) delete s.usageObservations[0].boundaryId;
        const r = s.budgetLedger[0];
        if (r?.entryType === "reservation") r.work = { kind: "attempt_start" };
      },
    });
    expect(mismatches(h)).toEqual([]);
    expect(
      h.execute().checks.some((c) => c.kind === "usage_boundary" || c.kind === "budget_boundary"),
    ).toBe(false);
  });

  it("rejects reconciliation receipts preceding their own reservation inside an otherwise valid attempt", () => {
    const h = harness({
      mutate: (s) => {
        const entry = s.budgetLedger[1];
        if (entry?.entryType !== "reconciliation") throw new Error("Missing reconciliation");
        entry.reconciledAt = time(450);
      },
    });
    expect(mismatches(h)).toEqual(["budget_reconciliation_receipt"]);
  });
  it.each(["missing", "record_invalid", "reference_mismatch", "not_yet_available"])(
    "keeps unavailable plan reason %s and independent accounting checks",
    (reason) => {
      const h = harness({ retry: true });
      const observation =
        reason === "missing" ? { status: "missing" } : { status: "unavailable", reason };
      Object.assign(h.planRead, { record: null, observation });
      const result = h.execute();
      expect(result.plan.recordObservation).toEqual(observation);
      expect(result.checks.find((c) => c.kind === "runtime_profile")?.observation).toEqual({
        status: "unavailable",
        reason: "plan_unavailable",
      });
      expect(result.checks.find((c) => c.kind === "retry_timing")?.observation).toEqual({
        status: "unavailable",
        reason: "plan_unavailable",
      });
      expect(result.checks.find((c) => c.kind === "budget_closed")?.observation.status).toBe(
        "matched",
      );
      expect(result.checks.some((c) => c.observation.status === "mismatch")).toBe(false);
    },
  );
  it.each([
    "null",
    "extra",
    "hidden",
    "getter",
    "missing_key",
    "wrong_reference",
    "unverified_body",
    "malformed_observation",
    "plan_hash",
    "result_hash",
    "result_missing",
    "input",
    "row_limit",
    "byte_limit",
  ])("rejects invalid captured inputs: %s", (kind) => {
    const h = harness();
    const getter = vi.fn(() => h.plan);
    if (kind === "null") return expect(() => inspect(h.input, h.read, null as never)).toThrow();
    if (kind === "extra") Object.assign(h.planRead, { extra: true });
    if (kind === "hidden") Object.defineProperty(h.planRead, "record", { enumerable: false });
    if (kind === "getter") Object.defineProperty(h.planRead, "record", { get: getter });
    if (kind === "missing_key") {
      Reflect.deleteProperty(h.planRead, "record");
      Object.assign(h.planRead, { other: true });
    }
    if (kind === "wrong_reference") h.planRead.source.reference.definitionSha256 = "f".repeat(64);
    if (kind === "unverified_body")
      Object.assign(h.planRead, { observation: { status: "missing" } });
    if (kind === "malformed_observation")
      Object.assign(h.planRead, { observation: { status: "approved" } });
    if (kind === "plan_hash")
      Object.assign(h.planRead.observation, { recordSha256: "f".repeat(64) });
    if (kind === "result_hash") Object.assign(h.read.observation, { recordSha256: "f".repeat(64) });
    if (kind === "result_missing")
      Object.assign(h.read, { record: null, observation: { status: "missing" } });
    if (kind === "input") Object.assign(h.input, { evaluationTime: "not_a_time" });
    if (kind === "row_limit") Object.assign(h.input.limits, { maximumRecords: 2 });
    if (kind === "byte_limit") Object.assign(h.input.limits, { maximumRecordBytes: 1 });
    expect(h.execute).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});
