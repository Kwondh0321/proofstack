import { isDeepStrictEqual } from "node:util";
import {
  ArtifactContentReferenceSchema,
  EvidenceScopeSchema,
  type EvidenceScope,
  OpaqueIdSchema,
  REPLAY_BUDGET_DIMENSIONS,
  ReplayAttemptErrorSchema,
  ReplayAttemptSchema,
  ReplayBudgetLedgerEntrySchema,
  ReplayBudgetWorkReferenceSchema,
  ReplayCancellationAcknowledgementSchema,
  ReplayCancellationRequestSchema,
  ReplayExecutionObservationPayloadSchema,
  ReplayExecutionObservationSchema,
  ReplayJobSchema,
  ReplayJobTerminalCodeSchema,
  ReplayJobTerminalStatusSchema,
  ReplayUsageMeasurementSchema,
  ReplayUsageObservationSchema,
  ReplayWorkerMutationFenceSchema,
  Sha256Schema,
  WorkerProtocolReferenceSchema,
  type ReplayWorkerMutationFence,
} from "@proofstack/contracts";
import {
  DurableReplayAccountingError,
  DurableReplayStateError,
  ReplayDefinitionLineageError,
  ReplayJobConflictError,
  ReplayJobNotFoundError,
  ReplayRepositoryContractError,
  type AcknowledgeDurableReplayCancellationCommand,
  type AppendReplayExecutionObservationCommand,
  type AppendReplayUsageObservationCommand,
  type ClaimDurableReplayJobCommand,
  type ClaimDurableReplayJobResult,
  type CompleteDurableReplayJobCommand,
  type HeartbeatDurableReplayJobCommand,
  type ReconcileDurableReplayBudgetCommand,
  type ReplayBudgetAmounts,
  type ReplayJobSnapshot,
  type ReplayJobWorkerRepository,
  type ReplayUsageMeasurements,
  type ReserveDurableReplayBudgetCommand,
} from "@proofstack/replay";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { withTenantTransaction } from "./tenant-transaction.js";

const MAX_LEASE_DURATION_MILLISECONDS = 86_400_000;
const SNAPSHOT_KEYS = [
  "attempts",
  "budgetLedger",
  "cancellationAcknowledgements",
  "cancellationRequest",
  "executionObservations",
  "job",
  "usageObservations",
] as const;

type WorkerOperation =
  | "acknowledge"
  | "append_execution"
  | "append_usage"
  | "claim"
  | "complete"
  | "heartbeat"
  | "reconcile"
  | "reserve";

interface SnapshotRow extends QueryResultRow {
  readonly snapshot: unknown;
}

interface CreatedMutationRow extends QueryResultRow {
  readonly created: boolean;
}

interface AcknowledgementRow extends CreatedMutationRow {
  readonly acknowledgement: unknown;
}

interface BudgetReservationRow extends CreatedMutationRow {
  readonly reservation: unknown;
}

interface BudgetReconciliationRow extends CreatedMutationRow {
  readonly reconciliation: unknown;
}

interface ObservationRow extends CreatedMutationRow {
  readonly observation: unknown;
}

interface ClaimRow extends QueryResultRow {
  readonly attempt: unknown;
  readonly claimed: boolean;
  readonly job: unknown;
  readonly reason: string | null;
  readonly worker_fence: unknown;
}

interface JobMutationRow extends QueryResultRow {
  readonly job: unknown;
}

interface CompletionRow extends QueryResultRow {
  readonly attempt: unknown;
  readonly job: unknown;
}

interface RawSnapshot {
  readonly attempts: unknown;
  readonly budgetLedger: unknown;
  readonly cancellationAcknowledgements: unknown;
  readonly cancellationRequest: unknown;
  readonly executionObservations: unknown;
  readonly job: unknown;
  readonly usageObservations: unknown;
}

function contractViolation(message: string, cause?: unknown): never {
  throw new ReplayRepositoryContractError(message, cause === undefined ? undefined : { cause });
}

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function postgresMessage(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : "";
}

