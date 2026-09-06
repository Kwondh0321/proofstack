import { isDeepStrictEqual } from "node:util";
import {
  type EvidenceScope,
  evidenceTimestampOrderKey,
  type ReleasePolicy,
  type ReleasePolicyLifecycleEvent,
  type ReleasePolicyReference,
} from "@proofstack/contracts";
import {
  InvalidReleasePolicyLifecycleInputError,
  ReleasePolicyLifecycleEventConflictError,
  ReleasePolicyLifecycleStateConflictError,
  ReleasePolicyLineageError,
  ReleasePolicyResourceConflictError,
  ReleasePolicyVersionConflictError,
} from "../policy/release-policy-errors.js";
import {
  releasePolicyReference,
  validateReleasePolicyLifecycleEvent,
  validateReleasePolicyRecord,
} from "../policy/release-policy-record-validation.js";
import type {
  PublishReleasePolicyLifecycleResult,
  PublishReleasePolicyResult,
  ReleasePolicyRepository,
} from "../policy/release-policy-repository.js";

interface TenantState {
  readonly events: Map<string, ReleasePolicyLifecycleEvent>;
  readonly policies: Map<string, ReleasePolicy>;
  readonly resources: Map<string, EvidenceScope>;
}

function emptyTenantState(): TenantState {
  return { events: new Map(), policies: new Map(), resources: new Map() };
}

