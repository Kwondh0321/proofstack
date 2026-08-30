import type { EvidenceScope } from "@proofstack/contracts";
import type { ReplayJobSnapshot, ReplayJobWorkerRepository } from "@proofstack/replay";
import { ReplayJobNotFoundError } from "@proofstack/replay";
import { describe, expect, it } from "vitest";
import {
  type ReplayDispatchDelivery,
  type ReplayDispatchLoopOptions,
  type ReplayDispatchSettlement,
  runReplayDispatchLoop,
} from "./dispatch-loop.js";
import { ReplayDispatchLoopError } from "./errors.js";

const scope = {
  environmentId: "env_dispatch_test",
  projectId: "prj_dispatch_test",
  tenantId: "ten_dispatch_test",
} as const;
const jobId = "job_dispatch_test";
const fence = {
  attemptId: "att_dispatch_test",
  fencingToken: 1,
  jobId,
  leaseId: "lease_dispatch_test",
  recoveryEpoch: 0,
  workerId: "wrk_dispatch_test",
} as const;
const startedAt = "2026-08-30T03:00:00.000Z";
const endedAt = "2026-08-30T03:00:01.000Z";
const plan = {
  definitionSha256: "1".repeat(64),
  planId: "plan_dispatch_test",
  planVersionId: "plv_dispatch_test",
} as const;

function runningSnapshot(id = jobId): ReplayJobSnapshot {
  const currentFence = { ...fence, jobId: id };
  return {
    attempts: [],
    budgetLedger: [],
    cancellationAcknowledgements: [],
    cancellationRequest: null,
    executionObservations: [],
    job: {
      createdAt: startedAt,
      createdByPrincipalId: "usr_dispatch_test",
      currentLease: {
        acquiredAt: startedAt,
        attemptSequence: 0,
        expiresAt: endedAt,
        heartbeatAt: startedAt,
        mutationFence: currentFence,
        schemaVersion: "0.1",
        scope,
      },
      jobId: id,
      lastFencingToken: 1,
      latestAttemptSequence: 0,
      plan,
      recoveryEpoch: 0,
      schemaVersion: "0.1",
      scope,
      startedAt,
      stateVersion: 2,
      status: "running",
    },
    usageObservations: [],
  };
}

function terminalSnapshot(id = jobId, terminalScope: EvidenceScope = scope): ReplayJobSnapshot {
  return {
    ...runningSnapshot(id),
    job: {
      ...runningSnapshot(id).job,
      currentLease: undefined,
      scope: terminalScope,
      stateVersion: 3,
      status: "failed",
      terminal: {
        attemptId: fence.attemptId,
        code: "execution_failed",
        committedAt: endedAt,
        status: "failed",
      },
    },
  };
}

class Delivery implements ReplayDispatchDelivery {
  readonly settlements: ReplayDispatchSettlement[] = [];
  settlementFailures = 0;

  constructor(readonly candidate: unknown) {}

  async settle(settlement: ReplayDispatchSettlement): Promise<void> {
    if (this.settlementFailures > 0) {
      this.settlementFailures -= 1;
      throw new Error("settlement unavailable");
    }
    this.settlements.push(settlement);
  }
}

type SourceItem = Error | ReplayDispatchDelivery | null;

class Source {
  readonly signals: AbortSignal[] = [];

  constructor(readonly items: SourceItem[]) {}

  async receive(signal: AbortSignal): Promise<ReplayDispatchDelivery | null> {
    this.signals.push(signal);
    const item = this.items.shift() ?? null;
    if (item instanceof Error) throw item;
    return item;
  }
}

function claimed(job = jobId) {
  return {
    claimed: true as const,
    snapshot: runningSnapshot(job),
    workerFence: { ...fence, jobId: job },
  };
}

function options(overrides: Partial<ReplayDispatchLoopOptions> = {}): ReplayDispatchLoopOptions {
  return {
    claimRetryDelayMilliseconds: 1,
    createClaimIds: () => ({ attemptId: fence.attemptId, leaseId: fence.leaseId }),
    executeClaimedAttempt: async () => terminalSnapshot(),
    leaseDurationMilliseconds: 2_000,
    maxConcurrentAttempts: 1,
    repository: { claimJob: async () => claimed() },
    settlementAttempts: 2,
    settlementRetryDelayMilliseconds: 1,
    source: new Source([null]),
    sourceFailureAttempts: 2,
    sourceRetryDelayMilliseconds: 1,
    workerBuildSha256: "2".repeat(64),
    workerId: fence.workerId,
    workerProtocol: { name: "proofstack.replay-worker", version: "1.0.0" },
    ...overrides,
  };
}

