import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INDEPENDENT_CRITIQUE_SCHEMA_VERSION,
  type IndependentCritiqueDefinition,
} from "./evaluation-model-assurance.js";
import {
  encodeIndependentCritiqueDefinition,
  INDEPENDENT_CRITIQUE_DEFINITION_DOMAIN,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";

interface CritiqueVector {
  readonly encodedByteLength: number;
  readonly input: ScopedEvaluationDefinition<IndependentCritiqueDefinition>;
  readonly kind: "independent_critique";
  readonly name: string;
  readonly sha256: string;
}

interface VectorDocument {
  readonly format: string;
  readonly vectors: readonly CritiqueVector[];
}

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/evaluation-independent-critique-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as VectorDocument;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function vector(): CritiqueVector {
  const value = document.vectors[0];
  if (!value) throw new Error("Expected an independent critique vector");
  return value;
}

describe("canonical independent critique encoding", () => {
  it("matches the fixed public UTF-8 and SHA-256 vector", () => {
    expect(document.format).toBe("proofstack.evaluation-independent-critique-definition.v1");
    expect(document.vectors.map(({ kind }) => kind)).toEqual(["independent_critique"]);
    const value = vector();
    const encoded = encodeIndependentCritiqueDefinition(value.input);
    expect(encoded.byteLength).toBe(value.encodedByteLength);
    expect(sha256(encoded)).toBe(value.sha256);
  });

  it("binds the domain, scope, observation, allowed evidence, withholding, and outcome", () => {
    const value = vector();
    const original = encodeIndependentCritiqueDefinition(value.input);
    const text = Buffer.from(original).toString("utf8");
    expect(text).toContain(INDEPENDENT_CRITIQUE_DEFINITION_DOMAIN);
    expect(text).toContain(`"schemaVersion":"${INDEPENDENT_CRITIQUE_SCHEMA_VERSION}"`);

    const mutations: ((candidate: CritiqueVector["input"]) => void)[] = [
      (candidate) => {
        candidate.scope.tenantId = "ten_other";
      },
      (candidate) => {
        candidate.definition.observation.definitionSha256 = "f".repeat(64);
      },
      (candidate) => {
        const evidence = candidate.definition.allowedEvidence[0];
        if (!evidence) throw new Error("Expected allowed evidence");
        evidence.sha256 = "e".repeat(64);
      },
      (candidate) => {
        candidate.definition.accessAttestation.evidence.sha256 = "d".repeat(64);
      },
      (candidate) => {
        if (candidate.definition.outcome.status !== "produced") {
          throw new Error("Expected produced outcome");
        }
        candidate.definition.outcome.output.sha256 = "c".repeat(64);
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(value.input);
      mutate(changed);
      expect(encodeIndependentCritiqueDefinition(changed)).not.toEqual(original);
    }
  });

  it("rejects original rationale, verdict, adjudication, and release fields", () => {
    const input = vector().input;
    for (const forbidden of [
      { originalRationale: "revealed" },
      { originalVerdict: "pass" },
      { adjudication: "accept" },
      { releaseAuthority: "allow" },
    ]) {
      expect(() =>
        encodeIndependentCritiqueDefinition({
          ...input,
          definition: { ...input.definition, ...forbidden },
        } as never),
      ).toThrow();
    }
  });
});
