import { readFileSync } from "node:fs";
import type { EvidenceScope } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import type { EvaluationRecordKind } from "./evaluation-repository-errors.js";
import {
  digestEvaluationRecordDefinition,
  evaluationRecordId,
  evaluationResource,
  type EvaluationStoredRecord,
  validateEvaluationRecord,
} from "./evaluation-record-validation.js";

interface StoredVector {
  readonly input: { readonly definition: Record<string, unknown> };
  readonly kind: EvaluationRecordKind;
}

const vectorFiles = [
  "evaluation-source-definition-v1.json",
  "evaluation-criteria-definition-v1.json",
  "evaluation-spec-definition-v1.json",
  "evaluation-qualification-definition-v1.json",
  "evaluation-run-definition-v1.json",
  "evaluation-assessment-definition-v1.json",
] as const;

const vectors = vectorFiles.flatMap(
  (file) =>
    (
      JSON.parse(
        readFileSync(new URL(`../../../contracts/vectors/${file}`, import.meta.url), "utf8"),
      ) as { readonly vectors: readonly StoredVector[] }
    ).vectors,
);

const scope: EvidenceScope = {
  environmentId: "env_validation",
  projectId: "prj_validation",
  tenantId: "ten_validation",
};

function receipt(kind: EvaluationRecordKind): Record<string, unknown> {
  const principal = "usr_validation";
  const timestamp = "2026-09-02T00:00:00.000Z";
  switch (kind) {
    case "aggregation_policy":
    case "criterion_set":
    case "evaluator_spec":
    case "oracle_spec":
    case "qualification_fixture_set":
      return { publishedAt: timestamp, publishedByPrincipalId: principal };
    case "assessment":
    case "evaluation_aggregate":
    case "evaluation_run":
      return { createdAt: timestamp, createdByPrincipalId: principal };
    case "criterion_set_status":
    case "discovery_record":
    case "evaluation_run_result":
      return { recordedAt: timestamp, recordedByPrincipalId: principal };
    case "evaluation_run_rejection":
      return { recordedAt: timestamp, requestedByPrincipalId: principal };
    case "qualification_report":
      return { executedByPrincipalId: principal, recordedAt: timestamp };
    case "raw_observation":
      return { recordedAt: timestamp };
    case "source_review":
      return {
        reviewedAt: timestamp,
        reviewedByPrincipalId: principal,
        reviewerRole: "Independent validation reviewer",
      };
    case "source_snapshot":
      return { publishedByPrincipalId: principal, recordedAt: timestamp };
  }
}

function materialize(vector: StoredVector): EvaluationStoredRecord {
  const definition = structuredClone(vector.input.definition);
  return {
    ...definition,
    ...receipt(vector.kind),
    definitionSha256: digestEvaluationRecordDefinition(vector.kind, scope, definition),
    schemaVersion: "0.1",
    scope,
  } as EvaluationStoredRecord;
}

describe("evaluation record validation registry", () => {
  it("validates every record domain and projects its immutable identifier", () => {
    expect(vectors.map(({ kind }) => kind).sort()).toEqual([
      "aggregation_policy",
      "assessment",
      "criterion_set",
      "criterion_set_status",
      "discovery_record",
      "evaluation_aggregate",
      "evaluation_run",
      "evaluation_run_rejection",
      "evaluation_run_result",
      "evaluator_spec",
      "oracle_spec",
      "qualification_fixture_set",
      "qualification_report",
      "raw_observation",
      "source_review",
      "source_snapshot",
    ]);

    const identifiers = new Set<string>();
    for (const vector of vectors) {
      const parsed = validateEvaluationRecord(vector.kind, materialize(vector));
      identifiers.add(`${vector.kind}:${evaluationRecordId(vector.kind, parsed)}`);
    }
    expect(identifiers.size).toBe(vectors.length);
  });

  it("reports only the five tenant-wide versioned resource bindings", () => {
    const resources = vectors.flatMap((vector) => {
      const record = materialize(vector);
      const resource = evaluationResource(vector.kind, record);
      return resource ? [`${resource.kind}:${resource.resourceId}`] : [];
    });
    expect(resources).toEqual([
      "criterion_set:crs_response",
      "oracle:orc_schema",
      "evaluator:evl_schema",
      "qualification_fixture_set:qfs_schema",
      "aggregation_policy:agp_schema",
    ]);
  });
});
