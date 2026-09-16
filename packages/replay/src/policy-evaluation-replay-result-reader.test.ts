import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
  REPLAY_BUDGET_DIMENSIONS,
  type ReplayJobSnapshot,
  ReplayJobSnapshotSchema,
  type ReplayPlan,
  type ReplayPlanDefinition,
  type TargetRelease,
  type TargetReleaseDefinition,
} from "@proofstack/contracts";
import { revalidatePolicyEvaluationCapturedRecord } from "@proofstack/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  inspectPolicyEvaluationReplayResult,
  type PolicyEvaluationReplayResultReadInput,
  type PolicyEvaluationReplayResultSource,
  readPolicyEvaluationReplayResult,
} from "./policy-evaluation-replay-result-reader.js";
import type { ReplayBudgetAmounts, ReplayUsageMeasurements } from "./replay-budget.js";
import type { ReplayJobControlRepository } from "./replay-job-repository.js";
import { MemoryReplayDefinitionRepository } from "./testing/memory-replay-definition-repository.js";
import { MemoryReplayJobRepository } from "./testing/memory-replay-job-repository.js";

const time = (fraction: string) => `2026-09-08T00:00:00.${fraction}Z`;
const sha = (digit: string) => digit.repeat(64);
const invalid = { reason: "record_invalid", status: "unavailable" };
const mismatch = { reason: "reference_mismatch", status: "unavailable" };
const future = { reason: "not_yet_available", status: "unavailable" };
const limits = { maximumRecordBytes: 1024 * 1024, maximumRecords: 1000 };

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, sorted(child)]),
    );
  }
  return value;
}
const json = (value: unknown) => JSON.stringify(sorted(value));
const hash = (value: unknown) => createHash("sha256").update(json(value)).digest("hex");
function terminal(value: ReplayJobSnapshot) {
  if (!value.job.terminal) throw new Error("Expected a terminal fixture");
  return value.job.terminal;
}
function last(value: ReplayJobSnapshot) {
  const result = value.attempts.at(-1);
  if (!result) throw new Error("Expected an attempt fixture");
  return result;
}
function command(value: ReplayJobSnapshot) {
  const attempt = last(value);
  if (!attempt.endedAt || !attempt.result) throw new Error("Expected a successful fixture");
  return {
    evaluationTime: time("600"),
    limits: { ...limits },
    scope: structuredClone(value.job.scope),
    source: {
      kind: "replay_result",
      reference: {
        attemptId: attempt.attemptId,
        completedAt: attempt.endedAt,
        jobId: value.job.jobId,
        plan: structuredClone(value.job.plan),
        result: structuredClone(attempt.result),
        targetRelease: structuredClone(attempt.targetRelease),
        terminalCode: "completed",
        terminalStatus: "succeeded",
      },
    },
  } satisfies PolicyEvaluationReplayResultReadInput;
}
function port(raw: unknown) {
  return {
    findJob: vi.fn<ReplayJobControlRepository["findJob"]>(async () => raw as ReplayJobSnapshot),
  };
}
const wire = (value: unknown): ReplayJobSnapshot =>
  JSON.parse(JSON.stringify(value)) as ReplayJobSnapshot;

