import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CreateAssessmentRequestSchema,
  CreateEvaluationAggregateRequestSchema,
  EvaluationRecordEnvelopeSchema,
  type EvaluationRecordKind,
  PublishEvaluationDefinitionRequestSchema,
  PublishEvaluationRecordResponseSchema,
  ReadEvaluationRecordResponseSchema,
  RecordCriterionSetStatusRequestSchema,
  RecordEvaluationRunDecisionRequestSchema,
  RecordEvaluationRunResultRequestSchema,
  RecordRawObservationRequestSchema,
} from "./evaluation-api.js";

interface StoredVector {
  readonly input: {
    readonly definition: Record<string, unknown>;
    readonly scope: Record<string, unknown>;
  };
  readonly kind: EvaluationRecordKind;
  readonly sha256: string;
}

const vectors = [
  "evaluation-source-definition-v1.json",
  "evaluation-criteria-definition-v1.json",
  "evaluation-spec-definition-v1.json",
  "evaluation-qualification-definition-v1.json",
  "evaluation-run-definition-v1.json",
  "evaluation-assessment-definition-v1.json",
].flatMap(
  (file) =>
    (
      JSON.parse(readFileSync(new URL(`../vectors/${file}`, import.meta.url), "utf8")) as {
        readonly vectors: readonly StoredVector[];
      }
    ).vectors,
);

function requestSchema(kind: EvaluationRecordKind) {
  switch (kind) {
    case "aggregation_policy":
    case "criterion_set":
    case "discovery_record":
    case "evaluator_spec":
    case "oracle_spec":
    case "qualification_fixture_set":
    case "qualification_report":
    case "source_review":
    case "source_snapshot":
      return PublishEvaluationDefinitionRequestSchema;
    case "criterion_set_status":
      return RecordCriterionSetStatusRequestSchema;
    case "evaluation_run":
    case "evaluation_run_rejection":
      return RecordEvaluationRunDecisionRequestSchema;
    case "raw_observation":
      return RecordRawObservationRequestSchema;
    case "evaluation_run_result":
      return RecordEvaluationRunResultRequestSchema;
    case "evaluation_aggregate":
      return CreateEvaluationAggregateRequestSchema;
    case "assessment":
      return CreateAssessmentRequestSchema;
  }
}

function receipt(kind: EvaluationRecordKind): Record<string, unknown> {
  const principalId = "usr_evaluation_api";
  const timestamp = "2026-09-02T00:00:00.000Z";
  switch (kind) {
    case "aggregation_policy":
    case "criterion_set":
    case "evaluator_spec":
    case "oracle_spec":
    case "qualification_fixture_set":
      return { publishedAt: timestamp, publishedByPrincipalId: principalId };
    case "assessment":
    case "evaluation_aggregate":
    case "evaluation_run":
      return { createdAt: timestamp, createdByPrincipalId: principalId };
    case "criterion_set_status":
    case "discovery_record":
    case "evaluation_run_result":
      return { recordedAt: timestamp, recordedByPrincipalId: principalId };
    case "evaluation_run_rejection":
      return { recordedAt: timestamp, requestedByPrincipalId: principalId };
    case "qualification_report":
      return { executedByPrincipalId: principalId, recordedAt: timestamp };
    case "raw_observation":
      return { recordedAt: timestamp };
    case "source_review":
      return {
        reviewedAt: timestamp,
        reviewedByPrincipalId: principalId,
        reviewerRole: "Independent API contract reviewer",
      };
    case "source_snapshot":
      return { publishedByPrincipalId: principalId, recordedAt: timestamp };
  }
}

function record(vector: StoredVector) {
  return {
    ...structuredClone(vector.input.definition),
    ...receipt(vector.kind),
    definitionSha256: vector.sha256,
    schemaVersion: "0.1",
    scope: vector.input.scope,
  };
}

describe("evaluation API contracts", () => {
  it("binds every strict definition to exactly one semantic mutation family", () => {
    expect(vectors).toHaveLength(16);
    for (const vector of vectors) {
      expect(
        requestSchema(vector.kind).parse({
          definition: vector.input.definition,
          kind: vector.kind,
        }),
        vector.kind,
      ).toEqual({ definition: vector.input.definition, kind: vector.kind });
    }
  });

  it("rejects mismatched kinds, unknown fields, and cross-family mutations", () => {
    const discovery = vectors.find(({ kind }) => kind === "discovery_record");
    const observation = vectors.find(({ kind }) => kind === "raw_observation");
    if (!discovery || !observation) throw new Error("Evaluation API vectors are incomplete");

    expect(
      PublishEvaluationDefinitionRequestSchema.safeParse({
        definition: discovery.input.definition,
        kind: "source_snapshot",
      }).success,
    ).toBe(false);
    expect(
      PublishEvaluationDefinitionRequestSchema.safeParse({
        definition: discovery.input.definition,
        extra: true,
        kind: discovery.kind,
      }).success,
    ).toBe(false);
    expect(
      PublishEvaluationDefinitionRequestSchema.safeParse({
        definition: observation.input.definition,
        kind: observation.kind,
      }).success,
    ).toBe(false);
  });

  it("parses strict discriminated envelopes and mutation/read acknowledgements for all kinds", () => {
    for (const vector of vectors) {
      const result = { kind: vector.kind, record: record(vector) };
      expect(EvaluationRecordEnvelopeSchema.parse(result), vector.kind).toEqual(result);
      expect(
        PublishEvaluationRecordResponseSchema.parse({
          created: true,
          requestId: "req_evaluation_api",
          result,
        }),
        vector.kind,
      ).toEqual({ created: true, requestId: "req_evaluation_api", result });
      expect(
        ReadEvaluationRecordResponseSchema.parse({
          requestId: "req_evaluation_api",
          result,
        }),
        vector.kind,
      ).toEqual({ requestId: "req_evaluation_api", result });
    }
  });
});
