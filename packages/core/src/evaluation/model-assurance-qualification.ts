import {
  type BlindedEvaluationPlan,
  BlindedEvaluationPlanSchema,
  type CalibrationReport,
  CalibrationReportSchema,
  type IndependenceDeclaration,
  IndependenceDeclarationSchema,
  type ModelEvaluatorProfile,
  ModelEvaluatorProfileSchema,
  type ModelQualificationReport,
  ModelQualificationReportSchema,
  type ModelQualificationSuite,
  ModelQualificationSuiteSchema,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";

export type ModelQualificationApplicabilityReason =
  | "blinded_plan_mismatch"
  | "blinded_plan_invalid"
  | "calibration_mismatch"
  | "calibration_not_current"
  | "calibration_unavailable"
  | "case_count_mismatch"
  | "criteria_mismatch"
  | "dataset_mismatch"
  | "evaluator_mismatch"
  | "execution_outside_suite"
  | "execution_outside_blinded_plan"
  | "independence_mismatch"
  | "independence_not_current"
  | "independence_not_verified"
  | "model_profile_mismatch"
  | "profile_not_current"
  | "report_not_current"
  | "report_unqualified"
  | "scope_mismatch"
  | "suite_mismatch"
  | "suite_not_current";

export type ModelQualificationApplicability =
  | { readonly reportId: string; readonly status: "applicable" }
  | {
      readonly reasons: readonly ModelQualificationApplicabilityReason[];
      readonly status: "inapplicable";
    };

type QualificationInput =
  | "at"
  | "blindedPlan"
  | "calibration"
  | "independence"
  | "profile"
  | "report"
  | "suite";

export class InvalidModelQualificationApplicabilityInputError extends Error {
  readonly code = "invalid_model_qualification_applicability_input";

  constructor(
    readonly input: QualificationInput,
    options?: ErrorOptions,
  ) {
    super(`The model-qualification ${input} does not satisfy its bounded contract`, options);
    this.name = "InvalidModelQualificationApplicabilityInputError";
  }
}

function parse<T>(
  schema: {
    safeParse(input: unknown): { success: true; data: T } | { success: false; error: Error };
  },
  input: unknown,
  name: QualificationInput,
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidModelQualificationApplicabilityInputError(name, { cause: parsed.error });
  }
  return parsed.data;
}

interface ScopedRecord {
  readonly scope: {
    readonly environmentId: string;
    readonly projectId: string;
    readonly tenantId: string;
  };
}

function sameScope(left: ScopedRecord, right: ScopedRecord): boolean {
  return (
    left.scope.tenantId === right.scope.tenantId &&
    left.scope.projectId === right.scope.projectId &&
    left.scope.environmentId === right.scope.environmentId
  );
}

function current(validFrom: string, validUntil: string, at: string): boolean {
  const instant = Date.parse(at);
  return Date.parse(validFrom) <= instant && instant < Date.parse(validUntil);
}

function evaluatorKey(value: {
  readonly definitionSha256?: string;
  readonly evaluatorId: string;
  readonly evaluatorVersionId: string;
}): string {
  return `${value.evaluatorId}:${value.evaluatorVersionId}:${value.definitionSha256 ?? ""}`;
}

function profileKey(value: {
  readonly definitionSha256: string;
  readonly modelProfileId: string;
  readonly modelProfileVersionId: string;
}): string {
  return `${value.modelProfileId}:${value.modelProfileVersionId}:${value.definitionSha256}`;
}

function criterionSelectorKey(value: {
  readonly criterionId: string;
  readonly criterionSetId: string;
  readonly criterionSetVersionId: string;
}): string {
  return `${value.criterionSetId}:${value.criterionSetVersionId}:${value.criterionId}`;
}

function calibrationCriterionKey(value: CalibrationReport["criteria"][number]): string {
  return criterionSelectorKey({
    criterionId: value.criterionId,
    criterionSetId: value.criterionSet.criterionSetId,
    criterionSetVersionId: value.criterionSet.criterionSetVersionId,
  });
}

