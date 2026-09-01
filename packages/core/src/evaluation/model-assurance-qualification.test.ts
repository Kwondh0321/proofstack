import { readFileSync } from "node:fs";
import type {
  BlindedEvaluationPlan,
  BlindedEvaluationPlanDefinition,
  CalibrationReport,
  CalibrationReportDefinition,
  EvidenceScope,
  IndependenceDeclaration,
  IndependenceDeclarationDefinition,
  ModelEvaluatorProfile,
  ModelEvaluatorProfileDefinition,
  ModelQualificationReport,
  ModelQualificationReportDefinition,
  ModelQualificationSuite,
  ModelQualificationSuiteDefinition,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  evaluateModelQualificationApplicability,
  InvalidModelQualificationApplicabilityInputError,
} from "./model-assurance-qualification.js";

interface DefinitionVector<T> {
  readonly input: { readonly definition: T; readonly scope: EvidenceScope };
  readonly sha256: string;
}

function vector<T>(name: string): DefinitionVector<T> {
  const document = JSON.parse(
    readFileSync(new URL(`../../../contracts/vectors/${name}`, import.meta.url), "utf8"),
  ) as { readonly vectors: readonly DefinitionVector<T>[] };
  const value = document.vectors[0];
  if (!value) throw new Error(`Expected vector ${name}`);
  return value;
}

interface QualificationFixture {
  readonly blindedPlan: BlindedEvaluationPlan;
  readonly calibration: CalibrationReport;
  readonly independence: IndependenceDeclaration;
  readonly profile: ModelEvaluatorProfile;
  readonly report: ModelQualificationReport;
  readonly suite: ModelQualificationSuite;
}

function fixture(): QualificationFixture {
  const profileVector = vector<ModelEvaluatorProfileDefinition>(
    "evaluation-model-assurance-definition-v1.json",
  );
  const independenceVector = vector<IndependenceDeclarationDefinition>(
    "evaluation-independence-definition-v1.json",
  );
  const calibrationVector = vector<CalibrationReportDefinition>(
    "evaluation-calibration-definition-v1.json",
  );
  const planVector = vector<BlindedEvaluationPlanDefinition>(
    "evaluation-blinded-plan-definition-v1.json",
  );
  const suiteVector = vector<ModelQualificationSuiteDefinition>(
    "evaluation-model-qualification-suite-definition-v1.json",
  );
  const reportVector = vector<ModelQualificationReportDefinition>(
    "evaluation-model-qualification-report-definition-v1.json",
  );
  const scope = structuredClone(suiteVector.input.scope);
  const profile: ModelEvaluatorProfile = {
    ...structuredClone(profileVector.input.definition),
    definitionSha256: profileVector.sha256,
    publishedAt: "2026-09-01T23:59:59.000Z",
    publishedByPrincipalId: "usr_model_profile_publisher",
    schemaVersion: "0.1",
    scope: structuredClone(scope),
  };
  const independence: IndependenceDeclaration = {
    ...structuredClone(independenceVector.input.definition),
    definitionSha256: independenceVector.sha256,
    recordedAt: "2026-09-02T00:10:01.000Z",
    schemaVersion: "0.1",
    scope: structuredClone(scope),
  };
  const calibration: CalibrationReport = {
    ...structuredClone(calibrationVector.input.definition),
    definitionSha256: calibrationVector.sha256,
    recordedAt: "2026-09-02T00:20:01.000Z",
    schemaVersion: "0.1",
    scope: structuredClone(scope),
  };
  const blindedPlan: BlindedEvaluationPlan = {
    ...structuredClone(planVector.input.definition),
    definitionSha256: planVector.sha256,
    publishedAt: "2026-09-02T00:29:59.000Z",
    publishedByPrincipalId: "usr_blind_plan_publisher",
    schemaVersion: "0.1",
    scope: structuredClone(scope),
  };
  const suite: ModelQualificationSuite = {
    ...structuredClone(suiteVector.input.definition),
    definitionSha256: suiteVector.sha256,
    publishedAt: "2026-09-02T03:59:59.000Z",
    publishedByPrincipalId: "usr_qualification_suite_publisher",
    schemaVersion: "0.1",
    scope: structuredClone(scope),
  };
  const report: ModelQualificationReport = {
    ...structuredClone(reportVector.input.definition),
    definitionSha256: reportVector.sha256,
    recordedAt: "2026-09-02T05:30:01.000Z",
    schemaVersion: "0.1",
    scope: structuredClone(scope),
  };

  suite.modelProfile = {
    definitionSha256: profile.definitionSha256,
    modelProfileId: profile.modelProfileId,
    modelProfileVersionId: profile.modelProfileVersionId,
  };
  report.modelProfile = structuredClone(suite.modelProfile);
  report.evaluator = structuredClone(suite.evaluator);
  independence.subject.evaluator = structuredClone(suite.evaluator);
  independence.subject.modelProfile = structuredClone(suite.modelProfile);
  report.independenceDeclaration = {
    definitionSha256: independence.definitionSha256,
    independenceDeclarationId: independence.independenceDeclarationId,
  };
  report.calibrationReport = {
    calibrationReportId: calibration.calibrationReportId,
    definitionSha256: calibration.definitionSha256,
  };
  report.suite = {
    definitionSha256: suite.definitionSha256,
    suiteId: suite.suiteId,
    suiteVersionId: suite.suiteVersionId,
  };
  suite.blindedPlan = {
    blindedPlanId: blindedPlan.blindedPlanId,
    blindedPlanVersionId: blindedPlan.blindedPlanVersionId,
    definitionSha256: blindedPlan.definitionSha256,
  };
  calibration.dataset = structuredClone(suite.dataset);
  report.statusSummary.caseCount = suite.caseCount;
  return { blindedPlan, calibration, independence, profile, report, suite };
}

