import type {
  EvidenceScope,
  ReplayBoundaryDeclaration,
  ReplayPlan,
  TargetRelease,
  TargetReleaseReference,
} from "@proofstack/contracts";
import {
  ReplayDefinitionConflictError,
  ReplayDefinitionLineageError,
  ReplayRepositoryContractError,
} from "../errors.js";
import {
  areReplayPlanDefinitionsEqual,
  areTargetReleaseDefinitionsEqual,
  validateAndProjectReplayPlan,
  validateAndProjectTargetRelease,
} from "../replay-definition.js";
import {
  buildReplayPlanPublishedOutboxIntent,
  buildTargetReleasePublishedOutboxIntent,
  type PublishedReplayDefinitionOutboxIntent,
} from "../replay-definition-publication-outbox.js";
import type {
  PublishReplayDefinitionResult,
  ReplayDefinitionRepository,
} from "../replay-definition-repository.js";
import type { ReplayDefinitionPublicationKind } from "./replay-definition-repository-test-control.js";

interface TenantState {
  readonly intents: Map<string, PublishedReplayDefinitionOutboxIntent>;
  readonly planResources: Map<string, EvidenceScope>;
  readonly plans: Map<string, ReplayPlan>;
  readonly targetReleases: Map<string, TargetRelease>;
  readonly targetResources: Map<string, EvidenceScope>;
}

function emptyTenantState(): TenantState {
  return {
    intents: new Map(),
    planResources: new Map(),
    plans: new Map(),
    targetReleases: new Map(),
    targetResources: new Map(),
  };
}

