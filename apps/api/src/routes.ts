import {
  createProofStackOpenApiDocument,
  DEFAULT_TRACE_PAGE_SIZE,
  EVIDENCE_SCHEMA_VERSION,
  IngestEvidenceRequestSchema,
  IngestEvidenceResponseSchema,
  LivenessResponseSchema,
  MAX_TRACE_PAGE_SIZE,
  OpaqueIdSchema,
  ReadinessResponseSchema,
  TraceIdSchema,
  TracePageCursorSchema,
  TraceResponseSchema,
} from "@proofstack/contracts";
import type { IngestEvidence, ListTraceEvidence } from "@proofstack/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Authenticator } from "./auth.js";
import { decodeTraceCursor, encodeTraceCursor } from "./trace-cursor.js";

const EvidencePathSchema = z
  .object({
    environmentId: OpaqueIdSchema,
    projectId: OpaqueIdSchema,
  })
  .strict();

const TracePathSchema = EvidencePathSchema.extend({ traceId: TraceIdSchema }).strict();
const TraceQuerySchema = z
  .object({
    cursor: TracePageCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_TRACE_PAGE_SIZE).default(DEFAULT_TRACE_PAGE_SIZE),
  })
  .strict();

export interface RouteDependencies {
  readonly authenticator: Authenticator;
  readonly ingestEvidence: IngestEvidence;
  readonly listTraceEvidence: ListTraceEvidence;
}

export async function registerRoutes(
  app: FastifyInstance,
  dependencies: RouteDependencies,
): Promise<void> {
  const openApiDocument = createProofStackOpenApiDocument();

  app.get("/health/live", async () => LivenessResponseSchema.parse({ status: "ok" }));
  app.get("/health/ready", async () => ReadinessResponseSchema.parse({ status: "ready" }));
  app.get("/openapi.json", async (_request, reply) =>
    reply.header("cache-control", "no-store").send(openApiDocument),
  );

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
    {
      config: {
        rateLimit: {
          max: 600,
          timeWindow: "1 minute",
        },
      },
    },
    async (request) => {
      const path = TracePathSchema.parse(request.params);
      const query = TraceQuerySchema.parse(request.query);
      const principal = await dependencies.authenticator.authenticate(request);
      const result = await dependencies.listTraceEvidence.execute({
        ...(query.cursor ? { after: decodeTraceCursor(query.cursor) } : {}),
        environmentId: path.environmentId,
        limit: query.limit,
        principal,
        projectId: path.projectId,
        traceId: path.traceId,
      });
      const lastEvent = result.events.at(-1);
      const nextCursor = result.hasMore && lastEvent ? encodeTraceCursor(lastEvent) : undefined;

      return TraceResponseSchema.parse({
        events: result.events,
        ...(nextCursor ? { nextCursor } : {}),
        requestId: request.id,
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        traceId: path.traceId,
      });
    },
  );
}
