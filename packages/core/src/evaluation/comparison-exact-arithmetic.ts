import {
  type ComparisonExactValue,
  ComparisonExactValueSchema,
  type ComparisonMetric,
  MAX_COMPARISON_EXACT_INTEGER_CHARACTERS,
  MAX_COMPARISON_NUMERIC_OBSERVATIONS,
  MAX_COMPARISON_SUBJECT_FIXTURES,
} from "@proofstack/contracts";

type NumericComparisonMetric = Extract<ComparisonMetric, { readonly kind: "numeric_measurement" }>;

export type ComparisonExactAggregation = NumericComparisonMetric["aggregation"];

export type ComparisonExactArithmeticErrorCode =
  | "empty_sample"
  | "invalid_aggregation"
  | "invalid_value"
  | "mixed_units"
  | "result_out_of_bounds"
  | "sample_limit_exceeded";

export class ComparisonExactArithmeticError extends Error {
  constructor(
    readonly code: ComparisonExactArithmeticErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ComparisonExactArithmeticError";
  }
}

interface ExactFraction {
  readonly denominator: bigint;
  readonly numerator: bigint;
}

interface ParsedExactValue extends ExactFraction {
  readonly unit: string;
}

export const MAX_COMPARISON_EXACT_AGGREGATION_VALUES =
  MAX_COMPARISON_NUMERIC_OBSERVATIONS * MAX_COMPARISON_SUBJECT_FIXTURES;

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function normalizeFraction(numerator: bigint, denominator: bigint): ExactFraction {
  if (denominator === 0n) {
    throw new ComparisonExactArithmeticError(
      "invalid_value",
      "Exact comparison values cannot have a zero denominator",
    );
  }
  const sign = denominator < 0n ? -1n : 1n;
  const signedNumerator = numerator * sign;
  const positiveDenominator = denominator * sign;
  if (signedNumerator === 0n) return { denominator: 1n, numerator: 0n };
  const divisor = greatestCommonDivisor(signedNumerator, positiveDenominator);
  return {
    denominator: positiveDenominator / divisor,
    numerator: signedNumerator / divisor,
  };
}

function assertResultBounds(value: ExactFraction): ExactFraction {
  if (
    value.numerator.toString().length > MAX_COMPARISON_EXACT_INTEGER_CHARACTERS ||
    value.denominator.toString().length > MAX_COMPARISON_EXACT_INTEGER_CHARACTERS
  ) {
    throw new ComparisonExactArithmeticError(
      "result_out_of_bounds",
      "The exact comparison result exceeds the bounded 128-character integer representation",
    );
  }
  return value;
}

function decimalFraction(value: string): ExactFraction {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fractional = ""] = unsigned.split(".");
  const numerator = BigInt(`${whole}${fractional}`) * (negative ? -1n : 1n);
  return normalizeFraction(numerator, 10n ** BigInt(fractional.length));
}

function parseExactValue(value: ComparisonExactValue): ParsedExactValue {
  const parsed = ComparisonExactValueSchema.safeParse(value);
  if (!parsed.success) {
    throw new ComparisonExactArithmeticError(
      "invalid_value",
      "The exact comparison value does not satisfy the public contract",
      { cause: parsed.error },
    );
  }
  const fraction =
    parsed.data.representation === "rational"
      ? normalizeFraction(BigInt(parsed.data.numerator), BigInt(parsed.data.denominator))
      : decimalFraction(parsed.data.value);
  return { ...fraction, unit: parsed.data.unit };
}

function compareFractions(left: ExactFraction, right: ExactFraction): -1 | 0 | 1 {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}

function addFractions(left: ExactFraction, right: ExactFraction): ExactFraction {
  const sharedDivisor = greatestCommonDivisor(left.denominator, right.denominator);
  const leftMultiplier = right.denominator / sharedDivisor;
  const rightMultiplier = left.denominator / sharedDivisor;
  return assertResultBounds(
    normalizeFraction(
      left.numerator * leftMultiplier + right.numerator * rightMultiplier,
      left.denominator * leftMultiplier,
    ),
  );
}

function divideFraction(value: ExactFraction, divisor: number): ExactFraction {
  return assertResultBounds(
    normalizeFraction(value.numerator, value.denominator * BigInt(divisor)),
  );
}

function canonicalFractionOrder(left: ExactFraction, right: ExactFraction): number {
  const comparison = compareFractions(left, right);
  if (comparison !== 0) return comparison;
  if (left.numerator !== right.numerator) return left.numerator < right.numerator ? -1 : 1;
  return left.denominator === right.denominator ? 0 : left.denominator < right.denominator ? -1 : 1;
}

function sumOrderedFractions(values: readonly ExactFraction[]): ExactFraction {
  return values.reduce<ExactFraction>((total, value) => addFractions(total, value), {
    denominator: 1n,
    numerator: 0n,
  });
}

function exactValue(value: ExactFraction, unit: string): ComparisonExactValue {
  const bounded = assertResultBounds(normalizeFraction(value.numerator, value.denominator));
  return ComparisonExactValueSchema.parse({
    denominator: bounded.denominator.toString(),
    numerator: bounded.numerator.toString(),
    representation: "rational",
    unit,
  });
}

