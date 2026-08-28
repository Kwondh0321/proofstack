import type { EvidenceEnvelope, EvidenceScope } from "@proofstack/contracts";
import { EvidenceConflictError } from "../errors.js";
import type { AppendEvidenceResult, EvidenceRepository } from "../evidence/evidence-repository.js";

function evidenceKey(envelope: EvidenceEnvelope): string {
  return `${envelope.scope.tenantId}:${envelope.evidence.eventId}`;
}

function isSameEvidence(left: EvidenceEnvelope, right: EvidenceEnvelope): boolean {
  return JSON.stringify(left.evidence) === JSON.stringify(right.evidence);
}

function matchesScope(envelope: EvidenceEnvelope, scope: EvidenceScope): boolean {
  return (
    envelope.scope.tenantId === scope.tenantId &&
    envelope.scope.projectId === scope.projectId &&
    envelope.scope.environmentId === scope.environmentId
  );
}

export class MemoryEvidenceRepository implements EvidenceRepository {
  private readonly events = new Map<string, EvidenceEnvelope>();

  async append(envelopes: readonly EvidenceEnvelope[]): Promise<AppendEvidenceResult> {
    const acceptedEventIds: string[] = [];
    const duplicateEventIds: string[] = [];
    const pending = new Map<string, EvidenceEnvelope>();

    for (const envelope of envelopes) {
      const key = evidenceKey(envelope);
      const existing = pending.get(key) ?? this.events.get(key);

      if (!existing) {
        pending.set(key, envelope);
        acceptedEventIds.push(envelope.evidence.eventId);
        continue;
      }

      if (!isSameEvidence(existing, envelope)) {
        throw new EvidenceConflictError(envelope.evidence.eventId);
      }

      duplicateEventIds.push(envelope.evidence.eventId);
    }

    for (const [key, envelope] of pending) {
      this.events.set(key, envelope);
    }

    return { acceptedEventIds, duplicateEventIds };
  }

  async listByTrace(scope: EvidenceScope, traceId: string): Promise<readonly EvidenceEnvelope[]> {
    return [...this.events.values()]
      .filter((envelope) => matchesScope(envelope, scope) && envelope.evidence.traceId === traceId)
      .sort((left, right) => {
        const timeDifference =
          Date.parse(left.evidence.startedAt) - Date.parse(right.evidence.startedAt);
        if (timeDifference !== 0) return timeDifference;
        return (left.evidence.sequence ?? 0) - (right.evidence.sequence ?? 0);
      });
  }
}
