import { describe, expect, it } from "vitest";
import {
  validateRuntimeDefinitionRecord,
  validateProtocolDefinitionRecord,
  StaticProtocolDefinitionCatalogue,
  StaticRuntimeDefinitionCatalogue,
} from "@proofstack/core";
import {
  ArtifactContentReferenceSchema,
  ProtocolDefinitionSelectorSchema,
} from "@proofstack/contracts";
import { createPolicyContributorDefinitions } from "./policy-evaluation-definitions.js";

type ArtifactContentReference = ReturnType<typeof ArtifactContentReferenceSchema.parse>;

const artifact = (name: string, digit: string): ArtifactContentReference => ({
  artifactId: name,
  classification: "internal",
  mediaType: "application/json",
  sha256: digit.repeat(64),
  sizeBytes: 123,
});
function input() {
  return {
    namespace: "fixture_policy",
    scope: {
      tenantId: "tenant_policy",
      projectId: "project_policy",
      environmentId: "environment_policy",
    },
    registeredAt: "2026-10-15T12:00:00.000Z",
    registeredByPrincipalId: "operator_policy",
    runtime: {
      family: "node" as const,
      version: "24.19.0",
      architecture: "x64" as const,
      platform: "linux" as const,
      entryPoint: "target.mjs",
    },
    implementation: artifact("artifact_original_implementation", "1"),
    configuration: artifact("artifact_original_configuration", "2"),
    specification: artifact("artifact_original_specification", "3"),
  };
}
describe("independent canonical contributor declarations", () => {
  it("retains three owning runtime definitions and all seven independent protocol families", async () => {
    const i = input();
    const d = createPolicyContributorDefinitions(i);
    expect(d.runtimeDefinitions.map((r) => validateRuntimeDefinitionRecord(r))).toEqual(
      d.runtimeDefinitions,
    );
    expect(d.protocolDefinitions.map((r) => validateProtocolDefinitionRecord(r))).toEqual(
      d.protocolDefinitions,
    );
    expect(d.runtimeDefinitions.map((r) => r.recordKind)).toEqual([
      "replay_runtime_profile",
      "replay_isolation_profile",
      "runtime_adapter",
    ]);
    expect(d.protocolDefinitions.map((r) => [r.protocolDefinitionId, r.family])).toEqual([
      ["protocol_fixture_policy_01", "capture_adapter"],
      ["protocol_fixture_policy_02", "source_format"],
      ["protocol_fixture_policy_03", "request_normalizer"],
      ["protocol_fixture_policy_04", "request_normalizer"],
      ["protocol_fixture_policy_05", "recorded_target_adapter"],
      ["protocol_fixture_policy_06", "released_target_adapter"],
      ["protocol_fixture_policy_07", "worker_protocol"],
      ["protocol_fixture_policy_08", "runtime_protocol"],
    ]);
    const runtime = new StaticRuntimeDefinitionCatalogue(d.runtimeDefinitions);
    expect(
      await runtime.findRuntimeProfile(i.scope, d.runtimeProfileReference.id, "1.0.0"),
    ).toEqual(d.runtimeProfile);
    expect(
      await runtime.findIsolationProfile(i.scope, d.isolationProfileReference.id, "1.0.0"),
    ).toEqual(d.isolationProfile);
    expect(
      await runtime.findRuntimeAdapter(i.scope, d.modelAdapterReference.adapterVersionId),
    ).toEqual(d.modelAdapter);
    const protocols = new StaticProtocolDefinitionCatalogue(d.protocolDefinitions);
    const normalizers = d.protocolDefinitions.filter((r) => r.family === "request_normalizer");
    expect(normalizers.map((r) => r.descriptor.name)).toEqual([
      "proofstack.reference.model",
      "proofstack.reference.tool",
    ]);
    for (const r of d.protocolDefinitions) {
      expect(await protocols.findProtocolDefinition(i.scope, r.protocolDefinitionId)).toEqual(r);
      expect(
        await protocols.listProtocolDefinitions(
          i.scope,
          ProtocolDefinitionSelectorSchema.parse({
            family: r.family,
            descriptor: r.descriptor,
          }),
        ),
      ).toEqual([r]);
      expect(r.registeredAt).toBe(i.registeredAt);
      expect(r.registeredByPrincipalId).toBe(i.registeredByPrincipalId);
    }
    expect(
      await runtime.findRuntimeAdapter(
        { ...i.scope, tenantId: "other_tenant" },
        d.modelAdapterReference.adapterVersionId,
      ),
    ).toBeNull();
  });
  it("binds full source artifacts, scope and runtime while keeping original receipts separate", () => {
    const i = input(),
      original = createPolicyContributorDefinitions(i);
    const differentSource = input();
    differentSource.implementation.sha256 = "4".repeat(64);
    expect(
      createPolicyContributorDefinitions(differentSource).runtimeProfile.definitionSha256,
    ).not.toBe(original.runtimeProfile.definitionSha256);
    const differentScope = input();
    differentScope.scope.tenantId = "other_tenant";
    expect(
      createPolicyContributorDefinitions(differentScope).protocolDefinitions[0]!.definitionSha256,
    ).not.toBe(original.protocolDefinitions[0]!.definitionSha256);
    const later = input();
    later.registeredAt = "2026-10-15T12:00:01.000Z";
    expect(createPolicyContributorDefinitions(later).modelAdapter.definitionSha256).toBe(
      original.modelAdapter.definitionSha256,
    );
    i.configuration.sha256 = "5".repeat(64);
    i.scope.tenantId = "changed_after_admission";
    expect(original.runtimeProfile.scope.tenantId).toBe("tenant_policy");
    expect(
      original.runtimeDefinitions.every((r) => r.configuration.sha256 === "2".repeat(64)),
    ).toBe(true);
    expect(() =>
      validateRuntimeDefinitionRecord({
        ...original.modelAdapter,
        definitionSha256: "f".repeat(64),
      }),
    ).toThrow();
  });
  it.each(["namespace", "numeric_namespace", "scope", "receipt", "actor", "artifact", "runtime"])(
    "rejects invalid original %s",
    (fault) => {
      const i = input();
      if (fault === "namespace") i.namespace = "invalid namespace";
      if (fault === "numeric_namespace") i.namespace = "123456abcdef";
      if (fault === "scope") i.scope.tenantId = "invalid scope";
      if (fault === "receipt") i.registeredAt = "2026-10-15T12:00:00.000001Z";
      if (fault === "actor") i.registeredByPrincipalId = "invalid actor";
      if (fault === "artifact") i.specification.sha256 = "invalid";
      if (fault === "runtime") i.runtime.version = "";
      expect(() => createPolicyContributorDefinitions(i)).toThrow();
    },
  );
});
