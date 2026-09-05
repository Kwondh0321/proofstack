import {
  ComparisonRecordKindSchema,
  CreateComparisonEvidenceSnapshotRequestSchema,
  DeriveComparisonResultRequestSchema,
  OpaqueIdSchema,
  PublishComparisonDefinitionRequestSchema,
  PublishComparisonRecordResponseSchema,
  ReadComparisonRecordResponseSchema,
} from "@proofstack/contracts";
import type {
  CreateComparisonEvidenceSnapshot,
  DeriveComparisonResult,
  PublishComparisonDefinition,
  ReadComparisonRecord,
} from "@proofstack/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Authenticator } from "./auth.js";

const ComparisonScopePathSchema = z
  .object({
    environmentId: OpaqueIdSchema,
    projectId: OpaqueIdSchema,
  })
  .strict();

const ComparisonDefinitionPathSchema = ComparisonScopePathSchema.extend({
  comparisonId: OpaqueIdSchema,
  comparisonVersionId: OpaqueIdSchema,
}).strict();

const ComparisonSnapshotPathSchema = ComparisonScopePathSchema.extend({
  snapshotId: OpaqueIdSchema,
}).strict();

const ComparisonResultPathSchema = ComparisonScopePathSchema.extend({
  resultId: OpaqueIdSchema,
}).strict();

const ComparisonRecordPathSchema = ComparisonScopePathSchema.extend({
  kind: ComparisonRecordKindSchema,
  recordId: OpaqueIdSchema,
}).strict();

export interface ComparisonRouteDependencies {
  readonly authenticator: Authenticator;
  readonly createSnapshot: Pick<CreateComparisonEvidenceSnapshot, "execute">;
  readonly deriveResult: Pick<DeriveComparisonResult, "execute">;
  readonly publishDefinition: Pick<PublishComparisonDefinition, "execute">;
  readonly readRecord: Pick<ReadComparisonRecord, "execute">;
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
    throw new Error("Comparison route response violates the public contract", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function route(
  path: z.output<typeof ComparisonScopePathSchema>,
  principal: Awaited<ReturnType<Authenticator["authenticate"]>>,
) {
  return {
    environmentId: path.environmentId,
    principal,
    projectId: path.projectId,
  };
}

export async function registerComparisonRoutes(
  app: FastifyInstance,
  dependencies: ComparisonRouteDependencies,
): Promise<void> {
  app.post(
    "/v1/projects/:projectId/environments/:environmentId/comparisons/:comparisonId/definitions/:comparisonVersionId",
    { config: { rateLimit: mutationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = ComparisonDefinitionPathSchema.parse(request.params);
      const input = PublishComparisonDefinitionRequestSchema.parse(request.body);
      const result = await dependencies.publishDefinition.execute({
        ...route(path, principal),
        comparisonId: path.comparisonId,
        comparisonVersionId: path.comparisonVersionId,
        input,
      });
      preventCaching(reply);
      return reply.status(result.created ? 201 : 200).send(
        validatedResponse(PublishComparisonRecordResponseSchema, {
          created: result.created,
          requestId: request.id,
          result: { kind: "comparison_definition", record: result.record },
        }),
      );
    },
  );

  app.post(
    "/v1/projects/:projectId/environments/:environmentId/comparisons/evidence-snapshots/:snapshotId",
    { config: { rateLimit: mutationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = ComparisonSnapshotPathSchema.parse(request.params);
      const input = CreateComparisonEvidenceSnapshotRequestSchema.parse(request.body);
      const result = await dependencies.createSnapshot.execute({
        ...route(path, principal),
        input,
        snapshotId: path.snapshotId,
      });
      preventCaching(reply);
      return reply.status(result.created ? 201 : 200).send(
        validatedResponse(PublishComparisonRecordResponseSchema, {
          created: result.created,
          requestId: request.id,
          result: { kind: "comparison_evidence_snapshot", record: result.record },
        }),
      );
    },
  );

  app.post(
    "/v1/projects/:projectId/environments/:environmentId/comparisons/results/:resultId",
    { config: { rateLimit: mutationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = ComparisonResultPathSchema.parse(request.params);
      const input = DeriveComparisonResultRequestSchema.parse(request.body);
      const result = await dependencies.deriveResult.execute({
        ...route(path, principal),
        input,
        resultId: path.resultId,
      });
      preventCaching(reply);
      return reply.status(result.created ? 201 : 200).send(
        validatedResponse(PublishComparisonRecordResponseSchema, {
          created: result.created,
          requestId: request.id,
          result: { kind: "comparison_result", record: result.record },
        }),
      );
    },
  );

  app.get(
    "/v1/projects/:projectId/environments/:environmentId/comparisons/records/:kind/:recordId",
    { config: { rateLimit: readRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = ComparisonRecordPathSchema.parse(request.params);
      const record = await dependencies.readRecord.execute({
        ...route(path, principal),
        kind: path.kind,
        recordId: path.recordId,
      });
      preventCaching(reply);
      return validatedResponse(ReadComparisonRecordResponseSchema, {
        requestId: request.id,
        result: { kind: path.kind, record },
      });
    },
  );
}
