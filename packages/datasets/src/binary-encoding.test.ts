import { describe, expect, it, vi } from "vitest";
import {
  concatenateBytes,
  encodeBoolean,
  encodeOptional,
  encodeSequence,
  encodeString,
  encodeUnsigned32,
} from "./binary-encoding.js";

const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");

describe("fixed binary primitives", () => {
  it("encodes booleans as one strict byte", () => {
    expect(hex(encodeBoolean(false))).toBe("00");
    expect(hex(encodeBoolean(true))).toBe("01");
    expect(() => encodeBoolean(1 as unknown as boolean)).toThrow(TypeError);
  });

  it.each([
    [0, "00000000"],
    [1, "00000001"],
    [255, "000000ff"],
    [256, "00000100"],
    [65_535, "0000ffff"],
    [65_536, "00010000"],
    [0xffff_ffff, "ffffffff"],
  ] as const)("encodes U32(%d) in network byte order", (value, expected) => {
    expect(hex(encodeUnsigned32(value))).toBe(expected);
  });

  it.each([-1, 0.5, 0x1_0000_0000, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid U32 value %s",
    (value) => {
      expect(() => encodeUnsigned32(value)).toThrow(RangeError);
    },
  );

  it.each([
    ["", "00000000"],
    ["é", "00000002c3a9"],
    ["한", "00000003ed959c"],
    ["🧪", "00000004f09fa7aa"],
  ] as const)("prefixes %j with its UTF-8 byte length", (value, expected) => {
    expect(hex(encodeString(value))).toBe(expected);
  });

  it("uses an exact option marker and invokes the encoder only when present", () => {
    const encode = vi.fn(encodeString);

    expect(hex(encodeOptional(undefined, encode))).toBe("00");
    expect(encode).not.toHaveBeenCalled();
    expect(hex(encodeOptional("x", encode))).toBe("010000000178");
    expect(encode).toHaveBeenCalledExactlyOnceWith("x");
  });

  it("uses a sequence count and unambiguous element framing", () => {
    expect(hex(encodeSequence([], encodeString))).toBe("00000000");
    expect(hex(encodeSequence(["ab", "c"], encodeString))).toBe("000000020000000261620000000163");
    expect(hex(encodeSequence(["a", "bc"], encodeString))).toBe("000000020000000161000000026263");
    expect(encodeSequence(["ab", "c"], encodeString)).not.toEqual(
      encodeSequence(["a", "bc"], encodeString),
    );
  });

  it("concatenates an empty or populated byte sequence without aliasing an input", () => {
    expect(concatenateBytes([])).toEqual(new Uint8Array());
    const source = Uint8Array.of(1, 2);
    const result = concatenateBytes([source, Uint8Array.of(3)]);
    source[0] = 9;
    expect(result).toEqual(Uint8Array.of(1, 2, 3));
  });
});
