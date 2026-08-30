import { isDeepStrictEqual } from "node:util";
import {
  type EvidenceScope,
  ReplayAttemptSchema,
  ReplayBudgetLedgerEntrySchema,
  ReplayCancellationAcknowledgementSchema,
  ReplayCancellationRequestSchema,
  ReplayExecutionObservationSchema,
  ReplayJobSchema,
  ReplayUsageObservationSchema,
  type ReplayWorkerMutationFence,
} from "@proofstack/contracts";
import {
  ReplayRepositoryContractError,
  type ReplayJobSnapshot,
  summarizeReplayBudgetLedger,
} from "@proofstack/replay";
import type { PoolClient, QueryResultRow } from "pg";

const SNAPSHOT_KEYS = [
  "attempts",
  "budgetLedger",
  "cancellationAcknowledgements",
  "cancellationRequest",
  "executionObservations",
  "job",
  "usageObservations",
] as const;

interface SnapshotRow extends QueryResultRow {
  readonly snapshot: unknown;
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

function scopesEqual(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

export function replayFencesEqual(
  left: ReplayWorkerMutationFence,
  right: ReplayWorkerMutationFence,
): boolean {
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

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    contractViolation(`PostgreSQL replay snapshot contains duplicate ${label}`);
  }
}

function requireExactSnapshotKeys(value: Readonly<Record<string, unknown>>): void {
  const keys = Object.keys(value).sort();
  if (!isDeepStrictEqual(keys, [...SNAPSHOT_KEYS].sort())) {
    contractViolation("PostgreSQL returned an invalid replay snapshot shape");
  }
}

export function parsePostgresReplayJobSnapshot(
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

    if (job.jobId !== expectedJobId || !scopesEqual(job.scope, expectedScope)) {
      contractViolation("PostgreSQL replay snapshot escaped its authorized scope");
    }
    requireUnique(
      attempts.map(({ attemptId }) => attemptId),
      "attempt identifiers",
    );
    requireUnique(
      attempts.map(({ mutationFence }) => mutationFence.leaseId),
      "lease identifiers",
    );
    if (
      attempts.some((attempt, index) => {
        const previous = attempts[index - 1];
        return (
          attempt.jobId !== job.jobId ||
          attempt.attemptSequence !== index ||
          !scopesEqual(attempt.scope, job.scope) ||
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
      if (
        !attempt ||
        !replayFencesEqual(attempt.mutationFence, fence) ||
        fence.jobId !== job.jobId
      ) {
        contractViolation("PostgreSQL replay history contains an unknown worker fence");
      }
      return attempt;
    };
    const latestAttempt = attempts.at(-1);
    if (job.currentLease) {
      requireKnownFence(job.currentLease.mutationFence);
      if (
        latestAttempt?.status !== "running" ||
        !replayFencesEqual(latestAttempt.mutationFence, job.currentLease.mutationFence)
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

    requireUnique(
      budgetLedger
        .filter((entry) => entry.entryType === "reservation")
        .map(({ reservationId }) => reservationId),
      "budget reservation identifiers",
    );
    requireUnique(
      budgetLedger
        .filter((entry) => entry.entryType === "reconciliation")
        .map(({ reconciliationId }) => reconciliationId),
      "budget reconciliation identifiers",
    );
    if (
      budgetLedger.some((entry, index) => {
        requireKnownFence(entry.mutationFence);
        return entry.ledgerSequence !== index || !scopesEqual(entry.scope, job.scope);
      })
    ) {
      contractViolation("PostgreSQL replay budget history is not contiguous");
    }
    try {
      summarizeReplayBudgetLedger(budgetLedger);
    } catch (error) {
      contractViolation("PostgreSQL replay budget history is internally inconsistent", error);
    }

    if (
      cancellationRequest &&
      (cancellationRequest.jobId !== job.jobId ||
        !scopesEqual(cancellationRequest.scope, job.scope) ||
        Date.parse(cancellationRequest.requestedAt) < Date.parse(job.createdAt))
    ) {
      contractViolation("PostgreSQL replay cancellation request escaped its job scope");
    }
    if (job.terminal?.code === "cancellation_committed" && !cancellationRequest) {
      contractViolation("PostgreSQL replay cancellation terminal has no exact request");
    }
    requireUnique(
      cancellationAcknowledgements.map(({ acknowledgementId }) => acknowledgementId),
      "cancellation acknowledgement identifiers",
    );
    for (const [index, acknowledgement] of cancellationAcknowledgements.entries()) {
      const attempt = requireKnownFence(acknowledgement.mutationFence);
      const previous = cancellationAcknowledgements[index - 1];
      if (
        !cancellationRequest ||
        acknowledgement.cancellationId !== cancellationRequest.cancellationId ||
        !scopesEqual(acknowledgement.scope, job.scope) ||
        Date.parse(acknowledgement.acknowledgedAt) < Date.parse(cancellationRequest.requestedAt) ||
        Date.parse(acknowledgement.acknowledgedAt) < Date.parse(attempt.startedAt) ||
        (previous !== undefined &&
          (previous.acknowledgedAt > acknowledgement.acknowledgedAt ||
            (previous.acknowledgedAt === acknowledgement.acknowledgedAt &&
              previous.acknowledgementId >= acknowledgement.acknowledgementId)))
      ) {
        contractViolation("PostgreSQL replay cancellation acknowledgement has no exact request");
      }
    }

    const observations = [...executionObservations, ...usageObservations];
    requireUnique(
      observations.map(({ observationId }) => observationId),
      "observation identifiers",
    );
    if (
      executionObservations.some(
        (observation, index) =>
          index > 0 &&
          (executionObservations[index - 1]?.observationSequence ?? -1) >=
            observation.observationSequence,
      ) ||
      usageObservations.some(
        (observation, index) =>
          index > 0 &&
          (usageObservations[index - 1]?.observationSequence ?? -1) >=
            observation.observationSequence,
      )
    ) {
      contractViolation("PostgreSQL replay observation lists are not ordered");
    }
    observations.sort((left, right) => left.observationSequence - right.observationSequence);
    if (
      observations.some((observation, index) => {
        const attempt = requireKnownFence(observation.mutationFence);
        return (
          observation.observationSequence !== index ||
          !scopesEqual(observation.scope, job.scope) ||
          Date.parse(observation.observedAt) < Date.parse(attempt.startedAt)
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

function requireOneRow<Row extends QueryResultRow>(rows: readonly Row[], label: string): Row {
  const row = rows[0];
  if (rows.length !== 1 || !row) contractViolation(`PostgreSQL returned an invalid ${label}`);
  return row;
}

export async function loadPostgresReplayJobSnapshot(
  client: PoolClient,
  scope: EvidenceScope,
  jobId: string,
): Promise<ReplayJobSnapshot | null> {
  const result = await client.query<SnapshotRow>(
    "SELECT public.proofstack_read_replay_job_snapshot($1, $2, $3) AS snapshot",
    [scope.projectId, scope.environmentId, jobId],
  );
  const row = requireOneRow(result.rows, "replay snapshot result");
  return row.snapshot === null ? null : parsePostgresReplayJobSnapshot(row.snapshot, scope, jobId);
}

export async function requirePostgresReplayJobSnapshot(
  client: PoolClient,
  scope: EvidenceScope,
  jobId: string,
): Promise<ReplayJobSnapshot> {
  const snapshot = await loadPostgresReplayJobSnapshot(client, scope, jobId);
  if (!snapshot) contractViolation("A successful replay mutation returned no durable snapshot");
  return snapshot;
}