async function memoryHistory() {
  const { vectors } = JSON.parse(
    readFileSync(new URL("../vectors/replay-definition-v1.json", import.meta.url), "utf8"),
  ) as {
    vectors: {
      kind: string;
      input: ReplayPlanDefinition | TargetReleaseDefinition;
      sha256: string;
    }[];
  };
  const definitions = new MemoryReplayDefinitionRepository();
  const records = vectors.map((vector) => ({
    ...vector.input,
    createdAt: time("000"),
    createdByPrincipalId: "usr_author",
    definitionSha256: vector.sha256,
  }));
  const release = records.find((value) => "targetReleaseId" in value) as TargetRelease;
  const plan = records.find((value) => "planVersionId" in value) as ReplayPlan;
  await definitions.publishTargetRelease(release);
  await definitions.publishReplayPlan(plan);
  let now = time("000");
  const repository = new MemoryReplayJobRepository({ definitions, now: () => now });
  const scope = plan.scope;
  const { snapshot: queued } = await repository.createJob({
    createdByPrincipalId: "usr_requester",
    jobId: "job_policy_source",
    scope,
    plan: {
      planId: plan.planId,
      planVersionId: plan.planVersionId,
      definitionSha256: plan.definitionSha256,
    },
  });
  now = time("100");
  const claimed = await repository.claimJob({
    attemptId: "att_policy_source",
    jobId: queued.job.jobId,
    leaseDurationMilliseconds: 2000,
    leaseId: "lease_policy_source",
    scope,
    workerBuildSha256: sha("c"),
    workerId: "worker_source",
    workerProtocol: plan.workerProtocol,
  });
  if (!claimed.claimed) throw new Error("Expected the reference repository to claim the fixture");
  const workerFence = claimed.workerFence;
  now = time("200");
  await repository.reserveBudget({
    reservationId: "reservation_source",
    scope,
    workerFence,
    work: { kind: "attempt_start" },
    requested: Object.fromEntries(
      REPLAY_BUDGET_DIMENSIONS.map((dimension) => [dimension, dimension === "jobAttempts" ? 1 : 0]),
    ) as ReplayBudgetAmounts,
  });
  await repository.appendExecutionObservation({
    observationId: "observation_source_execution",
    scope,
    workerFence,
    payload: {
      kind: "target",
      event: "started",
      afterCancellationRequest: false,
      evidenceSha256: sha("e"),
    },
  });
  await repository.appendUsageObservation({
    observationId: "observation_source_usage",
    scope,
    workerFence,
    sourceEventSha256: sha("d"),
    measurements: [
      {
        dimension: "elapsedMilliseconds",
        usage: { status: "observed", amount: 100, source: "measured" },
      },
    ],
  });
  now = time("300");
  await repository.reconcileBudget({
    reconciliationId: "reconciliation_source",
    reservationId: "reservation_source",
    scope,
    workerFence,
    usage: Object.fromEntries(
      REPLAY_BUDGET_DIMENSIONS.map((dimension) => [
        dimension,
        {
          status: "observed",
          amount: dimension === "jobAttempts" ? 1 : 0,
          source: "measured",
        },
      ]),
    ) as ReplayUsageMeasurements,
  });
  now = time("500");
  const completed = await repository.completeJob({
    code: "completed",
    status: "succeeded",
    scope,
    workerFence,
    result: {
      artifactId: "art_source_result",
      classification: "internal",
      mediaType: "application/json",
      sha256: sha("f"),
      sizeBytes: 128,
    },
  });
  return { completed, queued, repository, running: claimed.snapshot };
}

let actual: Awaited<ReturnType<typeof memoryHistory>>;
let retained: ReplayJobSnapshot;
beforeAll(async () => {
  actual = await memoryHistory();
  retained = wire(actual.completed);
  // The reference supports a later database commit receipt than the attempt's completion instant.
  terminal(retained).committedAt = time("600");
  expect(ReplayJobSnapshotSchema.safeParse(retained).success).toBe(true);
});
const fixture = () => structuredClone(retained);

function withCancellation(): ReplayJobSnapshot {
  const value = fixture();
  value.job.status = "cancelled";
  Object.assign(terminal(value), { status: "cancelled", code: "cancellation_committed" });
  Object.assign(last(value), {
    status: "cancelled",
    result: undefined,
    error: { code: "cancelled", effectCertainty: "none", message: "Cancellation won the commit." },
  });
  value.cancellationRequest = {
    cancellationId: "cancel_source",
    jobId: value.job.jobId,
    reason: "보관된 취소 요청 — retained intent",
    reasonCode: "operator_request",
    requestedAt: time("200"),
    requestedByPrincipalId: "usr_requester",
    schemaVersion: "0.1",
    scope: structuredClone(value.job.scope),
  };
  value.cancellationAcknowledgements = [
    {
      acknowledgementId: "ack_source",
      action: "stop_requested",
      cancellationId: "cancel_source",
      acknowledgedAt: time("300"),
      mutationFence: structuredClone(last(value).mutationFence),
      schemaVersion: "0.1",
      scope: structuredClone(value.job.scope),
    },
  ];
  expect(ReplayJobSnapshotSchema.safeParse(value).success).toBe(true);
  return value;
}

function withPriorAttempt(): ReplayJobSnapshot {
  const value = fixture();
  const latest = last(value);
  const prior = structuredClone(latest);
  Object.assign(prior, {
    attemptId: "att_prior",
    endedAt: latest.startedAt,
    result: undefined,
    retryDisposition: "retry_scheduled",
    startedAt: time("010"),
    status: "lease_expired",
    error: { code: "lease_expired", effectCertainty: "none", message: "The prior lease expired." },
  });
  Object.assign(prior.mutationFence, { attemptId: prior.attemptId, leaseId: "lease_prior" });
  latest.attemptSequence = 1;
  latest.mutationFence.fencingToken = 2;
  for (const row of [
    ...value.budgetLedger,
    ...value.executionObservations,
    ...value.usageObservations,
  ]) {
    row.mutationFence.fencingToken = 2;
  }
  value.attempts.unshift(prior);
  Object.assign(value.job, {
    lastFencingToken: 2,
    latestAttemptSequence: 1,
    startedAt: prior.startedAt,
  });
  expect(ReplayJobSnapshotSchema.safeParse(value).success).toBe(true);
  return value;
}

