import { PrincipalContextSchema } from "@proofstack/contracts";
import { InvalidApiKeyError } from "@proofstack/identity";
import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  ApiKeyRequestAuthenticator,
  AuthenticationRequiredError,
  createAuthenticator,
  type ApiKeyVerifier,
} from "./auth.js";
import { loadConfig } from "./config.js";

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

describe("createAuthenticator", () => {
  it("creates the development adapter only for development mode", async () => {
    const authenticator = createAuthenticator(loadConfig({ PROOFSTACK_ENV: "test" }));
    await expect(authenticator.authenticate(request())).resolves.toMatchObject({
      principalId: "usr_local",
      tenantId: "ten_local",
    });
  });

  it("fails closed without API key storage or for unfinished OIDC modes", () => {
    const apiKeyConfig = loadConfig({
      PROOFSTACK_AUTH_MODE: "api_key",
      PROOFSTACK_IDENTITY_DATABASE_URL: "postgresql://identity@127.0.0.1:5432/proofstack",
    });
    expect(() => createAuthenticator(apiKeyConfig)).toThrow("storage is unavailable");

    const oidcConfig = loadConfig({
      PROOFSTACK_AUTH_MODE: "oidc",
      PROOFSTACK_IDENTITY_DATABASE_URL: "postgresql://identity@127.0.0.1:5432/proofstack",
    });
    expect(() => createAuthenticator(oidcConfig)).toThrow("startup refused");
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

    const combinedConfig = loadConfig({
      PROOFSTACK_AUTH_MODE: "combined",
      PROOFSTACK_IDENTITY_DATABASE_URL: "postgresql://identity@127.0.0.1:5432/proofstack",
    });
    expect(() => createAuthenticator(combinedConfig)).toThrow("startup refused");
  });
});
