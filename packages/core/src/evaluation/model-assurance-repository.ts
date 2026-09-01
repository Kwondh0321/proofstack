import type {
  BlindedEvaluationPlan,
  BlindedEvaluationResult,
  CalibrationReport,
  EvidenceScope,
  HumanReviewerIndependence,
  HumanReviewProtocol,
  HumanReviewRecord,
  IndependenceDeclaration,
  IndependentCritique,
  ModelAssistedEvaluatorSpec,
  ModelAssuranceAssessment,
  ModelEvaluatorProfile,
  ModelQualificationReport,
  ModelQualificationSuite,
} from "@proofstack/contracts";

export interface ModelAssuranceRecordByKind {
  readonly blinded_evaluation_plan: BlindedEvaluationPlan;
  readonly blinded_evaluation_result: BlindedEvaluationResult;
  readonly calibration_report: CalibrationReport;
  readonly human_review_protocol: HumanReviewProtocol;
  readonly human_review_record: HumanReviewRecord;
  readonly human_reviewer_independence: HumanReviewerIndependence;
  readonly independence_declaration: IndependenceDeclaration;
  readonly independent_critique: IndependentCritique;
  readonly model_assisted_evaluator: ModelAssistedEvaluatorSpec;
  readonly model_assurance_assessment: ModelAssuranceAssessment;
  readonly model_evaluator_profile: ModelEvaluatorProfile;
  readonly model_qualification_report: ModelQualificationReport;
  readonly model_qualification_suite: ModelQualificationSuite;
}

export type ModelAssuranceRecordKind = keyof ModelAssuranceRecordByKind;
export type ModelAssuranceRecord = ModelAssuranceRecordByKind[ModelAssuranceRecordKind];

export interface PublishModelAssuranceRecordResult<Record extends ModelAssuranceRecord> {
  readonly created: boolean;
  readonly record: Record;
}

/**
 * Persistence boundary for the append-only model-assurance graph.
 *
 * Implementations must schema-validate and canonical-digest every candidate, enforce exact-scope
 * lineage before visibility, own stored values, return the authoritative original on an identical
 * retry, and reject any attempt to bind one kind/id pair to different immutable semantics.
 * Reads deliberately return null for both absence and records outside the exact authorized scope.
 */
export interface ModelAssuranceRepository {
  find<K extends ModelAssuranceRecordKind>(
    scope: EvidenceScope,
    kind: K,
    recordId: string,
  ): Promise<ModelAssuranceRecordByKind[K] | null>;

  publish<K extends ModelAssuranceRecordKind>(
    kind: K,
    candidate: ModelAssuranceRecordByKind[K],
  ): Promise<PublishModelAssuranceRecordResult<ModelAssuranceRecordByKind[K]>>;
}

export class ModelAssuranceRecordConflictError extends Error {
  readonly code = "model_assurance_record_conflict";

  constructor(
    readonly recordKind: ModelAssuranceRecordKind,
    readonly recordId: string,
  ) {
    super(`${recordKind} record ${recordId} is already bound to different immutable semantics`);
    this.name = "ModelAssuranceRecordConflictError";
  }
}

export class ModelAssuranceLineageError extends Error {
  readonly code = "model_assurance_lineage_invalid";

  constructor(
    readonly recordKind: ModelAssuranceRecordKind,
    readonly recordId: string,
    readonly referenceKind: ModelAssuranceRecordKind,
    readonly referenceId: string,
  ) {
    super(
      `${recordKind} record ${recordId} references unavailable or conflicting ${referenceKind} record ${referenceId}`,
    );
    this.name = "ModelAssuranceLineageError";
  }
}

export class InvalidModelAssuranceRecordInputError extends TypeError {
  readonly code = "model_assurance_record_input_invalid";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidModelAssuranceRecordInputError";
  }
}

export class ModelAssuranceRepositoryContractError extends Error {
  readonly code = "model_assurance_repository_contract_violation";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelAssuranceRepositoryContractError";
  }
}
