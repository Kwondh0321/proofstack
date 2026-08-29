import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  type ArtifactMetadata,
  type ArtifactOwnership,
  type PrincipalContext,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "@proofstack/core";
import type { ArtifactCatalogRepository } from "./artifact-ports.js";
import { ArtifactNotFoundError, InvalidArtifactLifecycleInputError } from "./errors.js";

export interface ReadArtifactMetadataCommand {
  readonly artifactId: string;
  readonly environmentId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
}

export interface ReadArtifactMetadataResult {
  readonly metadata: ArtifactMetadata;
  readonly ownership?: ArtifactOwnership;
}

/** Reads lifecycle metadata without touching encrypted object storage or unwrapping a data key. */
export class ReadArtifactMetadata {
  constructor(private readonly catalog: ArtifactCatalogRepository) {}

  async execute(command: ReadArtifactMetadataCommand): Promise<ReadArtifactMetadataResult> {
    requireCapability(command.principal, "artifact:read");
    requireEnvironmentAccess(command.principal, command.projectId, command.environmentId);
    if (!OpaqueIdSchema.safeParse(command.artifactId).success) {
      throw new InvalidArtifactLifecycleInputError("Artifact metadata identifier is invalid");
    }
    const scope = EvidenceScopeSchema.safeParse({
      environmentId: command.environmentId,
      projectId: command.projectId,
      tenantId: command.principal.tenantId,
    });
    if (!scope.success) {
      throw new InvalidArtifactLifecycleInputError("Artifact metadata scope is invalid", {
        cause: scope.error,
      });
    }

    const entry = await this.catalog.find(scope.data, command.artifactId);
    if (!entry) throw new ArtifactNotFoundError();
    return {
      metadata: structuredClone(entry.metadata),
      ...(entry.ownership ? { ownership: structuredClone(entry.ownership) } : {}),
    };
  }
}
