import { isDeepStrictEqual } from "node:util";
import {
  type ArtifactOwnership,
  ArtifactOwnershipSchema,
  type ArtifactTombstone,
  ArtifactTombstoneSchema,
  type EvidenceScope,
} from "@proofstack/contracts";
import type {
  ArtifactCatalogEntry,
  ArtifactCatalogRepository,
  ArtifactKeyReferenceSummary,
  ArtifactObjectReceipt,
  ArtifactPurgeReceipt,
  ReserveArtifactCatalogResult,
  TombstoneArtifactCatalogResult,
} from "../artifact-ports.js";
import {
  artifactReservationIdentity,
  MAX_ARTIFACT_MAINTENANCE_BATCH_SIZE,
} from "../artifact-ports.js";
import {
  ArtifactConflictError,
  ArtifactNotFoundError,
  ArtifactOwnedDeletionError,
  ArtifactOwnershipConflictError,
  ArtifactStateTransitionError,
} from "../errors.js";

interface StoredArtifact {
  entry: ArtifactCatalogEntry;
  purgeReceipt?: ArtifactPurgeReceipt;
  tombstone?: ArtifactTombstone;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function artifactKey(tenantId: string, artifactId: string): string {
  return `${tenantId}:${artifactId}`;
}

function matchesScope(entry: ArtifactCatalogEntry, scope: EvidenceScope): boolean {
  return (
    entry.metadata.scope.tenantId === scope.tenantId &&
    entry.metadata.scope.projectId === scope.projectId &&
    entry.metadata.scope.environmentId === scope.environmentId
  );
}

function isSameReservation(left: ArtifactCatalogEntry, right: ArtifactCatalogEntry): boolean {
  return isDeepStrictEqual(
    artifactReservationIdentity(left.metadata),
    artifactReservationIdentity(right.metadata),
  );
}

function isSameTombstone(left: ArtifactTombstone, right: ArtifactTombstone): boolean {
  return (
    left.actorPrincipalId === right.actorPrincipalId &&
    left.artifactId === right.artifactId &&
    left.reason === right.reason &&
    left.trigger === right.trigger
  );
}

function compareExpired(left: ArtifactCatalogEntry, right: ArtifactCatalogEntry): number {
  const leftExpiry = (left.metadata.retention as { readonly expiresAt: string }).expiresAt;
  const rightExpiry = (right.metadata.retention as { readonly expiresAt: string }).expiresAt;
  return (
    Date.parse(leftExpiry) - Date.parse(rightExpiry) ||
    left.metadata.contentReference.artifactId.localeCompare(
      right.metadata.contentReference.artifactId,
    )
  );
}

function compareAbandoned(left: ArtifactCatalogEntry, right: ArtifactCatalogEntry): number {
  return (
    Date.parse(left.metadata.createdAt) - Date.parse(right.metadata.createdAt) ||
    left.metadata.contentReference.artifactId.localeCompare(
      right.metadata.contentReference.artifactId,
    )
  );
}

function comparePendingPurge(left: ArtifactCatalogEntry, right: ArtifactCatalogEntry): number {
  return (
    Date.parse(left.metadata.tombstonedAt as string) -
      Date.parse(right.metadata.tombstonedAt as string) ||
    left.metadata.contentReference.artifactId.localeCompare(
      right.metadata.contentReference.artifactId,
    )
  );
}

function assertMaintenanceLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ARTIFACT_MAINTENANCE_BATCH_SIZE) {
    throw new RangeError(
      `Artifact maintenance limit must be between 1 and ${MAX_ARTIFACT_MAINTENANCE_BATCH_SIZE}`,
    );
  }
}

export class MemoryArtifactCatalogRepository implements ArtifactCatalogRepository {
  private readonly artifacts = new Map<string, StoredArtifact>();

  async reserve(candidate: ArtifactCatalogEntry): Promise<ReserveArtifactCatalogResult> {
    if (
      candidate.metadata.state !== "reserved" ||
      candidate.objectReceipt !== undefined ||
      candidate.ownership !== undefined
    ) {
      throw new ArtifactStateTransitionError();
    }
    const artifactId = candidate.metadata.contentReference.artifactId;
    const key = artifactKey(candidate.metadata.scope.tenantId, artifactId);
    const existing = this.artifacts.get(key);
    if (!existing) {
      const stored = { entry: clone(candidate) };
      this.artifacts.set(key, stored);
      return { created: true, entry: clone(stored.entry) };
    }
    if (!isSameReservation(existing.entry, candidate)) throw new ArtifactConflictError();
    return { created: false, entry: clone(existing.entry) };
  }

