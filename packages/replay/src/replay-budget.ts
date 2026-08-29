import {
  type EvidenceScope,
  MAX_REPLAY_ACCOUNTING_VALUE,
  REPLAY_ACCOUNTING_SCHEMA_VERSION,
  REPLAY_BUDGET_DIMENSIONS,
  type ReplayBudget,
  type ReplayBudgetDimension,
  type ReplayBudgetLedgerEntry,
  ReplayBudgetLedgerEntrySchema,
  type ReplayBudgetReconciliation,
  ReplayBudgetReconciliationSchema,
  type ReplayBudgetReservation,
  ReplayBudgetReservationSchema,
  ReplayBudgetSchema,
  type ReplayBudgetWorkReference,
  type ReplayUsageMeasurement,
  ReplayUsageMeasurementSchema,
  type ReplayWorkerMutationFence,
} from "@proofstack/contracts";
import { DurableReplayAccountingError } from "./errors.js";

export type ReplayBudgetAmounts = Readonly<Record<ReplayBudgetDimension, number>>;
export type ReplayUsageMeasurements = Readonly<
  Record<ReplayBudgetDimension, ReplayUsageMeasurement>
>;

export interface ReserveReplayBudgetOptions {
  readonly budget: ReplayBudget;
  readonly committed: ReplayBudgetAmounts;
  readonly ledgerSequence: number;
  readonly mutationFence: ReplayWorkerMutationFence;
  readonly requested: ReplayBudgetAmounts;
  readonly reservationId: string;
  readonly reservedAt: string;
  readonly scope: EvidenceScope;
  readonly work: ReplayBudgetWorkReference;
}

export interface ReconcileReplayBudgetOptions {
  readonly ledgerSequence: number;
  readonly reconciledAt: string;
  readonly reconciliationId: string;
  readonly usage: ReplayUsageMeasurements;
}

export interface ReplayBudgetLedgerSummary {
  readonly committed: ReplayBudgetAmounts;
  readonly disputed: readonly string[];
  readonly openReservationIds: readonly string[];
  readonly overruns: readonly string[];
  readonly reconciliationCount: number;
  readonly reservationCount: number;
}

function mapDimensions<T>(
  map: (dimension: ReplayBudgetDimension) => T,
): Record<ReplayBudgetDimension, T> {
  return Object.fromEntries(
    REPLAY_BUDGET_DIMENSIONS.map((dimension) => [dimension, map(dimension)]),
  ) as Record<ReplayBudgetDimension, T>;
}

function parseAmounts(input: unknown): ReplayBudgetAmounts {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new DurableReplayAccountingError("invalid_amounts");
  }
  const values = input as Readonly<Record<string, unknown>>;
  const keys = Object.keys(values);
  if (
    keys.length !== REPLAY_BUDGET_DIMENSIONS.length ||
    keys.some((key) => !REPLAY_BUDGET_DIMENSIONS.includes(key as ReplayBudgetDimension))
  ) {
    throw new DurableReplayAccountingError("invalid_amounts");
  }
  return mapDimensions((dimension) => {
    const value = values[dimension];
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new DurableReplayAccountingError("invalid_amounts");
    }
    return value as number;
  });
}

function parseUsage(input: unknown): ReplayUsageMeasurements {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new DurableReplayAccountingError("invalid_usage");
  }
  const values = input as Readonly<Record<string, unknown>>;
  const keys = Object.keys(values);
  if (
    keys.length !== REPLAY_BUDGET_DIMENSIONS.length ||
    keys.some((key) => !REPLAY_BUDGET_DIMENSIONS.includes(key as ReplayBudgetDimension))
  ) {
    throw new DurableReplayAccountingError("invalid_usage");
  }
  return mapDimensions((dimension) => {
    const parsed = ReplayUsageMeasurementSchema.safeParse(values[dimension]);
    if (!parsed.success) throw new DurableReplayAccountingError("invalid_usage");
    return parsed.data;
  });
}

