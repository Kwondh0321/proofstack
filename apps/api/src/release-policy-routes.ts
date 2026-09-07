import {
  MAX_RELEASE_POLICY_REQUEST_BYTES,
  MAX_RELEASE_POLICY_RESPONSE_BYTES,
  OpaqueIdSchema,
  type PrincipalContext,
  PrincipalContextSchema,
  PublishReleasePolicyLifecycleRequestSchema,
  PublishReleasePolicyLifecycleResponseSchema,
  PublishReleasePolicyRequestSchema,
  PublishReleasePolicyResponseSchema,
  ReadReleasePolicyLifecycleResponseSchema,
  ReadReleasePolicyResponseSchema,
} from "@proofstack/contracts";
import {
  ForbiddenError,
  type PublishReleasePolicy,
  type PublishReleasePolicyLifecycle,
  type ReadReleasePolicy,
  type ReadReleasePolicyLifecycle,
  requireCapability,
  requireEnvironmentAccess,
} from "@proofstack/core";
import type {
  FastifyInstance,
  FastifyRequest,
  onRequestAsyncHookHandler,
  onSendAsyncHookHandler,
} from "fastify";
import { z } from "zod";
import type { Authenticator } from "./auth.js";

const ReleasePolicyPathSchema = z
  .object({
    environmentId: OpaqueIdSchema,
    policyId: OpaqueIdSchema,
    policyVersionId: OpaqueIdSchema,
    projectId: OpaqueIdSchema,
  })
  .strict();

const ReleasePolicyLifecyclePathSchema = ReleasePolicyPathSchema.extend({
  eventId: OpaqueIdSchema,
}).strict();

export interface ReleasePolicyRouteDependencies {
  readonly authenticator: Authenticator;
  readonly publishLifecycle: Pick<PublishReleasePolicyLifecycle, "execute">;
  readonly publishPolicy: Pick<PublishReleasePolicy, "execute">;
  readonly readLifecycle: Pick<ReadReleasePolicyLifecycle, "execute">;
  readonly readPolicy: Pick<ReadReleasePolicy, "execute">;
}

const mutationRateLimit = { max: 60, timeWindow: "1 minute" } as const;
const readRateLimit = { max: 600, timeWindow: "1 minute" } as const;

const preventCaching: onSendAsyncHookHandler = async (_request, reply, payload) => {
  reply.header("cache-control", "no-store");
  return payload;
};

function validatedResponse<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Release policy route response violates the public contract", {
      cause: parsed.error,
    });
  }
  if (Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > MAX_RELEASE_POLICY_RESPONSE_BYTES) {
    throw new Error("Release policy route response exceeds the public transport budget");
  }
  return parsed.data;
}

export async function registerReleasePolicyRoutes(
  app: FastifyInstance,
  dependencies: ReleasePolicyRouteDependencies,
): Promise<void> {
  const policyRoute =
    "/v1/projects/:projectId/environments/:environmentId/release-policies/:policyId/versions/:policyVersionId";
  const lifecycleRoute = `${policyRoute}/lifecycle-events`;
  const exactLifecycleRoute = `${lifecycleRoute}/:eventId`;
  const principals = new WeakMap<FastifyRequest, PrincipalContext>();

  function authorize(capability: "policy:author" | "policy:read"): onRequestAsyncHookHandler {
    return async (request) => {
      const parsed = PrincipalContextSchema.safeParse(
        await dependencies.authenticator.authenticate(request),
      );
      if (!parsed.success) {
        throw new Error("Release policy authenticator returned an invalid principal", {
          cause: parsed.error,
        });
      }
      const principal = parsed.data;
      requireCapability(principal, capability);
      if (capability === "policy:author" && principal.principalType === "workload") {
        throw new ForbiddenError(
          "Workload principals cannot exercise non-delegable policy authority",
        );
      }
      // Routing supplies these strings; access is checked before their contract or body is parsed.
      const path = request.params as { environmentId: string; projectId: string };
      requireEnvironmentAccess(principal, path.projectId, path.environmentId);
      principals.set(request, principal);
    };
  }

  function authorizedPrincipal(request: FastifyRequest): PrincipalContext {
    const principal = principals.get(request);
    if (!principal) throw new Error("Release policy request did not pass its authority guard");
    return principal;
  }

  const mutationOptions = {
    bodyLimit: MAX_RELEASE_POLICY_REQUEST_BYTES,
    config: { rateLimit: mutationRateLimit },
    onRequest: authorize("policy:author"),
    onSend: preventCaching,
  };
  const readOptions = {
    config: { rateLimit: readRateLimit },
    onRequest: authorize("policy:read"),
    onSend: preventCaching,
  };

  app.post(policyRoute, mutationOptions, async (request, reply) => {
    const principal = authorizedPrincipal(request);
    const path = ReleasePolicyPathSchema.parse(request.params);
    const input = PublishReleasePolicyRequestSchema.parse(request.body);
    const result = await dependencies.publishPolicy.execute({
      environmentId: path.environmentId,
      input,
      policyId: path.policyId,
      policyVersionId: path.policyVersionId,
      principal,
      projectId: path.projectId,
    });
    return reply.status(result.created ? 201 : 200).send(
      validatedResponse(PublishReleasePolicyResponseSchema, {
        created: result.created,
        policy: result.policy,
        requestId: request.id,
      }),
    );
  });

  app.get(policyRoute, readOptions, async (request) => {
    const principal = authorizedPrincipal(request);
    const path = ReleasePolicyPathSchema.parse(request.params);
    const policy = await dependencies.readPolicy.execute({
      environmentId: path.environmentId,
      policyId: path.policyId,
      policyVersionId: path.policyVersionId,
      principal,
      projectId: path.projectId,
    });
    return validatedResponse(ReadReleasePolicyResponseSchema, {
      policy,
      requestId: request.id,
    });
  });

  app.post(lifecycleRoute, mutationOptions, async (request, reply) => {
    const principal = authorizedPrincipal(request);
    const path = ReleasePolicyPathSchema.parse(request.params);
    const input = PublishReleasePolicyLifecycleRequestSchema.parse(request.body);
    const result = await dependencies.publishLifecycle.execute({
      environmentId: path.environmentId,
      input,
      policyId: path.policyId,
      policyVersionId: path.policyVersionId,
      principal,
      projectId: path.projectId,
    });
    return reply.status(result.created ? 201 : 200).send(
      validatedResponse(PublishReleasePolicyLifecycleResponseSchema, {
        created: result.created,
        event: result.event,
        requestId: request.id,
      }),
    );
  });

  app.get(exactLifecycleRoute, readOptions, async (request) => {
    const principal = authorizedPrincipal(request);
    const path = ReleasePolicyLifecyclePathSchema.parse(request.params);
    const event = await dependencies.readLifecycle.execute({
      environmentId: path.environmentId,
      eventId: path.eventId,
      policyId: path.policyId,
      policyVersionId: path.policyVersionId,
      principal,
      projectId: path.projectId,
    });
    return validatedResponse(ReadReleasePolicyLifecycleResponseSchema, {
      event,
      requestId: request.id,
    });
  });
}
