import { describe, expect, it } from "vitest";
import { PolicyEvaluationReferenceSchema } from "./policy-evaluation-reference.js";

const sha = "a".repeat(64);
const references = [
  {
    kind: "record",
    path: "/policy",
    source: {
      kind: "release_policy",
      reference: {
        policyId: "policy_reference",
        policyVersionId: "policy_reference_v1",
        definitionSha256: sha,
      },
    },
  },
  {
    kind: "artifact",
    path: "/content",
    reference: {
      artifactId: "artifact_reference",
      sha256: sha,
      sizeBytes: 1,
      mediaType: "application/json",
      classification: "internal",
    },
  },
  {
    kind: "control_declaration",
    path: "/artifactId",
    declaration: { kind: "artifact_identity", reference: "artifact_reference" },
  },
  { kind: "replay_declaration", path: "/digest", declaration: { kind: "digest", reference: sha } },
  {
    kind: "protocol_declaration",
    path: "/source/captureAdapter",
    reference: { name: "capture_adapter", version: "1.0.0" },
  },
  {
    kind: "endpoint_profile_selector",
    path: "/provider",
    selector: { endpointProfileId: "endpoint_reference", endpointProfileVersion: "1.0.0" },
  },
  { kind: "evaluation_run_identity", path: "/evaluationRunId", evaluationRunId: "run_reference" },
  {
    kind: "interaction_prompt",
    path: "/prompt",
    reference: {
      artifactId: "artifact_reference",
      definitionSha256: sha,
      promptId: "prompt_reference",
      promptVersion: "1.0.0",
    },
  },
  {
    kind: "interaction_tool_contract",
    path: "/tool",
    reference: {
      artifactId: "artifact_reference",
      definitionSha256: sha,
      toolId: "tool_reference",
      toolVersion: "1.0.0",
    },
  },
  {
    kind: "criterion_selector",
    path: "/criterion",
    selector: {
      criterionId: "criterion_reference",
      criterionSetId: "criteria_reference",
      criterionSetVersionId: "criteria_reference_v1",
    },
  },
  {
    kind: "model_evaluator_selector",
    path: "/evaluator",
    selector: { evaluatorId: "evaluator_reference", evaluatorVersionId: "evaluator_reference_v1" },
  },
  {
    kind: "registered_implementation",
    path: "/implementation",
    reference: {
      dependencySnapshotSha256: sha,
      entryPointId: "entry_reference",
      implementationId: "implementation_reference",
      implementationSha256: sha,
      implementationVersionId: "implementation_reference_v1",
      runtime: { architecture: "x64", family: "node", platform: "linux", version: "24" },
      sourceRevision: "a".repeat(40),
    },
  },
  {
    kind: "trace_snapshot_selector",
    path: "/source/trace",
    selector: {
      kind: "trace_snapshot",
      eventIds: ["event_reference"],
      observedEventCount: 1,
      sourceCompleteness: "observed_snapshot",
      traceId: "a".repeat(32),
      capturedAt: "2026-10-03T00:00:00.000Z",
    },
  },
  {
    kind: "qualification_policy",
    path: "/policy",
    reference: {
      policyId: "qualification_reference",
      policyVersionId: "qualification_reference_v1",
      definitionSha256: sha,
    },
  },
] as const;

