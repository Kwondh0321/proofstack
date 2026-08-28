import {
  type EvidenceEnvelope,
  EvidenceEnvelopeSchema,
  type EvidenceScope,
  evidenceTimestampOrderKey,
} from "@proofstack/contracts";
import { EvidenceRepositoryContractError } from "../errors.js";
import type { EvidencePage, EvidenceRepository } from "./evidence-repository.js";

export interface ReadBoundedTraceSnapshotQuery {
  readonly maximumEvents: number;
  readonly scope: EvidenceScope;
  readonly traceId: string;
}

export type ReadBoundedTraceSnapshotResult =
  | {
      readonly events: readonly EvidenceEnvelope[];
      readonly status: "found";
    }
  | {
      readonly status: "not_found";
    }
  | {
      readonly maximumEvents: number;
      readonly status: "too_large";
    };

function matchesQuery(envelope: EvidenceEnvelope, scope: EvidenceScope, traceId: string): boolean {
  return (
    envelope.scope.tenantId === scope.tenantId &&
    envelope.scope.projectId === scope.projectId &&
    envelope.scope.environmentId === scope.environmentId &&
    envelope.evidence.traceId === traceId
  );
}

function invalidRepositoryPage(message: string, cause?: unknown): EvidenceRepositoryContractError {
  return new EvidenceRepositoryContractError(message, cause === undefined ? undefined : { cause });
}

function validateRepositoryEvents(input: unknown): readonly EvidenceEnvelope[] {
  try {
    if (!Array.isArray(input)) {
      throw invalidRepositoryPage("The evidence repository returned an invalid trace page");
    }
    return Array.from(input, (event) => {
      const parsed = EvidenceEnvelopeSchema.safeParse(event);
      if (!parsed.success) {
        throw invalidRepositoryPage(
          "The evidence repository returned an invalid trace event",
          parsed.error,
        );
      }
      return parsed.data;
    });
  } catch (cause) {
    if (cause instanceof EvidenceRepositoryContractError) throw cause;
    throw invalidRepositoryPage("The evidence repository returned an unreadable trace page", cause);
  }
}

function validateRepositoryPage(input: unknown): EvidencePage {
  if (typeof input !== "object" || input === null) {
    throw invalidRepositoryPage("The evidence repository returned an invalid trace page");
  }

  let cursorFound: unknown;
  let events: unknown;
  let hasMore: unknown;
  try {
    cursorFound = Reflect.get(input, "cursorFound");
    events = Reflect.get(input, "events");
    hasMore = Reflect.get(input, "hasMore");
  } catch (cause) {
    throw invalidRepositoryPage("The evidence repository returned an unreadable trace page", cause);
  }
  if (typeof cursorFound !== "boolean" || typeof hasMore !== "boolean") {
    throw invalidRepositoryPage("The evidence repository returned an invalid trace page");
  }
  return { cursorFound, events: validateRepositoryEvents(events), hasMore };
}

interface CanonicalEvidenceKey {
  readonly eventId: string;
  readonly sequence: number;
  readonly startedAt: bigint;
}

function canonicalEvidenceKey(envelope: EvidenceEnvelope): CanonicalEvidenceKey {
  return {
    eventId: envelope.evidence.eventId,
    sequence: envelope.evidence.sequence ?? 0,
    startedAt: evidenceTimestampOrderKey(envelope.evidence.startedAt),
  };
}

function compareCanonicalOrder(left: CanonicalEvidenceKey, right: CanonicalEvidenceKey): number {
  if (left.startedAt < right.startedAt) return -1;
  if (left.startedAt > right.startedAt) return 1;
  if (left.sequence < right.sequence) return -1;
  if (left.sequence > right.sequence) return 1;
  if (left.eventId === right.eventId) return 0;
  return left.eventId < right.eventId ? -1 : 1;
}

function assertCanonicalEvents(events: readonly EvidenceEnvelope[]): void {
  const eventIds = new Set<string>();
  let previousKey: CanonicalEvidenceKey | undefined;

  for (const event of events) {
    if (eventIds.has(event.evidence.eventId)) {
      throw new EvidenceRepositoryContractError(
        "The evidence repository returned a duplicate trace event",
      );
    }
    eventIds.add(event.evidence.eventId);

    let key: CanonicalEvidenceKey;
    try {
      key = canonicalEvidenceKey(event);
    } catch (error) {
      throw new EvidenceRepositoryContractError(
        "The evidence repository returned an invalid trace ordering key",
        { cause: error },
      );
    }
    if (previousKey && compareCanonicalOrder(previousKey, key) >= 0) {
      throw new EvidenceRepositoryContractError(
        "The evidence repository returned trace events outside canonical order",
      );
    }
    previousKey = key;
  }
}

/**
 * Reads one bounded, cursorless repository page so callers can freeze one observed trace view.
 * It never joins pages and never returns the partial prefix of an oversized trace.
 * This low-level primitive performs no authorization; callers must authorize and derive scope
 * before invoking it.
 */
export async function readBoundedTraceSnapshot(
  repository: EvidenceRepository,
  query: ReadBoundedTraceSnapshotQuery,
): Promise<ReadBoundedTraceSnapshotResult> {
  const maximumEvents = query.maximumEvents;
  if (!Number.isSafeInteger(maximumEvents) || maximumEvents < 1) {
    throw new RangeError("Trace snapshot limit must be a positive safe integer");
  }

  const expectedScope: EvidenceScope = {
    environmentId: query.scope.environmentId,
    projectId: query.scope.projectId,
    tenantId: query.scope.tenantId,
  };
  const traceId = query.traceId;
  const page = validateRepositoryPage(
    await repository.listByTrace({ ...expectedScope }, traceId, { limit: maximumEvents }),
  );
  if (!page.cursorFound) {
    throw new EvidenceRepositoryContractError(
      "The evidence repository rejected a cursorless trace read",
    );
  }
  if (page.events.length > maximumEvents) {
    throw new EvidenceRepositoryContractError(
      "The evidence repository returned more trace events than requested",
    );
  }
  if (page.hasMore && page.events.length !== maximumEvents) {
    throw new EvidenceRepositoryContractError(
      "The evidence repository reported more trace events after a short page",
    );
  }
  if (page.events.some((envelope) => !matchesQuery(envelope, expectedScope, traceId))) {
    throw new EvidenceRepositoryContractError(
      "The evidence repository returned an event outside the requested trace scope",
    );
  }
  assertCanonicalEvents(page.events);
  if (page.hasMore) return { maximumEvents, status: "too_large" };
  if (page.events.length === 0) return { status: "not_found" };
  return { events: page.events, status: "found" };
}
