import { describe, expect, it } from "vitest";
import { CreateModelAssuranceAssessment } from "../evaluation/create-model-assurance-assessment.js";
import { FixedClock } from "./fixed-clock.js";
import { createModelAssuranceRepositoryTestHarness } from "./model-assurance-repository-fixtures.js";

describe("model-assurance repository fixtures", () => {
  it("builds a complete eligible graph in dependency order", async () => {
    const harness = await createModelAssuranceRepositoryTestHarness("assurance_fixture");
    expect(new Set(harness.records.map(({ kind }) => kind))).toEqual(
      new Set([
        "blinded_evaluation_plan",
        "blinded_evaluation_result",
        "calibration_report",
        "human_review_protocol",
        "human_review_record",
        "human_reviewer_independence",
        "independence_declaration",
        "independent_critique",
        "model_assisted_evaluator",
        "model_evaluator_profile",
        "model_qualification_report",
        "model_qualification_suite",
      ]),
    );
    expect(harness.records).toHaveLength(17);

    const critique = harness.records.find(({ kind }) => kind === "independent_critique");
    const baseQualification = harness.evaluation.records.find(
      ({ kind }) => kind === "qualification_report",
    );
    if (!baseQualification || baseQualification.kind !== "qualification_report") {
      throw new Error("Expected a base qualification fixture");
    }
    expect(critique?.record).toMatchObject({
      qualificationReport: {
        definitionSha256: baseQualification.record.definitionSha256,
        qualificationReportId: baseQualification.record.qualificationReportId,
      },
    });

    const assessment = await new CreateModelAssuranceAssessment({
      clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
      evaluationRepository: harness.evaluation.repository,
      modelAssuranceRepository: harness.repository,
    }).execute(harness.command);
    expect(assessment).toMatchObject({
      created: true,
      record: {
        eligibility: "eligible",
        reasons: [],
        validUntil: "2026-09-03T00:30:00.000Z",
      },
    });
  });
});