function stateErrorCode(message: string): ConstructorParameters<typeof DurableReplayStateError>[0] {
  if (/attempt limit/i.test(message)) return "attempt_limit_reached";
  if (/counter|state version/i.test(message)) return "counter_exhausted";
  if (/lease is active|active .*lease/i.test(message)) return "lease_active";
  if (/lease is expired|expired lease/i.test(message)) return "lease_expired";
  if (/stale|another worker fence/i.test(message)) return "stale_fence";
  if (/cancellation/i.test(message)) return "cancellation_conflict";
  return "state_conflict";
}

function mapPersistenceError(error: unknown, operation: WorkerOperation): never {
  if (
    error instanceof DurableReplayAccountingError ||
    error instanceof DurableReplayStateError ||
    error instanceof ReplayDefinitionLineageError ||
    error instanceof ReplayJobConflictError ||
    error instanceof ReplayJobNotFoundError ||
    error instanceof ReplayRepositoryContractError
  ) {
    throw error;
  }

  const code = postgresCode(error);
  const message = postgresMessage(error);
  if (code === "P0002") {
    if (/Replay job is unavailable/i.test(message)) throw new ReplayJobNotFoundError();
    throw new ReplayJobConflictError();
  }
  if (code === "23505") throw new ReplayJobConflictError();
  if (code === "23503") {
    if (operation === "claim" && /exact published plan/i.test(message)) {
      throw new ReplayDefinitionLineageError();
    }
    throw new ReplayJobConflictError();
  }
  if (code === "23514" && operation === "claim" && /worker protocol/i.test(message)) {
    throw new ReplayDefinitionLineageError();
  }
  if (code === "40001") {
    throw new DurableReplayStateError("state_conflict", { cause: error });
  }
  if (/every budget reservation|budget overrun|budget ledger|committed accounting/i.test(message)) {
    throw new DurableReplayAccountingError("accounting_conflict", { cause: error });
  }
  if (code === "22003") {
    if (operation === "reserve" || operation === "reconcile" || operation === "complete") {
      throw new DurableReplayAccountingError("invalid_budget", { cause: error });
    }
    throw new DurableReplayStateError(stateErrorCode(message), { cause: error });
  }
  if (code === "55000" && /stale|lease|not running|attempt limit|counter/i.test(message)) {
    throw new DurableReplayStateError(stateErrorCode(message), { cause: error });
  }
  if (code === "22023" || code === "23514" || code === "55000") {
    throw new ReplayJobConflictError();
  }
  throw error;
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

function requireRecord(input: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    contractViolation(`${label} is not an object`);
  }
  return input as Readonly<Record<string, unknown>>;
}

function requireArray(input: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(input)) contractViolation(`${label} is not an array`);
  return input;
}

function requireExactSnapshotKeys(value: Readonly<Record<string, unknown>>): void {
  const keys = Object.keys(value).sort();
  if (!isDeepStrictEqual(keys, [...SNAPSHOT_KEYS].sort())) {
    contractViolation("PostgreSQL returned an invalid replay snapshot shape");
  }
}

