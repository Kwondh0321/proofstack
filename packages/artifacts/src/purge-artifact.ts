import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  type ArtifactMetadata,
  type PrincipalContext,
} from "@proofstack/contracts";
import { type Clock, requireCapability, requireEnvironmentAccess } from "@proofstack/core";
import type { ArtifactIdentityGenerator } from "./artifact-identifiers.js";
import type { ArtifactCatalogRepository, ArtifactObjectStore } from "./artifact-ports.js";
import {
  ArtifactNotFoundError,
  ArtifactStateTransitionError,
  InvalidArtifactLifecycleInputError,
} from "./errors.js";

export interface PurgeArtifactCommand {
  readonly artifactId: string;
  readonly environmentId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
}

export interface PurgeArtifactResult {
  readonly metadata: ArtifactMetadata;
}

export interface PurgeArtifactDependencies {
  readonly catalog: ArtifactCatalogRepository;
  readonly clock: Clock;
  readonly identities: ArtifactIdentityGenerator;
  readonly objects: ArtifactObjectStore;
}

export class PurgeArtifact {
  constructor(private readonly dependencies: PurgeArtifactDependencies) {}

  async execute(command: PurgeArtifactCommand): Promise<PurgeArtifactResult> {
    requireCapability(command.principal, "artifact:delete");
    requireEnvironmentAccess(command.principal, command.projectId, command.environmentId);
    if (!OpaqueIdSchema.safeParse(command.artifactId).success) {
      throw new InvalidArtifactLifecycleInputError("Artifact purge identifier is invalid");
    }
    const scope = EvidenceScopeSchema.safeParse({
      environmentId: command.environmentId,
      projectId: command.projectId,
      tenantId: command.principal.tenantId,
    });
    if (!scope.success) {
      throw new InvalidArtifactLifecycleInputError("Artifact purge scope is invalid", {
        cause: scope.error,
      });
    }

    const entry = await this.dependencies.catalog.find(scope.data, command.artifactId);
    if (!entry) throw new ArtifactNotFoundError();
    if (entry.metadata.state === "purged") return { metadata: entry.metadata };
    if (entry.metadata.state !== "tombstoned") throw new ArtifactStateTransitionError();

    const deleted = await this.dependencies.objects.delete(entry.objectKey);
    let occurredAt: string;
    try {
      occurredAt = this.dependencies.clock.now().toISOString();
    } catch (error) {
      throw new InvalidArtifactLifecycleInputError("Artifact purge clock is invalid", {
        cause: error,
      });
    }
    const purged = await this.dependencies.catalog.recordPurge(scope.data, {
      artifactId: command.artifactId,
      objectWasPresent: deleted.deleted,
      occurredAt,
      purgeId: this.dependencies.identities.generateLifecycleId("purge"),
    });
    return { metadata: purged.metadata };
  }
}
