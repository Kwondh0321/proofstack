import { describe, expect, it } from "vitest";
import {
  PolicyEvaluationCandidateAuthorityInputsSchema,
  PolicyEvaluationCandidateAuthoritySubjectSchema,
  type PolicyEvaluationCandidateAuthorityInputs,
} from "./policy-evaluation-candidate-authority.js";

const sha = "a".repeat(64);
function input(): Extract<PolicyEvaluationCandidateAuthorityInputs, { status: "observed" }> {
  return {
    status: "observed",
    scope: {
      tenantId: "tenant_authority",
      projectId: "project_authority",
      environmentId: "env_authority",
    },
    evaluationTime: "2026-10-03T00:00:00.000Z",
    startedAt: "2026-10-03T00:00:00.000Z",
    completedAt: "2026-10-03T00:00:00.001Z",
    occurrences: [
      {
        parent: {
          kind: "release_candidate",
          reference: {
            candidateId: "candidate_authority",
            candidateVersionId: "candidate_authority_v1",
            definitionSha256: sha,
          },
        },
        parentRecordSha256: sha,
        path: "/source",
        edgeIndex: 0,
        availability: "not_verified",
        subject: {
          kind: "source_revision",
          source: {
            commit: { algorithm: "sha1", value: "a".repeat(40) },
            tree: { algorithm: "sha1", value: "b".repeat(40) },
            repositoryUrl: "https://github.com/Kwondh0321/proofstack",
          },
        },
      },
    ],
    unavailableParents: [],
  };
}
describe("strict candidate reference authority observations", () => {
  it("preserves unavailable/configuration boundaries without claiming loaded-code authority", () => {
    const value = input();
    expect(PolicyEvaluationCandidateAuthorityInputsSchema.parse(value)).toEqual(value);
    expect(
      PolicyEvaluationCandidateAuthorityInputsSchema.parse({ status: "not_configured" }),
    ).toEqual({ status: "not_configured" });
  });
  it.each(["cut", "order", "coordinate", "parent", "path", "authority"] as const)(
    "rejects changed %s",
    (fault) => {
      const value = input();
      if (fault === "cut") value.startedAt = "2026-10-02T00:00:00.000Z";
      else if (fault === "order") value.completedAt = "2026-10-02T00:00:00.000Z";
      else if (fault === "coordinate")
        value.occurrences.push(structuredClone(value.occurrences[0]!));
      else if (fault === "parent")
        Reflect.set(value.occurrences[0]!.parent, "kind", "release_policy");
      else if (fault === "path") value.occurrences[0]!.path = "https://source.example/latest";
      else Reflect.set(value.occurrences[0]!, "approved", true);
      expect(PolicyEvaluationCandidateAuthorityInputsSchema.safeParse(value).success).toBe(false);
    },
  );
  it.each([
    {
      kind: "runtime_adapter",
      adapter: {
        adapterId: "adapter_authority",
        adapterVersionId: "adapter_authority_v1",
        definitionSha256: sha,
      },
      role: "adapter",
    },
    {
      kind: "model_declaration",
      providerId: "provider_authority",
      providerModelId: "declared_alias",
      role: "model",
      resolution: {
        status: "provider_alias_only",
        declaredAlias: "declared_alias",
        limitation: "Reference availability is not provider truth",
      },
    },
  ])("preserves original $kind subject and rejects executable grants", (subject) => {
    expect(PolicyEvaluationCandidateAuthoritySubjectSchema.parse(subject)).toEqual(subject);
    expect(
      PolicyEvaluationCandidateAuthoritySubjectSchema.safeParse({ ...subject, execute: true })
        .success,
    ).toBe(false);
  });
  it("rejects total occurrence overflow before parsing subject material", () => {
    const value = input();
    value.occurrences = Array.from({ length: 100000 }, () => value.occurrences[0]!);
    Object.defineProperty(value.occurrences[0], "subject", {
      get() {
        throw new Error("Subject material read before admission");
      },
    });
    expect(PolicyEvaluationCandidateAuthorityInputsSchema.safeParse(value).success).toBe(false);
  });
});