function parseSnapshot(
  input: unknown,
  expectedScope: EvidenceScope,
  expectedJobId: string,
): ReplayJobSnapshot {
  try {
    const value = requireRecord(input, "Replay snapshot");
    requireExactSnapshotKeys(value);
    const raw = value as unknown as RawSnapshot;
    const job = ReplayJobSchema.parse(raw.job);
    const attempts = requireArray(raw.attempts, "Replay attempts").map((item) =>
      ReplayAttemptSchema.parse(item),
    );
    const budgetLedger = requireArray(raw.budgetLedger, "Replay budget ledger").map((item) =>
      ReplayBudgetLedgerEntrySchema.parse(item),
    );
    const cancellationAcknowledgements = requireArray(
      raw.cancellationAcknowledgements,
      "Replay cancellation acknowledgements",
    ).map((item) => ReplayCancellationAcknowledgementSchema.parse(item));
    const cancellationRequest =
      raw.cancellationRequest === null
        ? null
        : ReplayCancellationRequestSchema.parse(raw.cancellationRequest);
    const executionObservations = requireArray(
      raw.executionObservations,
      "Replay execution observations",
    ).map((item) => ReplayExecutionObservationSchema.parse(item));
    const usageObservations = requireArray(raw.usageObservations, "Replay usage observations").map(
      (item) => ReplayUsageObservationSchema.parse(item),
    );

    if (job.jobId !== expectedJobId || !sameScope(job.scope, expectedScope)) {
      contractViolation("PostgreSQL replay snapshot escaped its authorized scope");
    }
    if (
      attempts.some((attempt, index) => {
        const previous = attempts[index - 1];
        return (
          attempt.jobId !== job.jobId ||
          attempt.attemptSequence !== index ||
          !sameScope(attempt.scope, job.scope) ||
          !isDeepStrictEqual(attempt.plan, job.plan) ||
          attempt.mutationFence.recoveryEpoch > job.recoveryEpoch ||
          attempt.mutationFence.fencingToken > job.lastFencingToken ||
          (previous !== undefined &&
            (attempt.mutationFence.fencingToken <= previous.mutationFence.fencingToken ||
              attempt.mutationFence.recoveryEpoch < previous.mutationFence.recoveryEpoch))
        );
      }) ||
      (attempts.length === 0
        ? job.latestAttemptSequence !== undefined
        : job.latestAttemptSequence !== attempts.length - 1 ||
          attempts.at(-1)?.mutationFence.fencingToken !== job.lastFencingToken)
    ) {
      contractViolation("PostgreSQL replay attempt history is not contiguous");
    }

    const attemptsById = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));
    const requireKnownFence = (fence: ReplayWorkerMutationFence) => {
      const attempt = attemptsById.get(fence.attemptId);
      if (!attempt || !sameFence(attempt.mutationFence, fence) || fence.jobId !== job.jobId) {
        contractViolation("PostgreSQL replay history contains an unknown worker fence");
      }
    };
    const latestAttempt = attempts.at(-1);
    if (job.currentLease) {
      requireKnownFence(job.currentLease.mutationFence);
      if (
        latestAttempt?.status !== "running" ||
        !sameFence(latestAttempt.mutationFence, job.currentLease.mutationFence)
      ) {
        contractViolation(
          "PostgreSQL replay current lease does not own the latest running attempt",
        );
      }
    }
    if (job.terminal?.attemptId) {
      const terminalAttempt = attemptsById.get(job.terminal.attemptId);
      if (
        !terminalAttempt ||
        terminalAttempt.attemptId !== latestAttempt?.attemptId ||
        terminalAttempt.status === "running" ||
        terminalAttempt.endedAt === undefined ||
        Date.parse(job.terminal.committedAt) < Date.parse(terminalAttempt.endedAt)
      ) {
        contractViolation("PostgreSQL replay terminal record does not close the latest attempt");
      }
    }

    if (
      budgetLedger.some((entry, index) => {
        requireKnownFence(entry.mutationFence);
        return entry.ledgerSequence !== index || !sameScope(entry.scope, job.scope);
      })
    ) {
      contractViolation("PostgreSQL replay budget history is not contiguous");
    }
    if (
      cancellationRequest &&
      (cancellationRequest.jobId !== job.jobId || !sameScope(cancellationRequest.scope, job.scope))
    ) {
      contractViolation("PostgreSQL replay cancellation request escaped its job scope");
    }
    for (const acknowledgement of cancellationAcknowledgements) {
      requireKnownFence(acknowledgement.mutationFence);
      if (
        !cancellationRequest ||
        acknowledgement.cancellationId !== cancellationRequest.cancellationId ||
        !sameScope(acknowledgement.scope, job.scope)
      ) {
        contractViolation("PostgreSQL replay cancellation acknowledgement has no exact request");
      }
    }

    const observations = [...executionObservations, ...usageObservations].sort(
      (left, right) => left.observationSequence - right.observationSequence,
    );
    if (
      observations.some((observation, index) => {
        requireKnownFence(observation.mutationFence);
        return (
          observation.observationSequence !== index || !sameScope(observation.scope, job.scope)
        );
      })
    ) {
      contractViolation("PostgreSQL replay observation history is not contiguous");
    }
    for (const observation of executionObservations) {
      if (
        observation.payload.kind === "cancellation" &&
        observation.payload.cancellationId !== cancellationRequest?.cancellationId
      ) {
        contractViolation("PostgreSQL replay cancellation observation has no exact request");
      }
    }

    return structuredClone({
      attempts,
      budgetLedger,
      cancellationAcknowledgements,
      cancellationRequest,
      executionObservations,
      job,
      usageObservations,
    });
  } catch (error) {
    if (error instanceof ReplayRepositoryContractError) throw error;
    contractViolation("PostgreSQL returned an invalid replay job snapshot", error);
  }
}

