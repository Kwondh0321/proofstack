import { readFileSync } from "node:fs";
import type { EvaluationRecordKind, EvidenceScope } from "@proofstack/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  digestEvaluationDefinition,
  EvaluationDefinitionDigestError,
} from "./evaluation-definition-digest.js";

interface StoredVector {
  readonly input: {
    readonly definition: unknown;
    readonly scope: EvidenceScope;
  };
  readonly kind: EvaluationRecordKind;
  readonly sha256: string;
}

const vectors = [
  "evaluation-source-definition-v1.json",
  "evaluation-criteria-definition-v1.json",
  "evaluation-spec-definition-v1.json",
  "evaluation-qualification-definition-v1.json",
  "evaluation-run-definition-v1.json",
  "evaluation-assessment-definition-v1.json",
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

describe("evaluation definition digest", () => {
  it("reproduces every language-independent contract vector", async () => {
    expect(vectors).toHaveLength(16);
    for (const vector of vectors) {
      await expect(
        digestEvaluationDefinition(vector.kind, vector.input.scope, vector.input.definition),
        vector.kind,
      ).resolves.toBe(vector.sha256);
    }
  });

  it("fails closed when Web Crypto cannot calculate the digest", async () => {
    const digest = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("no"));
    await expect(
      digestEvaluationDefinition(
        vectors[0]?.kind ?? "discovery_record",
        vectors[0]?.input.scope ?? {
          environmentId: "env_local",
          projectId: "prj_local",
          tenantId: "ten_local",
        },
        vectors[0]?.input.definition ?? {},
      ),
    ).rejects.toBeInstanceOf(EvaluationDefinitionDigestError);
    digest.mockRestore();
  });
});
