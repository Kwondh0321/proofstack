import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import type {
  EvidenceScope,
  RegressionDatasetVersion,
  RegressionFixtureVersion,
  RegressionFixtureVersionReference,
  RequestedRegressionFixtureVersionReference,
} from "@proofstack/contracts";
import {
  RegressionRepositoryContractError,
  RegressionVersionConflictError,
  RegressionVersionLineageError,
} from "../errors.js";
import {
  buildRegressionDatasetVersionPublishedOutboxIntent,
  buildRegressionFixtureVersionPublishedOutboxIntent,
  type RegressionVersionPublishedOutboxIntent,
} from "../regression-publication-outbox.js";
import {
  areRegressionDatasetVersionDefinitionsEqual,
  areRegressionFixtureVersionDefinitionsEqual,
  validateAndProjectRegressionDatasetVersion,
  validateAndProjectRegressionFixtureVersion,
} from "../regression-version-definition.js";
import type {
  PublishRegressionVersionResult,
  RegressionVersionRepository,
  ResolveRegressionFixtureVersionReferencesResult,
} from "../regression-version-repository.js";
import type { RegressionVersionPublicationKind } from "./regression-version-repository-test-control.js";

interface LogicalResourceBinding {
  readonly rootVersionId: string;
  readonly scope: EvidenceScope;
}

interface TenantState {
  readonly datasetResources: Map<string, LogicalResourceBinding>;
  readonly datasetVersions: Map<string, RegressionDatasetVersion>;
  readonly fixtureResources: Map<string, LogicalResourceBinding>;
  readonly fixtureVersions: Map<string, RegressionFixtureVersion>;
  readonly publicationIntents: Map<string, RegressionVersionPublishedOutboxIntent>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function emptyTenantState(): TenantState {
  return {
    datasetResources: new Map(),
    datasetVersions: new Map(),
    fixtureResources: new Map(),
    fixtureVersions: new Map(),
    publicationIntents: new Map(),
  };
}

function copyTenantState(state: TenantState): TenantState {
  return {
    datasetResources: new Map(state.datasetResources),
    datasetVersions: new Map(state.datasetVersions),
    fixtureResources: new Map(state.fixtureResources),
    fixtureVersions: new Map(state.fixtureVersions),
    publicationIntents: new Map(state.publicationIntents),
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
    const stored = state.fixtureVersions.get(reference.fixtureVersionId);
    if (!stored) throw new RegressionVersionConflictError();
    const authoritative = validateStoredFixtureVersion(stored).version;
    if (
      authoritative.fixtureId !== reference.fixtureId ||
      !scopesEqual(authoritative.scope, version.scope) ||
      authoritative.definitionSha256 !== reference.definitionSha256
    ) {
      throw new RegressionVersionConflictError();
    }
  }
}

/** Test adapter that linearizes every publication with one detached tenant-state replacement. */
export class MemoryRegressionVersionRepository implements RegressionVersionRepository {
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

  async resolveFixtureVersionReferences(
    scope: EvidenceScope,
    references: readonly RequestedRegressionFixtureVersionReference[],
  ): Promise<ResolveRegressionFixtureVersionReferencesResult> {
    if (references.length === 0) return [];
    const state = this.tenants.get(scope.tenantId);
    if (!state) return null;

    const resolved: RegressionFixtureVersionReference[] = [];
    for (const reference of references) {
      const stored = state.fixtureVersions.get(reference.fixtureVersionId);
      if (
        !stored ||
        !hasExactStoredScope(stored, scope) ||
        stored.fixtureId !== reference.fixtureId
      ) {
        return null;
      }
      const authoritative = validateStoredFixtureVersion(stored).version;
      resolved.push({
        definitionSha256: authoritative.definitionSha256,
        fixtureId: authoritative.fixtureId,
        fixtureVersionId: authoritative.fixtureVersionId,
      });
    }
    return clone(resolved);
  }

  /** Schedules one test-only outbox insertion failure without mutating authoritative state. */
  failNextPublicationIntent(kind: RegressionVersionPublicationKind): void {
    this.failedIntentKinds.add(kind);
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
