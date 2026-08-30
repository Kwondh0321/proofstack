import { describe, expect, it } from "vitest";
import {
  MAX_REPLAY_ACCOUNTING_VALUE,
  REPLAY_ACCOUNTING_SCHEMA_VERSION,
  REPLAY_BUDGET_DIMENSIONS,
  REPLAY_OBSERVATION_SCHEMA_VERSION,
  ReplayBudgetLedgerEntrySchema,
  ReplayBudgetReconciliationSchema,
  ReplayBudgetReconciliationVectorSchema,
  ReplayBudgetReservationSchema,
  ReplayBudgetReservationVectorSchema,
  ReplayExecutionObservationSchema,
  ReplayUsageObservationSchema,
} from "./replay-accounting.js";

const sha = (digit: string): string => digit.repeat(64);

const scope = {
  environmentId: "env_reference",
  projectId: "prj_reference",
  tenantId: "ten_reference",
};

const mutationFence = {
  attemptId: "att_reference_001",
  fencingToken: 1,
  jobId: "job_reference_001",
  leaseId: "lea_reference_001",
  recoveryEpoch: 0,
  workerId: "wrk_reference_001",
};

function reservationDimension(reservedAmount = 0) {
  return {
    committedBefore: 0,
    limit: 100,
    measurement: "measured" as const,
    reservedAmount,
  };
}

function reservationVector() {
  return Object.fromEntries(
    REPLAY_BUDGET_DIMENSIONS.map((dimension) => [
      dimension,
      reservationDimension(dimension === "jobAttempts" ? 1 : 0),
    ]),
  );
}

function reservation() {
  return {
    dimensions: reservationVector(),
    entryType: "reservation" as const,
    ledgerSequence: 0,
    mutationFence,
    reservationId: "res_reference_001",
    reservedAt: "2026-08-29T00:00:02.000Z",
    schemaVersion: REPLAY_ACCOUNTING_SCHEMA_VERSION,
    scope,
    work: { kind: "attempt_start" as const },
  };
}

function settledDimension(reservedAmount = 0, actualAmount = reservedAmount) {
  return {
    actualUsage: { amount: actualAmount, source: "measured" as const, status: "observed" as const },
    disposition: "settled" as const,
    overrunAmount: 0,
    releasedAmount: reservedAmount - actualAmount,
    reservedAmount,
  };
}

function reconciliationVector() {
  return Object.fromEntries(
    REPLAY_BUDGET_DIMENSIONS.map((dimension) => [
      dimension,
      settledDimension(dimension === "jobAttempts" ? 1 : 0),
    ]),
  );
}

function reconciliation() {
  return {
    dimensions: reconciliationVector(),
    entryType: "reconciliation" as const,
    ledgerSequence: 1,
    mutationFence,
    reconciledAt: "2026-08-29T00:00:03.000Z",
    reconciliationId: "rec_reference_001",
    reservationId: "res_reference_001",
    schemaVersion: REPLAY_ACCOUNTING_SCHEMA_VERSION,
    scope,
  };
}

function executionObservation(payload: Record<string, unknown>) {
  return {
    mutationFence,
    observationId: "obs_reference_001",
    observationSequence: 0,
    observedAt: "2026-08-29T00:00:04.000Z",
    payload,
    schemaVersion: REPLAY_OBSERVATION_SCHEMA_VERSION,
    scope,
  };
}

