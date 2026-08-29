import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  type ArtifactMetadata,
  type PrincipalContext,
} from "@proofstack/contracts";
import { type Clock, requireCapability, requireEnvironmentAccess } from "@proofstack/core";
import type {
  ArtifactCatalogRepository,
  ArtifactContentEncryptor,
  ArtifactObjectReceipt,
  ArtifactObjectStore,
} from "./artifact-ports.js";
import {
  ArtifactNotFoundError,
  ArtifactObjectConflictError,
  ArtifactStateTransitionError,
  InvalidArtifactLifecycleInputError,
} from "./errors.js";
import type { ArtifactContentInspector } from "./artifact-content-inspection.js";

export interface UploadArtifactCommand {
  readonly artifactId: string;
  readonly content: Uint8Array;
  readonly environmentId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
}

export interface UploadArtifactResult {
  readonly metadata: ArtifactMetadata;
}

export interface UploadArtifactDependencies {
  readonly catalog: ArtifactCatalogRepository;
  readonly clock: Clock;
  readonly encryption: ArtifactContentEncryptor;
  readonly inspection: ArtifactContentInspector;
  readonly objects: ArtifactObjectStore;
}

function sameReceipt(left: ArtifactObjectReceipt, right: ArtifactObjectReceipt): boolean {
  return left.sha256 === right.sha256 && left.sizeBytes === right.sizeBytes;
}

export class UploadArtifact {
  constructor(private readonly dependencies: UploadArtifactDependencies) {}

  async execute(command: UploadArtifactCommand): Promise<UploadArtifactResult> {
    requireCapability(command.principal, "artifact:write");
    requireEnvironmentAccess(command.principal, command.projectId, command.environmentId);
    if (
      !OpaqueIdSchema.safeParse(command.artifactId).success ||
      !(command.content instanceof Uint8Array)
    ) {
      throw new InvalidArtifactLifecycleInputError("Artifact upload command is invalid");
    }
    const scope = EvidenceScopeSchema.safeParse({
      environmentId: command.environmentId,
      projectId: command.projectId,
      tenantId: command.principal.tenantId,
    });
    if (!scope.success) {
      throw new InvalidArtifactLifecycleInputError("Artifact upload scope is invalid", {
        cause: scope.error,
      });
    }

    const entry = await this.dependencies.catalog.find(scope.data, command.artifactId);
    if (!entry) throw new ArtifactNotFoundError();
    if (entry.metadata.state !== "reserved" && entry.metadata.state !== "available") {
      throw new ArtifactStateTransitionError();
    }

    const encrypted = await this.dependencies.encryption.encrypt(
      entry.metadata,
      entry.encryption,
      command.content,
    );
    await this.dependencies.inspection.inspect({
      content: command.content,
      metadata: entry.metadata,
    });
    const stored = await this.dependencies.objects.putIfAbsent(entry.objectKey, encrypted.bytes);
    if (!sameReceipt(stored.receipt, encrypted.receipt)) throw new ArtifactObjectConflictError();

    let availableAt: string;
    try {
      availableAt = this.dependencies.clock.now().toISOString();
    } catch (error) {
      throw new InvalidArtifactLifecycleInputError("Artifact upload clock is invalid", {
        cause: error,
      });
    }
    const activated = await this.dependencies.catalog.activate(
      scope.data,
      command.artifactId,
      encrypted.receipt,
      availableAt,
    );
    return { metadata: activated.metadata };
  }
}
