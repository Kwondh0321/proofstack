import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MODEL_ASSISTED_EVALUATOR_SPEC_SCHEMA_VERSION,
  type ModelAssistedEvaluatorSpecDefinition,
} from "./evaluation-model-assurance.js";
import {
  encodeModelAssistedEvaluatorSpecDefinition,
  MODEL_ASSISTED_EVALUATOR_SPEC_DEFINITION_DOMAIN,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";

interface Vector {
  readonly encodedByteLength: number;
  readonly input: ScopedEvaluationDefinition<ModelAssistedEvaluatorSpecDefinition>;
  readonly kind: "model_assisted_evaluator_spec";
  readonly name: string;
  readonly sha256: string;
}

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/evaluation-model-assisted-spec-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as { readonly format: string; readonly vectors: readonly Vector[] };

function vector(): Vector {
  const value = document.vectors[0];
  if (!value) throw new Error("Expected a model-assisted evaluator vector");
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("canonical model-assisted evaluator encoding", () => {
  it("matches the fixed public UTF-8 and SHA-256 vector", () => {
    expect(document.format).toBe("proofstack.evaluation-model-assisted-spec-definition.v1");
    const value = vector();
    const bytes = encodeModelAssistedEvaluatorSpecDefinition(value.input);
    expect(bytes.byteLength).toBe(value.encodedByteLength);
    expect(sha256(bytes)).toBe(value.sha256);
  });

  it("binds profile, qualification corpus, schemas, criteria, semantics, and scope", () => {
    const value = vector();
    const original = encodeModelAssistedEvaluatorSpecDefinition(value.input);
    const text = Buffer.from(original).toString("utf8");
    expect(text).toContain(MODEL_ASSISTED_EVALUATOR_SPEC_DEFINITION_DOMAIN);
    expect(text).toContain(`"schemaVersion":"${MODEL_ASSISTED_EVALUATOR_SPEC_SCHEMA_VERSION}"`);

    const mutations: ((candidate: Vector["input"]) => void)[] = [
      (candidate) => {
        candidate.scope.tenantId = "ten_other";
      },
      (candidate) => {
        candidate.definition.modelProfile.definitionSha256 = "f".repeat(64);
      },
      (candidate) => {
        candidate.definition.qualificationFixtureSet.definitionSha256 = "e".repeat(64);
      },
      (candidate) => {
        candidate.definition.outputSchema.sha256 = "d".repeat(64);
      },
      (candidate) => {
        candidate.definition.resultSemantics = "A different bounded result meaning.";
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(value.input);
      mutate(changed);
      expect(encodeModelAssistedEvaluatorSpecDefinition(changed)).not.toEqual(original);
    }
  });

  it("rejects embedded provider authority, prompts, credentials, and release policy", () => {
    const input = vector().input;
    for (const forbidden of [
      { apiKey: "secret" },
      { endpoint: "https://example.invalid" },
      { prompt: "mutable prompt" },
      { releaseAuthority: "allow" },
    ]) {
      expect(() =>
        encodeModelAssistedEvaluatorSpecDefinition({
          ...input,
          definition: { ...input.definition, ...forbidden },
        } as never),
      ).toThrow();
    }
  });
});
