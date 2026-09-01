import { z } from "zod";
import {
  ASSESSMENT_SCHEMA_VERSION,
  type AssessmentDefinition,
  AssessmentDefinitionSchema,
  EVALUATION_AGGREGATE_SCHEMA_VERSION,
  EVALUATION_AGGREGATION_POLICY_SCHEMA_VERSION,
  type EvaluationAggregateDefinition,
  EvaluationAggregateDefinitionSchema,
  type EvaluationAggregationPolicyDefinition,
  EvaluationAggregationPolicyDefinitionSchema,
} from "./evaluation-assessment.js";
import {
  CRITERION_SET_SCHEMA_VERSION,
  CRITERION_SET_STATUS_SCHEMA_VERSION,
  type CriterionSetDefinition,
  CriterionSetDefinitionSchema,
  type CriterionSetStatusDefinition,
  CriterionSetStatusDefinitionSchema,
} from "./evaluation-criteria.js";
import {
  EVALUATION_RUN_RESULT_SCHEMA_VERSION,
  EVALUATION_RUN_REJECTION_SCHEMA_VERSION,
  EVALUATION_RUN_SCHEMA_VERSION,
  type EvaluationRunDefinition,
  EvaluationRunDefinitionSchema,
  type EvaluationRunRejectionDefinition,
  EvaluationRunRejectionDefinitionSchema,
  type EvaluationRunResultDefinition,
  EvaluationRunResultDefinitionSchema,
  RAW_OBSERVATION_SCHEMA_VERSION,
  type RawObservationDefinition,
  RawObservationDefinitionSchema,
} from "./evaluation-run.js";
import {
  DISCOVERY_RECORD_SCHEMA_VERSION,
  type DiscoveryRecordDefinition,
  DiscoveryRecordDefinitionSchema,
  SOURCE_REVIEW_SCHEMA_VERSION,
  SOURCE_SNAPSHOT_SCHEMA_VERSION,
  type SourceReviewDefinition,
  SourceReviewDefinitionSchema,
  type SourceSnapshotDefinition,
  SourceSnapshotDefinitionSchema,
} from "./evaluation-source.js";
import {
  EVALUATOR_SPEC_SCHEMA_VERSION,
  type EvaluatorSpecDefinition,
  EvaluatorSpecDefinitionSchema,
  ORACLE_SPEC_SCHEMA_VERSION,
  type OracleSpecDefinition,
  OracleSpecDefinitionSchema,
  QUALIFICATION_FIXTURE_SET_SCHEMA_VERSION,
  type QualificationFixtureSetDefinition,
  QualificationFixtureSetDefinitionSchema,
  QUALIFICATION_REPORT_SCHEMA_VERSION,
  type QualificationReportDefinition,
  QualificationReportDefinitionSchema,
} from "./evaluation-spec.js";
import {
  CALIBRATION_REPORT_SCHEMA_VERSION,
  BLINDED_EVALUATION_PLAN_SCHEMA_VERSION,
  type BlindedEvaluationPlanDefinition,
  BlindedEvaluationPlanDefinitionSchema,
  type CalibrationReportDefinition,
  CalibrationReportDefinitionSchema,
  INDEPENDENCE_DECLARATION_SCHEMA_VERSION,
  type IndependenceDeclarationDefinition,
  IndependenceDeclarationDefinitionSchema,
  MODEL_ASSISTED_EVALUATOR_SPEC_SCHEMA_VERSION,
  type ModelAssistedEvaluatorSpecDefinition,
  ModelAssistedEvaluatorSpecDefinitionSchema,
  MODEL_EVALUATOR_PROFILE_SCHEMA_VERSION,
  type ModelEvaluatorProfileDefinition,
  ModelEvaluatorProfileDefinitionSchema,
} from "./evaluation-model-assurance.js";
import { type EvidenceScope, EvidenceScopeSchema } from "./evidence.js";

export const EVALUATION_DEFINITION_ENCODING_VERSION =
  "proofstack.evaluation-definition-jcs.v1" as const;
