import { createHash } from "node:crypto";
import {
  EvidenceScopeSchema,
  type ReplayBudgetDimension,
  REPLAY_BUDGET_DIMENSIONS,
  type ReplayBudgetReservation,
  type ReplayExecutionObservationPayload,
  ReplayWorkerMutationFenceSchema,
} from "@proofstack/contracts";
import {
  type ReplayBudgetAmounts,
  type ReplayJobSnapshot,
  type ReplayJobWorkerRepository,
  type ReplayUsageMeasurements,
  summarizeReplayBudgetLedger,
  validateAndProjectReplayPlan,
} from "@proofstack/replay";
import { ReplayAttemptAccountingError } from "./errors.js";

const ATTEMPT_ACCOUNTING_NAMESPACE = "proofstack.replay-attempt-accounting.v1";

export interface ReserveReplayAttemptBudgetOptions {
  readonly leaseDurationMilliseconds: number;
  readonly plan: unknown;
  readonly repository: ReplayJobWorkerRepository;
  readonly scope: unknown;
  readonly snapshot: ReplayJobSnapshot;
  readonly workerFence: unknown;
}

export interface ReservedReplayAttemptBudget {
  readonly reservationId: string;
  readonly requested: ReplayBudgetAmounts;
  readonly snapshot: ReplayJobSnapshot;
}

export interface ReplayAttemptUsageInput {
  readonly elapsedMilliseconds: number;
  readonly emittedArtifactBytes: number;
  readonly executionObservations: readonly ReplayExecutionObservationPayload[];
}

export interface ReconcileReplayAttemptBudgetOptions {
  readonly actual: unknown;
  readonly leaseDurationMilliseconds: number;
  readonly plan: unknown;
  readonly repository: ReplayJobWorkerRepository;
  readonly reservationId: string;
  readonly scope: unknown;
  readonly workerFence: unknown;
}

