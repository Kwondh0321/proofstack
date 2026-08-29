import type {
  PurgeArtifact,
  ReadArtifact,
  ReadArtifactMetadata,
  ReserveArtifact,
  TombstoneArtifact,
  UploadArtifact,
} from "@proofstack/artifacts";
import {
  MAX_ARTIFACT_CONTENT_BYTES,
  OpaqueIdSchema,
  type PrincipalContext,
  PurgeArtifactResponseSchema,
  ReadArtifactMetadataResponseSchema,
  ReserveArtifactRequestSchema,
  ReserveArtifactResponseSchema,
  TombstoneArtifactRequestSchema,
  TombstoneArtifactResponseSchema,
  UploadArtifactResponseSchema,
} from "@proofstack/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Authenticator } from "./auth.js";

const ARTIFACT_BINARY_MEDIA_TYPE = "application/octet-stream";

const ArtifactCollectionPathSchema = z
  .object({ environmentId: OpaqueIdSchema, projectId: OpaqueIdSchema })
  .strict();

const ArtifactPathSchema = ArtifactCollectionPathSchema.extend({
  artifactId: OpaqueIdSchema,
}).strict();

export interface ArtifactRouteDependencies {
  readonly authenticator: Authenticator;
  readonly purgeArtifact: Pick<PurgeArtifact, "execute">;
  readonly readArtifact: Pick<ReadArtifact, "execute">;
  readonly readArtifactMetadata: Pick<ReadArtifactMetadata, "execute">;
  readonly reserveArtifact: Pick<ReserveArtifact, "execute">;
  readonly tombstoneArtifact: Pick<TombstoneArtifact, "execute">;
  readonly uploadArtifact: Pick<UploadArtifact, "execute">;
}

const mutationRateLimit = { max: 60, timeWindow: "1 minute" } as const;
const readRateLimit = { max: 600, timeWindow: "1 minute" } as const;

function contentBytes(body: unknown): Uint8Array {
  if (!Buffer.isBuffer(body) || body.byteLength === 0) {
    throw new z.ZodError([
      {
        code: "custom",
        message: "Artifact content must be a non-empty binary body",
        path: [],
      },
    ]);
  }
  return Uint8Array.from(body);
}

function artifactCommand(path: z.infer<typeof ArtifactPathSchema>, principal: PrincipalContext) {
  return {
    artifactId: path.artifactId,
    environmentId: path.environmentId,
    principal,
    projectId: path.projectId,
  };
}

export async function registerArtifactRoutes(
  app: FastifyInstance,
  dependencies: ArtifactRouteDependencies,
): Promise<void> {
  const uploadPrincipals = new WeakMap<FastifyRequest, PrincipalContext>();
  app.addContentTypeParser(
    ARTIFACT_BINARY_MEDIA_TYPE,
    { bodyLimit: MAX_ARTIFACT_CONTENT_BYTES, parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  app.post(
    "/v1/projects/:projectId/environments/:environmentId/artifacts",
    { config: { rateLimit: mutationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = ArtifactCollectionPathSchema.parse(request.params);
      const body = ReserveArtifactRequestSchema.parse(request.body);
      const result = await dependencies.reserveArtifact.execute({
        environmentId: path.environmentId,
        principal,
        projectId: path.projectId,
        request: body,
      });
      return reply.status(result.created ? 201 : 200).send(
        ReserveArtifactResponseSchema.parse({
          created: result.created,
          metadata: result.metadata,
          requestId: request.id,
        }),
      );
    },
  );

  app.put(
    "/v1/projects/:projectId/environments/:environmentId/artifacts/:artifactId/content",
    {
      bodyLimit: MAX_ARTIFACT_CONTENT_BYTES,
      config: { rateLimit: mutationRateLimit },
      preParsing: async (request, _reply, payload) => {
        const principal = await dependencies.authenticator.authenticate(request);
        uploadPrincipals.set(request, principal);
        return payload;
      },
    },
    async (request) => {
      const principal = uploadPrincipals.get(request);
      /* v8 ignore next -- preParsing establishes the principal before body parsing and handling. */
      if (!principal) throw new Error("Authenticated artifact upload context is unavailable");
      const path = ArtifactPathSchema.parse(request.params);
      const result = await dependencies.uploadArtifact.execute({
        ...artifactCommand(path, principal),
        content: contentBytes(request.body),
      });
      return UploadArtifactResponseSchema.parse({
        metadata: result.metadata,
        requestId: request.id,
      });
    },
  );

  app.get(
    "/v1/projects/:projectId/environments/:environmentId/artifacts/:artifactId",
    { config: { rateLimit: readRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = ArtifactPathSchema.parse(request.params);
      const result = await dependencies.readArtifactMetadata.execute(
        artifactCommand(path, principal),
      );
      reply.header("cache-control", "no-store");
      return ReadArtifactMetadataResponseSchema.parse({
        ...result,
        requestId: request.id,
      });
    },
  );

  app.get(
    "/v1/projects/:projectId/environments/:environmentId/artifacts/:artifactId/content",
    { config: { rateLimit: readRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = ArtifactPathSchema.parse(request.params);
      const result = await dependencies.readArtifact.execute(artifactCommand(path, principal));
      reply
        .header("cache-control", "no-store")
        .header(
          "x-proofstack-artifact-classification",
          result.metadata.contentReference.classification,
        )
        .header("x-proofstack-artifact-redaction-status", result.metadata.redaction.status)
        .header("x-proofstack-artifact-sha256", result.metadata.contentReference.sha256)
        .header("x-proofstack-request-id", request.id)
        .type(result.metadata.contentReference.mediaType);
      return reply.send(Buffer.from(result.content));
    },
  );

  app.delete(
    "/v1/projects/:projectId/environments/:environmentId/artifacts/:artifactId",
    { config: { rateLimit: mutationRateLimit } },
    async (request, reply) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = ArtifactPathSchema.parse(request.params);
      const body = TombstoneArtifactRequestSchema.parse(request.body);
      const result = await dependencies.tombstoneArtifact.execute({
        ...artifactCommand(path, principal),
        request: body,
      });
      return reply.status(result.created ? 201 : 200).send(
        TombstoneArtifactResponseSchema.parse({
          ...result,
          requestId: request.id,
        }),
      );
    },
  );

  app.post(
    "/v1/projects/:projectId/environments/:environmentId/artifacts/:artifactId/purge",
    { config: { rateLimit: mutationRateLimit } },
    async (request) => {
      const principal = await dependencies.authenticator.authenticate(request);
      const path = ArtifactPathSchema.parse(request.params);
      const result = await dependencies.purgeArtifact.execute(artifactCommand(path, principal));
      return PurgeArtifactResponseSchema.parse({
        metadata: result.metadata,
        requestId: request.id,
      });
    },
  );
}
