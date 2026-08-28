import { createHash } from "node:crypto";

const MAX_ISSUER_BYTES = 2_048;
const MAX_SUBJECT_BYTES = 512;
const DIGEST_DOMAIN = Buffer.from("proofstack:oidc-identity:v1\0", "utf8");

export class OidcIdentityFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OidcIdentityFormatError";
  }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

export function requireOidcIssuer(value: string): string {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_ISSUER_BYTES ||
    hasControlCharacter(value) ||
    /\s|\\/.test(value)
  ) {
    throw new OidcIdentityFormatError("OIDC issuer is invalid");
  }

  let issuer: URL;
  try {
    issuer = new URL(value);
  } catch (error) {
    throw new OidcIdentityFormatError("OIDC issuer is invalid", { cause: error });
  }
  if (
    issuer.protocol !== "https:" ||
    issuer.username !== "" ||
    issuer.password !== "" ||
    issuer.search !== "" ||
    issuer.hash !== ""
  ) {
    throw new OidcIdentityFormatError(
      "OIDC issuer must be an HTTPS URL without credentials, query, or fragment",
    );
  }
  return value;
}

export function requireOidcSubject(value: string): string {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_SUBJECT_BYTES ||
    hasControlCharacter(value)
  ) {
    throw new OidcIdentityFormatError("OIDC subject is invalid");
  }
  return value;
}

function lengthPrefix(value: Buffer): Buffer {
  const result = Buffer.allocUnsafe(4);
  result.writeUInt32BE(value.length);
  return result;
}

export function oidcIdentityDigest(issuer: string, subject: string): string {
  const issuerBytes = Buffer.from(requireOidcIssuer(issuer), "utf8");
  const subjectBytes = Buffer.from(requireOidcSubject(subject), "utf8");
  return createHash("sha256")
    .update(DIGEST_DOMAIN)
    .update(lengthPrefix(issuerBytes))
    .update(issuerBytes)
    .update(lengthPrefix(subjectBytes))
    .update(subjectBytes)
    .digest("hex");
}
