import {
  OidcLoginService,
  OidcLoginTransactionCipher,
  OidcSessionAuthenticator,
  OidcSessionLifecycle,
} from "@proofstack/identity";
import { BrowserSessionRequestAuthenticator } from "./auth.js";
import type { OidcIdentityRepository } from "./identity-storage.js";
import { createOpenIdClientProvider, type OpenIdClientProviderOptions } from "./oidc-provider.js";

export interface OidcRuntimeConfig extends OpenIdClientProviderOptions {
  readonly browserOrigin: string;
  readonly transactionSecret: string;
}

export interface OidcRuntime {
  readonly browserSessions: BrowserSessionRequestAuthenticator;
  readonly login: OidcLoginService;
  readonly sessionLifecycle: OidcSessionLifecycle;
}

interface OidcRuntimeDependencies {
  readonly createProvider: typeof createOpenIdClientProvider;
}

const defaultDependencies: OidcRuntimeDependencies = {
  createProvider: createOpenIdClientProvider,
};

export async function createOidcRuntime(
  config: OidcRuntimeConfig,
  repository: OidcIdentityRepository,
  dependencies: OidcRuntimeDependencies = defaultDependencies,
): Promise<OidcRuntime> {
  const provider = await dependencies.createProvider({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    issuer: config.issuer,
    redirectUri: config.redirectUri,
    scopes: config.scopes,
  });
  const browserSessions = new BrowserSessionRequestAuthenticator(
    new OidcSessionAuthenticator(repository),
    config.browserOrigin,
  );
  return {
    browserSessions,
    login: new OidcLoginService({
      bindings: repository,
      cipher: new OidcLoginTransactionCipher(config.transactionSecret),
      provider,
      sessions: repository,
      transactions: repository,
    }),
    sessionLifecycle: new OidcSessionLifecycle(repository),
  };
}
