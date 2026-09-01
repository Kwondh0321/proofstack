import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CRITERION_SET_SCHEMA_VERSION,
  CRITERION_SET_STATUS_SCHEMA_VERSION,
  type CriterionSetDefinition,
  type CriterionSetStatusDefinition,
} from "./evaluation-criteria.js";
import {
  CRITERION_SET_DEFINITION_DOMAIN,
  CRITERION_SET_STATUS_DEFINITION_DOMAIN,
  encodeCriterionSetDefinition,
  encodeCriterionSetStatusDefinition,
  type ScopedEvaluationDefinition,
} from "./evaluation-definition-encoding.js";

interface StaticVectorBase {
  readonly encodedByteLength: number;
  readonly name: string;
  readonly sha256: string;
}

interface CriterionSetVector extends StaticVectorBase {
  readonly input: ScopedEvaluationDefinition<CriterionSetDefinition>;
  readonly kind: "criterion_set";
}

interface CriterionSetStatusVector extends StaticVectorBase {
  readonly input: ScopedEvaluationDefinition<CriterionSetStatusDefinition>;
  readonly kind: "criterion_set_status";
}

type StaticVector = CriterionSetVector | CriterionSetStatusVector;

const vectorsDocument = JSON.parse(
  readFileSync(
    new URL("../vectors/evaluation-criteria-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly format: string;
  readonly vectors: readonly StaticVector[];
};

function encode(vector: StaticVector): Uint8Array {
  switch (vector.kind) {
    case "criterion_set":
      return encodeCriterionSetDefinition(vector.input);
    case "criterion_set_status":
      return encodeCriterionSetStatusDefinition(vector.input);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireAt<Value>(values: readonly Value[], index: number, label: string): Value {
  const value = values[index];
  if (!value) throw new Error(`Expected ${label} at index ${index}`);
  return value;
}

function requireVector<Kind extends StaticVector["kind"]>(kind: Kind) {
  const vector = vectorsDocument.vectors.find((candidate) => candidate.kind === kind);
  if (!vector) throw new Error(`Expected a ${kind} vector`);
  return vector as Extract<StaticVector, { readonly kind: Kind }>;
}

describe("canonical evaluation criteria definition encoding", () => {
  it("matches independent fixed UTF-8 and SHA-256 vectors", () => {
    expect(vectorsDocument.format).toBe("proofstack.evaluation-criteria-definition.v1");
    expect(vectorsDocument.vectors.map(({ kind }) => kind)).toEqual([
      "criterion_set",
      "criterion_set_status",
    ]);

    for (const vector of vectorsDocument.vectors) {
      const encoded = encode(vector);
      expect(encoded.byteLength, vector.name).toBe(vector.encodedByteLength);
      expect(sha256(encoded), vector.name).toBe(vector.sha256);
    }
  });

  it("uses distinct domains while retaining exact scope and schema lineage", () => {
    const criterionBytes = encode(requireVector("criterion_set"));
    const statusBytes = encode(requireVector("criterion_set_status"));
    const criterionText = Buffer.from(criterionBytes).toString("utf8");
    const statusText = Buffer.from(statusBytes).toString("utf8");

    expect(criterionBytes).not.toEqual(statusBytes);
    expect(criterionText).toContain(CRITERION_SET_DEFINITION_DOMAIN);
    expect(statusText).toContain(CRITERION_SET_STATUS_DEFINITION_DOMAIN);
    expect(criterionText).toContain(`"schemaVersion":"${CRITERION_SET_SCHEMA_VERSION}"`);
    expect(statusText).toContain(`"schemaVersion":"${CRITERION_SET_STATUS_SCHEMA_VERSION}"`);
  });

  it("changes bytes for criterion, applicability, source review, lifecycle, and tenant lineage", () => {
    const criterion = requireVector("criterion_set");
    const originalCriterion = encode(criterion);
    const mutations: Array<(value: CriterionSetVector) => void> = [
      (value) => {
        value.input.scope.tenantId = "ten_other";
      },
      (value) => {
        requireAt(value.input.definition.criteria, 0, "criterion").claim =
          "The replay result conforms to a different approved response contract.";
      },
      (value) => {
        const applicability = requireAt(
          value.input.definition.criteria,
          0,
          "criterion",
        ).applicability;
        if (applicability.operator !== "allOf") throw new Error("Expected allOf applicability");
        const condition = applicability.operands[0];
        if (!condition || !("value" in condition)) throw new Error("Expected leaf condition");
        condition.value = "env_other";
      },
      (value) => {
        requireAt(value.input.definition.sources, 0, "source").review.definitionSha256 = "f".repeat(
          64,
        );
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(criterion);
      mutate(changed);
      expect(encode(changed)).not.toEqual(originalCriterion);
    }

    const status = requireVector("criterion_set_status");
    const changedStatus = structuredClone(status);
    const previousStatus = changedStatus.input.definition.previousStatus;
    if (!previousStatus) throw new Error("Expected previous status lineage");
    previousStatus.definitionSha256 = "d".repeat(64);
    expect(encode(changedStatus)).not.toEqual(encode(status));
  });

  it("normalizes object insertion order but preserves validated semantic array order", () => {
    const vector = requireVector("criterion_set");
    const reordered = {
      definition: Object.fromEntries(Object.entries(vector.input.definition).reverse()),
      scope: Object.fromEntries(Object.entries(vector.input.scope).reverse()),
    } as unknown as typeof vector.input;
    expect(encodeCriterionSetDefinition(reordered)).toEqual(
      encodeCriterionSetDefinition(vector.input),
    );

    const reversedSources = structuredClone(vector.input);
    reversedSources.definition.sources.reverse();
    expect(() => encodeCriterionSetDefinition(reversedSources)).toThrow();
  });

  it("rejects server metadata and unknown authority fields", () => {
    const criterion = requireVector("criterion_set").input;
    expect(() =>
      encodeCriterionSetDefinition({ ...criterion, publishedAt: "hidden" } as never),
    ).toThrow();
    expect(() =>
      encodeCriterionSetDefinition({
        ...criterion,
        definition: { ...criterion.definition, releaseDecision: "allow" },
      } as never),
    ).toThrow();

    const status = requireVector("criterion_set_status").input;
    expect(() =>
      encodeCriterionSetStatusDefinition({
        ...status,
        definition: { ...status.definition, approvedBy: "usr_hidden" },
      } as never),
    ).toThrow();
  });
});
