import { readFileSync } from "node:fs";
import type { CalibrationReport, ModelEvaluatorProfile } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  type CalibrationCompatibilityContext,
  evaluateCalibrationCompatibility,
  InvalidCalibrationCompatibilityInputError,
} from "./model-assurance-calibration.js";

interface StoredVector {
  readonly input: { definition: Record<string, unknown>; scope: Record<string, string> };
  readonly sha256: string;
}

interface VectorDocument {
  readonly vectors: readonly StoredVector[];
}

function vector(file: string): StoredVector {
  const document = JSON.parse(
    readFileSync(new URL(`../../../contracts/vectors/${file}`, import.meta.url), "utf8"),
  ) as VectorDocument;
  const value = document.vectors[0];
  if (!value) throw new Error(`Expected vector ${file}`);
  return value;
}

function records(): {
  calibration: CalibrationReport;
  context: CalibrationCompatibilityContext;
  profile: ModelEvaluatorProfile;
} {
  const profileVector = vector("evaluation-model-assurance-definition-v1.json");
  const profile = {
    ...structuredClone(profileVector.input.definition),
    definitionSha256: profileVector.sha256,
    publishedAt: "2026-09-02T00:00:01.000Z",
    publishedByPrincipalId: "usr_profile_publisher",
    schemaVersion: "0.1",
    scope: structuredClone(profileVector.input.scope),
  } as unknown as ModelEvaluatorProfile;
  const calibrationVector = vector("evaluation-calibration-definition-v1.json");
  const definition = structuredClone(calibrationVector.input.definition) as unknown as Omit<
    CalibrationReport,
    "definitionSha256" | "recordedAt" | "schemaVersion" | "scope"
  >;
  definition.modelProfile.definitionSha256 = profile.definitionSha256;
  const calibration = {
    ...definition,
    definitionSha256: "c".repeat(64),
    recordedAt: "2026-09-02T00:20:01.000Z",
    schemaVersion: "0.1",
    scope: structuredClone(calibrationVector.input.scope),
  } as CalibrationReport;
  const context: CalibrationCompatibilityContext = {
    at: "2026-09-15T00:00:00.000Z",
    criteria: structuredClone(calibration.criteria),
    dataset: structuredClone(calibration.dataset),
    evaluator: structuredClone(calibration.evaluator),
    locale: calibration.population.locale,
    populationTags: structuredClone(calibration.population.populationTags),
    qualificationReport: structuredClone(calibration.qualificationReport),
    riskTier: calibration.population.riskTier,
    scope: structuredClone(calibration.scope),
    taskKindId: calibration.population.taskKindIds[0] ?? "task_missing",
  };
  return { calibration, context, profile };
}

describe("model calibration compatibility", () => {
  it("accepts only the exact current model, evaluator, corpus, population, and criterion slice", () => {
    const { calibration, context, profile } = records();
    expect(evaluateCalibrationCompatibility(profile, calibration, context)).toEqual({
      status: "compatible",
    });
  });

  it("fails closed when calibration or profile validity does not cover evaluation time", () => {
    const { calibration, context, profile } = records();
    const staleContext = { ...context, at: "2026-12-01T00:00:00.000Z" };
    expect(evaluateCalibrationCompatibility(profile, calibration, staleContext)).toEqual({
      reasons: ["calibration_not_current", "profile_not_current"],
      status: "incompatible",
    });
  });

  it("rejects unavailable or shifted calibration without raw-confidence fallback", () => {
    const { calibration, context, profile } = records();
    calibration.status = "unavailable";
    calibration.statusReasons = ["Current population shift was detected"];
    calibration.distributionShift = {
      evidence: calibration.calibrationEvidence.slice(0, 1),
      method: "Population stability index v1",
      status: "shift_detected",
    };
    expect(evaluateCalibrationCompatibility(profile, calibration, context)).toEqual({
      reasons: ["calibration_unavailable", "distribution_shift"],
      status: "incompatible",
    });
  });

  it("detects exact model, evaluator, qualification, dataset, and scope mismatches", () => {
    const { calibration, context, profile } = records();
    calibration.modelProfile.definitionSha256 = "0".repeat(64);
    const mismatchedContext = {
      ...context,
      dataset: { ...context.dataset, definitionSha256: "3".repeat(64) },
      evaluator: { ...context.evaluator, definitionSha256: "1".repeat(64) },
      qualificationReport: {
        ...context.qualificationReport,
        definitionSha256: "2".repeat(64),
      },
      scope: { ...context.scope, environmentId: "env_other" },
    };
    expect(evaluateCalibrationCompatibility(profile, calibration, mismatchedContext)).toEqual({
      reasons: [
        "dataset_mismatch",
        "evaluator_mismatch",
        "model_profile_mismatch",
        "qualification_mismatch",
        "scope_mismatch",
      ],
      status: "incompatible",
    });
  });

  it("rejects extrapolation across risk, locale, task, population, or criteria", () => {
    const { calibration, context, profile } = records();
    const criteria = structuredClone(context.criteria);
    const criterion = criteria[0];
    if (!criterion) throw new Error("Expected criterion");
    criterion.criterionSet.definitionSha256 = "4".repeat(64);
    const extrapolatedContext = {
      ...context,
      criteria,
      locale: "ko",
      populationTags: ["agent:other"],
      riskTier: "critical" as const,
      taskKindId: "task_other",
    };
    expect(evaluateCalibrationCompatibility(profile, calibration, extrapolatedContext)).toEqual({
      reasons: [
        "criterion_mismatch",
        "locale_mismatch",
        "population_mismatch",
        "risk_tier_mismatch",
        "task_kind_mismatch",
      ],
      status: "incompatible",
    });
  });

  it("rejects malformed profile, calibration, and context inputs", () => {
    const { calibration, context, profile } = records();
    expect(() => evaluateCalibrationCompatibility({}, calibration, context)).toThrow(
      InvalidCalibrationCompatibilityInputError,
    );
    expect(() => evaluateCalibrationCompatibility(profile, {}, context)).toThrow(
      InvalidCalibrationCompatibilityInputError,
    );
    expect(() =>
      evaluateCalibrationCompatibility(profile, calibration, {
        ...context,
        populationTags: ["z", "a"],
      }),
    ).toThrow(InvalidCalibrationCompatibilityInputError);
  });
});
