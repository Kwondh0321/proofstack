import type {
  EvidenceScope,
  ReplayArtifactContentReference,
  ReplayBudget,
  ReplayBudgetLedgerEntry,
  ReplayCancellationAcknowledgement,
  ReplayCancellationRequest,
  ReplayWorkerMutationFence,
} from "@proofstack/contracts";
import {
  emptyReplayBudgetAmounts,
  reconcileReplayBudget,
  type ReplayBudgetAmounts,
  type ReplayJobRepository,
  type ReplayJobSnapshot,
  reserveReplayBudget,
} from "@proofstack/replay";
import { describe, expect, it, vi } from "vitest";
import { completeSupervisedReplayAttempt } from "./attempt-completion.js";
import type {
  ReplayTargetProcessResult,
  ReplayTargetProcessStatus,
} from "./target-process-supervisor.js";

const scope: EvidenceScope = {
  environmentId: "env_completion",
  projectId: "prj_completion",
  tenantId: "ten_completion",
};

const workerFence: ReplayWorkerMutationFence = {
  attemptId: "att_completion_001",
  fencingToken: 17,
  jobId: "job_completion_001",
  leaseId: "lea_completion_001",
  recoveryEpoch: 0,
  workerId: "wrk_completion_001",
};

const resultArtifact: ReplayArtifactContentReference = {
  artifactId: "art_completion_result",
  classification: "internal",
  mediaType: "application/json",
  sha256: "a".repeat(64),
  sizeBytes: 128,
};

const cancellation: ReplayCancellationRequest = {
  cancellationId: "can_completion_001",
  jobId: workerFence.jobId,
  reason: "Stop the attempt",
  reasonCode: "operator_request",
  requestedAt: "2026-08-30T00:00:00.000Z",
  requestedByPrincipalId: "usr_completion",
  schemaVersion: "0.1",
  scope,
};

const acknowledgement: ReplayCancellationAcknowledgement = {
  acknowledgedAt: "2026-08-30T00:00:01.000Z",
  acknowledgementId: "ack_completion_001",
  action: "stop_requested",
  cancellationId: cancellation.cancellationId,
  mutationFence: workerFence,
  schemaVersion: "0.1",
  scope,
};

function processResult(
  status: ReplayTargetProcessStatus,
  failureCode: ReplayTargetProcessResult["failureCode"],
): ReplayTargetProcessResult {
  return {
    executionObservations: [],
    exitCode: status === "completed" ? 0 : 1,
    failureCode,
    isolation: [
      {
        control: "process_boundary",
        evidenceSha256: "b".repeat(64),
        kind: "isolation",
        verdict: "verified",
      },
    ],
    runtime: [],
    signal: null,
    status,
    stderr: {
      capturedBytes: 0,
      contentSha256: "0".repeat(64),
      evidenceSha256: "c".repeat(64),
      limitBytes: 16,
      observedAtLeastBytes: 0,
      stream: "stderr",
      truncated: false,
    },
    stdout: {
      capturedBytes: 0,
      contentSha256: "0".repeat(64),
      evidenceSha256: "d".repeat(64),
      limitBytes: 16,
      observedAtLeastBytes: 0,
      stream: "stdout",
      truncated: false,
    },
  };
}

function snapshot(
  options: {
    readonly acknowledgements?: readonly ReplayCancellationAcknowledgement[];
    readonly cancellationRequest?: ReplayCancellationRequest | null;
    readonly ledger?: readonly ReplayBudgetLedgerEntry[];
    readonly job?: Readonly<Record<string, unknown>>;
  } = {},
): ReplayJobSnapshot {
  return {
    attempts: [],
    budgetLedger: options.ledger ?? [],
    cancellationAcknowledgements: options.acknowledgements ?? [],
    cancellationRequest: options.cancellationRequest ?? null,
    executionObservations: [],
    job: {
      currentLease: { mutationFence: workerFence },
      jobId: workerFence.jobId,
      scope,
      ...options.job,
    },
    usageObservations: [],
  } as unknown as ReplayJobSnapshot;
}

function repository(returned: ReplayJobSnapshot, order: string[] = []) {
  const completeJob = vi.fn(async (_command: Parameters<ReplayJobRepository["completeJob"]>[0]) => {
    order.push("complete");
    return returned;
  });
  const heartbeatJob = vi.fn(
    async (_command: Parameters<ReplayJobRepository["heartbeatJob"]>[0]) => {
      order.push("heartbeat");
      return returned;
    },
  );
  const mocks = { completeJob, heartbeatJob };
  return mocks as typeof mocks & ReplayJobRepository;
}

