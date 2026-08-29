const MAX_UNSIGNED_32 = 0xffff_ffff;
const textEncoder = new TextEncoder();

export function encodeBoolean(value: boolean): Uint8Array {
  if (typeof value !== "boolean") {
    throw new TypeError("Binary encoding requires a boolean");
  }
  return Uint8Array.of(value ? 1 : 0);
}

export function concatenateBytes(parts: readonly Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts));
}

export function encodeUnsigned32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > MAX_UNSIGNED_32) {
    throw new RangeError("Binary encoding requires an unsigned 32-bit integer");
  }
  const encoded = new Uint8Array(4);
  new DataView(encoded.buffer).setUint32(0, value, false);
  return encoded;
}

export function encodeUnsignedSafeInteger(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Binary encoding requires a nonnegative safe integer");
  }
  const encoded = new Uint8Array(8);
  new DataView(encoded.buffer).setBigUint64(0, BigInt(value), false);
  return encoded;
}

export function encodeBytes(value: Uint8Array): Uint8Array {
  return concatenateBytes([encodeUnsigned32(value.byteLength), value]);
}

export function encodeString(value: string): Uint8Array {
  return encodeBytes(textEncoder.encode(value));
}

export function encodeOptional<T>(
  value: T | undefined,
  encode: (present: T) => Uint8Array,
): Uint8Array {
  return value === undefined
    ? Uint8Array.of(0)
    : concatenateBytes([Uint8Array.of(1), encode(value)]);
}

export function encodeSequence<T>(
  values: readonly T[],
  encode: (value: T) => Uint8Array,
): Uint8Array {
  return concatenateBytes([encodeUnsigned32(values.length), ...values.map(encode)]);
}
