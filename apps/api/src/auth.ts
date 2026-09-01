import { type PrincipalContext, PrincipalContextSchema } from "@proofstack/contracts";
import {
  ApiKeyAuthenticator,
  type ApiKeyCredentialLookup,
  type AuthenticatedBrowserSession,
  type BrowserSessionLookup,
  InvalidApiKeyError,
  InvalidBrowserSessionError,
  OidcSessionAuthenticator,
  requireBrowserCsrfToken,
} from "@proofstack/identity";
import type { FastifyRequest } from "fastify";
import type { ApiConfig } from "./config.js";

export interface Authenticator {
  authenticate(request: FastifyRequest): Promise<PrincipalContext>;
}

export interface ApiKeyVerifier {
  authenticate(value: string, requestId: string): Promise<PrincipalContext>;
}

export interface BrowserSessionVerifier {
  authenticate(value: string, requestId: string): Promise<AuthenticatedBrowserSession>;
}

export class AuthenticationRequiredError extends Error {
  constructor(options?: ErrorOptions) {
    super("Authentication is required or invalid", options);
    this.name = "AuthenticationRequiredError";
  }
}

export class BrowserRequestRejectedError extends Error {
  constructor(options?: ErrorOptions) {
    super("Browser request origin or CSRF verification failed", options);
    this.name = "BrowserRequestRejectedError";
  }
}

export const BROWSER_SESSION_COOKIE = "__Host-proofstack_session";
export const BROWSER_CSRF_COOKIE = "__Host-proofstack_csrf";

export function readSingleCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const values: string[] = [];
  for (const segment of header.split(";")) {
    const trimmed = segment.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0 || trimmed.slice(0, separator) !== name) continue;
    values.push(trimmed.slice(separator + 1));
  }
  return values.length === 1 && values[0] !== "" ? (values[0] ?? null) : null;
}

function requiresCsrf(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

const DEVELOPMENT_CAPABILITIES = [
  "project:read",
  "project:manage",
  "evidence:ingest",
  "evidence:read",
  "artifact:write",
  "artifact:read",
  "artifact:read:restricted",
  "artifact:delete",
  "dataset:read",
  "dataset:manage",
  "replay:read",
  "replay:run",
  "replay:cancel",
  "replay:manage",
  "evaluation:read",
  "evaluation:run",
  "evaluation:model:run",
  "evaluation:human:review",
  "evaluation:manage",
  "release:read",
  "release:manage",
  "policy:evaluate",
  "policy:manage",
  "approval:decide",
  "audit:read",
  "identity:read",
  "identity:manage",
] as const;

class DevelopmentAuthenticator implements Authenticator {
  async authenticate(request: FastifyRequest): Promise<PrincipalContext> {
    return PrincipalContextSchema.parse({
      authentication: {
        authenticatedAt: new Date().toISOString(),
        method: "development",
      },
      capabilities: DEVELOPMENT_CAPABILITIES,
      principalId: "usr_local",
      principalType: "user",
      requestId: request.id,
      resourceScope: { mode: "tenant" },
      roles: ["owner"],
      tenantId: "ten_local",
    });
  }
}

export class ApiKeyRequestAuthenticator implements Authenticator {
  constructor(private readonly verifier: ApiKeyVerifier) {}

  async authenticate(request: FastifyRequest): Promise<PrincipalContext> {
    const authorization = request.headers.authorization;
    const match =
      typeof authorization === "string" ? /^Bearer ([^\s,]+)$/i.exec(authorization) : null;
    const value = match?.[1];
    if (!value) throw new AuthenticationRequiredError();

    try {
      return await this.verifier.authenticate(value, request.id);
    } catch (error) {
      if (error instanceof InvalidApiKeyError) {
        throw new AuthenticationRequiredError({ cause: error });
      }
      throw error;
    }
  }
}

export class BrowserSessionRequestAuthenticator implements Authenticator {
  constructor(
    private readonly verifier: BrowserSessionVerifier,
    private readonly allowedOrigin: string,
  ) {}

  async authenticate(request: FastifyRequest): Promise<PrincipalContext> {
    return (await this.authenticateSession(request)).principal;
  }

  async authenticateSession(request: FastifyRequest): Promise<AuthenticatedBrowserSession> {
    const sessionToken = readSingleCookie(request.headers.cookie, BROWSER_SESSION_COOKIE);
    if (!sessionToken) throw new AuthenticationRequiredError();

    let authenticated: AuthenticatedBrowserSession;
    try {
      authenticated = await this.verifier.authenticate(sessionToken, request.id);
    } catch (error) {
      if (error instanceof InvalidBrowserSessionError) {
        throw new AuthenticationRequiredError({ cause: error });
      }
      throw error;
    }

    if (requiresCsrf(request.method)) {
      const csrfCookie = readSingleCookie(request.headers.cookie, BROWSER_CSRF_COOKIE);
      const csrfHeader = request.headers["x-proofstack-csrf"];
      const origin = request.headers.origin;
      if (
        origin !== this.allowedOrigin ||
        typeof csrfHeader !== "string" ||
        !csrfCookie ||
        csrfHeader !== csrfCookie
      ) {
        throw new BrowserRequestRejectedError();
      }
      try {
        requireBrowserCsrfToken(csrfHeader, authenticated.csrfDigest);
      } catch (error) {
        throw new BrowserRequestRejectedError({ cause: error });
      }
    }
    return authenticated;
  }
}

export class CombinedRequestAuthenticator implements Authenticator {
  constructor(
    private readonly apiKeys: ApiKeyRequestAuthenticator,
    private readonly browserSessions: BrowserSessionRequestAuthenticator,
  ) {}

  authenticate(request: FastifyRequest): Promise<PrincipalContext> {
    return request.headers.authorization === undefined
      ? this.browserSessions.authenticate(request)
      : this.apiKeys.authenticate(request);
  }
}

export interface AuthenticatorDependencies {
  readonly apiKeyCredentials?: ApiKeyCredentialLookup;
  readonly browserAuthenticator?: BrowserSessionRequestAuthenticator;
  readonly browserSessions?: BrowserSessionLookup;
}

export function createAuthenticator(
  config: ApiConfig,
  dependencies: AuthenticatorDependencies = {},
): Authenticator {
  if (config.authMode === "development") return new DevelopmentAuthenticator();
  if (config.authMode === "api_key") {
    if (!dependencies.apiKeyCredentials) {
      throw new Error("API key identity storage is unavailable; startup refused");
    }
    return new ApiKeyRequestAuthenticator(new ApiKeyAuthenticator(dependencies.apiKeyCredentials));
  }
  if (!config.oidc) {
    throw new Error("OIDC browser session storage is unavailable; startup refused");
  }
  const browserOrigin = config.corsOrigin ?? new URL(config.oidc.redirectUri).origin;
  let browserSessions = dependencies.browserAuthenticator;
  if (!browserSessions) {
    if (!dependencies.browserSessions) {
      throw new Error("OIDC browser session storage is unavailable; startup refused");
    }
    browserSessions = new BrowserSessionRequestAuthenticator(
      new OidcSessionAuthenticator(dependencies.browserSessions),
      browserOrigin,
    );
  }
  if (config.authMode === "oidc") return browserSessions;
  if (!dependencies.apiKeyCredentials) {
    throw new Error("API key identity storage is unavailable; startup refused");
  }
  return new CombinedRequestAuthenticator(
    new ApiKeyRequestAuthenticator(new ApiKeyAuthenticator(dependencies.apiKeyCredentials)),
    browserSessions,
  );
}