/** Verifies that one qualification report still applies to its exact frozen inputs. */
export function evaluateModelQualificationApplicability(
  suiteInput: unknown,
  reportInput: unknown,
  profileInput: unknown,
  independenceInput: unknown,
  calibrationInput: unknown,
  blindedPlanInput: unknown,
  atInput: unknown,
): ModelQualificationApplicability {
  const suite = parse<ModelQualificationSuite>(ModelQualificationSuiteSchema, suiteInput, "suite");
  const report = parse<ModelQualificationReport>(
    ModelQualificationReportSchema,
    reportInput,
    "report",
  );
  const profile = parse<ModelEvaluatorProfile>(
    ModelEvaluatorProfileSchema,
    profileInput,
    "profile",
  );
  const independence = parse<IndependenceDeclaration>(
    IndependenceDeclarationSchema,
    independenceInput,
    "independence",
  );
  const calibration = parse<CalibrationReport>(
    CalibrationReportSchema,
    calibrationInput,
    "calibration",
  );
  const blindedPlan = parse<BlindedEvaluationPlan>(
    BlindedEvaluationPlanSchema,
    blindedPlanInput,
    "blindedPlan",
  );
  const at = parse<string>(UtcMillisecondTimestampSchema, atInput, "at");
  const reasons = new Set<ModelQualificationApplicabilityReason>();

  for (const record of [report, profile, independence, calibration, blindedPlan]) {
    if (!sameScope(suite, record)) reasons.add("scope_mismatch");
  }
  if (!current(suite.validFrom, suite.validUntil, at)) reasons.add("suite_not_current");
  if (!current(report.validFrom, report.validUntil, at)) reasons.add("report_not_current");
  if (!current(profile.validFrom, profile.validUntil, at)) reasons.add("profile_not_current");
  if (!current(calibration.validFrom, calibration.validUntil, at)) {
    reasons.add("calibration_not_current");
  }
  if (calibration.status !== "calibrated") reasons.add("calibration_unavailable");
  if (report.status !== "qualified") reasons.add("report_unqualified");
  if (
    report.suite.suiteId !== suite.suiteId ||
    report.suite.suiteVersionId !== suite.suiteVersionId ||
    report.suite.definitionSha256 !== suite.definitionSha256
  ) {
    reasons.add("suite_mismatch");
  }
  if (
    suite.blindedPlan.blindedPlanId !== blindedPlan.blindedPlanId ||
    suite.blindedPlan.blindedPlanVersionId !== blindedPlan.blindedPlanVersionId ||
    suite.blindedPlan.definitionSha256 !== blindedPlan.definitionSha256
  ) {
    reasons.add("blinded_plan_mismatch");
  }
  if (blindedPlan.planStatus !== "valid") reasons.add("blinded_plan_invalid");
  if (
    profileKey(suite.modelProfile) !== profileKey(profile) ||
    profileKey(report.modelProfile) !== profileKey(profile)
  ) {
    reasons.add("model_profile_mismatch");
  }
  if (
    evaluatorKey(suite.evaluator) !== evaluatorKey(report.evaluator) ||
    suite.evaluator.evaluatorId !== profile.evaluator.evaluatorId ||
    suite.evaluator.evaluatorVersionId !== profile.evaluator.evaluatorVersionId
  ) {
    reasons.add("evaluator_mismatch");
  }
  if (
    report.independenceDeclaration.independenceDeclarationId !==
      independence.independenceDeclarationId ||
    report.independenceDeclaration.definitionSha256 !== independence.definitionSha256 ||
    evaluatorKey(independence.subject.evaluator) !== evaluatorKey(report.evaluator) ||
    profileKey(independence.subject.modelProfile) !== profileKey(profile)
  ) {
    reasons.add("independence_mismatch");
  }
  if (independence.reviewStatus !== "verified") reasons.add("independence_not_verified");
  if (!current(independence.validFrom, independence.validUntil, at)) {
    reasons.add("independence_not_current");
  }
  if (
    report.calibrationReport.calibrationReportId !== calibration.calibrationReportId ||
    report.calibrationReport.definitionSha256 !== calibration.definitionSha256
  ) {
    reasons.add("calibration_mismatch");
  }
  if (
    suite.dataset.datasetId !== calibration.dataset.datasetId ||
    suite.dataset.datasetVersionId !== calibration.dataset.datasetVersionId ||
    suite.dataset.definitionSha256 !== calibration.dataset.definitionSha256
  ) {
    reasons.add("dataset_mismatch");
  }
  const suiteCriteria = suite.criteria.map(criterionSelectorKey).sort();
  const calibrationCriteria = calibration.criteria.map(calibrationCriterionKey).sort();
  if (
    suiteCriteria.length !== calibrationCriteria.length ||
    suiteCriteria.some((key, index) => key !== calibrationCriteria[index])
  ) {
    reasons.add("criteria_mismatch");
  }
  if (suite.caseCount !== report.statusSummary.caseCount) reasons.add("case_count_mismatch");
  if (
    Date.parse(report.startedAt) < Date.parse(suite.publishedAt) ||
    Date.parse(report.startedAt) < Date.parse(suite.validFrom) ||
    Date.parse(report.completedAt) >= Date.parse(suite.validUntil)
  ) {
    reasons.add("execution_outside_suite");
  }
  if (
    Date.parse(report.startedAt) < Date.parse(blindedPlan.validFrom) ||
    Date.parse(report.completedAt) >= Date.parse(blindedPlan.validUntil)
  ) {
    reasons.add("execution_outside_blinded_plan");
  }
  return reasons.size === 0
    ? { reportId: report.reportId, status: "applicable" }
    : { reasons: [...reasons].sort(), status: "inapplicable" };
}
