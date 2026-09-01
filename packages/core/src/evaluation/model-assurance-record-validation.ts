import { createHash } from "node:crypto";
import {
  BlindedEvaluationPlanSchema,
  BlindedEvaluationResultSchema,
  CalibrationReportSchema,
  encodeBlindedEvaluationPlanDefinition,
  encodeBlindedEvaluationResultDefinition,
  encodeCalibrationReportDefinition,
  encodeHumanReviewerIndependenceDefinition,
  encodeHumanReviewProtocolDefinition,
  encodeHumanReviewRecordDefinition,
  encodeIndependenceDeclarationDefinition,
  encodeIndependentCritiqueDefinition,
  encodeModelAssistedEvaluatorSpecDefinition,
  encodeModelAssuranceAssessmentDefinition,
  encodeModelEvaluatorProfileDefinition,
  encodeModelQualificationReportDefinition,
  encodeModelQualificationSuiteDefinition,
  type EvidenceScope,
  HumanReviewerIndependenceSchema,
  HumanReviewProtocolSchema,
  HumanReviewRecordSchema,
  IndependenceDeclarationSchema,
  IndependentCritiqueSchema,
  ModelAssistedEvaluatorSpecSchema,
  ModelAssuranceAssessmentSchema,
  ModelEvaluatorProfileSchema,
  ModelQualificationReportSchema,
  ModelQualificationSuiteSchema,
} from "@proofstack/contracts";
import {
  InvalidModelAssuranceRecordInputError,
  ModelAssuranceRepositoryContractError,
  type ModelAssuranceRecord,
  type ModelAssuranceRecordKind,
} from "./model-assurance-repository.js";

interface RecordBase {
  readonly definitionSha256: string;
  readonly scope: EvidenceScope;
}

interface ModelAssuranceRecordDescriptor {
  readonly encode: (input: {
    readonly definition: unknown;
    readonly scope: EvidenceScope;
  }) => Uint8Array;
  readonly idOf: (record: RecordBase) => string;
  readonly parse: (input: unknown) => ModelAssuranceRecord;
  readonly receiptKeys: readonly string[];
}

const commonReceiptKeys = ["definitionSha256", "schemaVersion", "scope"] as const;
const publishedReceiptKeys = [
  ...commonReceiptKeys,
  "publishedAt",
  "publishedByPrincipalId",
] as const;
const recordedReceiptKeys = [...commonReceiptKeys, "recordedAt"] as const;
const recordedByReceiptKeys = [...recordedReceiptKeys, "recordedByPrincipalId"] as const;

function field(record: RecordBase, key: string): string {
  const value = (record as unknown as Readonly<Record<string, unknown>>)[key];
  if (typeof value !== "string") {
    throw new ModelAssuranceRepositoryContractError(
      `Validated model-assurance record omitted ${key}`,
    );
  }
  return value;
}

