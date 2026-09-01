import {
  AssessmentDefinitionSchema,
  BlindedEvaluationResultDefinitionSchema,
  CalibrationReportDefinitionSchema,
  HumanReviewRecordDefinitionSchema,
  IndependenceDeclarationDefinitionSchema,
  IndependentCritiqueDefinitionSchema,
  ModelQualificationReportDefinitionSchema,
} from "@proofstack/contracts";
import { createModelAssuranceRepositoryTestHarness } from "@proofstack/core/testing";
import { beforeAll, describe, expect, it } from "vitest";
import {
  correlatedCriticQualificationDefinition,
  correlatedCritiqueDefinition,
  correlatedIndependenceDefinition,
  criticalBaseAssessmentDefinition,
  humanReviewVariantDefinition,
  reversedBlindResultDefinition,
  unavailableCalibrationDefinition,
  unqualifiedModelReportDefinition,
} from "./scenario.js";

let harness: Awaited<ReturnType<typeof createModelAssuranceRepositoryTestHarness>>;

beforeAll(async () => {
  harness = await createModelAssuranceRepositoryTestHarness("model_example_unit");
});

function evaluationRecord<Kind extends string>(kind: Kind) {
  const fixture = harness.evaluation.records.find((candidate) => candidate.kind === kind);
  if (!fixture) throw new Error(`Expected ${kind} evaluation fixture`);
  return fixture.record;
}

function assuranceRecord<Kind extends string>(kind: Kind, index = 0) {
  const fixtures = harness.records.filter((candidate) => candidate.kind === kind);
  const fixture = fixtures[index];
  if (!fixture) throw new Error(`Expected ${kind} assurance fixture at ${index}`);
  return fixture.record;
}

describe("model-assurance reference scenario variants", () => {
  it("creates a strict critical non-model base assessment", () => {
    const definition = criticalBaseAssessmentDefinition(
      evaluationRecord("assessment") as never,
      "unit",
    );
    expect(AssessmentDefinitionSchema.parse(definition)).toMatchObject({
      eligibility: { reasons: ["critical_counterevidence"], status: "ineligible" },
    });
  });

  it("creates strict incompatible calibration and correlated lineage records", () => {
    expect(
      CalibrationReportDefinitionSchema.parse(
        unavailableCalibrationDefinition(assuranceRecord("calibration_report") as never, "unit"),
      ),
    ).toMatchObject({ status: "unavailable" });
    const primary = assuranceRecord("independence_declaration", 0) as never;
    const critic = assuranceRecord("independence_declaration", 1) as never;
    const correlated = IndependenceDeclarationDefinitionSchema.parse(
      correlatedIndependenceDefinition(primary, critic, "unit"),
    );
    expect(correlated).toMatchObject({
      dimensions: {
        providers: (primary as { dimensions: { providers: unknown } }).dimensions.providers,
      },
      independenceDeclarationId: "ind_unit_correlated_alias",
    });
    expect(() =>
      correlatedIndependenceDefinition(
        {
          ...(primary as object),
          dimensions: {
            ...(primary as { dimensions: object }).dimensions,
            providers: { reason: "unknown", status: "unknown" },
          },
        } as never,
        critic,
        "missing",
      ),
    ).toThrow(/provider lineage/);
  });

  it("retains both order-reversal directions and rejects an incomplete fixture", () => {
    const source = assuranceRecord("blinded_evaluation_result") as never;
    expect(
      BlindedEvaluationResultDefinitionSchema.parse(reversedBlindResultDefinition(source, "unit")),
    ).toMatchObject({ status: "disagreement" });
    const opposite = structuredClone(source) as {
      attempts: Array<{ status: string; verdict?: "fail" | "pass" }>;
    };
    const second = opposite.attempts[1];
    if (second?.status !== "completed") throw new Error("Expected second attempt");
    second.verdict = "fail";
    expect(reversedBlindResultDefinition(opposite as never, "opposite").attempts[1]).toMatchObject({
      verdict: "pass",
    });
    opposite.attempts.pop();
    expect(() => reversedBlindResultDefinition(opposite as never, "missing")).toThrow(
      /second completed order/,
    );
  });

  it("creates an unqualified injection report and preserves opposing and recused reviews", () => {
    expect(
      ModelQualificationReportDefinitionSchema.parse(
        unqualifiedModelReportDefinition(
          assuranceRecord("model_qualification_report") as never,
          "unit",
        ),
      ),
    ).toMatchObject({
      criticalScenarioFailures: ["direct_prompt_injection", "forged_citation"],
      status: "unqualified",
    });
    const review = assuranceRecord("human_review_record") as never;
    expect(
      HumanReviewRecordDefinitionSchema.parse(
        humanReviewVariantDefinition(review, "unit", "oppose"),
      ),
    ).toMatchObject({ action: "oppose", conflicts: [] });
    expect(
      HumanReviewRecordDefinitionSchema.parse(
        humanReviewVariantDefinition(review, "unit", "recuse"),
      ),
    ).toMatchObject({ action: "recuse", conflicts: ["shared_operating_organization"] });
  });

  it("rebinds a critic and its qualification to correlated exact lineage", () => {
    const primary = assuranceRecord("independence_declaration", 0) as never;
    const critic = assuranceRecord("independence_declaration", 1) as never;
    const declaration = {
      ...correlatedIndependenceDefinition(primary, critic, "unit"),
      definitionSha256: "a".repeat(64),
      recordedAt: "2026-09-02T05:45:00.000Z",
      schemaVersion: "0.1",
      scope: (primary as { scope: object }).scope,
    } as never;
    const reportDefinition = correlatedCriticQualificationDefinition(
      assuranceRecord("model_qualification_report", 1) as never,
      declaration,
      "unit",
    );
    expect(ModelQualificationReportDefinitionSchema.parse(reportDefinition)).toMatchObject({
      independenceDeclaration: { definitionSha256: "a".repeat(64) },
      reportId: "mqr_unit_correlated_critic",
    });
    const report = {
      ...reportDefinition,
      definitionSha256: "b".repeat(64),
      recordedAt: "2026-09-02T05:45:00.000Z",
      schemaVersion: "0.1",
      scope: (primary as { scope: object }).scope,
    } as never;
    expect(
      IndependentCritiqueDefinitionSchema.parse(
        correlatedCritiqueDefinition(
          assuranceRecord("independent_critique") as never,
          declaration,
          report,
          "unit",
        ),
      ),
    ).toMatchObject({
      critiqueId: "crt_unit_correlated",
      modelQualificationReport: { definitionSha256: "b".repeat(64) },
    });
  });
});
