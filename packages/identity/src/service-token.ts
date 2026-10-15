import { randomBytes } from "node:crypto";

// Shared cryptographic primitive only. API credential parsing/authentication is never reused.
export {
  hashApiKeySecret as hashServiceTokenSecret,
  verifyApiKeySecret as verifyServiceTokenSecret,
  type ApiKeyPasswordHash as ServiceTokenPasswordHash,
} from "./api-key.js";

const SERVICE_TOKEN_PATTERN = /^pss_v1_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/;
const RANDOM_BYTES = 48;
export interface ServiceTokenParts {
  readonly prefix: string;
  readonly secret: string;
}
export class ServiceTokenFormatError extends Error {
  constructor() {
    super("Service token format is invalid");
    this.name = "ServiceTokenFormatError";
  }
}
function canonical(value: string) {
  const decoded = Buffer.from(value, "base64url");
  // The fixed encoded lengths in SERVICE_TOKEN_PATTERN already bind 16/32 decoded bytes.
  if (decoded.toString("base64url") !== value) throw new ServiceTokenFormatError();
  return value;
}
/** Server-side issuance only. The raw value must never enter source, URLs, logs or job delivery. */
export function generateServiceToken(source: (size: number) => Uint8Array = randomBytes) {
  const bytes = source(RANDOM_BYTES);
  if (bytes.length !== RANDOM_BYTES) throw new ServiceTokenFormatError();
  const material = Buffer.from(bytes);
  const prefix = material.subarray(0, 16).toString("base64url");
  const secret = material.subarray(16).toString("base64url");
  return { prefix, secret, value: `pss_v1_${prefix}_${secret}` };
}
export function parseServiceToken(value: string): ServiceTokenParts {
  const match = SERVICE_TOKEN_PATTERN.exec(value);
  const prefix = match?.[1],
    secret = match?.[2];
  if (!prefix || !secret) throw new ServiceTokenFormatError();
  return { prefix: canonical(prefix), secret: canonical(secret) };
}
