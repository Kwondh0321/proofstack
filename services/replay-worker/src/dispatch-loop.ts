import { randomUUID } from "node:crypto";
import {
  EvidenceScopeSchema,
  type EvidenceScope,
  OpaqueIdSchema,
  ReplayJobSchema,
  type ReplayWorkerMutationFence,
  Sha256Schema,
  WorkerProtocolReferenceSchema,
} from "@proofstack/contracts";
import {
  ReplayJobNotFoundError,
  type ReplayJobSnapshot,
  type ReplayJobWorkerRepository,
} from "@proofstack/replay";
import { ReplayDispatchLoopError } from "./errors.js";

const MAX_CONCURRENT_ATTEMPTS = 32;
const MAX_DURATION_MILLISECONDS = 86_400_000;
const MAX_SOURCE_FAILURE_ATTEMPTS = 100;
const MAX_SETTLEMENT_ATTEMPTS = 10;

export interface ReplayDispatchCandidate {
  readonly jobId: string;
  readonly scope: EvidenceScope;
}

export type ReplayDispatchSettlement =
  | {
      readonly disposition: "complete";
      readonly outcome: "attempt_terminal" | "job_terminal";
    }
  | {
      readonly disposition: "discard";
      readonly reason: "invalid_candidate" | "job_unavailable";
    }
  | {
      readonly disposition: "retry";
      readonly reason:
        | "attempt_failed"
        | "claim_deferred"
        | "claim_failed"
        | "worker_shutting_down";
      readonly retryAfterMilliseconds: number;
    };

export interface ReplayDispatchDelivery {
  readonly candidate: unknown;
  settle(settlement: ReplayDispatchSettlement): Promise<void>;
}

export interface ReplayDispatchSource {
  /** Returns null only after the source has closed and will produce no further deliveries. */
  receive(signal: AbortSignal): Promise<ReplayDispatchDelivery | null>;
}

export interface ExecuteClaimedReplayAttemptInput {
  readonly scope: EvidenceScope;
  readonly signal: AbortSignal;
  readonly snapshot: ReplayJobSnapshot;
  readonly workerFence: ReplayWorkerMutationFence;
}

export interface ReplayDispatchLoopOptions {
  readonly claimRetryDelayMilliseconds: number;
  readonly createClaimIds?: () => { readonly attemptId: string; readonly leaseId: string };
  readonly executeClaimedAttempt: (
    input: ExecuteClaimedReplayAttemptInput,
  ) => Promise<ReplayJobSnapshot>;
  readonly leaseDurationMilliseconds: number;
  readonly maxConcurrentAttempts: number;
  readonly repository: Pick<ReplayJobWorkerRepository, "claimJob">;
  readonly settlementAttempts: number;
  readonly settlementRetryDelayMilliseconds: number;
  readonly signal?: AbortSignal;
  readonly source: ReplayDispatchSource;
  readonly sourceFailureAttempts: number;
  readonly sourceRetryDelayMilliseconds: number;
  readonly workerBuildSha256: string;
  readonly workerId: string;
  readonly workerProtocol: unknown;
}

export interface ReplayDispatchLoopResult {
  readonly claimed: number;
  readonly completed: number;
  readonly deferred: number;
  readonly discarded: number;
  readonly failed: number;
  readonly received: number;
}

interface DispatchPolicy {
  readonly claimRetryDelayMilliseconds: number;
  readonly leaseDurationMilliseconds: number;
  readonly maxConcurrentAttempts: number;
  readonly settlementAttempts: number;
  readonly settlementRetryDelayMilliseconds: number;
  readonly sourceFailureAttempts: number;
  readonly sourceRetryDelayMilliseconds: number;
  readonly workerBuildSha256: string;
  readonly workerId: string;
  readonly workerProtocol: ReturnType<typeof WorkerProtocolReferenceSchema.parse>;
}

interface MutableDispatchLoopResult {
  claimed: number;
  completed: number;
  deferred: number;
  discarded: number;
  failed: number;
  received: number;
}

function positiveInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function validatePolicy(options: ReplayDispatchLoopOptions): DispatchPolicy {
  try {
    if (
      !positiveInteger(options.maxConcurrentAttempts, MAX_CONCURRENT_ATTEMPTS) ||
      !positiveInteger(options.leaseDurationMilliseconds, MAX_DURATION_MILLISECONDS) ||
      !positiveInteger(options.claimRetryDelayMilliseconds, MAX_DURATION_MILLISECONDS) ||
      !positiveInteger(options.sourceFailureAttempts, MAX_SOURCE_FAILURE_ATTEMPTS) ||
      !positiveInteger(options.sourceRetryDelayMilliseconds, MAX_DURATION_MILLISECONDS) ||
      !positiveInteger(options.settlementAttempts, MAX_SETTLEMENT_ATTEMPTS) ||
      !positiveInteger(options.settlementRetryDelayMilliseconds, MAX_DURATION_MILLISECONDS)
    ) {
      throw new TypeError("Dispatch policy contains an invalid bounded integer");
    }
    return {
      claimRetryDelayMilliseconds: options.claimRetryDelayMilliseconds,
      leaseDurationMilliseconds: options.leaseDurationMilliseconds,
      maxConcurrentAttempts: options.maxConcurrentAttempts,
      settlementAttempts: options.settlementAttempts,
      settlementRetryDelayMilliseconds: options.settlementRetryDelayMilliseconds,
      sourceFailureAttempts: options.sourceFailureAttempts,
      sourceRetryDelayMilliseconds: options.sourceRetryDelayMilliseconds,
      workerBuildSha256: Sha256Schema.parse(options.workerBuildSha256),
      workerId: OpaqueIdSchema.parse(options.workerId),
      workerProtocol: WorkerProtocolReferenceSchema.parse(options.workerProtocol),
    };
  } catch (error) {
    throw new ReplayDispatchLoopError("invalid_dispatch_policy", { cause: error });
  }
}

function defaultClaimIds(): { readonly attemptId: string; readonly leaseId: string } {
  const suffix = randomUUID().replaceAll("-", "");
  return { attemptId: `att_${suffix}`, leaseId: `lease_${suffix}` };
}

function claimIds(options: ReplayDispatchLoopOptions) {
  try {
    const value = (options.createClaimIds ?? defaultClaimIds)();
    return {
      attemptId: OpaqueIdSchema.parse(value.attemptId),
      leaseId: OpaqueIdSchema.parse(value.leaseId),
    };
  } catch (error) {
    throw new ReplayDispatchLoopError("invalid_claim_identity", { cause: error });
  }
}

function parseCandidate(input: unknown): ReplayDispatchCandidate | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const value = input as { readonly jobId?: unknown; readonly scope?: unknown };
  if (Object.keys(value).length !== 2 || !("jobId" in value) || !("scope" in value)) {
    return null;
  }
  const scope = EvidenceScopeSchema.safeParse(value.scope);
  const jobId = OpaqueIdSchema.safeParse(value.jobId);
  return scope.success && jobId.success ? { jobId: jobId.data, scope: scope.data } : null;
}

function requireDelivery(input: ReplayDispatchDelivery | null): ReplayDispatchDelivery | null {
  if (input === null) return null;
  if (typeof input !== "object" || typeof input.settle !== "function" || !("candidate" in input)) {
    throw new ReplayDispatchLoopError("invalid_delivery");
  }
  return input;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function settle(
  delivery: ReplayDispatchDelivery,
  settlement: ReplayDispatchSettlement,
  policy: DispatchPolicy,
): Promise<void> {
  let latestError: unknown;
  for (let attempt = 1; attempt <= policy.settlementAttempts; attempt += 1) {
    try {
      await delivery.settle(settlement);
      return;
    } catch (error) {
      latestError = error;
      if (attempt < policy.settlementAttempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, policy.settlementRetryDelayMilliseconds),
        );
      }
    }
  }
  throw new ReplayDispatchLoopError("settlement_failed", { cause: latestError });
}

function validTerminalSnapshot(
  snapshot: ReplayJobSnapshot,
  candidate: ReplayDispatchCandidate,
): boolean {
  const parsed = ReplayJobSchema.safeParse(snapshot.job);
  return (
    parsed.success &&
    parsed.data.jobId === candidate.jobId &&
    parsed.data.scope.tenantId === candidate.scope.tenantId &&
    parsed.data.scope.projectId === candidate.scope.projectId &&
    parsed.data.scope.environmentId === candidate.scope.environmentId &&
    parsed.data.terminal !== undefined
  );
}

