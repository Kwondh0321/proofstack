import {
  CreateReplayJobRequestSchema,
  CreateReplayJobResponseSchema,
  OpaqueIdSchema,
  PublishReplayPlanResponseSchema,
  PublishTargetReleaseResponseSchema,
  ReadReplayJobResponseSchema,
  ReadReplayPlanResponseSchema,
  ReadTargetReleaseResponseSchema,
  ReplayPlanDefinitionSchema,
  RequestReplayCancellationResponseSchema,
  RequestReplayCancellationSchema,
  TargetReleaseDefinitionSchema,
} from "@proofstack/contracts";
import type {
  CreateDurableReplayJob,
  PublishReplayPlan,
  PublishTargetRelease,
  ReadReplayJob,
  ReadReplayPlan,
  ReadTargetRelease,
  RequestDurableReplayCancellation,
} from "@proofstack/replay";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Authenticator } from "./auth.js";

const ReplayScopePathSchema = z
  .object({
    environmentId: OpaqueIdSchema,
    projectId: OpaqueIdSchema,
  })
  .strict();

const TargetReleasePathSchema = ReplayScopePathSchema.extend({
  targetId: OpaqueIdSchema,
  targetReleaseId: OpaqueIdSchema,
}).strict();

const ReplayPlanPathSchema = ReplayScopePathSchema.extend({
  planId: OpaqueIdSchema,
  planVersionId: OpaqueIdSchema,
}).strict();

const ReplayJobPathSchema = ReplayScopePathSchema.extend({
  jobId: OpaqueIdSchema,
}).strict();

const ReplayCancellationPathSchema = ReplayJobPathSchema.extend({
  cancellationId: OpaqueIdSchema,
}).strict();

export interface ReplayRouteDependencies {
  readonly authenticator: Authenticator;
  readonly createJob: Pick<CreateDurableReplayJob, "execute">;
  readonly publishPlan: Pick<PublishReplayPlan, "execute">;
  readonly publishTargetRelease: Pick<PublishTargetRelease, "execute">;
  readonly readJob: Pick<ReadReplayJob, "execute">;
  readonly readPlan: Pick<ReadReplayPlan, "execute">;
  readonly readTargetRelease: Pick<ReadTargetRelease, "execute">;
  readonly requestCancellation: Pick<RequestDurableReplayCancellation, "execute">;
}

const mutationRateLimit = {
  max: 60,
  timeWindow: "1 minute",
} as const;

const readRateLimit = {
  max: 600,
  timeWindow: "1 minute",
} as const;

function preventCaching(reply: { header(name: string, value: string): unknown }): void {
  reply.header("cache-control", "no-store");
}

function validatedResponse<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Replay route response violates the public contract", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export async function registerReplayRoutes(
  app: FastifyInstance,
  dependencies: ReplayRouteDependencies,
): Promise<void> {
  app.post(
    "/v1/projects/:projectId/environments/:environmentId/replay-targets/:targetId/releases/:targetReleaseId",
    { config: { rateLimit: mutationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = TargetReleasePathSchema.parse(request.params);
      const definition = TargetReleaseDefinitionSchema.parse(request.body);
      const result = await dependencies.publishTargetRelease.execute({
        definition,
        environmentId: path.environmentId,
        principal,
        projectId: path.projectId,
        targetId: path.targetId,
        targetReleaseId: path.targetReleaseId,
      });
      preventCaching(reply);
      return reply.status(result.created ? 201 : 200).send(
        validatedResponse(PublishTargetReleaseResponseSchema, {
          created: result.created,
          release: result.release,
          requestId: request.id,
        }),
      );
    },
  );

  app.get(
    "/v1/projects/:projectId/environments/:environmentId/replay-targets/:targetId/releases/:targetReleaseId",
    { config: { rateLimit: readRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = TargetReleasePathSchema.parse(request.params);
      const release = await dependencies.readTargetRelease.execute({
        environmentId: path.environmentId,
        principal,
        projectId: path.projectId,
        targetId: path.targetId,
        targetReleaseId: path.targetReleaseId,
      });
      preventCaching(reply);
      return validatedResponse(ReadTargetReleaseResponseSchema, {
        release,
        requestId: request.id,
      });
    },
  );

  app.post(
    "/v1/projects/:projectId/environments/:environmentId/replay-plans/:planId/versions/:planVersionId",
    { config: { rateLimit: mutationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = ReplayPlanPathSchema.parse(request.params);
      const definition = ReplayPlanDefinitionSchema.parse(request.body);
      const result = await dependencies.publishPlan.execute({
        definition,
        environmentId: path.environmentId,
        planId: path.planId,
        planVersionId: path.planVersionId,
        principal,
        projectId: path.projectId,
      });
      preventCaching(reply);
      return reply.status(result.created ? 201 : 200).send(
        validatedResponse(PublishReplayPlanResponseSchema, {
          created: result.created,
          plan: result.plan,
          requestId: request.id,
        }),
      );
    },
  );

  app.get(
    "/v1/projects/:projectId/environments/:environmentId/replay-plans/:planId/versions/:planVersionId",
    { config: { rateLimit: readRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = ReplayPlanPathSchema.parse(request.params);
      const plan = await dependencies.readPlan.execute({
        environmentId: path.environmentId,
        planId: path.planId,
        planVersionId: path.planVersionId,
        principal,
        projectId: path.projectId,
      });
      preventCaching(reply);
      return validatedResponse(ReadReplayPlanResponseSchema, { plan, requestId: request.id });
    },
  );

  app.post(
    "/v1/projects/:projectId/environments/:environmentId/replay-jobs/:jobId",
    { config: { rateLimit: mutationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = ReplayJobPathSchema.parse(request.params);
      const body = CreateReplayJobRequestSchema.parse(request.body);
      const result = await dependencies.createJob.execute({
        environmentId: path.environmentId,
        jobId: path.jobId,
        principal,
        projectId: path.projectId,
        request: body,
      });
      preventCaching(reply);
      return reply.status(result.created ? 201 : 200).send(
        validatedResponse(CreateReplayJobResponseSchema, {
          created: result.created,
          requestId: request.id,
          snapshot: result.snapshot,
        }),
      );
    },
  );

  app.get(
    "/v1/projects/:projectId/environments/:environmentId/replay-jobs/:jobId",
    { config: { rateLimit: readRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = ReplayJobPathSchema.parse(request.params);
      const snapshot = await dependencies.readJob.execute({
        environmentId: path.environmentId,
        jobId: path.jobId,
        principal,
        projectId: path.projectId,
      });
      preventCaching(reply);
      return validatedResponse(ReadReplayJobResponseSchema, { requestId: request.id, snapshot });
    },
  );

  app.post(
    "/v1/projects/:projectId/environments/:environmentId/replay-jobs/:jobId/cancellation-requests/:cancellationId",
    { config: { rateLimit: mutationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = ReplayCancellationPathSchema.parse(request.params);
      const body = RequestReplayCancellationSchema.refine(
        (value) => value.cancellationId === path.cancellationId,
        {
          message: "cancellationId must match the exact route identifier",
          path: ["cancellationId"],
        },
      ).parse(request.body);
      const result = await dependencies.requestCancellation.execute({
        environmentId: path.environmentId,
        jobId: path.jobId,
        principal,
        projectId: path.projectId,
        request: body,
      });
      preventCaching(reply);
      return reply.status(result.created ? 201 : 200).send(
        validatedResponse(RequestReplayCancellationResponseSchema, {
          created: result.created,
          requestId: request.id,
          snapshot: result.snapshot,
        }),
      );
    },
  );
}
