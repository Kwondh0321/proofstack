import {
  type CreateBrowserSession,
  type CreatedBrowserSession,
  type CreatedOidcLoginTransaction,
  type CreateOidcLoginTransaction,
  generateOidcTransactionSecret,
  OidcLoginService,
  OidcSessionLifecycle,
} from "@proofstack/identity";
import { describe, expect, it, vi } from "vitest";
import { BrowserSessionRequestAuthenticator } from "./auth.js";
import type { OidcIdentityRepository } from "./identity-storage.js";
import { createOidcRuntime } from "./oidc-runtime.js";

const config = {
  browserOrigin: "https://console.example.test",
  clientId: "proofstack-console",
  clientSecret: "provider-client-secret",
  issuer: "https://identity.example.test/tenant",
  redirectUri: "https://proofstack.example.test/v1/auth/oidc/callback",
  scopes: ["openid", "profile", "email"],
  transactionSecret: generateOidcTransactionSecret((size) => new Uint8Array(size).fill(7)),
} as const;

class FakeOidcIdentityRepository implements OidcIdentityRepository {
  async consumeActive() {
    return null;
  }

  create(input: CreateOidcLoginTransaction): Promise<CreatedOidcLoginTransaction>;
  create(input: CreateBrowserSession): Promise<CreatedBrowserSession>;
  async create(input: CreateOidcLoginTransaction | CreateBrowserSession) {
    if ("protectedPayload" in input) {
      return {
        createdAt: "2026-08-28T08:00:00.000Z",
        expiresAt: "2026-08-28T08:10:00.000Z",
      };
    }
    return {
      absoluteExpiresAt: "2026-08-28T20:00:00.000Z",
      createdAt: "2026-08-28T08:00:00.000Z",
      idleExpiresAt: "2026-08-28T08:30:00.000Z",
      sessionId: input.sessionId,
    };
  }

  async findActiveByIssuerSubject() {
    return null;
  }

  async findAndTouchActive() {
    return null;
  }

  async revokeActive() {
    return true;
  }
}

function repository(): OidcIdentityRepository {
  return new FakeOidcIdentityRepository();
}

describe("createOidcRuntime", () => {
  it("composes the provider, encrypted transaction flow, browser verifier, and revocation", async () => {
    const createProvider = vi.fn(async () => ({
      authorizationUrl: (input: {
        readonly codeChallenge: string;
        readonly nonce: string;
        readonly state: string;
      }) => {
        const url = new URL("https://identity.example.test/authorize");
        url.searchParams.set("response_type", "code");
        url.searchParams.set("state", input.state);
        url.searchParams.set("nonce", input.nonce);
        url.searchParams.set("code_challenge", input.codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        return url.href;
      },
      issuer: config.issuer,
      validateCallback: async () => ({ subject: "user-123" }),
    }));
    const runtime = await createOidcRuntime(config, repository(), { createProvider });

    expect(createProvider).toHaveBeenCalledWith({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      issuer: config.issuer,
      redirectUri: config.redirectUri,
      scopes: config.scopes,
    });
    expect(runtime.browserSessions).toBeInstanceOf(BrowserSessionRequestAuthenticator);
    expect(runtime.login).toBeInstanceOf(OidcLoginService);
    expect(runtime.sessionLifecycle).toBeInstanceOf(OidcSessionLifecycle);
    await expect(runtime.login.begin("/traces")).resolves.toMatchObject({
      authorizationUrl: expect.stringContaining("code_challenge_method=S256"),
      interactionToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it("fails startup when provider discovery fails", async () => {
    const discoveryFailure = new Error("discovery unavailable");
    await expect(
      createOidcRuntime(config, repository(), {
        createProvider: async () => {
          throw discoveryFailure;
        },
      }),
    ).rejects.toBe(discoveryFailure);
  });
});
