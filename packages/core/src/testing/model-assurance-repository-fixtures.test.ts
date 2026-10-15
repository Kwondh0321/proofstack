import {
  ArtifactContentReferenceSchema,
  ModelAssuranceAssessmentInputSchema,
  PolicyEvaluationSourceReferenceSchema,
  policyEvaluationSourceReferenceKey,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { CreateModelAssuranceAssessment } from "../evaluation/create-model-assurance-assessment.js";
import { FixedClock } from "./fixed-clock.js";
import { createModelAssuranceRepositoryTestHarness } from "./model-assurance-repository-fixtures.js";

describe("model-assurance repository fixtures", () => {
  it.each(["pg_nested_assessment_disagreement", "pg_assurance_corrupt_0123456789ab"])(
    "retains valid artifact identities for the native namespace %s",
    async (namespace) => {
      const harness = await createModelAssuranceRepositoryTestHarness(namespace);
      expect(harness.evaluation.scope.tenantId).toBe(`ten_${namespace}`);
      expect(harness.records).toHaveLength(20);
    },
  );
  it("keeps each external source identity bound to one exact original reference", async () => {
    const harness = await createModelAssuranceRepositoryTestHarness("assurance_references");
    const sources = new Map<string, unknown>();
    const kinds = PolicyEvaluationSourceReferenceSchema.options.map(
      (option) => option.shape.kind.value,
    );
    const visit = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      if ("definitionSha256" in value)
        for (const kind of kinds) {
          const parsed = PolicyEvaluationSourceReferenceSchema.safeParse({
            kind,
            reference: value,
          });
          if (!parsed.success) continue;
          const source = parsed.data;
          const key = policyEvaluationSourceReferenceKey(source);
          if (sources.has(key)) expect(source, key).toEqual(sources.get(key));
          sources.set(key, source);
        }
      for (const child of Object.values(value)) visit(child);
    };
    for (const { record } of [...harness.evaluation.records, ...harness.records]) visit(record);
    expect(sources.size).toBeGreaterThan(40);
  });
  it("retains one exact descriptor for each artifact across the complete joined graph", async () => {
    const harness = await createModelAssuranceRepositoryTestHarness("assurance_artifacts");
    const references = new Map<string, ReturnType<typeof ArtifactContentReferenceSchema.parse>>();
    let occurrences = 0;
    const visit = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      const parsed = ArtifactContentReferenceSchema.safeParse(value);
      if (parsed.success) {
        const reference = parsed.data;
        const previous = references.get(reference.artifactId);
        if (previous) expect(reference, reference.artifactId).toEqual(previous);
        references.set(reference.artifactId, reference);
        occurrences++;
      }
      for (const child of Object.values(value)) visit(child);
    };
    for (const { record } of [...harness.evaluation.records, ...harness.records]) visit(record);
    expect(references.size).toBeGreaterThan(10);
    expect(occurrences).toBeGreaterThan(references.size);
  });
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
    expect(harness.records).toHaveLength(20);
    expect(ModelAssuranceAssessmentInputSchema.parse(harness.command.definition)).toEqual(
      harness.command.definition,
    );

    const critique = harness.records.find(({ kind }) => kind === "independent_critique");
    const baseQualification = harness.evaluation.records.find(
      ({ kind }) => kind === "qualification_report",
    );
    if (!baseQualification || baseQualification.kind !== "qualification_report") {
      throw new Error("Expected a base qualification fixture");
    }
    expect(critique?.record).toMatchObject({
      modelQualificationReport: {
        reportId: expect.stringContaining("critic"),
      },
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
