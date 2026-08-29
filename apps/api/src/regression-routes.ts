import {
  OpaqueIdSchema,
  PublishInteractionFixtureVersionRequestSchema,
  PublishRecordedInteractionFixtureVersionResponseSchema,
  PublishRegressionDatasetVersionRequestSchema,
  PublishRegressionDatasetVersionResponseSchema,
  PublishRegressionFixtureVersionRequestSchema,
  PublishRegressionFixtureVersionResponseSchema,
  ReadRecordedInteractionFixtureMetadataResponseSchema,
  ReadRegressionDatasetVersionResponseSchema,
  ReadRegressionFixtureVersionResponseSchema,
  RevokeInteractionFixtureContentRequestSchema,
  RevokeRecordedInteractionFixtureContentResponseSchema,
} from "@proofstack/contracts";
import type {
  PublishRecordedInteractionFixtureVersion,
  PublishRegressionDatasetVersion,
  PublishRegressionFixtureVersion,
  ReadRecordedInteractionFixtureMetadata,
  ReadRegressionDatasetVersion,
  ReadRegressionFixtureVersion,
  RevokeRecordedInteractionFixtureContent,
} from "@proofstack/datasets";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Authenticator } from "./auth.js";

const RegressionFixturePathSchema = z
  .object({
    environmentId: OpaqueIdSchema,
    fixtureId: OpaqueIdSchema,
    projectId: OpaqueIdSchema,
  })
  .strict();

const RegressionFixtureVersionPathSchema = RegressionFixturePathSchema.extend({
  fixtureVersionId: OpaqueIdSchema,
}).strict();

const RegressionDatasetPathSchema = z
  .object({
    datasetId: OpaqueIdSchema,
    environmentId: OpaqueIdSchema,
    projectId: OpaqueIdSchema,
  })
  .strict();

const RegressionDatasetVersionPathSchema = RegressionDatasetPathSchema.extend({
  datasetVersionId: OpaqueIdSchema,
}).strict();

export interface RegressionRouteDependencies {
  readonly authenticator: Authenticator;
  readonly publishDatasetVersion: Pick<PublishRegressionDatasetVersion, "execute">;
  readonly publishFixtureVersion: Pick<PublishRegressionFixtureVersion, "execute">;
  readonly readDatasetVersion: Pick<ReadRegressionDatasetVersion, "execute">;
  readonly readFixtureVersion: Pick<ReadRegressionFixtureVersion, "execute">;
}

export interface InteractionFixtureRouteDependencies {
  readonly authenticator: Authenticator;
  readonly publishRecordedFixtureVersion: Pick<PublishRecordedInteractionFixtureVersion, "execute">;
  readonly readRecordedFixtureMetadata: Pick<ReadRecordedInteractionFixtureMetadata, "execute">;
  readonly revokeRecordedFixtureContent: Pick<RevokeRecordedInteractionFixtureContent, "execute">;
}

const publicationRateLimit = {
  max: 60,
  timeWindow: "1 minute",
} as const;

const readRateLimit = {
  max: 600,
  timeWindow: "1 minute",
} as const;