const controlDeclarations = [
  { kind: "artifact_identity", reference: "artifact_reference" },
  {
    kind: "artifact_requirement",
    reference: {
      kind: "artifact_required",
      componentKind: "build_artifact",
      allowedMediaTypes: ["application/json"],
      maximumDataClassification: "internal",
      requireDigest: true,
      role: "artifact_reference",
    },
  },
  {
    kind: "approval_requirement",
    reference: {
      kind: "approval_required",
      conflictRule: "reject_declared_conflict",
      excludeCandidateAuthor: true,
      excludePolicyAuthor: true,
      humanReviewerGroupIds: [],
      independenceGroupIds: ["independent_reference"],
      quorum: 1,
      reviewerRoleIds: ["reviewer_reference"],
    },
  },
  {
    kind: "candidate_source",
    reference: {
      commit: { algorithm: "sha1", value: "a".repeat(40) },
      repositoryUrl: "https://github.com/Kwondh0321/proofstack",
      tree: { algorithm: "sha1", value: "b".repeat(40) },
    },
  },
  {
    kind: "comparison_predecessor",
    reference: { comparisonVersionId: "comparison_reference_v1", definitionSha256: sha },
  },
  {
    kind: "model_declaration",
    reference: {
      providerId: "provider_reference",
      providerModelId: "model_reference",
      resolution: {
        status: "provider_alias_only",
        declaredAlias: "model_reference",
        limitation: "Provider alias is not an exact version",
      },
    },
  },
  {
    kind: "safety_event",
    reference: {
      eventId: "event_reference",
      kind: "guardrail_check",
      occurredAt: "2026-10-03T00:00:00.000Z",
      sourceId: "source_reference",
      sourceSha256: sha,
    },
  },
];
const replayDeclarations = [
  { kind: "artifact_identity", reference: "artifact_reference" },
  {
    kind: "credential_selector",
    reference: {
      credentialId: "credential_reference",
      credentialVersionId: "credential_reference_v1",
    },
  },
  { kind: "digest", reference: sha },
  {
    kind: "endpoint_profile",
    reference: {
      definitionSha256: sha,
      endpointProfileId: "endpoint_reference",
      endpointProfileVersion: "1.0.0",
    },
  },
  {
    kind: "preinstalled_target",
    reference: {
      kind: "preinstalled",
      implementationId: "implementation_reference",
      implementationSha256: sha,
    },
  },
  { kind: "recorded_adapter", reference: { name: "recorded_adapter", version: "1.0.0" } },
  {
    kind: "subprocess_implementation",
    reference: { executableSha256: sha, implementationId: "implementation_reference" },
  },
  {
    kind: "target_adapter",
    reference: { name: "target_adapter", protocolVersion: "1.0.0", version: "1.0.0" },
  },
  { kind: "worker_protocol", reference: { name: "worker_protocol", version: "1.0.0" } },
];

describe("strict retained policy relationship references", () => {
  it.each([
    ...controlDeclarations.map((declaration) => ({
      kind: "control_declaration",
      path: "/declaration",
      declaration,
    })),
    ...replayDeclarations.map((declaration) => ({
      kind: "replay_declaration",
      path: "/declaration",
      declaration,
    })),
  ])("retains $kind/$declaration.kind and rejects nested authority fields", (reference) => {
    expect(PolicyEvaluationReferenceSchema.parse(reference)).toEqual(reference);
    expect(
      PolicyEvaluationReferenceSchema.safeParse({
        ...reference,
        declaration: { ...reference.declaration, execute: true },
      }).success,
    ).toBe(false);
  });
  it.each(references)(
    "preserves original $kind coordinates using the owning bounds",
    (reference) => {
      expect(PolicyEvaluationReferenceSchema.parse(reference)).toEqual(reference);
    },
  );
  it.each(references)("rejects executable/authority fields on $kind", (reference) => {
    expect(
      PolicyEvaluationReferenceSchema.safeParse({ ...reference, execute: "caller_code" }).success,
    ).toBe(false);
  });
  it.each([
    "",
    "https://source.example/replace",
    "/bad~escape",
    "/bad\u0000path",
    "/" + "x".repeat(1024),
  ])("rejects a non-pointer or excessive occurrence path: %s", (path) => {
    expect(PolicyEvaluationReferenceSchema.safeParse({ ...references[0], path }).success).toBe(
      false,
    );
  });
  it("rejects an arbitrary source URL, supplied SQL and resolved credentials", () => {
    expect(
      PolicyEvaluationReferenceSchema.safeParse({
        kind: "record",
        path: "/policy",
        source: { url: "https://source.example/latest" },
      }).success,
    ).toBe(false);
    expect(
      PolicyEvaluationReferenceSchema.safeParse({
        kind: "replay_declaration",
        path: "/credential",
        declaration: {
          kind: "credential_selector",
          reference: { credentialVersionId: "credential_reference", secret: "caller_secret" },
        },
      }).success,
    ).toBe(false);
    expect(
      PolicyEvaluationReferenceSchema.safeParse({
        kind: "sql",
        path: "/record",
        query: "caller_sql",
      }).success,
    ).toBe(false);
  });
});
