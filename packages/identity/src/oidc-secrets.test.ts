import { describe, expect, it } from "vitest";
import {
  browserSessionDigest,
  generateBrowserSessionCredentials,
  generateOidcLoginSecrets,
  generateOidcTransactionSecret,
  OidcLoginTransactionCipher,
  OidcSecretFormatError,
  OidcTransactionProtectionError,
  oidcStateDigest,
  verifyBrowserCsrfToken,
} from "./oidc-secrets.js";

function source(start = 1) {
  let value = start;
  return (size: number) => {
    const result = new Uint8Array(size).fill(value);
    value += 1;
    return result;
  };
}

describe("OIDC login secrets", () => {
  it("generates independent state, nonce, verifier, and an S256 challenge", () => {
    const secrets = generateOidcLoginSecrets(source());

    expect(secrets.state).toHaveLength(43);
    expect(secrets.nonce).toHaveLength(43);
    expect(secrets.codeVerifier).toHaveLength(43);
    expect(new Set([secrets.state, secrets.nonce, secrets.codeVerifier]).size).toBe(3);
    expect(secrets.codeChallenge).toHaveLength(43);
    expect(secrets.stateDigest).toBe(oidcStateDigest(secrets.state));
    expect(secrets.stateDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects malformed state before hashing", () => {
    expect(() => oidcStateDigest("invalid")).toThrow(OidcSecretFormatError);
  });
});

describe("OIDC login transaction protection", () => {
  it("round trips a strict payload with authenticated encryption", () => {
    const secret = generateOidcTransactionSecret(source(20));
    const cipher = new OidcLoginTransactionCipher(secret);
    const login = generateOidcLoginSecrets(source(30));
    const payload = {
      codeVerifier: login.codeVerifier,
      nonce: login.nonce,
      returnTo: "/traces?view=recent",
      state: login.state,
    };
    const encrypted = cipher.encrypt(payload, source(40));

    expect(encrypted).toMatch(/^otx_v1_/);
    expect(encrypted).not.toContain(login.codeVerifier);
    expect(cipher.decrypt(encrypted)).toEqual(payload);
  });

  it("rejects tampering, a different key, and unbounded return locations", () => {
    const cipher = new OidcLoginTransactionCipher(generateOidcTransactionSecret(source(50)));
    const login = generateOidcLoginSecrets(source(60));
    const encrypted = cipher.encrypt(
      {
        codeVerifier: login.codeVerifier,
        nonce: login.nonce,
        returnTo: "/",
        state: login.state,
      },
      source(70),
    );
    const replacement = encrypted.endsWith("A") ? "B" : "A";

    expect(() => cipher.decrypt(`${encrypted.slice(0, -1)}${replacement}`)).toThrow(
      OidcTransactionProtectionError,
    );
    const other = new OidcLoginTransactionCipher(generateOidcTransactionSecret(source(80)));
    expect(() => other.decrypt(encrypted)).toThrow(OidcTransactionProtectionError);
    expect(() =>
      cipher.encrypt({
        codeVerifier: login.codeVerifier,
        nonce: login.nonce,
        returnTo: "https://attacker.example/redirect",
        state: login.state,
      }),
    ).toThrow(OidcSecretFormatError);
  });

  it("rejects malformed plaintext and ciphertext without exposing a parser oracle", () => {
    const cipher = new OidcLoginTransactionCipher(generateOidcTransactionSecret(source(81)));
    const login = generateOidcLoginSecrets(source(82));

    expect(() => cipher.encrypt(null as unknown as Parameters<typeof cipher.encrypt>[0])).toThrow(
      OidcSecretFormatError,
    );
    expect(() =>
      cipher.encrypt({
        codeVerifier: login.codeVerifier,
        nonce: login.nonce,
        returnTo: "//attacker.example",
        state: login.state,
      }),
    ).toThrow(OidcSecretFormatError);
    expect(() => cipher.decrypt("not-a-transaction")).toThrow(OidcTransactionProtectionError);
    expect(() => cipher.decrypt("otx_v1_AAAAAAAAAAAAAAAA_A_AAAAAAAAAAAAAAAAAAAAAA")).toThrow(
      OidcTransactionProtectionError,
    );
  });

  it("normalizes unexpected encryption failures to a stable protection error", () => {
    const cipher = new OidcLoginTransactionCipher(generateOidcTransactionSecret(source(83)));
    const input = new Proxy({} as Parameters<typeof cipher.encrypt>[0], {
      ownKeys() {
        throw new Error("unexpected object failure");
      },
    });

    expect(() => cipher.encrypt(input)).toThrow(OidcTransactionProtectionError);
  });

  it("requires one canonical 256-bit transaction key", () => {
    expect(() => new OidcLoginTransactionCipher("short-secret")).toThrow(OidcSecretFormatError);
    expect(() => new OidcLoginTransactionCipher("not+base64url")).toThrow(OidcSecretFormatError);
    expect(() => generateOidcTransactionSecret(() => new Uint8Array(31))).toThrow(
      OidcSecretFormatError,
    );
  });
});

describe("browser session secrets", () => {
  it("generates domain-separated session and CSRF credentials", () => {
    const credentials = generateBrowserSessionCredentials(source(90));

    expect(credentials.sessionToken).toMatch(/^pss_v1_/);
    expect(credentials.csrfToken).toMatch(/^psc_v1_/);
    expect(credentials.sessionDigest).toBe(browserSessionDigest(credentials.sessionToken));
    expect(credentials.csrfDigest).not.toBe(credentials.sessionDigest);
    expect(verifyBrowserCsrfToken(credentials.csrfToken, credentials.csrfDigest)).toBe(true);
    expect(
      verifyBrowserCsrfToken(
        credentials.csrfToken.replace("psc_v1_", "pss_v1_"),
        credentials.csrfDigest,
      ),
    ).toBe(false);
  });

  it("rejects malformed session and CSRF material without throwing from verification", () => {
    expect(() => browserSessionDigest("invalid-session")).toThrow(OidcSecretFormatError);
    expect(verifyBrowserCsrfToken("invalid-csrf", "invalid-digest")).toBe(false);
  });
});