export const DISCOVERY_RECORD_DEFINITION_DOMAIN = "proofstack.discovery-record.v1" as const;
export const SOURCE_SNAPSHOT_DEFINITION_DOMAIN = "proofstack.source-snapshot.v1" as const;
export const SOURCE_REVIEW_DEFINITION_DOMAIN = "proofstack.source-review.v1" as const;
export const CRITERION_SET_DEFINITION_DOMAIN = "proofstack.criterion-set.v1" as const;
export const CRITERION_SET_STATUS_DEFINITION_DOMAIN = "proofstack.criterion-set-status.v1" as const;
export const ORACLE_SPEC_DEFINITION_DOMAIN = "proofstack.oracle-spec.v1" as const;
export const EVALUATOR_SPEC_DEFINITION_DOMAIN = "proofstack.evaluator-spec.v1" as const;
export const MODEL_EVALUATOR_PROFILE_DEFINITION_DOMAIN =
  "proofstack.model-evaluator-profile.v1" as const;
export const INDEPENDENCE_DECLARATION_DEFINITION_DOMAIN =
  "proofstack.independence-declaration.v1" as const;
export const CALIBRATION_REPORT_DEFINITION_DOMAIN = "proofstack.calibration-report.v1" as const;
export const MODEL_ASSISTED_EVALUATOR_SPEC_DEFINITION_DOMAIN =
  "proofstack.model-assisted-evaluator-spec.v1" as const;
export const BLINDED_EVALUATION_PLAN_DEFINITION_DOMAIN =
  "proofstack.blinded-evaluation-plan.v1" as const;
export const QUALIFICATION_FIXTURE_SET_DEFINITION_DOMAIN =
  "proofstack.qualification-fixture-set.v1" as const;
export const QUALIFICATION_REPORT_DEFINITION_DOMAIN = "proofstack.qualification-report.v1" as const;
export const EVALUATION_RUN_DEFINITION_DOMAIN = "proofstack.evaluation-run.v1" as const;
export const EVALUATION_RUN_REJECTION_DEFINITION_DOMAIN =
  "proofstack.evaluation-run-rejection.v1" as const;
export const RAW_OBSERVATION_DEFINITION_DOMAIN = "proofstack.raw-observation.v1" as const;
export const EVALUATION_RUN_RESULT_DEFINITION_DOMAIN =
  "proofstack.evaluation-run-result.v1" as const;
export const EVALUATION_AGGREGATION_POLICY_DEFINITION_DOMAIN =
  "proofstack.evaluation-aggregation-policy.v1" as const;
export const EVALUATION_AGGREGATE_DEFINITION_DOMAIN = "proofstack.evaluation-aggregate.v1" as const;
export const ASSESSMENT_DEFINITION_DOMAIN = "proofstack.assessment.v1" as const;

const MAX_CANONICAL_NESTING_DEPTH = 64;

export interface ScopedEvaluationDefinition<Definition> {
  readonly definition: Definition;
  readonly scope: EvidenceScope;
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalJson(value: unknown, active: WeakSet<object>, depth: number): string {
  if (depth > MAX_CANONICAL_NESTING_DEPTH) {
    throw new RangeError(
      `Canonical evaluation definitions cannot exceed ${MAX_CANONICAL_NESTING_DEPTH} levels`,
    );
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical evaluation definitions require finite JSON numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (containsUnpairedSurrogate(value)) {
      throw new TypeError("Canonical evaluation definitions require Unicode scalar strings");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("Canonical evaluation definitions contain JSON values only");
  }
  if (active.has(value)) {
    throw new TypeError("Canonical evaluation definitions cannot contain circular references");
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("Canonical evaluation definitions cannot contain sparse arrays");
        }
        items.push(canonicalJson(value[index], active, depth + 1));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical evaluation definitions require plain JSON objects");
    }
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
      throw new TypeError("Canonical evaluation definitions cannot contain symbol keys");
    }
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        if (containsUnpairedSurrogate(key)) {
          throw new TypeError("Canonical evaluation definition keys require Unicode scalars");
        }
        return `${JSON.stringify(key)}:${canonicalJson(
          (value as Record<string, unknown>)[key],
          active,
          depth + 1,
        )}`;
      });
    return `{${entries.join(",")}}`;
  } finally {
    active.delete(value);
  }
}

