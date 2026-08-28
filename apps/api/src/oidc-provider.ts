import {
  type OidcAuthorizationInput,
  type OidcCallbackInput,
  type OidcProviderClient,
  OidcProviderConfigurationError,
  requireOidcIssuer,
} from "@proofstack/identity";

const MAX_CLIENT_ID_LENGTH = 512;
const MAX_CLIENT_SECRET_LENGTH = 4_096;
const MAX_SCOPE_COUNT = 20;
const MAX_SCOPE_LENGTH = 128;

export interface OpenIdClientProviderOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly issuer: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
}

interface OpenIdConfiguration {
  serverMetadata(): { readonly issuer?: string };
}

interface OpenIdTokenResponse {
  claims(): { readonly sub?: unknown } | undefined;
}

interface OpenIdClientAdapterDependencies {
  authorizationCodeGrant(
    configuration: OpenIdConfiguration,
    currentUrl: URL,
    checks: {
      readonly expectedNonce: string;
      readonly expectedState: string;
      readonly idTokenExpected: boolean;
      readonly pkceCodeVerifier: string;
    },
  ): Promise<OpenIdTokenResponse>;
  buildAuthorizationUrl(
    configuration: OpenIdConfiguration,
    parameters: Record<string, string>,
  ): URL;
  discovery(
    issuer: URL,
    clientId: string,
    metadata: {
      readonly client_secret: string;
      readonly redirect_uris: readonly string[];
      readonly response_types: readonly string[];
    },
  ): Promise<OpenIdConfiguration>;
}

async function loadOpenIdClient(): Promise<OpenIdClientAdapterDependencies> {
  const moduleName: string = "openid-client";
  return (await import(moduleName)) as OpenIdClientAdapterDependencies;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function boundedCredential(value: string, maximum: number, label: string): string {
  if (value.length === 0 || value.length > maximum || hasControlCharacter(value)) {
    throw new OidcProviderConfigurationError(`${label} is invalid`);
  }
  return value;
}

function redirectUri(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new OidcProviderConfigurationError("OIDC redirect URI is invalid", { cause: error });
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new OidcProviderConfigurationError(
      "OIDC redirect URI must be an exact HTTPS URL without credentials, query, or fragment",
    );
  }
  return url;
}

function scopes(values: readonly string[]): string {
  if (
    values.length === 0 ||
    values.length > MAX_SCOPE_COUNT ||
    !values.includes("openid") ||
    new Set(values).size !== values.length ||
    values.some(
      (value) =>
        value.length === 0 ||
        value.length > MAX_SCOPE_LENGTH ||
        !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(value),
    )
  ) {
    throw new OidcProviderConfigurationError(
      "OIDC scopes must be unique printable tokens and include openid",
    );
  }
  return values.join(" ");
}

function callbackUrl(value: string, expected: URL): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("OIDC callback URL is invalid", { cause: error });
  }
  if (
    url.protocol !== expected.protocol ||
    url.username !== "" ||
    url.password !== "" ||
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.hash !== ""
  ) {
    throw new Error("OIDC callback URL does not match the configured redirect URI");
  }
  return url;
}

class OpenIdClientProvider implements OidcProviderClient {
  constructor(
    readonly issuer: string,
    private readonly configuration: OpenIdConfiguration,
    private readonly configuredRedirectUri: URL,
    private readonly configuredScope: string,
    private readonly dependencies: Pick<
      OpenIdClientAdapterDependencies,
      "authorizationCodeGrant" | "buildAuthorizationUrl"
    >,
  ) {}

  authorizationUrl(input: OidcAuthorizationInput): string {
    return this.dependencies.buildAuthorizationUrl(this.configuration, {
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      nonce: input.nonce,
      redirect_uri: this.configuredRedirectUri.href,
      response_type: "code",
      scope: this.configuredScope,
      state: input.state,
    }).href;
  }

  async validateCallback(input: OidcCallbackInput): Promise<{ readonly subject: string }> {
    const currentUrl = callbackUrl(input.currentUrl, this.configuredRedirectUri);
    const tokens = await this.dependencies.authorizationCodeGrant(this.configuration, currentUrl, {
      expectedNonce: input.expectedNonce,
      expectedState: input.expectedState,
      idTokenExpected: true,
      pkceCodeVerifier: input.codeVerifier,
    });
    const subject = tokens.claims()?.sub;
    if (typeof subject !== "string") {
      throw new Error("OIDC callback did not return an ID token subject");
    }
    return { subject };
  }
}

export async function createOpenIdClientProvider(
  options: OpenIdClientProviderOptions,
  injectedDependencies?: OpenIdClientAdapterDependencies,
): Promise<OidcProviderClient> {
  const dependencies = injectedDependencies ?? (await loadOpenIdClient());
  const issuer = requireOidcIssuer(options.issuer);
  const clientId = boundedCredential(options.clientId, MAX_CLIENT_ID_LENGTH, "OIDC client ID");
  const clientSecret = boundedCredential(
    options.clientSecret,
    MAX_CLIENT_SECRET_LENGTH,
    "OIDC client secret",
  );
  const configuredRedirectUri = redirectUri(options.redirectUri);
  const configuredScope = scopes(options.scopes);
  const configuration = await dependencies.discovery(new URL(issuer), clientId, {
    client_secret: clientSecret,
    redirect_uris: [configuredRedirectUri.href],
    response_types: ["code"],
  });
  if (configuration.serverMetadata().issuer !== issuer) {
    throw new OidcProviderConfigurationError(
      "Discovered OIDC metadata does not match the configured issuer",
    );
  }
  return new OpenIdClientProvider(
    issuer,
    configuration,
    configuredRedirectUri,
    configuredScope,
    dependencies,
  );
}
