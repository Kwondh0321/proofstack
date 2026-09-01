import { readFileSync } from "node:fs";
import type { EvidenceScope, ModelAssuranceRecordKind } from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  digestModelAssuranceDefinition,
  ModelAssuranceDefinitionDigestError,
} from "./model-assurance-definition-digest.js";

interface StoredVector {
  readonly input: { readonly definition: unknown; readonly scope: EvidenceScope };
  readonly kind: ModelAssuranceRecordKind | "model_assisted_evaluator_spec";
  readonly sha256: string;
}

const vectors = [
  "evaluation-blinded-plan-definition-v1.json",
  "evaluation-blinded-result-definition-v1.json",
  "evaluation-calibration-definition-v1.json",
  "evaluation-human-review-protocol-definition-v1.json",
  "evaluation-human-review-record-definition-v1.json",
  "evaluation-human-reviewer-independence-definition-v1.json",
  "evaluation-independence-definition-v1.json",
  "evaluation-independent-critique-definition-v1.json",
  "evaluation-model-assisted-spec-definition-v1.json",
  "evaluation-model-assurance-assessment-definition-v1.json",
  "evaluation-model-assurance-definition-v1.json",
  "evaluation-model-qualification-report-definition-v1.json",
  "evaluation-model-qualification-suite-definition-v1.json",
].flatMap(
  (file) =>
    (
      JSON.parse(
        readFileSync(
          new URL(`../../../packages/contracts/vectors/${file}`, import.meta.url),
          "utf8",
        ),
      ) as { readonly vectors: readonly StoredVector[] }
    ).vectors,
);

describe("model-assurance definition digest", () => {
  it("reproduces every language-independent contract vector", async () => {
    expect(vectors).toHaveLength(13);
    for (const vector of vectors) {
      const kind =
        vector.kind === "model_assisted_evaluator_spec" ? "model_assisted_evaluator" : vector.kind;
      await expect(
        digestModelAssuranceDefinition(kind, vector.input.scope, vector.input.definition),
        kind,
      ).resolves.toBe(vector.sha256);
    }
  });

  it("fails closed when Web Crypto cannot calculate the digest", async () => {
    const digest = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("no"));
    const vector = vectors[0];
    if (!vector) throw new Error("Expected a model-assurance vector");
    const kind =
      vector.kind === "model_assisted_evaluator_spec" ? "model_assisted_evaluator" : vector.kind;
    await expect(
      digestModelAssuranceDefinition(kind, vector.input.scope, vector.input.definition),
    ).rejects.toBeInstanceOf(ModelAssuranceDefinitionDigestError);
    digest.mockRestore();
  });
});