function checkedAdd(left: number, right: number): number {
  if (right > MAX_REPLAY_ACCOUNTING_VALUE - left) {
    throw new DurableReplayAccountingError("arithmetic_overflow");
  }
  return left + right;
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

export function emptyReplayBudgetAmounts(): ReplayBudgetAmounts {
  return mapDimensions(() => 0);
}

export function reserveReplayBudget(options: ReserveReplayBudgetOptions): ReplayBudgetReservation {
  const parsedBudget = ReplayBudgetSchema.safeParse(options.budget);
  if (!parsedBudget.success) throw new DurableReplayAccountingError("invalid_budget");
  const budget = parsedBudget.data;
  const committed = parseAmounts(options.committed);
  const requested = parseAmounts(options.requested);
  return ReplayBudgetReservationSchema.parse({
    dimensions: mapDimensions((dimension) => ({
      committedBefore: committed[dimension],
      limit: budget[dimension].limit,
      measurement: budget[dimension].measurement,
      reservedAmount: requested[dimension],
    })),
    entryType: "reservation",
    ledgerSequence: options.ledgerSequence,
    mutationFence: options.mutationFence,
    reservationId: options.reservationId,
    reservedAt: options.reservedAt,
    schemaVersion: REPLAY_ACCOUNTING_SCHEMA_VERSION,
    scope: options.scope,
    work: options.work,
  });
}

export function applyReplayBudgetReservation(
  committedInput: ReplayBudgetAmounts,
  reservationInput: ReplayBudgetReservation,
): ReplayBudgetAmounts {
  const committed = parseAmounts(committedInput);
  const reservation = ReplayBudgetReservationSchema.parse(reservationInput);
  return mapDimensions((dimension) => {
    const entry = reservation.dimensions[dimension];
    if (entry.committedBefore !== committed[dimension]) {
      throw new DurableReplayAccountingError("accounting_conflict");
    }
    return checkedAdd(committed[dimension], entry.reservedAmount);
  });
}

export function reconcileReplayBudget(
  reservationInput: ReplayBudgetReservation,
  options: ReconcileReplayBudgetOptions,
): ReplayBudgetReconciliation {
  const reservation = ReplayBudgetReservationSchema.parse(reservationInput);
  const usage = parseUsage(options.usage);
  return ReplayBudgetReconciliationSchema.parse({
    dimensions: mapDimensions((dimension) => {
      const reservedAmount = reservation.dimensions[dimension].reservedAmount;
      const actualUsage = usage[dimension];
      if (actualUsage.status === "unavailable") {
        return {
          actualUsage,
          disposition: "disputed",
          overrunAmount: 0,
          releasedAmount: 0,
          reservedAmount,
        };
      }
      if (actualUsage.amount <= reservedAmount) {
        return {
          actualUsage,
          disposition: "settled",
          overrunAmount: 0,
          releasedAmount: reservedAmount - actualUsage.amount,
          reservedAmount,
        };
      }
      return {
        actualUsage,
        disposition: "overrun",
        overrunAmount: actualUsage.amount - reservedAmount,
        releasedAmount: 0,
        reservedAmount,
      };
    }),
    entryType: "reconciliation",
    ledgerSequence: options.ledgerSequence,
    mutationFence: reservation.mutationFence,
    reconciledAt: options.reconciledAt,
    reconciliationId: options.reconciliationId,
    reservationId: reservation.reservationId,
    schemaVersion: REPLAY_ACCOUNTING_SCHEMA_VERSION,
    scope: reservation.scope,
  });
}

export function applyReplayBudgetReconciliation(
  committedInput: ReplayBudgetAmounts,
  reservationInput: ReplayBudgetReservation,
  reconciliationInput: ReplayBudgetReconciliation,
): ReplayBudgetAmounts {
  const committed = parseAmounts(committedInput);
  const reservation = ReplayBudgetReservationSchema.parse(reservationInput);
  const reconciliation = ReplayBudgetReconciliationSchema.parse(reconciliationInput);
  if (
    reconciliation.reservationId !== reservation.reservationId ||
    reconciliation.ledgerSequence <= reservation.ledgerSequence ||
    !sameScope(reconciliation.scope, reservation.scope) ||
    !sameFence(reconciliation.mutationFence, reservation.mutationFence)
  ) {
    throw new DurableReplayAccountingError("accounting_conflict");
  }
  return mapDimensions((dimension) => {
    const reservedAmount = reservation.dimensions[dimension].reservedAmount;
    const reconciled = reconciliation.dimensions[dimension];
    if (
      reconciled.reservedAmount !== reservedAmount ||
      committed[dimension] < reconciled.releasedAmount
    ) {
      throw new DurableReplayAccountingError("accounting_conflict");
    }
    return checkedAdd(committed[dimension] - reconciled.releasedAmount, reconciled.overrunAmount);
  });
}

export function summarizeReplayBudgetLedger(
  entriesInput: readonly ReplayBudgetLedgerEntry[],
): ReplayBudgetLedgerSummary {
  let committed = emptyReplayBudgetAmounts();
  const reservations = new Map<string, ReplayBudgetReservation>();
  const reconciledReservations = new Set<string>();
  const disputed: string[] = [];
  const overruns: string[] = [];
  let reconciliationCount = 0;

  for (const [index, input] of entriesInput.entries()) {
    const entry = ReplayBudgetLedgerEntrySchema.parse(input);
    if (entry.ledgerSequence !== index) {
      throw new DurableReplayAccountingError("ledger_order");
    }
    if (entry.entryType === "reservation") {
      if (reservations.has(entry.reservationId)) {
        throw new DurableReplayAccountingError("duplicate_entry");
      }
      committed = applyReplayBudgetReservation(committed, entry);
      reservations.set(entry.reservationId, entry);
      continue;
    }

    const reservation = reservations.get(entry.reservationId);
    if (!reservation) throw new DurableReplayAccountingError("missing_reservation");
    if (reconciledReservations.has(entry.reservationId)) {
      throw new DurableReplayAccountingError("duplicate_entry");
    }
    committed = applyReplayBudgetReconciliation(committed, reservation, entry);
    reconciledReservations.add(entry.reservationId);
    reconciliationCount += 1;
    for (const dimension of REPLAY_BUDGET_DIMENSIONS) {
      const disposition = entry.dimensions[dimension].disposition;
      if (disposition === "disputed") disputed.push(`${entry.reservationId}:${dimension}`);
      if (disposition === "overrun") overruns.push(`${entry.reservationId}:${dimension}`);
    }
  }

  return {
    committed,
    disputed,
    openReservationIds: [...reservations.keys()].filter(
      (reservationId) => !reconciledReservations.has(reservationId),
    ),
    overruns,
    reconciliationCount,
    reservationCount: reservations.size,
  };
}
