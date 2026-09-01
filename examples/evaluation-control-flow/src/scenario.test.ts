import type {
  EvidenceScope,
  EvaluationRun,
  EvaluationRunResult,
  PrincipalContext,
  RawObservation,
} from "@proofstack/contracts";
import {
  CreateAssessment,
  CreateEvaluationAggregate,
  MemoryEvaluationRepository,
  PublishEvaluationDefinition,
  RecordCriterionSetStatus,
  RecordEvaluationRunDecision,
  RecordEvaluationRunResult,
  RecordQualificationReport,
  RecordRawObservation,
  type EvaluationRecordKind,
  type RecordEvaluationCommand,
  type RecordEvaluationDependencies,
} from "@proofstack/core";
import { describe, expect, it } from "vitest";
import { EvaluationScenario, type ReferenceVerdict } from "./scenario.js";

const scope: EvidenceScope = {
  environmentId: "env_reference",
  projectId: "prj_reference",
  tenantId: "ten_reference",
};

const principal: PrincipalContext = {
  authentication: {
    authenticatedAt: "2026-09-02T11:59:00.000Z",
    method: "development",
  },
  capabilities: ["evaluation:manage", "evaluation:read", "evaluation:run"],
  principalId: "svc_evaluator",
  principalType: "service",
  requestId: "req_reference_scenario",
  resourceScope: { mode: "tenant" },
  roles: ["admin"],
  tenantId: scope.tenantId,
};

const verdicts = ["pass", "fail", "abstain", "error", "not_applicable"] as const;

function command<Kind extends EvaluationRecordKind>(
  kind: Kind,
  recordId: string,
  definition: RecordEvaluationCommand<Kind>["definition"],
): RecordEvaluationCommand<Kind> {
  return {
    definition,
    environmentId: scope.environmentId,
    kind,
    principal,
    projectId: scope.projectId,
    recordId,
  };
}

