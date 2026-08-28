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
  listByTrace(
    scope: EvidenceScope,
    traceId: string,
    options: EvidencePageOptions,
  ): Promise<EvidencePage>;
}
