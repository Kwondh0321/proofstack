import { createHash } from "node:crypto";
import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  type ArtifactMetadata,
  type PrincipalContext,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "@proofstack/core";
import type {
  ArtifactCatalogRepository,
  ArtifactContentDecryptor,
  ArtifactObjectReceipt,
  ArtifactObjectStore,
} from "./artifact-ports.js";
import {
  ArtifactNotFoundError,
  ArtifactObjectMissingError,
  ArtifactProtectionError,
  ArtifactUnavailableError,
  InvalidArtifactLifecycleInputError,
} from "./errors.js";

export interface ReadArtifactCommand {
  readonly artifactId: string;
  readonly environmentId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
}

export interface ReadArtifactResult {
  readonly content: Uint8Array;
  readonly metadata: ArtifactMetadata;
}

export interface ReadArtifactDependencies {
  readonly catalog: ArtifactCatalogRepository;
  readonly encryption: ArtifactContentDecryptor;
  readonly objects: ArtifactObjectStore;
}

function receipt(value: Uint8Array): ArtifactObjectReceipt {
  return {
    sha256: createHash("sha256").update(value).digest("hex"),
    sizeBytes: value.byteLength,
  };
}

function sameReceipt(left: ArtifactObjectReceipt, right: ArtifactObjectReceipt): boolean {
  return left.sha256 === right.sha256 && left.sizeBytes === right.sizeBytes;
}

export class ReadArtifact {
  constructor(private readonly dependencies: ReadArtifactDependencies) {}

  async execute(command: ReadArtifactCommand): Promise<ReadArtifactResult> {
    requireCapability(command.principal, "artifact:read");
    requireEnvironmentAccess(command.principal, command.projectId, command.environmentId);
    if (!OpaqueIdSchema.safeParse(command.artifactId).success) {
      throw new InvalidArtifactLifecycleInputError("Artifact read identifier is invalid");
    }
    const scope = EvidenceScopeSchema.safeParse({
      environmentId: command.environmentId,
      projectId: command.projectId,
      tenantId: command.principal.tenantId,
    });
    if (!scope.success) {
      throw new InvalidArtifactLifecycleInputError("Artifact read scope is invalid", {
        cause: scope.error,
      });
    }

    const entry = await this.dependencies.catalog.find(scope.data, command.artifactId);
    if (!entry) throw new ArtifactNotFoundError();
    if (entry.metadata.contentReference.classification === "restricted") {
      requireCapability(command.principal, "artifact:read:restricted");
    }
    if (entry.metadata.state !== "available") throw new ArtifactUnavailableError();

    const encrypted = await this.dependencies.objects.get(entry.objectKey);
    if (!encrypted) throw new ArtifactObjectMissingError();
    if (!entry.objectReceipt || !sameReceipt(receipt(encrypted), entry.objectReceipt)) {
      throw new ArtifactProtectionError();
    }
    const content = await this.dependencies.encryption.decrypt(
      entry.metadata,
      entry.encryption,
      encrypted,
    );
    return { content, metadata: entry.metadata };
  }
}
