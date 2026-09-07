import {
  type ComparisonExactValue,
  ComparisonExactValueSchema,
  type ReleasePolicyComparator,
  ReleasePolicyComparatorSchema,
  ReleasePolicyExactDecimalSchema,
  type ReleasePolicyPredicate,
  ReleasePolicyUnitSchema,
  UnitIntervalDecimalSchema,
} from "@proofstack/contracts";
import { compareComparisonExactValues } from "../evaluation/comparison-exact-arithmetic.js";

type PolicyUnit = Extract<ReleasePolicyPredicate, { kind: "comparison_threshold" }>["unit"];
type BoundComparator = Extract<ReleasePolicyPredicate, { kind: "uncertainty_bound" }>["comparator"];

export type PolicyNumericInputErrorCode =
  | "invalid_basis_points"
  | "invalid_comparator"
  | "invalid_count"
  | "invalid_population"
  | "invalid_probability_bound"
  | "invalid_threshold"
  | "invalid_unit"
  | "invalid_value"
  | "mixed_units";

export class PolicyNumericInputError extends Error {
  constructor(
    readonly code: PolicyNumericInputErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PolicyNumericInputError";
  }
}

/** Numeric evidence only: neither field establishes source eligibility or release permission. */
export interface PolicyNumericComparison {
  readonly matches: boolean;
  readonly order: -1 | 0 | 1;
}

export type PolicyCoverageRatioComparison =
  | { readonly comparison: PolicyNumericComparison; readonly status: "compared" }
  | { readonly reason: "zero_denominator"; readonly status: "undefined" };

function comparator(value: ReleasePolicyComparator): ReleasePolicyComparator {
  const parsed = ReleasePolicyComparatorSchema.safeParse(value);
  if (!parsed.success) {
    throw new PolicyNumericInputError(
      "invalid_comparator",
      "Expected a declared policy comparator",
    );
  }
  return parsed.data;
}

function comparison(
  order: -1 | 0 | 1,
  operation: ReleasePolicyComparator,
): PolicyNumericComparison {
  const matches: Record<ReleasePolicyComparator, boolean> = {
    equal: order === 0,
    greater_than: order === 1,
    greater_than_or_equal: order !== -1,
    less_than: order === -1,
    less_than_or_equal: order !== 1,
    not_equal: order !== 0,
  };
  return { matches: matches[operation], order };
}

function assertCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PolicyNumericInputError("invalid_count", "Counts must be nonnegative safe integers");
  }
}

function assertBasisPoints(value: number, minimum: 0 | 1): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > 10_000) {
    throw new PolicyNumericInputError(
      "invalid_basis_points",
      `Basis points must be integers from ${minimum} to 10000`,
    );
  }
}

/**
 * Compare a selected exact operand, not an entire policy rule. The caller must separately prove
 * reference/metric/stratum identity, applicability, compatibility, and required eligibility.
 * Shared contracts bound rationals to 128 characters per integer and decimals to 18 whole and
 * 18 fractional digits before conversion. Even the general comparison helper's intermediate
 * magnitude is below 10^257; no input-dependent unbounded precision or rounded value is admitted.
 */
export function comparePolicyExactThreshold(
  value: ComparisonExactValue,
  threshold: string,
  unit: PolicyUnit,
  operation: ReleasePolicyComparator,
): PolicyNumericComparison {
  const parsedComparator = comparator(operation);
  if (!ReleasePolicyUnitSchema.safeParse(unit).success) {
    throw new PolicyNumericInputError("invalid_unit", "Expected a declared policy unit");
  }
  if (!ReleasePolicyExactDecimalSchema.safeParse(threshold).success) {
    throw new PolicyNumericInputError("invalid_threshold", "Expected a canonical policy decimal");
  }
  const parsedValue = ComparisonExactValueSchema.safeParse(value);
  if (!parsedValue.success) {
    throw new PolicyNumericInputError(
      "invalid_value",
      "Expected a bounded exact comparison value",
      {
        cause: parsedValue.error,
      },
    );
  }
  if (parsedValue.data.unit !== unit) {
    throw new PolicyNumericInputError("mixed_units", "Operand and policy units must match exactly");
  }
  return comparison(
    compareComparisonExactValues(parsedValue.data, {
      representation: "decimal",
      unit,
      value: threshold,
    }),
    parsedComparator,
  );
}

/** Count floors and ceilings still need their exact declared population and unit checked upstream. */
export function comparePolicyCounts(
  observed: number,
  threshold: number,
  operation: ReleasePolicyComparator,
): PolicyNumericComparison {
  const parsedComparator = comparator(operation);
  assertCount(observed);
  assertCount(threshold);
  return comparison(observed < threshold ? -1 : observed > threshold ? 1 : 0, parsedComparator);
}

/**
 * Preserve the full same-population denominator. Empty population is not zero-percent success.
 * Counts are bounded before BigInt conversion; both cross-products are at most 20 decimal digits.
 */
export function comparePolicyCoverageRatio(
  observed: number,
  total: number,
  minimumBasisPoints: number,
): PolicyCoverageRatioComparison {
  assertCount(observed);
  assertCount(total);
  assertBasisPoints(minimumBasisPoints, 1);
  if (observed > total) {
    throw new PolicyNumericInputError(
      "invalid_population",
      "Observed count cannot exceed total count",
    );
  }
  if (total === 0) return { reason: "zero_denominator", status: "undefined" };
  const left = BigInt(observed) * 10_000n;
  const right = BigInt(minimumBasisPoints) * BigInt(total);
  return {
    comparison: comparison(left < right ? -1 : left > right ? 1 : 0, "greater_than_or_equal"),
    status: "compared",
  };
}

/**
 * Compare a retained interval bound without recomputing or rounding it. This does not establish
 * the interval's method, confidence, sampling assumption, lineage, or source qualification.
 */
export function comparePolicyProbabilityBound(
  bound: string,
  thresholdBasisPoints: number,
  operation: BoundComparator,
): PolicyNumericComparison {
  if (operation !== "at_least" && operation !== "at_most") {
    throw new PolicyNumericInputError("invalid_comparator", "Expected at_least or at_most");
  }
  assertBasisPoints(thresholdBasisPoints, 0);
  if (!UnitIntervalDecimalSchema.safeParse(bound).success) {
    throw new PolicyNumericInputError(
      "invalid_probability_bound",
      "Expected a bounded unit-interval decimal",
    );
  }
  // Formatting, not division: basis points are exact ten-thousandths of a probability.
  const threshold =
    thresholdBasisPoints === 10_000 ? "1" : `0.${String(thresholdBasisPoints).padStart(4, "0")}`;
  const unit = "probability";
  const order = compareComparisonExactValues(
    { representation: "decimal", unit, value: bound },
    { representation: "decimal", unit, value: threshold },
  );
  return comparison(
    order,
    operation === "at_least" ? "greater_than_or_equal" : "less_than_or_equal",
  );
}
