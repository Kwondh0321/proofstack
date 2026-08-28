import { describe, expect, it } from "vitest";
import { parseTraceLookup } from "./trace-lookup.js";

describe("parseTraceLookup", () => {
  it("distinguishes an untouched lookup from invalid input", () => {
    expect(parseTraceLookup(undefined)).toEqual({ status: "empty" });
    expect(parseTraceLookup("   ")).toEqual({ status: "invalid", value: "" });
    expect(parseTraceLookup("not-a-trace")).toEqual({
      status: "invalid",
      value: "not-a-trace",
    });
  });

  it("normalizes and accepts a valid trace identifier", () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

    expect(parseTraceLookup(`  ${traceId}  `)).toEqual({ status: "valid", traceId });
  });
});
