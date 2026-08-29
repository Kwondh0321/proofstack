import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import {
  type ArtifactMetadata,
  ArtifactMetadataSchema,
  type ArtifactOwnership,
  ArtifactOwnershipSchema,
  type ArtifactTombstone,
  ArtifactTombstoneSchema,
  type EvidenceScope,
  type InteractionFixtureContentRevocation,
  InteractionFixtureContentRevocationSchema,
  type RecordedInteractionFixtureVersion,
  type RegressionDatasetVersion,
  type RegressionFixtureVersion,
  type RegressionFixtureVersionReference,
  type RequestedRegressionFixtureVersionReference,
} from "@proofstack/contracts";
import {
  RegressionArtifactBindingError,
  RegressionFixtureContentRevocationConflictError,
  RegressionRepositoryContractError,
  RegressionVersionConflictError,
  RegressionVersionLineageError,
  RegressionVersionNotFoundError,
} from "../errors.js";
import {
  buildRecordedInteractionFixtureVersionPublishedOutboxIntent,
  buildRegressionDatasetVersionPublishedOutboxIntent,
  buildRegressionFixtureVersionPublishedOutboxIntent,
  type RegressionVersionPublishedOutboxIntent,
} from "../regression-publication-outbox.js";
import {
  areRecordedInteractionFixtureVersionDefinitionsEqual,
  areRegressionDatasetVersionDefinitionsEqual,
  areRegressionFixtureVersionDefinitionsEqual,
  validateAndProjectRecordedInteractionFixtureVersion,
  validateAndProjectRegressionDatasetVersion,
  validateAndProjectRegressionFixtureVersion,
} from "../regression-version-definition.js";
import type {
  InteractionFixtureVersionRepository,
  PublishRecordedInteractionFixtureVersionResult,
  PublishRegressionVersionResult,
  ResolveRegressionFixtureVersionReferencesResult,
  RevokeInteractionFixtureContentCandidate,
  RevokeInteractionFixtureContentResult,
  StoredInteractionFixtureContent,
  StoredRecordedInteractionFixtureVersion,
} from "../regression-version-repository.js";
import type { RegressionVersionPublicationKind } from "./regression-version-repository-test-control.js";

interface LogicalResourceBinding {
  readonly rootVersionId: string;
  readonly scope: EvidenceScope;
}