function encodeUtf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * Encodes one bounded JSON value using RFC 8785 property ordering and ECMAScript number
 * serialization, then emits exact UTF-8 bytes. Strings are not normalized: callers must retain
 * their original scalar value, and schemas that require NFC must enforce it before this boundary.
 */
export function encodeEvaluationCanonicalJson(value: unknown): Uint8Array {
  return encodeUtf8(canonicalJson(value, new WeakSet<object>(), 0));
}

function scopedDefinitionSchema<Definition extends z.ZodType>(definition: Definition) {
  return z.object({ definition, scope: EvidenceScopeSchema }).strict();
}

function encodeDefinition(
  definitionDomain: string,
  schemaVersion: string,
  scope: EvidenceScope,
  definition: unknown,
): Uint8Array {
  return encodeEvaluationCanonicalJson({
    definition,
    definitionDomain,
    encodingVersion: EVALUATION_DEFINITION_ENCODING_VERSION,
    schemaVersion,
    scope,
  });
}

export function encodeDiscoveryRecordDefinition(
  input: ScopedEvaluationDefinition<DiscoveryRecordDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(DiscoveryRecordDefinitionSchema).parse(input);
  return encodeDefinition(
    DISCOVERY_RECORD_DEFINITION_DOMAIN,
    DISCOVERY_RECORD_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeSourceSnapshotDefinition(
  input: ScopedEvaluationDefinition<SourceSnapshotDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(SourceSnapshotDefinitionSchema).parse(input);
  return encodeDefinition(
    SOURCE_SNAPSHOT_DEFINITION_DOMAIN,
    SOURCE_SNAPSHOT_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeSourceReviewDefinition(
  input: ScopedEvaluationDefinition<SourceReviewDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(SourceReviewDefinitionSchema).parse(input);
  return encodeDefinition(
    SOURCE_REVIEW_DEFINITION_DOMAIN,
    SOURCE_REVIEW_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeCriterionSetDefinition(
  input: ScopedEvaluationDefinition<CriterionSetDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(CriterionSetDefinitionSchema).parse(input);
  return encodeDefinition(
    CRITERION_SET_DEFINITION_DOMAIN,
    CRITERION_SET_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeCriterionSetStatusDefinition(
  input: ScopedEvaluationDefinition<CriterionSetStatusDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(CriterionSetStatusDefinitionSchema).parse(input);
  return encodeDefinition(
    CRITERION_SET_STATUS_DEFINITION_DOMAIN,
    CRITERION_SET_STATUS_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeOracleSpecDefinition(
  input: ScopedEvaluationDefinition<OracleSpecDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(OracleSpecDefinitionSchema).parse(input);
  return encodeDefinition(
    ORACLE_SPEC_DEFINITION_DOMAIN,
    ORACLE_SPEC_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeEvaluatorSpecDefinition(
  input: ScopedEvaluationDefinition<EvaluatorSpecDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(EvaluatorSpecDefinitionSchema).parse(input);
  return encodeDefinition(
    EVALUATOR_SPEC_DEFINITION_DOMAIN,
    EVALUATOR_SPEC_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeModelEvaluatorProfileDefinition(
  input: ScopedEvaluationDefinition<ModelEvaluatorProfileDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(ModelEvaluatorProfileDefinitionSchema).parse(input);
  return encodeDefinition(
    MODEL_EVALUATOR_PROFILE_DEFINITION_DOMAIN,
    MODEL_EVALUATOR_PROFILE_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeIndependenceDeclarationDefinition(
  input: ScopedEvaluationDefinition<IndependenceDeclarationDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(IndependenceDeclarationDefinitionSchema).parse(input);
  return encodeDefinition(
    INDEPENDENCE_DECLARATION_DEFINITION_DOMAIN,
    INDEPENDENCE_DECLARATION_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeCalibrationReportDefinition(
  input: ScopedEvaluationDefinition<CalibrationReportDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(CalibrationReportDefinitionSchema).parse(input);
  return encodeDefinition(
    CALIBRATION_REPORT_DEFINITION_DOMAIN,
    CALIBRATION_REPORT_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeModelAssistedEvaluatorSpecDefinition(
  input: ScopedEvaluationDefinition<ModelAssistedEvaluatorSpecDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(ModelAssistedEvaluatorSpecDefinitionSchema).parse(input);
  return encodeDefinition(
    MODEL_ASSISTED_EVALUATOR_SPEC_DEFINITION_DOMAIN,
    MODEL_ASSISTED_EVALUATOR_SPEC_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeBlindedEvaluationPlanDefinition(
  input: ScopedEvaluationDefinition<BlindedEvaluationPlanDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(BlindedEvaluationPlanDefinitionSchema).parse(input);
  return encodeDefinition(
    BLINDED_EVALUATION_PLAN_DEFINITION_DOMAIN,
    BLINDED_EVALUATION_PLAN_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeQualificationFixtureSetDefinition(
  input: ScopedEvaluationDefinition<QualificationFixtureSetDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(QualificationFixtureSetDefinitionSchema).parse(input);
  return encodeDefinition(
    QUALIFICATION_FIXTURE_SET_DEFINITION_DOMAIN,
    QUALIFICATION_FIXTURE_SET_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeQualificationReportDefinition(
  input: ScopedEvaluationDefinition<QualificationReportDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(QualificationReportDefinitionSchema).parse(input);
  return encodeDefinition(
    QUALIFICATION_REPORT_DEFINITION_DOMAIN,
    QUALIFICATION_REPORT_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeEvaluationRunDefinition(
  input: ScopedEvaluationDefinition<EvaluationRunDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(EvaluationRunDefinitionSchema).parse(input);
  return encodeDefinition(
    EVALUATION_RUN_DEFINITION_DOMAIN,
    EVALUATION_RUN_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeEvaluationRunRejectionDefinition(
  input: ScopedEvaluationDefinition<EvaluationRunRejectionDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(EvaluationRunRejectionDefinitionSchema).parse(input);
  return encodeDefinition(
    EVALUATION_RUN_REJECTION_DEFINITION_DOMAIN,
    EVALUATION_RUN_REJECTION_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeRawObservationDefinition(
  input: ScopedEvaluationDefinition<RawObservationDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(RawObservationDefinitionSchema).parse(input);
  return encodeDefinition(
    RAW_OBSERVATION_DEFINITION_DOMAIN,
    RAW_OBSERVATION_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeEvaluationRunResultDefinition(
  input: ScopedEvaluationDefinition<EvaluationRunResultDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(EvaluationRunResultDefinitionSchema).parse(input);
  return encodeDefinition(
    EVALUATION_RUN_RESULT_DEFINITION_DOMAIN,
    EVALUATION_RUN_RESULT_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeEvaluationAggregationPolicyDefinition(
  input: ScopedEvaluationDefinition<EvaluationAggregationPolicyDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(EvaluationAggregationPolicyDefinitionSchema).parse(input);
  return encodeDefinition(
    EVALUATION_AGGREGATION_POLICY_DEFINITION_DOMAIN,
    EVALUATION_AGGREGATION_POLICY_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeEvaluationAggregateDefinition(
  input: ScopedEvaluationDefinition<EvaluationAggregateDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(EvaluationAggregateDefinitionSchema).parse(input);
  return encodeDefinition(
    EVALUATION_AGGREGATE_DEFINITION_DOMAIN,
    EVALUATION_AGGREGATE_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}

export function encodeAssessmentDefinition(
  input: ScopedEvaluationDefinition<AssessmentDefinition>,
): Uint8Array {
  const parsed = scopedDefinitionSchema(AssessmentDefinitionSchema).parse(input);
  return encodeDefinition(
    ASSESSMENT_DEFINITION_DOMAIN,
    ASSESSMENT_SCHEMA_VERSION,
    parsed.scope,
    parsed.definition,
  );
}
