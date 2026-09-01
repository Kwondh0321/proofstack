import { createHash } from "node:crypto";
import {
  AssessmentSchema,
  CriterionSetSchema,
  CriterionSetStatusRecordSchema,
  DiscoveryRecordSchema,
  encodeAssessmentDefinition,
  encodeCriterionSetDefinition,
  encodeCriterionSetStatusDefinition,
  encodeDiscoveryRecordDefinition,
  encodeEvaluationAggregateDefinition,
  encodeEvaluationAggregationPolicyDefinition,
  encodeEvaluationRunDefinition,
  encodeEvaluationRunRejectionDefinition,
  encodeEvaluationRunResultDefinition,
  encodeEvaluatorSpecDefinition,
  encodeOracleSpecDefinition,
  encodeQualificationFixtureSetDefinition,
  encodeQualificationReportDefinition,
  encodeRawObservationDefinition,
  encodeSourceReviewDefinition,
  encodeSourceSnapshotDefinition,
  EvaluationAggregateSchema,
  EvaluationAggregationPolicySchema,
  EvaluationRunRejectionSchema,
  EvaluationRunResultSchema,
  EvaluationRunSchema,
  EvaluatorSpecSchema,
  OracleSpecSchema,
  QualificationFixtureSetSchema,
  QualificationReportSchema,
  RawObservationSchema,
  SourceReviewRecordSchema,
  SourceSnapshotSchema,
  type Assessment,
  type CriterionSet,
  type CriterionSetStatusRecord,
  type DiscoveryRecord,
  type EvaluationAggregate,
  type EvaluationAggregationPolicy,
  type EvaluationRun,
  type EvaluationRunRejection,
  type EvaluationRunResult,
  type EvaluatorSpec,
  type EvidenceScope,
  type OracleSpec,
  type QualificationFixtureSet,
  type QualificationReport,
  type RawObservation,
  type SourceReviewRecord,
  type SourceSnapshot,
} from "@proofstack/contracts";
import {
  EvaluationRepositoryContractError,
  InvalidEvaluationRecordInputError,
} from "./evaluation-repository-errors.js";
import type {
  EvaluationRecordKind,
  EvaluationResourceKind,
} from "./evaluation-repository-errors.js";

export type EvaluationStoredRecord =
  | Assessment
  | CriterionSet
  | CriterionSetStatusRecord
  | DiscoveryRecord
  | EvaluationAggregate
  | EvaluationAggregationPolicy
  | EvaluationRun
  | EvaluationRunRejection
  | EvaluationRunResult
  | EvaluatorSpec
  | OracleSpec
  | QualificationFixtureSet
  | QualificationReport
  | RawObservation
  | SourceReviewRecord
  | SourceSnapshot;

interface RecordBase {
  readonly definitionSha256: string;
  readonly scope: EvidenceScope;
}

interface EvaluationRecordDescriptor {
  readonly encode: (input: {
    readonly definition: unknown;
    readonly scope: EvidenceScope;
  }) => Uint8Array;
  readonly idOf: (record: RecordBase) => string;
  readonly parse: (input: unknown) => EvaluationStoredRecord;
  readonly receiptKeys: readonly string[];
  readonly resourceOf?: (record: RecordBase) => {
    readonly kind: EvaluationResourceKind;
    readonly resourceId: string;
  };
}

const commonReceiptKeys = ["definitionSha256", "schemaVersion", "scope"] as const;
const publishedReceiptKeys = [
  ...commonReceiptKeys,
  "publishedAt",
  "publishedByPrincipalId",
] as const;
const createdReceiptKeys = [...commonReceiptKeys, "createdAt", "createdByPrincipalId"] as const;

function field(record: RecordBase, key: string): string {
  const value = (record as unknown as Readonly<Record<string, unknown>>)[key];
  if (typeof value !== "string") {
    throw new EvaluationRepositoryContractError(`Validated evaluation record omitted ${key}`);
  }
  return value;
}

export const evaluationRecordDescriptors: Readonly<
  Record<EvaluationRecordKind, EvaluationRecordDescriptor>
