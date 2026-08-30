import { z } from "zod";
import type { EvidenceScope } from "./evidence.js";
import {
  MAX_REPLAY_ACCOUNTING_VALUE,
  REPLAY_BUDGET_DIMENSIONS,
  type ReplayBudgetDimension,
  type ReplayBudgetLedgerEntry,
  ReplayBudgetLedgerEntrySchema,
  ReplayExecutionObservationSchema,
  ReplayUsageObservationSchema,
} from "./replay-accounting.js";
import {
  type ReplayAttempt,
  ReplayAttemptSchema,
  ReplayCancellationAcknowledgementSchema,
  ReplayCancellationRequestSchema,
  type ReplayJob,
  ReplayJobSchema,
  type ReplayPlanJobReference,
  type ReplayWorkerMutationFence,
} from "./replay-job.js";

function scopesEqual(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function plansEqual(left: ReplayPlanJobReference, right: ReplayPlanJobReference): boolean {
  return (
    left.planId === right.planId &&
    left.planVersionId === right.planVersionId &&
    left.definitionSha256 === right.definitionSha256
  );
}

function fencesEqual(left: ReplayWorkerMutationFence, right: ReplayWorkerMutationFence): boolean {
  return (
    left.jobId === right.jobId &&
    left.attemptId === right.attemptId &&
    left.leaseId === right.leaseId &&
    left.workerId === right.workerId &&
    left.fencingToken === right.fencingToken &&
    left.recoveryEpoch === right.recoveryEpoch
  );
}

function addIssue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: "custom", message, path });
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function validateAttempts(
  job: ReplayJob,
  attempts: readonly ReplayAttempt[],
  context: z.RefinementCtx,
): ReadonlyMap<string, ReplayAttempt> | undefined {
  if (
    !unique(attempts.map(({ attemptId }) => attemptId)) ||
    !unique(attempts.map(({ mutationFence }) => mutationFence.leaseId))
  ) {
    addIssue(context, ["attempts"], "Replay attempt and lease identifiers must be unique");
    return undefined;
  }

  const invalidAttempt = attempts.find((attempt, index) => {
    const previous = attempts[index - 1];
    return (
      attempt.jobId !== job.jobId ||
      attempt.attemptSequence !== index ||
      !scopesEqual(attempt.scope, job.scope) ||
      !plansEqual(attempt.plan, job.plan) ||
      attempt.mutationFence.recoveryEpoch > job.recoveryEpoch ||
      attempt.mutationFence.fencingToken > job.lastFencingToken ||
      (previous !== undefined &&
        (attempt.mutationFence.fencingToken <= previous.mutationFence.fencingToken ||
          attempt.mutationFence.recoveryEpoch < previous.mutationFence.recoveryEpoch))
    );
  });
  const latestAttempt = attempts.at(-1);
  const rootDisagrees =
    attempts.length === 0
      ? job.latestAttemptSequence !== undefined
      : job.latestAttemptSequence !== attempts.length - 1 ||
        latestAttempt?.mutationFence.fencingToken !== job.lastFencingToken;
  if (invalidAttempt || rootDisagrees) {
    addIssue(
      context,
      ["attempts"],
      "Replay attempt history must be contiguous and agree with the job root",
    );
    return undefined;
  }

  const attemptsById = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));
  const knownFence = (fence: ReplayWorkerMutationFence): ReplayAttempt | undefined => {
    const attempt = attemptsById.get(fence.attemptId);
    return attempt && fencesEqual(attempt.mutationFence, fence) && fence.jobId === job.jobId
      ? attempt
      : undefined;
  };
  if (
    job.currentLease &&
    (knownFence(job.currentLease.mutationFence) === undefined ||
      latestAttempt?.status !== "running" ||
      !fencesEqual(latestAttempt.mutationFence, job.currentLease.mutationFence))
  ) {
    addIssue(context, ["job", "currentLease"], "The current lease must own the latest attempt");
    return undefined;
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
      addIssue(context, ["job", "terminal"], "The terminal record must close the latest attempt");
      return undefined;
    }
  }
  return attemptsById;
}

