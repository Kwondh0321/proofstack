import { readFileSync } from "node:fs";
import {
  POLICY_INSTALLATION_BINDING_SCHEMA_VERSION,
  type PolicyInstallationBinding,
  type PolicyInstallationBindingDefinition,
  RELEASE_POLICY_LIFECYCLE_SCHEMA_VERSION,
  RELEASE_POLICY_SCHEMA_VERSION,
  type ReleasePolicy,
  type ReleasePolicyDefinition,
  type ScopedPolicyInstallationBindingDefinition,
  type ScopedReleasePolicyDefinition,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  InvalidPolicyInstallationBindingInputError,
  InvalidReleasePolicyLifecycleInputError,
  InvalidReleasePolicyRecordInputError,
} from "./release-policy-errors.js";
import {
  digestPolicyInstallationBindingDefinition,
  digestReleasePolicyDefinition,
  releasePolicyReference,
  validatePolicyInstallationBindingRecord,
  validateReleasePolicyLifecycleEvent,
  validateReleasePolicyRecord,
} from "./release-policy-record-validation.js";

interface InstallationVector {
  readonly input: ScopedPolicyInstallationBindingDefinition;
  readonly kind: "policy_installation_binding";
  readonly sha256: string;
}

interface PolicyVector {
  readonly input: ScopedReleasePolicyDefinition;
  readonly kind: "release_policy";
  readonly sha256: string;
}

interface VectorDocument {
  readonly vectors: readonly [InstallationVector, PolicyVector];
}

const document = JSON.parse(
  readFileSync(
    new URL("../../../contracts/vectors/release-policy-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as VectorDocument;

function installationDefinition(): PolicyInstallationBindingDefinition {
  return structuredClone(document.vectors[0].input.definition);
}

function installation(): PolicyInstallationBinding {
  const vector = document.vectors[0];
  return {
    ...structuredClone(vector.input.definition),
    definitionSha256: vector.sha256,
    registeredAt: "2026-09-06T00:00:00.000Z",
    registeredByPrincipalId: "principal_operator",
    schemaVersion: POLICY_INSTALLATION_BINDING_SCHEMA_VERSION,
  };
}

function policyDefinition(): ReleasePolicyDefinition {
  return structuredClone(document.vectors[1].input.definition);
}

function policy(): ReleasePolicy {
  const vector = document.vectors[1];
  return {
    ...structuredClone(vector.input.definition),
    definitionSha256: vector.sha256,
    publishedAt: "2026-09-06T23:00:00.000Z",
    publishedByPrincipalId: vector.input.definition.issuerPrincipalId,
    schemaVersion: RELEASE_POLICY_SCHEMA_VERSION,
    scope: structuredClone(vector.input.scope),
  };
}

describe("release policy record validation", () => {
  it("matches the fixed public digests for installation authority and policy semantics", () => {
    const [installationVector, policyVector] = document.vectors;
    expect(
      digestPolicyInstallationBindingDefinition(
        installationVector.input.scope,
        installationDefinition(),
      ),
    ).toBe(installationVector.sha256);
    expect(digestReleasePolicyDefinition(policyVector.input.scope, policyDefinition())).toBe(
      policyVector.sha256,
    );
  });

  it("accepts exact records and returns the digest-bearing policy reference", () => {
    const binding = installation();
    const releasePolicy = policy();
    expect(validatePolicyInstallationBindingRecord(binding)).toEqual(binding);
    expect(validateReleasePolicyRecord(releasePolicy)).toEqual(releasePolicy);
    expect(releasePolicyReference(releasePolicy)).toEqual({
      definitionSha256: releasePolicy.definitionSha256,
      policyId: releasePolicy.policyId,
      policyVersionId: releasePolicy.policyVersionId,
    });
  });

  it("excludes server receipt fields while binding every semantic and scope field", () => {
    const binding = installation();
    const changedBindingReceipt = {
      ...binding,
      registeredAt: "2026-09-06T00:00:01.000Z",
      registeredByPrincipalId: "principal_operator_retry",
    };
    expect(validatePolicyInstallationBindingRecord(changedBindingReceipt)).toEqual(
      changedBindingReceipt,
    );

    const releasePolicy = policy();
    const changedPolicyReceipt = {
      ...releasePolicy,
      publishedAt: "2026-09-06T23:00:01.000Z",
    };
    expect(validateReleasePolicyRecord(changedPolicyReceipt)).toEqual(changedPolicyReceipt);

    const changedSemantics = structuredClone(releasePolicy);
    changedSemantics.mode = "advisory";
    expect(() => validateReleasePolicyRecord(changedSemantics)).toThrow(
      /invalid canonical definition digest/,
    );

    const changedScope = structuredClone(releasePolicy);
    changedScope.scope.environmentId = "env_production";
    expect(() => validateReleasePolicyRecord(changedScope)).toThrow(
      /invalid canonical definition digest/,
    );

    const changedAuthority = structuredClone(binding);
    changedAuthority.authorityEvidence.sha256 = "0".repeat(64);
    expect(() => validatePolicyInstallationBindingRecord(changedAuthority)).toThrow(
      /invalid canonical definition digest/,
    );
  });

  it("rejects forged or metadata-smuggling records with stable domain errors", () => {
    const binding = installation();
    const releasePolicy = policy();
    for (const invalid of [
      { ...binding, definitionSha256: "0".repeat(64) },
      { ...binding, registryUrl: "https://mutable.example/policy.json" },
      { ...binding, secret: "credential" },
    ]) {
      expect(() => validatePolicyInstallationBindingRecord(invalid)).toThrow(
        InvalidPolicyInstallationBindingInputError,
      );
    }
    for (const invalid of [
      { ...releasePolicy, approval: "approved" },
      { ...releasePolicy, definitionSha256: "0".repeat(64) },
      { ...releasePolicy, deploymentToken: "secret" },
      { ...releasePolicy, releaseDecision: "proceed" },
    ]) {
      expect(() => validateReleasePolicyRecord(invalid)).toThrow(
        InvalidReleasePolicyRecordInputError,
      );
    }
  });

  it("rejects receipt fields passed into either canonical definition boundary", () => {
    const binding = installation();
    const releasePolicy = policy();
    expect(() =>
      digestPolicyInstallationBindingDefinition(binding.scope, {
        ...binding,
        definitionSha256: binding.definitionSha256,
      } as never),
    ).toThrow();
    expect(() =>
      digestReleasePolicyDefinition(releasePolicy.scope, {
        ...releasePolicy,
        definitionSha256: releasePolicy.definitionSha256,
      } as never),
    ).toThrow();
  });

  it("strict-parses lifecycle history under a dedicated stable error", () => {
    const releasePolicy = policy();
    const event = {
      actorPrincipalId: releasePolicy.issuerPrincipalId,
      eventId: "policy_lifecycle_event_v1",
      kind: "withdrawn" as const,
      occurredAt: "2026-10-01T00:00:00.000Z",
      policy: releasePolicyReference(releasePolicy),
      reason: "The release policy is no longer authorized for new decisions.",
      schemaVersion: RELEASE_POLICY_LIFECYCLE_SCHEMA_VERSION,
      scope: releasePolicy.scope,
    };
    expect(validateReleasePolicyLifecycleEvent(event)).toEqual(event);
    expect(() =>
      validateReleasePolicyLifecycleEvent({ ...event, deploymentStatus: "blocked" }),
    ).toThrow(InvalidReleasePolicyLifecycleInputError);
  });
});
