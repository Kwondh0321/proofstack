import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { type EvidenceScope, EvidenceScopeSchema } from "./evidence.js";
import {
  POLICY_EVALUATION_MANIFEST_SCHEMA_VERSION,
  type PolicyEvaluationManifestDefinition,
  PolicyEvaluationManifestDefinitionSchema,
  type PolicyEvaluationManifestPageDefinition,
  PolicyEvaluationManifestPageDefinitionSchema,
} from "./policy-evaluation-manifest.js";

export const POLICY_EVALUATION_MANIFEST_DOMAIN =
  "proofstack.policy-evaluation-manifest.v1" as const;
export const POLICY_EVALUATION_MANIFEST_PAGE_DOMAIN =
  "proofstack.policy-evaluation-manifest-page.v1" as const;
export const POLICY_EVALUATION_MANIFEST_ENCODING_VERSION =
  "proofstack.policy-evaluation-manifest-jcs.v1" as const;

const ManifestInputSchema = z
  .object({ definition: PolicyEvaluationManifestDefinitionSchema, scope: EvidenceScopeSchema })
  .strict();
const PageInputSchema = z
  .object({ definition: PolicyEvaluationManifestPageDefinitionSchema, scope: EvidenceScopeSchema })
  .strict();

export function encodePolicyEvaluationManifestDefinition(input: {
  readonly definition: PolicyEvaluationManifestDefinition;
  readonly scope: EvidenceScope;
}): Uint8Array {
  const parsed = ManifestInputSchema.parse(input);
  return encodeEvaluationCanonicalJson({
    ...parsed,
    definitionDomain: POLICY_EVALUATION_MANIFEST_DOMAIN,
    encodingVersion: POLICY_EVALUATION_MANIFEST_ENCODING_VERSION,
    schemaVersion: POLICY_EVALUATION_MANIFEST_SCHEMA_VERSION,
  });
}

export function encodePolicyEvaluationManifestPageDefinition(input: {
  readonly definition: PolicyEvaluationManifestPageDefinition;
  readonly scope: EvidenceScope;
}): Uint8Array {
  const parsed = PageInputSchema.parse(input);
  return encodeEvaluationCanonicalJson({
    ...parsed,
    definitionDomain: POLICY_EVALUATION_MANIFEST_PAGE_DOMAIN,
    encodingVersion: POLICY_EVALUATION_MANIFEST_ENCODING_VERSION,
    schemaVersion: POLICY_EVALUATION_MANIFEST_SCHEMA_VERSION,
  });
}
