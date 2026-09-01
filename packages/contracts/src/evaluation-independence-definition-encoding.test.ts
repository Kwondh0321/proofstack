import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INDEPENDENCE_DECLARATION_SCHEMA_VERSION,
  type IndependenceDeclarationDefinition,
} from "./evaluation-model-assurance.js";
import {
  encodeIndependenceDeclarationDefinition,
  INDEPENDENCE_DECLARATION_DEFINITION_DOMAIN,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";

interface Vector {
  readonly encodedByteLength: number;
  readonly input: ScopedEvaluationDefinition<IndependenceDeclarationDefinition>;
  readonly kind: "independence_declaration";
  readonly name: string;
  readonly sha256: string;
}

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/evaluation-independence-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as { readonly format: string; readonly vectors: readonly Vector[] };

function vector(): Vector {
  const value = document.vectors[0];
  if (!value) throw new Error("Expected an independence declaration vector");
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("canonical independence declaration encoding", () => {
  it("matches the fixed public UTF-8 and SHA-256 vector", () => {
    expect(document.format).toBe("proofstack.evaluation-independence-definition.v1");
    const value = vector();
    const bytes = encodeIndependenceDeclarationDefinition(value.input);
    expect(bytes.byteLength).toBe(value.encodedByteLength);
    expect(sha256(bytes)).toBe(value.sha256);
  });

  it("binds domain, schema, scope, subject, every material dimension, conflicts, and review", () => {
    const value = vector();
    const original = encodeIndependenceDeclarationDefinition(value.input);
    const text = Buffer.from(original).toString("utf8");
    expect(text).toContain(INDEPENDENCE_DECLARATION_DEFINITION_DOMAIN);
    expect(text).toContain(`"schemaVersion":"${INDEPENDENCE_DECLARATION_SCHEMA_VERSION}"`);

    const mutations: ((candidate: Vector["input"]) => void)[] = [
      (candidate) => {
        candidate.scope.environmentId = "env_other";
      },
      (candidate) => {
        candidate.definition.subject.evaluator.definitionSha256 = "f".repeat(64);
      },
      (candidate) => {
        candidate.definition.dimensions.providers = {
          reason: "Provider lineage unavailable",
          status: "unknown",
        };
        candidate.definition.reviewStatus = "unverifiable";
      },
      (candidate) => {
        candidate.definition.declaredConflicts = ["A different material conflict"];
      },
      (candidate) => {
        candidate.definition.reviewedByPrincipalId = "usr_other";
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(value.input);
      mutate(changed);
      expect(encodeIndependenceDeclarationDefinition(changed)).not.toEqual(original);
    }
  });

  it("rejects caller-owned conclusions, correlation waivers, and release authority", () => {
    const input = vector().input;
    for (const forbidden of [
      { independent: true },
      { releaseAuthority: "allow" },
      { waiveCorrelation: true },
    ]) {
      expect(() =>
        encodeIndependenceDeclarationDefinition({
          ...input,
          definition: { ...input.definition, ...forbidden },
        } as never),
      ).toThrow();
    }
  });
});
