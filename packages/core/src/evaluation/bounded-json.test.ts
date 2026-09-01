import { describe, expect, it } from "vitest";
import { BoundedJsonParseError, MAX_BOUNDED_JSON_DEPTH, parseBoundedJson } from "./bounded-json.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("bounded strict JSON parser", () => {
  it("parses every JSON value kind and counts exact value nodes", () => {
    const result = parseBoundedJson(
      bytes('{"array":[true,false,null,-12.5e+2,"line\\nfeed"],"empty":{}}'),
      32,
    );
    expect(result.value).toEqual({
      array: [true, false, null, -1_250, "line\nfeed"],
      empty: {},
    });
    expect(result.nodeCount).toBe(8);
    expect(parseBoundedJson(bytes("[]"), 1)).toEqual({ nodeCount: 1, value: [] });
  });

  it("accepts legal escapes and non-ASCII scalar strings", () => {
    expect(parseBoundedJson(bytes('"한글 \\uD83D\\uDE80 \\/ \\b \\f \\r \\t"'), 1).value).toBe(
      "한글 🚀 / \b \f \r \t",
    );
  });

  it.each([
    ['{"a":1,"a":2}', "Duplicate object property"],
    ['{"outer":{"a":1,"a":2}}', "Duplicate object property"],
    ['{"a" 1}', "Expected a colon"],
    ['{"a":1,}', "Expected an object property name"],
    ["[1,]", "Expected a JSON value"],
    ["[1 2]", "Expected a comma"],
    ['"unterminated', "Unterminated JSON string"],
    ['"bad\\xescape"', "Invalid escape"],
    ['"bad\\u12xz"', "Invalid Unicode escape"],
    ['"control\u0001"', "Unescaped control character"],
    ["01", "leading zeroes"],
    ["1.", "Expected a digit"],
    ["1e+", "Expected a digit"],
    ["tru", "Invalid true literal"],
    ["fals", "Invalid false literal"],
    ["nul", "Invalid null literal"],
    ["null trailing", "Unexpected content"],
    ["", "Expected a JSON value"],
  ])("rejects non-strict JSON %j", (source, message) => {
    expect(() => parseBoundedJson(bytes(source), 32)).toThrow(message);
  });

  it("rejects invalid UTF-8, non-finite numbers, and unpaired escaped surrogates", () => {
    expect(() => parseBoundedJson(Uint8Array.of(0xc3, 0x28), 1)).toThrow("valid UTF-8");
    expect(() => parseBoundedJson(bytes("1e9999"), 1)).toThrow("represented canonically");
    expect(() => parseBoundedJson(bytes('"\\uD800"'), 1)).toThrow("represented canonically");
  });

  it("enforces global node and nesting limits", () => {
    expect(() => parseBoundedJson(bytes("[1,2,3]"), 3)).toThrow("node limit exceeded");
    const nested = `${"[".repeat(MAX_BOUNDED_JSON_DEPTH + 1)}0${"]".repeat(
      MAX_BOUNDED_JSON_DEPTH + 1,
    )}`;
    expect(() => parseBoundedJson(bytes(nested), MAX_BOUNDED_JSON_DEPTH + 2)).toThrow(
      "nesting depth exceeded",
    );
  });

  it("rejects invalid parser limits with a typed range error", () => {
    expect(() => parseBoundedJson(bytes("null"), 0)).toThrow(RangeError);
    expect(() => parseBoundedJson(bytes("null"), Number.MAX_VALUE)).toThrow(RangeError);
  });

  it("reports a stable character offset on syntax errors", () => {
    try {
      parseBoundedJson(bytes('{"ok":true,"bad":]'), 8);
      throw new Error("Expected strict parsing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(BoundedJsonParseError);
      expect((error as BoundedJsonParseError).characterOffset).toBe(17);
    }
  });
});