> = {
  aggregation_policy: {
    encode: (input) => encodeEvaluationAggregationPolicyDefinition(input as never),
    idOf: (record) => field(record, "policyVersionId"),
    parse: (input) => EvaluationAggregationPolicySchema.parse(input),
    receiptKeys: publishedReceiptKeys,
    resourceOf: (record) => ({ kind: "aggregation_policy", resourceId: field(record, "policyId") }),
  },
  assessment: {
    encode: (input) => encodeAssessmentDefinition(input as never),
    idOf: (record) => field(record, "assessmentId"),
    parse: (input) => AssessmentSchema.parse(input),
    receiptKeys: createdReceiptKeys,
  },
  criterion_set: {
    encode: (input) => encodeCriterionSetDefinition(input as never),
    idOf: (record) => field(record, "criterionSetVersionId"),
    parse: (input) => CriterionSetSchema.parse(input),
    receiptKeys: publishedReceiptKeys,
    resourceOf: (record) => ({
      kind: "criterion_set",
      resourceId: field(record, "criterionSetId"),
    }),
  },
  criterion_set_status: {
    encode: (input) => encodeCriterionSetStatusDefinition(input as never),
    idOf: (record) => field(record, "statusRecordId"),
    parse: (input) => CriterionSetStatusRecordSchema.parse(input),
    receiptKeys: [...commonReceiptKeys, "recordedAt", "recordedByPrincipalId"],
  },
  discovery_record: {
    encode: (input) => encodeDiscoveryRecordDefinition(input as never),
    idOf: (record) => field(record, "discoveryId"),
    parse: (input) => DiscoveryRecordSchema.parse(input),
    receiptKeys: [...commonReceiptKeys, "recordedAt", "recordedByPrincipalId"],
  },
  evaluation_aggregate: {
    encode: (input) => encodeEvaluationAggregateDefinition(input as never),
    idOf: (record) => field(record, "aggregateId"),
    parse: (input) => EvaluationAggregateSchema.parse(input),
    receiptKeys: createdReceiptKeys,
  },
  evaluation_run: {
    encode: (input) => encodeEvaluationRunDefinition(input as never),
    idOf: (record) => field(record, "evaluationRunId"),
    parse: (input) => EvaluationRunSchema.parse(input),
    receiptKeys: createdReceiptKeys,
  },
  evaluation_run_rejection: {
    encode: (input) => encodeEvaluationRunRejectionDefinition(input as never),
    idOf: (record) => field(record, "rejectionId"),
    parse: (input) => EvaluationRunRejectionSchema.parse(input),
    receiptKeys: [...commonReceiptKeys, "recordedAt", "requestedByPrincipalId"],
  },
  evaluation_run_result: {
    encode: (input) => encodeEvaluationRunResultDefinition(input as never),
    idOf: (record) => field(record, "resultId"),
    parse: (input) => EvaluationRunResultSchema.parse(input),
    receiptKeys: [...commonReceiptKeys, "recordedAt", "recordedByPrincipalId"],
  },
  evaluator_spec: {
    encode: (input) => encodeEvaluatorSpecDefinition(input as never),
    idOf: (record) => field(record, "evaluatorVersionId"),
    parse: (input) => EvaluatorSpecSchema.parse(input),
    receiptKeys: publishedReceiptKeys,
    resourceOf: (record) => ({ kind: "evaluator", resourceId: field(record, "evaluatorId") }),
  },
  oracle_spec: {
    encode: (input) => encodeOracleSpecDefinition(input as never),
    idOf: (record) => field(record, "oracleVersionId"),
    parse: (input) => OracleSpecSchema.parse(input),
    receiptKeys: publishedReceiptKeys,
    resourceOf: (record) => ({ kind: "oracle", resourceId: field(record, "oracleId") }),
  },
  qualification_fixture_set: {
    encode: (input) => encodeQualificationFixtureSetDefinition(input as never),
    idOf: (record) => field(record, "fixtureSetVersionId"),
    parse: (input) => QualificationFixtureSetSchema.parse(input),
    receiptKeys: publishedReceiptKeys,
    resourceOf: (record) => ({
      kind: "qualification_fixture_set",
      resourceId: field(record, "fixtureSetId"),
    }),
  },
  qualification_report: {
    encode: (input) => encodeQualificationReportDefinition(input as never),
    idOf: (record) => field(record, "qualificationReportId"),
    parse: (input) => QualificationReportSchema.parse(input),
    receiptKeys: [...commonReceiptKeys, "executedByPrincipalId", "recordedAt"],
  },
  raw_observation: {
    encode: (input) => encodeRawObservationDefinition(input as never),
    idOf: (record) => field(record, "observationId"),
    parse: (input) => RawObservationSchema.parse(input),
    receiptKeys: [...commonReceiptKeys, "recordedAt"],
  },
  source_review: {
    encode: (input) => encodeSourceReviewDefinition(input as never),
    idOf: (record) => field(record, "sourceReviewId"),
    parse: (input) => SourceReviewRecordSchema.parse(input),
    receiptKeys: [...commonReceiptKeys, "reviewedAt", "reviewedByPrincipalId", "reviewerRole"],
  },
  source_snapshot: {
    encode: (input) => encodeSourceSnapshotDefinition(input as never),
    idOf: (record) => field(record, "sourceSnapshotId"),
    parse: (input) => SourceSnapshotSchema.parse(input),
    receiptKeys: [...commonReceiptKeys, "publishedByPrincipalId", "recordedAt"],
  },
};

function definitionOf(
  record: EvaluationStoredRecord,
  receiptKeys: readonly string[],
): Record<string, unknown> {
  const definition = structuredClone(record) as unknown as Record<string, unknown>;
  for (const key of receiptKeys) delete definition[key];
  return definition;
}

export function validateEvaluationRecord(
  kind: EvaluationRecordKind,
  candidate: unknown,
): EvaluationStoredRecord {
  const descriptor = evaluationRecordDescriptors[kind];
  let parsed: EvaluationStoredRecord;
  let digest: string;
  try {
    parsed = descriptor.parse(candidate);
    digest = digestEvaluationRecordDefinition(
      kind,
      parsed.scope,
      definitionOf(parsed, descriptor.receiptKeys),
    );
  } catch (error) {
    throw new InvalidEvaluationRecordInputError(`Invalid ${kind} record`, { cause: error });
  }
  if (digest !== parsed.definitionSha256) {
    throw new InvalidEvaluationRecordInputError(
      `${kind} record ${descriptor.idOf(parsed)} has an invalid canonical definition digest`,
    );
  }
  return parsed;
}

export function digestEvaluationRecordDefinition(
  kind: EvaluationRecordKind,
  scope: EvidenceScope,
  definition: unknown,
): string {
  const bytes = evaluationRecordDescriptors[kind].encode({ definition, scope });
  return createHash("sha256").update(bytes).digest("hex");
}

export function evaluationRecordId(
  kind: EvaluationRecordKind,
  record: EvaluationStoredRecord,
): string {
  return evaluationRecordDescriptors[kind].idOf(record);
}

export function evaluationResource(
  kind: EvaluationRecordKind,
  record: EvaluationStoredRecord,
): { readonly kind: EvaluationResourceKind; readonly resourceId: string } | null {
  return evaluationRecordDescriptors[kind].resourceOf?.(record) ?? null;
}
