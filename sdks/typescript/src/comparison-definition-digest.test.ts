import { readFileSync } from "node:fs";
import type { ComparisonRecordKind, EvidenceScope } from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ComparisonDefinitionDigestError,
  digestComparisonDefinition,
} from "./comparison-definition-digest.js";

interface StoredVector {
  readonly input: { readonly definition: unknown; readonly scope: EvidenceScope };
  readonly kind: ComparisonRecordKind;
  readonly sha256: string;
}

const vectors = [
  "evaluation-comparison-definition-v1.json",
  "evaluation-comparison-snapshot-definition-v1.json",
  "evaluation-comparison-result-definition-v1.json",
].map((file) => {
  const document = JSON.parse(
    readFileSync(new URL(`../../../packages/contracts/vectors/${file}`, import.meta.url), "utf8"),
  ) as { readonly vectors: readonly StoredVector[] };
  const first = document.vectors[0];
  if (!first) throw new Error(`Expected ${file}`);
  return first;
});

describe("comparison definition digest", () => {
  it("reproduces every comparison contract vector", async () => {
    expect(vectors.map(({ kind }) => kind)).toEqual([
      "comparison_definition",
      "comparison_evidence_snapshot",
      "comparison_result",
    ]);
    for (const vector of vectors) {
      await expect(
        digestComparisonDefinition(vector.kind, vector.input.scope, vector.input.definition),
      ).resolves.toBe(vector.sha256);
    }
  });

  it("fails closed when Web Crypto cannot calculate the digest", async () => {
    const digest = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("unavailable"));
    const vector = vectors[0];
    if (!vector) throw new Error("Expected comparison vector");
    await expect(
      digestComparisonDefinition(vector.kind, vector.input.scope, vector.input.definition),
    ).rejects.toBeInstanceOf(ComparisonDefinitionDigestError);
    digest.mockRestore();
  });
});
