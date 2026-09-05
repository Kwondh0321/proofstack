import type { ComparisonExactValue } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  aggregateComparisonExactValues,
  ComparisonExactArithmeticError,
  compareComparisonExactValues,
  MAX_COMPARISON_EXACT_AGGREGATION_VALUES,
  subtractComparisonExactValues,
} from "./comparison-exact-arithmetic.js";

function decimal(value: string, unit = "requests"): ComparisonExactValue {
  return { representation: "decimal", unit, value };
}

function rational(numerator: string, denominator: string, unit = "requests"): ComparisonExactValue {
  return { denominator, numerator, representation: "rational", unit };
}

function expectArithmeticError(
  action: () => unknown,
  code: ComparisonExactArithmeticError["code"],
) {
  try {
    action();
    throw new Error("Expected exact comparison arithmetic to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ComparisonExactArithmeticError);
    expect((error as ComparisonExactArithmeticError).code).toBe(code);
  }
}

describe("exact comparison arithmetic", () => {
  it("normalizes mixed decimal and rational sums without floating point", () => {
    expect(
      aggregateComparisonExactValues([decimal("1.20"), decimal("-0.2"), rational("1", "3")], {
        method: "sum",
        methodVersion: "1.0.0",
      }),
    ).toEqual(rational("4", "3"));
  });

  it("represents non-terminating means exactly", () => {
    expect(
      aggregateComparisonExactValues([decimal("1"), decimal("0"), decimal("0")], {
        method: "mean",
        methodVersion: "1.0.0",
      }),
    ).toEqual(rational("1", "3"));
  });

  it("derives ordered extrema and odd or even medians across negative values", () => {
    const values = [decimal("10"), decimal("-2"), decimal("1"), decimal("0")];
    expect(
      aggregateComparisonExactValues(values, { method: "minimum", methodVersion: "1.0.0" }),
    ).toEqual(rational("-2", "1"));
    expect(
      aggregateComparisonExactValues(values, { method: "maximum", methodVersion: "1.0.0" }),
    ).toEqual(rational("10", "1"));
    expect(
      aggregateComparisonExactValues(values, { method: "median", methodVersion: "1.0.0" }),
    ).toEqual(rational("1", "2"));
    expect(
      aggregateComparisonExactValues([decimal("10"), decimal("-2"), decimal("1")], {
        method: "median",
        methodVersion: "1.0.0",
      }),
    ).toEqual(rational("1", "1"));
  });

  it("uses the declared nearest-rank quantile endpoints and integer ranks", () => {
    const values = [decimal("4"), decimal("1"), decimal("3"), decimal("2")];
    for (const [basisPoints, expected] of [
      [1, "1"],
      [2_500, "1"],
      [5_000, "2"],
      [7_500, "3"],
      [10_000, "4"],
    ] as const) {
      expect(
        aggregateComparisonExactValues(values, {
          basisPoints,
          method: "nearest_rank_quantile",
          methodVersion: "1.0.0",
        }),
      ).toEqual(rational(expected, "1"));
    }
  });

  it("is invariant to input order and exact input representation", () => {
    const first = aggregateComparisonExactValues(
      [decimal("0.5"), rational("2", "3"), rational("1", "3")],
      { method: "mean", methodVersion: "1.0.0" },
    );
    const equivalent = aggregateComparisonExactValues(
      [rational("1", "3"), rational("1", "2"), rational("2", "3")],
      { method: "mean", methodVersion: "1.0.0" },
    );
    const rounded = aggregateComparisonExactValues(
      [decimal("0.333333333333333333"), decimal("0.5"), rational("2", "3")],
      { method: "mean", methodVersion: "1.0.0" },
    );
    expect(first).toEqual(rational("1", "2"));
    expect(equivalent).toEqual(first);
    expect(rounded).not.toEqual(first);
    expect(
      aggregateComparisonExactValues([rational("1", "3"), decimal("0.5"), rational("2", "3")], {
        method: "mean",
        methodVersion: "1.0.0",
      }),
    ).toEqual(first);
  });

  it("subtracts and orders mixed exact representations", () => {
    expect(
      subtractComparisonExactValues(decimal("0.5", "ratio"), rational("2", "3", "ratio")),
    ).toEqual(rational("1", "6", "ratio"));
    expect(compareComparisonExactValues(decimal("0.5"), rational("1", "2"))).toBe(0);
    expect(compareComparisonExactValues(decimal("-1"), rational("0", "1"))).toBe(-1);
  });

  it("rejects empty, oversized, malformed, mixed-unit, and invalid quantile inputs", () => {
    expectArithmeticError(
      () => aggregateComparisonExactValues([], { method: "sum", methodVersion: "1.0.0" }),
      "empty_sample",
    );
    const oversized = [] as ComparisonExactValue[];
    oversized.length = MAX_COMPARISON_EXACT_AGGREGATION_VALUES + 1;
    expectArithmeticError(
      () => aggregateComparisonExactValues(oversized, { method: "sum", methodVersion: "1.0.0" }),
      "sample_limit_exceeded",
    );
    expectArithmeticError(
      () =>
        aggregateComparisonExactValues([decimal("01")], {
          method: "sum",
          methodVersion: "1.0.0",
        }),
      "invalid_value",
    );
    expectArithmeticError(
      () =>
        aggregateComparisonExactValues([decimal("1"), decimal("1", "tokens")], {
          method: "sum",
          methodVersion: "1.0.0",
        }),
      "mixed_units",
    );
    expectArithmeticError(
      () =>
        aggregateComparisonExactValues([decimal("1")], {
          basisPoints: 0,
          method: "nearest_rank_quantile",
          methodVersion: "1.0.0",
        } as never),
      "invalid_aggregation",
    );
    expectArithmeticError(
      () => aggregateComparisonExactValues([decimal("1")], { method: "unknown" } as never),
      "invalid_aggregation",
    );
    expectArithmeticError(
      () =>
        aggregateComparisonExactValues([decimal("1")], {
          method: "sum",
          methodVersion: "2.0.0",
        } as never),
      "invalid_aggregation",
    );
    expectArithmeticError(
      () =>
        aggregateComparisonExactValues([decimal("1")], {
          basisPoints: 5_000,
          method: "nearest_rank_quantile",
          methodVersion: "2.0.0",
        } as never),
      "invalid_aggregation",
    );
    expectArithmeticError(
      () => subtractComparisonExactValues(decimal("1"), decimal("1", "tokens")),
      "mixed_units",
    );
    expectArithmeticError(
      () => compareComparisonExactValues(decimal("1"), decimal("1", "tokens")),
      "mixed_units",
    );
  });

  it("fails closed when a reduced result exceeds the public rational bound", () => {
    const maximum = rational("9".repeat(128), "1");
    expectArithmeticError(
      () =>
        aggregateComparisonExactValues([maximum, maximum], {
          method: "sum",
          methodVersion: "1.0.0",
        }),
      "result_out_of_bounds",
    );
    expectArithmeticError(
      () =>
        aggregateComparisonExactValues(
          [rational("1", `1${"0".repeat(127)}`), rational("1", "9".repeat(128))],
          { method: "sum", methodVersion: "1.0.0" },
        ),
      "result_out_of_bounds",
    );
  });
});
