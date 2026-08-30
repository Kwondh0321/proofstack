import {
  type EvidenceScope,
  REPLAY_OBSERVATION_SCHEMA_VERSION,
  type ReplayAttempt,
  type ReplayBudgetLedgerEntry,
  type ReplayBudgetReconciliation,
  type ReplayBudgetReservation,
  type ReplayCancellationAcknowledgement,
  type ReplayCancellationRequest,
  type ReplayExecutionObservation,
  ReplayExecutionObservationSchema,
  type ReplayJob,
  type ReplayPlan,
  type ReplayUsageObservation,
  ReplayUsageObservationSchema,
  type ReplayWorkerMutationFence,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";
import {
  DurableReplayAccountingError,
  ReplayDefinitionLineageError,
  ReplayJobConflictError,
  ReplayJobNotFoundError,
  ReplayRepositoryContractError,
} from "../errors.js";
import {
  reconcileReplayBudget,
  reserveReplayBudget,
  summarizeReplayBudgetLedger,
} from "../replay-budget.js";
import type { ReplayDefinitionRepository } from "../replay-definition-repository.js";
import {
  buildReplayJobCancellationRequestedOutboxIntent,
  buildReplayJobCreatedOutboxIntent,
  buildReplayJobTerminalOutboxIntent,
  type ReplayJobOutboxIntent,
} from "../replay-job-outbox.js";
import type {
  AcknowledgeDurableReplayCancellationCommand,
  AppendReplayExecutionObservationCommand,
  AppendReplayUsageObservationCommand,
  ClaimDurableReplayJobCommand,
  ClaimDurableReplayJobResult,
  CompleteDurableReplayJobCommand,
  CreateReplayJobCommand,
  CreateReplayJobResult,
  HeartbeatDurableReplayJobCommand,
  ReconcileDurableReplayBudgetCommand,
  ReplayJobRepository,
  ReplayJobSnapshot,
  RequestDurableReplayCancellationCommand,
  RequestDurableReplayCancellationResult,
  ReserveDurableReplayBudgetCommand,
} from "../replay-job-repository.js";
import {
  acknowledgeReplayCancellation,
  assertReplayWorkerMutationFence,
  claimReplayJob,
  closeExpiredReplayAttempt,
  completeReplayAttempt,
  createQueuedReplayJob,
  heartbeatReplayJob,
  requestReplayCancellation,
} from "../replay-job-state.js";
import { decideReplayRetry } from "../replay-retry.js";

export type ReplayJobIntentKind = "cancellation_requested" | "job_created" | "job_terminal";

interface StoredReplayJob {
  readonly attempts: readonly ReplayAttempt[];
  readonly budgetLedger: readonly ReplayBudgetLedgerEntry[];
  readonly cancellationAcknowledgements: readonly ReplayCancellationAcknowledgement[];
  readonly cancellationRequest: ReplayCancellationRequest | null;
  readonly executionObservations: readonly ReplayExecutionObservation[];
  readonly intents: ReadonlyMap<string, ReplayJobOutboxIntent>;
  readonly job: ReplayJob;
  readonly usageObservations: readonly ReplayUsageObservation[];
}

export interface MemoryReplayJobRepositoryOptions {
  readonly definitions: ReplayDefinitionRepository;
  readonly now: () => string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function sameFence(left: ReplayWorkerMutationFence, right: ReplayWorkerMutationFence): boolean {
  return (
    left.jobId === right.jobId &&
    left.attemptId === right.attemptId &&
    left.leaseId === right.leaseId &&
    left.workerId === right.workerId &&
    left.fencingToken === right.fencingToken &&
    left.recoveryEpoch === right.recoveryEpoch
  );
}

function exactPlanReference(job: ReplayJob, plan: ReplayPlan): boolean {
  return (
    job.plan.planId === plan.planId &&
    job.plan.planVersionId === plan.planVersionId &&
    job.plan.definitionSha256 === plan.definitionSha256 &&
    sameScope(job.scope, plan.scope)
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function intentKey(intent: ReplayJobOutboxIntent): string {
  return `${intent.eventType}:${intent.aggregateId}`;
}

function snapshot(stored: StoredReplayJob): ReplayJobSnapshot {
  return clone({
    attempts: stored.attempts,
    budgetLedger: stored.budgetLedger,
    cancellationAcknowledgements: stored.cancellationAcknowledgements,
    cancellationRequest: stored.cancellationRequest,
    executionObservations: stored.executionObservations,
    job: stored.job,
    usageObservations: stored.usageObservations,
  });
}

function withIntent(stored: StoredReplayJob, intent: ReplayJobOutboxIntent): StoredReplayJob {
  const intents = new Map(stored.intents);
  intents.set(intentKey(intent), clone(intent));
  return { ...stored, intents };
}

function replaceAttempt(
  attempts: readonly ReplayAttempt[],
  attempt: ReplayAttempt,
): readonly ReplayAttempt[] {
  const next = [...attempts];
  next[attempt.attemptSequence] = clone(attempt);
  return next;
}

function currentAttempt(stored: StoredReplayJob): ReplayAttempt {
  const sequence = stored.job.latestAttemptSequence;
  /* v8 ignore next -- Domain transitions only expose a current attempt after assigning its sequence. */
  if (sequence === undefined) {
    throw new ReplayRepositoryContractError("Current replay attempt sequence is unavailable");
  }
  const attempt = stored.attempts[sequence];
  /* v8 ignore next -- Attempts are appended atomically with the job's authoritative sequence. */
  if (!attempt) throw new ReplayRepositoryContractError("Current replay attempt is unavailable");
  return attempt;
}

function exactWorkerProtocol(command: ClaimDurableReplayJobCommand, plan: ReplayPlan): boolean {
  return (
    command.workerProtocol.name === plan.workerProtocol.name &&
    command.workerProtocol.version === plan.workerProtocol.version
  );
}

function expiredEffect(plan: ReplayPlan) {
  const live = plan.boundaries.filter((boundary) => boundary.mode === "live_provider");
  if (live.length === 0) return { effectCertainty: "none" as const };
  if (live.every((boundary) => boundary.sideEffect.kind === "read_only")) {
    return {
      effectCertainty: "may_have_occurred" as const,
      effectRetrySafety: {
        evidenceSha256: plan.definitionSha256,
        kind: "read_only" as const,
      },
    };
  }
  return {
    effectCertainty: "may_have_occurred" as const,
    effectRetrySafety: { kind: "not_retryable" as const },
  };
}

function terminalCloseReason(
  reason: Exclude<ReturnType<typeof decideReplayRetry>, { eligible: true }>["reason"],
) {
  if (reason === "deadline_insufficient") {
    return { code: "deadline_reached" as const, status: "timed_out" as const };
  }
  return {
    code:
      reason === "effect_not_retry_safe"
        ? ("execution_failed" as const)
        : ("retries_exhausted" as const),
    status: "failed" as const,
  };
}

function hasOpenBudgetReservation(stored: StoredReplayJob): boolean {
  const reconciledReservationIds = new Set<string>();
  for (const entry of stored.budgetLedger) {
    if (entry.entryType === "reconciliation") {
      reconciledReservationIds.add(entry.reservationId);
    }
  }
  for (const entry of stored.budgetLedger) {
    if (entry.entryType === "reservation" && !reconciledReservationIds.has(entry.reservationId)) {
      return true;
    }
  }
  return false;
}

type ExpiredTerminalDecision =
  | { readonly code: "cancellation_committed"; readonly status: "cancelled" }
  | {
      readonly code: "execution_failed" | "retries_exhausted";
      readonly status: "failed";
    }
  | { readonly code: "deadline_reached"; readonly status: "timed_out" };

function terminalizeExpiredAttempt(
  stored: StoredReplayJob,
  effect: ReturnType<typeof expiredEffect>,
  now: string,
  terminal: ExpiredTerminalDecision,
): StoredReplayJob {
  const closed = closeExpiredReplayAttempt(stored.job, currentAttempt(stored), {
    ...terminal,
    effect,
    now,
  });
  return withIntent(
    {
      ...stored,
      attempts: replaceAttempt(stored.attempts, closed.attempt),
      job: closed.job,
    },
    buildReplayJobTerminalOutboxIntent(closed.job),
  );
}

/** Atomic in-memory reference adapter for the complete durable replay job port. */
export class MemoryReplayJobRepository implements ReplayJobRepository {
  private readonly definitions: ReplayDefinitionRepository;
  private readonly failedIntentKinds = new Set<ReplayJobIntentKind>();
  private readonly jobs = new Map<string, Map<string, StoredReplayJob>>();
  private readonly nowValue: () => string;

  constructor(options: MemoryReplayJobRepositoryOptions) {
    this.definitions = options.definitions;
    this.nowValue = options.now;
  }

  async createJob(command: CreateReplayJobCommand): Promise<CreateReplayJobResult> {
    const plan = await this.definitions.findReplayPlan(command.scope, command.plan.planVersionId);
    if (
      !plan ||
      plan.planId !== command.plan.planId ||
      plan.definitionSha256 !== command.plan.definitionSha256
    ) {
      throw new ReplayDefinitionLineageError();
    }
    const now = this.now();
    const candidate = createQueuedReplayJob({
      createdAt: now,
      createdByPrincipalId: command.createdByPrincipalId,
      request: { jobId: command.jobId, plan: command.plan },
      scope: command.scope,
    });
    const tenantJobs = this.jobs.get(command.scope.tenantId);
    const existing = tenantJobs?.get(command.jobId);
    if (existing) {
      if (
        !sameScope(existing.job.scope, command.scope) ||
        existing.job.createdByPrincipalId !== command.createdByPrincipalId ||
        !sameJson(existing.job.plan, command.plan)
      ) {
        throw new ReplayJobConflictError();
      }
      this.requireIntent(existing, buildReplayJobCreatedOutboxIntent(existing.job));
      return { created: false, snapshot: snapshot(existing) };
    }
    let stored: StoredReplayJob = {
      attempts: [],
      budgetLedger: [],
      cancellationAcknowledgements: [],
      cancellationRequest: null,
      executionObservations: [],
      intents: new Map(),
      job: candidate,
      usageObservations: [],
    };
    stored = withIntent(stored, buildReplayJobCreatedOutboxIntent(candidate));
    this.throwInjectedIntentFailure("job_created");
    const nextTenant = new Map(tenantJobs);
    nextTenant.set(command.jobId, stored);
    this.jobs.set(command.scope.tenantId, nextTenant);
    return { created: true, snapshot: snapshot(stored) };
  }

  async findJob(scope: EvidenceScope, jobId: string): Promise<ReplayJobSnapshot | null> {
    const stored = this.jobs.get(scope.tenantId)?.get(jobId);
    if (!stored || !sameScope(stored.job.scope, scope)) return null;
    return snapshot(stored);
  }

  async claimJob(command: ClaimDurableReplayJobCommand): Promise<ClaimDurableReplayJobResult> {
    const initial = this.requireJob(command.scope, command.jobId);
    const plan = await this.requirePlan(initial.job);
    const target = await this.definitions.findTargetRelease(
      plan.scope,
      plan.targetRelease.targetReleaseId,
    );
    if (
      !target ||
      target.definitionSha256 !== plan.targetRelease.definitionSha256 ||
      target.targetId !== plan.targetRelease.targetId ||
      !sameJson(target.targetAdapter, plan.targetRelease.targetAdapter) ||
      !sameJson(target.workerProtocol, plan.targetRelease.workerProtocol)
    ) {
      throw new ReplayDefinitionLineageError();
    }
    if (!exactWorkerProtocol(command, plan)) throw new ReplayDefinitionLineageError();
    if (command.leaseDurationMilliseconds > plan.retryPolicy.perAttemptTimeoutMilliseconds) {
      throw new ReplayJobConflictError();
    }
    const stored = this.requireJob(command.scope, command.jobId);
    if (stored.attempts.some(({ attemptId }) => attemptId === command.attemptId)) {
      throw new ReplayJobConflictError();
    }
    const now = this.now();
    let expiredEffectValue: ReturnType<typeof expiredEffect> | undefined;
    if (stored.job.status === "running") {
      const lease = stored.job.currentLease;
      /* v8 ignore next -- ReplayJobSchema requires every running job to carry a current lease. */
      if (!lease) throw new ReplayRepositoryContractError("Running replay job has no lease");
      if (Date.parse(now) >= Date.parse(lease.expiresAt)) {
        expiredEffectValue = expiredEffect(plan);
        const attempt = currentAttempt(stored);
        if (stored.cancellationRequest) {
          const next = terminalizeExpiredAttempt(stored, expiredEffectValue, now, {
            code: "cancellation_committed",
            status: "cancelled",
          });
          this.throwInjectedIntentFailure("job_terminal");
          this.replace(command.scope.tenantId, command.jobId, next);
          return { claimed: false, reason: "terminalized", snapshot: snapshot(next) };
        }
        if (hasOpenBudgetReservation(stored)) {
          const next = terminalizeExpiredAttempt(stored, expiredEffectValue, now, {
            code: "execution_failed",
            status: "failed",
          });
          this.throwInjectedIntentFailure("job_terminal");
          this.replace(command.scope.tenantId, command.jobId, next);
          return { claimed: false, reason: "terminalized", snapshot: snapshot(next) };
        }
        const startedAt = stored.job.startedAt;
        /* v8 ignore next -- A running job is created only by a claim that also assigns startedAt. */
        if (!startedAt) {
          throw new ReplayRepositoryContractError("Running replay job has no start time");
        }
        const retry = decideReplayRetry({
          attemptSequence: attempt.attemptSequence,
          error: {
            code: "lease_expired",
            ...expiredEffectValue,
            message: "The worker lease expired before a terminal attempt commit.",
          },
          evaluatedAt: now,
          failedAt: lease.expiresAt,
          jobStartedAt: startedAt,
          policy: plan.retryPolicy,
        });
        if (!retry.eligible) {
          const next = terminalizeExpiredAttempt(
            stored,
            expiredEffectValue,
            now,
            terminalCloseReason(retry.reason),
          );
          this.throwInjectedIntentFailure("job_terminal");
          this.replace(command.scope.tenantId, command.jobId, next);
          return { claimed: false, reason: "terminalized", snapshot: snapshot(next) };
        }
        if (Date.parse(now) < Date.parse(retry.notBefore)) {
          return { claimed: false, reason: "retry_not_ready", snapshot: snapshot(stored) };
        }
      }
    }

    const claimed = claimReplayJob(stored.job, {
      attemptId: command.attemptId,
      ...(stored.job.status === "running"
        ? {
            currentAttempt: currentAttempt(stored),
            ...(expiredEffectValue ? { expiredEffect: expiredEffectValue } : {}),
          }
        : {}),
      isolationProfile: plan.isolationProfile,
      leaseDurationMilliseconds: command.leaseDurationMilliseconds,
      leaseId: command.leaseId,
      maxAttempts: plan.retryPolicy.maxAttempts,
      now,
      runtimeProfile: plan.runtimeProfile,
      targetRelease: plan.targetRelease,
      workerBuildSha256: command.workerBuildSha256,
      workerId: command.workerId,
      workerProtocol: command.workerProtocol,
    });
    const attempts = claimed.expiredAttempt
      ? [...replaceAttempt(stored.attempts, claimed.expiredAttempt), claimed.attempt]
      : [...stored.attempts, claimed.attempt];
    const next = { ...stored, attempts, job: claimed.job };
    this.replace(command.scope.tenantId, command.jobId, next);
    return {
      claimed: true,
      snapshot: snapshot(next),
      workerFence: clone(claimed.lease.mutationFence),
    };
  }

  async heartbeatJob(command: HeartbeatDurableReplayJobCommand): Promise<ReplayJobSnapshot> {
    const initial = this.requireJob(command.scope, command.workerFence.jobId);
    const plan = await this.requirePlan(initial.job);
    if (command.leaseDurationMilliseconds > plan.retryPolicy.perAttemptTimeoutMilliseconds) {
      throw new ReplayJobConflictError();
    }
    const stored = this.requireJob(command.scope, command.workerFence.jobId);
    const job = heartbeatReplayJob(
      stored.job,
      command.workerFence,
      this.now(),
      command.leaseDurationMilliseconds,
    );
    const next = { ...stored, job };
    this.replace(command.scope.tenantId, job.jobId, next);
    return snapshot(next);
  }

  async requestCancellation(
    command: RequestDurableReplayCancellationCommand,
  ): Promise<RequestDurableReplayCancellationResult> {
    const stored = this.requireJob(command.scope, command.jobId);
    if (stored.job.terminal && !stored.cancellationRequest) {
      return { created: false, snapshot: snapshot(stored) };
    }
    const cancelled = requestReplayCancellation(stored.job, {
      ...(stored.cancellationRequest ? { existing: stored.cancellationRequest } : {}),
      input: command.input,
      now: this.now(),
      requestedByPrincipalId: command.requestedByPrincipalId,
    });
    if (!cancelled.created) {
      this.requireIntent(
        stored,
        buildReplayJobCancellationRequestedOutboxIntent(stored.job, cancelled.request),
      );
      if (stored.job.terminal) {
        this.requireIntent(stored, buildReplayJobTerminalOutboxIntent(stored.job));
      }
      return { created: false, snapshot: snapshot(stored) };
    }
    let next: StoredReplayJob = {
      ...stored,
      cancellationRequest: cancelled.request,
      job: cancelled.job,
    };
    next = withIntent(
      next,
      buildReplayJobCancellationRequestedOutboxIntent(cancelled.job, cancelled.request),
    );
    this.throwInjectedIntentFailure("cancellation_requested");
    if (cancelled.job.terminal) {
      next = withIntent(next, buildReplayJobTerminalOutboxIntent(cancelled.job));
      this.throwInjectedIntentFailure("job_terminal");
    }
    this.replace(command.scope.tenantId, command.jobId, next);
    return { created: true, snapshot: snapshot(next) };
  }

  async acknowledgeCancellation(
    command: AcknowledgeDurableReplayCancellationCommand,
  ): Promise<ReplayJobSnapshot> {
    const stored = this.requireJob(command.scope, command.workerFence.jobId);
    const request = stored.cancellationRequest;
    if (!request) throw new ReplayJobConflictError();
    const acknowledgement = acknowledgeReplayCancellation(
      stored.job,
      request,
      command.workerFence,
      {
        acknowledgementId: command.acknowledgementId,
        action: command.action,
        now: this.now(),
      },
    );
    const existing = stored.cancellationAcknowledgements.find(
      ({ acknowledgementId }) => acknowledgementId === command.acknowledgementId,
    );
    if (existing) {
      const equivalent = {
        action: acknowledgement.action,
        cancellationId: acknowledgement.cancellationId,
        mutationFence: acknowledgement.mutationFence,
        scope: acknowledgement.scope,
      };
      const storedEquivalent = {
        action: existing.action,
        cancellationId: existing.cancellationId,
        mutationFence: existing.mutationFence,
        scope: existing.scope,
      };
      if (!sameJson(equivalent, storedEquivalent)) throw new ReplayJobConflictError();
      return snapshot(stored);
    }
    const next = {
      ...stored,
      cancellationAcknowledgements: [...stored.cancellationAcknowledgements, acknowledgement],
    };
    this.replace(command.scope.tenantId, stored.job.jobId, next);
    return snapshot(next);
  }

  async reserveBudget(command: ReserveDurableReplayBudgetCommand): Promise<ReplayJobSnapshot> {
    const initial = this.requireJob(command.scope, command.workerFence.jobId);
    const plan = await this.requirePlan(initial.job);
    const stored = this.requireJob(command.scope, command.workerFence.jobId);
    const now = this.now();
    assertReplayWorkerMutationFence(stored.job, command.workerFence, now);
    const existing = stored.budgetLedger.find(
      (entry): entry is ReplayBudgetReservation =>
        entry.entryType === "reservation" && entry.reservationId === command.reservationId,
    );
    if (existing) {
      const requested = Object.fromEntries(
        Object.entries(existing.dimensions).map(([dimension, value]) => [
          dimension,
          value.reservedAmount,
        ]),
      );
      if (
        !sameJson(existing.mutationFence, command.workerFence) ||
        !sameJson(existing.work, command.work) ||
        !sameJson(requested, command.requested)
      ) {
        throw new ReplayJobConflictError();
      }
      return snapshot(stored);
    }
    const summary = summarizeReplayBudgetLedger(stored.budgetLedger);
    const reservation = reserveReplayBudget({
      budget: plan.budget,
      committed: summary.committed,
      ledgerSequence: stored.budgetLedger.length,
      mutationFence: command.workerFence,
      requested: command.requested,
      reservationId: command.reservationId,
      reservedAt: now,
      scope: command.scope,
      work: command.work,
    });
    const next = { ...stored, budgetLedger: [...stored.budgetLedger, reservation] };
    this.replace(command.scope.tenantId, stored.job.jobId, next);
    return snapshot(next);
  }

  async reconcileBudget(command: ReconcileDurableReplayBudgetCommand): Promise<ReplayJobSnapshot> {
    const stored = this.requireJob(command.scope, command.workerFence.jobId);
    const now = this.now();
    assertReplayWorkerMutationFence(stored.job, command.workerFence, now);
    const reservation = stored.budgetLedger.find(
      (entry): entry is ReplayBudgetReservation =>
        entry.entryType === "reservation" && entry.reservationId === command.reservationId,
    );
    if (!reservation || !sameFence(reservation.mutationFence, command.workerFence)) {
      throw new ReplayJobConflictError();
    }
    const candidate = reconcileReplayBudget(reservation, {
      ledgerSequence: stored.budgetLedger.length,
      reconciledAt: now,
      reconciliationId: command.reconciliationId,
      usage: command.usage,
    });
    const existingById = stored.budgetLedger.find(
      (entry): entry is ReplayBudgetReconciliation =>
        entry.entryType === "reconciliation" && entry.reconciliationId === command.reconciliationId,
    );
    const existingForReservation = stored.budgetLedger.find(
      (entry): entry is ReplayBudgetReconciliation =>
        entry.entryType === "reconciliation" && entry.reservationId === command.reservationId,
    );
    const existing = existingById ?? existingForReservation;
    if (existing) {
      if (
        existing.reconciliationId !== candidate.reconciliationId ||
        existing.reservationId !== candidate.reservationId ||
        !sameJson(existing.dimensions, candidate.dimensions) ||
        !sameFence(existing.mutationFence, candidate.mutationFence)
      ) {
        throw new ReplayJobConflictError();
      }
      return snapshot(stored);
    }
    const ledger = [...stored.budgetLedger, candidate];
    summarizeReplayBudgetLedger(ledger);
    const next = { ...stored, budgetLedger: ledger };
    this.replace(command.scope.tenantId, stored.job.jobId, next);
    return snapshot(next);
  }

  async appendExecutionObservation(
    command: AppendReplayExecutionObservationCommand,
  ): Promise<ReplayJobSnapshot> {
    const initial = this.requireJob(command.scope, command.workerFence.jobId);
    const plan = await this.requirePlan(initial.job);
    const stored = this.requireJob(command.scope, command.workerFence.jobId);
    const now = this.now();
    assertReplayWorkerMutationFence(stored.job, command.workerFence, now);
    const payload = command.payload;
    if (payload.kind === "boundary") {
      const boundary = plan.boundaries.find(({ boundaryId }) => boundaryId === payload.boundaryId);
      if (!boundary || boundary.kind !== payload.boundaryKind || boundary.mode !== payload.mode) {
        throw new ReplayJobConflictError();
      }
    }
    if (
      payload.kind === "cancellation" &&
      payload.cancellationId !== stored.cancellationRequest?.cancellationId
    ) {
      throw new ReplayJobConflictError();
    }
    const candidate = ReplayExecutionObservationSchema.parse({
      mutationFence: command.workerFence,
      observationId: command.observationId,
      observationSequence: stored.executionObservations.length + stored.usageObservations.length,
      observedAt: now,
      payload,
      schemaVersion: REPLAY_OBSERVATION_SCHEMA_VERSION,
      scope: command.scope,
    });
    return this.appendObservation(stored, candidate, "execution");
  }

  async appendUsageObservation(
    command: AppendReplayUsageObservationCommand,
  ): Promise<ReplayJobSnapshot> {
    const initial = this.requireJob(command.scope, command.workerFence.jobId);
    const plan = await this.requirePlan(initial.job);
    const stored = this.requireJob(command.scope, command.workerFence.jobId);
    const now = this.now();
    assertReplayWorkerMutationFence(stored.job, command.workerFence, now);
    if (
      command.boundaryId !== undefined &&
      !plan.boundaries.some(({ boundaryId }) => boundaryId === command.boundaryId)
    ) {
      throw new ReplayJobConflictError();
    }
    const candidate = ReplayUsageObservationSchema.parse({
      ...(command.boundaryId === undefined ? {} : { boundaryId: command.boundaryId }),
      measurements: command.measurements,
      mutationFence: command.workerFence,
      observationId: command.observationId,
      observationSequence: stored.executionObservations.length + stored.usageObservations.length,
      observedAt: now,
      schemaVersion: REPLAY_OBSERVATION_SCHEMA_VERSION,
      scope: command.scope,
      sourceEventSha256: command.sourceEventSha256,
    });
    return this.appendObservation(stored, candidate, "usage");
  }

  async completeJob(command: CompleteDurableReplayJobCommand): Promise<ReplayJobSnapshot> {
    const stored = this.requireJob(command.scope, command.workerFence.jobId);
    const now = this.now();
    assertReplayWorkerMutationFence(stored.job, command.workerFence, now);
    const ledger = summarizeReplayBudgetLedger(stored.budgetLedger);
    if (ledger.openReservationIds.length > 0) {
      throw new DurableReplayAccountingError("accounting_conflict");
    }
    if (
      ledger.overruns.length > 0 &&
      command.status !== "budget_exhausted" &&
      stored.cancellationRequest === null
    ) {
      throw new DurableReplayAccountingError("accounting_conflict");
    }
    if (
      stored.cancellationRequest &&
      !stored.cancellationAcknowledgements.some(({ mutationFence }) =>
        sameFence(mutationFence, command.workerFence),
      )
    ) {
      throw new ReplayJobConflictError();
    }
    const completed = completeReplayAttempt(
      stored.job,
      currentAttempt(stored),
      command.workerFence,
      {
        cancellationRequested: stored.cancellationRequest !== null,
        code: command.code,
        ...(command.error ? { error: command.error } : {}),
        now,
        ...(command.result ? { result: command.result } : {}),
        status: command.status,
      },
    );
    let next: StoredReplayJob = {
      ...stored,
      attempts: replaceAttempt(stored.attempts, completed.attempt),
      job: completed.job,
    };
    next = withIntent(next, buildReplayJobTerminalOutboxIntent(completed.job));
    this.throwInjectedIntentFailure("job_terminal");
    this.replace(command.scope.tenantId, stored.job.jobId, next);
    return snapshot(next);
  }

  failNextIntent(kind: ReplayJobIntentKind): void {
    this.failedIntentKinds.add(kind);
  }

  async publishedIntents(tenantId: string): Promise<readonly ReplayJobOutboxIntent[]> {
    const intents = [...(this.jobs.get(tenantId)?.values() ?? [])].flatMap((stored) => [
      ...stored.intents.values(),
    ]);
    return clone(intents.sort((left, right) => (intentKey(left) < intentKey(right) ? -1 : 1)));
  }

  removeIntent(kind: ReplayJobIntentKind, tenantId: string, jobId: string): void {
    const tenantJobs = this.jobs.get(tenantId);
    const stored = tenantJobs?.get(jobId);
    if (!tenantJobs || !stored) return;
    const eventType = {
      cancellation_requested: "replay.job.cancellation-requested",
      job_created: "replay.job.created",
      job_terminal: "replay.job.terminal",
    }[kind];
    const intents = new Map(stored.intents);
    intents.delete(`${eventType}:${jobId}`);
    const nextTenant = new Map(tenantJobs);
    nextTenant.set(jobId, { ...stored, intents });
    this.jobs.set(tenantId, nextTenant);
  }

  private appendObservation(
    stored: StoredReplayJob,
    candidate: ReplayExecutionObservation | ReplayUsageObservation,
    kind: "execution" | "usage",
  ): ReplayJobSnapshot {
    const existing = [...stored.executionObservations, ...stored.usageObservations].find(
      ({ observationId }) => observationId === candidate.observationId,
    );
    if (existing) {
      const comparable = ({
        observedAt: _time,
        observationSequence: _sequence,
        ...value
      }: typeof existing) => value;
      if (!sameJson(comparable(existing), comparable(candidate))) {
        throw new ReplayJobConflictError();
      }
      return snapshot(stored);
    }
    const next: StoredReplayJob =
      kind === "execution"
        ? {
            ...stored,
            executionObservations: [
              ...stored.executionObservations,
              candidate as ReplayExecutionObservation,
            ],
          }
        : {
            ...stored,
            usageObservations: [...stored.usageObservations, candidate as ReplayUsageObservation],
          };
    this.replace(candidate.scope.tenantId, candidate.mutationFence.jobId, next);
    return snapshot(next);
  }

  private now(): string {
    return UtcMillisecondTimestampSchema.parse(this.nowValue());
  }

  private replace(tenantId: string, jobId: string, stored: StoredReplayJob): void {
    const tenantJobs = new Map(this.jobs.get(tenantId));
    tenantJobs.set(jobId, stored);
    this.jobs.set(tenantId, tenantJobs);
  }

  private requireIntent(stored: StoredReplayJob, expected: ReplayJobOutboxIntent): void {
    if (!sameJson(stored.intents.get(intentKey(expected)), expected)) {
      throw new ReplayRepositoryContractError("Replay job publication intent is unavailable");
    }
  }

  private requireJob(scope: EvidenceScope, jobId: string): StoredReplayJob {
    const stored = this.jobs.get(scope.tenantId)?.get(jobId);
    if (!stored || !sameScope(stored.job.scope, scope)) throw new ReplayJobNotFoundError();
    return stored;
  }

  private async requirePlan(job: ReplayJob): Promise<ReplayPlan> {
    const plan = await this.definitions.findReplayPlan(job.scope, job.plan.planVersionId);
    if (!plan || !exactPlanReference(job, plan)) throw new ReplayDefinitionLineageError();
    return plan;
  }

  private throwInjectedIntentFailure(kind: ReplayJobIntentKind): void {
    if (!this.failedIntentKinds.delete(kind)) return;
    throw new Error(`Injected ${kind} replay job intent failure`);
  }
}