function stableId(
  prefix: "obs" | "rec" | "rsv",
  workerFence: ReturnType<typeof ReplayWorkerMutationFenceSchema.parse>,
  purpose: string,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        attemptId: workerFence.attemptId,
        fencingToken: workerFence.fencingToken,
        namespace: ATTEMPT_ACCOUNTING_NAMESPACE,
        purpose,
      }),
      "utf8",
    )
    .digest("hex");
  return `${prefix}_${digest.slice(0, 40)}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mapBudgetAmounts(map: (dimension: ReplayBudgetDimension) => number): ReplayBudgetAmounts {
  return Object.fromEntries(
    REPLAY_BUDGET_DIMENSIONS.map((dimension) => [dimension, map(dimension)]),
  ) as ReplayBudgetAmounts;
}

function parseActualUsage(input: unknown): ReplayBudgetAmounts {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ReplayAttemptAccountingError("invalid_usage");
  }
  const values = input as Readonly<Record<string, unknown>>;
  const keys = Object.keys(values);
  if (
    keys.length !== REPLAY_BUDGET_DIMENSIONS.length ||
    keys.some((key) => !REPLAY_BUDGET_DIMENSIONS.includes(key as ReplayBudgetDimension))
  ) {
    throw new ReplayAttemptAccountingError("invalid_usage");
  }
  return mapBudgetAmounts((dimension) => {
    const value = values[dimension];
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new ReplayAttemptAccountingError("invalid_usage");
    }
    return value as number;
  });
}

function parseContext(options: {
  readonly plan: unknown;
  readonly scope: unknown;
  readonly workerFence: unknown;
}): {
  readonly plan: ReturnType<typeof validateAndProjectReplayPlan>["plan"];
  readonly scope: ReturnType<typeof EvidenceScopeSchema.parse>;
  readonly workerFence: ReturnType<typeof ReplayWorkerMutationFenceSchema.parse>;
} {
  try {
    const plan = validateAndProjectReplayPlan(options.plan).plan;
    const scope = EvidenceScopeSchema.parse(options.scope);
    const workerFence = ReplayWorkerMutationFenceSchema.parse(options.workerFence);
    if (!sameJson(plan.scope, scope)) {
      throw new TypeError("Plan and attempt scopes differ");
    }
    return { plan, scope, workerFence };
  } catch (error) {
    throw new ReplayAttemptAccountingError("invalid_accounting_context", { cause: error });
  }
}

function validateSnapshot(
  snapshot: ReplayJobSnapshot,
  context: ReturnType<typeof parseContext>,
): void {
  const planReference = {
    definitionSha256: context.plan.definitionSha256,
    planId: context.plan.planId,
    planVersionId: context.plan.planVersionId,
  };
  if (
    snapshot.job.jobId !== context.workerFence.jobId ||
    !sameJson(snapshot.job.scope, context.scope) ||
    !sameJson(snapshot.job.plan, planReference) ||
    !sameJson(snapshot.job.currentLease?.mutationFence, context.workerFence)
  ) {
    throw new ReplayAttemptAccountingError("invalid_accounting_context");
  }
}

function validateLeaseDuration(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ReplayAttemptAccountingError("invalid_lease_policy");
  }
}

function reservationAmounts(
  snapshot: ReplayJobSnapshot,
  context: ReturnType<typeof parseContext>,
): ReplayBudgetAmounts {
  let summary: ReturnType<typeof summarizeReplayBudgetLedger>;
  try {
    summary = summarizeReplayBudgetLedger(snapshot.budgetLedger);
  } catch (error) {
    throw new ReplayAttemptAccountingError("invalid_accounting_context", { cause: error });
  }
  const remaining = mapBudgetAmounts(
    (dimension) => context.plan.budget[dimension].limit - summary.committed[dimension],
  );
  if (REPLAY_BUDGET_DIMENSIONS.some((dimension) => remaining[dimension] < 1)) {
    throw new ReplayAttemptAccountingError("budget_exhausted_before_attempt");
  }
  return remaining;
}

function amountsFromExistingReservation(
  snapshot: ReplayJobSnapshot,
  reservationId: string,
  context: ReturnType<typeof parseContext>,
): ReplayBudgetAmounts | null {
  const existing = snapshot.budgetLedger.find(
    (entry): entry is ReplayBudgetReservation =>
      entry.entryType === "reservation" && entry.reservationId === reservationId,
  );
  if (!existing) return null;
  if (
    !sameJson(existing.mutationFence, context.workerFence) ||
    !sameJson(existing.scope, context.scope) ||
    !sameJson(existing.work, { kind: "attempt_start" })
  ) {
    throw new ReplayAttemptAccountingError("invalid_accounting_context");
  }
  return mapBudgetAmounts((dimension) => existing.dimensions[dimension].reservedAmount);
}

export async function reserveReplayAttemptBudget(
  options: ReserveReplayAttemptBudgetOptions,
): Promise<ReservedReplayAttemptBudget> {
  const context = parseContext(options);
  validateLeaseDuration(
    options.leaseDurationMilliseconds,
    context.plan.retryPolicy.perAttemptTimeoutMilliseconds,
  );
  validateSnapshot(options.snapshot, context);
  const reservationId = stableId("rsv", context.workerFence, "attempt-start");
  const requested =
    amountsFromExistingReservation(options.snapshot, reservationId, context) ??
    reservationAmounts(options.snapshot, context);
  await options.repository.heartbeatJob({
    leaseDurationMilliseconds: options.leaseDurationMilliseconds,
    scope: context.scope,
    workerFence: context.workerFence,
  });
  const snapshot = await options.repository.reserveBudget({
    requested,
    reservationId,
    scope: context.scope,
    work: { kind: "attempt_start" },
    workerFence: context.workerFence,
  });
  return Object.freeze({ requested, reservationId, snapshot });
}

export function measureRecordedStubAttemptUsage(
  input: ReplayAttemptUsageInput,
): ReplayBudgetAmounts {
  if (
    !Number.isSafeInteger(input.elapsedMilliseconds) ||
    input.elapsedMilliseconds < 0 ||
    !Number.isSafeInteger(input.emittedArtifactBytes) ||
    input.emittedArtifactBytes < 0
  ) {
    throw new ReplayAttemptAccountingError("invalid_usage");
  }
  let modelRequests = 0;
  let toolCalls = 0;
  for (const observation of input.executionObservations) {
    if (observation.kind !== "boundary" || observation.phase !== "request_started") continue;
    if (observation.boundaryKind === "model") modelRequests += 1;
    if (observation.boundaryKind === "tool") toolCalls += 1;
  }
  return Object.freeze({
    concurrentInteractions: modelRequests + toolCalls === 0 ? 0 : 1,
    elapsedMilliseconds: input.elapsedMilliseconds,
    emittedArtifactBytes: input.emittedArtifactBytes,
    inputTokens: 0,
    jobAttempts: 1,
    modelRequests,
    outputTokens: 0,
    providerCostMicrounits: 0,
    retrievedBytes: 0,
    toolCalls,
  });
}

function usageMeasurements(
  actual: ReplayBudgetAmounts,
  context: ReturnType<typeof parseContext>,
): ReplayUsageMeasurements {
  return Object.fromEntries(
    REPLAY_BUDGET_DIMENSIONS.map((dimension) => {
      const measurement = context.plan.budget[dimension].measurement;
      return [
        dimension,
        measurement === "unavailable"
          ? { reason: "source_unavailable" as const, status: "unavailable" as const }
          : { amount: actual[dimension], source: measurement, status: "observed" as const },
      ];
    }),
  ) as ReplayUsageMeasurements;
}

export async function reconcileReplayAttemptBudget(
  options: ReconcileReplayAttemptBudgetOptions,
): Promise<ReplayJobSnapshot> {
  const context = parseContext(options);
  validateLeaseDuration(
    options.leaseDurationMilliseconds,
    context.plan.retryPolicy.perAttemptTimeoutMilliseconds,
  );
  if (options.reservationId !== stableId("rsv", context.workerFence, "attempt-start")) {
    throw new ReplayAttemptAccountingError("invalid_accounting_context");
  }
  const actual = parseActualUsage(options.actual);
  const usage = usageMeasurements(actual, context);
  const observationId = stableId("obs", context.workerFence, "attempt-usage");
  const reconciliationId = stableId("rec", context.workerFence, "attempt-reconciliation");
  const sourceEventSha256 = createHash("sha256")
    .update(
      JSON.stringify({
        actual,
        namespace: ATTEMPT_ACCOUNTING_NAMESPACE,
        reservationId: options.reservationId,
      }),
      "utf8",
    )
    .digest("hex");
  await options.repository.heartbeatJob({
    leaseDurationMilliseconds: options.leaseDurationMilliseconds,
    scope: context.scope,
    workerFence: context.workerFence,
  });
  await options.repository.appendUsageObservation({
    measurements: REPLAY_BUDGET_DIMENSIONS.map((dimension) => ({
      dimension,
      usage: usage[dimension],
    })),
    observationId,
    scope: context.scope,
    sourceEventSha256,
    workerFence: context.workerFence,
  });
  await options.repository.heartbeatJob({
    leaseDurationMilliseconds: options.leaseDurationMilliseconds,
    scope: context.scope,
    workerFence: context.workerFence,
  });
  return await options.repository.reconcileBudget({
    reconciliationId,
    reservationId: options.reservationId,
    scope: context.scope,
    usage,
    workerFence: context.workerFence,
  });
}