interface TenantState {
  readonly artifactMetadata: Map<string, ArtifactMetadata>;
  readonly artifactOwnerships: Map<string, ArtifactOwnership>;
  readonly artifactTombstones: Map<string, ArtifactTombstone>;
  readonly datasetResources: Map<string, LogicalResourceBinding>;
  readonly datasetVersions: Map<string, RegressionDatasetVersion>;
  readonly fixtureResources: Map<string, LogicalResourceBinding>;
  readonly fixtureVersions: Map<string, RegressionFixtureVersion>;
  readonly publicationIntents: Map<string, RegressionVersionPublishedOutboxIntent>;
  readonly recordedContentRevocations: Map<string, InteractionFixtureContentRevocation>;
  readonly recordedFixtureVersions: Map<string, RecordedInteractionFixtureVersion>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function emptyTenantState(): TenantState {
  return {
    artifactMetadata: new Map(),
    artifactOwnerships: new Map(),
    artifactTombstones: new Map(),
    datasetResources: new Map(),
    datasetVersions: new Map(),
    fixtureResources: new Map(),
    fixtureVersions: new Map(),
    publicationIntents: new Map(),
    recordedContentRevocations: new Map(),
    recordedFixtureVersions: new Map(),
  };
}

function copyTenantState(state: TenantState): TenantState {
  return {
    artifactMetadata: new Map(state.artifactMetadata),
    artifactOwnerships: new Map(state.artifactOwnerships),
    artifactTombstones: new Map(state.artifactTombstones),
    datasetResources: new Map(state.datasetResources),
    datasetVersions: new Map(state.datasetVersions),
    fixtureResources: new Map(state.fixtureResources),
    fixtureVersions: new Map(state.fixtureVersions),
    publicationIntents: new Map(state.publicationIntents),
    recordedContentRevocations: new Map(state.recordedContentRevocations),
    recordedFixtureVersions: new Map(state.recordedFixtureVersions),
  };
}

function scopesEqual(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function hasExactStoredScope(input: unknown, scope: EvidenceScope): boolean {
  if (typeof input !== "object" || input === null || !("scope" in input)) return false;
  const storedScope = input.scope;
  if (typeof storedScope !== "object" || storedScope === null) return false;
  return (
    "tenantId" in storedScope &&
    storedScope.tenantId === scope.tenantId &&
    "projectId" in storedScope &&
    storedScope.projectId === scope.projectId &&
    "environmentId" in storedScope &&
    storedScope.environmentId === scope.environmentId
  );
}

function intentKey(intent: RegressionVersionPublishedOutboxIntent): string {
  return `${intent.eventType}\u0000${intent.aggregateType}\u0000${intent.aggregateId}`;
}

function compareIntents(
  left: RegressionVersionPublishedOutboxIntent,
  right: RegressionVersionPublishedOutboxIntent,
): number {
  return Buffer.compare(Buffer.from(intentKey(left)), Buffer.from(intentKey(right)));
}

function requireCanonicalIntent(
  state: TenantState,
  expected: RegressionVersionPublishedOutboxIntent,
): void {
  const stored = state.publicationIntents.get(intentKey(expected));
  if (!stored || !isDeepStrictEqual(stored, expected)) {
    throw new RegressionRepositoryContractError(
      "Stored regression version is missing its canonical publication intent",
    );
  }
}

function validateStoredFixtureVersion(input: unknown) {
  try {
    return validateAndProjectRegressionFixtureVersion(input);
  } catch (cause) {
    throw new RegressionRepositoryContractError(
      "Stored regression fixture version violates the repository contract",
      { cause },
    );
  }
}

function validateStoredDatasetVersion(input: unknown) {
  try {
    return validateAndProjectRegressionDatasetVersion(input);
  } catch (cause) {
    throw new RegressionRepositoryContractError(
      "Stored regression dataset version violates the repository contract",
      { cause },
    );
  }
}

function validateStoredRecordedFixtureVersion(input: unknown) {
  try {
    return validateAndProjectRecordedInteractionFixtureVersion(input);
  } catch (cause) {
    throw new RegressionRepositoryContractError(
      "Stored recorded interaction fixture version violates the repository contract",
      { cause },
    );
  }
}

function expectedOwnerships(
  version: RecordedInteractionFixtureVersion,
): readonly ArtifactOwnership[] {
  return version.interactionCapture.artifacts.map(({ contentReference }) =>
    ArtifactOwnershipSchema.parse({
      artifactId: contentReference.artifactId,
      boundAt: version.createdAt,
      boundByPrincipalId: version.createdByPrincipalId,
      owner: {
        fixtureId: version.fixtureId,
        fixtureVersionId: version.fixtureVersionId,
        kind: "regression_fixture_version",
      },
      schemaVersion: "0.1",
      scope: version.scope,
    }),
  );
}

function storedRecordedFixtureRecord(
  state: TenantState,
  input: unknown,
): StoredRecordedInteractionFixtureVersion {
  const stored = validateStoredRecordedFixtureVersion(input).version;
  const ownerships = expectedOwnerships(stored).map((expected) => {
    const ownership = state.artifactOwnerships.get(expected.artifactId);
    if (!ownership || !isDeepStrictEqual(ownership, expected)) {
      throw new RegressionRepositoryContractError(
        "Stored recorded interaction fixture is missing canonical artifact ownership",
      );
    }
    return clone(ownership);
  });
  requireCanonicalIntent(
    state,
    buildRecordedInteractionFixtureVersionPublishedOutboxIntent(stored),
  );
  return { ownerships, version: clone(stored) };
}

function storedInteractionFixtureContent(
  state: TenantState,
  input: unknown,
): StoredInteractionFixtureContent {
  const record = storedRecordedFixtureRecord(state, input);
  const revocationInput = state.recordedContentRevocations.get(record.version.fixtureVersionId);
  if (revocationInput) {
    const revocation = InteractionFixtureContentRevocationSchema.safeParse(revocationInput);
    if (
      !revocation.success ||
      revocation.data.fixtureId !== record.version.fixtureId ||
      !scopesEqual(revocation.data.scope, record.version.scope)
    ) {
      throw new RegressionRepositoryContractError(
        "Stored interaction fixture content revocation violates the repository contract",
      );
    }
    const tombstones = record.ownerships.map((ownership) => {
      const tombstone = ArtifactTombstoneSchema.safeParse(
        state.artifactTombstones.get(ownership.artifactId),
      );
      if (
        !tombstone.success ||
        tombstone.data.actorPrincipalId !== revocation.data.revokedByPrincipalId ||
        tombstone.data.occurredAt !== revocation.data.revokedAt ||
        tombstone.data.reason !== revocation.data.reason ||
        tombstone.data.trigger !== "fixture_revocation"
      ) {
        throw new RegressionRepositoryContractError(
          "Stored interaction fixture tombstones violate the repository contract",
        );
      }
      return tombstone.data;
    });
    return {
      contentAvailability: "revoked",
      ownerships: record.ownerships,
      revocation: revocation.data,
      tombstones,
      version: record.version,
    };
  }
  const available = record.ownerships.every((ownership) => {
    const metadata = state.artifactMetadata.get(ownership.artifactId);
    return metadata?.state === "available";
  });
  return {
    contentAvailability: available ? "available" : "unavailable",
    ownerships: record.ownerships,
    revocation: null,
    tombstones: [],
    version: record.version,
  };
}

interface StoredFixtureReferenceTarget {
  readonly kind: "evidence" | "recorded";
  readonly value: RegressionFixtureVersion | RecordedInteractionFixtureVersion;
}

function storedFixtureReferenceTarget(
  state: TenantState,
  fixtureVersionId: string,
): StoredFixtureReferenceTarget | null {
  const evidence = state.fixtureVersions.get(fixtureVersionId);
  const recorded = state.recordedFixtureVersions.get(fixtureVersionId);
  if (evidence && recorded) {
    throw new RegressionRepositoryContractError(
      "A fixture version identifier is stored in multiple version families",
    );
  }
  if (evidence) return { kind: "evidence", value: evidence };
  if (recorded) return { kind: "recorded", value: recorded };
  return null;
}

function validateFixtureReferenceTarget(
  target: StoredFixtureReferenceTarget,
): RegressionFixtureVersion | RecordedInteractionFixtureVersion {
  return target.kind === "evidence"
    ? validateStoredFixtureVersion(target.value).version
    : validateStoredRecordedFixtureVersion(target.value).version;
}

function fixtureBindingForPublication(
  state: TenantState,
  version: RegressionFixtureVersion,
): LogicalResourceBinding | null {
  const binding = state.fixtureResources.get(version.fixtureId);
  if (!binding) {
    if (version.predecessor) throw new RegressionVersionLineageError();
    return { rootVersionId: version.fixtureVersionId, scope: clone(version.scope) };
  }
  if (!scopesEqual(binding.scope, version.scope)) throw new RegressionVersionConflictError();
  if (!version.predecessor) throw new RegressionVersionLineageError();

  const predecessor = state.fixtureVersions.get(version.predecessor.fixtureVersionId);
  if (!predecessor) throw new RegressionVersionLineageError();
  const authoritative = validateStoredFixtureVersion(predecessor).version;
  if (
    authoritative.fixtureId !== version.fixtureId ||
    !scopesEqual(authoritative.scope, version.scope) ||
    authoritative.definitionSha256 !== version.predecessor.definitionSha256
  ) {
    throw new RegressionVersionLineageError();
  }
  return null;
}

function datasetBindingForPublication(
  state: TenantState,
  version: RegressionDatasetVersion,
): LogicalResourceBinding | null {
  const binding = state.datasetResources.get(version.datasetId);
  if (!binding) {
    if (version.predecessor) throw new RegressionVersionLineageError();
    return { rootVersionId: version.datasetVersionId, scope: clone(version.scope) };
  }
  if (!scopesEqual(binding.scope, version.scope)) throw new RegressionVersionConflictError();
  if (!version.predecessor) throw new RegressionVersionLineageError();

  const predecessor = state.datasetVersions.get(version.predecessor.datasetVersionId);
  if (!predecessor) throw new RegressionVersionLineageError();
  const authoritative = validateStoredDatasetVersion(predecessor).version;
  if (
    authoritative.datasetId !== version.datasetId ||
    !scopesEqual(authoritative.scope, version.scope) ||
    authoritative.definitionSha256 !== version.predecessor.definitionSha256
  ) {
    throw new RegressionVersionLineageError();
  }
  return null;
}

function validateDatasetMembership(state: TenantState, version: RegressionDatasetVersion): void {
  for (const reference of version.fixtureVersions) {
    const target = storedFixtureReferenceTarget(state, reference.fixtureVersionId);
    if (!target) throw new RegressionVersionConflictError();
    const stored = validateFixtureReferenceTarget(target);
    if (
      stored.fixtureId !== reference.fixtureId ||
      !scopesEqual(stored.scope, version.scope) ||
      stored.definitionSha256 !== reference.definitionSha256
    ) {
      throw new RegressionVersionConflictError();
    }
  }
}

function interactionFixtureBindingForPublication(
  state: TenantState,
  version: RecordedInteractionFixtureVersion,
): void {
  const binding = state.fixtureResources.get(version.fixtureId);
  if (!binding) throw new RegressionVersionLineageError();
  if (!scopesEqual(binding.scope, version.scope)) throw new RegressionVersionConflictError();

  const predecessor = state.fixtureVersions.get(version.predecessor.fixtureVersionId);
  if (!predecessor) throw new RegressionVersionLineageError();
  const authoritative = validateStoredFixtureVersion(predecessor).version;
  if (
    authoritative.fixtureId !== version.fixtureId ||
    !scopesEqual(authoritative.scope, version.scope) ||
    authoritative.definitionSha256 !== version.predecessor.definitionSha256 ||
    !isDeepStrictEqual(authoritative.source, version.source)
  ) {
    throw new RegressionVersionLineageError();
  }
}

function ownershipsForPublication(
  state: TenantState,
  version: RecordedInteractionFixtureVersion,
): readonly ArtifactOwnership[] {
  for (const binding of version.interactionCapture.artifacts) {
    const artifactId = binding.contentReference.artifactId;
    const metadataInput = state.artifactMetadata.get(artifactId);
    const metadata = ArtifactMetadataSchema.safeParse(metadataInput);
    if (
      !metadata.success ||
      !scopesEqual(metadata.data.scope, version.scope) ||
      metadata.data.state !== "available" ||
      metadata.data.retention.mode !== "retain" ||
      !isDeepStrictEqual(metadata.data.contentReference, binding.contentReference) ||
      !isDeepStrictEqual(metadata.data.redaction, binding.redaction) ||
      state.artifactOwnerships.has(artifactId)
    ) {
      throw new RegressionArtifactBindingError();
    }
  }
  return expectedOwnerships(version);
}

/** Test adapter that linearizes every publication with one detached tenant-state replacement. */
export class MemoryRegressionVersionRepository implements InteractionFixtureVersionRepository {
  private readonly failedIntentKinds = new Set<RegressionVersionPublicationKind>();
  private readonly tenants = new Map<string, TenantState>();

  async datasetResourceExists(scope: EvidenceScope, datasetId: string): Promise<boolean> {
    const binding = this.tenants.get(scope.tenantId)?.datasetResources.get(datasetId);
    return binding !== undefined && hasExactStoredScope(binding, scope);
  }

  async findDatasetVersion(
    scope: EvidenceScope,
    datasetVersionId: string,
  ): Promise<RegressionDatasetVersion | null> {
    const stored = this.tenants.get(scope.tenantId)?.datasetVersions.get(datasetVersionId);
    if (!stored || !hasExactStoredScope(stored, scope)) return null;
    const authoritative = validateStoredDatasetVersion(stored).version;
    return clone(authoritative);
  }

  async findFixtureVersion(
    scope: EvidenceScope,
    fixtureVersionId: string,
  ): Promise<RegressionFixtureVersion | null> {
    const stored = this.tenants.get(scope.tenantId)?.fixtureVersions.get(fixtureVersionId);
    if (!stored || !hasExactStoredScope(stored, scope)) return null;
    const authoritative = validateStoredFixtureVersion(stored).version;
    return clone(authoritative);
  }

  async findRecordedInteractionFixtureVersion(
    scope: EvidenceScope,
    fixtureVersionId: string,
  ): Promise<StoredRecordedInteractionFixtureVersion | null> {
    const state = this.tenants.get(scope.tenantId);
    const stored = state?.recordedFixtureVersions.get(fixtureVersionId);
    if (!state || !stored || !hasExactStoredScope(stored, scope)) return null;
    return clone(storedRecordedFixtureRecord(state, stored));
  }

  async findRecordedInteractionFixtureContent(
    scope: EvidenceScope,
    fixtureVersionId: string,
  ): Promise<StoredInteractionFixtureContent | null> {
    const state = this.tenants.get(scope.tenantId);
    const stored = state?.recordedFixtureVersions.get(fixtureVersionId);
    if (!state || !stored || !hasExactStoredScope(stored, scope)) return null;
    return clone(storedInteractionFixtureContent(state, stored));
  }

  async fixtureResourceExists(scope: EvidenceScope, fixtureId: string): Promise<boolean> {
    const binding = this.tenants.get(scope.tenantId)?.fixtureResources.get(fixtureId);
    return binding !== undefined && hasExactStoredScope(binding, scope);
  }

  async publishDatasetVersion(
    candidate: RegressionDatasetVersion,
  ): Promise<PublishRegressionVersionResult<RegressionDatasetVersion>> {
    const validated = validateAndProjectRegressionDatasetVersion(candidate);
    const version = validated.version;
    const current = this.tenants.get(version.scope.tenantId) ?? emptyTenantState();
    const existing = current.datasetVersions.get(version.datasetVersionId);
    if (existing) {
      const stored = validateStoredDatasetVersion(existing);
      if (!areRegressionDatasetVersionDefinitionsEqual(stored.definition, validated.definition)) {
        throw new RegressionVersionConflictError();
      }
      requireCanonicalIntent(
        current,
        buildRegressionDatasetVersionPublishedOutboxIntent(stored.version),
      );
      return { created: false, version: clone(stored.version) };
    }

    const binding = datasetBindingForPublication(current, version);
    validateDatasetMembership(current, version);
    const stored = clone(version);
    const intent = buildRegressionDatasetVersionPublishedOutboxIntent(stored);
    const result = { created: true, version: clone(stored) } as const;
    const next = copyTenantState(current);
    if (binding) next.datasetResources.set(version.datasetId, binding);
    next.datasetVersions.set(version.datasetVersionId, stored);
    next.publicationIntents.set(intentKey(intent), clone(intent));
    this.throwInjectedIntentFailure("dataset");
    this.tenants.set(version.scope.tenantId, next);
    return result;
  }

  async publishFixtureVersion(
    candidate: RegressionFixtureVersion,
  ): Promise<PublishRegressionVersionResult<RegressionFixtureVersion>> {
    const validated = validateAndProjectRegressionFixtureVersion(candidate);
    const version = validated.version;
    const current = this.tenants.get(version.scope.tenantId) ?? emptyTenantState();
    if (current.recordedFixtureVersions.has(version.fixtureVersionId)) {
      throw new RegressionVersionConflictError();
    }
    const existing = current.fixtureVersions.get(version.fixtureVersionId);
    if (existing) {
      const stored = validateStoredFixtureVersion(existing);
      if (!areRegressionFixtureVersionDefinitionsEqual(stored.definition, validated.definition)) {
        throw new RegressionVersionConflictError();
      }
      requireCanonicalIntent(
        current,
        buildRegressionFixtureVersionPublishedOutboxIntent(stored.version),
      );
      return { created: false, version: clone(stored.version) };
    }

    const binding = fixtureBindingForPublication(current, version);
    const stored = clone(version);
    const intent = buildRegressionFixtureVersionPublishedOutboxIntent(stored);
    const result = { created: true, version: clone(stored) } as const;
    const next = copyTenantState(current);
    if (binding) next.fixtureResources.set(version.fixtureId, binding);
    next.fixtureVersions.set(version.fixtureVersionId, stored);
    next.publicationIntents.set(intentKey(intent), clone(intent));
    this.throwInjectedIntentFailure("fixture");
    this.tenants.set(version.scope.tenantId, next);
    return result;
  }

  async publishRecordedInteractionFixtureVersion(
    candidate: RecordedInteractionFixtureVersion,
  ): Promise<PublishRecordedInteractionFixtureVersionResult> {
    const validated = validateAndProjectRecordedInteractionFixtureVersion(candidate);
    const version = validated.version;
    const current = this.tenants.get(version.scope.tenantId) ?? emptyTenantState();
    const existing = current.recordedFixtureVersions.get(version.fixtureVersionId);
    if (existing) {
      const stored = storedRecordedFixtureRecord(current, existing);
      const storedDefinition = validateStoredRecordedFixtureVersion(stored.version).definition;
      if (
        !areRecordedInteractionFixtureVersionDefinitionsEqual(
          storedDefinition,
          validated.definition,
        )
      ) {
        throw new RegressionVersionConflictError();
      }
      return { created: false, ownerships: stored.ownerships, version: stored.version };
    }
    if (current.fixtureVersions.has(version.fixtureVersionId)) {
      throw new RegressionVersionConflictError();
    }

    interactionFixtureBindingForPublication(current, version);
    const ownerships = ownershipsForPublication(current, version);
    const stored = clone(version);
    const intent = buildRecordedInteractionFixtureVersionPublishedOutboxIntent(stored);
    const next = copyTenantState(current);
    next.recordedFixtureVersions.set(version.fixtureVersionId, stored);
    for (const ownership of ownerships) {
      next.artifactOwnerships.set(ownership.artifactId, clone(ownership));
    }
    next.publicationIntents.set(intentKey(intent), clone(intent));
    this.throwInjectedIntentFailure("interaction_fixture");
    this.tenants.set(version.scope.tenantId, next);
    return { created: true, ownerships: clone(ownerships), version: clone(stored) };
  }

  async revokeRecordedInteractionFixtureContent(
    candidate: RevokeInteractionFixtureContentCandidate,
  ): Promise<RevokeInteractionFixtureContentResult> {
    const revocation = InteractionFixtureContentRevocationSchema.parse(candidate.revocation);
    const tombstones = candidate.tombstones.map((value) => ArtifactTombstoneSchema.parse(value));
    const current = this.tenants.get(revocation.scope.tenantId);
    const stored = current?.recordedFixtureVersions.get(revocation.fixtureVersionId);
    if (
      !current ||
      !stored ||
      !hasExactStoredScope(stored, revocation.scope) ||
      stored.fixtureId !== revocation.fixtureId
    ) {
      throw new RegressionVersionNotFoundError();
    }
    const existing = current.recordedContentRevocations.get(revocation.fixtureVersionId);
    if (existing) {
      if (existing.reason !== revocation.reason) {
        throw new RegressionFixtureContentRevocationConflictError();
      }
      return { created: false, ...clone(storedInteractionFixtureContent(current, stored)) };
    }
    const content = storedInteractionFixtureContent(current, stored);
    if (tombstones.length !== content.ownerships.length) {
      throw new RegressionRepositoryContractError(
        "Interaction fixture revocation tombstone set is incomplete",
      );
    }
    const next = copyTenantState(current);
    next.recordedContentRevocations.set(revocation.fixtureVersionId, clone(revocation));
    for (const [index, tombstone] of tombstones.entries()) {
      const ownership = content.ownerships[index] as ArtifactOwnership;
      const metadata = current.artifactMetadata.get(ownership.artifactId);
      if (
        metadata?.state !== "available" ||
        tombstone.artifactId !== ownership.artifactId ||
        tombstone.actorPrincipalId !== revocation.revokedByPrincipalId ||
        tombstone.occurredAt !== revocation.revokedAt ||
        tombstone.reason !== revocation.reason ||
        tombstone.trigger !== "fixture_revocation"
      ) {
        throw new RegressionRepositoryContractError(
          "Interaction fixture revocation tombstone set is invalid",
        );
      }
      next.artifactTombstones.set(tombstone.artifactId, clone(tombstone));
      next.artifactMetadata.set(tombstone.artifactId, {
        ...metadata,
        state: "tombstoned",
        tombstonedAt: tombstone.occurredAt,
      });
    }
    this.throwInjectedIntentFailure("interaction_revocation");
    this.tenants.set(revocation.scope.tenantId, next);
    return { created: true, ...clone(storedInteractionFixtureContent(next, stored)) };
  }

  async resolveFixtureVersionReferences(
    scope: EvidenceScope,
    references: readonly RequestedRegressionFixtureVersionReference[],
  ): Promise<ResolveRegressionFixtureVersionReferencesResult> {
    if (references.length === 0) return [];
    const state = this.tenants.get(scope.tenantId);
    if (!state) return null;

    const resolved: RegressionFixtureVersionReference[] = [];
    for (const reference of references) {
      const target = storedFixtureReferenceTarget(state, reference.fixtureVersionId);
      if (
        !target ||
        !hasExactStoredScope(target.value, scope) ||
        target.value.fixtureId !== reference.fixtureId
      ) {
        return null;
      }
      const stored = validateFixtureReferenceTarget(target);
      resolved.push({
        definitionSha256: stored.definitionSha256,
        fixtureId: stored.fixtureId,
        fixtureVersionId: stored.fixtureVersionId,
      });
    }
    return clone(resolved);
  }

  /** Schedules one test-only outbox insertion failure without mutating authoritative state. */
  failNextPublicationIntent(kind: RegressionVersionPublicationKind): void {
    this.failedIntentKinds.add(kind);
  }

  /** Seeds one authoritative catalog row for interaction-publication adapter tests. */
  seedInteractionArtifact(metadataInput: ArtifactMetadata): void {
    const metadata = ArtifactMetadataSchema.parse(metadataInput);
    const artifactId = metadata.contentReference.artifactId;
    const current = this.tenants.get(metadata.scope.tenantId) ?? emptyTenantState();
    const existing = current.artifactMetadata.get(artifactId);
    if (existing && !isDeepStrictEqual(existing, metadata)) {
      throw new RegressionArtifactBindingError();
    }
    if (existing) return;
    const next = copyTenantState(current);
    next.artifactMetadata.set(artifactId, clone(metadata));
    this.tenants.set(metadata.scope.tenantId, next);
  }

  /** Returns isolated publication intents in deterministic bytewise identifier order. */
  async publishedIntents(
    tenantId: string,
  ): Promise<readonly RegressionVersionPublishedOutboxIntent[]> {
    const intents = this.tenants.get(tenantId)?.publicationIntents.values() ?? [];
    return clone([...intents].sort(compareIntents));
  }

  private throwInjectedIntentFailure(kind: RegressionVersionPublicationKind): void {
    if (!this.failedIntentKinds.delete(kind)) return;
    throw new Error(`Injected ${kind} regression publication intent failure`);
  }
}