function requireScope(input: EvidenceScope): EvidenceScope {
  return EvidenceScopeSchema.parse(input);
}

function requireId(input: string): string {
  return OpaqueIdSchema.parse(input);
}

function requireLeaseDuration(input: number): number {
  if (!Number.isSafeInteger(input) || input < 1 || input > MAX_LEASE_DURATION_MILLISECONDS) {
    throw new ReplayJobConflictError();
  }
  return input;
}

function requireAmounts(input: ReplayBudgetAmounts): ReplayBudgetAmounts {
  const value = requireRecord(input, "Replay budget amounts");
  if (
    !isDeepStrictEqual(Object.keys(value).sort(), [...REPLAY_BUDGET_DIMENSIONS].sort()) ||
    REPLAY_BUDGET_DIMENSIONS.some(
      (dimension) => !Number.isSafeInteger(value[dimension]) || (value[dimension] as number) < 0,
    )
  ) {
    throw new DurableReplayAccountingError("invalid_amounts");
  }
  return structuredClone(input);
}

function requireUsage(input: ReplayUsageMeasurements): ReplayUsageMeasurements {
  const value = requireRecord(input, "Replay budget usage");
  if (!isDeepStrictEqual(Object.keys(value).sort(), [...REPLAY_BUDGET_DIMENSIONS].sort())) {
    throw new DurableReplayAccountingError("invalid_usage");
  }
  return Object.fromEntries(
    REPLAY_BUDGET_DIMENSIONS.map((dimension) => [
      dimension,
      ReplayUsageMeasurementSchema.parse(value[dimension]),
    ]),
  ) as ReplayUsageMeasurements;
}

function requireFence(input: ReplayWorkerMutationFence): ReplayWorkerMutationFence {
  return ReplayWorkerMutationFenceSchema.parse(input);
}

function fenceParameters(fence: ReplayWorkerMutationFence): readonly unknown[] {
  return [
    fence.jobId,
    fence.attemptId,
    fence.leaseId,
    fence.workerId,
    fence.fencingToken,
    fence.recoveryEpoch,
  ];
}

function requireOneRow<Row extends QueryResultRow>(rows: readonly Row[], label: string): Row {
  const row = rows[0];
  if (rows.length !== 1 || !row) contractViolation(`PostgreSQL returned an invalid ${label}`);
  return row;
}

async function loadSnapshot(
  client: PoolClient,
  scope: EvidenceScope,
  jobId: string,
): Promise<ReplayJobSnapshot | null> {
  const result = await client.query<SnapshotRow>(
    "SELECT public.proofstack_read_replay_job_snapshot($1, $2, $3) AS snapshot",
    [scope.projectId, scope.environmentId, jobId],
  );
  const row = requireOneRow(result.rows, "replay snapshot result");
  return row.snapshot === null ? null : parseSnapshot(row.snapshot, scope, jobId);
}

async function requireSnapshot(
  client: PoolClient,
  scope: EvidenceScope,
  jobId: string,
): Promise<ReplayJobSnapshot> {
  const snapshot = await loadSnapshot(client, scope, jobId);
  if (!snapshot) contractViolation("A successful replay mutation returned no durable snapshot");
  return snapshot;
}

async function requireCreatedMutation<Row extends CreatedMutationRow>(
  client: PoolClient,
  sql: string,
  parameters: unknown[],
  label: string,
): Promise<Row> {
  const result = await client.query<Row>(sql, parameters);
  const row = requireOneRow(result.rows, label);
  if (typeof row.created !== "boolean")
    contractViolation(`PostgreSQL returned an invalid ${label}`);
  return row;
}

