import type { EvidenceScope } from "@proofstack/contracts";
import type { ReleaseCandidateSourceReference } from "./release-candidate-source-references.js";

export type ReleaseCandidateRevisionReference = Extract<
  ReleaseCandidateSourceReference,
  { readonly kind: "source_revision" }
>;
export type ReleaseCandidateRuntimeReference = Extract<
  ReleaseCandidateSourceReference,
  { readonly kind: "model_declaration" | "runtime_adapter" }
>;

/** Operator-owned exact reference authority; no publication, object, key or SQL port. */
export interface ReleaseCandidateRevisionAuthority {
  isAvailable(scope: EvidenceScope, reference: ReleaseCandidateRevisionReference): Promise<boolean>;
}

/** Declared model/adapter availability is distinct from loaded code or exact model evidence. */
export interface ReleaseCandidateRuntimeAuthority {
  isAvailable(scope: EvidenceScope, reference: ReleaseCandidateRuntimeReference): Promise<boolean>;
}
