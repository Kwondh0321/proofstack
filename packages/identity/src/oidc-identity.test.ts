import { describe, expect, it } from "vitest";
import {
  OidcIdentityFormatError,
  oidcIdentityDigest,
  requireOidcIssuer,
  requireOidcSubject,
} from "./oidc-identity.js";

describe("OIDC identity", () => {
  it("preserves an exact safe issuer and creates a stable domain-separated identity digest", () => {
    const issuer = "https://identity.example.test/tenant";
    expect(requireOidcIssuer(issuer)).toBe(issuer);
    expect(oidcIdentityDigest(issuer, "subject-001")).toBe(
      "6f2a5f48a154548f67c3bdfeb1533b6b79a6282356b3b58ec5ed433cda9c6ee0",
    );
    expect(oidcIdentityDigest(issuer, "subject-002")).not.toBe(
      oidcIdentityDigest(issuer, "subject-001"),
    );
    expect(oidcIdentityDigest(`${issuer}/subject-001`, "subject-002")).not.toBe(
      oidcIdentityDigest(issuer, "subject-001/subject-002"),
    );
  });

  it.each([
    "",
    "not-a-url",
    "http://identity.example.test",
    "https://user@identity.example.test",
    "https://:secret@identity.example.test",
    "https://identity.example.test?tenant=one",
    "https://identity.example.test#tenant",
    " https://identity.example.test",
    "https://identity.example.test/path with space",
    "https://identity.example.test/bad\\path",
    "https://identity.example.test/bad\npath",
    `https://identity.example.test/${"가".repeat(680)}`,
  ])("rejects unsafe issuer %j", (issuer) => {
    expect(() => requireOidcIssuer(issuer)).toThrow(OidcIdentityFormatError);
  });

  it("accepts an exact opaque subject", () => {
    expect(requireOidcSubject("provider subject/한글")).toBe("provider subject/한글");
  });

  it.each(["", "bad\u0000subject", "가".repeat(171)])("rejects unsafe subject %j", (subject) => {
    expect(() => requireOidcSubject(subject)).toThrow(OidcIdentityFormatError);
  });
});
