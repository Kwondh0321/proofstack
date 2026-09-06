import { readFileSync } from "node:fs";
import type { ReleaseCandidateDefinition } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  releaseCandidateSourceReferences,
  type ReleaseCandidateSourceReference,
} from "./release-candidate-source-references.js";

interface VectorDocument {
  readonly vectors: readonly {
    readonly input: { readonly definition: ReleaseCandidateDefinition };
  }[];
}

const document = JSON.parse(
  readFileSync(
    new URL("../../../contracts/vectors/release-candidate-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as VectorDocument;

function definition(): ReleaseCandidateDefinition {
  const value = document.vectors[0]?.input.definition;
  if (!value) throw new Error("Expected a release candidate vector");
  return structuredClone(value);
}

function kinds(references: readonly ReleaseCandidateSourceReference[]): readonly string[] {
  return references.map(({ kind }) => kind);
}

describe("release candidate source references", () => {
  it("enumerates every source class in fixed dependency order", () => {
    const references = releaseCandidateSourceReferences(definition());
    expect(kinds(references)).toEqual([
      "source_revision",
      "build_artifact",
      "build_artifact",
      "dataset_version",
      "assessment",
      "model_assurance_assessment",
      "comparison_result",
      "model_declaration",
      "runtime_adapter",
      "model_resolution_evidence",
      "prompt",
      "tool_contract",
      "target_release",
    ]);
    expect(references).toHaveLength(13);
    expect(references).toContainEqual({
      artifact: expect.objectContaining({ artifactId: "artifact_system_prompt" }),
      kind: "prompt",
      role: "system_prompt",
    });
    expect(references).toContainEqual({
      kind: "target_release",
      targetRelease: expect.objectContaining({ targetReleaseId: "target_checkout_agent_v1" }),
    });
  });

  it("retains provider alias uncertainty without inventing resolution evidence", () => {
    const candidate = definition();
    const model = candidate.runtimeComponents[0];
    if (model?.kind !== "model") throw new Error("Expected a model component");
    model.resolution = {
      declaredAlias: "checkout-model-latest",
      limitation: "The provider does not expose an immutable served model version.",
      status: "provider_alias_only",
    };
    const references = releaseCandidateSourceReferences(candidate);
    expect(kinds(references)).toContain("model_declaration");
    expect(kinds(references)).toContain("runtime_adapter");
    expect(kinds(references)).not.toContain("model_resolution_evidence");
    expect(references).toContainEqual(
      expect.objectContaining({
        kind: "model_declaration",
        resolution: expect.objectContaining({ status: "provider_alias_only" }),
      }),
    );
  });

  it("rejects malformed ordering and authority fields before enumeration", () => {
    const candidate = definition();
    expect(() =>
      releaseCandidateSourceReferences({
        ...candidate,
        runtimeComponents: [...candidate.runtimeComponents].reverse(),
      }),
    ).toThrow();
    expect(() =>
      releaseCandidateSourceReferences({
        ...candidate,
        releaseDecision: "proceed",
      } as never),
    ).toThrow();
  });
});