describe("replay budget reservation contracts", () => {
  it("reserves one complete finite vector before work", () => {
    expect(ReplayBudgetReservationVectorSchema.parse(reservationVector())).toEqual(
      reservationVector(),
    );
    expect(ReplayBudgetReservationSchema.parse(reservation())).toEqual(reservation());
    expect(ReplayBudgetLedgerEntrySchema.safeParse(reservation()).success).toBe(true);
    const { entryType: _entryType, ...ambiguous } = reservation();
    expect(ReplayBudgetLedgerEntrySchema.safeParse(ambiguous).success).toBe(false);
  });

  it("accepts exact attempt, boundary, and artifact work references", () => {
    const base = reservation();
    expect(
      ReplayBudgetReservationSchema.safeParse({
        ...base,
        work: {
          boundaryId: "bnd_model",
          boundaryKind: "model",
          kind: "boundary_call",
        },
      }).success,
    ).toBe(true);
    expect(
      ReplayBudgetReservationSchema.safeParse({
        ...base,
        work: { artifactId: "art_output", kind: "artifact_emission" },
      }).success,
    ).toBe(true);
  });

  it("rejects zero work, incomplete dimensions, overflow, and hidden aggregate budgets", () => {
    const zero = Object.fromEntries(
      REPLAY_BUDGET_DIMENSIONS.map((dimension) => [dimension, reservationDimension(0)]),
    );
    expect(ReplayBudgetReservationVectorSchema.safeParse(zero).success).toBe(false);

    const vector = reservationVector();
    const { toolCalls: _missing, ...incomplete } = vector;
    expect(ReplayBudgetReservationVectorSchema.safeParse(incomplete).success).toBe(false);
    expect(ReplayBudgetReservationVectorSchema.safeParse({ ...vector, total: 100 }).success).toBe(
      false,
    );
    expect(
      ReplayBudgetReservationVectorSchema.safeParse({
        ...vector,
        jobAttempts: {
          ...reservationDimension(1),
          committedBefore: 100,
          limit: 100,
        },
      }).success,
    ).toBe(false);
    expect(
      ReplayBudgetReservationVectorSchema.safeParse({
        ...vector,
        jobAttempts: reservationDimension(MAX_REPLAY_ACCOUNTING_VALUE + 1),
      }).success,
    ).toBe(false);
  });
});

describe("replay budget reconciliation contracts", () => {
  it("settles observed usage and releases only the exact unused reservation", () => {
    const vector = {
      ...reconciliationVector(),
      inputTokens: settledDimension(10, 4),
    };
    expect(ReplayBudgetReconciliationVectorSchema.safeParse(vector).success).toBe(true);
    const record = { ...reconciliation(), dimensions: vector };
    expect(ReplayBudgetReconciliationSchema.safeParse(record).success).toBe(true);
    expect(ReplayBudgetLedgerEntrySchema.safeParse(record).success).toBe(true);
  });

  it("preserves complete overruns instead of truncating actual usage", () => {
    const overrun = {
      actualUsage: {
        amount: 17,
        source: "provider_reported" as const,
        status: "observed" as const,
      },
      disposition: "overrun" as const,
      overrunAmount: 7,
      releasedAmount: 0,
      reservedAmount: 10,
    };
    expect(
      ReplayBudgetReconciliationVectorSchema.safeParse({
        ...reconciliationVector(),
        outputTokens: overrun,
      }).success,
    ).toBe(true);
    expect(
      ReplayBudgetReconciliationVectorSchema.safeParse({
        ...reconciliationVector(),
        outputTokens: { ...overrun, overrunAmount: 0 },
      }).success,
    ).toBe(false);
  });

  it("keeps unavailable usage fully reserved and disputed", () => {
    const disputed = {
      actualUsage: { reason: "provider_did_not_report" as const, status: "unavailable" as const },
      disposition: "disputed" as const,
      overrunAmount: 0,
      releasedAmount: 0,
      reservedAmount: 10,
    };
    expect(
      ReplayBudgetReconciliationVectorSchema.safeParse({
        ...reconciliationVector(),
        providerCostMicrounits: disputed,
      }).success,
    ).toBe(true);
    expect(
      ReplayBudgetReconciliationVectorSchema.safeParse({
        ...reconciliationVector(),
        providerCostMicrounits: { ...disputed, releasedAmount: 10 },
      }).success,
    ).toBe(false);
  });

  it("rejects invented settlement arithmetic", () => {
    expect(
      ReplayBudgetReconciliationVectorSchema.safeParse({
        ...reconciliationVector(),
        inputTokens: { ...settledDimension(10, 4), releasedAmount: 5 },
      }).success,
    ).toBe(false);
  });
});