function validateBudgetLedger(
  job: ReplayJob,
  attemptsById: ReadonlyMap<string, ReplayAttempt>,
  entries: readonly ReplayBudgetLedgerEntry[],
  context: z.RefinementCtx,
): void {
  const committed = new Map<ReplayBudgetDimension, number>(
    REPLAY_BUDGET_DIMENSIONS.map((dimension) => [dimension, 0]),
  );
  const reservations = new Map<
    string,
    Extract<ReplayBudgetLedgerEntry, { entryType: "reservation" }>
  >();
  const reconciliationIds = new Set<string>();
  const reconciledReservations = new Set<string>();

  for (const [index, entry] of entries.entries()) {
    const attempt = attemptsById.get(entry.mutationFence.attemptId);
    if (
      entry.ledgerSequence !== index ||
      !scopesEqual(entry.scope, job.scope) ||
      !attempt ||
      !fencesEqual(attempt.mutationFence, entry.mutationFence)
    ) {
      addIssue(
        context,
        ["budgetLedger", index],
        "Replay budget history must be contiguous, scoped, and fenced",
      );
      return;
    }

    if (entry.entryType === "reservation") {
      if (reservations.has(entry.reservationId)) {
        addIssue(context, ["budgetLedger", index], "Budget reservation identifiers must be unique");
        return;
      }
      for (const dimension of REPLAY_BUDGET_DIMENSIONS) {
        const current = committed.get(dimension) ?? 0;
        const value = entry.dimensions[dimension];
        const next = current + value.reservedAmount;
        if (value.committedBefore !== current || next > MAX_REPLAY_ACCOUNTING_VALUE) {
          addIssue(
            context,
            ["budgetLedger", index, "dimensions", dimension],
            "Budget reservation must extend the exact committed total without overflow",
          );
          return;
        }
        committed.set(dimension, next);
      }
      reservations.set(entry.reservationId, entry);
      continue;
    }

    const reservation = reservations.get(entry.reservationId);
    if (
      !reservation ||
      reconciliationIds.has(entry.reconciliationId) ||
      reconciledReservations.has(entry.reservationId) ||
      !scopesEqual(entry.scope, reservation.scope) ||
      !fencesEqual(entry.mutationFence, reservation.mutationFence)
    ) {
      addIssue(
        context,
        ["budgetLedger", index],
        "Budget reconciliation must close one exact open reservation",
      );
      return;
    }
    for (const dimension of REPLAY_BUDGET_DIMENSIONS) {
      const current = committed.get(dimension) ?? 0;
      const value = entry.dimensions[dimension];
      const reservedAmount = reservation.dimensions[dimension].reservedAmount;
      const next = current - value.releasedAmount + value.overrunAmount;
      if (
        value.reservedAmount !== reservedAmount ||
        current < value.releasedAmount ||
        !Number.isSafeInteger(next) ||
        next > MAX_REPLAY_ACCOUNTING_VALUE
      ) {
        addIssue(
          context,
          ["budgetLedger", index, "dimensions", dimension],
          "Budget reconciliation must preserve exact reserved and committed totals",
        );
        return;
      }
      committed.set(dimension, next);
    }
    reconciliationIds.add(entry.reconciliationId);
    reconciledReservations.add(entry.reservationId);
  }
}

const replayJobSnapshotShape = {
  attempts: z.array(ReplayAttemptSchema),
  budgetLedger: z.array(ReplayBudgetLedgerEntrySchema),
  cancellationAcknowledgements: z.array(ReplayCancellationAcknowledgementSchema),
  cancellationRequest: ReplayCancellationRequestSchema.nullable(),
  executionObservations: z.array(ReplayExecutionObservationSchema),
  job: ReplayJobSchema,
  usageObservations: z.array(ReplayUsageObservationSchema),
};

