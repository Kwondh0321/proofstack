import {
  ArtifactMetadataSchema,
  type ArtifactMetadata,
  type PrincipalContext,
  ReserveArtifactRequestSchema,
  type ReserveArtifactRequest,
} from "@proofstack/contracts";
import { type Clock, requireCapability, requireEnvironmentAccess } from "@proofstack/core";
import type { ArtifactIdentityGenerator } from "./artifact-identifiers.js";
import type {
  ArtifactCatalogEntry,
  ArtifactCatalogRepository,
  ArtifactEncryptionPlanner,
} from "./artifact-ports.js";
import { InvalidArtifactLifecycleInputError } from "./errors.js";

export interface ReserveArtifactCommand {
  readonly environmentId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
  readonly request: ReserveArtifactRequest;
}

export interface ReserveArtifactResult {
  readonly created: boolean;
  readonly metadata: ArtifactMetadata;
}

export interface ReserveArtifactDependencies {
  readonly catalog: ArtifactCatalogRepository;
  readonly clock: Clock;
  readonly encryption: ArtifactEncryptionPlanner;
  readonly identities: ArtifactIdentityGenerator;
}

function requestMetadata(command: ReserveArtifactCommand, createdAt: string): ArtifactMetadata {
  const request = ReserveArtifactRequestSchema.safeParse(command.request);
  if (!request.success) {
    throw new InvalidArtifactLifecycleInputError("Artifact reservation request is invalid", {
      cause: request.error,
    });
  }
  const redactedAt =
    request.data.redaction.status === "applied"
      ? request.data.redaction.records.at(-1)?.stage
      : undefined;
  const candidate = ArtifactMetadataSchema.safeParse({
    contentReference: {
      artifactId: request.data.artifactId,
      classification: request.data.classification,
      mediaType: request.data.mediaType,
      ...(redactedAt ? { redactedAt } : {}),
      sha256: request.data.sha256,
      sizeBytes: request.data.sizeBytes,
    },
    createdAt,
    redaction: request.data.redaction,
    retention: request.data.retention,
    schemaVersion: "0.1",
    scope: {
      environmentId: command.environmentId,
      projectId: command.projectId,
      tenantId: command.principal.tenantId,
    },
    state: "reserved",
  });
  if (!candidate.success) {
    throw new InvalidArtifactLifecycleInputError("Artifact reservation scope is invalid", {
      cause: candidate.error,
    });
  }
  return candidate.data;
}

function publicResult(created: boolean, entry: ArtifactCatalogEntry): ReserveArtifactResult {
  return { created, metadata: entry.metadata };
}

export class ReserveArtifact {
  constructor(private readonly dependencies: ReserveArtifactDependencies) {}

  async execute(command: ReserveArtifactCommand): Promise<ReserveArtifactResult> {
    requireCapability(command.principal, "artifact:write");
    requireEnvironmentAccess(command.principal, command.projectId, command.environmentId);

    let createdAt: string;
    try {
      createdAt = this.dependencies.clock.now().toISOString();
    } catch (error) {
      throw new InvalidArtifactLifecycleInputError("Artifact reservation clock is invalid", {
        cause: error,
      });
    }
    const metadata = requestMetadata(command, createdAt);
    const existing = await this.dependencies.catalog.find(
      metadata.scope,
      metadata.contentReference.artifactId,
    );
    if (
      !existing &&
      metadata.retention.mode === "expire" &&
      Date.parse(metadata.retention.expiresAt) <= Date.parse(createdAt)
    ) {
      throw new InvalidArtifactLifecycleInputError(
        "Artifact expiration must be later than its reservation time",
      );
    }
    const candidate: ArtifactCatalogEntry = existing
      ? {
          createdByPrincipalId: existing.createdByPrincipalId,
          encryption: existing.encryption,
          metadata,
          objectKey: existing.objectKey,
        }
      : {
          createdByPrincipalId: command.principal.principalId,
          encryption: await this.dependencies.encryption.createPlan(metadata),
          metadata,
          objectKey: this.dependencies.identities.generateObjectKey(),
        };
    const result = await this.dependencies.catalog.reserve(candidate);
    return publicResult(result.created, result.entry);
  }
}
