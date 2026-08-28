import { describe, expect, it } from "vitest";
import { SystemClock } from "./clock.js";

describe("SystemClock", () => {
  it("returns the current time", () => {
    const before = Date.now();
    const current = new SystemClock().now().getTime();
    const after = Date.now();

    expect(current).toBeGreaterThanOrEqual(before);
    expect(current).toBeLessThanOrEqual(after);
  });
});
