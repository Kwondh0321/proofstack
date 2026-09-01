import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BLINDED_EVALUATION_RESULT_SCHEMA_VERSION,
  type BlindedEvaluationResultDefinition,
} from "./evaluation-model-assurance.js";
import {
  BLINDED_EVALUATION_RESULT_DEFINITION_DOMAIN,
  encodeBlindedEvaluationResultDefinition,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";

interface ResultVector {
  readonly encodedByteLength: number;
  readonly input: ScopedEvaluationDefinition<BlindedEvaluationResultDefinition>;
  readonly kind: "blinded_evaluation_result";
  readonly name: string;
  readonly sha256: string;
}

interface VectorDocument {
  readonly format: string;
  readonly vectors: readonly ResultVector[];
}

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/evaluation-blinded-result-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as VectorDocument;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function vector(): ResultVector {
  const value = document.vectors[0];
  if (!value) throw new Error("Expected a blinded evaluation result vector");
  return value;
}

describe("canonical blinded evaluation result encoding", () => {
  it("matches the fixed public UTF-8 and SHA-256 vector", () => {
    expect(document.format).toBe("proofstack.evaluation-blinded-result-definition.v1");
    expect(document.vectors.map(({ kind }) => kind)).toEqual(["blinded_evaluation_result"]);
    const value = vector();
    const encoded = encodeBlindedEvaluationResultDefinition(value.input);
    expect(encoded.byteLength).toBe(value.encodedByteLength);
    expect(sha256(encoded)).toBe(value.sha256);
  });

  it("binds both attempts, their observations, rationales, order comparison, and unblinding", () => {
    const value = vector();
    const original = encodeBlindedEvaluationResultDefinition(value.input);
    const text = Buffer.from(original).toString("utf8");
    expect(text).toContain(BLINDED_EVALUATION_RESULT_DEFINITION_DOMAIN);
    expect(text).toContain(`"schemaVersion":"${BLINDED_EVALUATION_RESULT_SCHEMA_VERSION}"`);
    const changed = structuredClone(value.input);
    const attempt = changed.definition.attempts[0];
    if (attempt?.status !== "completed") throw new Error("Expected completed attempt");
    attempt.rationale.sha256 = "f".repeat(64);
    expect(encodeBlindedEvaluationResultDefinition(changed)).not.toEqual(original);
  });
});
