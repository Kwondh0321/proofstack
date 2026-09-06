import {
  OpaqueIdSchema,
  PublishReleaseCandidateRequestSchema,
  PublishReleaseCandidateResponseSchema,
  ReadReleaseCandidateResponseSchema,
} from "@proofstack/contracts";
import type { PublishReleaseCandidate, ReadReleaseCandidate } from "@proofstack/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Authenticator } from "./auth.js";

const ReleaseCandidateScopePathSchema = z
  .object({
    environmentId: OpaqueIdSchema,
    projectId: OpaqueIdSchema,
  })
  .strict();

const ReleaseCandidatePathSchema = ReleaseCandidateScopePathSchema.extend({
  candidateId: OpaqueIdSchema,
  candidateVersionId: OpaqueIdSchema,
}).strict();

export interface ReleaseCandidateRouteDependencies {
  readonly authenticator: Authenticator;
  readonly publishCandidate: Pick<PublishReleaseCandidate, "execute">;
  readonly readCandidate: Pick<ReadReleaseCandidate, "execute">;
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
    throw new Error("Release candidate route response violates the public contract", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export async function registerReleaseCandidateRoutes(
  app: FastifyInstance,
  dependencies: ReleaseCandidateRouteDependencies,
): Promise<void> {
  const route =
    "/v1/projects/:projectId/environments/:environmentId/release-candidates/:candidateId/versions/:candidateVersionId";

  app.post(route, { config: { rateLimit: mutationRateLimit } }, async (request, reply) => {
    const principal = await dependencies.authenticator.authenticate(request);
    const path = ReleaseCandidatePathSchema.parse(request.params);
    const input = PublishReleaseCandidateRequestSchema.parse(request.body);
    const result = await dependencies.publishCandidate.execute({
      candidateId: path.candidateId,
      candidateVersionId: path.candidateVersionId,
      environmentId: path.environmentId,
      input,
      principal,
      projectId: path.projectId,
    });
    preventCaching(reply);
    return reply.status(result.created ? 201 : 200).send(
      validatedResponse(PublishReleaseCandidateResponseSchema, {
        candidate: result.candidate,
        created: result.created,
        requestId: request.id,
      }),
    );
  });

  app.get(route, { config: { rateLimit: readRateLimit } }, async (request, reply) => {
    const principal = await dependencies.authenticator.authenticate(request);
    const path = ReleaseCandidatePathSchema.parse(request.params);
    const candidate = await dependencies.readCandidate.execute({
      candidateId: path.candidateId,
      candidateVersionId: path.candidateVersionId,
      environmentId: path.environmentId,
      principal,
      projectId: path.projectId,
    });
    preventCaching(reply);
    return validatedResponse(ReadReleaseCandidateResponseSchema, {
      candidate,
      requestId: request.id,
    });
  });
}
