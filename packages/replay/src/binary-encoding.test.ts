import { describe, expect, it } from "vitest";
import {
  concatenateBytes,
  encodeBoolean,
  encodeBytes,
  encodeOptional,
  encodeSequence,
  encodeString,
  encodeUnsigned32,
  encodeUnsignedSafeInteger,
} from "./binary-encoding.js";

const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");

describe("replay binary encoding", () => {
  it("concatenates bytes without sharing mutable input storage", () => {
    const left = Uint8Array.of(1, 2);
    const encoded = concatenateBytes([left, Uint8Array.of(3)]);
    left[0] = 9;
    expect([...encoded]).toEqual([1, 2, 3]);
  });

  it.each([
    [0, "00000000"],
    [1, "00000001"],
    [0xffff_ffff, "ffffffff"],
  ] as const)("encodes unsigned 32-bit value %s", (value, expected) => {
    expect(hex(encodeUnsigned32(value))).toBe(expected);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 0x1_0000_0000])(
    "rejects invalid unsigned value %s",
    (value) => {
      expect(() => encodeUnsigned32(value)).toThrow(RangeError);
    },
  );

  it("length-prefixes exact bytes and UTF-8 strings", () => {
    expect(hex(encodeBytes(Uint8Array.of(0, 255)))).toBe("0000000200ff");
    expect(hex(encodeString("A🧪"))).toBe("0000000541f09fa7aa");
  });

  it("encodes booleans with one canonical byte", () => {
    expect(hex(encodeBoolean(false))).toBe("00");
    expect(hex(encodeBoolean(true))).toBe("01");
    expect(() => encodeBoolean("true" as never)).toThrow(TypeError);
  });

  it.each([
    [0, "0000000000000000"],
    [1, "0000000000000001"],
    [Number.MAX_SAFE_INTEGER, "001fffffffffffff"],
  ] as const)("encodes safe integer %s as unsigned 64-bit big-endian", (value, expected) => {
    expect(hex(encodeUnsignedSafeInteger(value))).toBe(expected);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid safe integer %s",
    (value) => {
      expect(() => encodeUnsignedSafeInteger(value)).toThrow(RangeError);
    },
  );

  it("encodes optional values and ordered sequences without ambiguity", () => {
    expect(hex(encodeOptional(undefined, encodeString))).toBe("00");
    expect(hex(encodeOptional("A", encodeString))).toBe("010000000141");
    expect(hex(encodeSequence(["A", "B"], encodeString))).toBe("0000000200000001410000000142");
  });
});