function budget(): ReplayBudget {
  return Object.fromEntries(
    [
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
    ].map((dimension) => [dimension, { limit: 10, measurement: "measured" }]),
  ) as ReplayBudget;
}

function amounts(amount: number): ReplayBudgetAmounts {
  return Object.fromEntries(
    Object.keys(budget()).map((dimension) => [dimension, amount]),
  ) as unknown as ReplayBudgetAmounts;
}

function ledger(options: { readonly open?: boolean; readonly overrun?: boolean } = {}) {
  const reservation = reserveReplayBudget({
    budget: budget(),
    committed: emptyReplayBudgetAmounts(),
    ledgerSequence: 0,
    mutationFence: workerFence,
    requested: amounts(1),
    reservationId: "rsv_completion_001",
    reservedAt: "2026-08-30T00:00:00.000Z",
    scope,
    work: { kind: "attempt_start" },
  });
  if (options.open) return [reservation];
  const usage = Object.fromEntries(
    Object.keys(budget()).map((dimension) => [
      dimension,
      {
        amount: options.overrun && dimension === "inputTokens" ? 2 : 1,
        source: "measured",
        status: "observed",
      },
    ]),
  ) as Parameters<typeof reconcileReplayBudget>[1]["usage"];
  const reconciliation = reconcileReplayBudget(reservation, {
    ledgerSequence: 1,
    reconciledAt: "2026-08-30T00:00:01.000Z",
    reconciliationId: "rec_completion_001",
    usage,
  });
  return [reservation, reconciliation];
}

async function completionCommand(options: {
  readonly current?: ReplayJobSnapshot;
  readonly process?: ReplayTargetProcessResult;
  readonly result?: unknown;
}) {
  const current = options.current ?? snapshot({ ledger: ledger() });
  const targetRepository = repository(current);
  await completeSupervisedReplayAttempt({
    leaseDurationMilliseconds: 1_000,
    processResult: options.process ?? processResult("completed", null),
    repository: targetRepository,
    result: options.result ?? resultArtifact,
    scope,
    snapshot: current,
    workerFence,
  });
  return targetRepository.completeJob.mock.calls[0]?.[0];
}

