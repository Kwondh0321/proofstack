import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  type ArtifactMetadata,
  type ArtifactTombstone,
  type PrincipalContext,
  TombstoneArtifactRequestSchema,
  type TombstoneArtifactRequest,
} from "@proofstack/contracts";
import { type Clock, requireCapability, requireEnvironmentAccess } from "@proofstack/core";
import type { ArtifactIdentityGenerator } from "./artifact-identifiers.js";
import type { ArtifactCatalogRepository } from "./artifact-ports.js";
import { InvalidArtifactLifecycleInputError } from "./errors.js";

export interface TombstoneArtifactCommand {
  readonly artifactId: string;
  readonly environmentId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
  readonly request: TombstoneArtifactRequest;
}

export interface TombstoneArtifactResult {
  readonly created: boolean;
  readonly metadata: ArtifactMetadata;
  readonly tombstone: ArtifactTombstone;
}

export interface TombstoneArtifactDependencies {
  readonly catalog: ArtifactCatalogRepository;
  readonly clock: Clock;
  readonly identities: ArtifactIdentityGenerator;
}

export class TombstoneArtifact {
  constructor(private readonly dependencies: TombstoneArtifactDependencies) {}

  async execute(command: TombstoneArtifactCommand): Promise<TombstoneArtifactResult> {
    requireCapability(command.principal, "artifact:delete");
    requireEnvironmentAccess(command.principal, command.projectId, command.environmentId);
    const request = TombstoneArtifactRequestSchema.safeParse(command.request);
    if (!OpaqueIdSchema.safeParse(command.artifactId).success || !request.success) {
      throw new InvalidArtifactLifecycleInputError("Artifact deletion request is invalid", {
        ...(request.success ? {} : { cause: request.error }),
      });
    }
    const scope = EvidenceScopeSchema.safeParse({
      environmentId: command.environmentId,
      projectId: command.projectId,
      tenantId: command.principal.tenantId,
    });
    if (!scope.success) {
      throw new InvalidArtifactLifecycleInputError("Artifact deletion scope is invalid", {
        cause: scope.error,
      });
    }

    let occurredAt: string;
    try {
      occurredAt = this.dependencies.clock.now().toISOString();
    } catch (error) {
      throw new InvalidArtifactLifecycleInputError("Artifact deletion clock is invalid", {
        cause: error,
      });
    }
    const result = await this.dependencies.catalog.tombstone(scope.data, {
      actorPrincipalId: command.principal.principalId,
      artifactId: command.artifactId,
      occurredAt,
      reason: request.data.reason,
      tombstoneId: this.dependencies.identities.generateLifecycleId("tombstone"),
      trigger: "manual",
    });
    return {
      created: result.created,
      metadata: result.entry.metadata,
      tombstone: result.tombstone,
    };
  }
}
