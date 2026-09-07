import {
  OpaqueIdSchema,
  PublishReleasePolicyLifecycleRequestSchema,
  PublishReleasePolicyLifecycleResponseSchema,
  PublishReleasePolicyRequestSchema,
  PublishReleasePolicyResponseSchema,
  ReadReleasePolicyLifecycleResponseSchema,
  ReadReleasePolicyResponseSchema,
} from "@proofstack/contracts";
import type {
  PublishReleasePolicy,
  PublishReleasePolicyLifecycle,
  ReadReleasePolicy,
  ReadReleasePolicyLifecycle,
} from "@proofstack/core";
import type { FastifyInstance, onSendAsyncHookHandler } from "fastify";
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

const mutationOptions = { config: { rateLimit: mutationRateLimit }, onSend: preventCaching };
const readOptions = { config: { rateLimit: readRateLimit }, onSend: preventCaching };

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

  app.post(policyRoute, mutationOptions, async (request, reply) => {
    const principal = await dependencies.authenticator.authenticate(request);
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
    const principal = await dependencies.authenticator.authenticate(request);
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
    const principal = await dependencies.authenticator.authenticate(request);
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
    const principal = await dependencies.authenticator.authenticate(request);
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
