import type { ArtifactTombstoneTrigger, PrincipalContext } from "@proofstack/contracts";
import type { Clock } from "@proofstack/core";
import type { ArtifactIdentityGenerator } from "./artifact-identifiers.js";
import {
  artifactAbandonedThreshold,
  artifactMaintenanceScope,
  artifactMaintenanceTimestamp,
  MIN_ABANDONED_RESERVATION_AGE_MS,
} from "./artifact-maintenance-support.js";
import type { ArtifactCatalogEntry, ArtifactCatalogRepository } from "./artifact-ports.js";
import type { PurgeArtifact, PurgeArtifactCommand } from "./purge-artifact.js";

const RETENTION_TOMBSTONE_REASON = "Configured artifact retention period expired";
const ABANDONED_TOMBSTONE_REASON =
  "Artifact reservation was not completed before the cleanup threshold";
export { MIN_ABANDONED_RESERVATION_AGE_MS };

export interface ArtifactMaintenanceCommand {
  readonly environmentId: string;
  readonly limit: number;
  readonly principal: PrincipalContext;
  readonly projectId: string;
}

export interface ProcessAbandonedReservationsCommand extends ArtifactMaintenanceCommand {
  readonly abandonedBefore: string;
}

export interface ArtifactMaintenanceResult {
  readonly failedArtifactIds: readonly string[];
  readonly inspected: number;
  readonly purged: number;
  readonly tombstoned: number;
}

interface ArtifactPurgeExecutor {
  execute(command: PurgeArtifactCommand): ReturnType<PurgeArtifact["execute"]>;
}

export interface ProcessArtifactRetentionDependencies {
  readonly catalog: ArtifactCatalogRepository;
  readonly clock: Clock;
  readonly identities: ArtifactIdentityGenerator;
  readonly purge: ArtifactPurgeExecutor;
}

export interface RetryArtifactPurgesDependencies {
  readonly catalog: ArtifactCatalogRepository;
  readonly purge: ArtifactPurgeExecutor;
}

function purgeCommand(
  command: ArtifactMaintenanceCommand,
  artifactId: string,
): PurgeArtifactCommand {
  return {
    artifactId,
    environmentId: command.environmentId,
    principal: command.principal,
    projectId: command.projectId,
  };
}

async function processTombstoneCandidates(
  entries: readonly ArtifactCatalogEntry[],
  command: ArtifactMaintenanceCommand,
  occurredAt: string,
  reason: string,
  trigger: ArtifactTombstoneTrigger,
  dependencies: ProcessArtifactRetentionDependencies,
): Promise<ArtifactMaintenanceResult> {
  const scope = artifactMaintenanceScope(command);
  const failedArtifactIds: string[] = [];
  let purged = 0;
  let tombstoned = 0;

  for (const entry of entries) {
    const artifactId = entry.metadata.contentReference.artifactId;
    try {
      const result = await dependencies.catalog.tombstone(scope, {
        actorPrincipalId: command.principal.principalId,
        artifactId,
        occurredAt,
        reason,
        tombstoneId: dependencies.identities.generateLifecycleId("tombstone"),
        trigger,
      });
      if (result.created) tombstoned += 1;
      await dependencies.purge.execute(purgeCommand(command, artifactId));
      purged += 1;
    } catch {
      failedArtifactIds.push(artifactId);
    }
  }
  return { failedArtifactIds, inspected: entries.length, purged, tombstoned };
}

export class ProcessArtifactRetention {
  constructor(private readonly dependencies: ProcessArtifactRetentionDependencies) {}

  async execute(command: ArtifactMaintenanceCommand): Promise<ArtifactMaintenanceResult> {
    const scope = artifactMaintenanceScope(command);
    const occurredAt = artifactMaintenanceTimestamp(
      this.dependencies.clock,
      "Artifact retention clock is invalid",
    );
    const expired = await this.dependencies.catalog.listExpired(scope, occurredAt, command.limit);
    return processTombstoneCandidates(
      expired,
      command,
      occurredAt,
      RETENTION_TOMBSTONE_REASON,
      "retention",
      this.dependencies,
    );
  }
}

export class ProcessAbandonedReservations {
  constructor(private readonly dependencies: ProcessArtifactRetentionDependencies) {}

  async execute(command: ProcessAbandonedReservationsCommand): Promise<ArtifactMaintenanceResult> {
    const scope = artifactMaintenanceScope(command);
    const occurredAt = artifactMaintenanceTimestamp(
      this.dependencies.clock,
      "Artifact cleanup clock is invalid",
    );
    const threshold = artifactAbandonedThreshold(command.abandonedBefore, occurredAt);
    const abandoned = await this.dependencies.catalog.listAbandoned(
      scope,
      threshold,
      command.limit,
    );
    return processTombstoneCandidates(
      abandoned,
      command,
      occurredAt,
      ABANDONED_TOMBSTONE_REASON,
      "abandoned",
      this.dependencies,
    );
  }
}

export class RetryArtifactPurges {
  constructor(private readonly dependencies: RetryArtifactPurgesDependencies) {}

  async execute(command: ArtifactMaintenanceCommand): Promise<ArtifactMaintenanceResult> {
    const scope = artifactMaintenanceScope(command);
    const pending = await this.dependencies.catalog.listPendingPurge(scope, command.limit);
    const failedArtifactIds: string[] = [];
    let purged = 0;

    for (const entry of pending) {
      const artifactId = entry.metadata.contentReference.artifactId;
      try {
        await this.dependencies.purge.execute(purgeCommand(command, artifactId));
        purged += 1;
      } catch {
        failedArtifactIds.push(artifactId);
      }
    }
    return { failedArtifactIds, inspected: pending.length, purged, tombstoned: 0 };
  }
}
