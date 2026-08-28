import { createHash } from "node:crypto";
import type { Clock } from "@proofstack/core";
import {
  artifactAbandonedThreshold,
  artifactMaintenanceScope,
  type ArtifactMaintenanceScopeCommand,
  artifactMaintenanceTimestamp,
} from "./artifact-maintenance-support.js";
import type {
  ArtifactCatalogRepository,
  ArtifactContentDecryptor,
  ArtifactObjectReceipt,
  ArtifactObjectStore,
} from "./artifact-ports.js";

export interface ReconcileArtifactReservationsCommand extends ArtifactMaintenanceScopeCommand {
  readonly abandonedBefore: string;
  readonly limit: number;
}

export interface ReconcileArtifactReservationsResult {
  readonly activated: number;
  readonly failedArtifactIds: readonly string[];
  readonly inspected: number;
  readonly missingObjects: number;
}

export interface ReconcileArtifactReservationsDependencies {
  readonly catalog: ArtifactCatalogRepository;
  readonly clock: Clock;
  readonly encryption: ArtifactContentDecryptor;
  readonly objects: ArtifactObjectStore;
}

function objectReceipt(value: Uint8Array): ArtifactObjectReceipt {
  return {
    sha256: createHash("sha256").update(value).digest("hex"),
    sizeBytes: value.byteLength,
  };
}

export class ReconcileArtifactReservations {
  constructor(private readonly dependencies: ReconcileArtifactReservationsDependencies) {}

  async execute(
    command: ReconcileArtifactReservationsCommand,
  ): Promise<ReconcileArtifactReservationsResult> {
    const scope = artifactMaintenanceScope(command);
    const occurredAt = artifactMaintenanceTimestamp(
      this.dependencies.clock,
      "Artifact reconciliation clock is invalid",
    );
    const threshold = artifactAbandonedThreshold(command.abandonedBefore, occurredAt);
    const candidates = await this.dependencies.catalog.listAbandoned(
      scope,
      threshold,
      command.limit,
    );
    const failedArtifactIds: string[] = [];
    let activated = 0;
    let missingObjects = 0;

    for (const candidate of candidates) {
      const artifactId = candidate.metadata.contentReference.artifactId;
      let plaintext: Uint8Array | undefined;
      try {
        const encrypted = await this.dependencies.objects.get(candidate.objectKey);
        if (!encrypted) {
          missingObjects += 1;
          continue;
        }
        plaintext = await this.dependencies.encryption.decrypt(
          candidate.metadata,
          candidate.encryption,
          encrypted,
        );
        await this.dependencies.catalog.activate(
          scope,
          artifactId,
          objectReceipt(encrypted),
          occurredAt,
        );
        activated += 1;
      } catch {
        failedArtifactIds.push(artifactId);
      } finally {
        plaintext?.fill(0);
      }
    }

    return {
      activated,
      failedArtifactIds,
      inspected: candidates.length,
      missingObjects,
    };
  }
}
