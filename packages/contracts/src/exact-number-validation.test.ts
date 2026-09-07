import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { WilsonIntervalSchema } from "./evaluation-assessment.js";
import { ComparisonExactValueSchema } from "./evaluation-comparison.js";
import { ComparisonMetricValueSchema } from "./evaluation-comparison-result.js";

function rational(numerator = "1", denominator = "1") {
  return { denominator, numerator, representation: "rational" as const, unit: "requests" };
}

function decimal(value = "0") {
  return { representation: "decimal" as const, unit: "requests", value };
}

function metric() {
  return {
    baseline: decimal("1"),
    candidate: decimal("2"),
    delta: decimal("1"),
    direction: "increased" as const,
    status: "available" as const,
  };
}

function interval() {
  return {
    confidenceLevelBasisPoints: 9_500,
    lowerBound: "0.1",
    method: "wilson_score_interval" as const,
    methodVersion: "1.0.0" as const,
    successCount: 1,
    trialCount: 2,
    upperBound: "0.9",
  };
}

interface InvalidCase {
  readonly input: unknown;
  readonly label: string;
  readonly schema: z.ZodType;
}

const malformedIntegers = ["bad", "", " 1", "0x10", "1e3", "1.5", "01", "9".repeat(129)];
const malformedDecimals = ["bad", "", "0x10", "1e3", "NaN", "9".repeat(19), `0.${"1".repeat(19)}`];
const invalidCases: InvalidCase[] = [
  ...(["numerator", "denominator"] as const).flatMap((field) =>
    malformedIntegers.flatMap((value, index) => {
      const input = { ...rational(), [field]: value };
      return [
        {
          input,
          label: `rational ${field} format ${index}`,
          schema: ComparisonExactValueSchema,
        },
        ...(["baseline", "candidate", "delta"] as const).map((role) => ({
          input: { ...metric(), [role]: input },
          label: `nested rational ${role} ${field} format ${index}`,
          schema: ComparisonMetricValueSchema,
        })),
      ];
    }),
  ),
  ...(["baseline", "candidate", "delta"] as const).flatMap((role) =>
    malformedDecimals.map((value, index) => ({
      input: { ...metric(), [role]: decimal(value) },
      label: `metric decimal ${role} format ${index}`,
      schema: ComparisonMetricValueSchema,
    })),
  ),
  ...(["lowerBound", "upperBound"] as const).flatMap((field) =>
    [...malformedDecimals, "-0.1", "2", "1.0000000000000000001"].map((value, index) => ({
      input: { ...interval(), [field]: value },
      label: `interval ${field} format ${index}`,
      schema: WilsonIntervalSchema,
    })),
  ),
];

describe("exact number validation before arithmetic", () => {
  it.each(invalidCases)(
    "rejects $label without entering BigInt arithmetic",
    ({ input, schema }) => {
      const arithmetic = vi.spyOn(globalThis, "BigInt");
      try {
        const parsed = schema.safeParse(input);
        expect(parsed.success).toBe(false);
        expect(arithmetic).not.toHaveBeenCalled();
      } finally {
        arithmetic.mockRestore();
      }
    },
  );

  it("preserves valid exact values, deltas, and interval bytes", () => {
    for (const input of [
      rational(),
      rational("-1", "3"),
      rational("9".repeat(128)),
      decimal("1.20"),
    ]) {
      expect(ComparisonExactValueSchema.parse(input)).toEqual(input);
    }
    expect(ComparisonMetricValueSchema.parse(metric())).toEqual(metric());
    expect(WilsonIntervalSchema.parse(interval())).toEqual(interval());
  });

  it("still checks numeric invariants after every child field is valid", () => {
    expect(ComparisonExactValueSchema.safeParse(rational("2", "4")).success).toBe(false);
    expect(ComparisonExactValueSchema.safeParse(rational("0", "2")).success).toBe(false);
    expect(ComparisonExactValueSchema.safeParse(rational("1", "0")).success).toBe(false);
    expect(ComparisonExactValueSchema.safeParse(rational("1", "-1")).success).toBe(false);
    expect(
      ComparisonMetricValueSchema.safeParse({ ...metric(), delta: decimal("2") }).success,
    ).toBe(false);
    expect(
      ComparisonMetricValueSchema.safeParse({ ...metric(), direction: "unchanged" }).success,
    ).toBe(false);
    expect(
      WilsonIntervalSchema.safeParse({ ...interval(), lowerBound: "0.9", upperBound: "0.1" })
        .success,
    ).toBe(false);
    expect(WilsonIntervalSchema.safeParse({ ...interval(), successCount: 3 }).success).toBe(false);
  });
});
