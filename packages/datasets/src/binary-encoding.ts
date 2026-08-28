const MAX_UNSIGNED_32 = 0xffff_ffff;
const textEncoder = new TextEncoder();

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

export function encodeString(value: string): Uint8Array {
  const encoded = textEncoder.encode(value);
  return concatenateBytes([encodeUnsigned32(encoded.byteLength), encoded]);
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
