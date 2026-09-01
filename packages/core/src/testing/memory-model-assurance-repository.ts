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
import { modelAssuranceRecordReferences } from "../evaluation/model-assurance-record-lineage.js";
import {
  modelAssuranceRecordId,
  validateModelAssuranceRecord,
} from "../evaluation/model-assurance-record-validation.js";
import {
  ModelAssuranceLineageError,
  type ModelAssuranceRecord,
  type ModelAssuranceRecordByKind,
  ModelAssuranceRecordConflictError,
  type ModelAssuranceRecordKind,
  type ModelAssuranceRepository,
  type PublishModelAssuranceRecordResult,
} from "../evaluation/model-assurance-repository.js";

interface ExactReference {
  readonly definitionSha256: string;
  readonly kind: ModelAssuranceRecordKind;
  readonly recordId: string;
}

function exact(
  kind: ModelAssuranceRecordKind,
  recordId: string,
  definitionSha256: string,
): ExactReference {
  return { definitionSha256, kind, recordId };
}

function references(
  kind: ModelAssuranceRecordKind,
  record: ModelAssuranceRecord,
): ExactReference[] {
  switch (kind) {
    case "blinded_evaluation_plan": {
      const value = record as BlindedEvaluationPlan;
      return [
        exact(
          "model_assisted_evaluator",
          value.evaluator.evaluatorVersionId,
          value.evaluator.definitionSha256,
        ),
        exact(
          "model_evaluator_profile",
          value.modelProfile.modelProfileVersionId,
          value.modelProfile.definitionSha256,
        ),
        exact(
          "independence_declaration",
          value.independenceDeclaration.independenceDeclarationId,
          value.independenceDeclaration.definitionSha256,
        ),
        exact(
          "calibration_report",
          value.calibrationReport.calibrationReportId,
          value.calibrationReport.definitionSha256,
        ),
        ...(value.predecessor
          ? [
              exact(
                "blinded_evaluation_plan" as const,
                value.predecessor.blindedPlanVersionId,
                value.predecessor.definitionSha256,
              ),
            ]
          : []),
      ];
    }
    case "blinded_evaluation_result": {
      const value = record as BlindedEvaluationResult;
      return [
        exact(
          "blinded_evaluation_plan",
          value.plan.blindedPlanVersionId,
          value.plan.definitionSha256,
        ),
      ];
    }
    case "calibration_report": {
      const value = record as CalibrationReport;
      return [
        exact(
          "model_assisted_evaluator",
          value.evaluator.evaluatorVersionId,
          value.evaluator.definitionSha256,
        ),
        exact(
          "model_evaluator_profile",
          value.modelProfile.modelProfileVersionId,
          value.modelProfile.definitionSha256,
        ),
        ...(value.predecessor
          ? [
              exact(
                "calibration_report" as const,
                value.predecessor.calibrationReportId,
                value.predecessor.definitionSha256,
              ),
            ]
          : []),
      ];
    }
    case "human_review_protocol": {
      const value = record as HumanReviewProtocol;
      return value.predecessor
        ? [
            exact(
              "human_review_protocol",
              value.predecessor.protocolVersionId,
              value.predecessor.definitionSha256,
            ),
          ]
        : [];
    }
    case "human_review_record": {
      const value = record as HumanReviewRecord;
      return [
        exact(
          "human_review_protocol",
          value.protocol.protocolVersionId,
          value.protocol.definitionSha256,
        ),
        exact(
          "human_reviewer_independence",
          value.independenceDeclaration.declarationId,
          value.independenceDeclaration.definitionSha256,
        ),
        ...value.critiques.map((reference) =>
          exact("independent_critique", reference.critiqueId, reference.definitionSha256),
        ),
        ...(value.supersedes
          ? [
              exact(
                "human_review_record" as const,
                value.supersedes.reviewId,
                value.supersedes.definitionSha256,
              ),
            ]
          : []),
      ];
    }
    case "human_reviewer_independence": {
      const value = record as HumanReviewerIndependence;
      return value.predecessor
        ? [
            exact(
              "human_reviewer_independence",
              value.predecessor.declarationId,
              value.predecessor.definitionSha256,
            ),
          ]
        : [];
    }
    case "independence_declaration": {
      const value = record as IndependenceDeclaration;
      return [
        exact(
          "model_assisted_evaluator",
          value.subject.evaluator.evaluatorVersionId,
          value.subject.evaluator.definitionSha256,
        ),
        exact(
          "model_evaluator_profile",
          value.subject.modelProfile.modelProfileVersionId,
          value.subject.modelProfile.definitionSha256,
        ),
        ...(value.predecessor
          ? [
              exact(
                "independence_declaration" as const,
                value.predecessor.independenceDeclarationId,
                value.predecessor.definitionSha256,
              ),
            ]
          : []),
      ];
    }
    case "independent_critique": {
      const value = record as IndependentCritique;
      return [
        exact(
          "model_assisted_evaluator",
          value.evaluator.evaluatorVersionId,
          value.evaluator.definitionSha256,
        ),
        exact(
          "model_evaluator_profile",
          value.modelProfile.modelProfileVersionId,
          value.modelProfile.definitionSha256,
        ),
        exact(
          "independence_declaration",
          value.independenceDeclaration.independenceDeclarationId,
          value.independenceDeclaration.definitionSha256,
        ),
        exact(
          "calibration_report",
          value.calibrationReport.calibrationReportId,
          value.calibrationReport.definitionSha256,
        ),
        exact(
          "model_qualification_report",
          value.modelQualificationReport.reportId,
          value.modelQualificationReport.definitionSha256,
        ),
      ];
    }
    case "model_assisted_evaluator": {
      const value = record as ModelAssistedEvaluatorSpec;
      return [
        exact(
          "model_evaluator_profile",
          value.modelProfile.modelProfileVersionId,
          value.modelProfile.definitionSha256,
        ),
        ...(value.predecessor
          ? [
              exact(
                "model_assisted_evaluator" as const,
                value.predecessor.evaluatorVersionId,
                value.predecessor.definitionSha256,
              ),
            ]
          : []),
      ];
    }
    case "model_assurance_assessment": {
      const value = record as ModelAssuranceAssessment;
      return [
        exact(
          "blinded_evaluation_plan",
          value.blindedPlan.blindedPlanVersionId,
          value.blindedPlan.definitionSha256,
        ),
        exact(
          "blinded_evaluation_result",
          value.blindedResult.resultId,
          value.blindedResult.definitionSha256,
        ),
        exact(
          "calibration_report",
          value.calibrationReport.calibrationReportId,
          value.calibrationReport.definitionSha256,
        ),
        exact(
          "model_qualification_report",
          value.modelQualificationReport.reportId,
          value.modelQualificationReport.definitionSha256,
        ),
        exact(
          "human_review_protocol",
          value.humanReviewProtocol.protocolVersionId,
          value.humanReviewProtocol.definitionSha256,
        ),
        ...value.critiques.map((reference) =>
          exact("independent_critique", reference.critiqueId, reference.definitionSha256),
        ),
        ...value.independenceDeclarations.map((reference) =>
          exact(
            "independence_declaration",
            reference.independenceDeclarationId,
            reference.definitionSha256,
          ),
        ),
        ...value.humanReviews.map((reference) =>
          exact("human_review_record", reference.reviewId, reference.definitionSha256),
        ),
      ];
    }
    case "model_evaluator_profile": {
      const value = record as ModelEvaluatorProfile;
      return value.predecessor
        ? [
            exact(
              "model_evaluator_profile",
              value.predecessor.modelProfileVersionId,
              value.predecessor.definitionSha256,
            ),
          ]
        : [];
    }
    case "model_qualification_report": {
      const value = record as ModelQualificationReport;
      return [
        exact(
          "model_qualification_suite",
          value.suite.suiteVersionId,
          value.suite.definitionSha256,
        ),
        exact(
          "model_assisted_evaluator",
          value.evaluator.evaluatorVersionId,
          value.evaluator.definitionSha256,
        ),
        exact(
          "model_evaluator_profile",
          value.modelProfile.modelProfileVersionId,
          value.modelProfile.definitionSha256,
        ),
        exact(
          "independence_declaration",
          value.independenceDeclaration.independenceDeclarationId,
          value.independenceDeclaration.definitionSha256,
        ),
        exact(
          "calibration_report",
          value.calibrationReport.calibrationReportId,
          value.calibrationReport.definitionSha256,
        ),
        ...(value.predecessor
          ? [
              exact(
                "model_qualification_report" as const,
                value.predecessor.reportId,
                value.predecessor.definitionSha256,
              ),
            ]
          : []),
      ];
    }
    case "model_qualification_suite": {
      const value = record as ModelQualificationSuite;
      return [
        exact(
          "model_assisted_evaluator",
          value.evaluator.evaluatorVersionId,
          value.evaluator.definitionSha256,
        ),
        exact(
          "model_evaluator_profile",
          value.modelProfile.modelProfileVersionId,
          value.modelProfile.definitionSha256,
        ),
        exact(
          "blinded_evaluation_plan",
          value.blindedPlan.blindedPlanVersionId,
          value.blindedPlan.definitionSha256,
        ),
        ...(value.predecessor
          ? [
              exact(
                "model_qualification_suite" as const,
                value.predecessor.suiteVersionId,
                value.predecessor.definitionSha256,
              ),
            ]
          : []),
      ];
    }
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function key(tenantId: string, kind: ModelAssuranceRecordKind, recordId: string): string {
  return `${tenantId}:${kind}:${recordId}`;
}

/** In-memory conformance reference; production code must use a durable transactional adapter. */
export class MemoryModelAssuranceRepository implements ModelAssuranceRepository {
  readonly #records = new Map<string, ModelAssuranceRecord>();

  async find<K extends ModelAssuranceRecordKind>(
    scope: EvidenceScope,
    kind: K,
    recordId: string,
  ): Promise<ModelAssuranceRecordByKind[K] | null> {
    const record = this.#records.get(key(scope.tenantId, kind, recordId));
    if (!record || !sameScope(record.scope, scope)) return null;
    return clone(record) as ModelAssuranceRecordByKind[K];
  }

  async publish<K extends ModelAssuranceRecordKind>(
    kind: K,
    candidate: ModelAssuranceRecordByKind[K],
  ): Promise<PublishModelAssuranceRecordResult<ModelAssuranceRecordByKind[K]>> {
    const parsed = validateModelAssuranceRecord(kind, candidate);
    const recordId = modelAssuranceRecordId(kind, parsed);
    const recordKey = key(parsed.scope.tenantId, kind, recordId);
    const existing = this.#records.get(recordKey);
    if (existing) {
      if (
        existing.definitionSha256 !== parsed.definitionSha256 ||
        !sameScope(existing.scope, parsed.scope)
      ) {
        throw new ModelAssuranceRecordConflictError(kind, recordId);
      }
      return { created: false, record: clone(existing) as ModelAssuranceRecordByKind[K] };
    }
    const canonicalReferences = modelAssuranceRecordReferences(kind, parsed);
    const referenceParity = references(kind, parsed).map((reference) => ({
      definitionSha256: reference.definitionSha256,
      recordId: reference.recordId,
      recordKind: reference.kind,
    }));
    if (JSON.stringify(canonicalReferences) !== JSON.stringify(referenceParity)) {
      throw new Error("Model-assurance reference extractors disagree");
    }
    for (const reference of canonicalReferences) {
      const target = this.#records.get(
        key(parsed.scope.tenantId, reference.recordKind, reference.recordId),
      );
      if (
        !target ||
        !sameScope(target.scope, parsed.scope) ||
        target.definitionSha256 !== reference.definitionSha256
      ) {
        throw new ModelAssuranceLineageError(
          kind,
          recordId,
          reference.recordKind,
          reference.recordId,
        );
      }
    }
    const owned = clone(parsed);
    this.#records.set(recordKey, owned);
    return { created: true, record: clone(owned) as ModelAssuranceRecordByKind[K] };
  }
}
