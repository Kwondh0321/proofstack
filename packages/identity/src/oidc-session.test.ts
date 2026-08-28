import { describe, expect, it } from "vitest";
import type { AuthenticatableBrowserSession, BrowserSessionLookup } from "./oidc-session.js";
import {
  InvalidBrowserCsrfError,
  InvalidBrowserSessionError,
  OidcSessionAuthenticator,
  OidcSessionLifecycle,
  requireBrowserCsrfToken,
} from "./oidc-session.js";
import { generateBrowserSessionCredentials } from "./oidc-secrets.js";

function source(value: number) {
  return (size: number) => new Uint8Array(size).fill(value);
}

function fixture(overrides: Partial<AuthenticatableBrowserSession> = {}) {
  const credentials = generateBrowserSessionCredentials(source(11));
  const session = {
    capabilities: ["project:read", "evidence:read", "identity:manage"],
    createdAt: "2026-08-28T10:00:00.000Z",
    csrfDigest: credentials.csrfDigest,
    principalId: "usr_browser_operator",
    resourceScope: {
      mode: "restricted",
      projects: [{ environmentIds: ["env_production"], projectId: "prj_agent" }],
    },
    roles: ["admin"],
    sessionDigest: credentials.sessionDigest,
    sessionId: "ses_browser_session",
    tenantId: "ten_browser_identity",
    ...overrides,
  } satisfies AuthenticatableBrowserSession;
  const lookup = {
    calls: [] as string[],
    result: session as AuthenticatableBrowserSession | null,
    async findAndTouchActive(sessionDigest: string) {
      this.calls.push(sessionDigest);
      return this.result;
    },
  };
  return { credentials, lookup, session };
}

describe("OidcSessionAuthenticator", () => {
  it("constructs a user principal from the current authoritative binding", async () => {
    const value = fixture();
    const result = await new OidcSessionAuthenticator(value.lookup).authenticate(
      value.credentials.sessionToken,
      "req_browser_session_001",
    );

    expect(value.lookup.calls).toEqual([value.credentials.sessionDigest]);
    expect(result).toEqual({
      csrfDigest: value.credentials.csrfDigest,
      principal: {
        authentication: {
          authenticatedAt: value.session.createdAt,
          credentialId: value.session.sessionId,
          method: "oidc",
        },
        capabilities: value.session.capabilities,
        principalId: value.session.principalId,
        principalType: "user",
        requestId: "req_browser_session_001",
        resourceScope: value.session.resourceScope,
        roles: value.session.roles,
        tenantId: value.session.tenantId,
      },
      sessionDigest: value.credentials.sessionDigest,
    });
  });

  it("rejects malformed tokens without querying identity storage", async () => {
    const value = fixture();

    await expect(
      new OidcSessionAuthenticator(value.lookup).authenticate("malformed", "req_malformed"),
    ).rejects.toBeInstanceOf(InvalidBrowserSessionError);
    expect(value.lookup.calls).toHaveLength(0);
  });

  it("uses one generic error for unknown, expired, and revoked sessions", async () => {
    const value = fixture();
    value.lookup.result = null;

    await expect(
      new OidcSessionAuthenticator(value.lookup).authenticate(
        value.credentials.sessionToken,
        "req_inactive",
      ),
    ).rejects.toEqual(
      expect.objectContaining({ message: "Browser session is invalid or expired" }),
    );
  });

  it("detects a session digest returned for a different lookup", async () => {
    const value = fixture({ sessionDigest: "f".repeat(64) });

    await expect(
      new OidcSessionAuthenticator(value.lookup).authenticate(
        value.credentials.sessionToken,
        "req_mismatch",
      ),
    ).rejects.toThrow("different session digest");
  });

  it("detects corrupt CSRF and authorization metadata", async () => {
    const csrf = fixture({ csrfDigest: "invalid" });
    await expect(
      new OidcSessionAuthenticator(csrf.lookup).authenticate(
        csrf.credentials.sessionToken,
        "req_csrf_corrupt",
      ),
    ).rejects.toThrow("CSRF digest is invalid");

    const authorization = fixture({ tenantId: "INVALID" });
    await expect(
      new OidcSessionAuthenticator(authorization.lookup).authenticate(
        authorization.credentials.sessionToken,
        "req_authorization_corrupt",
      ),
    ).rejects.toThrow("authorization is invalid");
  });

  it("preserves unexpected identity storage failures", async () => {
    const value = fixture();
    const unavailable = new Error("identity storage unavailable");
    const lookup: BrowserSessionLookup = {
      findAndTouchActive: async () => {
        throw unavailable;
      },
    };

    await expect(
      new OidcSessionAuthenticator(lookup).authenticate(
        value.credentials.sessionToken,
        "req_storage",
      ),
    ).rejects.toBe(unavailable);
  });
});

describe("browser session mutation controls", () => {
  it("accepts only the CSRF token paired with the authenticated session", () => {
    const value = fixture();

    expect(() =>
      requireBrowserCsrfToken(value.credentials.csrfToken, value.credentials.csrfDigest),
    ).not.toThrow();
    expect(() =>
      requireBrowserCsrfToken(
        generateBrowserSessionCredentials(source(12)).csrfToken,
        value.credentials.csrfDigest,
      ),
    ).toThrow(InvalidBrowserCsrfError);
  });

  it("revokes the exact authenticated session digest and remains idempotent", async () => {
    const value = fixture();
    const authenticated = await new OidcSessionAuthenticator(value.lookup).authenticate(
      value.credentials.sessionToken,
      "req_logout",
    );
    const calls: string[] = [];
    let active = true;
    const lifecycle = new OidcSessionLifecycle({
      revokeActive: async (sessionDigest) => {
        calls.push(sessionDigest);
        const result = active;
        active = false;
        return result;
      },
    });

    await expect(lifecycle.revoke(authenticated)).resolves.toBe(true);
    await expect(lifecycle.revoke(authenticated)).resolves.toBe(false);
    expect(calls).toEqual([value.credentials.sessionDigest, value.credentials.sessionDigest]);
  });

  it("preserves session revocation storage failures", async () => {
    const value = fixture();
    const authenticated = await new OidcSessionAuthenticator(value.lookup).authenticate(
      value.credentials.sessionToken,
      "req_logout_failure",
    );
    const unavailable = new Error("revocation storage unavailable");
    const lifecycle = new OidcSessionLifecycle({
      revokeActive: async () => {
        throw unavailable;
      },
    });

    await expect(lifecycle.revoke(authenticated)).rejects.toBe(unavailable);
  });
});
