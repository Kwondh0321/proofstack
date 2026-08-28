function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createEventId(): string {
  return `evt_${randomHex(16)}`;
}

export function createTraceId(): string {
  return randomHex(16);
}

export function createSpanId(): string {
  return randomHex(8);
}
