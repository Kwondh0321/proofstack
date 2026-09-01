import {
  CreateModelAssuranceAssessmentRequestSchema,
  ModelAssuranceRecordKindSchema,
  OpaqueIdSchema,
  PublishModelAssuranceDefinitionRequestSchema,
  PublishModelAssuranceRecordResponseSchema,
  ReadModelAssuranceRecordResponseSchema,
  RecordHumanReviewRequestSchema,
  RecordModelAssuranceExecutionRequestSchema,
} from "@proofstack/contracts";
import type {
  CreateModelAssuranceAssessment,
  PublishModelAssuranceDefinition,
  ReadModelAssuranceRecord,
  RecordHumanReview,
  RecordModelAssuranceExecution,
} from "@proofstack/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Authenticator } from "./auth.js";

const ModelAssuranceScopePathSchema = z
  .object({
    environmentId: OpaqueIdSchema,
    projectId: OpaqueIdSchema,
  })
  .strict();

const ModelAssuranceMutationPathSchema = ModelAssuranceScopePathSchema.extend({
  recordId: OpaqueIdSchema,
}).strict();

const ModelAssuranceRecordPathSchema = ModelAssuranceMutationPathSchema.extend({
  kind: ModelAssuranceRecordKindSchema,
}).strict();

export interface ModelAssuranceRouteDependencies {
  readonly authenticator: Authenticator;
  readonly createAssessment: Pick<CreateModelAssuranceAssessment, "execute">;
  readonly publishDefinition: Pick<PublishModelAssuranceDefinition, "execute">;
  readonly readRecord: Pick<ReadModelAssuranceRecord, "execute">;
  readonly recordExecution: Pick<RecordModelAssuranceExecution, "execute">;
  readonly recordHumanReview: Pick<RecordHumanReview, "execute">;
}

const mutationRateLimit = { max: 60, timeWindow: "1 minute" } as const;
const readRateLimit = { max: 600, timeWindow: "1 minute" } as const;

function preventCaching(reply: { header(name: string, value: string): unknown }): void {
  reply.header("cache-control", "no-store");
}

function validatedResponse<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Model-assurance route response violates the public contract", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function command(
  path: z.output<typeof ModelAssuranceMutationPathSchema>,
  principal: Awaited<ReturnType<Authenticator["authenticate"]>>,
) {
  return {
    environmentId: path.environmentId,
    principal,
    projectId: path.projectId,
    recordId: path.recordId,
  };
}

export async function registerModelAssuranceRoutes(
  app: FastifyInstance,
  dependencies: ModelAssuranceRouteDependencies,
): Promise<void> {
  app.post(
    "/v1/projects/:projectId/environments/:environmentId/model-assurance/definitions/:recordId",
    { config: { rateLimit: mutationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = ModelAssuranceMutationPathSchema.parse(request.params);
      const body = PublishModelAssuranceDefinitionRequestSchema.parse(request.body);
      const result = await dependencies.publishDefinition.execute({
        ...command(path, principal),
        definition: body.definition,
        kind: body.kind,
      });
      preventCaching(reply);
      return reply.status(result.created ? 201 : 200).send(
        validatedResponse(PublishModelAssuranceRecordResponseSchema, {
          created: result.created,
          requestId: request.id,
          result: { kind: body.kind, record: result.record },
        }),
      );
    },
  );

  app.post(
    "/v1/projects/:projectId/environments/:environmentId/model-assurance/executions/:recordId",
    { config: { rateLimit: mutationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = ModelAssuranceMutationPathSchema.parse(request.params);
      const body = RecordModelAssuranceExecutionRequestSchema.parse(request.body);
      const result = await dependencies.recordExecution.execute({
        ...command(path, principal),
        definition: body.definition,
        kind: body.kind,
      });
      preventCaching(reply);
      return reply.status(result.created ? 201 : 200).send(
        validatedResponse(PublishModelAssuranceRecordResponseSchema, {
          created: result.created,
          requestId: request.id,
          result: { kind: body.kind, record: result.record },
        }),
      );
    },
  );

  app.post(
    "/v1/projects/:projectId/environments/:environmentId/model-assurance/human-reviews/:recordId",
    { config: { rateLimit: mutationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = ModelAssuranceMutationPathSchema.parse(request.params);
      const body = RecordHumanReviewRequestSchema.parse(request.body);
      const result = await dependencies.recordHumanReview.execute({
        ...command(path, principal),
        definition: body.definition,
        kind: body.kind,
      });
      preventCaching(reply);
      return reply.status(result.created ? 201 : 200).send(
        validatedResponse(PublishModelAssuranceRecordResponseSchema, {
          created: result.created,
          requestId: request.id,
          result: { kind: body.kind, record: result.record },
        }),
      );
    },
  );

  app.post(
    "/v1/projects/:projectId/environments/:environmentId/model-assurance/assessments/:recordId",
    { config: { rateLimit: mutationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = ModelAssuranceMutationPathSchema.parse(request.params);
      const body = CreateModelAssuranceAssessmentRequestSchema.parse(request.body);
      const result = await dependencies.createAssessment.execute({
        ...command(path, principal),
        definition: body.definition,
      });
      preventCaching(reply);
      return reply.status(result.created ? 201 : 200).send(
        validatedResponse(PublishModelAssuranceRecordResponseSchema, {
          created: result.created,
          requestId: request.id,
          result: { kind: body.kind, record: result.record },
        }),
      );
    },
  );

  app.get(
    "/v1/projects/:projectId/environments/:environmentId/model-assurance/records/:kind/:recordId",
    { config: { rateLimit: readRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = ModelAssuranceRecordPathSchema.parse(request.params);
      const record = await dependencies.readRecord.execute({
        ...command(path, principal),
        kind: path.kind,
      });
      preventCaching(reply);
      return validatedResponse(ReadModelAssuranceRecordResponseSchema, {
        requestId: request.id,
        result: { kind: path.kind, record },
      });
    },
  );
}
