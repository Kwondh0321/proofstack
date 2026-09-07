import { describe, expect, it, vi } from "vitest";
import { evidenceTimestampOrderKey } from "./evidence.js";
import {
  POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";

describe("exact policy evaluation time", () => {
  it("preserves the full supported fraction instead of using the database cursor's rounding", () => {
    const first = "2026-09-07T00:00:00.000000000000000000000000000001Z";
    const second = "2026-09-07T00:00:00.000000000000000000000000000002Z";
    expect(PolicyEvaluationTimeSchema.parse(first)).toBe(first);
    expect(
      policyEvaluationTimestampOrderKey(second) - policyEvaluationTimestampOrderKey(first),
    ).toBe(1n);
    expect(evidenceTimestampOrderKey(first)).toBe(evidenceTimestampOrderKey(second));
  });

  it("orders epoch, pre-epoch, leap-day, and whole-second boundaries exactly", () => {
    expect(policyEvaluationTimestampOrderKey("1970-01-01T00:00:00Z")).toBe(0n);
    expect(policyEvaluationTimestampOrderKey("1970-01-01T00:00:00.001Z")).toBe(
      POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND,
    );
    expect(policyEvaluationTimestampOrderKey("1969-12-31T23:59:59.999Z")).toBe(
      -POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND,
    );
    expect(
      policyEvaluationTimestampOrderKey("2024-03-01T00:00:00Z") -
        policyEvaluationTimestampOrderKey("2024-02-29T23:59:59.999999999999999999999999999999Z"),
    ).toBe(1n);
    expect(policyEvaluationTimestampOrderKey("0001-01-01T00:00:00Z")).toBeLessThan(0n);
    expect(policyEvaluationTimestampOrderKey("9999-12-31T23:59:59.999Z")).toBeGreaterThan(0n);
  });

  it.each([
    "2026-09-07T12:00:00.123456789012345678901234567890Z",
    "2026-09-07T21:00:00.123456789012345678901234567890+09:00",
    "2026-09-07T04:00:00.123456789012345678901234567890-08:00",
    "2026-09-08T03:59:00.123456789012345678901234567890+15:59",
  ])("compares source offset %s at the same exact instant", (source) => {
    expect(policyEvaluationTimestampOrderKey(source)).toBe(
      policyEvaluationTimestampOrderKey("2026-09-07T12:00:00.123456789012345678901234567890Z"),
    );
    expect(PolicyEvaluationTimeSchema.safeParse(source).success).toBe(source.endsWith("Z"));
  });

  it("orders half-open validity and future-evidence edges without a millisecond tolerance", () => {
    const before = policyEvaluationTimestampOrderKey(
      "2026-09-07T00:00:00.499999999999999999999999999999Z",
    );
    const edge = policyEvaluationTimestampOrderKey("2026-09-07T00:00:00.5Z");
    const after = policyEvaluationTimestampOrderKey(
      "2026-09-07T00:00:00.500000000000000000000000000001Z",
    );
    expect(before < edge).toBe(true);
    expect(policyEvaluationTimestampOrderKey("2026-09-07T00:00:00.500Z") < edge).toBe(false);
    expect(after > edge).toBe(true);
    expect(policyEvaluationTimestampOrderKey("2026-09-07T00:00:00.500Z")).toBe(edge);
  });

  it.each([
    "bad",
    "",
    "2026-02-29T00:00:00Z",
    "0000-01-01T00:00:00Z",
    "2026-09-07T00:00:00.1234567890123456789012345678901Z",
    "2026-09-07T00:00:00+16:00",
    "2026-09-07T00:00:00Z\n",
    null,
    0,
  ])("rejects unsupported time %j before integer conversion", (value) => {
    const arithmetic = vi.spyOn(globalThis, "BigInt");
    try {
      expect(() => policyEvaluationTimestampOrderKey(value as never)).toThrow();
      expect(arithmetic).not.toHaveBeenCalled();
    } finally {
      arithmetic.mockRestore();
    }
  });
});
