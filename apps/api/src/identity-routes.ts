import {
  IssueApiKeyRequestSchema,
  IssueApiKeyResponseSchema,
  OpaqueIdSchema,
  RevokeApiKeyRequestSchema,
  RevokeApiKeyResponseSchema,
  RotateApiKeyRequestSchema,
  RotateApiKeyResponseSchema,
} from "@proofstack/contracts";
import type { ApiKeyLifecycle } from "@proofstack/identity";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Authenticator } from "./auth.js";

const ApiKeyPathSchema = z.object({ credentialId: OpaqueIdSchema }).strict();

export type ApiKeyLifecycleService = Pick<ApiKeyLifecycle, "issue" | "revoke" | "rotate">;

export interface IdentityRouteDependencies {
  readonly apiKeyLifecycle?: ApiKeyLifecycleService;
  readonly authenticator: Authenticator;
}

export class IdentityManagementUnavailableError extends Error {
  constructor() {
    super("Identity management storage is unavailable");
    this.name = "IdentityManagementUnavailableError";
  }
}

function requireLifecycle(lifecycle: ApiKeyLifecycleService | undefined): ApiKeyLifecycleService {
  if (!lifecycle) throw new IdentityManagementUnavailableError();
  return lifecycle;
}

function oneTimeCredentialReply(reply: FastifyReply): FastifyReply {
  return reply.header("cache-control", "no-store").header("pragma", "no-cache");
}

export async function registerIdentityRoutes(
  app: FastifyInstance,
  dependencies: IdentityRouteDependencies,
): Promise<void> {
  app.post(
    "/v1/identity/api-keys",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const issuer = await dependencies.authenticator.authenticate(request);
      const lifecycle = requireLifecycle(dependencies.apiKeyLifecycle);
      const body = IssueApiKeyRequestSchema.parse(request.body);
      const result = await lifecycle.issue({
        capabilities: body.capabilities,
        ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
        issuer,
        name: body.name,
        resourceScope: body.resourceScope,
      });
      return oneTimeCredentialReply(reply)
        .status(201)
        .send(
          IssueApiKeyResponseSchema.parse({
            credential: result.credential,
            requestId: request.id,
            value: result.value,
          }),
        );
    },
  );

  app.post(
    "/v1/identity/api-keys/:credentialId/rotate",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const issuer = await dependencies.authenticator.authenticate(request);
      const lifecycle = requireLifecycle(dependencies.apiKeyLifecycle);
      const path = ApiKeyPathSchema.parse(request.params);
      const body = RotateApiKeyRequestSchema.parse(request.body ?? {});
      const result = await lifecycle.rotate({
        credentialId: path.credentialId,
        ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
        issuer,
      });
      return oneTimeCredentialReply(reply).send(
        RotateApiKeyResponseSchema.parse({
          credential: result.credential,
          requestId: request.id,
          value: result.value,
        }),
      );
    },
  );

  app.post(
    "/v1/identity/api-keys/:credentialId/revoke",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const issuer = await dependencies.authenticator.authenticate(request);
      const lifecycle = requireLifecycle(dependencies.apiKeyLifecycle);
      const path = ApiKeyPathSchema.parse(request.params);
      const body = RevokeApiKeyRequestSchema.parse(request.body);
      const revoked = await lifecycle.revoke({
        credentialId: path.credentialId,
        issuer,
        reason: body.reason,
      });
      return RevokeApiKeyResponseSchema.parse({
        credentialId: path.credentialId,
        requestId: request.id,
        revoked,
      });
    },
  );
}
