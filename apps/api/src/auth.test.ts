import { PrincipalContextSchema } from "@proofstack/contracts";
import {
  generateBrowserSessionCredentials,
  InvalidApiKeyError,
  InvalidBrowserSessionError,
} from "@proofstack/identity";
import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  ApiKeyRequestAuthenticator,
  type ApiKeyVerifier,
  AuthenticationRequiredError,
  BrowserRequestRejectedError,
  BrowserSessionRequestAuthenticator,
  type BrowserSessionVerifier,
  CombinedRequestAuthenticator,
  createAuthenticator,
} from "./auth.js";
import { loadConfig } from "./config.js";

const OIDC_ENV = {
  PROOFSTACK_OIDC_CLIENT_ID: "proofstack-console",
  PROOFSTACK_OIDC_CLIENT_SECRET: "provider-client-secret",
  PROOFSTACK_OIDC_ISSUER: "https://identity.example.test/tenant",
  PROOFSTACK_OIDC_REDIRECT_URI: "https://proofstack.example.test/v1/auth/oidc/callback",
  PROOFSTACK_OIDC_TRANSACTION_SECRET: "A".repeat(43),
} as const;

const principal = PrincipalContextSchema.parse({
  authentication: {
    authenticatedAt: "2026-08-28T08:00:00.000Z",
    credentialId: "key_request_auth",
    method: "api_key",
  },
  capabilities: ["evidence:ingest"],
  principalId: "wrk_request_auth",
  principalType: "workload",
  requestId: "req_request_auth",
  resourceScope: { mode: "tenant" },
  roles: ["ingest"],
  tenantId: "ten_request_auth",
});

const browserPrincipal = PrincipalContextSchema.parse({
  authentication: {
    authenticatedAt: "2026-08-28T08:00:00.000Z",
    credentialId: "ses_request_auth",
    method: "oidc",
  },
  capabilities: ["evidence:read", "identity:manage"],
  principalId: "usr_request_auth",
  principalType: "user",
  requestId: "req_request_auth",
  resourceScope: { mode: "tenant" },
  roles: ["admin"],
  tenantId: "ten_request_auth",
});

const browserCredentials = generateBrowserSessionCredentials((size) =>
  new Uint8Array(size).fill(19),
);

function request(authorization?: string): FastifyRequest {
  return {
    headers: authorization === undefined ? {} : { authorization },
    id: "req_request_auth",
  } as FastifyRequest;
}

function verifier(result: "invalid" | "success" = "success"): ApiKeyVerifier & {
  readonly authenticate: ReturnType<typeof vi.fn>;
} {
  return {
    authenticate: vi.fn(async () => {
      if (result === "invalid") throw new InvalidApiKeyError();
      return principal;
    }),
  };
}

function browserVerifier(result: "invalid" | "success" = "success"): BrowserSessionVerifier & {
  readonly authenticate: ReturnType<typeof vi.fn>;
} {
  return {
    authenticate: vi.fn(async () => {
      if (result === "invalid") throw new InvalidBrowserSessionError();
      return {
        csrfDigest: browserCredentials.csrfDigest,
        principal: browserPrincipal,
        sessionDigest: browserCredentials.sessionDigest,
      };
    }),
  };
}

