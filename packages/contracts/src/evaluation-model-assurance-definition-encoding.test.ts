import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MODEL_EVALUATOR_PROFILE_SCHEMA_VERSION,
  type ModelEvaluatorProfileDefinition,
} from "./evaluation-model-assurance.js";
import {
  encodeModelEvaluatorProfileDefinition,
  MODEL_EVALUATOR_PROFILE_DEFINITION_DOMAIN,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";

interface ModelProfileVector {
  readonly encodedByteLength: number;
  readonly input: ScopedEvaluationDefinition<ModelEvaluatorProfileDefinition>;
  readonly kind: "model_evaluator_profile";
  readonly name: string;
  readonly sha256: string;
}

interface VectorDocument {
  readonly format: string;
  readonly vectors: readonly ModelProfileVector[];
}

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/evaluation-model-assurance-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as VectorDocument;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function vector(): ModelProfileVector {
  const value = document.vectors[0];
  if (!value) throw new Error("Expected a model evaluator profile vector");
  return value;
}

describe("canonical model evaluator profile encoding", () => {
  it("matches the fixed public UTF-8 and SHA-256 vector", () => {
    expect(document.format).toBe("proofstack.evaluation-model-assurance-definition.v1");
    expect(document.vectors.map(({ kind }) => kind)).toEqual(["model_evaluator_profile"]);
    const value = vector();
    const encoded = encodeModelEvaluatorProfileDefinition(value.input);
    expect(encoded.byteLength).toBe(value.encodedByteLength);
    expect(sha256(encoded)).toBe(value.sha256);
  });

  it("binds the profile domain, schema version, scope, model, prompts, tools, and budget", () => {
    const value = vector();
    const original = encodeModelEvaluatorProfileDefinition(value.input);
    const text = Buffer.from(original).toString("utf8");
    expect(text).toContain(MODEL_EVALUATOR_PROFILE_DEFINITION_DOMAIN);
    expect(text).toContain(`"schemaVersion":"${MODEL_EVALUATOR_PROFILE_SCHEMA_VERSION}"`);

    const mutations: ((candidate: ModelProfileVector["input"]) => void)[] = [
      (candidate) => {
        candidate.scope.tenantId = "ten_other";
      },
      (candidate) => {
        candidate.definition.provider.providerModelId = "other-model";
      },
      (candidate) => {
        const prompt = candidate.definition.prompts[0];
        if (!prompt) throw new Error("Expected a prompt");
        prompt.template.sha256 = "f".repeat(64);
      },
      (candidate) => {
        const tool = candidate.definition.toolContracts[0];
        if (!tool) throw new Error("Expected a tool contract");
        tool.sha256 = "e".repeat(64);
      },
      (candidate) => {
        candidate.definition.budgets.maximumCostMicrousd += 1;
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(value.input);
      mutate(changed);
      expect(encodeModelEvaluatorProfileDefinition(changed)).not.toEqual(original);
    }
  });

  it("normalizes insertion order and rejects server, credential, destination, and release fields", () => {
    const input = vector().input;
    const reordered = {
      definition: Object.fromEntries(Object.entries(input.definition).reverse()),
      scope: Object.fromEntries(Object.entries(input.scope).reverse()),
    } as unknown as typeof input;
    expect(encodeModelEvaluatorProfileDefinition(reordered)).toEqual(
      encodeModelEvaluatorProfileDefinition(input),
    );
    for (const forbidden of [
      { apiKey: "secret" },
      { endpoint: "https://example.invalid" },
      { publishedAt: "2026-09-02T00:00:00.000Z" },
      { releaseAuthority: "allow" },
    ]) {
      expect(() =>
        encodeModelEvaluatorProfileDefinition({
          ...input,
          definition: { ...input.definition, ...forbidden },
        } as never),
      ).toThrow();
    }
  });
});
