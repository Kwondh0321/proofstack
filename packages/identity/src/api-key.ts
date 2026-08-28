import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const API_KEY_PATTERN = /^psk_v1_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{43})$/;
const API_KEY_RANDOM_BYTES = 41;
const API_KEY_PREFIX_BYTES = 9;
const API_KEY_SECRET_BYTES = 32;
const API_KEY_SALT_BYTES = 16;
const SCRYPT_COST = 32_768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

type RandomBytes = (size: number) => Uint8Array;

export interface ApiKeyParts {
  readonly prefix: string;
  readonly secret: string;
}

export interface ApiKeyPasswordHash {
  readonly algorithm: "scrypt-v1";
  readonly blockSize: typeof SCRYPT_BLOCK_SIZE;
  readonly cost: typeof SCRYPT_COST;
  readonly digest: string;
  readonly keyLength: typeof SCRYPT_KEY_LENGTH;
  readonly parallelization: typeof SCRYPT_PARALLELIZATION;
  readonly salt: string;
}

export interface IssuedApiKey extends ApiKeyParts {
  readonly value: string;
}

export class ApiKeyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiKeyFormatError";
  }
}

export class ApiKeyHashError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApiKeyHashError";
  }
}

function canonicalBase64Url(value: string, expectedBytes: number, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ApiKeyFormatError(`${label} is malformed`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== expectedBytes || decoded.toString("base64url") !== value) {
    throw new ApiKeyFormatError(`${label} is malformed`);
  }
  return decoded;
}

function requireRandomBytes(bytes: Uint8Array, expected: number): Buffer {
  if (bytes.length !== expected) {
    throw new ApiKeyFormatError(
      `Random source returned ${bytes.length} bytes; expected ${expected}`,
    );
  }
  return Buffer.from(bytes);
}

function validateHash(hash: ApiKeyPasswordHash): {
  readonly digest: Buffer;
  readonly salt: Buffer;
} {
  if (
    hash.algorithm !== "scrypt-v1" ||
    hash.cost !== SCRYPT_COST ||
    hash.blockSize !== SCRYPT_BLOCK_SIZE ||
    hash.parallelization !== SCRYPT_PARALLELIZATION ||
    hash.keyLength !== SCRYPT_KEY_LENGTH
  ) {
    throw new ApiKeyHashError("API key hash parameters are unsupported");
  }
  try {
    return {
      digest: canonicalBase64Url(hash.digest, SCRYPT_KEY_LENGTH, "API key digest"),
      salt: canonicalBase64Url(hash.salt, API_KEY_SALT_BYTES, "API key salt"),
    };
  } catch (error) {
    throw new ApiKeyHashError("API key hash encoding is invalid", { cause: error });
  }
}

async function derive(secret: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      secret,
      salt,
      SCRYPT_KEY_LENGTH,
      {
        N: SCRYPT_COST,
        maxmem: SCRYPT_MAX_MEMORY,
        p: SCRYPT_PARALLELIZATION,
        r: SCRYPT_BLOCK_SIZE,
      },
      (error, result) => {
        /* v8 ignore next -- OpenSSL/platform KDF failures cannot be induced with validated constants. */
        if (error) reject(error);
        else resolve(result);
      },
    );
  });
}

export function generateApiKey(source: RandomBytes = randomBytes): IssuedApiKey {
  const bytes = requireRandomBytes(source(API_KEY_RANDOM_BYTES), API_KEY_RANDOM_BYTES);
  const prefix = bytes.subarray(0, API_KEY_PREFIX_BYTES).toString("base64url");
  const secret = bytes.subarray(API_KEY_PREFIX_BYTES).toString("base64url");
  return { prefix, secret, value: `psk_v1_${prefix}_${secret}` };
}

export function parseApiKey(value: string): ApiKeyParts {
  const match = API_KEY_PATTERN.exec(value);
  const prefix = match?.[1];
  const secret = match?.[2];
  if (!prefix || !secret) throw new ApiKeyFormatError("API key format is invalid");
  canonicalBase64Url(prefix, API_KEY_PREFIX_BYTES, "API key prefix");
  canonicalBase64Url(secret, API_KEY_SECRET_BYTES, "API key secret");
  return { prefix, secret };
}

export async function hashApiKeySecret(
  secret: string,
  source: RandomBytes = randomBytes,
): Promise<ApiKeyPasswordHash> {
  const secretBytes = canonicalBase64Url(secret, API_KEY_SECRET_BYTES, "API key secret");
  const salt = requireRandomBytes(source(API_KEY_SALT_BYTES), API_KEY_SALT_BYTES);
  const digest = await derive(secretBytes, salt);
  return {
    algorithm: "scrypt-v1",
    blockSize: SCRYPT_BLOCK_SIZE,
    cost: SCRYPT_COST,
    digest: digest.toString("base64url"),
    keyLength: SCRYPT_KEY_LENGTH,
    parallelization: SCRYPT_PARALLELIZATION,
    salt: salt.toString("base64url"),
  };
}

export async function verifyApiKeySecret(
  secret: string,
  hash: ApiKeyPasswordHash,
): Promise<boolean> {
  const secretBytes = canonicalBase64Url(secret, API_KEY_SECRET_BYTES, "API key secret");
  const stored = validateHash(hash);
  const candidate = await derive(secretBytes, stored.salt);
  return timingSafeEqual(candidate, stored.digest);
}
