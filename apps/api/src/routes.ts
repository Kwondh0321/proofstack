import {
  EVIDENCE_SCHEMA_VERSION,
  IngestEvidenceResponseSchema,
  IngestEvidenceRequestSchema,
  LivenessResponseSchema,
  OpaqueIdSchema,
  ReadinessResponseSchema,
  TraceIdSchema,
  TraceResponseSchema,
} from "@proofstack/contracts";
import type { IngestEvidence, ListTraceEvidence } from "@proofstack/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Authenticator } from "./auth.js";

const EvidencePathSchema = z
  .object({
    environmentId: OpaqueIdSchema,
    projectId: OpaqueIdSchema,
  })
  .strict();

const TracePathSchema = EvidencePathSchema.extend({ traceId: TraceIdSchema }).strict();

export interface RouteDependencies {
  readonly authenticator: Authenticator;
  readonly ingestEvidence: IngestEvidence;
  readonly listTraceEvidence: ListTraceEvidence;
}

export async function registerRoutes(
  app: FastifyInstance,
  dependencies: RouteDependencies,
): Promise<void> {
  app.get("/health/live", async () => LivenessResponseSchema.parse({ status: "ok" }));
  app.get("/health/ready", async () => ReadinessResponseSchema.parse({ status: "ready" }));

  app.post(
    "/v1/projects/:projectId/environments/:environmentId/evidence",
    {
      config: {
        rateLimit: {
          max: 120,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const path = EvidencePathSchema.parse(request.params);
      const body = IngestEvidenceRequestSchema.parse(request.body);
      const principal = await dependencies.authenticator.authenticate(request);

      const result = await dependencies.ingestEvidence.execute({
        environmentId: path.environmentId,
        principal,
        projectId: path.projectId,
        request: body,
      });

      return reply.status(202).send(
        IngestEvidenceResponseSchema.parse({
          acceptedEventIds: result.acceptedEventIds,
          duplicateEventIds: result.duplicateEventIds,
          requestId: request.id,
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
        }),
      );
    },
  );

  app.get(
    "/v1/projects/:projectId/environments/:environmentId/traces/:traceId",
    async (request) => {
      const path = TracePathSchema.parse(request.params);
      const principal = await dependencies.authenticator.authenticate(request);
      const events = await dependencies.listTraceEvidence.execute({
        environmentId: path.environmentId,
        principal,
        projectId: path.projectId,
        traceId: path.traceId,
      });

      return TraceResponseSchema.parse({
        events,
        requestId: request.id,
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        traceId: path.traceId,
      });
    },
  );
}