describe("replay usage observations", () => {
  it("records sorted observed and unavailable dimensions without plaintext", () => {
    const observation = {
      boundaryId: "bnd_model",
      measurements: [
        {
          dimension: "inputTokens" as const,
          usage: { amount: 12, source: "provider_reported" as const, status: "observed" as const },
        },
        {
          dimension: "outputTokens" as const,
          usage: {
            reason: "provider_did_not_report" as const,
            status: "unavailable" as const,
          },
        },
      ],
      mutationFence,
      observationId: "use_reference_001",
      observationSequence: 0,
      observedAt: "2026-08-29T00:00:04.000Z",
      schemaVersion: REPLAY_OBSERVATION_SCHEMA_VERSION,
      scope,
      sourceEventSha256: sha("1"),
    };
    expect(ReplayUsageObservationSchema.parse(observation)).toEqual(observation);
    expect(
      ReplayUsageObservationSchema.safeParse({
        ...observation,
        measurements: [...observation.measurements].reverse(),
      }).success,
    ).toBe(false);
    expect(
      ReplayUsageObservationSchema.safeParse({ ...observation, providerPayload: "secret" }).success,
    ).toBe(false);
  });
});

describe("replay execution observations", () => {
  it.each([
    ["recorded_stub", "recorded"],
    ["simulation", "simulated"],
    ["live_provider", "live"],
  ] as const)("preserves the %s boundary origin", (mode, executionOrigin) => {
    const observation = executionObservation({
      afterCancellationRequest: false,
      boundaryId: "bnd_model",
      boundaryKind: "model",
      effectCertainty: mode === "live_provider" ? "confirmed" : "none",
      evidenceSha256: sha("2"),
      kind: "boundary",
      mode,
      executionOrigin,
      phase: "response_observed",
    });
    expect(ReplayExecutionObservationSchema.safeParse(observation).success).toBe(true);
  });

  it("rejects mode fallback labels and invented live effects", () => {
    const payload = {
      afterCancellationRequest: false,
      boundaryId: "bnd_model",
      boundaryKind: "model",
      effectCertainty: "none",
      evidenceSha256: sha("2"),
      kind: "boundary",
      mode: "simulation",
      executionOrigin: "live",
      phase: "response_observed",
    };
    expect(ReplayExecutionObservationSchema.safeParse(executionObservation(payload)).success).toBe(
      false,
    );
    expect(
      ReplayExecutionObservationSchema.safeParse(
        executionObservation({
          ...payload,
          effectCertainty: "confirmed",
          executionOrigin: "simulated",
        }),
      ).success,
    ).toBe(false);
  });

  it("requires exact target exit semantics", () => {
    const exited = executionObservation({
      afterCancellationRequest: true,
      evidenceSha256: sha("3"),
      event: "exited",
      exitCode: 0,
      kind: "target",
    });
    expect(ReplayExecutionObservationSchema.safeParse(exited).success).toBe(true);
    expect(
      ReplayExecutionObservationSchema.safeParse(
        executionObservation({
          afterCancellationRequest: false,
          evidenceSha256: sha("3"),
          event: "started",
          exitCode: 0,
          kind: "target",
        }),
      ).success,
    ).toBe(false);
    expect(
      ReplayExecutionObservationSchema.safeParse(
        executionObservation({
          afterCancellationRequest: false,
          evidenceSha256: sha("3"),
          event: "exited",
          kind: "target",
        }),
      ).success,
    ).toBe(false);
  });

  it("accepts cancellation and truthful isolation evidence only as immutable digests", () => {
    expect(
      ReplayExecutionObservationSchema.safeParse(
        executionObservation({
          cancellationId: "can_reference_001",
          event: "late_completion_observed",
          evidenceSha256: sha("4"),
          kind: "cancellation",
        }),
      ).success,
    ).toBe(true);
    expect(
      ReplayExecutionObservationSchema.safeParse(
        executionObservation({
          control: "subprocess_policy",
          evidenceSha256: sha("5"),
          kind: "isolation",
          verdict: "not_verified",
        }),
      ).success,
    ).toBe(true);
    expect(
      ReplayExecutionObservationSchema.safeParse(
        executionObservation({
          control: "network_policy",
          evidence: { rawLog: "unbounded" },
          evidenceSha256: sha("5"),
          kind: "isolation",
          verdict: "verified",
        }),
      ).success,
    ).toBe(false);
  });
});
