import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MODEL_QUALIFICATION_SUITE_SCHEMA_VERSION,
  type ModelQualificationSuiteDefinition,
} from "./evaluation-model-qualification.js";
import {
  encodeModelQualificationSuiteDefinition,
  MODEL_QUALIFICATION_SUITE_DEFINITION_DOMAIN,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";

interface SuiteVector {
  readonly encodedByteLength: number;
  readonly input: ScopedEvaluationDefinition<ModelQualificationSuiteDefinition>;
  readonly kind: "model_qualification_suite";
  readonly name: string;
  readonly sha256: string;
}

interface VectorDocument {
  readonly format: string;
  readonly vectors: readonly SuiteVector[];
}

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/evaluation-model-qualification-suite-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as VectorDocument;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function vector(): SuiteVector {
  const value = document.vectors[0];
  if (!value) throw new Error("Expected a model qualification suite vector");
  return value;
}

describe("canonical model qualification suite encoding", () => {
  it("matches the fixed public UTF-8 and SHA-256 vector", () => {
    expect(document.format).toBe("proofstack.evaluation-model-qualification-suite-definition.v1");
    expect(document.vectors.map(({ kind }) => kind)).toEqual(["model_qualification_suite"]);
    const value = vector();
    const encoded = encodeModelQualificationSuiteDefinition(value.input);
    expect(encoded.byteLength).toBe(value.encodedByteLength);
    expect(sha256(encoded)).toBe(value.sha256);
  });

  it("binds scope, model, corpus, complete scenarios, blind plan, and finite execution policy", () => {
    const value = vector();
    const original = encodeModelQualificationSuiteDefinition(value.input);
    const text = Buffer.from(original).toString("utf8");
    expect(text).toContain(MODEL_QUALIFICATION_SUITE_DEFINITION_DOMAIN);
    expect(text).toContain(`"schemaVersion":"${MODEL_QUALIFICATION_SUITE_SCHEMA_VERSION}"`);

    const mutations: ((candidate: SuiteVector["input"]) => void)[] = [
      (candidate) => {
        candidate.scope.tenantId = "ten_other";
      },
      (candidate) => {
        candidate.definition.modelProfile.definitionSha256 = "f".repeat(64);
      },
      (candidate) => {
        candidate.definition.caseManifest.sha256 = "e".repeat(64);
      },
      (candidate) => {
        candidate.definition.blindedPlan.definitionSha256 = "d".repeat(64);
      },
      (candidate) => {
        candidate.definition.executionPolicy.stochasticVarianceAttemptsPerCase += 1;
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(value.input);
      mutate(changed);
      expect(encodeModelQualificationSuiteDefinition(changed)).not.toEqual(original);
    }
  });
});