export const ReplayJobSnapshotSchema = z
  .object(replayJobSnapshotShape)
  .strict()
  .superRefine((value, context) => {
    const attemptsById = validateAttempts(value.job, value.attempts, context);
    if (!attemptsById) return;

    validateBudgetLedger(value.job, attemptsById, value.budgetLedger, context);

    const cancellation = value.cancellationRequest;
    if (
      cancellation &&
      (cancellation.jobId !== value.job.jobId ||
        !scopesEqual(cancellation.scope, value.job.scope) ||
        Date.parse(cancellation.requestedAt) < Date.parse(value.job.createdAt))
    ) {
      addIssue(
        context,
        ["cancellationRequest"],
        "Cancellation must belong to the job and cannot precede its creation",
      );
    }
    if (value.job.terminal?.code === "cancellation_committed" && !cancellation) {
      addIssue(
        context,
        ["cancellationRequest"],
        "A cancelled job must retain its exact cancellation request",
      );
    }

    if (
      !unique(value.cancellationAcknowledgements.map(({ acknowledgementId }) => acknowledgementId))
    ) {
      addIssue(
        context,
        ["cancellationAcknowledgements"],
        "Cancellation acknowledgement identifiers must be unique",
      );
    }
    for (const [index, acknowledgement] of value.cancellationAcknowledgements.entries()) {
      const attempt = attemptsById.get(acknowledgement.mutationFence.attemptId);
      const previous = value.cancellationAcknowledgements[index - 1];
      if (
        !cancellation ||
        acknowledgement.cancellationId !== cancellation.cancellationId ||
        !attempt ||
        !fencesEqual(attempt.mutationFence, acknowledgement.mutationFence) ||
        !scopesEqual(acknowledgement.scope, value.job.scope) ||
        Date.parse(acknowledgement.acknowledgedAt) < Date.parse(cancellation.requestedAt) ||
        Date.parse(acknowledgement.acknowledgedAt) < Date.parse(attempt.startedAt) ||
        (previous !== undefined &&
          (previous.acknowledgedAt > acknowledgement.acknowledgedAt ||
            (previous.acknowledgedAt === acknowledgement.acknowledgedAt &&
              previous.acknowledgementId >= acknowledgement.acknowledgementId)))
      ) {
        addIssue(
          context,
          ["cancellationAcknowledgements", index],
          "Cancellation acknowledgement must match the exact request, fence, scope, and order",
        );
      }
    }

    const observations = [...value.executionObservations, ...value.usageObservations];
    if (!unique(observations.map(({ observationId }) => observationId))) {
      addIssue(context, ["executionObservations"], "Observation identifiers must be unique");
    }
    if (
      value.executionObservations.some(
        (observation, index) =>
          index > 0 &&
          (value.executionObservations[index - 1]?.observationSequence ?? -1) >=
            observation.observationSequence,
      ) ||
      value.usageObservations.some(
        (observation, index) =>
          index > 0 &&
          (value.usageObservations[index - 1]?.observationSequence ?? -1) >=
            observation.observationSequence,
      )
    ) {
      addIssue(context, ["executionObservations"], "Observation lists must be strictly ordered");
    }
    observations.sort((left, right) => left.observationSequence - right.observationSequence);
    for (const [index, observation] of observations.entries()) {
      const attempt = attemptsById.get(observation.mutationFence.attemptId);
      if (
        observation.observationSequence !== index ||
        !attempt ||
        !fencesEqual(attempt.mutationFence, observation.mutationFence) ||
        !scopesEqual(observation.scope, value.job.scope) ||
        Date.parse(observation.observedAt) < Date.parse(attempt.startedAt)
      ) {
        addIssue(
          context,
          ["executionObservations"],
          "Observation history must be contiguous, scoped, fenced, and causally ordered",
        );
        break;
      }
    }
    for (const [index, observation] of value.executionObservations.entries()) {
      if (
        observation.payload.kind === "cancellation" &&
        observation.payload.cancellationId !== cancellation?.cancellationId
      ) {
        addIssue(
          context,
          ["executionObservations", index, "payload", "cancellationId"],
          "Cancellation observations must name the exact durable request",
        );
      }
    }
  });

export type ReplayJobSnapshot = z.infer<typeof ReplayJobSnapshotSchema>;