function copyTenantState(state: TenantState): TenantState {
  return {
    events: new Map(state.events),
    policies: new Map(state.policies),
    resources: new Map(state.resources),
  };
}

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function scopesEqual(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function referencesEqual(left: ReleasePolicyReference, right: ReleasePolicyReference): boolean {
  return (
    left.policyId === right.policyId &&
    left.policyVersionId === right.policyVersionId &&
    left.definitionSha256 === right.definitionSha256
  );
}

function policyDefinition(policy: ReleasePolicy): unknown {
  const definition = clone(policy) as unknown as Record<string, unknown>;
  for (const key of [
    "definitionSha256",
    "publishedAt",
    "publishedByPrincipalId",
    "schemaVersion",
    "scope",
  ]) {
    delete definition[key];
  }
  return definition;
}

function policiesHaveSameSemantics(left: ReleasePolicy, right: ReleasePolicy): boolean {
  return (
    scopesEqual(left.scope, right.scope) &&
    left.definitionSha256 === right.definitionSha256 &&
    isDeepStrictEqual(policyDefinition(left), policyDefinition(right))
  );
}

function lifecycleSemantics(event: ReleasePolicyLifecycleEvent): unknown {
  const semantics = clone(event) as unknown as Record<string, unknown>;
  for (const key of ["actorPrincipalId", "occurredAt", "schemaVersion"]) {
    delete semantics[key];
  }
  return semantics;
}

function eventsHaveSameSemantics(
  left: ReleasePolicyLifecycleEvent,
  right: ReleasePolicyLifecycleEvent,
): boolean {
  return isDeepStrictEqual(lifecycleSemantics(left), lifecycleSemantics(right));
}

function exactPolicy(
  state: TenantState,
  scope: EvidenceScope,
  reference: ReleasePolicyReference,
): ReleasePolicy | null {
  const policy = state.policies.get(reference.policyVersionId);
  if (
    !policy ||
    !scopesEqual(policy.scope, scope) ||
    !referencesEqual(releasePolicyReference(policy), reference)
  ) {
    return null;
  }
  return policy;
}

function assertLifecycleTimeline(
  event: ReleasePolicyLifecycleEvent,
  policy: ReleasePolicy,
  successor?: ReleasePolicy,
): void {
  const occurredAt = evidenceTimestampOrderKey(event.occurredAt);
  if (
    occurredAt < evidenceTimestampOrderKey(policy.publishedAt) ||
    (successor && occurredAt < evidenceTimestampOrderKey(successor.publishedAt))
  ) {
    throw new InvalidReleasePolicyLifecycleInputError(
      `Release policy lifecycle event ${event.eventId} predates an authoritative policy receipt`,
    );
  }
}

/**
 * In-memory conformance reference for the release policy repository contract.
 *
 * State changes are copy-on-write and each async method mutates synchronously before returning,
 * which makes competing publications linearizable within one JavaScript process. Production
 * deployments must use a durable transactional adapter with equivalent constraints.
 */
export class MemoryReleasePolicyRepository implements ReleasePolicyRepository {
  private readonly tenants = new Map<string, TenantState>();

  async findReleasePolicy(
    scope: EvidenceScope,
    policyVersionId: string,
  ): Promise<ReleasePolicy | null> {
    const policy = this.tenants.get(scope.tenantId)?.policies.get(policyVersionId);
    if (!policy || !scopesEqual(policy.scope, scope)) return null;
    return clone(policy);
  }

  async findReleasePolicyLifecycleEvent(
    scope: EvidenceScope,
    eventId: string,
  ): Promise<ReleasePolicyLifecycleEvent | null> {
    const event = this.tenants.get(scope.tenantId)?.events.get(eventId);
    if (!event || !scopesEqual(event.scope, scope)) return null;
    return clone(event);
  }

  async listReleasePolicyLifecycleEvents(
    scope: EvidenceScope,
    policyVersionId: string,
  ): Promise<readonly ReleasePolicyLifecycleEvent[]> {
    return [...(this.tenants.get(scope.tenantId)?.events.values() ?? [])]
      .filter(
        (event) =>
          scopesEqual(event.scope, scope) && event.policy.policyVersionId === policyVersionId,
      )
      .sort((left, right) => {
        const leftTime = evidenceTimestampOrderKey(left.occurredAt);
        const rightTime = evidenceTimestampOrderKey(right.occurredAt);
        return leftTime < rightTime
          ? -1
          : leftTime > rightTime
            ? 1
            : left.eventId.localeCompare(right.eventId);
      })
      .map(clone);
  }

  async publishReleasePolicy(policy: ReleasePolicy): Promise<PublishReleasePolicyResult> {
    const validated = validateReleasePolicyRecord(policy);
    const current = this.tenants.get(validated.scope.tenantId) ?? emptyTenantState();
    const existing = current.policies.get(validated.policyVersionId);
    if (existing) {
      if (!policiesHaveSameSemantics(existing, validated)) {
        throw new ReleasePolicyVersionConflictError(validated.policyVersionId);
      }
      return { created: false, policy: clone(existing) };
    }

    const boundScope = current.resources.get(validated.policyId);
    if (boundScope && !scopesEqual(boundScope, validated.scope)) {
      throw new ReleasePolicyResourceConflictError(validated.policyId);
    }

    if (validated.predecessor && !exactPolicy(current, validated.scope, validated.predecessor)) {
      throw new ReleasePolicyLineageError(
        validated.policyVersionId,
        validated.predecessor.policyVersionId,
      );
    }

    const next = copyTenantState(current);
    const stored = clone(validated);
    next.policies.set(stored.policyVersionId, stored);
    next.resources.set(stored.policyId, clone(stored.scope));
    this.tenants.set(stored.scope.tenantId, next);
    return { created: true, policy: clone(stored) };
  }

  async publishReleasePolicyLifecycleEvent(
    event: ReleasePolicyLifecycleEvent,
  ): Promise<PublishReleasePolicyLifecycleResult> {
    const validated = validateReleasePolicyLifecycleEvent(event);
    const current = this.tenants.get(validated.scope.tenantId) ?? emptyTenantState();
    const existing = current.events.get(validated.eventId);
    if (existing) {
      if (!eventsHaveSameSemantics(existing, validated)) {
        throw new ReleasePolicyLifecycleEventConflictError(validated.eventId);
      }
      return { created: false, event: clone(existing) };
    }

    const policy = exactPolicy(current, validated.scope, validated.policy);
    if (!policy) {
      throw new ReleasePolicyLineageError(
        validated.policy.policyVersionId,
        validated.policy.policyVersionId,
      );
    }

    let successor: ReleasePolicy | undefined;
    if (validated.kind === "superseded") {
      successor = exactPolicy(current, validated.scope, validated.successor) ?? undefined;
      const predecessor = successor?.predecessor;
      if (!predecessor || !referencesEqual(predecessor, validated.policy)) {
        throw new ReleasePolicyLineageError(
          validated.policy.policyVersionId,
          validated.successor.policyVersionId,
        );
      }
    }

    assertLifecycleTimeline(validated, policy, successor);
    if (
      [...current.events.values()].some(
        (candidate) =>
          scopesEqual(candidate.scope, validated.scope) &&
          candidate.policy.policyVersionId === validated.policy.policyVersionId,
      )
    ) {
      throw new ReleasePolicyLifecycleStateConflictError(validated.policy.policyVersionId);
    }

    const next = copyTenantState(current);
    const stored = clone(validated);
    next.events.set(stored.eventId, stored);
    this.tenants.set(stored.scope.tenantId, next);
    return { created: true, event: clone(stored) };
  }
}
