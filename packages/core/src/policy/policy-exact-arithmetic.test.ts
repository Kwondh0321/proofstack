import {
  type ComparisonExactValue,
  type ReleasePolicyComparator,
  ReleasePolicyComparatorSchema,
  ReleasePolicyUnitSchema,
} from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  comparePolicyCounts,
  comparePolicyCoverageRatio,
  comparePolicyExactThreshold,
  comparePolicyProbabilityBound,
  PolicyNumericInputError,
  type PolicyNumericInputErrorCode,
} from "./policy-exact-arithmetic.js";

type Fraction = readonly [bigint, bigint];
type Order = -1 | 0 | 1;

// Independent oracle: compare continued-fraction quotients, not production cross-products.
// Floor division makes this work for signed numerators too; reciprocation reverses order.
function fractionOrder(left: Fraction, right: Fraction): Order {
  let [a, b] = left;
  let [c, d] = right;
  let direction = 1;
  for (;;) {
    let qa = a / b;
    let ra = a % b;
    let qc = c / d;
    let rc = c % d;
    if (ra < 0n) {
      qa -= 1n;
      ra += b;
    }
    if (rc < 0n) {
      qc -= 1n;
      rc += d;
    }
    if (qa !== qc) return (direction * (qa < qc ? -1 : 1)) as Order;
    if (ra === 0n || rc === 0n) {
      return ra === rc ? 0 : ((direction * (ra === 0n ? -1 : 1)) as Order);
    }
    [a, b, c, d] = [b, ra, d, rc];
    direction = -direction;
  }
}

function decimalFraction(value: string): Fraction {
  const fractionalDigits = value.split(".")[1]?.length ?? 0;
  return [BigInt(value.replace(".", "")), 10n ** BigInt(fractionalDigits)];
}

function expectedMatch(order: Order, operation: ReleasePolicyComparator): boolean {
  // Explicit acceptance sets keep the test separate from the implementation's Boolean mapping.
  const accepted: Record<ReleasePolicyComparator, readonly Order[]> = {
    equal: [0],
    greater_than: [1],
    greater_than_or_equal: [0, 1],
    less_than: [-1],
    less_than_or_equal: [-1, 0],
    not_equal: [-1, 1],
  };
  return accepted[operation].includes(order);
}

function rational(numerator: bigint, denominator: bigint): ComparisonExactValue {
  let a = numerator < 0n ? -numerator : numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return {
    denominator: String(denominator / a),
    numerator: String(numerator / a),
    representation: "rational",
    unit: "requests",
  };
}

function decimal(value: string, unit = "requests"): ComparisonExactValue {
  return { representation: "decimal", unit, value };
}

