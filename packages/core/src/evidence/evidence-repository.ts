import type { EvidenceEnvelope, EvidenceScope } from "@proofstack/contracts";

export interface AppendEvidenceResult {
  readonly acceptedEventIds: readonly string[];
  readonly duplicateEventIds: readonly string[];
}

export interface EvidenceRepository {
  append(envelopes: readonly EvidenceEnvelope[]): Promise<AppendEvidenceResult>;
  listByTrace(scope: EvidenceScope, traceId: string): Promise<readonly EvidenceEnvelope[]>;
}