describe("materialized policy replay-result inspection", () => {
  it("synchronously reinspects memory, wire, and failed-prior-attempt histories with the same full hash", async () => {
    for (const raw of [actual.completed, fixture(), withPriorAttempt()]) {
      const expected = wire(raw);
      const input = command(expected);
      const inspected = inspectPolicyEvaluationReplayResult(input, raw);
      expect(inspected).not.toBeInstanceOf(Promise);
      expect(inspected).toEqual({
        source: input.source,
        record: expected,
        observation: { status: "verified", recordSha256: hash(expected) },
      });
      expect(inspected).toEqual(await readPolicyEvaluationReplayResult(input, port(raw)));
    }
  });

  it("distinguishes supplied absence, malformed bodies, non-success, and contradictory histories", () => {
    const input = command(fixture());
    expect(inspectPolicyEvaluationReplayResult(input, null)).toEqual({
      source: input.source,
      record: null,
      observation: { status: "missing" },
    });
    const contradictory = fixture();
    contradictory.cancellationRequest = withCancellation().cancellationRequest;
    for (const raw of [
      undefined,
      false,
      0,
      "invalid",
      [],
      {},
      contradictory,
      {
        ...fixture(),
        approved: undefined,
      },
    ]) {
      expect(inspectPolicyEvaluationReplayResult(input, raw)).toEqual({
        source: input.source,
        record: null,
        observation: invalid,
      });
    }
    for (const raw of [actual.queued, actual.running, withCancellation()]) {
      expect(inspectPolicyEvaluationReplayResult(input, raw).observation).toEqual(mismatch);
    }
  });

  it("retains exact identity, scope, and full-precision temporal admission during reinspection", () => {
    const raw = fixture();
    for (const dimension of ["tenantId", "projectId", "environmentId"] as const) {
      const input = command(raw);
      input.scope[dimension] = "foreign_scope";
      expect(inspectPolicyEvaluationReplayResult(input, raw).observation).toEqual(mismatch);
    }
    const otherArtifact = command(raw);
    otherArtifact.source.reference.result.sha256 = sha("0");
    expect(inspectPolicyEvaluationReplayResult(otherArtifact, raw).observation).toEqual(mismatch);
    const otherVersion = command(raw);
    otherVersion.source.reference.targetRelease.targetAdapter.version = "9.0.0";
    expect(inspectPolicyEvaluationReplayResult(otherVersion, raw).observation).toEqual(mismatch);
    const otherInstant = command(raw);
    otherInstant.source.reference.completedAt = time("500000000000000000000000000001");
    expect(inspectPolicyEvaluationReplayResult(otherInstant, raw).observation).toEqual(mismatch);
    const earlierCut = command(raw);
    earlierCut.evaluationTime = time("599999999999999999999999999999");
    expect(inspectPolicyEvaluationReplayResult(earlierCut, raw).observation).toEqual(future);
    const equivalentInstant = command(raw);
    equivalentInstant.source.reference.completedAt = "2026-09-08T09:00:00.500+09:00";
    expect(inspectPolicyEvaluationReplayResult(equivalentInstant, raw)).toEqual({
      source: equivalentInstant.source,
      record: raw,
      observation: { status: "verified", recordSha256: hash(raw) },
    });
  });

  it("validates input before touching a supplied body, even when it is null", () => {
    const input = command(fixture());
    const getter = vi.fn(() => {
      throw new Error("Must not read a body with invalid input");
    });
    const raw = {
      get job() {
        return getter();
      },
    };
    for (const bad of [
      null,
      { ...input, approved: true },
      { ...input, scope: {} },
      { ...input, evaluationTime: "invalid" },
      { ...input, source: { kind: "replay_plan", reference: input.source.reference.plan } },
      { ...input, limits: { ...limits, maximumRecords: 1 } },
      { ...input, limits: { ...limits, maximumRecordBytes: Infinity } },
      { ...input, limits: { ...limits, extra: 1 } },
    ]) {
      for (const body of [raw, null]) {
        expect(() => inspectPolicyEvaluationReplayResult(bad as typeof input, body)).toThrow(
          expect.objectContaining({ code: "policy_evaluation_replay_result_read_input_invalid" }),
        );
      }
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("owns the full context before body access and returns independent record and source values", () => {
    const value = fixture();
    const original = fixture();
    const input = command(value);
    const expectedSource = structuredClone(input.source);
    const raw = {
      ...value,
      get job() {
        input.scope.tenantId = "foreign_scope";
        input.source.reference.result.sha256 = sha("0");
        input.evaluationTime = "2000-01-01T00:00:00Z";
        input.limits.maximumRecords = 2;
        input.limits.maximumRecordBytes = 1;
        return value.job;
      },
    };
    const result = inspectPolicyEvaluationReplayResult(input, raw);
    expect(result).toEqual({
      source: expectedSource,
      record: original,
      observation: { status: "verified", recordSha256: hash(original) },
    });
    if (!result.record) throw new Error("Expected a retained record");
    result.record.job.createdByPrincipalId = "usr_changed";
    last(result.record).result = undefined;
    result.source.reference.result.sha256 = sha("1");
    expect(value).toEqual(original);
    expect(input.source.reference.result.sha256).toBe(sha("0"));
  });

  it("reapplies complete history and UTF-8 limits, including failed attempts and cancellation rows", () => {
    const prior = withPriorAttempt();
    const error = prior.attempts[0]?.error;
    if (!error) throw new Error("Expected the retained prior failure");
    error.message = "이전 시도 실패 — retained prior failure";
    for (const raw of [prior, withCancellation()]) {
      const maximumRecords =
        1 +
        raw.attempts.length +
        raw.budgetLedger.length +
        raw.executionObservations.length +
        raw.usageObservations.length +
        raw.cancellationAcknowledgements.length +
        Number(raw.cancellationRequest !== null);
      const maximumRecordBytes = Buffer.byteLength(json(wire(raw)));
      expect(maximumRecordBytes).toBeGreaterThan(json(wire(raw)).length);
      const input = { ...command(fixture()), limits: { maximumRecords, maximumRecordBytes } };
      expect(inspectPolicyEvaluationReplayResult(input, raw).observation).toEqual(
        raw === prior ? { status: "verified", recordSha256: hash(wire(raw)) } : mismatch,
      );
      for (const [field, dimension] of [
        ["maximumRecords", "records"],
        ["maximumRecordBytes", "record_bytes"],
      ] as const) {
        const bounded = structuredClone(input);
        bounded.limits[field] -= 1;
        expect(() => inspectPolicyEvaluationReplayResult(bounded, raw)).toThrow(
          expect.objectContaining({
            code: "policy_evaluation_replay_result_read_limit_exceeded",
            dimension,
          }),
        );
      }
    }
  });

  it("rejects oversized histories before element access and does not let body getters widen limits", () => {
    const attempts = new Array(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS);
    const getter = vi.fn(() => {
      throw new Error("Must not traverse oversized history");
    });
    Object.defineProperty(attempts, 0, { get: getter });
    expect(() =>
      inspectPolicyEvaluationReplayResult(command(fixture()), {
        ...fixture(),
        attempts,
      }),
    ).toThrow(expect.objectContaining({ dimension: "records" }));
    expect(getter).not.toHaveBeenCalled();
    const input = command(fixture());
    input.limits.maximumRecordBytes = 1;
    expect(() =>
      inspectPolicyEvaluationReplayResult(input, {
        ...fixture(),
        get job() {
          input.limits.maximumRecordBytes = limits.maximumRecordBytes;
          return fixture().job;
        },
      }),
    ).toThrow(expect.objectContaining({ dimension: "record_bytes" }));
  });

  it("propagates unexpected body-access failures without fabricating an observation", () => {
    const error = new Error("Captured body access failed");
    expect(() =>
      inspectPolicyEvaluationReplayResult(command(fixture()), {
        ...fixture(),
        get job() {
          throw error;
        },
      }),
    ).toThrow(error);
  });

  it("binds reinspection to the original observation before later dependency traversal", async () => {
    const raw = withPriorAttempt();
    const input = command(raw);
    const read = await readPolicyEvaluationReplayResult(input, port(raw));
    const revalidate = (evidence: typeof read) =>
      revalidatePolicyEvaluationCapturedRecord<
        PolicyEvaluationReplayResultReadInput,
        ReplayJobSnapshot,
        PolicyEvaluationReplayResultSource
      >(input, evidence, inspectPolicyEvaluationReplayResult);
    expect(revalidate(read)).toEqual(read);
    for (const field of ["receipt", "prior_failure"] as const) {
      const changed = structuredClone(read);
      if (!changed.record) throw new Error("Expected a captured body");
      if (field === "receipt") changed.record.job.createdByPrincipalId = "usr_other_receipt";
      else {
        const error = changed.record.attempts[0]?.error;
        if (!error) throw new Error("Expected a prior failure");
        error.message = "Different retained failure";
      }
      // Exact successful-result identity is unchanged, but the original full-history hash is not.
      expect(inspectPolicyEvaluationReplayResult(input, changed.record).observation.status).toBe(
        "verified",
      );
      expect(() => revalidate(changed)).toThrow(
        expect.objectContaining({ reason: "observation_mismatch" }),
      );
    }
  });
});

describe("exact policy replay-result acquisition", () => {
  it("reads one exact scoped job and hashes its full retained history, not just the result reference", async () => {
    const value = fixture();
    const input = command(value);
    const repository = port(value);
    expect(await readPolicyEvaluationReplayResult(input, repository)).toEqual({
      source: input.source,
      record: value,
      observation: { status: "verified", recordSha256: hash(value) },
    });
    expect(repository.findJob).toHaveBeenCalledExactlyOnceWith(
      input.scope,
      input.source.reference.jobId,
    );
  });

  it("accepts equivalent completion instants without normalizing away hashed receipt bytes", async () => {
    for (const completedAt of [
      time("500000000000000000000000000000"),
      "2026-09-08T09:00:00.500+09:00",
    ]) {
      const value = fixture();
      const input = command(value);
      input.source.reference.completedAt = completedAt;
      const result = await readPolicyEvaluationReplayResult(input, port(value));
      expect(result).toEqual({
        source: input.source,
        record: value,
        observation: { status: "verified", recordSha256: hash(value) },
      });
    }
  });

  it("does not confuse attempt completion with a later terminal database receipt", async () => {
    const value = fixture();
    const input = command(value);
    input.source.reference.completedAt = terminal(value).committedAt;
    expect((await readPolicyEvaluationReplayResult(input, port(value))).observation).toEqual(
      mismatch,
    );
    input.source.reference.completedAt = time("500000000000000000000000000001");
    expect((await readPolicyEvaluationReplayResult(input, port(value))).observation).toEqual(
      mismatch,
    );
  });

  const changes: [string[], unknown][] = [
    [["attemptId"], "att_other"],
    [["jobId"], "job_other"],
    [["plan", "planId"], "plan_other"],
    [["plan", "planVersionId"], "plan_version_other"],
    [["plan", "definitionSha256"], sha("1")],
    [["result", "artifactId"], "art_other"],
    [["result", "classification"], "restricted"],
    [["result", "mediaType"], "text/plain"],
    [["result", "sha256"], sha("2")],
    [["result", "sizeBytes"], 129],
    [["targetRelease", "definitionSha256"], sha("3")],
    [["targetRelease", "targetId"], "target_other"],
    [["targetRelease", "targetReleaseId"], "release_other"],
    [["targetRelease", "targetAdapter", "name"], "other.adapter"],
    [["targetRelease", "targetAdapter", "version"], "9.0.0"],
    [["targetRelease", "targetAdapter", "protocolVersion"], "9.0.0"],
    [["targetRelease", "workerProtocol", "name"], "other.worker"],
    [["targetRelease", "workerProtocol", "version"], "9.0.0"],
  ];
  for (const [path, replacement] of changes) {
    it(`rejects substitution of reference.${path.join(".")}`, async () => {
      const value = fixture();
      const input = command(value);
      const parent = path
        .slice(0, -1)
        .reduce<object>((object, key) => Reflect.get(object, key), input.source.reference);
      Reflect.set(parent, path.at(-1) as string, replacement);
      expect((await readPolicyEvaluationReplayResult(input, port(value))).observation).toEqual(
        mismatch,
      );
    });
  }
  for (const dimension of ["tenantId", "projectId", "environmentId"] as const) {
    it(`rejects a repository that returns a foreign ${dimension}`, async () => {
      const value = fixture();
      const input = command(value);
      input.scope[dimension] = "foreign_scope";
      expect((await readPolicyEvaluationReplayResult(input, port(value))).observation).toEqual(
        mismatch,
      );
      expect(
        (await readPolicyEvaluationReplayResult(input, actual.repository)).observation,
      ).toEqual({ status: "missing" });
    });
  }
  it("uses canonical nested values rather than property insertion order", async () => {
    const value = fixture();
    const input = command(value);
    input.source.reference.targetRelease = Object.fromEntries(
      Object.entries(input.source.reference.targetRelease).reverse(),
    ) as typeof input.source.reference.targetRelease;
    expect((await readPolicyEvaluationReplayResult(input, port(value))).observation.status).toBe(
      "verified",
    );
  });
  it("owns input, limits, and scope before the read callback can mutate them", async () => {
    const value = fixture();
    const input = command(value);
    const source = structuredClone(input.source);
    const repository = port(value);
    repository.findJob.mockImplementation(async (scope) => {
      scope.tenantId = "foreign_scope";
      input.scope.projectId = "foreign_project";
      input.source.reference.result.sha256 = sha("1");
      input.evaluationTime = "2000-01-01T00:00:00Z";
      input.limits.maximumRecords = 2;
      input.limits.maximumRecordBytes = 1;
      return value;
    });
    const read = await readPolicyEvaluationReplayResult(input, repository);
    expect(read).toEqual({
      source,
      record: value,
      observation: { status: "verified", recordSha256: hash(value) },
    });
    if (!read.record) throw new Error("Expected a retained record");
    read.record.job.scope.projectId = "mutated_output";
    last(read.record).result = undefined;
    expect(value).toEqual(fixture());
    expect(input.source.reference.result.sha256).toBe(sha("1"));
  });
  it("normalizes only valid optional undefined fields and agrees with real memory/JSON transport", async () => {
    const read = await readPolicyEvaluationReplayResult(
      command(wire(actual.completed)),
      actual.repository,
    );
    expect(read.record).toEqual(wire(actual.completed));
    expect(read.observation).toEqual({
      status: "verified",
      recordSha256: hash(wire(actual.completed)),
    });
    const value = fixture();
    value.job.currentLease = undefined;
    last(value).error = undefined;
    const normalized = await readPolicyEvaluationReplayResult(command(value), port(value));
    expect(normalized.record).toEqual(fixture());
    expect(normalized.observation).toEqual({ status: "verified", recordSha256: hash(fixture()) });
    expect(
      (
        await readPolicyEvaluationReplayResult(
          command(value),
          port({ ...value, approved: undefined }),
        )
      ).observation,
    ).toEqual(invalid);
  });
  it("binds receipt and child-observation changes in the record hash", async () => {
    const value = fixture();
    value.job.createdByPrincipalId = "usr_other_receipt";
    const observation = value.usageObservations[0];
    if (!observation) throw new Error("Expected a usage fixture");
    observation.sourceEventSha256 = sha("0");
    const read = await readPolicyEvaluationReplayResult(command(value), port(value));
    expect(read.observation).toEqual({ status: "verified", recordSha256: hash(value) });
    expect(hash(value)).not.toBe(hash(fixture()));
  });
});

describe("missing, corrupt, incomplete, and future replay evidence", () => {
  it("retains closed prior attempts but never substitutes them for the terminal source", async () => {
    const value = withPriorAttempt();
    const input = command(value);
    expect((await readPolicyEvaluationReplayResult(input, port(value))).observation).toEqual({
      status: "verified",
      recordSha256: hash(value),
    });
    input.source.reference.attemptId = "att_prior";
    expect((await readPolicyEvaluationReplayResult(input, port(value))).observation).toEqual(
      mismatch,
    );
  });
  it.each([undefined, time("101")])(
    "rejects an unclosed or overlapping prior attempt ending at %s",
    async (endedAt) => {
      const value = withPriorAttempt();
      const input = command(value);
      const prior = value.attempts[0];
      if (!prior) throw new Error("Expected a prior attempt");
      prior.endedAt = endedAt;
      if (endedAt === undefined) {
        prior.status = "running";
        prior.retryDisposition = undefined;
        prior.error = undefined;
      }
      expect((await readPolicyEvaluationReplayResult(input, port(value))).observation).toEqual(
        invalid,
      );
    },
  );
  it("returns missing only for an exact null", async () => {
    const input = command(fixture());
    expect(await readPolicyEvaluationReplayResult(input, port(null))).toEqual({
      source: input.source,
      record: null,
      observation: { status: "missing" },
    });
  });
  it.each([undefined, false, 0, "invalid", [], {}, { attempts: null }])(
    "rejects malformed %j without fabricating absence",
    async (raw) => {
      expect(
        (await readPolicyEvaluationReplayResult(command(fixture()), port(raw))).observation,
      ).toEqual(invalid);
    },
  );
  it("does not treat queued or running work as completed evidence", async () => {
    for (const value of [actual.queued, actual.running]) {
      expect(
        (await readPolicyEvaluationReplayResult(command(fixture()), port(value))).observation,
      ).toEqual(mismatch);
    }
  });
  it("rejects forged successful history that ignores a retained cancellation request", async () => {
    const value = fixture();
    const input = command(value);
    value.cancellationRequest = withCancellation().cancellationRequest;
    expect((await readPolicyEvaluationReplayResult(input, port(value))).observation).toEqual(
      invalid,
    );
  });
  const corruptions: [string, (value: ReplayJobSnapshot) => void][] = [
    [
      "root/terminal disagreement",
      (value) => {
        terminal(value).status = "failed";
      },
    ],
    [
      "unknown terminal attempt",
      (value) => {
        terminal(value).attemptId = "unknown_attempt";
      },
    ],
    [
      "missing successful result",
      (value) => {
        last(value).result = undefined;
      },
    ],
    [
      "unscoped history",
      (value) => {
        last(value).scope.tenantId = "foreign_tenant";
      },
    ],
    [
      "fence mismatch",
      (value) => {
        last(value).mutationFence.fencingToken += 1;
      },
    ],
    [
      "attempt plan mismatch",
      (value) => {
        last(value).plan.definitionSha256 = sha("0");
      },
    ],
    [
      "duplicate attempts",
      (value) => {
        value.attempts.push(structuredClone(last(value)));
      },
    ],
    [
      "missing budget reservation",
      (value) => {
        value.budgetLedger.shift();
      },
    ],
    [
      "missing observation",
      (value) => {
        value.executionObservations = [];
      },
    ],
  ];
  for (const [name, mutate] of corruptions) {
    it(`rejects corrupt ${name}`, async () => {
      const value = fixture();
      const input = command(value);
      mutate(value);
      expect((await readPolicyEvaluationReplayResult(input, port(value))).observation).toEqual(
        invalid,
      );
    });
  }
  it.each([
    ["failed", "execution_failed", "worker_internal_error"],
    ["timed_out", "deadline_reached", "deadline_exceeded"],
    ["budget_exhausted", "budget_limit_reached", "budget_exhausted"],
    ["cancelled", "cancellation_committed", "cancelled"],
  ] as const)(
    "does not infer success from a valid %s terminal job",
    async (status, code, errorCode) => {
      const value = status === "cancelled" ? withCancellation() : fixture();
      const input = command(fixture());
      value.job.status = status;
      Object.assign(terminal(value), { status, code });
      Object.assign(last(value), {
        status,
        result: undefined,
        error: {
          code: errorCode,
          effectCertainty: "none",
          message: "Execution failed",
        },
      });
      expect(ReplayJobSnapshotSchema.safeParse(value).success).toBe(true);
      expect((await readPolicyEvaluationReplayResult(input, port(value))).observation).toEqual(
        mismatch,
      );
    },
  );
  it("requires the terminal receipt at the full-precision evaluation cut", async () => {
    const value = fixture();
    const input = command(value);
    for (const evaluationTime of [time("500"), time("599999999999999999999999999999")]) {
      input.evaluationTime = evaluationTime;
      expect((await readPolicyEvaluationReplayResult(input, port(value))).observation).toEqual(
        future,
      );
    }
    input.evaluationTime = time("600");
    expect((await readPolicyEvaluationReplayResult(input, port(value))).observation.status).toBe(
      "verified",
    );
  });
  const futureReceipts: [string, (value: ReplayJobSnapshot) => void][] = [
    [
      "reservation",
      (value) => {
        const row = value.budgetLedger[0];
        if (row?.entryType === "reservation") row.reservedAt = time("601");
      },
    ],
    [
      "reconciliation",
      (value) => {
        const row = value.budgetLedger[1];
        if (row?.entryType === "reconciliation") row.reconciledAt = time("601");
      },
    ],
    [
      "execution observation",
      (value) => {
        const row = value.executionObservations[0];
        if (row) row.observedAt = time("601");
      },
    ],
    [
      "usage observation",
      (value) => {
        const row = value.usageObservations[0];
        if (row) row.observedAt = time("601");
      },
    ],
  ];
  for (const [name, mutate] of futureReceipts) {
    it(`does not backdate a future ${name} into a historical source`, async () => {
      const value = fixture();
      const input = command(value);
      mutate(value);
      expect(ReplayJobSnapshotSchema.safeParse(value).success).toBe(true);
      expect((await readPolicyEvaluationReplayResult(input, port(value))).observation).toEqual(
        future,
      );
    });
  }
  it("propagates repository failures and unexpected accessors instead of inventing missingness", async () => {
    const error = new Error("source authority offline");
    const repository = port(null);
    repository.findJob.mockRejectedValue(error);
    await expect(readPolicyEvaluationReplayResult(command(fixture()), repository)).rejects.toBe(
      error,
    );
    await expect(
      readPolicyEvaluationReplayResult(
        command(fixture()),
        port({
          ...fixture(),
          get job() {
            throw error;
          },
        }),
      ),
    ).rejects.toBe(error);
  });
});

describe("bounded replay-source admission", () => {
  it("rejects malformed input and limits before any repository read", async () => {
    const input = command(fixture());
    const repository = port(null);
    const badInputs: unknown[] = [
      null,
      { ...input, approved: true },
      { ...input, scope: {} },
      { ...input, evaluationTime: "not a date" },
      { ...input, evaluationTime: "2026-09-08T09:00:00+09:00" },
      { ...input, source: { kind: "replay_plan", reference: input.source.reference.plan } },
      {
        ...input,
        source: {
          ...input.source,
          reference: { ...input.source.reference, terminalStatus: "failed" },
        },
      },
      { ...input, limits: null },
      { ...input, limits: { ...limits, extra: 1 } },
    ];
    for (const maximumRecordBytes of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      "10",
      MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES + 1,
    ]) {
      badInputs.push({ ...input, limits: { ...limits, maximumRecordBytes } });
    }
    for (const maximumRecords of [
      0,
      1,
      2.5,
      NaN,
      Infinity,
      "10",
      MAX_POLICY_EVALUATION_ACQUISITION_RECORDS + 1,
    ]) {
      badInputs.push({ ...input, limits: { ...limits, maximumRecords } });
    }
    for (const bad of badInputs) {
      await expect(
        readPolicyEvaluationReplayResult(bad as typeof input, repository),
      ).rejects.toMatchObject({ code: "policy_evaluation_replay_result_read_input_invalid" });
    }
    expect(repository.findJob).not.toHaveBeenCalled();
  });
  it("admits exact global ceilings without granting a larger or unbounded allowance", async () => {
    const value = fixture();
    const input = command(value);
    input.limits = {
      maximumRecords: MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
      maximumRecordBytes: MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES,
    };
    expect((await readPolicyEvaluationReplayResult(input, port(value))).observation.status).toBe(
      "verified",
    );
  });
  it("counts all history rows and cancellation records without counting only the latest attempt", async () => {
    for (const value of [fixture(), withCancellation()]) {
      const count =
        1 +
        value.attempts.length +
        value.budgetLedger.length +
        value.executionObservations.length +
        value.usageObservations.length +
        value.cancellationAcknowledgements.length +
        Number(value.cancellationRequest !== null);
      for (const maximumRecords of [count, count + 1]) {
        const input = { ...command(fixture()), limits: { ...limits, maximumRecords } };
        expect(
          (await readPolicyEvaluationReplayResult(input, port(value))).observation.status,
        ).toBe(value.cancellationRequest === null ? "verified" : "unavailable");
      }
      await expect(
        readPolicyEvaluationReplayResult(
          { ...command(fixture()), limits: { ...limits, maximumRecords: count - 1 } },
          port(value),
        ),
      ).rejects.toMatchObject({
        code: "policy_evaluation_replay_result_read_limit_exceeded",
        dimension: "records",
      });
    }
  });
  it("rejects oversized histories before traversing or parsing their elements", async () => {
    const attempts = new Array(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS);
    Object.defineProperty(attempts, 0, {
      get() {
        throw new Error("Must not traverse oversized history");
      },
    });
    await expect(
      readPolicyEvaluationReplayResult(command(fixture()), port({ ...fixture(), attempts })),
    ).rejects.toMatchObject({ dimension: "records" });
  });
  it("enforces canonical UTF-8 bytes at the exact boundary with no truncation or missing observation", async () => {
    const value = withPriorAttempt();
    const error = value.attempts[0]?.error;
    if (!error) throw new Error("Expected a prior attempt error");
    error.message = "이전 시도가 종료됨 — prior attempt closed";
    const encoded = json(value);
    const bytes = Buffer.byteLength(encoded);
    expect(bytes).toBeGreaterThan(encoded.length);
    for (const maximumRecordBytes of [bytes, bytes + 1]) {
      const input = { ...command(value), limits: { ...limits, maximumRecordBytes } };
      expect((await readPolicyEvaluationReplayResult(input, port(value))).observation).toEqual({
        status: "verified",
        recordSha256: hash(value),
      });
    }
    await expect(
      readPolicyEvaluationReplayResult(
        { ...command(value), limits: { ...limits, maximumRecordBytes: bytes - 1 } },
        port(value),
      ),
    ).rejects.toMatchObject({
      code: "policy_evaluation_replay_result_read_limit_exceeded",
      dimension: "record_bytes",
    });
  });
  it("does not let a callback widen captured admission limits", async () => {
    const value = fixture();
    const input = { ...command(value), limits: { ...limits, maximumRecordBytes: 1 } };
    const repository = port(value);
    repository.findJob.mockImplementation(async () => {
      input.limits.maximumRecordBytes = limits.maximumRecordBytes;
      return value;
    });
    await expect(readPolicyEvaluationReplayResult(input, repository)).rejects.toMatchObject({
      dimension: "record_bytes",
    });
  });
});