describe("contestable evaluation reference scenario", () => {
  it("materializes the complete conservative decision graph through public core operations", async () => {
    const dependencies: RecordEvaluationDependencies = {
      clock: { now: () => new Date("2026-09-02T12:00:00.000Z") },
      repository: new MemoryEvaluationRepository(),
    };
    const definitions = new PublishEvaluationDefinition(dependencies);
    const statuses = new RecordCriterionSetStatus(dependencies);
    const runDecisions = new RecordEvaluationRunDecision(dependencies);
    const reports = new RecordQualificationReport(dependencies);
    const observations = new RecordRawObservation(dependencies);
    const results = new RecordEvaluationRunResult(dependencies);
    const aggregates = new CreateEvaluationAggregate(dependencies);
    const assessments = new CreateAssessment(dependencies);
    const scenario = new EvaluationScenario({
      environmentId: scope.environmentId,
      namespace: "reference",
    });

    const discovery = (
      await definitions.execute(
        command("discovery_record", "dsc_primary_reference", scenario.discovery()),
      )
    ).record;
    const conflictSource = (
      await definitions.execute(
        command("source_snapshot", scenario.ids.sourceConflict, scenario.conflictingSource()),
      )
    ).record;
    const primarySource = (
      await definitions.execute(
        command(
          "source_snapshot",
          scenario.ids.sourcePrimary,
          scenario.primarySource(discovery, conflictSource),
        ),
      )
    ).record;
    const conflictReview = (
      await definitions.execute(
        command(
          "source_review",
          scenario.ids.sourceReviewConflict,
          scenario.conflictingSourceReview(conflictSource),
        ),
      )
    ).record;
    const primaryReview = (
      await definitions.execute(
        command(
          "source_review",
          scenario.ids.sourceReviewPrimary,
          scenario.primarySourceReview(primarySource, conflictSource),
        ),
      )
    ).record;
    const fixtureSet = (
      await definitions.execute(
        command(
          "qualification_fixture_set",
          scenario.ids.fixtureSetVersion,
          scenario.qualificationFixtureSet(),
        ),
      )
    ).record;
    const oracle = (
      await definitions.execute(
        command("oracle_spec", scenario.ids.oracleVersion, scenario.oracle(fixtureSet)),
      )
    ).record;
    const evaluator = (
      await definitions.execute(
        command(
          "evaluator_spec",
          scenario.ids.evaluatorVersion,
          scenario.evaluator(fixtureSet, oracle),
        ),
      )
    ).record;
    const criterionSet = (
      await definitions.execute(
        command(
          "criterion_set",
          scenario.ids.criterionSetVersion,
          scenario.criterionSet({
            conflictReview,
            conflictSource,
            evaluator,
            oracle,
            primaryReview,
            primarySource,
          }),
        ),
      )
    ).record;
    const policy = (
      await definitions.execute(
        command("aggregation_policy", scenario.ids.policyVersion, scenario.aggregationPolicy()),
      )
    ).record;
    const draftStatus = (
      await statuses.execute(
        command(
          "criterion_set_status",
          scenario.ids.statusDraft,
          scenario.draftStatus(criterionSet),
        ),
      )
    ).record;
    const approvedStatus = (
      await statuses.execute(
        command(
          "criterion_set_status",
          scenario.ids.statusApproved,
          scenario.approvedStatus(criterionSet, draftStatus),
        ),
      )
    ).record;
    const oracleQualification = (
      await reports.execute(
        command(
          "qualification_report",
          "qlr_oracle_reference",
          scenario.qualificationReport(oracle, fixtureSet),
        ),
      )
    ).record;
    const evaluatorQualification = (
      await reports.execute(
        command(
          "qualification_report",
          "qlr_evaluator_reference",
          scenario.qualificationReport(evaluator, fixtureSet),
        ),
      )
    ).record;

    const recordedRuns: EvaluationRun[] = [];
    const recordedObservations: RawObservation[] = [];
    const recordedResults: EvaluationRunResult[] = [];
    for (const verdict of verdicts) {
      const run = (
        await runDecisions.execute(
          command(
            "evaluation_run",
            `evr_${verdict}_reference`,
            scenario.run({
              criterionSet,
              evaluator,
              evaluatorQualification,
              oracle,
              oracleQualification,
              policy,
              sourceReviews: [conflictReview, primaryReview],
              status: approvedStatus,
              verdict,
            }),
          ),
        )
      ).record;
      recordedRuns.push(run);
      let observation: RawObservation | undefined;
      if (verdict !== "not_applicable") {
        observation = (
          await observations.execute(
            command(
              "raw_observation",
              `obs_${verdict}_reference`,
              scenario.observation(run, verdict),
            ),
          )
        ).record;
        recordedObservations.push(observation);
      }
      recordedResults.push(
        (
          await results.execute(
            command(
              "evaluation_run_result",
              `evs_${verdict}_reference`,
              scenario.result(run, verdict, observation),
            ),
          )
        ).record,
      );
    }

    const aggregate = (
      await aggregates.execute(
        command(
          "evaluation_aggregate",
          scenario.ids.aggregate,
          scenario.aggregate(policy, criterionSet, recordedRuns, recordedResults),
        ),
      )
    ).record;
    const assessment = (
      await assessments.execute(
        command(
          "assessment",
          scenario.ids.assessment,
          scenario.assessment({
            aggregate,
            criterionSet,
            observations: recordedObservations,
            policy,
            qualifications: [oracleQualification, evaluatorQualification],
            reviews: [conflictReview, primaryReview],
            runs: recordedRuns,
            sources: [conflictSource, primarySource],
            status: approvedStatus,
          }),
        ),
      )
    ).record;

    expect(recordedRuns.map((run) => run.applicability.result)).toEqual([
      "applicable",
      "applicable",
      "applicable",
      "applicable",
      "not_applicable",
    ]);
    expect(recordedRuns.at(-1)?.attempts).toEqual([]);
    expect(recordedResults.at(-1)?.observations).toEqual([]);
    expect(recordedResults.map((result) => result.verdict)).toEqual<ReferenceVerdict[]>([
      ...verdicts,
    ]);
    expect(aggregate.counts).toEqual({
      abstainCount: 1,
      applicableCount: 4,
      attemptedCount: 5,
      decidedCount: 2,
      errorCount: 1,
      failCount: 1,
      notApplicableCount: 1,
      passCount: 1,
      selectedCount: 5,
    });
    expect(aggregate.coverage).toEqual({ denominator: 4, numerator: 2, status: "available" });
    expect(assessment.eligibility).toEqual({
      reasons: [
        "critical_counterevidence",
        "human_review_required",
        "insufficient_coverage",
        "source_review_not_current",
        "unresolved_disagreement",
      ],
      status: "ineligible",
    });
    expect(assessment.dimensions).toMatchObject({
      coverage: "insufficient",
      sourceFreshness: "not_current",
    });
    expect(assessment.supportStatus).toBe("inconclusive");

    expect(() =>
      scenario.run({
        criterionSet: { ...criterionSet, criteria: [] },
        evaluator,
        evaluatorQualification,
        oracle,
        oracleQualification,
        policy,
        sourceReviews: [conflictReview, primaryReview],
        status: approvedStatus,
        verdict: "pass",
      }),
    ).toThrow("Reference criterion set is empty");
    const nonApplicableRun = recordedRuns.at(-1);
    if (!nonApplicableRun) throw new TypeError("Reference scenario omitted its final run");
    expect(() => scenario.observation(nonApplicableRun, "pass")).toThrow(
      "Executed reference run is missing its attempt",
    );
    const firstRun = recordedRuns[0];
    if (!firstRun) throw new TypeError("Reference scenario omitted its first run");
    expect(() => scenario.aggregate(policy, criterionSet, [firstRun], [])).toThrow(
      `Missing result for ${firstRun.evaluationRunId}`,
    );
  });

  it.each(["UPPERCASE", "contains-hyphen", "waytoolongnamespacevalue"])(
    "rejects the unsafe namespace %s before constructing identifiers",
    (namespace) => {
      expect(
        () => new EvaluationScenario({ environmentId: scope.environmentId, namespace }),
      ).toThrow("Evaluation scenario namespace");
    },
  );
});
