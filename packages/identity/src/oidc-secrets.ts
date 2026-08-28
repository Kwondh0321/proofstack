import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const OPAQUE_BYTES = 32;
const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 12;
const AES_TAG_BYTES = 16;
const TRANSACTION_AAD = Buffer.from("proofstack:oidc-login:v1", "utf8");
const TRANSACTION_PATTERN =
  /^otx_v1_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{1,4096})_([A-Za-z0-9_-]{22})$/;
const SESSION_PATTERN = /^pss_v1_([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/;
const CSRF_PATTERN = /^psc_v1_([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/;
const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Redirect targets must reject every ASCII control character.
const RETURN_PATH_PATTERN = /^\/(?!\/)[^\\\u0000-\u001f\u007f]{0,1023}$/;

type RandomSource = (size: number) => Uint8Array;
type OidcLoginTransactionRecord = Record<string, unknown> & {
  codeVerifier?: unknown;
  nonce?: unknown;
  returnTo?: unknown;
  state?: unknown;
};

export interface OidcLoginSecrets {
  readonly codeChallenge: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly state: string;
  readonly stateDigest: string;
}

export interface OidcLoginTransactionPayload {
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly returnTo: string;
  readonly state: string;
}

export interface BrowserSessionCredentials {
  readonly csrfDigest: string;
  readonly csrfToken: string;
  readonly sessionDigest: string;
  readonly sessionToken: string;
}

export class OidcSecretFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OidcSecretFormatError";
  }
}

export class OidcTransactionProtectionError extends Error {
  constructor(options?: ErrorOptions) {
    super("OIDC login transaction could not be protected or recovered", options);
    this.name = "OidcTransactionProtectionError";
  }
}

function bytes(source: RandomSource, size: number): Buffer {
  const value = Buffer.from(source(size));
  if (value.length !== size) {
    throw new OidcSecretFormatError(
      `Random source returned ${value.length} bytes; expected ${size}`,
    );
  }
  return value;
}

function canonicalBase64Url(value: string, expectedBytes: number, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new OidcSecretFormatError(`${label} is malformed`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== expectedBytes || decoded.toString("base64url") !== value) {
    throw new OidcSecretFormatError(`${label} is malformed`);
  }
  return decoded;
}

function digest(domain: "csrf" | "session" | "state", value: string): string {
  return createHash("sha256")
    .update(`proofstack:${domain}:v1\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function opaque(source: RandomSource): string {
  return bytes(source, OPAQUE_BYTES).toString("base64url");
}

function requireOpaque(value: string, label: string): string {
  if (!OPAQUE_PATTERN.test(value)) throw new OidcSecretFormatError(`${label} is malformed`);
  canonicalBase64Url(value, OPAQUE_BYTES, label);
  return value;
}

function payload(value: unknown): OidcLoginTransactionPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OidcSecretFormatError("OIDC login transaction payload is malformed");
  }
  const record = value as OidcLoginTransactionRecord;
  if (
    Object.keys(record).sort().join(",") !== "codeVerifier,nonce,returnTo,state" ||
    typeof record.codeVerifier !== "string" ||
    !CODE_VERIFIER_PATTERN.test(record.codeVerifier) ||
    typeof record.nonce !== "string" ||
    typeof record.state !== "string" ||
    typeof record.returnTo !== "string" ||
    !RETURN_PATH_PATTERN.test(record.returnTo)
  ) {
    throw new OidcSecretFormatError("OIDC login transaction payload is malformed");
  }
  requireOpaque(record.nonce, "OIDC nonce");
  requireOpaque(record.state, "OIDC state");
  return {
    codeVerifier: record.codeVerifier,
    nonce: record.nonce,
    returnTo: record.returnTo,
    state: record.state,
  };
}

export function generateOidcTransactionSecret(source: RandomSource = randomBytes): string {
  return opaque(source);
}

export function oidcStateDigest(state: string): string {
  return digest("state", requireOpaque(state, "OIDC state"));
}

export function generateOidcLoginSecrets(source: RandomSource = randomBytes): OidcLoginSecrets {
  const state = opaque(source);
  const nonce = opaque(source);
  const codeVerifier = opaque(source);
  const codeChallenge = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
  return { codeChallenge, codeVerifier, nonce, state, stateDigest: oidcStateDigest(state) };
}

export function generateBrowserSessionCredentials(
  source: RandomSource = randomBytes,
): BrowserSessionCredentials {
  const sessionToken = `pss_v1_${opaque(source)}`;
  const csrfToken = `psc_v1_${opaque(source)}`;
  return {
    csrfDigest: digest("csrf", csrfToken),
    csrfToken,
    sessionDigest: digest("session", sessionToken),
    sessionToken,
  };
}

export function browserSessionDigest(value: string): string {
  if (!SESSION_PATTERN.test(value)) throw new OidcSecretFormatError("Browser session is malformed");
  return digest("session", value);
}

export function verifyBrowserCsrfToken(value: string, expectedDigest: string): boolean {
  if (!CSRF_PATTERN.test(value) || !/^[0-9a-f]{64}$/.test(expectedDigest)) return false;
  const actual = Buffer.from(digest("csrf", value), "hex");
  const expected = Buffer.from(expectedDigest, "hex");
  return timingSafeEqual(actual, expected);
}

export class OidcLoginTransactionCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = canonicalBase64Url(secret, AES_KEY_BYTES, "OIDC transaction secret");
  }

  encrypt(input: OidcLoginTransactionPayload, source: RandomSource = randomBytes): string {
    try {
      const validated = payload(input);
      const iv = bytes(source, AES_IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", this.key, iv);
      cipher.setAAD(TRANSACTION_AAD);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(validated), "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return `otx_v1_${iv.toString("base64url")}_${ciphertext.toString("base64url")}_${tag.toString("base64url")}`;
    } catch (error) {
      if (error instanceof OidcSecretFormatError) throw error;
      throw new OidcTransactionProtectionError({ cause: error });
    }
  }

  decrypt(value: string): OidcLoginTransactionPayload {
    try {
      const match = TRANSACTION_PATTERN.exec(value);
      const ivValue = match?.[1];
      const ciphertextValue = match?.[2];
      const tagValue = match?.[3];
      if (!ivValue || !ciphertextValue || !tagValue) {
        throw new OidcSecretFormatError("OIDC login transaction ciphertext is malformed");
      }
      const iv = canonicalBase64Url(ivValue, AES_IV_BYTES, "OIDC transaction IV");
      const ciphertext = Buffer.from(ciphertextValue, "base64url");
      if (ciphertext.length === 0 || ciphertext.toString("base64url") !== ciphertextValue) {
        throw new OidcSecretFormatError("OIDC transaction ciphertext is malformed");
      }
      const tag = canonicalBase64Url(tagValue, AES_TAG_BYTES, "OIDC transaction tag");
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAAD(TRANSACTION_AAD);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
        "utf8",
      );
      return payload(JSON.parse(plaintext));
    } catch (error) {
      throw new OidcTransactionProtectionError({ cause: error });
    }
  }
}
