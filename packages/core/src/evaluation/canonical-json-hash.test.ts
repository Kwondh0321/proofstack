import { describe, expect, it } from "vitest";
import { hashEvaluationCanonicalJson } from "./canonical-json-hash.js";

describe("canonical material SHA-256", () => {
  it("matches an independently generated Unicode/scalar byte vector regardless of key order", () => {
    // Python hashlib over UTF-8: {"a":[0,true,null,"é"],"한글":"😀"}
    const expected = "d573ab48de3469d3c2226362768c996650fe300db81afd0ac42b552989482deb";
    expect(hashEvaluationCanonicalJson({ 한글: "😀", a: [0, true, null, "é"] })).toBe(expected);
    expect(hashEvaluationCanonicalJson({ a: [0, true, null, "é"], 한글: "😀" })).toBe(expected);
  });
  it("recomputes mutable material rather than caching a prior hash", () => {
    const value = { selected: ["source_one"] };
    const before = hashEvaluationCanonicalJson(value);
    value.selected.push("source_two");
    expect(hashEvaluationCanonicalJson(value)).not.toBe(before);
  });
  it.each(["\ud800", undefined, Number.NaN, new Date(0)])(
    "preserves strict JSON admission for %j",
    (value) => {
      expect(() => hashEvaluationCanonicalJson(value)).toThrow();
    },
  );
});
