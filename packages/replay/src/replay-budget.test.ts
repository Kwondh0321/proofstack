import {
  REPLAY_BUDGET_DIMENSIONS,
  type ReplayBudget,
  type ReplayBudgetDimension,
  type ReplayBudgetReconciliation,
  type ReplayBudgetReservation,
  type ReplayUsageMeasurement,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { DurableReplayAccountingError, type DurableReplayAccountingErrorCode } from "./errors.js";
import {
  applyReplayBudgetReconciliation,
  applyReplayBudgetReservation,
  emptyReplayBudgetAmounts,
  type ReplayBudgetAmounts,
  type ReplayUsageMeasurements,
  reconcileReplayBudget,
  reserveReplayBudget,
  summarizeReplayBudgetLedger,
} from "./replay-budget.js";

const scope = {
  environmentId: "env_budget",
  projectId: "prj_budget",
  tenantId: "ten_budget",
};

const mutationFence = {
  attemptId: "att_budget_001",
  fencingToken: 1,
  jobId: "job_budget_001",
  leaseId: "lea_budget_001",
  recoveryEpoch: 0,
  workerId: "wrk_budget_001",
};

function mapDimensions<T>(
  value: (dimension: ReplayBudgetDimension) => T,
): Record<ReplayBudgetDimension, T> {
  return Object.fromEntries(
    REPLAY_BUDGET_DIMENSIONS.map((dimension) => [dimension, value(dimension)]),
  ) as Record<ReplayBudgetDimension, T>;
}

function budget(): ReplayBudget {
  return mapDimensions(() => ({ limit: 100, measurement: "measured" as const }));
}

function amounts(overrides: Partial<ReplayBudgetAmounts> = {}): ReplayBudgetAmounts {
  return { ...emptyReplayBudgetAmounts(), ...overrides };
}

function observed(amount: number): ReplayUsageMeasurement {
  return { amount, source: "measured", status: "observed" };
}

function usage(overrides: Partial<ReplayUsageMeasurements> = {}): ReplayUsageMeasurements {
  return {
    ...mapDimensions(() => observed(0)),
    ...overrides,
  };
}

function reservation(
  overrides: Partial<Parameters<typeof reserveReplayBudget>[0]> = {},
): ReplayBudgetReservation {
  return reserveReplayBudget({
    budget: budget(),
    committed: amounts(),
    ledgerSequence: 0,
    mutationFence,
    requested: amounts({ inputTokens: 10, jobAttempts: 1, outputTokens: 5 }),
    reservationId: "res_budget_001",
    reservedAt: "2026-08-29T00:00:02.000Z",
    scope,
    work: { kind: "attempt_start" },
    ...overrides,
  });
}

function reconciliation(
  reserved = reservation(),
  overrides: Partial<Parameters<typeof reconcileReplayBudget>[1]> = {},
): ReplayBudgetReconciliation {
  return reconcileReplayBudget(reserved, {
    ledgerSequence: 1,
    reconciledAt: "2026-08-29T00:00:03.000Z",
    reconciliationId: "rec_budget_001",
    usage: usage({ inputTokens: observed(4), jobAttempts: observed(1), outputTokens: observed(5) }),
    ...overrides,
  });
}

function expectAccountingError(run: () => unknown, code: DurableReplayAccountingErrorCode): void {
  try {
    run();
    throw new Error("Expected a durable replay accounting error");
  } catch (error) {
    expect(error).toBeInstanceOf(DurableReplayAccountingError);
    expect(error).toMatchObject({ code, name: "DurableReplayAccountingError" });
  }
}

describe("replay budget reservation", () => {
  it("starts with every dimension at zero", () => {
    expect(emptyReplayBudgetAmounts()).toEqual(mapDimensions(() => 0));
  });

  it("reserves a complete vector against immutable plan limits", () => {
    const reserved = reservation();
    expect(reserved).toMatchObject({
      dimensions: {
        inputTokens: { committedBefore: 0, limit: 100, reservedAmount: 10 },
        jobAttempts: { committedBefore: 0, limit: 100, reservedAmount: 1 },
        outputTokens: { committedBefore: 0, limit: 100, reservedAmount: 5 },
      },
      entryType: "reservation",
      reservationId: "res_budget_001",
    });
    expect(applyReplayBudgetReservation(amounts(), reserved)).toEqual(
      amounts({ inputTokens: 10, jobAttempts: 1, outputTokens: 5 }),
    );
  });

  it("accepts boundary and artifact work references", () => {
    expect(
      reservation({
        work: { boundaryId: "bnd_model", boundaryKind: "model", kind: "boundary_call" },
      }).work,
    ).toMatchObject({ kind: "boundary_call" });
    expect(
      reservation({ work: { artifactId: "art_output", kind: "artifact_emission" } }).work,
    ).toMatchObject({ kind: "artifact_emission" });
  });

  it("rejects plan limit exhaustion and stale committed snapshots", () => {
    expect(() =>
      reservation({
        committed: amounts({ inputTokens: 95 }),
        requested: amounts({ inputTokens: 10 }),
      }),
    ).toThrow();
    expectAccountingError(
      () => applyReplayBudgetReservation(amounts({ inputTokens: 1 }), reservation()),
      "accounting_conflict",
    );
  });

  it.each([
    null,
    [],
    {},
    { ...amounts({ jobAttempts: 1 }), hiddenTotal: 1 },
    { ...amounts({ jobAttempts: 1 }), inputTokens: -1 },
    { ...amounts({ jobAttempts: 1 }), inputTokens: 0.5 },
  ])("rejects malformed amount vector %#", (invalid) => {
    expectAccountingError(
      () => reservation({ requested: invalid as ReplayBudgetAmounts }),
      "invalid_amounts",
    );
  });

  it("rejects an incomplete or extended budget before reading its dimensions", () => {
    const { inputTokens: _missing, ...incomplete } = budget();
    expectAccountingError(
      () => reservation({ budget: incomplete as ReplayBudget }),
      "invalid_budget",
    );
    expectAccountingError(
      () => reservation({ budget: { ...budget(), hiddenLimit: 1 } as ReplayBudget }),
      "invalid_budget",
    );
  });
});

describe("replay budget reconciliation", () => {
  it("releases only unused observed reservation", () => {
    const reserved = reservation();
    const committed = applyReplayBudgetReservation(amounts(), reserved);
    const reconciled = reconciliation(reserved);
    expect(reconciled.dimensions.inputTokens).toMatchObject({
      disposition: "settled",
      overrunAmount: 0,
      releasedAmount: 6,
      reservedAmount: 10,
    });
    expect(applyReplayBudgetReconciliation(committed, reserved, reconciled)).toEqual(
      amounts({ inputTokens: 4, jobAttempts: 1, outputTokens: 5 }),
    );
  });

  it("preserves disputed reservations and complete overruns", () => {
    const reserved = reservation({
      requested: amounts({
        inputTokens: 10,
        jobAttempts: 1,
        outputTokens: 5,
        providerCostMicrounits: 20,
      }),
    });
    const committed = applyReplayBudgetReservation(amounts(), reserved);
    const reconciled = reconciliation(reserved, {
      usage: usage({
        inputTokens: observed(4),
        jobAttempts: observed(1),
        outputTokens: observed(8),
        providerCostMicrounits: {
          reason: "provider_did_not_report",
          status: "unavailable",
        },
      }),
    });
    expect(reconciled.dimensions.outputTokens).toMatchObject({
      disposition: "overrun",
      overrunAmount: 3,
      releasedAmount: 0,
    });
    expect(reconciled.dimensions.providerCostMicrounits).toMatchObject({
      disposition: "disputed",
      overrunAmount: 0,
      releasedAmount: 0,
    });
    expect(applyReplayBudgetReconciliation(committed, reserved, reconciled)).toEqual(
      amounts({
        inputTokens: 4,
        jobAttempts: 1,
        outputTokens: 8,
        providerCostMicrounits: 20,
      }),
    );
  });

  it.each([
    null,
    [],
    {},
    { ...usage(), hidden: observed(1) },
    { ...usage(), inputTokens: { amount: -1, source: "measured", status: "observed" } },
  ])("rejects malformed usage vector %#", (invalid) => {
    expectAccountingError(
      () => reconciliation(reservation(), { usage: invalid as ReplayUsageMeasurements }),
      "invalid_usage",
    );
  });

  it("rejects mismatched reservation identity, order, scope, fence, and amounts", () => {
    const reserved = reservation();
    const committed = applyReplayBudgetReservation(amounts(), reserved);
    const base = reconciliation(reserved);
    const mismatches: ReplayBudgetReconciliation[] = [
      { ...base, reservationId: "res_budget_other" },
      { ...base, ledgerSequence: 0 },
      { ...base, scope: { ...base.scope, tenantId: "ten_other" } },
      { ...base, scope: { ...base.scope, projectId: "prj_other" } },
      { ...base, scope: { ...base.scope, environmentId: "env_other" } },
      {
        ...base,
        mutationFence: { ...base.mutationFence, jobId: "job_budget_other" },
      },
      {
        ...base,
        mutationFence: { ...base.mutationFence, attemptId: "att_budget_other" },
      },
      {
        ...base,
        mutationFence: { ...base.mutationFence, leaseId: "lea_budget_other" },
      },
      {
        ...base,
        mutationFence: { ...base.mutationFence, workerId: "wrk_budget_other" },
      },
      { ...base, mutationFence: { ...base.mutationFence, fencingToken: 2 } },
      { ...base, mutationFence: { ...base.mutationFence, recoveryEpoch: 1 } },
      {
        ...base,
        dimensions: {
          ...base.dimensions,
          inputTokens: {
            ...base.dimensions.inputTokens,
            releasedAmount: 5,
            reservedAmount: 9,
          },
        },
      },
    ];
    for (const mismatch of mismatches) {
      expectAccountingError(
        () => applyReplayBudgetReconciliation(committed, reserved, mismatch),
        "accounting_conflict",
      );
    }
    expectAccountingError(
      () => applyReplayBudgetReconciliation(amounts(), reserved, base),
      "accounting_conflict",
    );
  });

  it("fails closed on checked addition overflow", () => {
    const reserved = reservation({
      budget: {
        ...budget(),
        inputTokens: { limit: Number.MAX_SAFE_INTEGER, measurement: "measured" },
      },
      committed: amounts({ inputTokens: Number.MAX_SAFE_INTEGER - 1 }),
      requested: amounts({ inputTokens: 1 }),
    });
    const committed = applyReplayBudgetReservation(
      amounts({ inputTokens: Number.MAX_SAFE_INTEGER - 1 }),
      reserved,
    );
    const reconciled = reconciliation(reserved, {
      usage: usage({ inputTokens: observed(2) }),
    });
    expectAccountingError(
      () => applyReplayBudgetReconciliation(committed, reserved, reconciled),
      "arithmetic_overflow",
    );
  });
});

describe("replay budget ledger reconstruction", () => {
  it("reconstructs committed, disputed, overrun, and open state in exact sequence", () => {
    const first = reservation({
      requested: amounts({ inputTokens: 10, providerCostMicrounits: 20 }),
    });
    const afterFirst = applyReplayBudgetReservation(amounts(), first);
    const second = reservation({
      committed: afterFirst,
      ledgerSequence: 1,
      requested: amounts({ outputTokens: 5 }),
      reservationId: "res_budget_002",
      work: { boundaryId: "bnd_model", boundaryKind: "model", kind: "boundary_call" },
    });
    const reconciled = reconciliation(first, {
      ledgerSequence: 2,
      usage: usage({
        inputTokens: observed(12),
        providerCostMicrounits: { reason: "source_unavailable", status: "unavailable" },
      }),
    });
    const summary = summarizeReplayBudgetLedger([first, second, reconciled]);
    expect(summary).toEqual({
      committed: amounts({ inputTokens: 12, outputTokens: 5, providerCostMicrounits: 20 }),
      disputed: ["res_budget_001:providerCostMicrounits"],
      openReservationIds: ["res_budget_002"],
      overruns: ["res_budget_001:inputTokens"],
      reconciliationCount: 1,
      reservationCount: 2,
    });
  });

  it("rejects gaps, duplicate reservations, missing reservations, and duplicate reconciliation", () => {
    const first = reservation();
    expectAccountingError(
      () => summarizeReplayBudgetLedger([{ ...first, ledgerSequence: 1 }]),
      "ledger_order",
    );
    expectAccountingError(
      () => summarizeReplayBudgetLedger([first, { ...first, ledgerSequence: 1 }]),
      "duplicate_entry",
    );
    const missing = { ...reconciliation(first), ledgerSequence: 0 };
    expectAccountingError(() => summarizeReplayBudgetLedger([missing]), "missing_reservation");
    const reconciled = reconciliation(first);
    expectAccountingError(
      () =>
        summarizeReplayBudgetLedger([
          first,
          reconciled,
          { ...reconciled, ledgerSequence: 2, reconciliationId: "rec_budget_002" },
        ]),
      "duplicate_entry",
    );
  });
});
