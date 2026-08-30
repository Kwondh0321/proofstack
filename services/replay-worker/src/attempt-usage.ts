import {
  MAX_REPLAY_ACCOUNTING_VALUE,
  type ReplayBoundaryExecutionResult,
  ReplayBoundaryExecutionResultSchema,
  type ReplayBudgetDimension,
  type ReplayExecutionObservationPayload,
  ReplayExecutionObservationPayloadSchema,
  type ReplayUsageMeasurement,
} from "@proofstack/contracts";
import type { ReplayUsageMeasurements } from "@proofstack/replay";
import { ReplayAttemptAccountingError } from "./errors.js";

export interface MeasureReplayAttemptUsageOptions {
  readonly boundaryResults: readonly unknown[];
  readonly elapsedMilliseconds: number;
  readonly emittedArtifactBytes: number;
  readonly executionObservations: readonly unknown[];
}

type BoundaryUsageDimension = "inputTokens" | "outputTokens" | "providerCostMicrounits";
type BoundaryObservation = Extract<
  ReplayExecutionObservationPayload,
  { readonly kind: "boundary" }
>;

function fail(): never {
  throw new ReplayAttemptAccountingError("invalid_usage_evidence");
}

function safeNonnegativeInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) fail();
  return input as number;
}

function checkedAdd(left: number, right: number): number {
  if (right > MAX_REPLAY_ACCOUNTING_VALUE - left) {
    throw new ReplayAttemptAccountingError("arithmetic_overflow");
  }
  return left + right;
}

function measured(amount: number): ReplayUsageMeasurement {
  return Object.freeze({ amount, source: "measured", status: "observed" });
}

function unavailable(
  reason: Extract<ReplayUsageMeasurement, { readonly status: "unavailable" }>["reason"],
): ReplayUsageMeasurement {
  return Object.freeze({ reason, status: "unavailable" });
}

function parseResults(input: readonly unknown[]): readonly ReplayBoundaryExecutionResult[] {
  try {
    return Object.freeze(
      input.map((candidate) => ReplayBoundaryExecutionResultSchema.parse(candidate)),
    );
  } catch {
    return fail();
  }
}

function parseObservations(
  input: readonly unknown[],
): readonly ReplayExecutionObservationPayload[] {
  try {
    return Object.freeze(
      input.map((candidate) => ReplayExecutionObservationPayloadSchema.parse(candidate)),
    );
  } catch {
    return fail();
  }
}

function matchesResult(observation: BoundaryObservation, result: ReplayBoundaryExecutionResult) {
  return (
    observation.phase === "response_observed" &&
    observation.boundaryId === result.boundaryId &&
    observation.boundaryKind === result.actualRequest.kind &&
    observation.effectCertainty === result.effectCertainty &&
    observation.executionOrigin === result.executionOrigin &&
    observation.mode === result.mode
  );
}

function observationKey(observation: BoundaryObservation): string {
  return JSON.stringify([
    observation.boundaryId,
    observation.boundaryKind,
    observation.mode,
    observation.executionOrigin,
  ]);
}

function validateBoundaryLifecycle(observations: readonly BoundaryObservation[]): void {
  let pending: string | undefined;
  for (const observation of observations) {
    const key = observationKey(observation);
    if (observation.phase === "request_started") {
      if (pending !== undefined) fail();
      pending = key;
      continue;
    }
    if (pending !== key) fail();
    pending = undefined;
  }
}

function correlateResults(
  observations: readonly ReplayExecutionObservationPayload[],
  results: readonly ReplayBoundaryExecutionResult[],
): readonly BoundaryObservation[] {
  const boundaryObservations = observations.filter(
    (observation): observation is BoundaryObservation => observation.kind === "boundary",
  );
  validateBoundaryLifecycle(boundaryObservations);
  const responses = boundaryObservations.filter(
    (observation) => observation.phase === "response_observed",
  );
  if (
    responses.length !== results.length ||
    responses.some((observation, index) => {
      const result = results[index];
      return result === undefined || !matchesResult(observation, result);
    })
  ) {
    fail();
  }
  return boundaryObservations;
}

function uncertainBoundaryUsage(
  observations: readonly BoundaryObservation[],
  relevant: (observation: BoundaryObservation) => boolean,
): boolean {
  let pending = false;
  for (const observation of observations) {
    if (!relevant(observation)) continue;
    if (observation.phase === "request_started") {
      pending = true;
      continue;
    }
    if (observation.phase === "failed") return true;
    pending = false;
  }
  return pending;
}

function countStarted(
  observations: readonly BoundaryObservation[],
  kind: "model" | "tool",
): number {
  let count = 0;
  for (const observation of observations) {
    if (observation.phase === "request_started" && observation.boundaryKind === kind) {
      count = checkedAdd(count, 1);
    }
  }
  return count;
}

function retrievedBytes(
  results: readonly ReplayBoundaryExecutionResult[],
  observations: readonly BoundaryObservation[],
): ReplayUsageMeasurement {
  if (
    uncertainBoundaryUsage(observations, (observation) => observation.boundaryKind === "retrieval")
  ) {
    return unavailable("measurement_failed");
  }
  let total = 0;
  for (const result of results) {
    if (result.actualRequest.kind !== "retrieval") continue;
    /* v8 ignore next -- Recorded outputs are contractually limited to model and tool boundaries. */
    if (result.output.kind !== "normalized_response") fail();
    total = checkedAdd(total, result.output.response.sizeBytes);
  }
  return measured(total);
}

