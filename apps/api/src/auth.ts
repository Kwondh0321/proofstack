import { type PrincipalContext, PrincipalContextSchema } from "@proofstack/contracts";
import {
  ApiKeyAuthenticator,
  type ApiKeyCredentialLookup,
  InvalidApiKeyError,
} from "@proofstack/identity";
import type { FastifyRequest } from "fastify";
import type { ApiConfig } from "./config.js";

export interface Authenticator {
  authenticate(request: FastifyRequest): Promise<PrincipalContext>;
}

export interface ApiKeyVerifier {
  authenticate(value: string, requestId: string): Promise<PrincipalContext>;
}

export class AuthenticationRequiredError extends Error {
  constructor(options?: ErrorOptions) {
    super("Authentication is required or invalid", options);
    this.name = "AuthenticationRequiredError";
  }
}

const DEVELOPMENT_CAPABILITIES = [
  "project:read",
  "project:manage",
  "evidence:ingest",
  "evidence:read",
  "evaluation:read",
  "evaluation:run",
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

export interface AuthenticatorDependencies {
  readonly apiKeyCredentials?: ApiKeyCredentialLookup;
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
  throw new Error(`Authentication mode ${config.authMode} is not implemented; startup refused`);
}
