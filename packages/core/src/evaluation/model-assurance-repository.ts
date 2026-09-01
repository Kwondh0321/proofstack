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

export interface AuthoritySplitModelAssuranceRepositories {
  /** Owns control-plane definitions, declarations, protocols, and assessments. */
  readonly control: ModelAssuranceRepository;
  /** Owns model-produced qualification, blinded-result, and critique records. */
  readonly execution: ModelAssuranceRepository;
  /** Owns authenticated human-review records. */
  readonly humanReview: ModelAssuranceRepository;
  /** Optional least-privilege read path; defaults to the control repository. */
  readonly read?: ModelAssuranceRepository;
}

const MODEL_EXECUTION_RECORD_KINDS = new Set<ModelAssuranceRecordKind>([
  "blinded_evaluation_result",
  "independent_critique",
  "model_qualification_report",
]);

/**
 * Routes writes to disjoint persistence authorities while presenting one repository boundary.
 *
 * HTTP authentication still decides whether a principal may invoke an operation. This router is
 * the independent database backstop: a compromised control-plane connection cannot manufacture a
 * model execution or a human review, and neither worker authority can publish an assessment.
 */
export class AuthoritySplitModelAssuranceRepository implements ModelAssuranceRepository {
  constructor(private readonly repositories: AuthoritySplitModelAssuranceRepositories) {}

  find<K extends ModelAssuranceRecordKind>(
    scope: EvidenceScope,
    kind: K,
    recordId: string,
  ): Promise<ModelAssuranceRecordByKind[K] | null> {
    return (this.repositories.read ?? this.repositories.control).find(scope, kind, recordId);
  }

  publish<K extends ModelAssuranceRecordKind>(
    kind: K,
    candidate: ModelAssuranceRecordByKind[K],
  ): Promise<PublishModelAssuranceRecordResult<ModelAssuranceRecordByKind[K]>> {
    return this.writer(kind).publish(kind, candidate);
  }

  private writer(kind: ModelAssuranceRecordKind): ModelAssuranceRepository {
    if (kind === "human_review_record") return this.repositories.humanReview;
    if (MODEL_EXECUTION_RECORD_KINDS.has(kind)) return this.repositories.execution;
    return this.repositories.control;
  }
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

export class ModelAssuranceRecordNotFoundError extends Error {
  readonly code = "model_assurance_record_not_found";

  constructor(
    readonly recordKind: ModelAssuranceRecordKind,
    readonly recordId: string,
  ) {
    super(`${recordKind} record ${recordId} was not found`);
    this.name = "ModelAssuranceRecordNotFoundError";
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
