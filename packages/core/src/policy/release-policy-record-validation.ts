import { createHash } from "node:crypto";
import {
  type EvidenceScope,
  encodePolicyInstallationBindingDefinition,
  encodeReleasePolicyDefinition,
  type PolicyInstallationBinding,
  type PolicyInstallationBindingDefinition,
  PolicyInstallationBindingSchema,
  type ReleasePolicy,
  type ReleasePolicyDefinition,
  type ReleasePolicyLifecycleEvent,
  ReleasePolicyLifecycleEventSchema,
  type ReleasePolicyReference,
  ReleasePolicySchema,
} from "@proofstack/contracts";
import {
  InvalidPolicyInstallationBindingInputError,
  InvalidReleasePolicyLifecycleInputError,
  InvalidReleasePolicyRecordInputError,
} from "./release-policy-errors.js";

const installationReceiptKeys = [
  "definitionSha256",
  "registeredAt",
  "registeredByPrincipalId",
  "schemaVersion",
] as const;

const policyReceiptKeys = [
  "definitionSha256",
  "publishedAt",
  "publishedByPrincipalId",
  "schemaVersion",
  "scope",
] as const;

function installationDefinitionOf(
  record: PolicyInstallationBinding,
): PolicyInstallationBindingDefinition {
  const definition = structuredClone(record) as unknown as Record<string, unknown>;
  for (const key of installationReceiptKeys) delete definition[key];
  return definition as unknown as PolicyInstallationBindingDefinition;
}

function policyDefinitionOf(record: ReleasePolicy): ReleasePolicyDefinition {
  const definition = structuredClone(record) as unknown as Record<string, unknown>;
  for (const key of policyReceiptKeys) delete definition[key];
  return definition as unknown as ReleasePolicyDefinition;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestPolicyInstallationBindingDefinition(
  scope: EvidenceScope,
  definition: PolicyInstallationBindingDefinition,
): string {
  return sha256(encodePolicyInstallationBindingDefinition({ definition, scope }));
}

export function digestReleasePolicyDefinition(
  scope: EvidenceScope,
  definition: ReleasePolicyDefinition,
): string {
  return sha256(encodeReleasePolicyDefinition({ definition, scope }));
}

/** Strict-parses and independently verifies one operator-owned installation authority record. */
export function validatePolicyInstallationBindingRecord(input: unknown): PolicyInstallationBinding {
  let parsed: PolicyInstallationBinding;
  let digest: string;
  try {
    parsed = PolicyInstallationBindingSchema.parse(input);
    digest = digestPolicyInstallationBindingDefinition(
      parsed.scope,
      installationDefinitionOf(parsed),
    );
  } catch (cause) {
    throw new InvalidPolicyInstallationBindingInputError(
      "Invalid policy installation binding record",
      { cause },
    );
  }
  if (digest !== parsed.definitionSha256) {
    throw new InvalidPolicyInstallationBindingInputError(
      `Policy installation binding ${parsed.bindingVersionId} has an invalid canonical definition digest`,
    );
  }
  return parsed;
}

/** Strict-parses and independently verifies one immutable release policy record. */
export function validateReleasePolicyRecord(input: unknown): ReleasePolicy {
  let parsed: ReleasePolicy;
  let digest: string;
  try {
    parsed = ReleasePolicySchema.parse(input);
    digest = digestReleasePolicyDefinition(parsed.scope, policyDefinitionOf(parsed));
  } catch (cause) {
    throw new InvalidReleasePolicyRecordInputError("Invalid release policy record", { cause });
  }
  if (digest !== parsed.definitionSha256) {
    throw new InvalidReleasePolicyRecordInputError(
      `Release policy ${parsed.policyVersionId} has an invalid canonical definition digest`,
    );
  }
  return parsed;
}

export function validateReleasePolicyLifecycleEvent(input: unknown): ReleasePolicyLifecycleEvent {
  try {
    return ReleasePolicyLifecycleEventSchema.parse(input);
  } catch (cause) {
    throw new InvalidReleasePolicyLifecycleInputError("Invalid release policy lifecycle event", {
      cause,
    });
  }
}

export function releasePolicyReference(policy: ReleasePolicy): ReleasePolicyReference {
  return {
    definitionSha256: policy.definitionSha256,
    policyId: policy.policyId,
    policyVersionId: policy.policyVersionId,
  };
}
