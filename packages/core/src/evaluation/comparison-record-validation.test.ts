import { readFileSync } from "node:fs";
import {
  COMPARISON_DEFINITION_SCHEMA_VERSION,
  COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
  COMPARISON_RESULT_SCHEMA_VERSION,
  type ComparisonDefinition,
  type ComparisonEvidenceSnapshot,
  type ComparisonResult,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  comparisonRecordId,
  digestComparisonRecordDefinition,
  validateComparisonRecord,
} from "./comparison-record-validation.js";
import { InvalidComparisonRecordInputError } from "./comparison-repository-errors.js";
import type { ComparisonRecordKind } from "./comparison-repository.js";

interface VectorDocument {
  readonly vectors: readonly {
    readonly input: {
      readonly definition: Record<string, unknown>;
      readonly scope: ComparisonDefinition["scope"];
    };
    readonly sha256: string;
  }[];
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`Expected ${key} in comparison vector`);
  return field;
}

function vector(filename: string) {
  const document = JSON.parse(
    readFileSync(new URL(`../../../contracts/vectors/${filename}`, import.meta.url), "utf8"),
  ) as VectorDocument;
  const first = document.vectors[0];
  if (!first) throw new Error(`Expected a vector in ${filename}`);
  return first;
}

const definitionVector = vector("evaluation-comparison-definition-v1.json");
const snapshotVector = vector("evaluation-comparison-snapshot-definition-v1.json");
const resultVector = vector("evaluation-comparison-result-definition-v1.json");

function records(): readonly {
  readonly id: string;
  readonly kind: ComparisonRecordKind;
  readonly record: ComparisonDefinition | ComparisonEvidenceSnapshot | ComparisonResult;
}[] {
  return [
    {
      id: stringField(definitionVector.input.definition, "comparisonVersionId"),
      kind: "comparison_definition",
      record: {
        ...structuredClone(definitionVector.input.definition),
        createdAt: "2026-09-02T03:00:00.000Z",
        createdByPrincipalId: "principal_operator",
        definitionSha256: definitionVector.sha256,
        schemaVersion: COMPARISON_DEFINITION_SCHEMA_VERSION,
        scope: structuredClone(definitionVector.input.scope),
      } as ComparisonDefinition,
    },
    {
      id: stringField(snapshotVector.input.definition, "snapshotId"),
      kind: "comparison_evidence_snapshot",
      record: {
        ...structuredClone(snapshotVector.input.definition),
        createdAt: "2026-09-02T03:00:00.000Z",
        createdByPrincipalId: "principal_operator",
        definitionSha256: snapshotVector.sha256,
        schemaVersion: COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
        scope: structuredClone(snapshotVector.input.scope),
      } as ComparisonEvidenceSnapshot,
    },
    {
      id: stringField(resultVector.input.definition, "resultId"),
      kind: "comparison_result",
      record: {
        ...structuredClone(resultVector.input.definition),
        createdAt: "2026-09-02T03:00:00.000Z",
        createdByPrincipalId: "principal_operator",
        definitionSha256: resultVector.sha256,
        schemaVersion: COMPARISON_RESULT_SCHEMA_VERSION,
        scope: structuredClone(resultVector.input.scope),
      } as ComparisonResult,
    },
  ];
}

describe("comparison record validation", () => {
  it("strict-parses and independently verifies every comparison record digest", () => {
    for (const fixture of records()) {
      const validated = validateComparisonRecord(fixture.kind, fixture.record);
      expect(validated).toEqual(fixture.record);
      expect(comparisonRecordId(fixture.kind, validated)).toBe(fixture.id);
      const definition = structuredClone(fixture.record) as unknown as Record<string, unknown>;
      for (const key of [
        "createdAt",
        "createdByPrincipalId",
        "definitionSha256",
        "schemaVersion",
        "scope",
      ]) {
        delete definition[key];
      }
      expect(digestComparisonRecordDefinition(fixture.kind, fixture.record.scope, definition)).toBe(
        fixture.record.definitionSha256,
      );
    }
  });

  it("rejects digest substitution and unknown stored fields", () => {
    for (const fixture of records()) {
      expect(() =>
        validateComparisonRecord(fixture.kind, {
          ...fixture.record,
          definitionSha256: "0".repeat(64),
        }),
      ).toThrowError(InvalidComparisonRecordInputError);
      expect(() =>
        validateComparisonRecord(fixture.kind, { ...fixture.record, hiddenDecision: "approve" }),
      ).toThrowError(InvalidComparisonRecordInputError);
    }
  });
});
