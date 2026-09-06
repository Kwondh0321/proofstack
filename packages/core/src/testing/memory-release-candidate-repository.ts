import type { EvidenceScope, ReleaseCandidate } from "@proofstack/contracts";
import {
  ReleaseCandidateLineageError,
  ReleaseCandidateResourceConflictError,
  ReleaseCandidateVersionConflictError,
} from "../release/release-candidate-errors.js";
import { validateReleaseCandidateRecord } from "../release/release-candidate-record-validation.js";
import type {
  PublishReleaseCandidateResult,
  ReleaseCandidateRepository,
} from "../release/release-candidate-repository.js";

interface TenantState {
  readonly records: Map<string, ReleaseCandidate>;
  readonly resources: Map<string, EvidenceScope>;
}

function emptyTenantState(): TenantState {
  return { records: new Map(), resources: new Map() };
}

function copyTenantState(state: TenantState): TenantState {
  return { records: new Map(state.records), resources: new Map(state.resources) };
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

/** Exact-scope, immutable in-memory implementation of the release candidate repository port. */
export class MemoryReleaseCandidateRepository implements ReleaseCandidateRepository {
  private readonly tenants = new Map<string, TenantState>();

  async findReleaseCandidate(
    scope: EvidenceScope,
    candidateVersionId: string,
  ): Promise<ReleaseCandidate | null> {
    const candidate = this.tenants.get(scope.tenantId)?.records.get(candidateVersionId);
    if (!candidate || !scopesEqual(candidate.scope, scope)) return null;
    return clone(candidate);
  }

  async publishReleaseCandidate(
    candidate: ReleaseCandidate,
  ): Promise<PublishReleaseCandidateResult> {
    const validated = validateReleaseCandidateRecord(candidate);
    const current = this.tenants.get(validated.scope.tenantId) ?? emptyTenantState();
    const existing = current.records.get(validated.candidateVersionId);
    if (existing) {
      if (existing.definitionSha256 !== validated.definitionSha256) {
        throw new ReleaseCandidateVersionConflictError(validated.candidateVersionId);
      }
      return { candidate: clone(existing), created: false };
    }

    const boundScope = current.resources.get(validated.candidateId);
    if (boundScope && !scopesEqual(boundScope, validated.scope)) {
      throw new ReleaseCandidateResourceConflictError(validated.candidateId);
    }

    if (validated.predecessor) {
      const predecessor = current.records.get(validated.predecessor.candidateVersionId);
      if (
        !predecessor ||
        !scopesEqual(predecessor.scope, validated.scope) ||
        predecessor.candidateId !== validated.predecessor.candidateId ||
        predecessor.definitionSha256 !== validated.predecessor.definitionSha256
      ) {
        throw new ReleaseCandidateLineageError(
          validated.candidateVersionId,
          validated.predecessor.candidateVersionId,
        );
      }
    }

    const next = copyTenantState(current);
    const stored = clone(validated);
    next.records.set(stored.candidateVersionId, stored);
    next.resources.set(stored.candidateId, clone(stored.scope));
    this.tenants.set(stored.scope.tenantId, next);
    return { candidate: clone(stored), created: true };
  }
}
