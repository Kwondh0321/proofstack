import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { type EvidenceScope, EvidenceScopeSchema } from "./evidence.js";
import {
  RELEASE_CANDIDATE_SCHEMA_VERSION,
  type ReleaseCandidateDefinition,
  ReleaseCandidateDefinitionSchema,
} from "./release-candidate.js";

export const RELEASE_CANDIDATE_DEFINITION_ENCODING_VERSION =
  "proofstack.release-candidate-definition-jcs.v1" as const;
export const RELEASE_CANDIDATE_DEFINITION_DOMAIN = "proofstack.release-candidate.v1" as const;

export interface ScopedReleaseCandidateDefinition {
  readonly definition: ReleaseCandidateDefinition;
  readonly scope: EvidenceScope;
}

const ScopedReleaseCandidateDefinitionSchema = z
  .object({
    definition: ReleaseCandidateDefinitionSchema,
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.definition.target.environmentId !== value.scope.environmentId) {
      context.addIssue({
        code: "custom",
        message: "Candidate target environment must equal its digest scope",
        path: ["definition", "target", "environmentId"],
      });
    }
  });

/**
 * Produces the exact bytes covered by a release candidate's definitionSha256. Server publication
 * metadata and all policy, decision, approval, credential, and deployment fields are outside this
 * boundary and are rejected by the strict input schema.
 */
export function encodeReleaseCandidateDefinition(
  input: ScopedReleaseCandidateDefinition,
): Uint8Array {
  const parsed = ScopedReleaseCandidateDefinitionSchema.parse(input);
  return encodeEvaluationCanonicalJson({
    definition: parsed.definition,
    definitionDomain: RELEASE_CANDIDATE_DEFINITION_DOMAIN,
    encodingVersion: RELEASE_CANDIDATE_DEFINITION_ENCODING_VERSION,
    schemaVersion: RELEASE_CANDIDATE_SCHEMA_VERSION,
    scope: parsed.scope,
  });
}
