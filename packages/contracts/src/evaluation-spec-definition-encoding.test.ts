import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EVALUATOR_SPEC_SCHEMA_VERSION,
  type EvaluatorSpecDefinition,
  ORACLE_SPEC_SCHEMA_VERSION,
  type OracleSpecDefinition,
} from "./evaluation-spec.js";
import {
  encodeEvaluatorSpecDefinition,
  encodeOracleSpecDefinition,
  EVALUATOR_SPEC_DEFINITION_DOMAIN,
  ORACLE_SPEC_DEFINITION_DOMAIN,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";

interface StaticVectorBase {
  readonly encodedByteLength: number;
  readonly name: string;
  readonly sha256: string;
}

interface OracleVector extends StaticVectorBase {
  readonly input: ScopedEvaluationDefinition<OracleSpecDefinition>;
  readonly kind: "oracle_spec";
}

interface EvaluatorVector extends StaticVectorBase {
  readonly input: ScopedEvaluationDefinition<EvaluatorSpecDefinition>;
  readonly kind: "evaluator_spec";
}

type StaticVector = OracleVector | EvaluatorVector;

const vectorsDocument = JSON.parse(
  readFileSync(new URL("../vectors/evaluation-spec-definition-v1.json", import.meta.url), "utf8"),
) as {
  readonly format: string;
  readonly vectors: readonly StaticVector[];
};

function encode(vector: StaticVector): Uint8Array {
  return vector.kind === "oracle_spec"
    ? encodeOracleSpecDefinition(vector.input)
    : encodeEvaluatorSpecDefinition(vector.input);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireVector<Kind extends StaticVector["kind"]>(kind: Kind) {
  const vector = vectorsDocument.vectors.find((candidate) => candidate.kind === kind);
  if (!vector) throw new Error(`Expected a ${kind} vector`);
  return vector as Extract<StaticVector, { readonly kind: Kind }>;
}

describe("canonical non-model evaluation specification encoding", () => {
  it("matches fixed UTF-8 and SHA-256 vectors", () => {
    expect(vectorsDocument.format).toBe("proofstack.evaluation-spec-definition.v1");
    expect(vectorsDocument.vectors.map(({ kind }) => kind)).toEqual([
      "oracle_spec",
      "evaluator_spec",
    ]);
    for (const vector of vectorsDocument.vectors) {
      const encoded = encode(vector);
      expect(encoded.byteLength, vector.name).toBe(vector.encodedByteLength);
      expect(sha256(encoded), vector.name).toBe(vector.sha256);
    }
  });

  it("separates oracle and evaluator domains and binds their schema versions", () => {
    const oracleText = Buffer.from(encode(requireVector("oracle_spec"))).toString("utf8");
    const evaluatorText = Buffer.from(encode(requireVector("evaluator_spec"))).toString("utf8");
    expect(oracleText).toContain(ORACLE_SPEC_DEFINITION_DOMAIN);
    expect(evaluatorText).toContain(EVALUATOR_SPEC_DEFINITION_DOMAIN);
    expect(oracleText).toContain(`"schemaVersion":"${ORACLE_SPEC_SCHEMA_VERSION}"`);
    expect(evaluatorText).toContain(`"schemaVersion":"${EVALUATOR_SPEC_SCHEMA_VERSION}"`);
  });

  it("changes bytes for implementation, runtime, independence, oracle, and scope lineage", () => {
    const oracle = requireVector("oracle_spec");
    const originalOracle = encode(oracle);
    const implementationChanged = structuredClone(oracle);
    implementationChanged.input.definition.implementation.implementationSha256 = "f".repeat(64);
    expect(encode(implementationChanged)).not.toEqual(originalOracle);
    const runtimeChanged = structuredClone(oracle);
    if (runtimeChanged.input.definition.runtimePolicy.seed.mode !== "fixed") {
      throw new Error("Expected a fixed seed");
    }
    runtimeChanged.input.definition.runtimePolicy.seed.value = 43;
    expect(encode(runtimeChanged)).not.toEqual(originalOracle);

    const evaluator = requireVector("evaluator_spec");
    const originalEvaluator = encode(evaluator);
    const independenceChanged = structuredClone(evaluator);
    independenceChanged.input.definition.independenceGroup.labelSourceIds = ["lbl_other"];
    expect(encode(independenceChanged)).not.toEqual(originalEvaluator);
    const oracleChanged = structuredClone(evaluator);
    const oracleReference = oracleChanged.input.definition.oracles[0];
    if (!oracleReference) throw new Error("Expected an oracle reference");
    oracleReference.definitionSha256 = "e".repeat(64);
    expect(encode(oracleChanged)).not.toEqual(originalEvaluator);
    const scopeChanged = structuredClone(evaluator);
    scopeChanged.input.scope.projectId = "prj_other";
    expect(encode(scopeChanged)).not.toEqual(originalEvaluator);
  });

  it("normalizes insertion order and rejects mutable publication or executable authority", () => {
    const oracle = requireVector("oracle_spec").input;
    const reordered = {
      definition: Object.fromEntries(Object.entries(oracle.definition).reverse()),
      scope: Object.fromEntries(Object.entries(oracle.scope).reverse()),
    } as unknown as typeof oracle;
    expect(encodeOracleSpecDefinition(reordered)).toEqual(encodeOracleSpecDefinition(oracle));
    expect(() =>
      encodeOracleSpecDefinition({ ...oracle, publishedAt: "hidden" } as never),
    ).toThrow();
    expect(() =>
      encodeOracleSpecDefinition({
        ...oracle,
        definition: {
          ...oracle.definition,
          runtimePolicy: { ...oracle.definition.runtimePolicy, network: "allowed" },
        },
      } as never),
    ).toThrow();

    const evaluator = requireVector("evaluator_spec").input;
    expect(() =>
      encodeEvaluatorSpecDefinition({
        ...evaluator,
        definition: { ...evaluator.definition, releaseAuthority: "allow" },
      } as never),
    ).toThrow();
  });
});
