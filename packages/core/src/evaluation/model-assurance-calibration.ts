import {
  type CalibrationReport,
  CalibrationReportSchema,
  type CriterionReference,
  CriterionReferenceSchema,
  EvaluationDatasetVersionReferenceSchema,
  EvaluationRiskTierSchema,
  type EvidenceScope,
  EvidenceScopeSchema,
  type ModelEvaluatorProfile,
  ModelEvaluatorProfileSchema,
  OpaqueIdSchema,
  type QualificationReportReference,
  QualificationReportReferenceSchema,
  Sha256Schema,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";

export interface ExactEvaluatorReference {
  readonly definitionSha256: string;
  readonly evaluatorId: string;
  readonly evaluatorVersionId: string;
}

export interface ExactDatasetReference {
  readonly datasetId: string;
  readonly datasetVersionId: string;
  readonly definitionSha256: string;
}

export type CalibrationRiskTier = "critical" | "high" | "low" | "moderate";

export interface CalibrationCompatibilityContext {
  readonly at: string;
  readonly criteria: readonly CriterionReference[];
  readonly dataset: ExactDatasetReference;
  readonly evaluator: ExactEvaluatorReference;
  readonly locale: string;
  readonly populationTags: readonly string[];
  readonly qualificationReport: QualificationReportReference;
  readonly riskTier: CalibrationRiskTier;
  readonly scope: EvidenceScope;
  readonly taskKindId: string;
}

export type CalibrationIncompatibilityReason =
  | "calibration_not_current"
  | "calibration_unavailable"
  | "criterion_mismatch"
  | "dataset_mismatch"
  | "distribution_shift"
  | "evaluator_mismatch"
  | "locale_mismatch"
  | "model_profile_mismatch"
  | "population_mismatch"
  | "profile_not_current"
  | "qualification_mismatch"
  | "risk_tier_mismatch"
  | "scope_mismatch"
  | "task_kind_mismatch";

export type CalibrationCompatibility =
  | { readonly status: "compatible" }
  | {
      readonly reasons: readonly CalibrationIncompatibilityReason[];
      readonly status: "incompatible";
    };

export class InvalidCalibrationCompatibilityInputError extends Error {
  readonly code = "invalid_calibration_compatibility_input";

  constructor(
    readonly input: "calibration" | "context" | "profile",
    options?: ErrorOptions,
  ) {
    super(`The calibration compatibility ${input} does not satisfy its bounded contract`, options);
    this.name = "InvalidCalibrationCompatibilityInputError";
  }
}

function parseProfile(input: unknown): ModelEvaluatorProfile {
  const parsed = ModelEvaluatorProfileSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidCalibrationCompatibilityInputError("profile", { cause: parsed.error });
  }
  return parsed.data;
}

function parseCalibration(input: unknown): CalibrationReport {
  const parsed = CalibrationReportSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidCalibrationCompatibilityInputError("calibration", { cause: parsed.error });
  }
  return parsed.data;
}

function parseContext(input: CalibrationCompatibilityContext): CalibrationCompatibilityContext {
  const valid =
    UtcMillisecondTimestampSchema.safeParse(input?.at).success &&
    EvidenceScopeSchema.safeParse(input?.scope).success &&
    EvaluationRiskTierSchema.safeParse(input?.riskTier).success &&
    OpaqueIdSchema.safeParse(input?.taskKindId).success &&
    QualificationReportReferenceSchema.safeParse(input?.qualificationReport).success &&
    EvaluationDatasetVersionReferenceSchema.safeParse(input?.dataset).success &&
    OpaqueIdSchema.safeParse(input?.evaluator?.evaluatorId).success &&
    OpaqueIdSchema.safeParse(input?.evaluator?.evaluatorVersionId).success &&
    Sha256Schema.safeParse(input?.evaluator?.definitionSha256).success &&
    /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/.test(input?.locale ?? "") &&
    Array.isArray(input?.populationTags) &&
    input.populationTags.every((tag) => typeof tag === "string") &&
    input.populationTags.every(
      (tag, index) => index === 0 || (input.populationTags[index - 1] ?? "") < tag,
    ) &&
    Array.isArray(input?.criteria) &&
    input.criteria.length > 0 &&
    input.criteria.every((criterion) => CriterionReferenceSchema.safeParse(criterion).success);
  if (!valid) throw new InvalidCalibrationCompatibilityInputError("context");
  return input;
}

function evaluatorReferencesEqual(
  left: ExactEvaluatorReference,
  right: ExactEvaluatorReference,
): boolean {
  return (
    left.evaluatorId === right.evaluatorId &&
    left.evaluatorVersionId === right.evaluatorVersionId &&
    left.definitionSha256 === right.definitionSha256
  );
}

