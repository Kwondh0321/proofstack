import { describe, expect, it } from "vitest";
import {
  RELEASE_CANDIDATE_SCHEMA_VERSION,
  PublishReleaseCandidateRequestSchema,
  ReleaseCandidateDefinitionSchema,
  ReleaseCandidateRuntimeComponentSchema,
  ReleaseCandidateSchema,
  ReleaseCandidateSourceSchema,
} from "./release-candidate.js";

const sha = (character: string) => character.repeat(64);

function artifact(
  artifactId: string,
  digestCharacter: string,
  classification: "confidential" | "internal" | "metadata" | "restricted" = "internal",
) {
  return {
    artifactId,
    classification,
    mediaType: "application/json",
    sha256: sha(digestCharacter),
    sizeBytes: 128,
  } as const;
}

function definition() {
  return {
    assessments: [
      {
        assessmentId: "assessment_candidate",
        definitionSha256: sha("1"),
      },
    ],
    buildArtifacts: [
      { artifact: artifact("artifact_agent_bundle", "2"), role: "agent_bundle" },
      { artifact: artifact("artifact_sbom", "3", "metadata"), role: "sbom" },
    ],
    candidateId: "candidate_checkout_agent",
    candidateVersionId: "candidate_checkout_agent_v1",
    comparisons: [
      {
        definitionSha256: sha("4"),
        resultId: "comparison_result_candidate",
      },
    ],
    contentProjection: "artifact_references_only",
    datasets: [
      {
        datasetId: "dataset_checkout",
        datasetVersionId: "dataset_checkout_v1",
        definitionSha256: sha("5"),
      },
    ],
    description: "Exact candidate for the checkout-agent reliability gate.",
    knownLimitations: ["Provider exposes an exact served model version but not model weights."],
    modelAssuranceAssessments: [
      {
        assessmentExtensionId: "model_assessment_candidate",
        definitionSha256: sha("6"),
      },
    ],
    name: "Checkout agent candidate",
    omissions: [],
    runtimeComponents: [
      {
        adapter: {
          adapterId: "adapter_model_provider",
          adapterVersionId: "adapter_model_provider_v1",
          definitionSha256: sha("7"),
        },
        kind: "model",
        providerId: "provider_example",
        providerModelId: "checkout-model",
        resolution: {
          resolutionEvidence: artifact("artifact_model_resolution", "8", "confidential"),
          resolvedModelVersion: "checkout-model-2026-09-01",
          status: "exact",
        },
        role: "primary_model",
      },
      {
        content: artifact("artifact_system_prompt", "9", "confidential"),
        kind: "prompt",
        role: "system_prompt",
      },
      {
        content: artifact("artifact_payment_tool", "a"),
        kind: "tool_contract",
        role: "payment_tool",
      },
    ],
    source: {
      commit: { algorithm: "sha1", value: "b".repeat(40) },
      repositoryUrl: "https://github.com/example/checkout-agent.git",
      tree: { algorithm: "sha256", value: sha("c") },
    },
    target: {
      environmentId: "env_staging",
      jurisdiction: "us",
      locale: "en-us",
      maximumDataClassification: "confidential",
      populationTags: ["business", "checkout"],
      purpose: "Evaluate one exact checkout-agent candidate before a staging release.",
      riskTier: "high",
      taskKind: "checkout_agent",
    },
    targetRelease: {
      definitionSha256: sha("d"),
      targetAdapter: {
        name: "local_target",
        protocolVersion: "1.0.0",
        version: "1.0.0",
      },
      targetId: "target_checkout_agent",
      targetReleaseId: "target_checkout_agent_v1",
      workerProtocol: { name: "json_line", version: "1.0.0" },
    },
  } as const;
}

