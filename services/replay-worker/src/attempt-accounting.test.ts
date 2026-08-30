import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type ReplayBudgetLedgerEntry,
  type ReplayBudgetReservation,
  type ReplayExecutionObservationPayload,
  type ReplayPlan,
  type ReplayPlanDefinition,
  ReplayPlanDefinitionSchema,
  ReplayPlanSchema,
  type ReplayWorkerMutationFence,
} from "@proofstack/contracts";
import {
  digestReplayPlanDefinition,
  type ReplayJobRepository,
  type ReplayJobSnapshot,
} from "@proofstack/replay";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  measureRecordedStubAttemptUsage,
  reconcileReplayAttemptBudget,
  reconcileReplayAttemptUsage,
  reserveReplayAttemptBudget,
} from "./attempt-accounting.js";

const scope = {
  environmentId: "env_accounting",
  projectId: "prj_accounting",
  tenantId: "ten_accounting",
} as const;

const workerFence: ReplayWorkerMutationFence = {
  attemptId: "att_accounting_001",
  fencingToken: 11,
  jobId: "job_accounting_001",
  leaseId: "lea_accounting_001",
  recoveryEpoch: 0,
  workerId: "wrk_accounting_001",
};

let plan: ReplayPlan;

beforeAll(async () => {
  const document = JSON.parse(
    await readFile(
      new URL("../../../packages/replay/vectors/replay-definition-v1.json", import.meta.url),
      "utf8",
    ),
  ) as { readonly vectors: readonly { readonly input: unknown; readonly kind: string }[] };
  const vector = document.vectors.find(({ kind }) => kind === "replay_plan");
  if (!vector) throw new Error("Replay plan vector is missing");
  const definition: ReplayPlanDefinition = ReplayPlanDefinitionSchema.parse({
    ...(vector.input as object),
    scope,
  });
  plan = ReplayPlanSchema.parse({
    createdAt: "2026-08-30T00:00:00.000Z",
    createdByPrincipalId: "usr_accounting",
    definitionSha256: digestReplayPlanDefinition(definition),
    ...definition,
  });
});

function snapshot(
  budgetLedger: readonly ReplayBudgetLedgerEntry[] = [],
  overrides: Readonly<Record<string, unknown>> = {},
): ReplayJobSnapshot {
  return {
    attempts: [],
    budgetLedger,
    cancellationAcknowledgements: [],
    cancellationRequest: null,
    executionObservations: [],
    job: {
      currentLease: { mutationFence: workerFence },
      jobId: workerFence.jobId,
      plan: {
        definitionSha256: plan.definitionSha256,
        planId: plan.planId,
        planVersionId: plan.planVersionId,
      },
      scope,
      ...overrides,
    },
    usageObservations: [],
  } as unknown as ReplayJobSnapshot;
}

function repository(returned: ReplayJobSnapshot, order: string[] = []) {
  const appendUsageObservation = vi.fn(
    async (_command: Parameters<ReplayJobRepository["appendUsageObservation"]>[0]) => {
      order.push("usage");
      return returned;
    },
  );
  const heartbeatJob = vi.fn(
    async (_command: Parameters<ReplayJobRepository["heartbeatJob"]>[0]) => {
      order.push("heartbeat");
      return returned;
    },
  );
  const reconcileBudget = vi.fn(
    async (_command: Parameters<ReplayJobRepository["reconcileBudget"]>[0]) => {
      order.push("reconcile");
      return returned;
    },
  );
  const reserveBudget = vi.fn(
    async (_command: Parameters<ReplayJobRepository["reserveBudget"]>[0]) => {
      order.push("reserve");
      return returned;
    },
  );
  const mocks = { appendUsageObservation, heartbeatJob, reconcileBudget, reserveBudget };
  return mocks as typeof mocks & ReplayJobRepository;
}

