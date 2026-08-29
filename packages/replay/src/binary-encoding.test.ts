import { describe, expect, it } from "vitest";
import {
  concatenateBytes,
  encodeBytes,
  encodeString,
  encodeUnsigned32,
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
});