async function processDelivery(
  delivery: ReplayDispatchDelivery,
  options: ReplayDispatchLoopOptions,
  policy: DispatchPolicy,
  signal: AbortSignal,
  result: MutableDispatchLoopResult,
): Promise<void> {
  result.received += 1;
  const candidate = parseCandidate(delivery.candidate);
  if (!candidate) {
    result.discarded += 1;
    await settle(delivery, { disposition: "discard", reason: "invalid_candidate" }, policy);
    return;
  }

  const ids = claimIds(options);
  let claimed: Awaited<ReturnType<ReplayJobWorkerRepository["claimJob"]>>;
  try {
    claimed = await options.repository.claimJob({
      attemptId: ids.attemptId,
      jobId: candidate.jobId,
      leaseDurationMilliseconds: policy.leaseDurationMilliseconds,
      leaseId: ids.leaseId,
      scope: candidate.scope,
      workerBuildSha256: policy.workerBuildSha256,
      workerId: policy.workerId,
      workerProtocol: policy.workerProtocol,
    });
  } catch (error) {
    if (error instanceof ReplayJobNotFoundError) {
      result.discarded += 1;
      await settle(delivery, { disposition: "discard", reason: "job_unavailable" }, policy);
      return;
    }
    result.failed += 1;
    await settle(
      delivery,
      {
        disposition: "retry",
        reason: "claim_failed",
        retryAfterMilliseconds: policy.claimRetryDelayMilliseconds,
      },
      policy,
    );
    return;
  }

  if (!claimed.claimed) {
    if (claimed.reason === "terminalized") {
      result.completed += 1;
      await settle(delivery, { disposition: "complete", outcome: "job_terminal" }, policy);
      return;
    }
    result.deferred += 1;
    await settle(
      delivery,
      {
        disposition: "retry",
        reason: "claim_deferred",
        retryAfterMilliseconds: policy.claimRetryDelayMilliseconds,
      },
      policy,
    );
    return;
  }

  result.claimed += 1;
  try {
    const snapshot = await options.executeClaimedAttempt({
      scope: candidate.scope,
      signal,
      snapshot: claimed.snapshot,
      workerFence: claimed.workerFence,
    });
    if (!validTerminalSnapshot(snapshot, candidate)) {
      throw new TypeError("Claimed replay attempt did not return its exact terminal job");
    }
    result.completed += 1;
    await settle(delivery, { disposition: "complete", outcome: "attempt_terminal" }, policy);
  } catch (error) {
    if (error instanceof ReplayDispatchLoopError && error.code === "settlement_failed") throw error;
    result.failed += 1;
    await settle(
      delivery,
      {
        disposition: "retry",
        reason: "attempt_failed",
        retryAfterMilliseconds: policy.leaseDurationMilliseconds,
      },
      policy,
    );
  }
}

/**
 * Pulls at most `maxConcurrentAttempts` exact job candidates at once.
 *
 * The dispatch source is delivery authority only. The worker repository remains the final tenant,
 * lease, retry, budget, and fencing authority for every claimed job.
 */
export async function runReplayDispatchLoop(
  options: ReplayDispatchLoopOptions,
): Promise<ReplayDispatchLoopResult> {
  const policy = validatePolicy(options);
  const peerAbort = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, peerAbort.signal])
    : peerAbort.signal;
  const result: MutableDispatchLoopResult = {
    claimed: 0,
    completed: 0,
    deferred: 0,
    discarded: 0,
    failed: 0,
    received: 0,
  };
  let sourceClosed = false;

  const worker = async () => {
    let consecutiveSourceFailures = 0;
    while (!sourceClosed && !signal.aborted) {
      let delivery: ReplayDispatchDelivery | null;
      try {
        delivery = requireDelivery(await options.source.receive(signal));
        consecutiveSourceFailures = 0;
      } catch (error) {
        if (error instanceof ReplayDispatchLoopError && error.code === "invalid_delivery") {
          throw error;
        }
        if (signal.aborted) return;
        consecutiveSourceFailures += 1;
        if (consecutiveSourceFailures >= policy.sourceFailureAttempts) {
          throw new ReplayDispatchLoopError("source_unavailable", { cause: error });
        }
        await wait(policy.sourceRetryDelayMilliseconds, signal);
        continue;
      }
      if (delivery === null) {
        sourceClosed = true;
        return;
      }
      if (signal.aborted) {
        result.received += 1;
        result.deferred += 1;
        await settle(
          delivery,
          {
            disposition: "retry",
            reason: "worker_shutting_down",
            retryAfterMilliseconds: policy.claimRetryDelayMilliseconds,
          },
          policy,
        );
        return;
      }
      await processDelivery(delivery, options, policy, signal, result);
    }
  };

  const workers = Array.from({ length: policy.maxConcurrentAttempts }, () => worker());
  try {
    await Promise.all(workers);
  } catch (error) {
    peerAbort.abort(error);
    await Promise.allSettled(workers);
    throw error;
  }
  return Object.freeze({ ...result });
}