const descriptors: Readonly<Record<ModelAssuranceRecordKind, ModelAssuranceRecordDescriptor>> = {
  blinded_evaluation_plan: {
    encode: (input) => encodeBlindedEvaluationPlanDefinition(input as never),
    idOf: (record) => field(record, "blindedPlanVersionId"),
    parse: (input) => BlindedEvaluationPlanSchema.parse(input),
    receiptKeys: publishedReceiptKeys,
  },
  blinded_evaluation_result: {
    encode: (input) => encodeBlindedEvaluationResultDefinition(input as never),
    idOf: (record) => field(record, "resultId"),
    parse: (input) => BlindedEvaluationResultSchema.parse(input),
    receiptKeys: recordedByReceiptKeys,
  },
  calibration_report: {
    encode: (input) => encodeCalibrationReportDefinition(input as never),
    idOf: (record) => field(record, "calibrationReportId"),
    parse: (input) => CalibrationReportSchema.parse(input),
    receiptKeys: recordedReceiptKeys,
  },
  human_review_protocol: {
    encode: (input) => encodeHumanReviewProtocolDefinition(input as never),
    idOf: (record) => field(record, "protocolVersionId"),
    parse: (input) => HumanReviewProtocolSchema.parse(input),
    receiptKeys: publishedReceiptKeys,
  },
  human_review_record: {
    encode: (input) => encodeHumanReviewRecordDefinition(input as never),
    idOf: (record) => field(record, "reviewId"),
    parse: (input) => HumanReviewRecordSchema.parse(input),
    receiptKeys: recordedReceiptKeys,
  },
  human_reviewer_independence: {
    encode: (input) => encodeHumanReviewerIndependenceDefinition(input as never),
    idOf: (record) => field(record, "declarationId"),
    parse: (input) => HumanReviewerIndependenceSchema.parse(input),
    receiptKeys: recordedReceiptKeys,
  },
  independence_declaration: {
    encode: (input) => encodeIndependenceDeclarationDefinition(input as never),
    idOf: (record) => field(record, "independenceDeclarationId"),
    parse: (input) => IndependenceDeclarationSchema.parse(input),
    receiptKeys: recordedReceiptKeys,
  },
  independent_critique: {
    encode: (input) => encodeIndependentCritiqueDefinition(input as never),
    idOf: (record) => field(record, "critiqueId"),
    parse: (input) => IndependentCritiqueSchema.parse(input),
    receiptKeys: recordedByReceiptKeys,
  },
  model_assisted_evaluator: {
    encode: (input) => encodeModelAssistedEvaluatorSpecDefinition(input as never),
    idOf: (record) => field(record, "evaluatorVersionId"),
    parse: (input) => ModelAssistedEvaluatorSpecSchema.parse(input),
    receiptKeys: publishedReceiptKeys,
  },
  model_assurance_assessment: {
    encode: (input) => encodeModelAssuranceAssessmentDefinition(input as never),
    idOf: (record) => field(record, "assessmentExtensionId"),
    parse: (input) => ModelAssuranceAssessmentSchema.parse(input),
    receiptKeys: recordedReceiptKeys,
  },
  model_evaluator_profile: {
    encode: (input) => encodeModelEvaluatorProfileDefinition(input as never),
    idOf: (record) => field(record, "modelProfileVersionId"),
    parse: (input) => ModelEvaluatorProfileSchema.parse(input),
    receiptKeys: publishedReceiptKeys,
  },
  model_qualification_report: {
    encode: (input) => encodeModelQualificationReportDefinition(input as never),
    idOf: (record) => field(record, "reportId"),
    parse: (input) => ModelQualificationReportSchema.parse(input),
    receiptKeys: recordedReceiptKeys,
  },
  model_qualification_suite: {
    encode: (input) => encodeModelQualificationSuiteDefinition(input as never),
    idOf: (record) => field(record, "suiteVersionId"),
    parse: (input) => ModelQualificationSuiteSchema.parse(input),
    receiptKeys: publishedReceiptKeys,
  },
};

function definitionOf(
  record: ModelAssuranceRecord,
  receiptKeys: readonly string[],
): Record<string, unknown> {
  const definition = structuredClone(record) as unknown as Record<string, unknown>;
  for (const key of receiptKeys) delete definition[key];
  return definition;
}

export function digestModelAssuranceRecordDefinition(
  kind: ModelAssuranceRecordKind,
  scope: EvidenceScope,
  definition: unknown,
): string {
  const bytes = descriptors[kind].encode({ definition, scope });
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateModelAssuranceRecord(
  kind: ModelAssuranceRecordKind,
  candidate: unknown,
): ModelAssuranceRecord {
  const descriptor = descriptors[kind];
  let parsed: ModelAssuranceRecord;
  let digest: string;
  try {
    parsed = descriptor.parse(candidate);
    digest = digestModelAssuranceRecordDefinition(
      kind,
      parsed.scope,
      definitionOf(parsed, descriptor.receiptKeys),
    );
  } catch (error) {
    throw new InvalidModelAssuranceRecordInputError(`Invalid ${kind} record`, { cause: error });
  }
  if (digest !== parsed.definitionSha256) {
    throw new InvalidModelAssuranceRecordInputError(
      `${kind} record ${descriptor.idOf(parsed)} has an invalid canonical definition digest`,
    );
  }
  return parsed;
}

export function modelAssuranceRecordId(
  kind: ModelAssuranceRecordKind,
  record: ModelAssuranceRecord,
): string {
  return descriptors[kind].idOf(record);
}