  async find(scope: EvidenceScope, artifactId: string): Promise<ArtifactCatalogEntry | null> {
    const stored = this.artifacts.get(artifactKey(scope.tenantId, artifactId));
    return stored && matchesScope(stored.entry, scope) ? clone(stored.entry) : null;
  }

  async findPurgeReceipt(
    scope: EvidenceScope,
    artifactId: string,
  ): Promise<ArtifactPurgeReceipt | null> {
    const stored = this.artifacts.get(artifactKey(scope.tenantId, artifactId));
    return stored && matchesScope(stored.entry, scope) && stored.purgeReceipt
      ? clone(stored.purgeReceipt)
      : null;
  }

  async activate(
    scope: EvidenceScope,
    artifactId: string,
    objectReceipt: ArtifactObjectReceipt,
    availableAt: string,
  ): Promise<ArtifactCatalogEntry> {
    const stored = this.required(scope, artifactId);
    if (stored.entry.metadata.state === "available") {
      if (!isDeepStrictEqual(stored.entry.objectReceipt, objectReceipt)) {
        throw new ArtifactConflictError();
      }
      return clone(stored.entry);
    }
    if (stored.entry.metadata.state !== "reserved") throw new ArtifactStateTransitionError();

    stored.entry = {
      ...stored.entry,
      metadata: { ...stored.entry.metadata, availableAt, state: "available" },
      objectReceipt: clone(objectReceipt),
    };
    return clone(stored.entry);
  }

  async tombstone(
    scope: EvidenceScope,
    tombstone: ArtifactTombstone,
  ): Promise<TombstoneArtifactCatalogResult> {
    const stored = this.required(scope, tombstone.artifactId);
    if (stored.entry.ownership) throw new ArtifactOwnedDeletionError();
    if (stored.tombstone) {
      if (!isSameTombstone(stored.tombstone, tombstone)) throw new ArtifactConflictError();
      return {
        created: false,
        entry: clone(stored.entry),
        tombstone: clone(stored.tombstone),
      };
    }

    const state = stored.entry.metadata.state;
    const allowed =
      (state === "reserved" && tombstone.trigger === "abandoned") ||
      (state === "available" && tombstone.trigger !== "abandoned");
    if (!allowed) throw new ArtifactStateTransitionError();

    stored.tombstone = clone(tombstone);
    stored.entry = {
      ...stored.entry,
      metadata: {
        ...stored.entry.metadata,
        state: "tombstoned",
        tombstonedAt: tombstone.occurredAt,
      },
    };
    return {
      created: true,
      entry: clone(stored.entry),
      tombstone: clone(stored.tombstone),
    };
  }

  async recordPurge(
    scope: EvidenceScope,
    receipt: ArtifactPurgeReceipt,
  ): Promise<ArtifactCatalogEntry> {
    const stored = this.required(scope, receipt.artifactId);
    if (stored.entry.metadata.state === "purged") return clone(stored.entry);
    if (stored.entry.metadata.state !== "tombstoned") throw new ArtifactStateTransitionError();

    stored.purgeReceipt = clone(receipt);
    stored.entry = {
      ...stored.entry,
      metadata: { ...stored.entry.metadata, purgedAt: receipt.occurredAt, state: "purged" },
    };
    return clone(stored.entry);
  }

  async listExpired(
    scope: EvidenceScope,
    expiresBefore: string,
    limit: number,
  ): Promise<readonly ArtifactCatalogEntry[]> {
    assertMaintenanceLimit(limit);
    const threshold = Date.parse(expiresBefore);
    return [...this.artifacts.values()]
      .map(({ entry }) => entry)
      .filter(
        (entry) =>
          matchesScope(entry, scope) &&
          entry.metadata.state === "available" &&
          entry.metadata.retention.mode === "expire" &&
          Date.parse(entry.metadata.retention.expiresAt) <= threshold,
      )
      .sort(compareExpired)
      .slice(0, limit)
      .map(clone);
  }

