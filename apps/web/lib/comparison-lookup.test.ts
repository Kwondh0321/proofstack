import { describe, expect, it } from "vitest";
import { parseComparisonLookup } from "./comparison-lookup.js";

describe("parseComparisonLookup", () => {
  it("distinguishes an absent query from an invalid identifier", () => {
    expect(parseComparisonLookup(undefined)).toEqual({ status: "empty" });
    expect(parseComparisonLookup("   ")).toEqual({ status: "invalid", value: "" });
  });

  it("normalizes and accepts a bounded opaque result identifier", () => {
    expect(parseComparisonLookup("  result_release_candidate_42  ")).toEqual({
      resultId: "result_release_candidate_42",
      status: "valid",
    });
  });

  it.each([
    "contains spaces",
    "contains/slash",
    "contains?query",
    "x".repeat(129),
    "../result_escape",
  ])("rejects unsafe lookup value %j", (value) => {
    expect(parseComparisonLookup(value)).toEqual({ status: "invalid", value });
  });
});
