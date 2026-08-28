import type { OidcAuthorizationInput, OidcCallbackInput } from "@proofstack/identity";
import { OidcProviderConfigurationError } from "@proofstack/identity";
import { describe, expect, it, vi } from "vitest";
import { createOpenIdClientProvider, type OpenIdClientProviderOptions } from "./oidc-provider.js";

const ISSUER = "https://identity.example.test/tenant";
const REDIRECT_URI = "https://proofstack.example.test/v1/auth/oidc/callback";
const AUTHORIZATION_INPUT: OidcAuthorizationInput = {
  codeChallenge: "challenge-value",
  nonce: "nonce-value",
  state: "state-value",
};
const CALLBACK_INPUT: OidcCallbackInput = {
  codeVerifier: "verifier-value",
  currentUrl: `${REDIRECT_URI}?code=authorization-code&state=state-value`,
  expectedNonce: "nonce-value",
  expectedState: "state-value",
};

type Dependencies = NonNullable<Parameters<typeof createOpenIdClientProvider>[1]>;

function options(
  overrides: Partial<OpenIdClientProviderOptions> = {},
): OpenIdClientProviderOptions {
  return {
    clientId: "proofstack-console",
    clientSecret: "provider-client-secret",
    issuer: ISSUER,
    redirectUri: REDIRECT_URI,
    scopes: ["openid", "profile", "email"],
    ...overrides,
  };
}

function fixture(
  overrides: { readonly discoveredIssuer?: string; readonly subject?: unknown } = {},
) {
  const configuration = {
    serverMetadata: () => ({ issuer: overrides.discoveredIssuer ?? ISSUER }),
  };
  const discovery = vi.fn(async () => configuration);
  const buildAuthorizationUrl = vi.fn(
    (_configuration: unknown, parameters: URLSearchParams | Record<string, string>) => {
      const url = new URL("https://identity.example.test/authorize");
      const entries =
        parameters instanceof URLSearchParams ? parameters.entries() : Object.entries(parameters);
      for (const [name, value] of entries) url.searchParams.set(name, value);
      return url;
    },
  );
  const authorizationCodeGrant = vi.fn(async () => ({
    claims: () => ({
      sub: "subject" in overrides ? overrides.subject : "provider-subject-001",
    }),
  }));
  const dependencies = {
    authorizationCodeGrant,
    buildAuthorizationUrl,
    discovery,
  } as unknown as Dependencies;
  return { authorizationCodeGrant, buildAuthorizationUrl, configuration, dependencies, discovery };
}