export async function registerRegressionRoutes(
  app: FastifyInstance,
  dependencies: RegressionRouteDependencies,
): Promise<void> {
  app.post(
    "/v1/projects/:projectId/environments/:environmentId/regression-fixtures/:fixtureId/versions",
    { config: { rateLimit: publicationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = RegressionFixturePathSchema.parse(request.params);
      const body = PublishRegressionFixtureVersionRequestSchema.parse(request.body);
      const result = await dependencies.publishFixtureVersion.execute({
        environmentId: path.environmentId,
        fixtureId: path.fixtureId,
        principal,
        projectId: path.projectId,
        request: body,
      });

      return reply.status(result.created ? 201 : 200).send(
        PublishRegressionFixtureVersionResponseSchema.parse({
          created: result.created,
          requestId: request.id,
          version: result.version,
        }),
      );
    },
  );

  app.get(
    "/v1/projects/:projectId/environments/:environmentId/regression-fixtures/:fixtureId/versions/:fixtureVersionId",
    { config: { rateLimit: readRateLimit } },
    async (request) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = RegressionFixtureVersionPathSchema.parse(request.params);
      const version = await dependencies.readFixtureVersion.execute({
        environmentId: path.environmentId,
        fixtureId: path.fixtureId,
        fixtureVersionId: path.fixtureVersionId,
        principal,
        projectId: path.projectId,
      });

      return ReadRegressionFixtureVersionResponseSchema.parse({
        requestId: request.id,
        version,
      });
    },
  );

  app.post(
    "/v1/projects/:projectId/environments/:environmentId/regression-datasets/:datasetId/versions",
    { config: { rateLimit: publicationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = RegressionDatasetPathSchema.parse(request.params);
      const body = PublishRegressionDatasetVersionRequestSchema.parse(request.body);
      const result = await dependencies.publishDatasetVersion.execute({
        datasetId: path.datasetId,
        environmentId: path.environmentId,
        principal,
        projectId: path.projectId,
        request: body,
      });

      return reply.status(result.created ? 201 : 200).send(
        PublishRegressionDatasetVersionResponseSchema.parse({
          created: result.created,
          requestId: request.id,
          version: result.version,
        }),
      );
    },
  );

  app.get(
    "/v1/projects/:projectId/environments/:environmentId/regression-datasets/:datasetId/versions/:datasetVersionId",
    { config: { rateLimit: readRateLimit } },
    async (request) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = RegressionDatasetVersionPathSchema.parse(request.params);
      const version = await dependencies.readDatasetVersion.execute({
        datasetId: path.datasetId,
        datasetVersionId: path.datasetVersionId,
        environmentId: path.environmentId,
        principal,
        projectId: path.projectId,
      });

      return ReadRegressionDatasetVersionResponseSchema.parse({
        requestId: request.id,
        version,
      });
    },
  );
}

export async function registerInteractionFixtureRoutes(
  app: FastifyInstance,
  dependencies: InteractionFixtureRouteDependencies,
): Promise<void> {
  app.post(
    "/v1/projects/:projectId/environments/:environmentId/regression-fixtures/:fixtureId/interaction-versions",
    { config: { rateLimit: publicationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = RegressionFixturePathSchema.parse(request.params);
      const body = PublishInteractionFixtureVersionRequestSchema.parse(request.body);
      const result = await dependencies.publishRecordedFixtureVersion.execute({
        environmentId: path.environmentId,
        fixtureId: path.fixtureId,
        principal,
        projectId: path.projectId,
        request: body,
      });
      return reply.status(result.created ? 201 : 200).send(
        PublishRecordedInteractionFixtureVersionResponseSchema.parse({
          created: result.created,
          ownerships: result.ownerships,
          requestId: request.id,
          version: result.version,
        }),
      );
    },
  );

  app.get(
    "/v1/projects/:projectId/environments/:environmentId/regression-fixtures/:fixtureId/interaction-versions/:fixtureVersionId",
    { config: { rateLimit: readRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = RegressionFixtureVersionPathSchema.parse(request.params);
      const result = await dependencies.readRecordedFixtureMetadata.execute({
        environmentId: path.environmentId,
        fixtureId: path.fixtureId,
        fixtureVersionId: path.fixtureVersionId,
        principal,
        projectId: path.projectId,
      });
      reply.header("cache-control", "no-store");
      return ReadRecordedInteractionFixtureMetadataResponseSchema.parse({
        ...result,
        requestId: request.id,
      });
    },
  );

  app.post(
    "/v1/projects/:projectId/environments/:environmentId/regression-fixtures/:fixtureId/interaction-versions/:fixtureVersionId/revocation",
    { config: { rateLimit: publicationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = RegressionFixtureVersionPathSchema.parse(request.params);
      const body = RevokeInteractionFixtureContentRequestSchema.parse(request.body);
      const result = await dependencies.revokeRecordedFixtureContent.execute({
        environmentId: path.environmentId,
        fixtureId: path.fixtureId,
        fixtureVersionId: path.fixtureVersionId,
        principal,
        projectId: path.projectId,
        request: body,
      });
      return reply.status(result.created ? 201 : 200).send(
        RevokeRecordedInteractionFixtureContentResponseSchema.parse({
          ...result,
          requestId: request.id,
        }),
      );
    },
  );
}
