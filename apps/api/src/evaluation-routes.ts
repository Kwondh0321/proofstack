import {
  CreateAssessmentRequestSchema,
  EvaluationRecordKindSchema,
  OpaqueIdSchema,
  PublishEvaluationDefinitionRequestSchema,
  PublishEvaluationRecordResponseSchema,
  ReadEvaluationRecordResponseSchema,
  RecordCriterionSetStatusRequestSchema,
  RecordEvaluationRunDecisionRequestSchema,
} from "@proofstack/contracts";
import type {
  CreateAssessment,
  PublishEvaluationDefinition,
  ReadEvaluationRecord,
  RecordCriterionSetStatus,
  RecordEvaluationRunDecision,
} from "@proofstack/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Authenticator } from "./auth.js";

const EvaluationScopePathSchema = z
  .object({
    environmentId: OpaqueIdSchema,
    projectId: OpaqueIdSchema,
  })
  .strict();

const EvaluationMutationPathSchema = EvaluationScopePathSchema.extend({
  recordId: OpaqueIdSchema,
}).strict();

const EvaluationRecordPathSchema = EvaluationMutationPathSchema.extend({
  kind: EvaluationRecordKindSchema,
}).strict();

export interface EvaluationRouteDependencies {
  readonly authenticator: Authenticator;
  readonly createAssessment: Pick<CreateAssessment, "execute">;
  readonly publishDefinition: Pick<PublishEvaluationDefinition, "execute">;
  readonly readRecord: Pick<ReadEvaluationRecord, "execute">;
  readonly recordCriterionSetStatus: Pick<RecordCriterionSetStatus, "execute">;
  readonly recordRunDecision: Pick<RecordEvaluationRunDecision, "execute">;
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
    throw new Error("Evaluation route response violates the public contract", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function command(
  path: z.output<typeof EvaluationMutationPathSchema>,
  principal: Awaited<ReturnType<Authenticator["authenticate"]>>,
) {
  return {
    environmentId: path.environmentId,
    principal,
    projectId: path.projectId,
    recordId: path.recordId,
  };
}

export async function registerEvaluationRoutes(
  app: FastifyInstance,
  dependencies: EvaluationRouteDependencies,
): Promise<void> {
  app.post(
    "/v1/projects/:projectId/environments/:environmentId/evaluations/definitions/:recordId",
    { config: { rateLimit: mutationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = EvaluationMutationPathSchema.parse(request.params);
      const body = PublishEvaluationDefinitionRequestSchema.parse(request.body);
      const result = await dependencies.publishDefinition.execute({
        ...command(path, principal),
        definition: body.definition,
        kind: body.kind,
      });
      preventCaching(reply);
      return reply.status(result.created ? 201 : 200).send(
        validatedResponse(PublishEvaluationRecordResponseSchema, {
          created: result.created,
          requestId: request.id,
          result: { kind: body.kind, record: result.record },
        }),
      );
    },
  );

  app.post(
    "/v1/projects/:projectId/environments/:environmentId/evaluations/criterion-set-statuses/:recordId",
    { config: { rateLimit: mutationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = EvaluationMutationPathSchema.parse(request.params);
      const body = RecordCriterionSetStatusRequestSchema.parse(request.body);
      const result = await dependencies.recordCriterionSetStatus.execute({
        ...command(path, principal),
        definition: body.definition,
        kind: body.kind,
      });
      preventCaching(reply);
      return reply.status(result.created ? 201 : 200).send(
        validatedResponse(PublishEvaluationRecordResponseSchema, {
          created: result.created,
          requestId: request.id,
          result: { kind: body.kind, record: result.record },
        }),
      );
    },
  );

  app.post(
    "/v1/projects/:projectId/environments/:environmentId/evaluations/run-decisions/:recordId",
    { config: { rateLimit: mutationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = EvaluationMutationPathSchema.parse(request.params);
      const body = RecordEvaluationRunDecisionRequestSchema.parse(request.body);
      const result = await dependencies.recordRunDecision.execute({
        ...command(path, principal),
        definition: body.definition,
        kind: body.kind,
      });
      preventCaching(reply);
      return reply.status(result.created ? 201 : 200).send(
        validatedResponse(PublishEvaluationRecordResponseSchema, {
          created: result.created,
          requestId: request.id,
          result: { kind: body.kind, record: result.record },
        }),
      );
    },
  );

  app.post(
    "/v1/projects/:projectId/environments/:environmentId/evaluations/assessments/:recordId",
    { config: { rateLimit: mutationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = EvaluationMutationPathSchema.parse(request.params);
      const body = CreateAssessmentRequestSchema.parse(request.body);
      const result = await dependencies.createAssessment.execute({
        ...command(path, principal),
        definition: body.definition,
        kind: body.kind,
      });
      preventCaching(reply);
      return reply.status(result.created ? 201 : 200).send(
        validatedResponse(PublishEvaluationRecordResponseSchema, {
          created: result.created,
          requestId: request.id,
          result: { kind: body.kind, record: result.record },
        }),
      );
    },
  );

  app.get(
    "/v1/projects/:projectId/environments/:environmentId/evaluations/records/:kind/:recordId",
    { config: { rateLimit: readRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = EvaluationRecordPathSchema.parse(request.params);
      const record = await dependencies.readRecord.execute({
        ...command(path, principal),
        kind: path.kind,
      });
      preventCaching(reply);
      return validatedResponse(ReadEvaluationRecordResponseSchema, {
        requestId: request.id,
        result: { kind: path.kind, record },
      });
    },
  );
}