/** PostgreSQL worker-only adapter for fenced replay execution state. */
export class PostgresReplayJobWorkerRepository implements ReplayJobWorkerRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async findJob(scopeInput: EvidenceScope, jobIdInput: string): Promise<ReplayJobSnapshot | null> {
    const scope = requireScope(scopeInput);
    const jobId = requireId(jobIdInput);
    return withTenantTransaction(this.pool, scope.tenantId, (client) =>
      loadSnapshot(client, scope, jobId),
    );
  }

  async claimJob(command: ClaimDurableReplayJobCommand): Promise<ClaimDurableReplayJobResult> {
    const scope = requireScope(command.scope);
    const jobId = requireId(command.jobId);
    const attemptId = requireId(command.attemptId);
    const leaseId = requireId(command.leaseId);
    const workerId = requireId(command.workerId);
    const workerProtocol = WorkerProtocolReferenceSchema.parse(command.workerProtocol);
    const workerBuildSha256 = Sha256Schema.parse(command.workerBuildSha256);
    const leaseDuration = requireLeaseDuration(command.leaseDurationMilliseconds);
    try {
      return await withTenantTransaction(this.pool, scope.tenantId, async (client) => {
        const result = await client.query<ClaimRow>(
          `SELECT * FROM public.proofstack_claim_replay_job(
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
          )`,
          [
            scope.projectId,
            scope.environmentId,
            jobId,
            attemptId,
            leaseId,
            workerId,
            workerProtocol.name,
            workerProtocol.version,
            workerBuildSha256,
            leaseDuration,
          ],
        );
        const row = requireOneRow(result.rows, "replay claim result");
        const snapshot = await requireSnapshot(client, scope, jobId);
        const returnedJob = ReplayJobSchema.parse(row.job);
        if (!isDeepStrictEqual(returnedJob, snapshot.job)) {
          contractViolation("PostgreSQL replay claim job disagrees with its durable snapshot");
        }
        if (row.claimed === false) {
          if (
            (row.reason !== "retry_not_ready" && row.reason !== "terminalized") ||
            row.worker_fence !== null ||
            row.attempt !== null
          ) {
            contractViolation("PostgreSQL returned an invalid unclaimed replay result");
          }
          return { claimed: false, reason: row.reason, snapshot };
        }
        if (row.claimed !== true || row.reason !== null) {
          contractViolation("PostgreSQL returned an invalid claimed replay result");
        }
        const workerFence = ReplayWorkerMutationFenceSchema.parse(row.worker_fence);
        const returnedAttempt = ReplayAttemptSchema.parse(row.attempt);
        if (
          !isDeepStrictEqual(returnedJob, snapshot.job) ||
          !isDeepStrictEqual(returnedAttempt, snapshot.attempts.at(-1)) ||
          !sameFence(workerFence, returnedAttempt.mutationFence)
        ) {
          contractViolation("PostgreSQL replay claim result disagrees with its durable snapshot");
        }
        return { claimed: true, snapshot, workerFence };
      });
    } catch (error) {
      mapPersistenceError(error, "claim");
    }
  }

  async heartbeatJob(command: HeartbeatDurableReplayJobCommand): Promise<ReplayJobSnapshot> {
    return this.withFencedJob(command, "heartbeat", async (client, scope, fence) => {
      const leaseDuration = requireLeaseDuration(command.leaseDurationMilliseconds);
      const result = await client.query<JobMutationRow>(
        `SELECT public.proofstack_heartbeat_replay_job(
          $1, $2, $3, $4, $5, $6, $7, $8, $9
        ) AS job`,
        [scope.projectId, scope.environmentId, ...fenceParameters(fence), leaseDuration],
      );
      const row = requireOneRow(result.rows, "replay heartbeat result");
      const snapshot = await requireSnapshot(client, scope, fence.jobId);
      if (!isDeepStrictEqual(ReplayJobSchema.parse(row.job), snapshot.job)) {
        contractViolation("PostgreSQL replay heartbeat disagrees with its durable snapshot");
      }
      return snapshot;
    });
  }

  async acknowledgeCancellation(
    command: AcknowledgeDurableReplayCancellationCommand,
  ): Promise<ReplayJobSnapshot> {
    const acknowledgementId = requireId(command.acknowledgementId);
    const actions = new Set([
      "observed_after_uninterruptible_completion",
      "stop_requested",
      "stopped_before_target_start",
    ]);
    if (!actions.has(command.action)) throw new ReplayJobConflictError();
    return this.withFencedJob(command, "acknowledge", async (client, scope, fence) => {
      const row = await requireCreatedMutation<AcknowledgementRow>(
        client,
        `SELECT * FROM public.proofstack_acknowledge_replay_cancellation(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        )`,
        [
          scope.projectId,
          scope.environmentId,
          ...fenceParameters(fence),
          acknowledgementId,
          command.action,
        ],
        "replay cancellation acknowledgement result",
      );
      const snapshot = await requireSnapshot(client, scope, fence.jobId);
      const acknowledgement = ReplayCancellationAcknowledgementSchema.parse(row.acknowledgement);
      if (
        !isDeepStrictEqual(
          acknowledgement,
          snapshot.cancellationAcknowledgements.find(
            (candidate) => candidate.acknowledgementId === acknowledgementId,
          ),
        )
      ) {
        contractViolation(
          "PostgreSQL replay cancellation acknowledgement disagrees with its durable snapshot",
        );
      }
      return snapshot;
    });
  }

  async reserveBudget(command: ReserveDurableReplayBudgetCommand): Promise<ReplayJobSnapshot> {
    const reservationId = requireId(command.reservationId);
    const work = ReplayBudgetWorkReferenceSchema.parse(command.work);
    const requested = requireAmounts(command.requested);
    return this.withFencedJob(command, "reserve", async (client, scope, fence) => {
      const row = await requireCreatedMutation<BudgetReservationRow>(
        client,
        `SELECT * FROM public.proofstack_reserve_replay_budget(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb
        )`,
        [
          scope.projectId,
          scope.environmentId,
          ...fenceParameters(fence),
          reservationId,
          JSON.stringify(work),
          JSON.stringify(requested),
        ],
        "replay budget reservation result",
      );
      const snapshot = await requireSnapshot(client, scope, fence.jobId);
      const reservation = ReplayBudgetLedgerEntrySchema.parse(row.reservation);
      if (
        reservation.entryType !== "reservation" ||
        !isDeepStrictEqual(
          reservation,
          snapshot.budgetLedger.find(
            (entry) => entry.entryType === "reservation" && entry.reservationId === reservationId,
          ),
        )
      ) {
        contractViolation("PostgreSQL replay reservation disagrees with its durable snapshot");
      }
      return snapshot;
    });
  }

  async reconcileBudget(command: ReconcileDurableReplayBudgetCommand): Promise<ReplayJobSnapshot> {
    const reconciliationId = requireId(command.reconciliationId);
    const reservationId = requireId(command.reservationId);
    const usage = requireUsage(command.usage);
    return this.withFencedJob(command, "reconcile", async (client, scope, fence) => {
      const row = await requireCreatedMutation<BudgetReconciliationRow>(
        client,
        `SELECT * FROM public.proofstack_reconcile_replay_budget(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
        )`,
        [
          scope.projectId,
          scope.environmentId,
          ...fenceParameters(fence),
          reconciliationId,
          reservationId,
          JSON.stringify(usage),
        ],
        "replay budget reconciliation result",
      );
      const snapshot = await requireSnapshot(client, scope, fence.jobId);
      const reconciliation = ReplayBudgetLedgerEntrySchema.parse(row.reconciliation);
      if (
        reconciliation.entryType !== "reconciliation" ||
        !isDeepStrictEqual(
          reconciliation,
          snapshot.budgetLedger.find(
            (entry) =>
              entry.entryType === "reconciliation" && entry.reconciliationId === reconciliationId,
          ),
        )
      ) {
        contractViolation("PostgreSQL replay reconciliation disagrees with its durable snapshot");
      }
      return snapshot;
    });
  }

  async appendExecutionObservation(
    command: AppendReplayExecutionObservationCommand,
  ): Promise<ReplayJobSnapshot> {
    const observationId = requireId(command.observationId);
    const payload = ReplayExecutionObservationPayloadSchema.parse(command.payload);
    return this.withFencedJob(command, "append_execution", async (client, scope, fence) => {
      const row = await requireCreatedMutation<ObservationRow>(
        client,
        `SELECT * FROM public.proofstack_append_replay_execution_observation(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb
        )`,
        [
          scope.projectId,
          scope.environmentId,
          ...fenceParameters(fence),
          observationId,
          JSON.stringify(payload),
        ],
        "replay execution observation result",
      );
      const snapshot = await requireSnapshot(client, scope, fence.jobId);
      const observation = ReplayExecutionObservationSchema.parse(row.observation);
      if (
        !isDeepStrictEqual(
          observation,
          snapshot.executionObservations.find(
            (candidate) => candidate.observationId === observationId,
          ),
        )
      ) {
        contractViolation(
          "PostgreSQL replay execution observation disagrees with its durable snapshot",
        );
      }
      return snapshot;
    });
  }

  async appendUsageObservation(
    command: AppendReplayUsageObservationCommand,
  ): Promise<ReplayJobSnapshot> {
    const observationId = requireId(command.observationId);
    const boundaryId = command.boundaryId === undefined ? null : requireId(command.boundaryId);
    const sourceEventSha256 = Sha256Schema.parse(command.sourceEventSha256);
    const measurements = command.measurements.map(({ dimension, usage }) => ({
      dimension,
      usage: ReplayUsageMeasurementSchema.parse(usage),
    }));
    if (
      measurements.length < 1 ||
      measurements.length > REPLAY_BUDGET_DIMENSIONS.length ||
      measurements.some(
        ({ dimension }, index) =>
          !REPLAY_BUDGET_DIMENSIONS.includes(dimension) ||
          (index > 0 && (measurements[index - 1]?.dimension ?? "") >= dimension),
      )
    ) {
      throw new ReplayJobConflictError();
    }
    return this.withFencedJob(command, "append_usage", async (client, scope, fence) => {
      const row = await requireCreatedMutation<ObservationRow>(
        client,
        `SELECT * FROM public.proofstack_append_replay_usage_observation(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
        )`,
        [
          scope.projectId,
          scope.environmentId,
          ...fenceParameters(fence),
          observationId,
          boundaryId,
          sourceEventSha256,
          JSON.stringify(measurements),
        ],
        "replay usage observation result",
      );
      const snapshot = await requireSnapshot(client, scope, fence.jobId);
      const observation = ReplayUsageObservationSchema.parse(row.observation);
      if (
        !isDeepStrictEqual(
          observation,
          snapshot.usageObservations.find((candidate) => candidate.observationId === observationId),
        )
      ) {
        contractViolation(
          "PostgreSQL replay usage observation disagrees with its durable snapshot",
        );
      }
      return snapshot;
    });
  }

  async completeJob(command: CompleteDurableReplayJobCommand): Promise<ReplayJobSnapshot> {
    const status = ReplayJobTerminalStatusSchema.parse(command.status);
    const code = ReplayJobTerminalCodeSchema.parse(command.code);
    const error =
      command.error === undefined ? null : ReplayAttemptErrorSchema.parse(command.error);
    const result =
      command.result === undefined ? null : ArtifactContentReferenceSchema.parse(command.result);
    return this.withFencedJob(command, "complete", async (client, scope, fence) => {
      const query = await client.query<CompletionRow>(
        `SELECT * FROM public.proofstack_complete_replay_job(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb
        )`,
        [
          scope.projectId,
          scope.environmentId,
          ...fenceParameters(fence),
          status,
          code,
          error === null ? null : JSON.stringify(error),
          result === null ? null : JSON.stringify(result),
        ],
      );
      const row = requireOneRow(query.rows, "replay completion result");
      const snapshot = await requireSnapshot(client, scope, fence.jobId);
      const attempt = ReplayAttemptSchema.parse(row.attempt);
      if (
        !isDeepStrictEqual(ReplayJobSchema.parse(row.job), snapshot.job) ||
        !isDeepStrictEqual(attempt, snapshot.attempts.at(-1))
      ) {
        contractViolation("PostgreSQL replay completion disagrees with its durable snapshot");
      }
      return snapshot;
    });
  }

  private async withFencedJob<Result>(
    command: { readonly scope: EvidenceScope; readonly workerFence: ReplayWorkerMutationFence },
    operation: WorkerOperation,
    mutation: (
      client: PoolClient,
      scope: EvidenceScope,
      fence: ReplayWorkerMutationFence,
    ) => Promise<Result>,
  ): Promise<Result> {
    const scope = requireScope(command.scope);
    const fence = requireFence(command.workerFence);
    try {
      return await withTenantTransaction(this.pool, scope.tenantId, (client) =>
        mutation(client, scope, fence),
      );
    } catch (error) {
      mapPersistenceError(error, operation);
    }
  }
}
