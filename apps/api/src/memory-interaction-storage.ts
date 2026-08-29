import type {
  ArtifactCatalogEntry,
  ArtifactCatalogRepository,
  ArtifactKeyReferenceSummary,
  ArtifactObjectReceipt,
  ArtifactPurgeReceipt,
  ReserveArtifactCatalogResult,
  TombstoneArtifactCatalogResult,
} from "@proofstack/artifacts";
import { MemoryArtifactCatalogRepository } from "@proofstack/artifacts/testing";
import type {
  ArtifactOwnership,
  ArtifactTombstone,
  EvidenceScope,
  RecordedInteractionFixtureVersion,
  RegressionDatasetVersion,
  RegressionFixtureVersion,
  RequestedRegressionFixtureVersionReference,
} from "@proofstack/contracts";
import {
  type InteractionFixtureVersionRepository,
  MemoryRegressionVersionRepository,
  type PublishRecordedInteractionFixtureVersionResult,
  type PublishRegressionVersionResult,
  RegressionRepositoryContractError,
  type ResolveRegressionFixtureVersionReferencesResult,
  type RevokeInteractionFixtureContentCandidate,
  type RevokeInteractionFixtureContentResult,
  type StoredInteractionFixtureContent,
  type StoredRecordedInteractionFixtureVersion,
} from "@proofstack/datasets";

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<Value>(operation: () => Promise<Value>): Promise<Value> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

class LockedArtifactCatalogRepository implements ArtifactCatalogRepository {
  constructor(
    private readonly mutex: AsyncMutex,
    private readonly repository: MemoryArtifactCatalogRepository,
  ) {}

  activate(
    scope: EvidenceScope,
    artifactId: string,
    objectReceipt: ArtifactObjectReceipt,
    availableAt: string,
  ): Promise<ArtifactCatalogEntry> {
    return this.mutex.run(() =>
      this.repository.activate(scope, artifactId, objectReceipt, availableAt),
    );
  }

  find(scope: EvidenceScope, artifactId: string): Promise<ArtifactCatalogEntry | null> {
    return this.mutex.run(() => this.repository.find(scope, artifactId));
  }

  listAbandoned(
    scope: EvidenceScope,
    createdBefore: string,
    limit: number,
  ): Promise<readonly ArtifactCatalogEntry[]> {
    return this.mutex.run(() => this.repository.listAbandoned(scope, createdBefore, limit));
  }

  listExpired(
    scope: EvidenceScope,
    expiresBefore: string,
    limit: number,
  ): Promise<readonly ArtifactCatalogEntry[]> {
    return this.mutex.run(() => this.repository.listExpired(scope, expiresBefore, limit));
  }

  listPendingPurge(scope: EvidenceScope, limit: number): Promise<readonly ArtifactCatalogEntry[]> {
    return this.mutex.run(() => this.repository.listPendingPurge(scope, limit));
  }

  listKeyReferences(scope: EvidenceScope): Promise<readonly ArtifactKeyReferenceSummary[]> {
    return this.mutex.run(() => this.repository.listKeyReferences(scope));
  }

  recordPurge(scope: EvidenceScope, receipt: ArtifactPurgeReceipt): Promise<ArtifactCatalogEntry> {
    return this.mutex.run(() => this.repository.recordPurge(scope, receipt));
  }

  reserve(candidate: ArtifactCatalogEntry): Promise<ReserveArtifactCatalogResult> {
    return this.mutex.run(() => this.repository.reserve(candidate));
  }

  tombstone(
    scope: EvidenceScope,
    tombstone: ArtifactTombstone,
  ): Promise<TombstoneArtifactCatalogResult> {
    return this.mutex.run(() => this.repository.tombstone(scope, tombstone));
  }
}

function exactOwnership(entry: ArtifactCatalogEntry | null, ownership: ArtifactOwnership): boolean {
  return (
    entry?.ownership?.artifactId === ownership.artifactId &&
    entry.ownership.boundAt === ownership.boundAt &&
    entry.ownership.boundByPrincipalId === ownership.boundByPrincipalId &&
    entry.ownership.owner.fixtureId === ownership.owner.fixtureId &&
    entry.ownership.owner.fixtureVersionId === ownership.owner.fixtureVersionId
  );
}

class CoordinatedMemoryRegressionVersionRepository implements InteractionFixtureVersionRepository {
  constructor(
    private readonly mutex: AsyncMutex,
    private readonly catalog: MemoryArtifactCatalogRepository,
    private readonly repository: MemoryRegressionVersionRepository,
  ) {}

  datasetResourceExists(scope: EvidenceScope, datasetId: string): Promise<boolean> {
    return this.repository.datasetResourceExists(scope, datasetId);
  }

  findDatasetVersion(
    scope: EvidenceScope,
    datasetVersionId: string,
  ): Promise<RegressionDatasetVersion | null> {
    return this.repository.findDatasetVersion(scope, datasetVersionId);
  }

