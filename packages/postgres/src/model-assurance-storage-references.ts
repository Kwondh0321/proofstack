import {
  type ModelAssuranceRecordKind,
  ModelAssuranceRepositoryContractError,
} from "@proofstack/core";

// Migration 0041's selected cross-domain grammar differs from core's model-only
// logical reference inventory. This projection stays private to the adapter.
const fields = [
  ["assessment", "assessmentId"],
  ["criterion_set", "criterionSetVersionId"],
  ["oracle_spec", "oracleVersionId"],
  ["qualification_report", "qualificationReportId"],
  ["raw_observation", "observationId"],
  ["blinded_evaluation_plan", "blindedPlanVersionId"],
  ["blinded_evaluation_result", "resultId"],
  ["calibration_report", "calibrationReportId"],
  ["human_review_protocol", "protocolVersionId"],
  ["human_review_record", "reviewId"],
  ["human_reviewer_independence", "declarationId"],
  ["independence_declaration", "independenceDeclarationId"],
  ["independent_critique", "critiqueId"],
  ["model_assisted_evaluator", "evaluatorVersionId"],
  ["model_assurance_assessment", "assessmentExtensionId"],
  ["model_evaluator_profile", "modelProfileVersionId"],
  ["model_qualification_report", "reportId"],
  ["model_qualification_suite", "suiteVersionId"],
] as const;

export interface ModelAssuranceStorageReference {
  readonly recordKind: (typeof fields)[number][0];
  readonly recordId: string;
  readonly definitionSha256: string;
}

const allowed: Record<
  ModelAssuranceRecordKind,
  readonly ModelAssuranceStorageReference["recordKind"][]
> = {
  blinded_evaluation_plan: [
    "model_assisted_evaluator",
    "model_evaluator_profile",
    "independence_declaration",
    "calibration_report",
    "blinded_evaluation_plan",
    "criterion_set",
  ],
  blinded_evaluation_result: ["blinded_evaluation_plan"],
  calibration_report: [
    "model_assisted_evaluator",
    "model_evaluator_profile",
    "calibration_report",
    "qualification_report",
    "criterion_set",
  ],
  human_review_protocol: ["human_review_protocol", "criterion_set"],
  human_review_record: [
    "human_review_protocol",
    "human_reviewer_independence",
    "independent_critique",
    "human_review_record",
    "assessment",
    "raw_observation",
  ],
  human_reviewer_independence: ["human_reviewer_independence"],
  independence_declaration: [
    "model_assisted_evaluator",
    "model_evaluator_profile",
    "independence_declaration",
  ],
  independent_critique: [
    "model_assisted_evaluator",
    "model_evaluator_profile",
    "independence_declaration",
    "calibration_report",
    "qualification_report",
    "raw_observation",
    "criterion_set",
  ],
  model_assisted_evaluator: ["model_evaluator_profile", "model_assisted_evaluator"],
  model_assurance_assessment: [
    "blinded_evaluation_plan",
    "blinded_evaluation_result",
    "calibration_report",
    "model_qualification_report",
    "human_review_protocol",
    "independent_critique",
    "independence_declaration",
    "human_review_record",
    "assessment",
    "raw_observation",
    "oracle_spec",
  ],
  model_evaluator_profile: ["model_evaluator_profile"],
  model_qualification_report: [
    "model_qualification_suite",
    "model_assisted_evaluator",
    "model_evaluator_profile",
    "independence_declaration",
    "calibration_report",
    "model_qualification_report",
    "qualification_report",
  ],
  model_qualification_suite: [
    "model_assisted_evaluator",
    "model_evaluator_profile",
    "blinded_evaluation_plan",
    "model_qualification_suite",
    "criterion_set",
  ],
};

/** Private storage projection; the owning caller validates the canonical body first. */
export function modelAssuranceStorageReferences(
  rootKind: ModelAssuranceRecordKind,
  rootId: string,
  record: unknown,
): readonly ModelAssuranceStorageReference[] {
  const selected = new Set(allowed[rootKind]);
  const references = new Map<string, ModelAssuranceStorageReference>();
  const pending = [{ value: record, depth: 0 }];
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (typeof node.value !== "object" || node.value === null) continue;
    const value = node.value as Readonly<Record<string, unknown>>;
    if (!Array.isArray(value) && node.depth > 0 && Object.hasOwn(value, "definitionSha256")) {
      for (const [recordKind, field] of fields) {
        const recordId = value[field];
        if (
          !selected.has(recordKind) ||
          recordId === undefined ||
          recordId === null ||
          (recordKind === rootKind && recordId === rootId)
        )
          continue;
        const definitionSha256 = value["definitionSha256"];
        if (typeof recordId !== "string" || typeof definitionSha256 !== "string") {
          throw new ModelAssuranceRepositoryContractError(
            "Canonical model-assurance storage reference is malformed",
          );
        }
        references.set(JSON.stringify([recordKind, recordId, definitionSha256]), {
          recordKind,
          recordId,
          definitionSha256,
        });
        if (references.size > 4096) {
          throw new ModelAssuranceRepositoryContractError(
            "Model-assurance storage reference limit exceeded",
          );
        }
      }
    }
    if (node.depth < 64) {
      for (const child of Object.values(value))
        pending.push({ value: child, depth: node.depth + 1 });
    }
  }
  return [...references.values()];
}
