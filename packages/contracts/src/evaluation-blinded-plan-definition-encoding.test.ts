import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BLINDED_EVALUATION_PLAN_SCHEMA_VERSION,
  type BlindedEvaluationPlanDefinition,
} from "./evaluation-model-assurance.js";
import {
  BLINDED_EVALUATION_PLAN_DEFINITION_DOMAIN,
  encodeBlindedEvaluationPlanDefinition,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";

interface Vector {
  readonly encodedByteLength: number;
  readonly input: ScopedEvaluationDefinition<BlindedEvaluationPlanDefinition>;
  readonly kind: "blinded_evaluation_plan";
  readonly name: string;
  readonly sha256: string;
}

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/evaluation-blinded-plan-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as { readonly format: string; readonly vectors: readonly Vector[] };

function vector(): Vector {
  const value = document.vectors[0];
  if (!value) throw new Error("Expected a blinded evaluation plan vector");
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("canonical blinded evaluation plan encoding", () => {
  it("matches the fixed public UTF-8 and SHA-256 vector", () => {
    expect(document.format).toBe("proofstack.evaluation-blinded-plan-definition.v1");
    const value = vector();
    const bytes = encodeBlindedEvaluationPlanDefinition(value.input);
    expect(bytes.byteLength).toBe(value.encodedByteLength);
    expect(sha256(bytes)).toBe(value.sha256);
  });

  it("binds subjects, blind map, both orders, attempts, leakage evidence, and evaluator lineage", () => {
    const value = vector();
    const original = encodeBlindedEvaluationPlanDefinition(value.input);
    const text = Buffer.from(original).toString("utf8");
    expect(text).toContain(BLINDED_EVALUATION_PLAN_DEFINITION_DOMAIN);
    expect(text).toContain(`"schemaVersion":"${BLINDED_EVALUATION_PLAN_SCHEMA_VERSION}"`);

    const mutations: ((candidate: Vector["input"]) => void)[] = [
      (candidate) => {
        candidate.scope.environmentId = "env_other";
      },
      (candidate) => {
        candidate.definition.blindMap.sha256 = "f".repeat(64);
      },
      (candidate) => {
        const attempt = candidate.definition.attempts[0];
        if (!attempt) throw new Error("Expected a blinded attempt");
        attempt.seed += 1;
      },
      (candidate) => {
        const check = candidate.definition.leakageChecks[0];
        if (!check) throw new Error("Expected a leakage check");
        check.evidence.sha256 = "e".repeat(64);
      },
      (candidate) => {
        candidate.definition.calibrationReport.definitionSha256 = "d".repeat(64);
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(value.input);
      mutate(changed);
      expect(encodeBlindedEvaluationPlanDefinition(changed)).not.toEqual(original);
    }
  });

  it("rejects early unblinding, unfavorable-order deletion, and release authority", () => {
    const input = vector().input;
    for (const forbidden of [
      { dropUnfavorableOrder: true },
      { releaseAuthority: "allow" },
      { unblindBeforeEvaluation: true },
    ]) {
      expect(() =>
        encodeBlindedEvaluationPlanDefinition({
          ...input,
          definition: { ...input.definition, ...forbidden },
        } as never),
      ).toThrow();
    }
  });
});