function browserRequest(options: {
  readonly authorization?: string;
  readonly cookieHeader?: string;
  readonly csrfCookie?: string;
  readonly csrfHeader?: string;
  readonly method?: string;
  readonly origin?: string;
  readonly sessionToken?: string;
}): FastifyRequest {
  const cookies = [
    options.sessionToken ? `__Host-proofstack_session=${options.sessionToken}` : undefined,
    options.csrfCookie ? `__Host-proofstack_csrf=${options.csrfCookie}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return {
    headers: {
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(options.cookieHeader !== undefined
        ? { cookie: options.cookieHeader }
        : cookies.length > 0
          ? { cookie: cookies.join("; ") }
          : {}),
      ...(options.csrfHeader ? { "x-proofstack-csrf": options.csrfHeader } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
    },
    id: "req_request_auth",
    method: options.method ?? "GET",
  } as FastifyRequest;
}

describe("ApiKeyRequestAuthenticator", () => {
  it("accepts one case-insensitive Bearer credential", async () => {
    const apiKeys = verifier();
    const authenticator = new ApiKeyRequestAuthenticator(apiKeys);

    await expect(authenticator.authenticate(request("bearer psk_v1_public_secret"))).resolves.toBe(
      principal,
    );
    expect(apiKeys.authenticate).toHaveBeenCalledWith("psk_v1_public_secret", "req_request_auth");
  });

  it.each([
    undefined,
    "",
    "Basic credential",
    "Bearer",
    "Bearer  credential",
    "Bearer credential extra",
    "Bearer first,Bearer second",
  ])("rejects a missing or ambiguous authorization value %j", async (authorization) => {
    const apiKeys = verifier();
    await expect(
      new ApiKeyRequestAuthenticator(apiKeys).authenticate(request(authorization)),
    ).rejects.toBeInstanceOf(AuthenticationRequiredError);
    expect(apiKeys.authenticate).not.toHaveBeenCalled();
  });

  it("normalizes invalid keys without hiding verifier failures", async () => {
    await expect(
      new ApiKeyRequestAuthenticator(verifier("invalid")).authenticate(
        request("Bearer invalid-key"),
      ),
    ).rejects.toMatchObject({
      cause: expect.any(InvalidApiKeyError),
      message: "Authentication is required or invalid",
    });

    const failure = new Error("identity database unavailable");
    const failed: ApiKeyVerifier = {
      authenticate: async () => {
        throw failure;
      },
    };
    await expect(
      new ApiKeyRequestAuthenticator(failed).authenticate(request("Bearer key")),
    ).rejects.toBe(failure);
  });
});

describe("BrowserSessionRequestAuthenticator", () => {
  it("authenticates one host-only session cookie for safe requests", async () => {
    const sessions = browserVerifier();
    const authenticator = new BrowserSessionRequestAuthenticator(
      sessions,
      "https://proofstack.example.test",
    );
    await expect(
      authenticator.authenticate(browserRequest({ sessionToken: browserCredentials.sessionToken })),
    ).resolves.toBe(browserPrincipal);
    expect(sessions.authenticate).toHaveBeenCalledWith(
      browserCredentials.sessionToken,
      "req_request_auth",
    );
  });

  it.each([
    ["missing", undefined],
    ["empty", "__Host-proofstack_session="],
    [
      "duplicate",
      `__Host-proofstack_session=${browserCredentials.sessionToken}; __Host-proofstack_session=${browserCredentials.sessionToken}`,
    ],
  ])("rejects a %s session cookie", async (_label, cookieHeader) => {
    const sessions = browserVerifier();
    const authenticator = new BrowserSessionRequestAuthenticator(
      sessions,
      "https://proofstack.example.test",
    );
    const requestValue = browserRequest(cookieHeader === undefined ? {} : { cookieHeader });
    await expect(authenticator.authenticate(requestValue)).rejects.toBeInstanceOf(
      AuthenticationRequiredError,
    );
    expect(sessions.authenticate).not.toHaveBeenCalled();
  });

  it("normalizes invalid sessions without hiding storage failures", async () => {
    const invalid = new BrowserSessionRequestAuthenticator(
      browserVerifier("invalid"),
      "https://proofstack.example.test",
    );
    await expect(
      invalid.authenticate(browserRequest({ sessionToken: browserCredentials.sessionToken })),
    ).rejects.toBeInstanceOf(AuthenticationRequiredError);

    const failure = new Error("identity database unavailable");
    const unavailable = new BrowserSessionRequestAuthenticator(
      {
        authenticate: async () => {
          throw failure;
        },
      },
      "https://proofstack.example.test",
    );
    await expect(
      unavailable.authenticate(browserRequest({ sessionToken: browserCredentials.sessionToken })),
    ).rejects.toBe(failure);
  });

  it("requires exact Origin and paired CSRF cookie and header for unsafe requests", async () => {
    const sessions = browserVerifier();
    const authenticator = new BrowserSessionRequestAuthenticator(
      sessions,
      "https://proofstack.example.test",
    );
    await expect(
      authenticator.authenticateSession(
        browserRequest({
          csrfCookie: browserCredentials.csrfToken,
          csrfHeader: browserCredentials.csrfToken,
          method: "POST",
          origin: "https://proofstack.example.test",
          sessionToken: browserCredentials.sessionToken,
        }),
      ),
    ).resolves.toMatchObject({ principal: browserPrincipal });

    const wrongCsrf = generateBrowserSessionCredentials().csrfToken;
    for (const override of [
      { origin: "https://attacker.example" },
      { csrfHeader: "" },
      { csrfCookie: "" },
      { csrfCookie: wrongCsrf, csrfHeader: wrongCsrf },
    ]) {
      await expect(
        authenticator.authenticate(
          browserRequest({
            csrfCookie: browserCredentials.csrfToken,
            csrfHeader: browserCredentials.csrfToken,
            method: "DELETE",
            origin: "https://proofstack.example.test",
            sessionToken: browserCredentials.sessionToken,
            ...override,
          }),
        ),
      ).rejects.toBeInstanceOf(BrowserRequestRejectedError);
    }
  });

  it.each(["HEAD", "OPTIONS"])("does not require CSRF for %s", async (method) => {
    const authenticator = new BrowserSessionRequestAuthenticator(
      browserVerifier(),
      "https://proofstack.example.test",
    );
    await expect(
      authenticator.authenticate(
        browserRequest({ method, sessionToken: browserCredentials.sessionToken }),
      ),
    ).resolves.toBe(browserPrincipal);
  });
});

describe("CombinedRequestAuthenticator", () => {
  it("selects one credential family without falling back from an invalid API key", async () => {
    const apiKeys = verifier();
    const sessions = browserVerifier();
    const combined = new CombinedRequestAuthenticator(
      new ApiKeyRequestAuthenticator(apiKeys),
      new BrowserSessionRequestAuthenticator(sessions, "https://proofstack.example.test"),
    );

    await expect(
      combined.authenticate(browserRequest({ authorization: "Bearer api-key" })),
    ).resolves.toBe(principal);
    expect(sessions.authenticate).not.toHaveBeenCalled();

    await expect(
      combined.authenticate(browserRequest({ sessionToken: browserCredentials.sessionToken })),
    ).resolves.toBe(browserPrincipal);

    const noFallback = new CombinedRequestAuthenticator(
      new ApiKeyRequestAuthenticator(verifier("invalid")),
      new BrowserSessionRequestAuthenticator(sessions, "https://proofstack.example.test"),
    );
    await expect(
      noFallback.authenticate(
        browserRequest({
          authorization: "Bearer invalid",
          sessionToken: browserCredentials.sessionToken,
        }),
      ),
    ).rejects.toBeInstanceOf(AuthenticationRequiredError);
  });
});

describe("createAuthenticator", () => {
  it("creates the development adapter only for development mode", async () => {
    const authenticator = createAuthenticator(loadConfig({ PROOFSTACK_ENV: "test" }));
    await expect(authenticator.authenticate(request())).resolves.toMatchObject({
      capabilities: expect.arrayContaining([
        "dataset:read",
        "dataset:manage",
        "replay:read",
        "replay:run",
        "replay:cancel",
        "replay:manage",
        "evaluation:manage",
      ]),
      principalId: "usr_local",
      tenantId: "ten_local",
    });
  });

  it("fails closed without required identity storage", () => {
    const apiKeyConfig = loadConfig({
      PROOFSTACK_AUTH_MODE: "api_key",
      PROOFSTACK_IDENTITY_DATABASE_URL: "postgresql://identity@127.0.0.1:5432/proofstack",
    });
    expect(() => createAuthenticator(apiKeyConfig)).toThrow("storage is unavailable");

    const oidcConfig = loadConfig({
      ...OIDC_ENV,
      PROOFSTACK_AUTH_MODE: "oidc",
      PROOFSTACK_IDENTITY_DATABASE_URL: "postgresql://identity@127.0.0.1:5432/proofstack",
    });
    expect(() => createAuthenticator(oidcConfig)).toThrow("browser session storage");
  });

  it("constructs API key authentication only with an explicit credential lookup", () => {
    const apiKeyConfig = loadConfig({
      PROOFSTACK_AUTH_MODE: "api_key",
      PROOFSTACK_IDENTITY_DATABASE_URL: "postgresql://identity@127.0.0.1:5432/proofstack",
    });
    const authenticator = createAuthenticator(apiKeyConfig, {
      apiKeyCredentials: {
        confirmActiveUse: async () => true,
        findActiveByPrefix: async () => null,
      },
    });

    expect(authenticator).toBeInstanceOf(ApiKeyRequestAuthenticator);

    const oidcConfig = loadConfig({
      ...OIDC_ENV,
      PROOFSTACK_AUTH_MODE: "oidc",
      PROOFSTACK_IDENTITY_DATABASE_URL: "postgresql://identity@127.0.0.1:5432/proofstack",
    });
    const combinedConfig = loadConfig({
      ...OIDC_ENV,
      PROOFSTACK_AUTH_MODE: "combined",
      PROOFSTACK_IDENTITY_DATABASE_URL: "postgresql://identity@127.0.0.1:5432/proofstack",
    });
    expect(() =>
      createAuthenticator(combinedConfig, {
        browserSessions: { findAndTouchActive: async () => null },
      }),
    ).toThrow("API key identity storage");

    expect(
      createAuthenticator(oidcConfig, {
        browserSessions: { findAndTouchActive: async () => null },
      }),
    ).toBeInstanceOf(BrowserSessionRequestAuthenticator);
    expect(
      createAuthenticator(combinedConfig, {
        apiKeyCredentials: {
          confirmActiveUse: async () => true,
          findActiveByPrefix: async () => null,
        },
        browserSessions: { findAndTouchActive: async () => null },
      }),
    ).toBeInstanceOf(CombinedRequestAuthenticator);
  });
});
