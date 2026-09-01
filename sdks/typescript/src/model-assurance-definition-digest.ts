import {
  type EvidenceScope,
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
  type ModelAssuranceRecordKind,
} from "@proofstack/contracts";

export class ModelAssuranceDefinitionDigestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelAssuranceDefinitionDigestError";
  }
}

function encodeDefinition(
  kind: ModelAssuranceRecordKind,
  scope: EvidenceScope,
  definition: unknown,
): Uint8Array {
  const input = { definition, scope };
  switch (kind) {
    case "blinded_evaluation_plan":
      return encodeBlindedEvaluationPlanDefinition(input as never);
    case "blinded_evaluation_result":
      return encodeBlindedEvaluationResultDefinition(input as never);
    case "calibration_report":
      return encodeCalibrationReportDefinition(input as never);
    case "human_review_protocol":
      return encodeHumanReviewProtocolDefinition(input as never);
    case "human_review_record":
      return encodeHumanReviewRecordDefinition(input as never);
    case "human_reviewer_independence":
      return encodeHumanReviewerIndependenceDefinition(input as never);
    case "independence_declaration":
      return encodeIndependenceDeclarationDefinition(input as never);
    case "independent_critique":
      return encodeIndependentCritiqueDefinition(input as never);
    case "model_assisted_evaluator":
      return encodeModelAssistedEvaluatorSpecDefinition(input as never);
    case "model_assurance_assessment":
      return encodeModelAssuranceAssessmentDefinition(input as never);
    case "model_evaluator_profile":
      return encodeModelEvaluatorProfileDefinition(input as never);
    case "model_qualification_report":
      return encodeModelQualificationReportDefinition(input as never);
    case "model_qualification_suite":
      return encodeModelQualificationSuiteDefinition(input as never);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ModelAssuranceDefinitionDigestError(
      "Web Crypto is required to verify model-assurance definition integrity",
    );
  }
  let digest: ArrayBuffer;
  try {
    digest = await subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  } catch (cause) {
    throw new ModelAssuranceDefinitionDigestError(
      "Model-assurance definition digest calculation failed",
      { cause },
    );
  }
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function digestModelAssuranceDefinition(
  kind: ModelAssuranceRecordKind,
  scope: EvidenceScope,
  definition: unknown,
): Promise<string> {
  return sha256Hex(encodeDefinition(kind, scope, definition));
}
