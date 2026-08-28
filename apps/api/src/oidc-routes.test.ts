import { PrincipalContextSchema } from "@proofstack/contracts";
import { InvalidOidcLoginError } from "@proofstack/identity";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
  OIDC_INTERACTION_COOKIE,
  type OidcRouteDependencies,
  registerOidcRoutes,
} from "./oidc-routes.js";

const STATE = "A".repeat(43);
const AUTHORIZATION_URL = `https://identity.example.test/authorize?response_type=code&state=${STATE}`;
const REDIRECT_URI = "https://proofstack.example.test/v1/auth/oidc/callback";
const SESSION_TOKEN = `pss_v1_${"A".repeat(43)}`;
const CSRF_TOKEN = `psc_v1_${"E".repeat(43)}`;
const apps: FastifyInstance[] = [];

function principal(requestId: string) {
  return PrincipalContextSchema.parse({
    authentication: {
      authenticatedAt: "2026-08-28T08:00:00.000Z",
      credentialId: "ses_oidc_routes",
      method: "oidc",
    },
    capabilities: ["evidence:read"],
    principalId: "usr_oidc_routes",
    principalType: "user",
    requestId,
    resourceScope: { mode: "tenant" },
    roles: ["viewer"],
    tenantId: "ten_oidc_routes",
  });
}

function fixture(overrides: Partial<OidcRouteDependencies> = {}) {
  const login = {
    begin: vi.fn(async () => ({
      authorizationUrl: AUTHORIZATION_URL,
      expiresAt: "2026-08-28T08:10:00.000Z",
      interactionToken: STATE,
    })),
    complete: vi.fn(async () => ({
      absoluteExpiresAt: "2026-08-28T20:00:00.000Z",
      csrfToken: CSRF_TOKEN,
      idleExpiresAt: "2026-08-28T08:30:00.000Z",
      returnTo: "/traces?view=recent",
      sessionToken: SESSION_TOKEN,
    })),
  };
  const browserSessions = {
    authenticateSession: vi.fn(async (request) => ({
      csrfDigest: "a".repeat(64),
      principal: principal(request.id),
      sessionDigest: "b".repeat(64),
    })),
  } satisfies OidcRouteDependencies["browserSessions"];
  const sessionLifecycle = { revoke: vi.fn(async () => true) };
  const dependencies = {
    browserSessions,
    login,
    redirectUri: REDIRECT_URI,
    sessionLifecycle,
    ...overrides,
  } satisfies OidcRouteDependencies;
  return { browserSessions, dependencies, login, sessionLifecycle };
}

async function createTestApp(dependencies: OidcRouteDependencies) {
  const app = Fastify({ genReqId: () => "req_oidc_routes" });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof InvalidOidcLoginError || error instanceof ZodError ? 400 : 500;
    return reply
      .status(status)
      .send({ error: error instanceof Error ? error.name : "UnknownError" });
  });
  await registerOidcRoutes(app, dependencies);
  apps.push(app);
  return app;
}