describe("release candidate contracts", () => {
  it("accepts exact release identity and references without policy meaning", () => {
    const input = definition();
    expect(ReleaseCandidateDefinitionSchema.parse(input)).toEqual(input);
    expect(
      ReleaseCandidateSchema.parse({
        ...input,
        createdAt: "2026-09-06T01:00:00.000Z",
        createdByPrincipalId: "user_release_manager",
        definitionSha256: sha("e"),
        schemaVersion: RELEASE_CANDIDATE_SCHEMA_VERSION,
        scope: {
          environmentId: "env_staging",
          projectId: "project_checkout",
          tenantId: "tenant_example",
        },
      }).candidateVersionId,
    ).toBe(input.candidateVersionId);
  });

  it("keeps authoritative and release-decision fields out of the publish request", () => {
    const { candidateId: _candidateId, ...request } = definition();
    expect(_candidateId).toBe("candidate_checkout_agent");
    expect(PublishReleaseCandidateRequestSchema.safeParse(request).success).toBe(true);

    for (const [field, value] of [
      ["candidateId", "candidate_other"],
      ["scope", { environmentId: "env_staging", projectId: "project", tenantId: "tenant" }],
      ["createdAt", "2026-09-06T01:00:00.000Z"],
      ["createdByPrincipalId", "user_other"],
      ["definitionSha256", sha("f")],
      ["policyEvaluation", "satisfied"],
      ["releaseDecision", "proceed"],
      ["deploymentToken", "secret"],
    ] as const) {
      expect(
        PublishReleaseCandidateRequestSchema.safeParse({ ...request, [field]: value }).success,
      ).toBe(false);
    }
  });

  it("requires immutable Git object identities and a credential-free HTTPS repository URL", () => {
    const valid = definition().source;
    expect(ReleaseCandidateSourceSchema.safeParse(valid).success).toBe(true);

    for (const source of [
      { ...valid, commit: { algorithm: "sha1", value: "main" } },
      { ...valid, commit: { algorithm: "sha256", value: "b".repeat(40) } },
      { ...valid, repositoryUrl: "http://github.com/example/checkout-agent.git" },
      { ...valid, repositoryUrl: "https://user:password@github.com/example/checkout-agent.git" },
      { ...valid, repositoryUrl: "https://github.com/example/checkout-agent.git?ref=main" },
      { ...valid, repositoryUrl: "https://github.com/example/checkout-agent.git#main" },
      { ...valid, repositoryUrl: "https://github.com" },
      { ...valid, repositoryUrl: "https://github.com/" },
    ]) {
      expect(ReleaseCandidateSourceSchema.safeParse(source).success).toBe(false);
    }
  });

  it("requires unique ordered exact components and evidence references", () => {
    const valid = definition();
    expect(
      ReleaseCandidateDefinitionSchema.safeParse({
        ...valid,
        runtimeComponents: [...valid.runtimeComponents].reverse(),
      }).success,
    ).toBe(false);
    expect(
      ReleaseCandidateDefinitionSchema.safeParse({
        ...valid,
        buildArtifacts: [
          valid.buildArtifacts[0],
          { artifact: artifact("artifact_other_bundle", "f"), role: "agent_bundle" },
        ],
      }).success,
    ).toBe(false);
    expect(
      ReleaseCandidateDefinitionSchema.safeParse({
        ...valid,
        datasets: [valid.datasets[0], { ...valid.datasets[0], definitionSha256: sha("f") }],
      }).success,
    ).toBe(false);
    expect(
      ReleaseCandidateDefinitionSchema.safeParse({
        ...valid,
        comparisons: [
          valid.comparisons[0],
          { ...valid.comparisons[0], definitionSha256: sha("f") },
        ],
      }).success,
    ).toBe(false);
    expect(
      ReleaseCandidateDefinitionSchema.safeParse({
        ...valid,
        assessments: [
          valid.assessments[0],
          { ...valid.assessments[0], definitionSha256: sha("f") },
        ],
      }).success,
    ).toBe(false);
    expect(
      ReleaseCandidateDefinitionSchema.safeParse({
        ...valid,
        modelAssuranceAssessments: [
          valid.modelAssuranceAssessments[0],
          { ...valid.modelAssuranceAssessments[0], definitionSha256: sha("f") },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps lineage, scope, classification, and omissions internally coherent", () => {
    const valid = definition();
    const { candidateId: _candidateId, ...request } = valid;
    expect(_candidateId).toBe("candidate_checkout_agent");
    expect(
      PublishReleaseCandidateRequestSchema.safeParse({
        ...request,
        predecessorVersionId: request.candidateVersionId,
      }).success,
    ).toBe(false);
    expect(
      ReleaseCandidateDefinitionSchema.safeParse({
        ...valid,
        predecessor: {
          candidateId: valid.candidateId,
          candidateVersionId: valid.candidateVersionId,
          definitionSha256: sha("f"),
        },
      }).success,
    ).toBe(false);
    expect(
      ReleaseCandidateDefinitionSchema.safeParse({
        ...valid,
        predecessor: {
          candidateId: "candidate_other",
          candidateVersionId: "candidate_other_v1",
          definitionSha256: sha("f"),
        },
      }).success,
    ).toBe(false);
    expect(
      ReleaseCandidateDefinitionSchema.safeParse({
        ...valid,
        target: { ...valid.target, maximumDataClassification: "internal" },
      }).success,
    ).toBe(false);
    expect(
      ReleaseCandidateDefinitionSchema.safeParse({
        ...valid,
        omissions: [
          {
            kind: "prompt",
            rationale: "The component is already present.",
            reason: "source_unavailable",
            role: "system_prompt",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ReleaseCandidateSchema.safeParse({
        ...valid,
        createdAt: "2026-09-06T01:00:00.000Z",
        createdByPrincipalId: "user_release_manager",
        definitionSha256: sha("e"),
        schemaVersion: RELEASE_CANDIDATE_SCHEMA_VERSION,
        scope: {
          environmentId: "env_production",
          projectId: "project_checkout",
          tenantId: "tenant_example",
        },
      }).success,
    ).toBe(false);
  });

  it("preserves provider alias uncertainty instead of presenting it as an exact model", () => {
    const valid = definition().runtimeComponents[0];
    if (valid.kind !== "model") throw new Error("Expected a model component");
    const aliasOnly = {
      ...valid,
      resolution: {
        declaredAlias: "checkout-model-latest",
        limitation: "The provider does not expose an immutable served model version.",
        status: "provider_alias_only",
      },
    } as const;
    expect(ReleaseCandidateRuntimeComponentSchema.safeParse(aliasOnly).success).toBe(true);
    const candidate = definition();
    expect(
      ReleaseCandidateDefinitionSchema.safeParse({
        ...candidate,
        runtimeComponents: [aliasOnly, ...candidate.runtimeComponents.slice(1)],
      }).success,
    ).toBe(true);
    expect(
      ReleaseCandidateRuntimeComponentSchema.safeParse({
        ...valid,
        resolution: { resolvedModelVersion: "checkout-model-2026-09-01", status: "exact" },
      }).success,
    ).toBe(false);
  });
});