describe("runReplayDispatchLoop", () => {
  it("claims and completes one exact delivered replay job", async () => {
    const delivery = new Delivery({ jobId, scope });
    let claimCommand: Parameters<ReplayJobWorkerRepository["claimJob"]>[0] | undefined;
    let executorInput:
      | Parameters<ReplayDispatchLoopOptions["executeClaimedAttempt"]>[0]
      | undefined;
    const result = await runReplayDispatchLoop(
      options({
        executeClaimedAttempt: async (input) => {
          executorInput = input;
          return terminalSnapshot();
        },
        repository: {
          claimJob: async (command) => {
            claimCommand = command;
            return claimed();
          },
        },
        source: new Source([delivery, null]),
      }),
    );

    expect(claimCommand).toEqual({
      attemptId: fence.attemptId,
      jobId,
      leaseDurationMilliseconds: 2_000,
      leaseId: fence.leaseId,
      scope,
      workerBuildSha256: "2".repeat(64),
      workerId: fence.workerId,
      workerProtocol: { name: "proofstack.replay-worker", version: "1.0.0" },
    });
    expect(executorInput).toMatchObject({ scope, workerFence: fence });
    expect(delivery.settlements).toEqual([
      { disposition: "complete", outcome: "attempt_terminal" },
    ]);
    expect(result).toEqual({
      claimed: 1,
      completed: 1,
      deferred: 0,
      discarded: 0,
      failed: 0,
      received: 1,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("uses bounded random claim identifiers when no factory is supplied", async () => {
    const delivery = new Delivery({ jobId, scope });
    let attemptId = "";
    let leaseId = "";
    const configured = options({
      repository: {
        claimJob: async (command) => {
          attemptId = command.attemptId;
          leaseId = command.leaseId;
          return claimed();
        },
      },
      source: new Source([delivery, null]),
    });
    delete (configured as { createClaimIds?: unknown }).createClaimIds;
    await runReplayDispatchLoop(configured);
    expect(attemptId).toMatch(/^att_[0-9a-f]{32}$/);
    expect(leaseId).toMatch(/^lease_[0-9a-f]{32}$/);
  });

  it("defers a job whose retry schedule is not ready", async () => {
    const delivery = new Delivery({ jobId, scope });
    const result = await runReplayDispatchLoop(
      options({
        executeClaimedAttempt: async () => {
          throw new Error("executor must not run");
        },
        repository: {
          claimJob: async () => ({
            claimed: false,
            reason: "retry_not_ready",
            snapshot: runningSnapshot(),
          }),
        },
        source: new Source([delivery, null]),
      }),
    );
    expect(delivery.settlements).toEqual([
      { disposition: "retry", reason: "claim_deferred", retryAfterMilliseconds: 1 },
    ]);
    expect(result).toMatchObject({ deferred: 1, received: 1 });
  });

  it("completes a delivery terminalized during claim", async () => {
    const delivery = new Delivery({ jobId, scope });
    const result = await runReplayDispatchLoop(
      options({
        repository: {
          claimJob: async () => ({
            claimed: false,
            reason: "terminalized",
            snapshot: terminalSnapshot(),
          }),
        },
        source: new Source([delivery, null]),
      }),
    );
    expect(delivery.settlements).toEqual([{ disposition: "complete", outcome: "job_terminal" }]);
    expect(result).toMatchObject({ completed: 1, received: 1 });
  });

  it.each([
    ["string", "invalid"],
    ["null", null],
    ["array", []],
    ["missing key", { jobId }],
    ["extra key", { extra: true, jobId, scope }],
    ["invalid job", { jobId: "INVALID", scope }],
    ["invalid scope", { jobId, scope: { ...scope, tenantId: "INVALID" } }],
  ])("discards an invalid %s candidate", async (_label, candidate) => {
    const delivery = new Delivery(candidate);
    const result = await runReplayDispatchLoop(options({ source: new Source([delivery, null]) }));
    expect(delivery.settlements).toEqual([{ disposition: "discard", reason: "invalid_candidate" }]);
    expect(result).toMatchObject({ discarded: 1, received: 1 });
  });

  it("discards a candidate hidden from the worker scope", async () => {
    const delivery = new Delivery({ jobId, scope });
    const result = await runReplayDispatchLoop(
      options({
        repository: {
          claimJob: async () => {
            throw new ReplayJobNotFoundError();
          },
        },
        source: new Source([delivery, null]),
      }),
    );
    expect(delivery.settlements).toEqual([{ disposition: "discard", reason: "job_unavailable" }]);
    expect(result).toMatchObject({ discarded: 1 });
  });

  it("retries a delivery after a claim failure", async () => {
    const delivery = new Delivery({ jobId, scope });
    const result = await runReplayDispatchLoop(
      options({
        repository: {
          claimJob: async () => {
            throw new Error("database unavailable");
          },
        },
        source: new Source([delivery, null]),
      }),
    );
    expect(delivery.settlements).toEqual([
      { disposition: "retry", reason: "claim_failed", retryAfterMilliseconds: 1 },
    ]);
    expect(result).toMatchObject({ failed: 1 });
  });

  it.each([
    [
      "executor failure",
      async () => {
        throw new Error("attempt failed");
      },
    ],
    [
      "invalid job",
      async () => ({ ...terminalSnapshot(), job: "invalid" }) as unknown as ReplayJobSnapshot,
    ],
    ["wrong job", async () => terminalSnapshot("job_other")],
    ["wrong tenant", async () => terminalSnapshot(jobId, { ...scope, tenantId: "ten_other" })],
    ["wrong project", async () => terminalSnapshot(jobId, { ...scope, projectId: "prj_other" })],
    [
      "wrong environment",
      async () => terminalSnapshot(jobId, { ...scope, environmentId: "env_other" }),
    ],
    ["nonterminal job", async () => runningSnapshot()],
  ])("retries after %s", async (_label, executeClaimedAttempt) => {
    const delivery = new Delivery({ jobId, scope });
    const result = await runReplayDispatchLoop(
      options({ executeClaimedAttempt, source: new Source([delivery, null]) }),
    );
    expect(delivery.settlements).toEqual([
      { disposition: "retry", reason: "attempt_failed", retryAfterMilliseconds: 2_000 },
    ]);
    expect(result).toMatchObject({ claimed: 1, failed: 1 });
  });

  it("retries an idempotent delivery settlement", async () => {
    const delivery = new Delivery({ jobId, scope });
    delivery.settlementFailures = 1;
    await expect(
      runReplayDispatchLoop(options({ source: new Source([delivery, null]) })),
    ).resolves.toMatchObject({ completed: 1 });
    expect(delivery.settlements).toHaveLength(1);
  });

  it("fails closed after exhausting settlement attempts", async () => {
    const delivery = new Delivery({ jobId, scope });
    delivery.settlementFailures = 2;
    await expect(
      runReplayDispatchLoop(options({ source: new Source([delivery, null]) })),
    ).rejects.toMatchObject({ code: "settlement_failed" });
  });

  it("retries bounded transient source failures and resets after a delivery", async () => {
    const first = new Delivery({ jobId, scope });
    const source = new Source([
      new Error("first receive failed"),
      first,
      new Error("later failure"),
      null,
    ]);
    const result = await runReplayDispatchLoop(options({ source, sourceFailureAttempts: 2 }));
    expect(result).toMatchObject({ completed: 1, received: 1 });
    expect(source.signals).toHaveLength(4);
  });

  it("fails closed after bounded source failures", async () => {
    await expect(
      runReplayDispatchLoop(
        options({
          source: new Source([new Error("first"), new Error("second")]),
          sourceFailureAttempts: 2,
        }),
      ),
    ).rejects.toMatchObject({ code: "source_unavailable" });
  });

  it("stops a source retry delay when the caller aborts", async () => {
    const controller = new AbortController();
    const source = new Source([new Error("transient")]);
    const promise = runReplayDispatchLoop(
      options({ signal: controller.signal, source, sourceRetryDelayMilliseconds: 50 }),
    );
    setTimeout(() => controller.abort("shutdown"), 1);
    await expect(promise).resolves.toEqual({
      claimed: 0,
      completed: 0,
      deferred: 0,
      discarded: 0,
      failed: 0,
      received: 0,
    });
  });

  it("stops without receiving when the caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("shutdown");
    const source = new Source([new Delivery({ jobId, scope })]);
    await expect(
      runReplayDispatchLoop(options({ signal: controller.signal, source })),
    ).resolves.toMatchObject({
      received: 0,
    });
    expect(source.signals).toEqual([]);
  });

  it("stops when a source aborts during receive", async () => {
    const controller = new AbortController();
    const source = {
      async receive() {
        controller.abort("shutdown");
        throw new Error("receive interrupted");
      },
    };
    await expect(
      runReplayDispatchLoop(options({ signal: controller.signal, source })),
    ).resolves.toMatchObject({ received: 0 });
  });

  it("returns a delivery received during shutdown without claiming it", async () => {
    const controller = new AbortController();
    const delivery = new Delivery({ jobId, scope });
    const source = {
      async receive() {
        controller.abort("shutdown");
        return delivery;
      },
    };
    const result = await runReplayDispatchLoop(
      options({
        repository: {
          claimJob: async () => {
            throw new Error("claim must not run during shutdown");
          },
        },
        signal: controller.signal,
        source,
      }),
    );
    expect(delivery.settlements).toEqual([
      {
        disposition: "retry",
        reason: "worker_shutting_down",
        retryAfterMilliseconds: 1,
      },
    ]);
    expect(result).toMatchObject({ deferred: 1, received: 1 });
  });

  it("never executes more than the configured concurrency", async () => {
    const deliveries = [
      new Delivery({ jobId: "job_dispatch_first", scope }),
      new Delivery({ jobId: "job_dispatch_second", scope }),
    ];
    let active = 0;
    let maximumActive = 0;
    let releaseBoth: (() => void) | undefined;
    const bothActive = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const result = await runReplayDispatchLoop(
      options({
        executeClaimedAttempt: async ({ snapshot }) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          if (active === 2) releaseBoth?.();
          await bothActive;
          active -= 1;
          return terminalSnapshot(snapshot.job.jobId);
        },
        maxConcurrentAttempts: 2,
        repository: {
          claimJob: async (command) => claimed(command.jobId),
        },
        source: new Source([...deliveries, null, null]),
      }),
    );
    expect(maximumActive).toBe(2);
    expect(result).toMatchObject({ claimed: 2, completed: 2, received: 2 });
  });

  it.each([
    ["zero concurrency", { maxConcurrentAttempts: 0 }],
    ["excess concurrency", { maxConcurrentAttempts: 33 }],
    ["fractional lease", { leaseDurationMilliseconds: 1.5 }],
    ["excess lease", { leaseDurationMilliseconds: 86_400_001 }],
    ["zero claim delay", { claimRetryDelayMilliseconds: 0 }],
    ["zero source failures", { sourceFailureAttempts: 0 }],
    ["excess source failures", { sourceFailureAttempts: 101 }],
    ["zero source delay", { sourceRetryDelayMilliseconds: 0 }],
    ["zero settlement attempts", { settlementAttempts: 0 }],
    ["excess settlement attempts", { settlementAttempts: 11 }],
    ["zero settlement delay", { settlementRetryDelayMilliseconds: 0 }],
    ["invalid worker id", { workerId: "INVALID" }],
    ["invalid build digest", { workerBuildSha256: "invalid" }],
    ["invalid protocol", { workerProtocol: { name: "invalid protocol", version: "1.0.0" } }],
  ])("rejects %s before receiving", async (_label, override) => {
    const source = new Source([null]);
    await expect(runReplayDispatchLoop(options({ ...override, source }))).rejects.toMatchObject({
      code: "invalid_dispatch_policy",
    });
    expect(source.signals).toEqual([]);
  });

  it.each([
    ["invalid attempt", { attemptId: "INVALID", leaseId: fence.leaseId }],
    ["invalid lease", { attemptId: fence.attemptId, leaseId: "INVALID" }],
  ])("fails closed on %s claim identity", async (_label, ids) => {
    const delivery = new Delivery({ jobId, scope });
    await expect(
      runReplayDispatchLoop(
        options({ createClaimIds: () => ids, source: new Source([delivery, null]) }),
      ),
    ).rejects.toMatchObject({ code: "invalid_claim_identity" });
  });

  it.each([
    ["primitive", "invalid"],
    ["missing candidate", { settle: async () => {} }],
    ["missing settlement", { candidate: { jobId, scope } }],
  ])("fails closed on a malformed %s delivery", async (_label, malformed) => {
    const source = {
      async receive() {
        return malformed as ReplayDispatchDelivery;
      },
    };
    await expect(
      runReplayDispatchLoop(options({ source, sourceFailureAttempts: 1 })),
    ).rejects.toBeInstanceOf(ReplayDispatchLoopError);
  });
});