  async listAbandoned(
    scope: EvidenceScope,
    createdBefore: string,
    limit: number,
  ): Promise<readonly ArtifactCatalogEntry[]> {
    assertMaintenanceLimit(limit);
    const threshold = Date.parse(createdBefore);
    return [...this.artifacts.values()]
      .map(({ entry }) => entry)
      .filter(
        (entry) =>
          matchesScope(entry, scope) &&
          entry.metadata.state === "reserved" &&
          Date.parse(entry.metadata.createdAt) <= threshold,
      )
      .sort(compareAbandoned)
      .slice(0, limit)
      .map(clone);
  }

  async listPendingPurge(
    scope: EvidenceScope,
    limit: number,
  ): Promise<readonly ArtifactCatalogEntry[]> {
    assertMaintenanceLimit(limit);
    return [...this.artifacts.values()]
      .map(({ entry }) => entry)
      .filter((entry) => matchesScope(entry, scope) && entry.metadata.state === "tombstoned")
      .sort(comparePendingPurge)
      .slice(0, limit)
      .map(clone);
  }

  async listKeyReferences(scope: EvidenceScope): Promise<readonly ArtifactKeyReferenceSummary[]> {
    const references = new Map<string, ArtifactKeyReferenceSummary["counts"]>();
    for (const { entry } of this.artifacts.values()) {
      if (!matchesScope(entry, scope)) continue;
      const keyId = entry.encryption.wrappedDataKey.keyId;
      const current = references.get(keyId) ?? {
        available: 0,
        purged: 0,
        reserved: 0,
        tombstoned: 0,
        total: 0,
      };
      references.set(keyId, {
        ...current,
        [entry.metadata.state]: current[entry.metadata.state] + 1,
        total: current.total + 1,
      });
    }
    return [...references.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([keyId, counts]) => ({ counts: { ...counts }, keyId }));
  }

  /** Testing-only equivalent of the ownership row written by a coordinated fixture transaction. */
  claimFixtureOwnershipForTesting(ownershipInput: ArtifactOwnership): ArtifactCatalogEntry {
    const ownership = ArtifactOwnershipSchema.parse(ownershipInput);
    const stored = this.required(ownership.scope, ownership.artifactId);
    if (stored.entry.ownership) {
      if (!isDeepStrictEqual(stored.entry.ownership, ownership)) {
        throw new ArtifactOwnershipConflictError();
      }
      return clone(stored.entry);
    }
    if (
      stored.entry.metadata.state !== "available" ||
      stored.entry.metadata.retention.mode !== "retain"
    ) {
      throw new ArtifactStateTransitionError();
    }
    stored.entry = { ...stored.entry, ownership: clone(ownership) };
    return clone(stored.entry);
  }

  /** Testing-only equivalent of the owned tombstone written by a fixture revocation transaction. */
  tombstoneFixtureOwnershipForTesting(
    scope: EvidenceScope,
    tombstone: ArtifactTombstone,
  ): TombstoneArtifactCatalogResult {
    const candidate = ArtifactTombstoneSchema.parse(tombstone);
    const stored = this.required(scope, candidate.artifactId);
    if (!stored.entry.ownership || candidate.trigger !== "fixture_revocation") {
      throw new ArtifactStateTransitionError();
    }
    if (stored.tombstone) {
      if (!isSameTombstone(stored.tombstone, candidate)) throw new ArtifactConflictError();
      return {
        created: false,
        entry: clone(stored.entry),
        tombstone: clone(stored.tombstone),
      };
    }
    /* v8 ignore next -- ownership is claimable only while available and every later state has a tombstone. */
    if (stored.entry.metadata.state !== "available") throw new ArtifactStateTransitionError();

    stored.tombstone = clone(candidate);
    stored.entry = {
      ...stored.entry,
      metadata: {
        ...stored.entry.metadata,
        state: "tombstoned",
        tombstonedAt: candidate.occurredAt,
      },
    };
    return {
      created: true,
      entry: clone(stored.entry),
      tombstone: clone(candidate),
    };
  }

  private required(scope: EvidenceScope, artifactId: string): StoredArtifact {
    const stored = this.artifacts.get(artifactKey(scope.tenantId, artifactId));
    if (!stored || !matchesScope(stored.entry, scope)) throw new ArtifactNotFoundError();
    return stored;
  }
}