function qualificationReferencesEqual(
  left: QualificationReportReference,
  right: QualificationReportReference,
): boolean {
  return (
    left.qualificationReportId === right.qualificationReportId &&
    left.definitionSha256 === right.definitionSha256
  );
}

function datasetReferencesEqual(
  left: ExactDatasetReference,
  right: ExactDatasetReference,
): boolean {
  return (
    left.datasetId === right.datasetId &&
    left.datasetVersionId === right.datasetVersionId &&
    left.definitionSha256 === right.definitionSha256
  );
}

function criterionKey(criterion: CriterionReference): string {
  return `${criterion.criterionSet.criterionSetId}:${criterion.criterionSet.criterionSetVersionId}:${criterion.criterionId}:${criterion.criterionSet.definitionSha256}`;
}

function selectorKey(selector: {
  readonly criterionId: string;
  readonly criterionSetId: string;
  readonly criterionSetVersionId: string;
}): string {
  return `${selector.criterionSetId}:${selector.criterionSetVersionId}:${selector.criterionId}`;
}

function current(validFrom: string, validUntil: string, at: string): boolean {
  const instant = Date.parse(at);
  return Date.parse(validFrom) <= instant && instant < Date.parse(validUntil);
}

function sameScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

/** Recomputes whether one immutable calibration report applies to one exact evaluation context. */
export function evaluateCalibrationCompatibility(
  profileInput: unknown,
  calibrationInput: unknown,
  contextInput: CalibrationCompatibilityContext,
): CalibrationCompatibility {
  const profile = parseProfile(profileInput);
  const calibration = parseCalibration(calibrationInput);
  const context = parseContext(contextInput);
  const reasons = new Set<CalibrationIncompatibilityReason>();

  if (!sameScope(profile.scope, calibration.scope) || !sameScope(profile.scope, context.scope)) {
    reasons.add("scope_mismatch");
  }
  if (!current(profile.validFrom, profile.validUntil, context.at))
    reasons.add("profile_not_current");
  if (!current(calibration.validFrom, calibration.validUntil, context.at)) {
    reasons.add("calibration_not_current");
  }
  if (calibration.status !== "calibrated") reasons.add("calibration_unavailable");
  if (calibration.distributionShift.status !== "no_shift_detected") {
    reasons.add("distribution_shift");
  }
  if (
    calibration.modelProfile.modelProfileId !== profile.modelProfileId ||
    calibration.modelProfile.modelProfileVersionId !== profile.modelProfileVersionId ||
    calibration.modelProfile.definitionSha256 !== profile.definitionSha256
  ) {
    reasons.add("model_profile_mismatch");
  }
  if (
    calibration.evaluator.evaluatorId !== profile.evaluator.evaluatorId ||
    calibration.evaluator.evaluatorVersionId !== profile.evaluator.evaluatorVersionId ||
    !evaluatorReferencesEqual(calibration.evaluator, context.evaluator)
  ) {
    reasons.add("evaluator_mismatch");
  }
  if (!qualificationReferencesEqual(calibration.qualificationReport, context.qualificationReport)) {
    reasons.add("qualification_mismatch");
  }
  if (!datasetReferencesEqual(calibration.dataset, context.dataset))
    reasons.add("dataset_mismatch");
  if (
    calibration.population.riskTier !== context.riskTier ||
    !profile.riskTiers.includes(context.riskTier)
  ) {
    reasons.add("risk_tier_mismatch");
  }
  if (calibration.population.locale !== context.locale || profile.locale !== context.locale) {
    reasons.add("locale_mismatch");
  }
  if (!calibration.population.taskKindIds.includes(context.taskKindId)) {
    reasons.add("task_kind_mismatch");
  }
  if (
    calibration.population.populationTags.length !== context.populationTags.length ||
    calibration.population.populationTags.some(
      (tag, index) => tag !== context.populationTags[index],
    )
  ) {
    reasons.add("population_mismatch");
  }
  const contextCriteria = context.criteria.map(criterionKey).sort();
  const calibrationCriteria = calibration.criteria.map(criterionKey).sort();
  const supported = new Set(profile.supportedCriteria.map(selectorKey));
  if (
    contextCriteria.length !== calibrationCriteria.length ||
    contextCriteria.some((key, index) => key !== calibrationCriteria[index]) ||
    context.criteria.some(
      ({ criterionId, criterionSet }) =>
        !supported.has(
          selectorKey({
            criterionId,
            criterionSetId: criterionSet.criterionSetId,
            criterionSetVersionId: criterionSet.criterionSetVersionId,
          }),
        ),
    )
  ) {
    reasons.add("criterion_mismatch");
  }
  return reasons.size === 0
    ? { status: "compatible" }
    : { reasons: [...reasons].sort(), status: "incompatible" };
}