function validateAggregation(value: ComparisonExactAggregation): void {
  const candidate = value as {
    readonly basisPoints?: unknown;
    readonly method?: unknown;
    readonly methodVersion?: unknown;
  };
  const method = candidate.method;
  if (["maximum", "mean", "median", "minimum", "sum"].includes(method as string)) return;
  if (method !== "nearest_rank_quantile") {
    throw new ComparisonExactArithmeticError(
      "invalid_aggregation",
      "The exact comparison aggregation method is not supported",
    );
  }
  if (
    candidate.methodVersion !== "1.0.0" ||
    typeof candidate.basisPoints !== "number" ||
    !Number.isInteger(candidate.basisPoints) ||
    candidate.basisPoints < 1 ||
    candidate.basisPoints > 10_000
  ) {
    throw new ComparisonExactArithmeticError(
      "invalid_aggregation",
      "Nearest-rank quantiles require version 1.0.0 and 1 to 10000 basis points",
    );
  }
}

function parseSample(values: readonly ComparisonExactValue[]): readonly ParsedExactValue[] {
  if (values.length === 0) {
    throw new ComparisonExactArithmeticError(
      "empty_sample",
      "Exact comparison aggregation requires at least one observation",
    );
  }
  if (values.length > MAX_COMPARISON_EXACT_AGGREGATION_VALUES) {
    throw new ComparisonExactArithmeticError(
      "sample_limit_exceeded",
      `Exact comparison aggregation cannot exceed ${MAX_COMPARISON_EXACT_AGGREGATION_VALUES} observations`,
    );
  }
  const parsed = values.map(parseExactValue);
  const unit = parsed[0]?.unit;
  if (!unit || parsed.some((value) => value.unit !== unit)) {
    throw new ComparisonExactArithmeticError(
      "mixed_units",
      "Exact comparison aggregation cannot combine different units",
    );
  }
  return parsed;
}

/**
 * Returns a canonical, reduced rational for every declared descriptive method. Keeping one output
 * representation makes equivalent decimal and rational inputs encode identically and prevents
 * input order from changing the immutable comparison result.
 */
export function aggregateComparisonExactValues(
  values: readonly ComparisonExactValue[],
  aggregation: ComparisonExactAggregation,
): ComparisonExactValue {
  validateAggregation(aggregation);
  const parsed = parseSample(values);
  const unit = parsed[0]?.unit;
  if (!unit) {
    throw new ComparisonExactArithmeticError("empty_sample", "Expected a parsed exact sample");
  }
  const ordered = [...parsed].sort(canonicalFractionOrder);
  let result: ExactFraction;

  switch (aggregation.method) {
    case "minimum":
      result = ordered[0] as ParsedExactValue;
      break;
    case "maximum":
      result = ordered[ordered.length - 1] as ParsedExactValue;
      break;
    case "sum":
      result = sumOrderedFractions(ordered);
      break;
    case "mean":
      result = divideFraction(sumOrderedFractions(ordered), ordered.length);
      break;
    case "median": {
      const upperIndex = Math.floor(ordered.length / 2);
      const upper = ordered[upperIndex];
      if (!upper) {
        throw new ComparisonExactArithmeticError("empty_sample", "Expected a median observation");
      }
      if (ordered.length % 2 === 1) {
        result = upper;
        break;
      }
      const lower = ordered[upperIndex - 1];
      if (!lower) {
        throw new ComparisonExactArithmeticError(
          "empty_sample",
          "Expected two median observations",
        );
      }
      result = divideFraction(addFractions(lower, upper), 2);
      break;
    }
    case "nearest_rank_quantile": {
      const rank = Math.floor((aggregation.basisPoints * ordered.length + 9_999) / 10_000);
      const selected = ordered[rank - 1];
      if (!selected) {
        throw new ComparisonExactArithmeticError(
          "invalid_aggregation",
          "The nearest-rank quantile did not select a bounded observation",
        );
      }
      result = selected;
      break;
    }
  }

  return exactValue(result, unit);
}

export function subtractComparisonExactValues(
  baseline: ComparisonExactValue,
  candidate: ComparisonExactValue,
): ComparisonExactValue {
  const parsedBaseline = parseExactValue(baseline);
  const parsedCandidate = parseExactValue(candidate);
  if (parsedBaseline.unit !== parsedCandidate.unit) {
    throw new ComparisonExactArithmeticError(
      "mixed_units",
      "Exact comparison subtraction cannot combine different units",
    );
  }
  return exactValue(
    addFractions(parsedCandidate, {
      denominator: parsedBaseline.denominator,
      numerator: -parsedBaseline.numerator,
    }),
    parsedBaseline.unit,
  );
}

export function compareComparisonExactValues(
  left: ComparisonExactValue,
  right: ComparisonExactValue,
): -1 | 0 | 1 {
  const parsedLeft = parseExactValue(left);
  const parsedRight = parseExactValue(right);
  if (parsedLeft.unit !== parsedRight.unit) {
    throw new ComparisonExactArithmeticError(
      "mixed_units",
      "Exact comparison ordering cannot combine different units",
    );
  }
  return compareFractions(parsedLeft, parsedRight);
}