describe("createOpenIdClientProvider", () => {
  it("loads the installed adapter without weakening third-party type checking", async () => {
    await expect(
      createOpenIdClientProvider(options({ issuer: "http://identity.example.test" })),
    ).rejects.toThrow("HTTPS");
  });

  it("discovers exact issuer metadata with bounded confidential-client settings", async () => {
    const value = fixture();
    const provider = await createOpenIdClientProvider(options(), value.dependencies);

    expect(provider.issuer).toBe(ISSUER);
    expect(value.discovery).toHaveBeenCalledWith(new URL(ISSUER), "proofstack-console", {
      client_secret: "provider-client-secret",
      redirect_uris: [REDIRECT_URI],
      response_types: ["code"],
    });
  });

  it("builds an authorization-code request with exact PKCE, state, and nonce", async () => {
    const value = fixture();
    const provider = await createOpenIdClientProvider(options(), value.dependencies);
    const result = new URL(provider.authorizationUrl(AUTHORIZATION_INPUT));

    expect(Object.fromEntries(result.searchParams)).toEqual({
      code_challenge: "challenge-value",
      code_challenge_method: "S256",
      nonce: "nonce-value",
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "openid profile email",
      state: "state-value",
    });
    expect(value.buildAuthorizationUrl).toHaveBeenCalledWith(
      value.configuration,
      expect.anything(),
    );
  });

  it("validates the callback using PKCE, exact state and nonce, and a required ID token", async () => {
    const value = fixture();
    const provider = await createOpenIdClientProvider(options(), value.dependencies);

    await expect(provider.validateCallback(CALLBACK_INPUT)).resolves.toEqual({
      subject: "provider-subject-001",
    });
    expect(value.authorizationCodeGrant).toHaveBeenCalledWith(
      value.configuration,
      new URL(CALLBACK_INPUT.currentUrl),
      {
        expectedNonce: "nonce-value",
        expectedState: "state-value",
        idTokenExpected: true,
        pkceCodeVerifier: "verifier-value",
      },
    );
  });

  it.each([
    ["malformed callback", "not-a-url"],
    ["wrong protocol", CALLBACK_INPUT.currentUrl.replace("https:", "http:")],
    ["username", CALLBACK_INPUT.currentUrl.replace("https://", "https://user@")],
    ["password", CALLBACK_INPUT.currentUrl.replace("https://", "https://:secret@")],
    ["wrong origin", CALLBACK_INPUT.currentUrl.replace("proofstack.example.test", "attacker.test")],
    ["wrong path", CALLBACK_INPUT.currentUrl.replace("/callback", "/other")],
    ["fragment", `${CALLBACK_INPUT.currentUrl}#fragment`],
  ])("rejects a %s before calling the token endpoint", async (_label, currentUrl) => {
    const value = fixture();
    const provider = await createOpenIdClientProvider(options(), value.dependencies);
    await expect(provider.validateCallback({ ...CALLBACK_INPUT, currentUrl })).rejects.toThrow(
      /callback URL/,
    );
    expect(value.authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it.each([undefined, 1])("requires a string ID token subject (%j)", async (subject) => {
    const value = fixture({ subject });
    const provider = await createOpenIdClientProvider(options(), value.dependencies);
    await expect(provider.validateCallback(CALLBACK_INPUT)).rejects.toThrow("ID token subject");
  });

  it("rejects metadata whose validated issuer is not exact", async () => {
    const value = fixture({ discoveredIssuer: `${ISSUER}/other` });
    await expect(createOpenIdClientProvider(options(), value.dependencies)).rejects.toBeInstanceOf(
      OidcProviderConfigurationError,
    );
  });

  it("preserves discovery and callback verification failures", async () => {
    const discoveryFailure = fixture();
    const unavailable = new Error("identity provider unavailable");
    discoveryFailure.discovery.mockRejectedValueOnce(unavailable);
    await expect(createOpenIdClientProvider(options(), discoveryFailure.dependencies)).rejects.toBe(
      unavailable,
    );

    const callbackFailure = fixture();
    callbackFailure.authorizationCodeGrant.mockRejectedValueOnce(unavailable);
    const provider = await createOpenIdClientProvider(options(), callbackFailure.dependencies);
    await expect(provider.validateCallback(CALLBACK_INPUT)).rejects.toBe(unavailable);
  });

  it.each([
    [{ issuer: "http://identity.example.test" }, "HTTPS"],
    [{ clientId: "" }, "client ID"],
    [{ clientId: "x".repeat(513) }, "client ID"],
    [{ clientSecret: "bad\nsecret" }, "client secret"],
    [{ clientSecret: "x".repeat(4_097) }, "client secret"],
    [{ redirectUri: "not-a-url" }, "redirect URI"],
    [{ redirectUri: REDIRECT_URI.replace("https:", "http:") }, "exact HTTPS"],
    [{ redirectUri: `${REDIRECT_URI}?tenant=one` }, "exact HTTPS"],
    [{ scopes: [] }, "scopes"],
    [{ scopes: ["profile"] }, "scopes"],
    [{ scopes: ["openid", "openid"] }, "scopes"],
    [{ scopes: ["openid", "bad scope"] }, "scopes"],
    [{ scopes: ["openid", "x".repeat(129)] }, "scopes"],
    [
      { scopes: ["openid", ...Array.from({ length: 20 }, (_, index) => `scope:${index}`)] },
      "scopes",
    ],
  ] satisfies Array<[Partial<OpenIdClientProviderOptions>, string]>)(
    "rejects invalid provider configuration %j",
    async (override, message) => {
      const value = fixture();
      await expect(
        createOpenIdClientProvider(options(override), value.dependencies),
      ).rejects.toThrow(message);
      expect(value.discovery).not.toHaveBeenCalled();
    },
  );
});