function reservation(
  reservationId: string,
  overrides: Partial<ReplayBudgetReservation> = {},
): ReplayBudgetReservation {
  return {
    dimensions: Object.fromEntries(
      Object.entries(plan.budget).map(([dimension, budget]) => [
        dimension,
        {
          committedBefore: 0,
          limit: budget.limit,
          measurement: budget.measurement,
          reservedAmount: budget.limit,
        },
      ]),
    ) as ReplayBudgetReservation["dimensions"],
    entryType: "reservation",
    ledgerSequence: 0,
    mutationFence: workerFence,
    reservationId,
    reservedAt: "2026-08-30T00:01:00.000Z",
    schemaVersion: "0.1",
    scope,
    work: { kind: "attempt_start" },
    ...overrides,
  };
}

describe("attempt accounting", () => {
  it("reserves every remaining dimension with a retry-stable identity", async () => {
    const initial = snapshot();
    const order: string[] = [];
    const firstRepository = repository(initial, order);
    const first = await reserveReplayAttemptBudget({
      leaseDurationMilliseconds: 1_000,
      plan,
      repository: firstRepository,
      scope,
      snapshot: initial,
      workerFence,
    });
    expect(order).toEqual(["heartbeat", "reserve"]);
    expect(first.requested).toEqual(
      Object.fromEntries(
        Object.entries(plan.budget).map(([dimension, budget]) => [dimension, budget.limit]),
      ),
    );
    expect(firstRepository.reserveBudget).toHaveBeenCalledWith({
      requested: first.requested,
      reservationId: first.reservationId,
      scope,
      work: { kind: "attempt_start" },
      workerFence,
    });

    const retryRepository = repository(initial);
    const retry = await reserveReplayAttemptBudget({
      leaseDurationMilliseconds: 1_000,
      plan,
      repository: retryRepository,
      scope,
      snapshot: initial,
      workerFence,
    });
    expect(retry.reservationId).toBe(first.reservationId);

    const authoritative = snapshot([reservation(first.reservationId)]);
    const recoveredRepository = repository(authoritative);
    const recovered = await reserveReplayAttemptBudget({
      leaseDurationMilliseconds: 1_000,
      plan,
      repository: recoveredRepository,
      scope,
      snapshot: authoritative,
      workerFence,
    });
    expect(recovered.requested).toEqual(first.requested);
  });

  it("measures only work performed by the recorded-stub worker", () => {
    const observations = [
      {
        afterCancellationRequest: false,
        boundaryId: "bnd_model",
        boundaryKind: "model",
        effectCertainty: "none",
        evidenceSha256: "a".repeat(64),
        executionOrigin: "recorded",
        kind: "boundary",
        mode: "recorded_stub",
        phase: "request_started",
      },
      {
        afterCancellationRequest: false,
        boundaryId: "bnd_tool",
        boundaryKind: "tool",
        effectCertainty: "none",
        evidenceSha256: "b".repeat(64),
        executionOrigin: "recorded",
        kind: "boundary",
        mode: "recorded_stub",
        phase: "request_started",
      },
      {
        afterCancellationRequest: false,
        boundaryId: "bnd_model",
        boundaryKind: "model",
        effectCertainty: "none",
        evidenceSha256: "c".repeat(64),
        executionOrigin: "recorded",
        kind: "boundary",
        mode: "recorded_stub",
        phase: "response_observed",
      },
      {
        afterCancellationRequest: false,
        evidenceSha256: "d".repeat(64),
        event: "started",
        kind: "target",
      },
    ] satisfies ReplayExecutionObservationPayload[];
    expect(
      measureRecordedStubAttemptUsage({
        elapsedMilliseconds: 123,
        emittedArtifactBytes: 456,
        executionObservations: observations,
      }),
    ).toEqual({
      concurrentInteractions: 1,
      elapsedMilliseconds: 123,
      emittedArtifactBytes: 456,
      inputTokens: 0,
      jobAttempts: 1,
      modelRequests: 1,
      outputTokens: 0,
      providerCostMicrounits: 0,
      retrievedBytes: 0,
      toolCalls: 1,
    });
    expect(
      measureRecordedStubAttemptUsage({
        elapsedMilliseconds: 0,
        emittedArtifactBytes: 0,
        executionObservations: [],
      }).concurrentInteractions,
    ).toBe(0);
    for (const input of [
      { elapsedMilliseconds: -1, emittedArtifactBytes: 0 },
      { elapsedMilliseconds: 1.5, emittedArtifactBytes: 0 },
      { elapsedMilliseconds: 0, emittedArtifactBytes: -1 },
      { elapsedMilliseconds: 0, emittedArtifactBytes: 1.5 },
    ]) {
      expect(() =>
        measureRecordedStubAttemptUsage({ ...input, executionObservations: [] }),
      ).toThrowError(expect.objectContaining({ code: "invalid_usage" }));
    }
  });

  it("records sourced usage and reconciles the exact reservation in order", async () => {
    const initial = snapshot();
    const reservationRepository = repository(initial);
    const reserved = await reserveReplayAttemptBudget({
      leaseDurationMilliseconds: 1_000,
      plan,
      repository: reservationRepository,
      scope,
      snapshot: initial,
      workerFence,
    });
    const actual = measureRecordedStubAttemptUsage({
      elapsedMilliseconds: 321,
      emittedArtifactBytes: 654,
      executionObservations: [],
    });
    const order: string[] = [];
    const firstRepository = repository(initial, order);
    await expect(
      reconcileReplayAttemptBudget({
        actual,
        leaseDurationMilliseconds: 1_000,
        plan,
        repository: firstRepository,
        reservationId: reserved.reservationId,
        scope,
        workerFence,
      }),
    ).resolves.toBe(initial);
    expect(order).toEqual(["heartbeat", "usage", "heartbeat", "reconcile"]);
    const usageCommand = firstRepository.appendUsageObservation.mock.calls[0]?.[0];
    expect(usageCommand?.measurements.map(({ dimension }) => dimension)).toEqual([
      "concurrentInteractions",
      "elapsedMilliseconds",
      "emittedArtifactBytes",
      "inputTokens",
      "jobAttempts",
      "modelRequests",
      "outputTokens",
      "providerCostMicrounits",
      "retrievedBytes",
      "toolCalls",
    ]);
    expect(
      usageCommand?.measurements.find(({ dimension }) => dimension === "providerCostMicrounits")
        ?.usage,
    ).toEqual({ reason: "source_unavailable", status: "unavailable" });
    expect(
      usageCommand?.measurements.find(({ dimension }) => dimension === "elapsedMilliseconds")
        ?.usage,
    ).toEqual({ amount: 321, source: "measured", status: "observed" });
    expect(usageCommand?.sourceEventSha256).toBe(
      createHash("sha256")
        .update(
          JSON.stringify({
            actual,
            namespace: "proofstack.replay-attempt-accounting.v1",
            reservationId: reserved.reservationId,
          }),
          "utf8",
        )
        .digest("hex"),
    );

    const retryRepository = repository(initial);
    await reconcileReplayAttemptBudget({
      actual,
      leaseDurationMilliseconds: 1_000,
      plan,
      repository: retryRepository,
      reservationId: reserved.reservationId,
      scope,
      workerFence,
    });
    expect(retryRepository.appendUsageObservation.mock.calls[0]?.[0].observationId).toBe(
      usageCommand?.observationId,
    );
    expect(retryRepository.reconcileBudget.mock.calls[0]?.[0].reconciliationId).toBe(
      firstRepository.reconcileBudget.mock.calls[0]?.[0].reconciliationId,
    );
  });

  it("preserves multi-mode evidence sources and disputes missing or plan-mismatched usage", async () => {
    const initial = snapshot();
    const reserved = await reserveReplayAttemptBudget({
      leaseDurationMilliseconds: 1_000,
      plan,
      repository: repository(initial),
      scope,
      snapshot: initial,
      workerFence,
    });
    const evidence = {
      concurrentInteractions: { amount: 1, source: "measured", status: "observed" },
      elapsedMilliseconds: { amount: 10, source: "measured", status: "observed" },
      emittedArtifactBytes: { amount: 20, source: "measured", status: "observed" },
      inputTokens: { amount: 30, source: "provider_reported", status: "observed" },
      jobAttempts: { amount: 1, source: "measured", status: "observed" },
      modelRequests: { amount: 2, source: "measured", status: "observed" },
      outputTokens: { reason: "provider_did_not_report", status: "unavailable" },
      providerCostMicrounits: { amount: 40, source: "measured", status: "observed" },
      retrievedBytes: { amount: 50, source: "measured", status: "observed" },
      toolCalls: { amount: 1, source: "measured", status: "observed" },
    } as const;
    const order: string[] = [];
    const evidenceRepository = repository(initial, order);
    await reconcileReplayAttemptUsage({
      leaseDurationMilliseconds: 1_000,
      plan,
      repository: evidenceRepository,
      reservationId: reserved.reservationId,
      scope,
      usage: evidence,
      workerFence,
    });
    expect(order).toEqual(["heartbeat", "usage", "heartbeat", "reconcile"]);
    const command = evidenceRepository.appendUsageObservation.mock.calls[0]?.[0];
    const usageFor = (dimension: string) =>
      command?.measurements.find((measurement) => measurement.dimension === dimension)?.usage;
    expect(usageFor("inputTokens")).toEqual(evidence.inputTokens);
    expect(usageFor("outputTokens")).toEqual(evidence.outputTokens);
    expect(usageFor("providerCostMicrounits")).toEqual({
      reason: "source_unavailable",
      status: "unavailable",
    });

    const mismatchedRepository = repository(initial);
    await reconcileReplayAttemptUsage({
      leaseDurationMilliseconds: 1_000,
      plan,
      repository: mismatchedRepository,
      reservationId: reserved.reservationId,
      scope,
      usage: {
        ...evidence,
        inputTokens: { amount: 30, source: "estimated", status: "observed" },
      },
      workerFence,
    });
    expect(
      mismatchedRepository.appendUsageObservation.mock.calls[0]?.[0].measurements.find(
        ({ dimension }) => dimension === "inputTokens",
      )?.usage,
    ).toEqual({ reason: "measurement_failed", status: "unavailable" });

    await expect(
      reconcileReplayAttemptUsage({
        leaseDurationMilliseconds: 1_000,
        plan,
        repository: repository(initial),
        reservationId: "rsv_other",
        scope,
        usage: evidence,
        workerFence,
      }),
    ).rejects.toMatchObject({ code: "invalid_accounting_context" });
  });

  it("rejects invalid source-bearing usage before durable mutation", async () => {
    const initial = snapshot();
    const reserved = await reserveReplayAttemptBudget({
      leaseDurationMilliseconds: 1_000,
      plan,
      repository: repository(initial),
      scope,
      snapshot: initial,
      workerFence,
    });
    for (const usage of [null, {}, { unexpected: true }, reserved.requested]) {
      const invalidRepository = repository(initial);
      await expect(
        reconcileReplayAttemptUsage({
          leaseDurationMilliseconds: 1_000,
          plan,
          repository: invalidRepository,
          reservationId: reserved.reservationId,
          scope,
          usage,
          workerFence,
        }),
      ).rejects.toMatchObject({ code: "invalid_usage" });
      expect(invalidRepository.heartbeatJob).not.toHaveBeenCalled();
    }
  });

  it("rejects invalid authority, policy, ledger, capacity, and usage before mutation", async () => {
    const initial = snapshot();
    for (const leaseDurationMilliseconds of [0, 1.5, 2_001]) {
      const invalidRepository = repository(initial);
      await expect(
        reserveReplayAttemptBudget({
          leaseDurationMilliseconds,
          plan,
          repository: invalidRepository,
          scope,
          snapshot: initial,
          workerFence,
        }),
      ).rejects.toMatchObject({ code: "invalid_lease_policy" });
      expect(invalidRepository.heartbeatJob).not.toHaveBeenCalled();
    }

    for (const invalidSnapshot of [
      snapshot([], { jobId: "job_other" }),
      snapshot([], { scope: { ...scope, projectId: "prj_other" } }),
      snapshot([], { plan: { ...initial.job.plan, planId: "rpl_other" } }),
      snapshot([], { currentLease: undefined }),
    ]) {
      const invalidRepository = repository(invalidSnapshot);
      await expect(
        reserveReplayAttemptBudget({
          leaseDurationMilliseconds: 1_000,
          plan,
          repository: invalidRepository,
          scope,
          snapshot: invalidSnapshot,
          workerFence,
        }),
      ).rejects.toMatchObject({ code: "invalid_accounting_context" });
      expect(invalidRepository.heartbeatJob).not.toHaveBeenCalled();
    }

    const invalidContextRepository = repository(initial);
    await expect(
      reserveReplayAttemptBudget({
        leaseDurationMilliseconds: 1_000,
        plan: { ...plan, definitionSha256: "f".repeat(64) },
        repository: invalidContextRepository,
        scope,
        snapshot: initial,
        workerFence,
      }),
    ).rejects.toMatchObject({ code: "invalid_accounting_context" });
    await expect(
      reserveReplayAttemptBudget({
        leaseDurationMilliseconds: 1_000,
        plan,
        repository: invalidContextRepository,
        scope: { ...scope, environmentId: "env_other" },
        snapshot: initial,
        workerFence,
      }),
    ).rejects.toMatchObject({ code: "invalid_accounting_context" });

    const corruptedLedger = snapshot([reservation("rsv_corrupt", { ledgerSequence: 1 })]);
    await expect(
      reserveReplayAttemptBudget({
        leaseDurationMilliseconds: 1_000,
        plan,
        repository: repository(corruptedLedger),
        scope,
        snapshot: corruptedLedger,
        workerFence,
      }),
    ).rejects.toMatchObject({ code: "invalid_accounting_context" });

    const exhausted = snapshot([reservation("rsv_exhausted")]);
    await expect(
      reserveReplayAttemptBudget({
        leaseDurationMilliseconds: 1_000,
        plan,
        repository: repository(exhausted),
        scope,
        snapshot: exhausted,
        workerFence,
      }),
    ).rejects.toMatchObject({ code: "budget_exhausted_before_attempt" });

    const firstRepository = repository(initial);
    const reserved = await reserveReplayAttemptBudget({
      leaseDurationMilliseconds: 1_000,
      plan,
      repository: firstRepository,
      scope,
      snapshot: initial,
      workerFence,
    });
    const wrongExisting = snapshot([
      reservation(reserved.reservationId, {
        mutationFence: { ...workerFence, workerId: "wrk_other" },
      }),
    ]);
    await expect(
      reserveReplayAttemptBudget({
        leaseDurationMilliseconds: 1_000,
        plan,
        repository: repository(wrongExisting),
        scope,
        snapshot: wrongExisting,
        workerFence,
      }),
    ).rejects.toMatchObject({ code: "invalid_accounting_context" });

    for (const actual of [
      null,
      {},
      { ...reserved.requested, hidden: 1 },
      { ...reserved.requested, elapsedMilliseconds: -1 },
      { ...reserved.requested, elapsedMilliseconds: 1.5 },
    ]) {
      const invalidRepository = repository(initial);
      await expect(
        reconcileReplayAttemptBudget({
          actual,
          leaseDurationMilliseconds: 1_000,
          plan,
          repository: invalidRepository,
          reservationId: reserved.reservationId,
          scope,
          workerFence,
        }),
      ).rejects.toMatchObject({ code: "invalid_usage" });
      expect(invalidRepository.heartbeatJob).not.toHaveBeenCalled();
    }

    const invalidReservationRepository = repository(initial);
    await expect(
      reconcileReplayAttemptBudget({
        actual: reserved.requested,
        leaseDurationMilliseconds: 1_000,
        plan,
        repository: invalidReservationRepository,
        reservationId: "rsv_other",
        scope,
        workerFence,
      }),
    ).rejects.toMatchObject({ code: "invalid_accounting_context" });
    await expect(
      reconcileReplayAttemptBudget({
        actual: reserved.requested,
        leaseDurationMilliseconds: 0,
        plan,
        repository: invalidReservationRepository,
        reservationId: reserved.reservationId,
        scope,
        workerFence,
      }),
    ).rejects.toMatchObject({ code: "invalid_lease_policy" });
  });
});
