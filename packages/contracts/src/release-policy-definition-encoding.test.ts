import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  POLICY_INSTALLATION_BINDING_SCHEMA_VERSION,
  RELEASE_POLICY_SCHEMA_VERSION,
} from "./release-policy.js";
import {
  encodePolicyInstallationBindingDefinition,
  encodeReleasePolicyDefinition,
  POLICY_INSTALLATION_BINDING_DEFINITION_DOMAIN,
  POLICY_INSTALLATION_BINDING_DEFINITION_ENCODING_VERSION,
  RELEASE_POLICY_DEFINITION_DOMAIN,
  RELEASE_POLICY_DEFINITION_ENCODING_VERSION,
  type ScopedPolicyInstallationBindingDefinition,
  type ScopedReleasePolicyDefinition,
} from "./release-policy-definition-encoding.js";

interface InstallationBindingVector {
  readonly encodedByteLength: number;
  readonly input: ScopedPolicyInstallationBindingDefinition;
  readonly kind: "policy_installation_binding";
  readonly name: string;
  readonly sha256: string;
}

interface ReleasePolicyVector {
  readonly encodedByteLength: number;
  readonly input: ScopedReleasePolicyDefinition;
  readonly kind: "release_policy";
  readonly name: string;
  readonly sha256: string;
}

interface VectorDocument {
  readonly format: string;
  readonly vectors: readonly [InstallationBindingVector, ReleasePolicyVector];
}

const document = JSON.parse(
  readFileSync(new URL("../vectors/release-policy-definition-v1.json", import.meta.url), "utf8"),
) as VectorDocument;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("canonical release policy definition encoding", () => {
  it("matches fixed public UTF-8 and SHA-256 vectors", () => {
    expect(document.format).toBe("proofstack.release-policy-definition.v1");
    const [binding, policy] = document.vectors;
    expect(binding.kind).toBe("policy_installation_binding");
    expect(policy.kind).toBe("release_policy");

    const bindingBytes = encodePolicyInstallationBindingDefinition(binding.input);
    expect(bindingBytes.byteLength).toBe(binding.encodedByteLength);
    expect(sha256(bindingBytes)).toBe(binding.sha256);

    const policyBytes = encodeReleasePolicyDefinition(policy.input);
    expect(policyBytes.byteLength).toBe(policy.encodedByteLength);
    expect(sha256(policyBytes)).toBe(policy.sha256);
    expect(policy.input.definition.installationBinding.definitionSha256).toBe(binding.sha256);
  });

  it("domain-separates installation authority and policy semantics", () => {
    const [binding, policy] = document.vectors;
    const bindingText = Buffer.from(
      encodePolicyInstallationBindingDefinition(binding.input),
    ).toString("utf8");
    const policyText = Buffer.from(encodeReleasePolicyDefinition(policy.input)).toString("utf8");

    expect(bindingText).toContain(
      `"definitionDomain":"${POLICY_INSTALLATION_BINDING_DEFINITION_DOMAIN}"`,
    );
    expect(bindingText).toContain(
      `"encodingVersion":"${POLICY_INSTALLATION_BINDING_DEFINITION_ENCODING_VERSION}"`,
    );
    expect(bindingText).toContain(
      `"schemaVersion":"${POLICY_INSTALLATION_BINDING_SCHEMA_VERSION}"`,
    );
    expect(policyText).toContain(`"definitionDomain":"${RELEASE_POLICY_DEFINITION_DOMAIN}"`);
    expect(policyText).toContain(
      `"encodingVersion":"${RELEASE_POLICY_DEFINITION_ENCODING_VERSION}"`,
    );
    expect(policyText).toContain(`"schemaVersion":"${RELEASE_POLICY_SCHEMA_VERSION}"`);
    expect(policyText).toContain('"contentProjection":"references_and_bounded_metadata_only"');
  });

  it("normalizes insertion order while binding every semantic authority and policy field", () => {
    const [binding, policy] = document.vectors;
    const originalBinding = encodePolicyInstallationBindingDefinition(binding.input);
    const reorderedBinding = {
      definition: Object.fromEntries(Object.entries(binding.input.definition).reverse()),
      scope: Object.fromEntries(Object.entries(binding.input.scope).reverse()),
    } as unknown as ScopedPolicyInstallationBindingDefinition;
    expect(encodePolicyInstallationBindingDefinition(reorderedBinding)).toEqual(originalBinding);

    const originalPolicy = encodeReleasePolicyDefinition(policy.input);
    const reorderedPolicy = {
      definition: Object.fromEntries(Object.entries(policy.input.definition).reverse()),
      scope: Object.fromEntries(Object.entries(policy.input.scope).reverse()),
    } as unknown as ScopedReleasePolicyDefinition;
    expect(encodeReleasePolicyDefinition(reorderedPolicy)).toEqual(originalPolicy);

    const mutations: ((value: ScopedReleasePolicyDefinition) => void)[] = [
      (value) => {
        value.scope.tenantId = "tenant_other";
      },
      (value) => {
        value.definition.mode = "advisory";
      },
      (value) => {
        value.definition.applicability.taskKind = {
          operator: "equals",
          value: "support_agent",
        };
      },
      (value) => {
        const rule = value.definition.rules.find(
          ({ predicate }) => predicate.kind === "comparison_threshold",
        );
        if (rule?.predicate.kind !== "comparison_threshold") {
          throw new Error("Expected a comparison threshold rule");
        }
        rule.predicate.threshold = "1";
      },
      (value) => {
        value.definition.expiresAt = "2027-03-08T00:00:00.000Z";
      },
      (value) => {
        value.definition.knownLimitations = ["A changed limitation is part of policy meaning."];
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(policy.input);
      mutate(changed);
      expect(encodeReleasePolicyDefinition(changed)).not.toEqual(originalPolicy);
    }
  });

  it("rejects cross-scope authority and policy outcome or credential smuggling", () => {
    const [binding, policy] = document.vectors;
    expect(() =>
      encodePolicyInstallationBindingDefinition({
        ...binding.input,
        scope: { ...binding.input.scope, tenantId: "tenant_other" },
      }),
    ).toThrow(/digest scope/);

    for (const forbidden of [
      { approval: "approved" },
      { decision: "proceed" },
      { deploymentToken: "secret" },
      { evaluatedAt: "2026-09-07T00:00:00.000Z" },
      { exception: { granted: true } },
      { signature: "signed" },
    ]) {
      expect(() =>
        encodeReleasePolicyDefinition({
          ...policy.input,
          definition: { ...policy.input.definition, ...forbidden },
        } as never),
      ).toThrow();
    }
  });
});