  findFixtureVersion(
    scope: EvidenceScope,
    fixtureVersionId: string,
  ): Promise<RegressionFixtureVersion | null> {
    return this.repository.findFixtureVersion(scope, fixtureVersionId);
  }

  findRecordedInteractionFixtureContent(
    scope: EvidenceScope,
    fixtureVersionId: string,
  ): Promise<StoredInteractionFixtureContent | null> {
    return this.repository.findRecordedInteractionFixtureContent(scope, fixtureVersionId);
  }

  findRecordedInteractionFixtureVersion(
    scope: EvidenceScope,
    fixtureVersionId: string,
  ): Promise<StoredRecordedInteractionFixtureVersion | null> {
    return this.repository.findRecordedInteractionFixtureVersion(scope, fixtureVersionId);
  }

  fixtureResourceExists(scope: EvidenceScope, fixtureId: string): Promise<boolean> {
    return this.repository.fixtureResourceExists(scope, fixtureId);
  }

  publishDatasetVersion(
    candidate: RegressionDatasetVersion,
  ): Promise<PublishRegressionVersionResult<RegressionDatasetVersion>> {
    return this.repository.publishDatasetVersion(candidate);
  }

  publishFixtureVersion(
    candidate: RegressionFixtureVersion,
  ): Promise<PublishRegressionVersionResult<RegressionFixtureVersion>> {
    return this.repository.publishFixtureVersion(candidate);
  }

  publishRecordedInteractionFixtureVersion(
    candidate: RecordedInteractionFixtureVersion,
  ): Promise<PublishRecordedInteractionFixtureVersionResult> {
    return this.mutex.run(async () => {
      const existing = await this.repository.findRecordedInteractionFixtureVersion(
        candidate.scope,
        candidate.fixtureVersionId,
      );
      if (!existing) {
        for (const binding of candidate.interactionCapture.artifacts) {
          const entry = await this.catalog.find(
            candidate.scope,
            binding.contentReference.artifactId,
          );
          if (!entry) {
            throw new RegressionRepositoryContractError(
              "Memory interaction artifact catalog is not coordinated",
            );
          }
          this.repository.seedInteractionArtifact(entry.metadata);
        }
      }
      const result = await this.repository.publishRecordedInteractionFixtureVersion(candidate);
      for (const ownership of result.ownerships) {
        const entry = await this.catalog.find(ownership.scope, ownership.artifactId);
        if (entry?.ownership && !exactOwnership(entry, ownership)) {
          throw new RegressionRepositoryContractError(
            "Memory interaction artifact ownership is not coordinated",
          );
        }
      }
      for (const ownership of result.ownerships) {
        this.catalog.claimFixtureOwnershipForTesting(ownership);
      }
      return result;
    });
  }

  resolveFixtureVersionReferences(
    scope: EvidenceScope,
    references: readonly RequestedRegressionFixtureVersionReference[],
  ): Promise<ResolveRegressionFixtureVersionReferencesResult> {
    return this.repository.resolveFixtureVersionReferences(scope, references);
  }

  revokeRecordedInteractionFixtureContent(
    candidate: RevokeInteractionFixtureContentCandidate,
  ): Promise<RevokeInteractionFixtureContentResult> {
    return this.mutex.run(async () => {
      const stored = await this.repository.findRecordedInteractionFixtureContent(
        candidate.revocation.scope,
        candidate.revocation.fixtureVersionId,
      );
      if (stored) {
        for (const ownership of stored.ownerships) {
          const entry = await this.catalog.find(ownership.scope, ownership.artifactId);
          if (!exactOwnership(entry, ownership)) {
            throw new RegressionRepositoryContractError(
              "Memory interaction artifact ownership is not coordinated",
            );
          }
        }
      }
      const result = await this.repository.revokeRecordedInteractionFixtureContent(candidate);
      for (const tombstone of result.tombstones) {
        this.catalog.tombstoneFixtureOwnershipForTesting(result.version.scope, tombstone);
      }
      return result;
    });
  }
}

export interface MemoryInteractionStorage {
  readonly artifactCatalogRepository: ArtifactCatalogRepository;
  readonly regressionVersionRepository: InteractionFixtureVersionRepository;
}

/** Creates memory adapters whose artifact ownership and fixture revocation state cannot diverge. */
export function createMemoryInteractionStorage(): MemoryInteractionStorage {
  const mutex = new AsyncMutex();
  const catalog = new MemoryArtifactCatalogRepository();
  const regression = new MemoryRegressionVersionRepository();
  return {
    artifactCatalogRepository: new LockedArtifactCatalogRepository(mutex, catalog),
    regressionVersionRepository: new CoordinatedMemoryRegressionVersionRepository(
      mutex,
      catalog,
      regression,
    ),
  };
}