describe("completeSupervisedReplayAttempt", () => {
  it("renews authority immediately before publishing one successful terminal result", async () => {
    const current = snapshot({ ledger: ledger() });
    const order: string[] = [];
    const targetRepository = repository(current, order);
    await expect(
      completeSupervisedReplayAttempt({
        leaseDurationMilliseconds: 1_000,
        processResult: processResult("completed", null),
        repository: targetRepository,
        result: resultArtifact,
        scope,
        snapshot: current,
        workerFence,
      }),
    ).resolves.toBe(current);
    expect(order).toEqual(["heartbeat", "complete"]);
    expect(targetRepository.completeJob).toHaveBeenCalledWith({
      code: "completed",
      result: resultArtifact,
      scope,
      status: "succeeded",
      workerFence,
    });
  });

  it("lets acknowledged durable cancellation win even when usage overran", async () => {
    const command = await completionCommand({
      current: snapshot({
        acknowledgements: [acknowledgement],
        cancellationRequest: cancellation,
        ledger: ledger({ overrun: true }),
      }),
      process: processResult("completed", null),
    });
    expect(command).toMatchObject({
      code: "cancellation_committed",
      error: { code: "cancelled", effectCertainty: "none" },
      status: "cancelled",
    });
    expect(command).not.toHaveProperty("result");
  });

  it("decides completion from the authoritative final heartbeat snapshot", async () => {
    const initial = snapshot({ ledger: ledger() });
    const authoritative = snapshot({
      acknowledgements: [acknowledgement],
      cancellationRequest: cancellation,
      ledger: ledger(),
    });
    const targetRepository = repository(authoritative);
    await completeSupervisedReplayAttempt({
      leaseDurationMilliseconds: 1_000,
      processResult: processResult("completed", null),
      repository: targetRepository,
      result: resultArtifact,
      scope,
      snapshot: initial,
      workerFence,
    });
    expect(targetRepository.completeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "cancellation_committed",
        status: "cancelled",
      }),
    );
  });

  it("preserves reconciled overruns as budget exhaustion", async () => {
    const command = await completionCommand({
      current: snapshot({ ledger: ledger({ overrun: true }) }),
      process: processResult("completed", null),
    });
    expect(command).toMatchObject({
      code: "budget_limit_reached",
      error: { code: "budget_exhausted", effectCertainty: "none" },
      status: "budget_exhausted",
    });
    expect(command).not.toHaveProperty("result");
  });

  it("maps every bounded process failure to a fixed terminal error class", async () => {
    const cases = [
      ["boundary_resolution_failed", "fixture_unavailable"],
      ["output_limit_exceeded", "isolation_failed"],
      ["runtime_control_violated", "isolation_failed"],
      ["protocol_failed", "contract_mismatch"],
      ["target_incomplete", "contract_mismatch"],
      ["spawn_failed", "target_content_unavailable"],
      ["target_exit_failed", "target_process_interrupted"],
      ["result_publication_failed", "target_temporary_failure"],
      ["worker_cancelled", "authority_denied"],
      ["invalid_supervisor_options", "worker_internal_error"],
      [null, "worker_internal_error"],
    ] as const;
    for (const [failureCode, errorCode] of cases) {
      const command = await completionCommand({
        process: processResult(
          failureCode === "worker_cancelled" ? "cancelled" : "failed",
          failureCode,
        ),
      });
      expect(command).toMatchObject({
        code: "execution_failed",
        error: { code: errorCode, detailsSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
        status: "failed",
      });
    }
    const timedOut = await completionCommand({
      process: processResult("deadline_reached", "deadline_reached"),
    });
    expect(timedOut).toMatchObject({
      code: "deadline_reached",
      error: { code: "deadline_exceeded" },
      status: "timed_out",
    });
  });

  it("rejects invalid policy, authority, accounting, cancellation, and success result", async () => {
    const current = snapshot({ ledger: ledger() });
    for (const leaseDurationMilliseconds of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalidRepository = repository(current);
      await expect(
        completeSupervisedReplayAttempt({
          leaseDurationMilliseconds,
          processResult: processResult("completed", null),
          repository: invalidRepository,
          result: resultArtifact,
          scope,
          snapshot: current,
          workerFence,
        }),
      ).rejects.toMatchObject({ code: "invalid_lease_policy" });
      expect(invalidRepository.heartbeatJob).not.toHaveBeenCalled();
    }

    for (const invalid of [
      snapshot({ job: { jobId: "job_other" }, ledger: ledger() }),
      snapshot({ job: { scope: { ...scope, projectId: "prj_other" } }, ledger: ledger() }),
      snapshot({ job: { currentLease: undefined }, ledger: ledger() }),
    ]) {
      const invalidRepository = repository(invalid);
      await expect(
        completeSupervisedReplayAttempt({
          leaseDurationMilliseconds: 1_000,
          processResult: processResult("completed", null),
          repository: invalidRepository,
          result: resultArtifact,
          scope,
          snapshot: invalid,
          workerFence,
        }),
      ).rejects.toMatchObject({ code: "invalid_completion_context" });
      expect(invalidRepository.heartbeatJob).not.toHaveBeenCalled();
    }

    for (const invalid of [
      snapshot({ ledger: ledger({ open: true }) }),
      snapshot({ ledger: [{ ...ledger({ open: true })[0], ledgerSequence: 1 } as never] }),
    ]) {
      await expect(
        completeSupervisedReplayAttempt({
          leaseDurationMilliseconds: 1_000,
          processResult: processResult("completed", null),
          repository: repository(invalid),
          result: resultArtifact,
          scope,
          snapshot: invalid,
          workerFence,
        }),
      ).rejects.toMatchObject({ code: "incomplete_accounting" });
    }

    const unacknowledged = snapshot({
      cancellationRequest: cancellation,
      ledger: ledger(),
    });
    await expect(
      completeSupervisedReplayAttempt({
        leaseDurationMilliseconds: 1_000,
        processResult: processResult("cancelled", "worker_cancelled"),
        repository: repository(unacknowledged),
        scope,
        snapshot: unacknowledged,
        workerFence,
      }),
    ).rejects.toMatchObject({ code: "invalid_completion_context" });

    for (const result of [undefined, { ...resultArtifact, sha256: "f" }]) {
      const invalidRepository = repository(current);
      await expect(
        completeSupervisedReplayAttempt({
          leaseDurationMilliseconds: 1_000,
          processResult: processResult("completed", null),
          repository: invalidRepository,
          result,
          scope,
          snapshot: current,
          workerFence,
        }),
      ).rejects.toMatchObject({ code: "missing_result" });
      expect(invalidRepository.heartbeatJob).not.toHaveBeenCalled();
    }
  });
});
