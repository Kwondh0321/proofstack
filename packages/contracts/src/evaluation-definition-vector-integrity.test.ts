import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ASSESSMENT_DEFINITION_DOMAIN,
  CALIBRATION_REPORT_DEFINITION_DOMAIN,
  CRITERION_SET_DEFINITION_DOMAIN,
  CRITERION_SET_STATUS_DEFINITION_DOMAIN,
  DISCOVERY_RECORD_DEFINITION_DOMAIN,
  encodeAssessmentDefinition,
  encodeCalibrationReportDefinition,
  encodeCriterionSetDefinition,
  encodeCriterionSetStatusDefinition,
  encodeDiscoveryRecordDefinition,
  encodeEvaluationAggregateDefinition,
  encodeEvaluationAggregationPolicyDefinition,
  encodeEvaluationRunDefinition,
  encodeEvaluationRunRejectionDefinition,
  encodeEvaluationRunResultDefinition,
  encodeEvaluatorSpecDefinition,
  encodeIndependenceDeclarationDefinition,
  encodeModelEvaluatorProfileDefinition,
  encodeOracleSpecDefinition,
  encodeQualificationFixtureSetDefinition,
  encodeQualificationReportDefinition,
  encodeRawObservationDefinition,
  encodeSourceReviewDefinition,
  encodeSourceSnapshotDefinition,
  EVALUATION_AGGREGATE_DEFINITION_DOMAIN,
  EVALUATION_AGGREGATION_POLICY_DEFINITION_DOMAIN,
  EVALUATION_DEFINITION_ENCODING_VERSION,
  EVALUATION_RUN_DEFINITION_DOMAIN,
  EVALUATION_RUN_REJECTION_DEFINITION_DOMAIN,
  EVALUATION_RUN_RESULT_DEFINITION_DOMAIN,
  EVALUATOR_SPEC_DEFINITION_DOMAIN,
  INDEPENDENCE_DECLARATION_DEFINITION_DOMAIN,
  MODEL_EVALUATOR_PROFILE_DEFINITION_DOMAIN,
  ORACLE_SPEC_DEFINITION_DOMAIN,
  QUALIFICATION_FIXTURE_SET_DEFINITION_DOMAIN,
  QUALIFICATION_REPORT_DEFINITION_DOMAIN,
  RAW_OBSERVATION_DEFINITION_DOMAIN,
  SOURCE_REVIEW_DEFINITION_DOMAIN,
  SOURCE_SNAPSHOT_DEFINITION_DOMAIN,
} from "./evaluation-definition-encoding.js";

interface StoredVector {
  readonly encodedByteLength: number;
  readonly input: {
    definition: Record<string, unknown>;
    scope: { environmentId: string; projectId: string; tenantId: string };
  };
  readonly kind: string;
  readonly name: string;
  readonly sha256: string;
}

interface VectorDocument {
  readonly format: string;
  readonly vectors: readonly StoredVector[];
}

interface DecodedEnvelope {
  readonly definition: unknown;
  readonly definitionDomain: string;
  readonly encodingVersion: string;
  readonly schemaVersion: string;
  readonly scope: unknown;
}

const vectorFiles = [
  "evaluation-source-definition-v1.json",
  "evaluation-criteria-definition-v1.json",
  "evaluation-spec-definition-v1.json",
  "evaluation-qualification-definition-v1.json",
  "evaluation-run-definition-v1.json",
  "evaluation-assessment-definition-v1.json",
  "evaluation-model-assurance-definition-v1.json",
  "evaluation-independence-definition-v1.json",
  "evaluation-calibration-definition-v1.json",
] as const;

const documents = vectorFiles.map(
  (file) =>
    JSON.parse(
      readFileSync(new URL(`../vectors/${file}`, import.meta.url), "utf8"),
    ) as VectorDocument,
);

