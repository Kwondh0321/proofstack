import { z } from "zod";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { type EvidenceScope, EvidenceScopeSchema } from "./evidence.js";
import {
  POLICY_INSTALLATION_BINDING_SCHEMA_VERSION,
  type PolicyInstallationBindingDefinition,
  PolicyInstallationBindingDefinitionSchema,
  RELEASE_POLICY_SCHEMA_VERSION,
  type ReleasePolicyDefinition,
  ReleasePolicyDefinitionSchema,
} from "./release-policy.js";

export const POLICY_INSTALLATION_BINDING_DEFINITION_ENCODING_VERSION =
  "proofstack.policy-installation-binding-definition-jcs.v1" as const;
export const POLICY_INSTALLATION_BINDING_DEFINITION_DOMAIN =
  "proofstack.policy-installation-binding.v1" as const;
export const RELEASE_POLICY_DEFINITION_ENCODING_VERSION =
  "proofstack.release-policy-definition-jcs.v1" as const;
export const RELEASE_POLICY_DEFINITION_DOMAIN = "proofstack.release-policy.v1" as const;

export interface ScopedPolicyInstallationBindingDefinition {
  readonly definition: PolicyInstallationBindingDefinition;
  readonly scope: EvidenceScope;
}

export interface ScopedReleasePolicyDefinition {
  readonly definition: ReleasePolicyDefinition;
  readonly scope: EvidenceScope;
}

const ScopedPolicyInstallationBindingDefinitionSchema = z
  .object({
    definition: PolicyInstallationBindingDefinitionSchema,
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.definition.scope.tenantId !== value.scope.tenantId ||
      value.definition.scope.projectId !== value.scope.projectId ||
      value.definition.scope.environmentId !== value.scope.environmentId
    ) {
      context.addIssue({
        code: "custom",
        message: "Installation binding scope must equal its canonical digest scope",
        path: ["definition", "scope"],
      });
    }
  });

const ScopedReleasePolicyDefinitionSchema = z
  .object({
    definition: ReleasePolicyDefinitionSchema,
    scope: EvidenceScopeSchema,
  })
  .strict();

/** Encodes the complete operator-owned authority boundary without credentials or mutable locators. */
export function encodePolicyInstallationBindingDefinition(
  input: ScopedPolicyInstallationBindingDefinition,
): Uint8Array {
  const parsed = ScopedPolicyInstallationBindingDefinitionSchema.parse(input);
  return encodeEvaluationCanonicalJson({
    definition: parsed.definition,
    definitionDomain: POLICY_INSTALLATION_BINDING_DEFINITION_DOMAIN,
    encodingVersion: POLICY_INSTALLATION_BINDING_DEFINITION_ENCODING_VERSION,
    schemaVersion: POLICY_INSTALLATION_BINDING_SCHEMA_VERSION,
    scope: parsed.scope,
  });
}

/**
 * Encodes every semantic policy choice, including authority, applicability, sources, validity,
 * rule order, and future approval prerequisites. Publication metadata and outcomes are rejected by
 * the strict definition schema.
 */
export function encodeReleasePolicyDefinition(input: ScopedReleasePolicyDefinition): Uint8Array {
  const parsed = ScopedReleasePolicyDefinitionSchema.parse(input);
  return encodeEvaluationCanonicalJson({
    definition: parsed.definition,
    definitionDomain: RELEASE_POLICY_DEFINITION_DOMAIN,
    encodingVersion: RELEASE_POLICY_DEFINITION_ENCODING_VERSION,
    schemaVersion: RELEASE_POLICY_SCHEMA_VERSION,
    scope: parsed.scope,
  });
}
