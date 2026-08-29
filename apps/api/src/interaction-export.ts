import {
  type ArtifactCatalogEntry,
  type ArtifactCatalogRepository,
  ArtifactNotFoundError,
  ArtifactObjectMissingError,
  ArtifactUnavailableError,
  type ReadArtifact,
} from "@proofstack/artifacts";
import {
  ARTIFACT_PURGE_RECEIPT_EXPORT_SCHEMA_VERSION,
  INTERACTION_FIXTURE_EXPORT_SCHEMA_VERSION,
  MAX_INTERACTION_CONTENT_EXPORT_BYTES,
  type PrincipalContext,
  type RecordedInteractionFixtureContentExport,
  RecordedInteractionFixtureContentExportSchema,
  type RecordedInteractionFixtureMetadataExport,
  type RecordedInteractionFixtureMetadataExportArtifact,
  RecordedInteractionFixtureMetadataExportSchema,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "@proofstack/core";
import type {
  ReadRecordedInteractionFixtureMetadata,
  StoredInteractionFixtureContent,
} from "@proofstack/datasets";

export interface RecordedInteractionFixtureExportCommand {
  readonly environmentId: string;
  readonly fixtureId: string;
  readonly fixtureVersionId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
}

interface InteractionExportDependencies {
  readonly catalog: ArtifactCatalogRepository;
  readonly readRecordedFixtureMetadata: Pick<ReadRecordedInteractionFixtureMetadata, "execute">;
}

export interface InteractionContentExportDependencies extends InteractionExportDependencies {
  readonly readArtifact: Pick<ReadArtifact, "execute">;
}

export class InteractionExportStateChangedError extends Error {
  readonly code = "interaction_export_state_changed";

  constructor(options?: ErrorOptions) {
    super("Interaction fixture state changed or is inconsistent; retry the export", options);
    this.name = "InteractionExportStateChangedError";
  }
}

export class InteractionContentExportTooLargeError extends Error {
  readonly code = "interaction_content_export_too_large";

  constructor() {
    super("Interaction content export exceeds the aggregate byte limit");
    this.name = "InteractionContentExportTooLargeError";
  }
}

function sameStructuredValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function unavailableArtifact(
  stored: StoredInteractionFixtureContent,
  index: number,
  entry: ArtifactCatalogEntry | null,
): RecordedInteractionFixtureMetadataExportArtifact {
  const binding = stored.version.interactionCapture.artifacts[index];
  const ownership = stored.ownerships[index];
  if (!binding || !ownership) throw new InteractionExportStateChangedError();
  return {
    binding,
    lifecycleStatus: "unavailable",
    metadata: entry?.metadata ?? null,
    ownership,
    purgeReceipt: null,
    tombstone: null,
  };
}

async function exportArtifactMetadata(
  dependencies: InteractionExportDependencies,
  stored: StoredInteractionFixtureContent,
  index: number,
): Promise<RecordedInteractionFixtureMetadataExportArtifact> {
  const binding = stored.version.interactionCapture.artifacts[index];
  const ownership = stored.ownerships[index];
  if (!binding || !ownership) throw new InteractionExportStateChangedError();
  const scope = stored.version.scope;
  const artifactId = binding.contentReference.artifactId;
  const entry = await dependencies.catalog.find(scope, artifactId);
  if (!entry) return unavailableArtifact(stored, index, null);
  if (!entry.ownership || !sameStructuredValue(entry.ownership, ownership)) {
    throw new InteractionExportStateChangedError();
  }
  if (entry.metadata.state === "available") {
    return {
      binding,
      lifecycleStatus: "available",
      metadata: entry.metadata,
      ownership,
      purgeReceipt: null,
      tombstone: null,
    };
  }
  if (entry.metadata.state === "reserved") return unavailableArtifact(stored, index, entry);

  const tombstone = stored.tombstones[index];
  if (!tombstone || tombstone.artifactId !== artifactId) {
    throw new InteractionExportStateChangedError();
  }
  if (entry.metadata.state === "tombstoned") {
    return {
      binding,
      lifecycleStatus: "revoked",
      metadata: entry.metadata,
      ownership,
      purgeReceipt: null,
      tombstone,
    };
  }

  const receipt = await dependencies.catalog.findPurgeReceipt(scope, artifactId);
  if (!receipt) throw new InteractionExportStateChangedError();
  return {
    binding,
    lifecycleStatus: "purged",
    metadata: entry.metadata,
    ownership,
    purgeReceipt: {
      ...receipt,
      schemaVersion: ARTIFACT_PURGE_RECEIPT_EXPORT_SCHEMA_VERSION,
    },
    tombstone,
  };
}

async function metadataExport(
  dependencies: InteractionExportDependencies,
  stored: StoredInteractionFixtureContent,
): Promise<RecordedInteractionFixtureMetadataExport> {
  const artifacts = [];
  for (let index = 0; index < stored.version.interactionCapture.artifacts.length; index += 1) {
    artifacts.push(await exportArtifactMetadata(dependencies, stored, index));
  }
  const parsed = RecordedInteractionFixtureMetadataExportSchema.safeParse({
    artifacts,
    contentAvailability: stored.contentAvailability,
    mode: "metadata",
    revocation: stored.revocation,
    schemaVersion: INTERACTION_FIXTURE_EXPORT_SCHEMA_VERSION,
    version: stored.version,
  });
  if (!parsed.success) throw new InteractionExportStateChangedError({ cause: parsed.error });
  return parsed.data;
}

export class ExportRecordedInteractionFixtureMetadata {
  constructor(private readonly dependencies: InteractionExportDependencies) {}

  async execute(
    command: RecordedInteractionFixtureExportCommand,
  ): Promise<RecordedInteractionFixtureMetadataExport> {
    const stored = await this.dependencies.readRecordedFixtureMetadata.execute(command);
    return metadataExport(this.dependencies, stored);
  }
}

export class ExportRecordedInteractionFixtureContent {
  constructor(private readonly dependencies: InteractionContentExportDependencies) {}

  async execute(
    command: RecordedInteractionFixtureExportCommand,
  ): Promise<RecordedInteractionFixtureContentExport> {
    requireCapability(command.principal, "dataset:read");
    requireCapability(command.principal, "artifact:read");
    requireEnvironmentAccess(command.principal, command.projectId, command.environmentId);
    const stored = await this.dependencies.readRecordedFixtureMetadata.execute(command);
    if (
      stored.version.interactionCapture.artifacts.some(
        ({ contentReference }) => contentReference.classification === "restricted",
      )
    ) {
      requireCapability(command.principal, "artifact:read:restricted");
    }
    const metadata = await metadataExport(this.dependencies, stored);
    const declaredBytes = metadata.artifacts.reduce(
      (total, artifact) =>
        total +
        (artifact.lifecycleStatus === "available"
          ? artifact.binding.contentReference.sizeBytes
          : 0),
      0,
    );
    if (declaredBytes > MAX_INTERACTION_CONTENT_EXPORT_BYTES) {
      throw new InteractionContentExportTooLargeError();
    }

    const artifacts = [];
    for (const artifact of metadata.artifacts) {
      if (artifact.lifecycleStatus === "revoked") {
        artifacts.push({ artifact, content: { status: "revoked" as const } });
        continue;
      }
      if (artifact.lifecycleStatus === "purged") {
        artifacts.push({ artifact, content: { status: "purged" as const } });
        continue;
      }
      if (artifact.lifecycleStatus === "unavailable") {
        artifacts.push({ artifact, content: { status: "unavailable" as const } });
        continue;
      }
      try {
        const result = await this.dependencies.readArtifact.execute({
          artifactId: artifact.binding.contentReference.artifactId,
          environmentId: command.environmentId,
          principal: command.principal,
          projectId: command.projectId,
        });
        if (!sameStructuredValue(result.metadata, artifact.metadata)) {
          throw new InteractionExportStateChangedError();
        }
        artifacts.push({
          artifact,
          content: {
            bytes: Buffer.from(result.content).toString("base64url"),
            encoding: "base64url" as const,
            status: "available" as const,
          },
        });
      } catch (error) {
        if (error instanceof ArtifactObjectMissingError || error instanceof ArtifactNotFoundError) {
          artifacts.push({ artifact, content: { status: "missing" as const } });
          continue;
        }
        if (error instanceof ArtifactUnavailableError) {
          artifacts.push({ artifact, content: { status: "unavailable" as const } });
          continue;
        }
        throw error;
      }
    }

    const parsed = RecordedInteractionFixtureContentExportSchema.safeParse({
      artifacts,
      contentAvailability: metadata.contentAvailability,
      mode: "content",
      revocation: metadata.revocation,
      schemaVersion: INTERACTION_FIXTURE_EXPORT_SCHEMA_VERSION,
      version: metadata.version,
    });
    if (!parsed.success) throw new InteractionExportStateChangedError({ cause: parsed.error });
    return parsed.data;
  }
}
