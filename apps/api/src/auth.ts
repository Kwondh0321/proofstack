import { PrincipalContextSchema, type PrincipalContext } from "@proofstack/contracts";
import type { FastifyRequest } from "fastify";
import type { ApiConfig } from "./config.js";

export interface Authenticator {
  authenticate(request: FastifyRequest): Promise<PrincipalContext>;
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

export function createAuthenticator(config: ApiConfig): Authenticator {
  if (config.authMode === "development") return new DevelopmentAuthenticator();
  throw new Error(`Authentication mode ${config.authMode} is not implemented; startup refused`);
}