function expectInputError(action: () => unknown, code: PolicyNumericInputErrorCode): void {
  try {
    action();
    throw new Error("Expected policy numeric validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyNumericInputError);
    expect((error as PolicyNumericInputError).name).toBe("PolicyNumericInputError");
    expect((error as PolicyNumericInputError).code).toBe(code);
  }
}

const comparators = ReleasePolicyComparatorSchema.options;
const fractionCases = [-7n, -2n, -1n, 0n, 1n, 2n, 7n].flatMap((numerator) =>
  [1n, 2n, 3n, 7n, 97n].flatMap((denominator) =>
    ["-1", "-0.5", "0", "0.333333333333333333", "0.5", "1"].flatMap((threshold) =>
      comparators.map((operation) => ({
        denominator,
        label: `${numerator}/${denominator} ${operation} ${threshold}`,
        numerator,
        operation,
        threshold,
      })),
    ),
  ),
);

const boundaryCases: readonly {
  readonly value: ComparisonExactValue;
  readonly threshold: string;
  readonly order: Order;
}[] = [
  { value: decimal("0.999999999999999999"), threshold: "1", order: -1 },
  { value: decimal("1"), threshold: "1", order: 0 },
  { value: decimal("1.000000000000000001"), threshold: "1", order: 1 },
  { value: decimal("-1.000000000000000001"), threshold: "-1", order: -1 },
  { value: decimal("-1"), threshold: "-1", order: 0 },
  { value: decimal("-0.999999999999999999"), threshold: "-1", order: 1 },
  { value: decimal("9007199254740993"), threshold: "9007199254740992", order: 1 },
  { value: decimal("-9007199254740993"), threshold: "-9007199254740992", order: -1 },
  { value: rational(1n, 3n), threshold: "0.333333333333333333", order: 1 },
  { value: rational(-1n, 3n), threshold: "-0.333333333333333333", order: -1 },
  {
    value: rational(BigInt("9".repeat(128)), 1n),
    threshold: "999999999999999999.999999999999999999",
    order: 1,
  },
  { value: rational(1n, BigInt("9".repeat(128))), threshold: "0.000000000000000001", order: -1 },
  { value: decimal("-0.000"), threshold: "0", order: 0 },
  {
    value: { representation: "rational", numerator: "-0", denominator: "1", unit: "requests" },
    threshold: "0",
    order: 0,
  },
];

const coverageCases = [1, 3_333, 5_000, 9_999, 10_000].flatMap((minimum) =>
  [10_000, 30_000, Number.MAX_SAFE_INTEGER].flatMap((total) => {
    const floor = (BigInt(total) * BigInt(minimum)) / 10_000n;
    return [-1n, 0n, 1n].flatMap((offset) => {
      const observed = floor + offset;
      return observed < 0n || observed > BigInt(total)
        ? []
        : [{ minimum, observed: Number(observed), total }];
    });
  }),
);

const intervalCases = [0, 1, 3_333, 5_000, 9_999, 10_000].flatMap((threshold) =>
  [-1n, 0n, 1n].flatMap((offset) => {
    const scaled = BigInt(threshold) * 100_000_000_000_000n + offset;
    if (scaled < 0n || scaled > 1_000_000_000_000_000_000n) return [];
    const bound = `${scaled / 1_000_000_000_000_000_000n}.${String(scaled % 1_000_000_000_000_000_000n).padStart(18, "0")}`;
    return (["at_least", "at_most"] as const).map((operation) => ({ bound, operation, threshold }));
  }),
);

describe("bounded exact policy arithmetic", () => {
  it("checks the independent oracle against known signed, reciprocal, and equal fractions", () => {
    expect(fractionOrder([1n, 3n], [1n, 2n])).toBe(-1);
    expect(fractionOrder([-1n, 3n], [-1n, 2n])).toBe(1);
    expect(fractionOrder([7n, 3n], [2n, 1n])).toBe(1);
    expect(fractionOrder([-7n, 3n], [-2n, 1n])).toBe(-1);
    expect(fractionOrder([0n, 7n], [0n, 3n])).toBe(0);
    expect(fractionOrder([2n, 6n], [1n, 3n])).toBe(0);
  });

  it("registers every generated fraction case exactly once", () => {
    expect(fractionCases).toHaveLength(1_260);
    expect(new Set(fractionCases.map(({ label }) => label)).size).toBe(fractionCases.length);
  });

  it.each(fractionCases)(
    "matches the independent order for $label",
    ({ numerator, denominator, threshold, operation }) => {
      const order = fractionOrder([numerator, denominator], decimalFraction(threshold));
      expect(
        comparePolicyExactThreshold(
          rational(numerator, denominator),
          threshold,
          "requests",
          operation,
        ),
      ).toEqual({ matches: expectedMatch(order, operation), order });
    },
  );

  it.each(
    boundaryCases.flatMap((value, index) =>
      comparators.map((operation) => ({ ...value, index, operation })),
    ),
  )(
    "preserves exact threshold boundary $index for $operation",
    ({ value, threshold, operation, order }) => {
      const before = JSON.stringify(value);
      Object.freeze(value);
      expect(comparePolicyExactThreshold(value, threshold, "requests", operation)).toEqual({
        matches: expectedMatch(order, operation),
        order,
      });
      expect(JSON.stringify(value)).toBe(before);
    },
  );

  it.each(ReleasePolicyUnitSchema.options)(
    "preserves the explicit %s unit without conversion",
    (unit) => {
      expect(comparePolicyExactThreshold(decimal("1.20", unit), "1.2", unit, "equal")).toEqual({
        matches: true,
        order: 0,
      });
    },
  );

  it.each(comparators)("compares bounded count floors and ceilings using %s", (operation) => {
    for (const threshold of [0, 1, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
      for (const observed of [0, 1, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
        const order = fractionOrder([BigInt(observed), 1n], [BigInt(threshold), 1n]);
        expect(comparePolicyCounts(observed, threshold, operation)).toEqual({
          matches: expectedMatch(order, operation),
          order,
        });
      }
    }
  });

  it.each(coverageCases)(
    "compares $observed/$total against $minimum basis points without rounding",
    ({ observed, total, minimum }) => {
      const order = fractionOrder([BigInt(observed), BigInt(total)], [BigInt(minimum), 10_000n]);
      expect(comparePolicyCoverageRatio(observed, total, minimum)).toEqual({
        comparison: { matches: order !== -1, order },
        status: "compared",
      });
    },
  );

  it("distinguishes empty, observed zero, and full populations", () => {
    expect(comparePolicyCoverageRatio(0, 0, 1)).toEqual({
      reason: "zero_denominator",
      status: "undefined",
    });
    expect(comparePolicyCoverageRatio(0, 1, 1)).toEqual({
      comparison: { matches: false, order: -1 },
      status: "compared",
    });
    expect(comparePolicyCoverageRatio(1, 1, 10_000)).toEqual({
      comparison: { matches: true, order: 0 },
      status: "compared",
    });
    expect(comparePolicyCounts(-0, 0, "equal")).toEqual({ matches: true, order: 0 });
  });

  it.each(intervalCases)(
    "compares retained $bound $operation $threshold basis points",
    ({ bound, operation, threshold }) => {
      const order = fractionOrder(decimalFraction(bound), [BigInt(threshold), 10_000n]);
      expect(comparePolicyProbabilityBound(bound, threshold, operation)).toEqual({
        matches: operation === "at_least" ? order !== -1 : order !== 1,
        order,
      });
    },
  );

  it("does not round recurring coverage or a reported bound into satisfaction", () => {
    expect(comparePolicyCoverageRatio(1, 3, 3_334)).toEqual({
      comparison: { matches: false, order: -1 },
      status: "compared",
    });
    expect(comparePolicyProbabilityBound("0.499999999999999999", 5_000, "at_least")).toEqual({
      matches: false,
      order: -1,
    });
    expect(comparePolicyProbabilityBound("0.500000000000000001", 5_000, "at_most")).toEqual({
      matches: false,
      order: 1,
    });
    expect(comparePolicyProbabilityBound("0", 0, "at_least")).toEqual({ matches: true, order: 0 });
    expect(comparePolicyProbabilityBound("1", 10_000, "at_most")).toEqual({
      matches: true,
      order: 0,
    });
  });
});

describe("policy numeric input validation", () => {
  it.each([
    "01",
    "-0",
    "0.0",
    "1.20",
    "",
    " 1",
    "1e3",
    "0x10",
    "NaN",
    "1\n",
    "9".repeat(19),
    0,
    null,
    undefined,
  ])("rejects malformed or noncanonical threshold %j before arithmetic", (threshold) => {
    const arithmetic = vi.spyOn(globalThis, "BigInt");
    try {
      expectInputError(
        () => comparePolicyExactThreshold(decimal("1"), threshold as never, "requests", "equal"),
        "invalid_threshold",
      );
      expect(arithmetic).not.toHaveBeenCalled();
    } finally {
      arithmetic.mockRestore();
    }
  });

  it.each(["eq", "<", "toString", null, undefined])(
    "rejects unknown comparator %j",
    (operation) => {
      expectInputError(
        () => comparePolicyExactThreshold(decimal("1"), "1", "requests", operation as never),
        "invalid_comparator",
      );
      expectInputError(() => comparePolicyCounts(1, 1, operation as never), "invalid_comparator");
      expectInputError(
        () => comparePolicyProbabilityBound("0.5", 5_000, operation as never),
        "invalid_comparator",
      );
    },
  );

  it("rejects unsupported units, unit substitution, and invalid exact operands", () => {
    expectInputError(
      () => comparePolicyExactThreshold(decimal("1"), "1", "request" as never, "equal"),
      "invalid_unit",
    );
    expectInputError(
      () => comparePolicyExactThreshold(decimal("1", "tokens"), "1", "requests", "equal"),
      "mixed_units",
    );
    for (const value of [
      null,
      decimal("01"),
      decimal("1e3"),
      decimal("NaN"),
      { representation: "rational", numerator: "bad", denominator: "1", unit: "requests" },
      { representation: "rational", numerator: "1", denominator: "0", unit: "requests" },
      { representation: "rational", numerator: "2", denominator: "4", unit: "requests" },
      {
        representation: "rational",
        numerator: "9".repeat(129),
        denominator: "1",
        unit: "requests",
      },
    ]) {
      expectInputError(
        () => comparePolicyExactThreshold(value as never, "1", "requests", "equal"),
        "invalid_value",
      );
    }
  });

  it.each([
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "1",
    null,
    undefined,
    1n,
  ])("rejects invalid count %s in either operand before arithmetic", (value) => {
    const arithmetic = vi.spyOn(globalThis, "BigInt");
    try {
      expectInputError(() => comparePolicyCounts(value as never, 1, "equal"), "invalid_count");
      expectInputError(() => comparePolicyCounts(1, value as never, "equal"), "invalid_count");
      expectInputError(() => comparePolicyCoverageRatio(value as never, 1, 1), "invalid_count");
      expectInputError(() => comparePolicyCoverageRatio(0, value as never, 1), "invalid_count");
      expect(arithmetic).not.toHaveBeenCalled();
    } finally {
      arithmetic.mockRestore();
    }
  });

  it.each([-1, 10_001, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined])(
    "rejects invalid basis points %j",
    (value) => {
      expectInputError(
        () => comparePolicyCoverageRatio(1, 1, value as never),
        "invalid_basis_points",
      );
      expectInputError(
        () => comparePolicyProbabilityBound("0.5", value as never, "at_least"),
        "invalid_basis_points",
      );
    },
  );

  it("rejects impossible populations and validates limits before returning empty population", () => {
    expectInputError(() => comparePolicyCoverageRatio(1, 0, 1), "invalid_population");
    expectInputError(() => comparePolicyCoverageRatio(2, 1, 1), "invalid_population");
    expectInputError(() => comparePolicyCoverageRatio(0, 0, 0), "invalid_basis_points");
  });

  it.each([
    "",
    "bad",
    "-0",
    "-0.1",
    "2",
    "1.000000000000000001",
    "0.1234567890123456789",
    "1e-1",
    "0x1",
    "0\n",
    0.5,
    null,
    undefined,
  ])("rejects invalid probability bound %j before arithmetic", (bound) => {
    const arithmetic = vi.spyOn(globalThis, "BigInt");
    try {
      expectInputError(
        () => comparePolicyProbabilityBound(bound as never, 5_000, "at_least"),
        "invalid_probability_bound",
      );
      expect(arithmetic).not.toHaveBeenCalled();
    } finally {
      arithmetic.mockRestore();
    }
  });
});
