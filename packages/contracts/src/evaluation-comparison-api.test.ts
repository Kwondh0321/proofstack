import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ComparisonRecordEnvelopeSchema,
  ComparisonRecordKindSchema,
  PublishComparisonRecordResponseSchema,
  ReadComparisonRecordResponseSchema,
} from "./evaluation-comparison-api.js";
import {
  COMPARISON_DEFINITION_SCHEMA_VERSION,
  COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
} from "./evaluation-comparison.js";
import { COMPARISON_RESULT_SCHEMA_VERSION } from "./evaluation-comparison-result.js";

interface VectorDocument {
  readonly vectors: readonly {
    readonly input: { readonly definition: Record<string, unknown>; readonly scope: unknown };
    readonly sha256: string;
  }[];
}

function record(filename: string, receipt: Record<string, unknown>): Record<string, unknown> {
  const document = JSON.parse(
    readFileSync(new URL(`../vectors/${filename}`, import.meta.url), "utf8"),
  ) as VectorDocument;
  const vector = document.vectors[0];
  if (!vector) throw new Error(`Expected ${filename}`);
  return {
    ...structuredClone(vector.input.definition),
    ...receipt,
    definitionSha256: vector.sha256,
    scope: structuredClone(vector.input.scope),
  };
}

const definition = record("evaluation-comparison-definition-v1.json", {
  createdAt: "2026-09-02T04:00:00.000Z",
  createdByPrincipalId: "usr_comparison_api",
  schemaVersion: COMPARISON_DEFINITION_SCHEMA_VERSION,
});
const snapshot = record("evaluation-comparison-snapshot-definition-v1.json", {
  createdAt: "2026-09-02T04:00:00.000Z",
  createdByPrincipalId: "usr_comparison_api",
  schemaVersion: COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
});
const result = record("evaluation-comparison-result-definition-v1.json", {
  createdAt: "2026-09-02T04:00:00.000Z",
  createdByPrincipalId: "usr_comparison_api",
  schemaVersion: COMPARISON_RESULT_SCHEMA_VERSION,
});

describe("comparison API contracts", () => {
  it("keeps the immutable record kinds explicit and ordered", () => {
    expect(ComparisonRecordKindSchema.options).toEqual([
      "comparison_definition",
      "comparison_evidence_snapshot",
      "comparison_result",
    ]);
  });

  it.each([
    ["comparison_definition", definition],
    ["comparison_evidence_snapshot", snapshot],
    ["comparison_result", result],
  ] as const)("accepts an exact %s response envelope", (kind, value) => {
    const envelope = { kind, record: value };
    expect(ComparisonRecordEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(
      PublishComparisonRecordResponseSchema.parse({
        created: true,
        requestId: "req_comparison_api",
        result: envelope,
      }),
    ).toMatchObject({ created: true, result: { kind } });
    expect(
      ReadComparisonRecordResponseSchema.parse({
        requestId: "req_comparison_api",
        result: envelope,
      }),
    ).toMatchObject({ result: { kind } });
  });

  it("rejects unknown kinds, fields, and record-kind substitution", () => {
    expect(() =>
      ComparisonRecordEnvelopeSchema.parse({ kind: "comparison_unknown", record: definition }),
    ).toThrow();
    expect(() =>
      ComparisonRecordEnvelopeSchema.parse({
        kind: "comparison_definition",
        record: snapshot,
      }),
    ).toThrow();
    expect(() =>
      PublishComparisonRecordResponseSchema.parse({
        created: true,
        requestId: "req_comparison_api",
        result: { kind: "comparison_result", record: result },
        secret: "not-public",
      }),
    ).toThrow();
  });
});