function copyTenantState(state: TenantState): TenantState {
  return {
    intents: new Map(state.intents),
    planResources: new Map(state.planResources),
    plans: new Map(state.plans),
    targetReleases: new Map(state.targetReleases),
    targetResources: new Map(state.targetResources),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function scopesEqual(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function targetReferencesEqual(
  left: TargetReleaseReference,
  right: TargetReleaseReference,
): boolean {
  return (
    left.targetId === right.targetId &&
    left.targetReleaseId === right.targetReleaseId &&
    left.definitionSha256 === right.definitionSha256 &&
    left.targetAdapter.name === right.targetAdapter.name &&
    left.targetAdapter.version === right.targetAdapter.version &&
    left.targetAdapter.protocolVersion === right.targetAdapter.protocolVersion &&
    left.workerProtocol.name === right.workerProtocol.name &&
    left.workerProtocol.version === right.workerProtocol.version
  );
}

function targetReference(release: TargetRelease): TargetReleaseReference {
  return {
    definitionSha256: release.definitionSha256,
    targetAdapter: release.targetAdapter,
    targetId: release.targetId,
    targetReleaseId: release.targetReleaseId,
    workerProtocol: release.workerProtocol,
  };
}

function referencedTargetReleases(plan: ReplayPlan): readonly TargetReleaseReference[] {
  return [
    plan.targetRelease,
    ...plan.boundaries.flatMap((boundary: ReplayBoundaryDeclaration) =>
      boundary.mode === "simulation" ? [boundary.simulatorRelease] : [],
    ),
  ];
}

function intentKey(intent: PublishedReplayDefinitionOutboxIntent): string {
  return `${intent.eventType}:${intent.aggregateId}`;
}

function compareIntents(
  left: PublishedReplayDefinitionOutboxIntent,
  right: PublishedReplayDefinitionOutboxIntent,
): number {
  return intentKey(left) < intentKey(right) ? -1 : 1;
}

function requireCanonicalIntent(
  state: TenantState,
  expected: PublishedReplayDefinitionOutboxIntent,
): void {
  const stored = state.intents.get(intentKey(expected));
  if (JSON.stringify(stored) !== JSON.stringify(expected)) {
    throw new ReplayRepositoryContractError("Replay definition publication intent is unavailable");
  }
}

function requireResourceBinding(
  resources: ReadonlyMap<string, EvidenceScope>,
  resourceId: string,
  scope: EvidenceScope,
): boolean {
  const existing = resources.get(resourceId);
  if (!existing) return true;
  if (!scopesEqual(existing, scope)) throw new ReplayDefinitionConflictError();
  return false;
}

function requireTargetLineage(state: TenantState, plan: ReplayPlan): void {
  for (const reference of referencedTargetReleases(plan)) {
    const stored = state.targetReleases.get(reference.targetReleaseId);
    if (
      !stored ||
      !scopesEqual(stored.scope, plan.scope) ||
      !targetReferencesEqual(targetReference(stored), reference)
    ) {
      throw new ReplayDefinitionLineageError();
    }
  }
}

/** In-memory adapter with the same atomic definition-publication contract as durable adapters. */
export class MemoryReplayDefinitionRepository implements ReplayDefinitionRepository {
  private readonly failedIntentKinds = new Set<ReplayDefinitionPublicationKind>();
  private readonly tenants = new Map<string, TenantState>();

  async findReplayPlan(scope: EvidenceScope, planVersionId: string): Promise<ReplayPlan | null> {
    const stored = this.tenants.get(scope.tenantId)?.plans.get(planVersionId);
    if (!stored || !scopesEqual(stored.scope, scope)) return null;
    return clone(validateAndProjectReplayPlan(stored).plan);
  }

  async findTargetRelease(
    scope: EvidenceScope,
    targetReleaseId: string,
  ): Promise<TargetRelease | null> {
    const stored = this.tenants.get(scope.tenantId)?.targetReleases.get(targetReleaseId);
    if (!stored || !scopesEqual(stored.scope, scope)) return null;
    return clone(validateAndProjectTargetRelease(stored).release);
  }

  async publishReplayPlan(
    candidate: ReplayPlan,
  ): Promise<PublishReplayDefinitionResult<ReplayPlan>> {
    const validated = validateAndProjectReplayPlan(candidate);
    const plan = validated.plan;
    const current = this.tenants.get(plan.scope.tenantId) ?? emptyTenantState();
    const existing = current.plans.get(plan.planVersionId);
    if (existing) {
      const stored = validateAndProjectReplayPlan(existing);
      if (!areReplayPlanDefinitionsEqual(stored.definition, validated.definition)) {
        throw new ReplayDefinitionConflictError();
      }
      requireCanonicalIntent(current, buildReplayPlanPublishedOutboxIntent(stored.plan));
      return { created: false, definition: clone(stored.plan) };
    }

    const createResource = requireResourceBinding(current.planResources, plan.planId, plan.scope);
    requireTargetLineage(current, plan);
    const stored = clone(plan);
    const intent = buildReplayPlanPublishedOutboxIntent(stored);
    const next = copyTenantState(current);
    if (createResource) next.planResources.set(plan.planId, clone(plan.scope));
    next.plans.set(plan.planVersionId, stored);
    next.intents.set(intentKey(intent), clone(intent));
    this.throwInjectedIntentFailure("replay_plan");
    this.tenants.set(plan.scope.tenantId, next);
    return { created: true, definition: clone(stored) };
  }

  async publishTargetRelease(
    candidate: TargetRelease,
  ): Promise<PublishReplayDefinitionResult<TargetRelease>> {
    const validated = validateAndProjectTargetRelease(candidate);
    const release = validated.release;
    const current = this.tenants.get(release.scope.tenantId) ?? emptyTenantState();
    const existing = current.targetReleases.get(release.targetReleaseId);
    if (existing) {
      const stored = validateAndProjectTargetRelease(existing);
      if (!areTargetReleaseDefinitionsEqual(stored.definition, validated.definition)) {
        throw new ReplayDefinitionConflictError();
      }
      requireCanonicalIntent(current, buildTargetReleasePublishedOutboxIntent(stored.release));
      return { created: false, definition: clone(stored.release) };
    }

    const createResource = requireResourceBinding(
      current.targetResources,
      release.targetId,
      release.scope,
    );
    const stored = clone(release);
    const intent = buildTargetReleasePublishedOutboxIntent(stored);
    const next = copyTenantState(current);
    if (createResource) next.targetResources.set(release.targetId, clone(release.scope));
    next.targetReleases.set(release.targetReleaseId, stored);
    next.intents.set(intentKey(intent), clone(intent));
    this.throwInjectedIntentFailure("target_release");
    this.tenants.set(release.scope.tenantId, next);
    return { created: true, definition: clone(stored) };
  }

  /** Schedules one test-only outbox insertion failure before authoritative state replacement. */
  failNextPublicationIntent(kind: ReplayDefinitionPublicationKind): void {
    this.failedIntentKinds.add(kind);
  }

  /** Returns isolated publication intents in deterministic event and aggregate order. */
  async publishedIntents(
    tenantId: string,
  ): Promise<readonly PublishedReplayDefinitionOutboxIntent[]> {
    const intents = this.tenants.get(tenantId)?.intents.values() ?? [];
    return clone([...intents].sort(compareIntents));
  }

  /** Removes one test-only intent so conformance can prove corruption is detected on retry. */
  removePublicationIntent(
    kind: ReplayDefinitionPublicationKind,
    tenantId: string,
    aggregateId: string,
  ): void {
    const current = this.tenants.get(tenantId);
    if (!current) return;
    const eventType =
      kind === "target_release" ? "replay.target-release.published" : "replay.plan.published";
    const next = copyTenantState(current);
    next.intents.delete(`${eventType}:${aggregateId}`);
    this.tenants.set(tenantId, next);
  }

  private throwInjectedIntentFailure(kind: ReplayDefinitionPublicationKind): void {
    if (!this.failedIntentKinds.delete(kind)) return;
    throw new Error(`Injected ${kind} replay definition publication intent failure`);
  }
}
