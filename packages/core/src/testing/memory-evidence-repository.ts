import type { EvidenceEnvelope, EvidenceScope } from "@proofstack/contracts";
import { EvidenceConflictError } from "../errors.js";
import type {
  AppendEvidenceResult,
  EvidencePage,
  EvidencePageCursor,
  EvidencePageOptions,
  EvidenceRepository,
} from "../evidence/evidence-repository.js";

function evidenceKey(envelope: EvidenceEnvelope): string {
  return `${envelope.scope.tenantId}:${envelope.evidence.eventId}`;
}

function isJsonEquivalent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => isJsonEquivalent(value, right[index]));
  }

  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && isJsonEquivalent(leftRecord[key], rightRecord[key]),
    )
  );
}

function isSameEnvelope(left: EvidenceEnvelope, right: EvidenceEnvelope): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    isJsonEquivalent(left.scope, right.scope) &&
    isJsonEquivalent(left.evidence, right.evidence)
  );
}

function matchesScope(envelope: EvidenceEnvelope, scope: EvidenceScope): boolean {
  return (
    envelope.scope.tenantId === scope.tenantId &&
    envelope.scope.projectId === scope.projectId &&
    envelope.scope.environmentId === scope.environmentId
  );
}

function evidenceCursor(envelope: EvidenceEnvelope): EvidencePageCursor {
  return {
    eventId: envelope.evidence.eventId,
    sequence: envelope.evidence.sequence ?? 0,
    startedAt: envelope.evidence.startedAt,
  };
}

function matchesCursor(envelope: EvidenceEnvelope, cursor: EvidencePageCursor): boolean {
  const candidate = evidenceCursor(envelope);
  return (
    candidate.eventId === cursor.eventId &&
    candidate.sequence === cursor.sequence &&
    candidate.startedAt === cursor.startedAt
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

      if (!isSameEnvelope(existing, envelope)) {
        throw new EvidenceConflictError(envelope.evidence.eventId);
      }

      duplicateEventIds.push(envelope.evidence.eventId);
    }

    for (const [key, envelope] of pending) {
      this.events.set(key, envelope);
    }

    return { acceptedEventIds, duplicateEventIds };
  }

  async listByTrace(
    scope: EvidenceScope,
    traceId: string,
    options: EvidencePageOptions,
  ): Promise<EvidencePage> {
    const ordered = [...this.events.values()]
      .filter((envelope) => matchesScope(envelope, scope) && envelope.evidence.traceId === traceId)
      .sort((left, right) => {
        const timeDifference =
          Date.parse(left.evidence.startedAt) - Date.parse(right.evidence.startedAt);
        if (timeDifference !== 0) return timeDifference;
        const sequenceDifference = (left.evidence.sequence ?? 0) - (right.evidence.sequence ?? 0);
        if (sequenceDifference !== 0) return sequenceDifference;
        if (left.evidence.eventId === right.evidence.eventId) return 0;
        return left.evidence.eventId < right.evidence.eventId ? -1 : 1;
      });

    const after = options.after;
    const cursorIndex = after
      ? ordered.findIndex((envelope) => matchesCursor(envelope, after))
      : -1;
    if (after && cursorIndex === -1) {
      return { cursorFound: false, events: [], hasMore: false };
    }

    const window = ordered.slice(cursorIndex + 1, cursorIndex + 1 + options.limit + 1);
    return {
      cursorFound: true,
      events: window.slice(0, options.limit),
      hasMore: window.length > options.limit,
    };
  }
}
