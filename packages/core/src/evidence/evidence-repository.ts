import type { EvidenceEnvelope, EvidenceScope } from "@proofstack/contracts";

export interface AppendEvidenceResult {
  readonly acceptedEventIds: readonly string[];
  readonly duplicateEventIds: readonly string[];
}

export interface EvidencePageCursor {
  readonly eventId: string;
  readonly sequence: number;
  readonly startedAt: string;
}

export interface EvidencePageOptions {
  readonly after?: EvidencePageCursor;
  readonly limit: number;
}

export interface EvidencePage {
  readonly cursorFound: boolean;
  readonly events: readonly EvidenceEnvelope[];
  readonly hasMore: boolean;
}

export interface EvidenceRepository {
  append(envelopes: readonly EvidenceEnvelope[]): Promise<AppendEvidenceResult>;

  /**
   * Returns at most `options.limit` events in canonical trace order. `hasMore` means the page is
   * full and at least one additional matching event existed at the same read boundary.
   * `cursorFound` is always true for a cursorless read and may be false only when `after` was
   * supplied but that complete cursor was absent from the requested scope and trace.
   */
  listByTrace(
    scope: EvidenceScope,
    traceId: string,
    options: EvidencePageOptions,
  ): Promise<EvidencePage>;
}

/**
 * Exact immutable evidence read required by source-backed snapshots.
 *
 * Implementations return records in the caller's requested order only when every event exists in
 * the exact tenant, project, environment, and trace. Absence and out-of-scope records both return
 * `null`; partial results are forbidden. Callers must provide a bounded, unique list.
 */
export interface ExactEvidenceRepository extends EvidenceRepository {
  resolveExactEvents(
    scope: EvidenceScope,
    traceId: string,
    eventIds: readonly string[],
  ): Promise<readonly EvidenceEnvelope[] | null>;
}