function setCookies(headers: Record<string, unknown>): string[] {
  const value = headers["set-cookie"];
  if (Array.isArray(value)) return value.map(String);
  return value === undefined ? [] : [String(value)];
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("OIDC browser routes", () => {
  it("starts a local-return login and binds it to a hardened interaction cookie", async () => {
    const value = fixture();
    const app = await createTestApp(value.dependencies);
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/oidc/login?returnTo=%2Ftraces%3Fview%3Drecent",
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(AUTHORIZATION_URL);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(setCookies(response.headers)).toEqual([
      expect.stringMatching(
        new RegExp(
          `^${OIDC_INTERACTION_COOKIE}=${STATE}; Path=/; Expires=.+; Secure; HttpOnly; SameSite=Lax$`,
        ),
      ),
    ]);
    expect(value.login.begin).toHaveBeenCalledWith("/traces?view=recent");
  });

  it("rejects external and protocol-relative return targets before starting login", async () => {
    const value = fixture();
    const app = await createTestApp(value.dependencies);

    for (const returnTo of ["https://attacker.example", "//attacker.example"]) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/auth/oidc/login?returnTo=${encodeURIComponent(returnTo)}`,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(value.login.begin).not.toHaveBeenCalled();
  });

  it("completes only the initiating browser and never trusts the request host", async () => {
    const value = fixture();
    const app = await createTestApp(value.dependencies);
    const response = await app.inject({
      headers: {
        cookie: `${OIDC_INTERACTION_COOKIE}=${STATE}`,
        host: "attacker.example",
      },
      method: "GET",
      url: `/v1/auth/oidc/callback?code=provider-code&state=${STATE}&session_state=provider-session`,
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/traces?view=recent");
    expect(value.login.complete).toHaveBeenCalledWith(
      `${REDIRECT_URI}?code=provider-code&state=${STATE}&session_state=provider-session`,
      STATE,
    );
    const cookies = setCookies(response.headers);
    expect(cookies).toHaveLength(3);
    expect(cookies[0]).toContain(`__Host-proofstack_session=${SESSION_TOKEN}`);
    expect(cookies[0]).toContain("Secure; HttpOnly; SameSite=Lax");
    expect(cookies[1]).toContain(`__Host-proofstack_csrf=${CSRF_TOKEN}`);
    expect(cookies[1]).toContain("Secure; SameSite=Lax");
    expect(cookies[1]).not.toContain("HttpOnly");
    expect(cookies[2]).toContain(`${OIDC_INTERACTION_COOKIE}=;`);
    expect(cookies[2]).toContain("Max-Age=0");
  });

  it.each([
    ["missing", undefined],
    ["different", `${OIDC_INTERACTION_COOKIE}=${"E".repeat(43)}`],
    ["duplicate", `${OIDC_INTERACTION_COOKIE}=${STATE}; ${OIDC_INTERACTION_COOKIE}=${STATE}`],
  ])(
    "rejects a %s browser interaction cookie without consuming the transaction",
    async (_, cookie) => {
      const value = fixture();
      const app = await createTestApp(value.dependencies);
      const response = await app.inject({
        headers: cookie === undefined ? {} : { cookie },
        method: "GET",
        url: `/v1/auth/oidc/callback?code=provider-code&state=${STATE}`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(setCookies(response.headers)[0]).toContain("Max-Age=0");
      expect(value.login.complete).not.toHaveBeenCalled();
    },
  );

  it("expires the interaction cookie when provider validation fails", async () => {
    const value = fixture();
    value.login.complete.mockRejectedValueOnce(new InvalidOidcLoginError());
    const app = await createTestApp(value.dependencies);
    const response = await app.inject({
      headers: { cookie: `${OIDC_INTERACTION_COOKIE}=${STATE}` },
      method: "GET",
      url: `/v1/auth/oidc/callback?error=access_denied&state=${STATE}`,
    });

    expect(response.statusCode).toBe(400);
    expect(setCookies(response.headers)[0]).toContain("Max-Age=0");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("returns the current browser principal without caching", async () => {
    const value = fixture();
    const app = await createTestApp(value.dependencies);
    const response = await app.inject({ method: "GET", url: "/v1/auth/session" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      principal: { principalId: "usr_oidc_routes", requestId: "req_oidc_routes" },
      requestId: "req_oidc_routes",
    });
  });

  it("revokes the authenticated session and clears every browser credential", async () => {
    const value = fixture();
    const app = await createTestApp(value.dependencies);
    const response = await app.inject({ method: "POST", url: "/v1/auth/oidc/logout" });

    expect(response.statusCode).toBe(200);
    expect(value.sessionLifecycle.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ sessionDigest: "b".repeat(64) }),
    );
    expect(response.json()).toEqual({ requestId: "req_oidc_routes", revoked: true });
    expect(setCookies(response.headers)).toHaveLength(3);
    for (const cookie of setCookies(response.headers)) expect(cookie).toContain("Max-Age=0");
  });

  it("rejects invalid service expiration metadata", async () => {
    const value = fixture();
    value.login.begin.mockResolvedValueOnce({
      authorizationUrl: AUTHORIZATION_URL,
      expiresAt: "invalid",
      interactionToken: STATE,
    });
    const app = await createTestApp(value.dependencies);

    const response = await app.inject({ method: "GET", url: "/v1/auth/oidc/login" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "OidcIdentityDataIntegrityError" });
  });
});
