import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPARISON_DEFINITION_SCHEMA_VERSION,
  type ComparisonDefinitionInput,
} from "./evaluation-comparison.js";
import {
  COMPARISON_DEFINITION_DOMAIN,
  encodeComparisonDefinition,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";

interface ComparisonVector {
  readonly encodedByteLength: number;
  readonly input: ScopedEvaluationDefinition<ComparisonDefinitionInput>;
  readonly kind: "comparison_definition";
  readonly name: string;
  readonly sha256: string;
}

interface VectorDocument {
  readonly format: string;
  readonly vectors: readonly ComparisonVector[];
}

const document = JSON.parse(
  readFileSync(
    new URL("../vectors/evaluation-comparison-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as VectorDocument;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function vector(): ComparisonVector {
  const value = document.vectors[0];
  if (!value) throw new Error("Expected a comparison definition vector");
  return value;
}

describe("canonical comparison definition encoding", () => {
  it("matches the fixed public UTF-8 and SHA-256 vector", () => {
    expect(document.format).toBe("proofstack.evaluation-comparison-definition.v1");
    expect(document.vectors.map(({ kind }) => kind)).toEqual(["comparison_definition"]);
    const value = vector();
    const encoded = encodeComparisonDefinition(value.input);
    expect(encoded.byteLength).toBe(value.encodedByteLength);
    expect(sha256(encoded)).toBe(value.sha256);
  });

  it("binds domain, schema, scope, both roles, exact lineage, metrics, and calculation policy", () => {
    const value = vector();
    const original = encodeComparisonDefinition(value.input);
    const text = Buffer.from(original).toString("utf8");
    expect(text).toContain(COMPARISON_DEFINITION_DOMAIN);
    expect(text).toContain(`"schemaVersion":"${COMPARISON_DEFINITION_SCHEMA_VERSION}"`);
    expect(text).toContain('"denominators":"role_fixture_membership_and_paired_observations"');
    expect(text).toContain('"invalidCases":"preserve_and_exclude_from_aggregation"');
    expect(text).toContain('"numericObservationMultiplicity":"at_most_one_per_fixture"');

    const mutations: ((candidate: ComparisonVector["input"]) => void)[] = [
      (candidate) => {
        candidate.scope.tenantId = "tenant_other";
      },
      (candidate) => {
        candidate.definition.baseline.dataset.definitionSha256 = "e".repeat(64);
      },
      (candidate) => {
        const fixture = candidate.definition.candidate.fixtures[0];
        if (!fixture) throw new Error("Expected a candidate fixture");
        fixture.replay.result.sha256 = "f".repeat(64);
      },
      (candidate) => {
        const assessment = candidate.definition.baseline.fixtures[0]?.assessments[0];
        if (!assessment) throw new Error("Expected a baseline assessment");
        assessment.definitionSha256 = "0".repeat(64);
      },
      (candidate) => {
        const metric = candidate.definition.metrics[0];
        if (metric?.kind !== "replay_usage") throw new Error("Expected usage metric");
        metric.aggregation = { method: "maximum", methodVersion: "1.0.0" };
      },
      (candidate) => {
        candidate.definition.calculationPolicy.minimumPairedCoverageBasisPoints = 9_000;
      },
      (candidate) => {
        candidate.definition.calculationPolicy.missingness = "preserve_all";
        candidate.definition.classifiedContentProjection = "metadata_only";
        candidate.definition.name = "Changed exact comparison";
      },
      (candidate) => {
        const stratum = candidate.definition.strata[0];
        if (!stratum) throw new Error("Expected comparison stratum");
        stratum.label = "Changed population";
      },
      (candidate) => {
        const metric = candidate.definition.metrics[0];
        const stratum = candidate.definition.strata[0];
        if (!metric || !stratum) throw new Error("Expected comparison metric and stratum");
        stratum.stratumId = "stratum_other";
        metric.stratumId = "stratum_other";
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(value.input);
      mutate(changed);
      expect(encodeComparisonDefinition(changed)).not.toEqual(original);
    }
  });

  it("normalizes insertion order and rejects derived, credential, policy, and release fields", () => {
    const input = vector().input;
    const reordered = {
      definition: Object.fromEntries(Object.entries(input.definition).reverse()),
      scope: Object.fromEntries(Object.entries(input.scope).reverse()),
    } as unknown as typeof input;
    expect(encodeComparisonDefinition(reordered)).toEqual(encodeComparisonDefinition(input));

    for (const forbidden of [
      { apiKey: "secret" },
      { comparability: "comparable" },
      { delta: "1" },
      { policyThreshold: "0.95" },
      { releaseDecision: "approve" },
    ]) {
      expect(() =>
        encodeComparisonDefinition({
          ...input,
          definition: { ...input.definition, ...forbidden },
        } as never),
      ).toThrow();
    }
  });
});
