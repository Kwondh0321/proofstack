import type { EvidenceScope, ReleaseCandidate } from "@proofstack/contracts";
import { EvidenceScopeSchema, OpaqueIdSchema } from "@proofstack/contracts";
import {
  ReleaseCandidateLineageError,
  ReleaseCandidateRepositoryContractError,
  ReleaseCandidateResourceConflictError,
  ReleaseCandidateVersionConflictError,
} from "../release/release-candidate-errors.js";
import { validateReleaseCandidateRecord } from "../release/release-candidate-record-validation.js";
import type {
  PublishReleaseCandidateResult,
  ReleaseCandidateLogicalRootReader,
  ReleaseCandidateRepository,
} from "../release/release-candidate-repository.js";

interface TenantState {
  readonly records: Map<string, ReleaseCandidate>;
  readonly resources: Map<string, ReleaseCandidate>;
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
export class MemoryReleaseCandidateRepository
  implements ReleaseCandidateRepository, ReleaseCandidateLogicalRootReader
{
  private readonly tenants = new Map<string, TenantState>();

  /** Independent exact records and logical roots; no shared mutation handle escapes its owner. */
  fork(): MemoryReleaseCandidateRepository {
    const next = new MemoryReleaseCandidateRepository();
    for (const [tenant, state] of this.tenants) next.tenants.set(tenant, structuredClone(state));
    return next;
  }

  async findReleaseCandidate(
    scope: EvidenceScope,
    candidateVersionId: string,
  ): Promise<ReleaseCandidate | null> {
    const candidate = this.tenants.get(scope.tenantId)?.records.get(candidateVersionId);
    if (!candidate || !scopesEqual(candidate.scope, scope)) return null;
    return clone(candidate);
  }

  async findReleaseCandidateLogicalRoot(
    scopeInput: EvidenceScope,
    candidateVersionIdInput: string,
  ): Promise<ReleaseCandidate | null> {
    const scope = EvidenceScopeSchema.parse(scopeInput);
    const candidateVersionId = OpaqueIdSchema.parse(candidateVersionIdInput);
    const state = this.tenants.get(scope.tenantId);
    const candidate = state?.records.get(candidateVersionId);
    if (!candidate || !scopesEqual(candidate.scope, scope)) return null;
    const root = state?.resources.get(candidate.candidateId);
    if (!root || !scopesEqual(root.scope, scope))
      throw new ReleaseCandidateRepositoryContractError(
        "Stored release candidate is missing its exact logical root",
      );
    try {
      const validated = validateReleaseCandidateRecord(root);
      if (validated.candidateId !== candidate.candidateId || validated.predecessor)
        throw new Error("Logical resource mismatch");
      return clone(validated);
    } catch {
      throw new ReleaseCandidateRepositoryContractError(
        "Stored release candidate logical root is invalid",
      );
    }
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

    const boundRoot = current.resources.get(validated.candidateId);
    if (boundRoot && !scopesEqual(boundRoot.scope, validated.scope)) {
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
    if (!next.resources.has(stored.candidateId)) next.resources.set(stored.candidateId, stored);
    this.tenants.set(stored.scope.tenantId, next);
    return { candidate: clone(stored), created: true };
  }
}
