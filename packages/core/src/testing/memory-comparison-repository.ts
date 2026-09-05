import type {
  ComparisonDefinition,
  ComparisonEvidenceSnapshot,
  ComparisonResult,
  EvidenceScope,
} from "@proofstack/contracts";
import {
  comparisonRecordId,
  comparisonRecordReferences,
  comparisonResourceId,
  validateComparisonRecord,
} from "../evaluation/comparison-record-validation.js";
import {
  ComparisonLineageError,
  ComparisonRecordConflictError,
  ComparisonResourceConflictError,
} from "../evaluation/comparison-repository-errors.js";
import type {
  ComparisonRecord,
  ComparisonRecordKind,
  ComparisonRepository,
  PublishComparisonRecordResult,
} from "../evaluation/comparison-repository.js";

interface TenantState {
  readonly records: Map<string, ComparisonRecord>;
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

function recordKey(kind: ComparisonRecordKind, recordId: string): string {
  return `${kind}:${recordId}`;
}

function assertSemanticLineage(
  kind: ComparisonRecordKind,
  record: ComparisonRecord,
  referenced: readonly ComparisonRecord[],
): void {
  if (kind === "comparison_definition") {
    const definition = record as ComparisonDefinition;
    if (
      definition.predecessor &&
      (referenced[0] as ComparisonDefinition | undefined)?.comparisonId !== definition.comparisonId
    ) {
      throw new ComparisonLineageError(
        kind,
        definition.comparisonVersionId,
        "comparison_definition",
        definition.predecessor.comparisonVersionId,
      );
    }
    return;
  }

  const definition = referenced[0] as ComparisonDefinition | undefined;
  if (kind === "comparison_evidence_snapshot") {
    const snapshot = record as ComparisonEvidenceSnapshot;
    if (!definition || snapshot.comparison.comparisonId !== definition.comparisonId) {
      throw new ComparisonLineageError(
        kind,
        snapshot.snapshotId,
        "comparison_definition",
        snapshot.comparison.comparisonVersionId,
      );
    }
    return;
  }

  const result = record as ComparisonResult;
  const baseline = referenced[1] as ComparisonEvidenceSnapshot | undefined;
  const candidate = referenced[2] as ComparisonEvidenceSnapshot | undefined;
  const expectedComparison = result.comparison;
  if (!definition || expectedComparison.comparisonId !== definition.comparisonId) {
    throw new ComparisonLineageError(
      kind,
      result.resultId,
      "comparison_definition",
      expectedComparison.comparisonVersionId,
    );
  }
  if (
    baseline?.role !== "baseline" ||
    baseline.comparison.comparisonId !== expectedComparison.comparisonId ||
    baseline.comparison.comparisonVersionId !== expectedComparison.comparisonVersionId ||
    baseline.comparison.definitionSha256 !== expectedComparison.definitionSha256
  ) {
    throw new ComparisonLineageError(
      kind,
      result.resultId,
      "comparison_evidence_snapshot",
      result.baselineSnapshot.snapshotId,
    );
  }
  if (
    candidate?.role !== "candidate" ||
    candidate.comparison.comparisonId !== expectedComparison.comparisonId ||
    candidate.comparison.comparisonVersionId !== expectedComparison.comparisonVersionId ||
    candidate.comparison.definitionSha256 !== expectedComparison.definitionSha256
  ) {
    throw new ComparisonLineageError(
      kind,
      result.resultId,
      "comparison_evidence_snapshot",
      result.candidateSnapshot.snapshotId,
    );
  }
}

/** Exact-scope, immutable in-memory implementation of the comparison repository port. */
export class MemoryComparisonRepository implements ComparisonRepository {
  private readonly tenants = new Map<string, TenantState>();

  private async find<RecordType>(
    kind: ComparisonRecordKind,
    scope: EvidenceScope,
    recordId: string,
  ): Promise<RecordType | null> {
    const record = this.tenants.get(scope.tenantId)?.records.get(recordKey(kind, recordId));
    if (!record || !scopesEqual(record.scope, scope)) return null;
    return clone(record) as RecordType;
  }

  private async publish<RecordType extends ComparisonRecord>(
    kind: ComparisonRecordKind,
    candidate: RecordType,
  ): Promise<PublishComparisonRecordResult<RecordType>> {
    const validated = validateComparisonRecord(kind, candidate) as RecordType;
    const id = comparisonRecordId(kind, validated);
    const current = this.tenants.get(validated.scope.tenantId) ?? emptyTenantState();
    const existing = current.records.get(recordKey(kind, id));
    if (existing) {
      if (existing.definitionSha256 !== validated.definitionSha256) {
        throw new ComparisonRecordConflictError(kind, id);
      }
      return { created: false, record: clone(existing) as RecordType };
    }

    const resourceId = comparisonResourceId(kind, validated);
    if (resourceId) {
      const boundScope = current.resources.get(resourceId);
      if (boundScope && !scopesEqual(boundScope, validated.scope)) {
        throw new ComparisonResourceConflictError(resourceId);
      }
    }

    const referenced: ComparisonRecord[] = [];
    for (const reference of comparisonRecordReferences(kind, validated)) {
      const stored = current.records.get(recordKey(reference.recordKind, reference.recordId));
      if (
        !stored ||
        !scopesEqual(stored.scope, validated.scope) ||
        stored.definitionSha256 !== reference.definitionSha256
      ) {
        throw new ComparisonLineageError(kind, id, reference.recordKind, reference.recordId);
      }
      referenced.push(stored);
    }
    assertSemanticLineage(kind, validated, referenced);

    const next = copyTenantState(current);
    const stored = clone(validated);
    next.records.set(recordKey(kind, id), stored);
    if (resourceId) next.resources.set(resourceId, clone(validated.scope));
    this.tenants.set(validated.scope.tenantId, next);
    return { created: true, record: clone(stored) as RecordType };
  }

  async findComparisonDefinition(scope: EvidenceScope, id: string) {
    return this.find<ComparisonDefinition>("comparison_definition", scope, id);
  }

  async findComparisonEvidenceSnapshot(scope: EvidenceScope, id: string) {
    return this.find<ComparisonEvidenceSnapshot>("comparison_evidence_snapshot", scope, id);
  }

  async findComparisonResult(scope: EvidenceScope, id: string) {
    return this.find<ComparisonResult>("comparison_result", scope, id);
  }

  async publishComparisonDefinition(candidate: ComparisonDefinition) {
    return this.publish("comparison_definition", candidate);
  }

  async publishComparisonEvidenceSnapshot(candidate: ComparisonEvidenceSnapshot) {
    return this.publish("comparison_evidence_snapshot", candidate);
  }

  async publishComparisonResult(candidate: ComparisonResult) {
    return this.publish("comparison_result", candidate);
  }
}
