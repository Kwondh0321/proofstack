import type {
  BlindedEvaluationPlan,
  BlindedEvaluationResult,
  CalibrationReport,
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
import type {
  ModelAssuranceRecord,
  ModelAssuranceRecordKind,
} from "./model-assurance-repository.js";

export interface ModelAssuranceRecordReference {
  readonly definitionSha256: string;
  readonly recordId: string;
  readonly recordKind: ModelAssuranceRecordKind;
}

function exact(
  recordKind: ModelAssuranceRecordKind,
  recordId: string,
  definitionSha256: string,
): ModelAssuranceRecordReference {
  return { definitionSha256, recordId, recordKind };
}

export function modelAssuranceRecordReferences(
  kind: ModelAssuranceRecordKind,
  record: ModelAssuranceRecord,
): readonly ModelAssuranceRecordReference[] {
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