const registry = {
  aggregation_policy: {
    domain: EVALUATION_AGGREGATION_POLICY_DEFINITION_DOMAIN,
    encode: (input: unknown) => encodeEvaluationAggregationPolicyDefinition(input as never),
  },
  assessment: {
    domain: ASSESSMENT_DEFINITION_DOMAIN,
    encode: (input: unknown) => encodeAssessmentDefinition(input as never),
  },
  calibration_report: {
    domain: CALIBRATION_REPORT_DEFINITION_DOMAIN,
    encode: (input: unknown) => encodeCalibrationReportDefinition(input as never),
  },
  criterion_set: {
    domain: CRITERION_SET_DEFINITION_DOMAIN,
    encode: (input: unknown) => encodeCriterionSetDefinition(input as never),
  },
  criterion_set_status: {
    domain: CRITERION_SET_STATUS_DEFINITION_DOMAIN,
    encode: (input: unknown) => encodeCriterionSetStatusDefinition(input as never),
  },
  discovery_record: {
    domain: DISCOVERY_RECORD_DEFINITION_DOMAIN,
    encode: (input: unknown) => encodeDiscoveryRecordDefinition(input as never),
  },
  evaluation_aggregate: {
    domain: EVALUATION_AGGREGATE_DEFINITION_DOMAIN,
    encode: (input: unknown) => encodeEvaluationAggregateDefinition(input as never),
  },
  evaluation_run: {
    domain: EVALUATION_RUN_DEFINITION_DOMAIN,
    encode: (input: unknown) => encodeEvaluationRunDefinition(input as never),
  },
  evaluation_run_rejection: {
    domain: EVALUATION_RUN_REJECTION_DEFINITION_DOMAIN,
    encode: (input: unknown) => encodeEvaluationRunRejectionDefinition(input as never),
  },
  evaluation_run_result: {
    domain: EVALUATION_RUN_RESULT_DEFINITION_DOMAIN,
    encode: (input: unknown) => encodeEvaluationRunResultDefinition(input as never),
  },
  evaluator_spec: {
    domain: EVALUATOR_SPEC_DEFINITION_DOMAIN,
    encode: (input: unknown) => encodeEvaluatorSpecDefinition(input as never),
  },
  independence_declaration: {
    domain: INDEPENDENCE_DECLARATION_DEFINITION_DOMAIN,
    encode: (input: unknown) => encodeIndependenceDeclarationDefinition(input as never),
  },
  model_evaluator_profile: {
    domain: MODEL_EVALUATOR_PROFILE_DEFINITION_DOMAIN,
    encode: (input: unknown) => encodeModelEvaluatorProfileDefinition(input as never),
  },
  oracle_spec: {
    domain: ORACLE_SPEC_DEFINITION_DOMAIN,
    encode: (input: unknown) => encodeOracleSpecDefinition(input as never),
  },
  qualification_fixture_set: {
    domain: QUALIFICATION_FIXTURE_SET_DEFINITION_DOMAIN,
    encode: (input: unknown) => encodeQualificationFixtureSetDefinition(input as never),
  },
  qualification_report: {
    domain: QUALIFICATION_REPORT_DEFINITION_DOMAIN,
    encode: (input: unknown) => encodeQualificationReportDefinition(input as never),
  },
  raw_observation: {
    domain: RAW_OBSERVATION_DEFINITION_DOMAIN,
    encode: (input: unknown) => encodeRawObservationDefinition(input as never),
  },
  source_review: {
    domain: SOURCE_REVIEW_DEFINITION_DOMAIN,
    encode: (input: unknown) => encodeSourceReviewDefinition(input as never),
  },
  source_snapshot: {
    domain: SOURCE_SNAPSHOT_DEFINITION_DOMAIN,
    encode: (input: unknown) => encodeSourceSnapshotDefinition(input as never),
  },
} as const;

type RegisteredKind = keyof typeof registry;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRegisteredKind(kind: string): kind is RegisteredKind {
  return Object.hasOwn(registry, kind);
}

describe("evaluation definition vector registry", () => {
  it("registers every fixed vector exactly once under one unique domain and digest", () => {
    const vectors = documents.flatMap(({ vectors }) => vectors);
    const kinds = vectors.map(({ kind }) => kind).sort();
    expect(kinds).toEqual(Object.keys(registry).sort());
    expect(new Set(documents.map(({ format }) => format)).size).toBe(documents.length);
    expect(new Set(Object.values(registry).map(({ domain }) => domain)).size).toBe(
      Object.keys(registry).length,
    );
    expect(new Set(vectors.map(({ sha256: digest }) => digest)).size).toBe(vectors.length);

    for (const vector of vectors) {
      expect(isRegisteredKind(vector.kind), vector.kind).toBe(true);
      if (!isRegisteredKind(vector.kind)) throw new Error(`Unregistered vector ${vector.kind}`);
      const entry = registry[vector.kind];
      const bytes = entry.encode(vector.input);
      expect(bytes.byteLength, vector.name).toBe(vector.encodedByteLength);
      expect(sha256(bytes), vector.name).toBe(vector.sha256);
      const envelope = JSON.parse(Buffer.from(bytes).toString("utf8")) as DecodedEnvelope;
      expect(Object.keys(envelope)).toEqual([
        "definition",
        "definitionDomain",
        "encodingVersion",
        "schemaVersion",
        "scope",
      ]);
      expect(envelope.definitionDomain).toBe(entry.domain);
      expect(envelope.encodingVersion).toBe(EVALUATION_DEFINITION_ENCODING_VERSION);
    }
  });

  it("binds tenant scope for every vector and represents applicability at definition and run time", () => {
    const vectors = documents.flatMap(({ vectors }) => vectors);
    for (const vector of vectors) {
      if (!isRegisteredKind(vector.kind)) throw new Error(`Unregistered vector ${vector.kind}`);
      const original = registry[vector.kind].encode(vector.input);
      const changed = structuredClone(vector.input);
      changed.scope.tenantId = "ten_other";
      expect(registry[vector.kind].encode(changed), vector.name).not.toEqual(original);
    }

    const criterion = vectors.find(({ kind }) => kind === "criterion_set");
    const run = vectors.find(({ kind }) => kind === "evaluation_run");
    expect(JSON.stringify(criterion?.input.definition)).toContain('"applicability"');
    expect(JSON.stringify(run?.input.definition)).toContain('"applicability"');
  });
});