function evaluate(value: QualificationFixture, at = "2026-09-02T06:00:00.000Z") {
  return evaluateModelQualificationApplicability(
    value.suite,
    value.report,
    value.profile,
    value.independence,
    value.calibration,
    value.blindedPlan,
    at,
  );
}

describe("model qualification applicability", () => {
  it("accepts only an exact current qualification lineage", () => {
    const value = fixture();
    expect(evaluate(value)).toEqual({ reportId: value.report.reportId, status: "applicable" });
  });

  it("fails closed for an unqualified or stale report", () => {
    const unqualified = fixture();
    unqualified.report.status = "unqualified";
    unqualified.report.failureReasons = ["Provider behavior no longer matches the frozen suite"];
    expect(evaluate(unqualified)).toEqual({
      reasons: ["report_unqualified"],
      status: "inapplicable",
    });

    const stale = fixture();
    expect(evaluate(stale, stale.report.validUntil)).toEqual({
      reasons: ["calibration_not_current", "report_not_current"],
      status: "inapplicable",
    });

    const staleCalibration = fixture();
    staleCalibration.calibration.validUntil = "2026-09-02T05:59:59.000Z";
    expect(evaluate(staleCalibration)).toEqual({
      reasons: ["calibration_not_current"],
      status: "inapplicable",
    });

    const staleProfile = fixture();
    staleProfile.profile.validUntil = "2026-09-02T05:59:59.000Z";
    expect(evaluate(staleProfile)).toEqual({
      reasons: ["profile_not_current"],
      status: "inapplicable",
    });

    const unavailableCalibration = fixture();
    unavailableCalibration.calibration.status = "unavailable";
    unavailableCalibration.calibration.statusReasons = ["Calibration labels require refresh"];
    expect(evaluate(unavailableCalibration)).toEqual({
      reasons: ["calibration_unavailable"],
      status: "inapplicable",
    });

    const staleIndependence = fixture();
    staleIndependence.independence.validUntil = "2026-09-02T05:59:59.000Z";
    expect(evaluate(staleIndependence)).toEqual({
      reasons: ["independence_not_current"],
      status: "inapplicable",
    });

    const rejectedIndependence = fixture();
    rejectedIndependence.independence.reviewStatus = "rejected";
    expect(evaluate(rejectedIndependence)).toEqual({
      reasons: ["independence_not_verified"],
      status: "inapplicable",
    });
  });

  it("checks exact suite, blind-plan, profile, evaluator, independence, and calibration lineage", () => {
    const mutations: readonly [(value: QualificationFixture) => void, readonly string[]][] = [
      [
        (value) => {
          value.report.suite.definitionSha256 = "f".repeat(64);
        },
        ["suite_mismatch"],
      ],
      [
        (value) => {
          value.suite.blindedPlan.definitionSha256 = "f".repeat(64);
        },
        ["blinded_plan_mismatch"],
      ],
      [
        (value) => {
          value.report.modelProfile.definitionSha256 = "f".repeat(64);
        },
        ["model_profile_mismatch"],
      ],
      [
        (value) => {
          value.report.evaluator.definitionSha256 = "f".repeat(64);
        },
        ["evaluator_mismatch", "independence_mismatch"],
      ],
      [
        (value) => {
          value.report.independenceDeclaration.definitionSha256 = "f".repeat(64);
        },
        ["independence_mismatch"],
      ],
      [
        (value) => {
          value.report.calibrationReport.definitionSha256 = "f".repeat(64);
        },
        ["calibration_mismatch"],
      ],
    ];
    for (const [mutate, reasons] of mutations) {
      const value = fixture();
      mutate(value);
      expect(evaluate(value)).toEqual({ reasons, status: "inapplicable" });
    }
  });

  it("checks dataset, criteria, cases, scenarios, scope, and execution window", () => {
    const dataset = fixture();
    dataset.calibration.dataset.datasetId = "eds_other";
    expect(evaluate(dataset)).toEqual({ reasons: ["dataset_mismatch"], status: "inapplicable" });

    const criteria = fixture();
    const criterion = criteria.calibration.criteria[0];
    if (!criterion) throw new Error("Expected a calibration criterion");
    criterion.criterionId = "crt_other";
    expect(evaluate(criteria)).toEqual({ reasons: ["criteria_mismatch"], status: "inapplicable" });

    const cases = fixture();
    cases.suite.caseCount += 1;
    expect(evaluate(cases)).toEqual({ reasons: ["case_count_mismatch"], status: "inapplicable" });

    const scope = fixture();
    scope.report.scope.environmentId = "env_other";
    expect(evaluate(scope)).toEqual({ reasons: ["scope_mismatch"], status: "inapplicable" });

    const execution = fixture();
    execution.suite.publishedAt = "2026-09-02T05:00:01.000Z";
    expect(evaluate(execution)).toEqual({
      reasons: ["execution_outside_suite"],
      status: "inapplicable",
    });

    const blindExecution = fixture();
    blindExecution.blindedPlan.validUntil = "2026-09-02T05:29:59.000Z";
    expect(evaluate(blindExecution)).toEqual({
      reasons: ["execution_outside_blinded_plan"],
      status: "inapplicable",
    });

    const invalidPlan = fixture();
    invalidPlan.blindedPlan.planStatus = "invalid";
    invalidPlan.blindedPlan.statusReasons = ["A leakage control failed"];
    const check = invalidPlan.blindedPlan.leakageChecks[0];
    if (!check) throw new Error("Expected a blind leakage check");
    check.status = "failed";
    expect(evaluate(invalidPlan)).toEqual({
      reasons: ["blinded_plan_invalid"],
      status: "inapplicable",
    });
  });

  it("rejects malformed records and timestamps before evaluating", () => {
    const value = fixture();
    expect(() =>
      evaluateModelQualificationApplicability(
        {},
        value.report,
        value.profile,
        value.independence,
        value.calibration,
        value.blindedPlan,
        "2026-09-02T06:00:00.000Z",
      ),
    ).toThrow(InvalidModelQualificationApplicabilityInputError);
    expect(() => evaluate(value, "tomorrow")).toThrow(
      InvalidModelQualificationApplicabilityInputError,
    );
  });
});
