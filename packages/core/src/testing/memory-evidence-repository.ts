import {
  type EvidenceEnvelope,
  type EvidenceScope,
  evidenceTimestampOrderKey,
} from "@proofstack/contracts";
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

function cloneForJsonStorage<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Evidence must be JSON serializable");
  return JSON.parse(serialized) as T;
}

function isJsonEquivalent(left: unknown, right: unknown): boolean {
  if (left === right) return true;

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
    evidenceTimestampOrderKey(candidate.startedAt) === evidenceTimestampOrderKey(cursor.startedAt)
  );
}

export class MemoryEvidenceRepository implements EvidenceRepository {
  private readonly events = new Map<string, EvidenceEnvelope>();

  async append(envelopes: readonly EvidenceEnvelope[]): Promise<AppendEvidenceResult> {
    const acceptedEventIds: string[] = [];
    const duplicateEventIds: string[] = [];
    const pending = new Map<string, EvidenceEnvelope>();

    for (const envelope of envelopes) {
      const ownedEnvelope = cloneForJsonStorage(envelope);
      const key = evidenceKey(ownedEnvelope);
      const existing = pending.get(key) ?? this.events.get(key);

      if (!existing) {
        pending.set(key, ownedEnvelope);
        acceptedEventIds.push(ownedEnvelope.evidence.eventId);
        continue;
      }

      if (!isSameEnvelope(existing, ownedEnvelope)) {
        throw new EvidenceConflictError(ownedEnvelope.evidence.eventId);
      }

      duplicateEventIds.push(ownedEnvelope.evidence.eventId);
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
      .map((envelope) => ({
        envelope,
        startedAtOrderKey: evidenceTimestampOrderKey(envelope.evidence.startedAt),
      }))
      .sort((left, right) => {
        if (left.startedAtOrderKey < right.startedAtOrderKey) return -1;
        if (left.startedAtOrderKey > right.startedAtOrderKey) return 1;
        const sequenceDifference =
          (left.envelope.evidence.sequence ?? 0) - (right.envelope.evidence.sequence ?? 0);
        if (sequenceDifference !== 0) return sequenceDifference;
        if (left.envelope.evidence.eventId === right.envelope.evidence.eventId) return 0;
        return left.envelope.evidence.eventId < right.envelope.evidence.eventId ? -1 : 1;
      })
      .map(({ envelope }) => envelope);

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
      events: window.slice(0, options.limit).map((envelope) => cloneForJsonStorage(envelope)),
      hasMore: window.length > options.limit,
    };
  }
}
