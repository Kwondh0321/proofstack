import { PrincipalContextSchema } from "@proofstack/contracts";
import { generateApiKey } from "@proofstack/identity";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Authenticator } from "./auth.js";
import {
  type ApiKeyLifecycleService,
  IdentityManagementUnavailableError,
  registerIdentityRoutes,
} from "./identity-routes.js";

const apps: ReturnType<typeof Fastify>[] = [];
const issued = generateApiKey(() => new Uint8Array(41).fill(7));
const credential = {
  capabilities: ["evidence:ingest"] as const,
  createdAt: "2026-08-28T04:00:00.000Z",
  credentialId: "key_route_test",
  expiresAt: "2026-11-26T04:00:00.000Z",
  name: "route-test",
  prefix: issued.prefix,
  principalId: "wrk_route_test",
  resourceScope: { mode: "tenant" as const },
  revokedAt: null,
  rotatedFromCredentialId: null,
  tenantId: "ten_local",
};
const principal = PrincipalContextSchema.parse({
  authentication: {
    authenticatedAt: "2026-08-28T04:00:00.000Z",
    method: "development",
  },
  capabilities: ["identity:manage", "evidence:ingest"],
  principalId: "usr_route_test",
  principalType: "user",
  requestId: "req_route_test",
  resourceScope: { mode: "tenant" },
  roles: ["owner"],
  tenantId: "ten_local",
});

const authenticator: Authenticator = { authenticate: async () => principal };

function lifecycle(): ApiKeyLifecycleService & {
  readonly issue: ReturnType<typeof vi.fn>;
  readonly revoke: ReturnType<typeof vi.fn>;
  readonly rotate: ReturnType<typeof vi.fn>;
} {
  return {
    issue: vi.fn(async () => ({ credential, value: issued.value })),
    revoke: vi.fn(async () => true),
    rotate: vi.fn(async () => ({
      credential: { ...credential, rotatedFromCredentialId: "key_previous" },
      value: issued.value,
    })),
  };
}

async function identityApp(apiKeys?: ApiKeyLifecycleService) {
  const app = Fastify({ logger: false });
  apps.push(app);
  await registerIdentityRoutes(app, {
    ...(apiKeys ? { apiKeyLifecycle: apiKeys } : {}),
    authenticator,
  });
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("identity management routes", () => {
  it("issues, rotates, and revokes through the lifecycle boundary", async () => {
    const apiKeys = lifecycle();
    const app = await identityApp(apiKeys);
    const issue = await app.inject({
      body: {
        capabilities: ["evidence:ingest"],
        name: "route-test",
        resourceScope: { mode: "tenant" },
      },
      method: "POST",
      url: "/v1/identity/api-keys",
    });
    const rotate = await app.inject({
      method: "POST",
      url: "/v1/identity/api-keys/key_previous/rotate",
    });
    const revoke = await app.inject({
      body: { reason: "workload retired" },
      method: "POST",
      url: "/v1/identity/api-keys/key_route_test/revoke",
    });

    expect(issue.statusCode).toBe(201);
    expect(issue.headers["cache-control"]).toBe("no-store");
    expect(issue.headers.pragma).toBe("no-cache");
    expect(issue.json()).toMatchObject({ credential: { credentialId: credential.credentialId } });
    expect(apiKeys.issue).toHaveBeenCalledWith(
      expect.objectContaining({ issuer: principal, name: "route-test" }),
    );
    expect(rotate.statusCode).toBe(200);
    expect(rotate.headers["cache-control"]).toBe("no-store");
    expect(apiKeys.rotate).toHaveBeenCalledWith({
      credentialId: "key_previous",
      issuer: principal,
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toMatchObject({ credentialId: "key_route_test", revoked: true });
  });

  it("authenticates before validation and fails explicitly without storage", async () => {
    const authenticationFailure = new Error("not authenticated");
    const app = Fastify({ logger: false });
    apps.push(app);
    await registerIdentityRoutes(app, {
      authenticator: {
        authenticate: async () => {
          throw authenticationFailure;
        },
      },
    });

    const unauthenticated = await app.inject({
      body: { invalid: true },
      method: "POST",
      url: "/v1/identity/api-keys",
    });
    expect(unauthenticated.statusCode).toBe(500);

    const unavailable = await identityApp();
    const response = await unavailable.inject({
      body: {
        capabilities: ["evidence:ingest"],
        name: "route-test",
        resourceScope: { mode: "tenant" },
      },
      method: "POST",
      url: "/v1/identity/api-keys",
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      message: new IdentityManagementUnavailableError().message,
    });
  });
});
