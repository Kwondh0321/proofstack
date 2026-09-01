import {
  type EvaluationRecordKind,
  type EvidenceScope,
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
} from "@proofstack/contracts";

export class EvaluationDefinitionDigestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EvaluationDefinitionDigestError";
  }
}

function encodeDefinition(
  kind: EvaluationRecordKind,
  scope: EvidenceScope,
  definition: unknown,
): Uint8Array {
  const input = { definition, scope };
  switch (kind) {
    case "aggregation_policy":
      return encodeEvaluationAggregationPolicyDefinition(input as never);
    case "assessment":
      return encodeAssessmentDefinition(input as never);
    case "criterion_set":
      return encodeCriterionSetDefinition(input as never);
    case "criterion_set_status":
      return encodeCriterionSetStatusDefinition(input as never);
    case "discovery_record":
      return encodeDiscoveryRecordDefinition(input as never);
    case "evaluation_aggregate":
      return encodeEvaluationAggregateDefinition(input as never);
    case "evaluation_run":
      return encodeEvaluationRunDefinition(input as never);
    case "evaluation_run_rejection":
      return encodeEvaluationRunRejectionDefinition(input as never);
    case "evaluation_run_result":
      return encodeEvaluationRunResultDefinition(input as never);
    case "evaluator_spec":
      return encodeEvaluatorSpecDefinition(input as never);
    case "oracle_spec":
      return encodeOracleSpecDefinition(input as never);
    case "qualification_fixture_set":
      return encodeQualificationFixtureSetDefinition(input as never);
    case "qualification_report":
      return encodeQualificationReportDefinition(input as never);
    case "raw_observation":
      return encodeRawObservationDefinition(input as never);
    case "source_review":
      return encodeSourceReviewDefinition(input as never);
    case "source_snapshot":
      return encodeSourceSnapshotDefinition(input as never);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new EvaluationDefinitionDigestError(
      "Web Crypto is required to verify evaluation definition integrity",
    );
  }
  let digest: ArrayBuffer;
  try {
    digest = await subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  } catch (cause) {
    throw new EvaluationDefinitionDigestError("Evaluation definition digest calculation failed", {
      cause,
    });
  }
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function digestEvaluationDefinition(
  kind: EvaluationRecordKind,
  scope: EvidenceScope,
  definition: unknown,
): Promise<string> {
  return sha256Hex(encodeDefinition(kind, scope, definition));
}