function relevantResults(
  results: readonly ReplayBoundaryExecutionResult[],
  dimension: BoundaryUsageDimension,
): readonly ReplayBoundaryExecutionResult[] {
  if (dimension === "providerCostMicrounits") {
    return results.filter(({ mode }) => mode === "live_provider");
  }
  return results.filter(
    ({ actualRequest, mode }) => actualRequest.kind === "model" && mode !== "recorded_stub",
  );
}

function missingReason(
  result: ReplayBoundaryExecutionResult,
): Extract<ReplayUsageMeasurement, { readonly status: "unavailable" }>["reason"] {
  return result.declaration.mode === "live_provider" &&
    result.declaration.usageSource === "provider_reported"
    ? "provider_did_not_report"
    : "source_unavailable";
}

function unavailableReason(
  measurements: readonly Extract<ReplayUsageMeasurement, { readonly status: "unavailable" }>[],
) {
  if (measurements.some(({ reason }) => reason === "measurement_failed")) {
    return "measurement_failed" as const;
  }
  if (measurements.some(({ reason }) => reason === "provider_did_not_report")) {
    return "provider_did_not_report" as const;
  }
  return "source_unavailable" as const;
}

function aggregateBoundaryUsage(
  results: readonly ReplayBoundaryExecutionResult[],
  dimension: BoundaryUsageDimension,
  observations: readonly BoundaryObservation[],
): ReplayUsageMeasurement {
  const uncertain = uncertainBoundaryUsage(observations, (observation) =>
    dimension === "providerCostMicrounits"
      ? observation.mode === "live_provider"
      : observation.boundaryKind === "model" && observation.mode !== "recorded_stub",
  );
  if (uncertain) return unavailable("measurement_failed");
  const relevant = relevantResults(results, dimension);
  if (relevant.length === 0) return measured(0);

  const measurements = relevant.map((result) => {
    const found = result.usage.find((entry) => entry.dimension === dimension)?.usage;
    return found ?? unavailable(missingReason(result));
  });
  const missing = measurements.filter(
    (
      measurement,
    ): measurement is Extract<ReplayUsageMeasurement, { readonly status: "unavailable" }> =>
      measurement.status === "unavailable",
  );
  if (missing.length > 0) return unavailable(unavailableReason(missing));

  const observed = measurements as readonly Extract<
    ReplayUsageMeasurement,
    { readonly status: "observed" }
  >[];
  const source = observed[0]?.source;
  if (source === undefined || observed.some((measurement) => measurement.source !== source)) {
    return unavailable("measurement_failed");
  }
  let amount = 0;
  for (const measurement of observed) amount = checkedAdd(amount, measurement.amount);
  return Object.freeze({ amount, source, status: "observed" });
}

function verifyWorkerOwnedUsage(results: readonly ReplayBoundaryExecutionResult[]): void {
  const forbidden = new Set<ReplayBudgetDimension>([
    "concurrentInteractions",
    "elapsedMilliseconds",
    "emittedArtifactBytes",
    "jobAttempts",
  ]);
  for (const result of results) {
    for (const entry of result.usage) {
      if (forbidden.has(entry.dimension)) fail();
      if (entry.dimension === "modelRequests") {
        if (
          result.actualRequest.kind !== "model" ||
          entry.usage.status !== "observed" ||
          entry.usage.amount !== 1
        ) {
          fail();
        }
      }
      if (entry.dimension === "toolCalls") {
        if (
          result.actualRequest.kind !== "tool" ||
          entry.usage.status !== "observed" ||
          entry.usage.amount !== 1
        ) {
          fail();
        }
      }
    }
  }
}

/**
 * Builds one complete, source-preserving attempt usage vector from worker observations and
 * boundary results. Missing or mixed boundary evidence remains unavailable; it is never projected
 * into an observed zero or relabelled with a plan-selected source.
 */
export function measureReplayAttemptUsage(
  options: MeasureReplayAttemptUsageOptions,
): ReplayUsageMeasurements {
  const elapsedMilliseconds = safeNonnegativeInteger(options.elapsedMilliseconds);
  const emittedArtifactBytes = safeNonnegativeInteger(options.emittedArtifactBytes);
  const results = parseResults(options.boundaryResults);
  verifyWorkerOwnedUsage(results);
  const observations = parseObservations(options.executionObservations);
  const boundaryObservations = correlateResults(observations, results);
  const started = boundaryObservations.filter(
    (observation) => observation.phase === "request_started",
  ).length;

  return Object.freeze({
    concurrentInteractions: measured(started === 0 ? 0 : 1),
    elapsedMilliseconds: measured(elapsedMilliseconds),
    emittedArtifactBytes: measured(emittedArtifactBytes),
    inputTokens: aggregateBoundaryUsage(results, "inputTokens", boundaryObservations),
    jobAttempts: measured(1),
    modelRequests: measured(countStarted(boundaryObservations, "model")),
    outputTokens: aggregateBoundaryUsage(results, "outputTokens", boundaryObservations),
    providerCostMicrounits: aggregateBoundaryUsage(
      results,
      "providerCostMicrounits",
      boundaryObservations,
    ),
    retrievedBytes: retrievedBytes(results, boundaryObservations),
    toolCalls: measured(countStarted(boundaryObservations, "tool")),
  });
}
