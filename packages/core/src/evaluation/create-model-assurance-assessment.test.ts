import { readFileSync } from "node:fs";
import type {
  Assessment,
  BlindedEvaluationPlanDefinition,
  BlindedEvaluationResultDefinition,
  CalibrationReportDefinition,
  EvaluationAggregationPolicy,
  EvaluationRun,
  HumanReviewProtocolDefinition,
  IndependenceDeclarationDefinition,
  ModelAssistedEvaluatorSpecDefinition,
  ModelEvaluatorProfileDefinition,
  ModelQualificationReportDefinition,
  ModelQualificationSuiteDefinition,
  OracleSpec,
  PrincipalContext,
  QualificationReport,
  RawObservation,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "../errors.js";
import { FixedClock } from "../testing/fixed-clock.js";
import { createEvaluationRepositoryTestHarness } from "../testing/evaluation-repository-fixtures.js";
import { publishEvaluationFixture } from "../testing/evaluation-repository-conformance.js";
import { MemoryModelAssuranceRepository } from "../testing/memory-model-assurance-repository.js";
import {
  CreateModelAssuranceAssessment,
  type CreateModelAssuranceAssessmentCommand,
  addBlindReasons,
  addCalibrationReasons,
  addCritiqueReasons,
  addHumanReasons,
  addQualificationReasons,
  minimumEligibleValidity,
  ModelAssuranceDependencyError,
} from "./create-model-assurance-assessment.js";
import {
  digestModelAssuranceRecordDefinition,
  validateModelAssuranceRecord,
} from "./model-assurance-record-validation.js";
import type {
  ModelAssuranceRecordByKind,
  ModelAssuranceRecordKind,
} from "./model-assurance-repository.js";
import {
  InvalidModelAssuranceRecordInputError,
  ModelAssuranceRecordConflictError,
  ModelAssuranceRepositoryContractError,
} from "./model-assurance-repository.js";

function vector<T>(filename: string): T {
  const document = JSON.parse(
    readFileSync(new URL(`../../../contracts/vectors/${filename}`, import.meta.url), "utf8"),
  ) as { readonly vectors: readonly { readonly input: { readonly definition: T } }[] };
  const value = document.vectors[0];
  if (!value) throw new Error(`Expected vector ${filename}`);
  return structuredClone(value.input.definition);
}

function exact(record: { readonly definitionSha256: string }, id: string, idValue: string) {
  return { definitionSha256: record.definitionSha256, [id]: idValue };
}

function materialize<K extends ModelAssuranceRecordKind>(
  kind: K,
  scope: Assessment["scope"],
  definition: object,
  receipt: Readonly<Record<string, string>>,
): ModelAssuranceRecordByKind[K] {
  return validateModelAssuranceRecord(kind, {
    ...definition,
    ...receipt,
    definitionSha256: digestModelAssuranceRecordDefinition(kind, scope, definition),
    schemaVersion: "0.1",
    scope,
  }) as ModelAssuranceRecordByKind[K];
}

function recordOf<T>(
  records: readonly { readonly kind: string; readonly record: unknown }[],
  kind: string,
  predicate?: (record: T) => boolean,
): T {
  const fixture = records.find(
    (candidate) => candidate.kind === kind && (!predicate || predicate(candidate.record as T)),
  );
  if (!fixture) throw new Error(`Expected ${kind} fixture`);
  return fixture.record as T;
}

function principal(
  scope: Assessment["scope"],
  capabilities = ["evaluation:manage"],
): PrincipalContext {
  return {
    authentication: { authenticatedAt: "2026-09-02T05:59:00.000Z", method: "development" },
    capabilities: capabilities as PrincipalContext["capabilities"],
    principalId: "usr_assurance_manager",
    principalType: "user",
    requestId: "req_create_assurance",
    resourceScope: { mode: "tenant" },
    roles: ["admin"],
    tenantId: scope.tenantId,
  };
}

async function fixture() {
  const evaluation = createEvaluationRepositoryTestHarness("assurance_assessment");
  for (const value of evaluation.records) {
    await publishEvaluationFixture(evaluation.repository, value);
  }
  const base = recordOf<Assessment>(evaluation.records, "assessment");
  const policy = recordOf<EvaluationAggregationPolicy>(evaluation.records, "aggregation_policy");
  const observation = recordOf<RawObservation>(
    evaluation.records,
    "raw_observation",
    (value) => value.observationId === base.observations[0]?.observationId,
  );
  const run = recordOf<EvaluationRun>(
    evaluation.records,
    "evaluation_run",
    (value) => value.evaluationRunId === observation.run.evaluationRunId,
  );
  const oracle = recordOf<OracleSpec>(
    evaluation.records,
    "oracle_spec",
    (value) => value.oracleVersionId === run.oracle.oracleVersionId,
  );
  const baseQualification = recordOf<QualificationReport>(
    evaluation.records,
    "qualification_report",
    (value) => value.qualificationReportId === run.evaluatorQualification.qualificationReportId,
  );
  const repository = new MemoryModelAssuranceRepository();
  const scope = evaluation.scope;
  const publishedBy = {
    publishedAt: "2026-09-01T23:59:59.000Z",
    publishedByPrincipalId: "usr_assurance_publisher",
  };

  const profileDefinition = vector<ModelEvaluatorProfileDefinition>(
    "evaluation-model-assurance-definition-v1.json",
  );
  profileDefinition.supportedCriteria = [
    {
      criterionId: base.criterion.criterionId,
      criterionSetId: base.criterion.criterionSet.criterionSetId,
      criterionSetVersionId: base.criterion.criterionSet.criterionSetVersionId,
    },
  ];
  const profile = materialize("model_evaluator_profile", scope, profileDefinition, publishedBy);
  await repository.publish("model_evaluator_profile", profile);

  const evaluatorDefinition = vector<ModelAssistedEvaluatorSpecDefinition>(
    "evaluation-model-assisted-spec-definition-v1.json",
  );
  evaluatorDefinition.modelProfile = {
    definitionSha256: profile.definitionSha256,
    modelProfileId: profile.modelProfileId,
    modelProfileVersionId: profile.modelProfileVersionId,
  };
  const evaluator = materialize("model_assisted_evaluator", scope, evaluatorDefinition, {
    publishedAt: "2026-09-02T00:04:59.000Z",
    publishedByPrincipalId: "usr_assurance_publisher",
  });
  await repository.publish("model_assisted_evaluator", evaluator);

  const independenceDefinition = vector<IndependenceDeclarationDefinition>(
    "evaluation-independence-definition-v1.json",
  );
  independenceDefinition.subject = {
    evaluator: {
      definitionSha256: evaluator.definitionSha256,
      evaluatorId: evaluator.evaluatorId,
      evaluatorVersionId: evaluator.evaluatorVersionId,
    },
    modelProfile: {
      definitionSha256: profile.definitionSha256,
      modelProfileId: profile.modelProfileId,
      modelProfileVersionId: profile.modelProfileVersionId,
    },
  };
  const independence = materialize("independence_declaration", scope, independenceDefinition, {
    recordedAt: "2026-09-02T00:10:01.000Z",
  });
  await repository.publish("independence_declaration", independence);

  const calibrationDefinition = vector<CalibrationReportDefinition>(
    "evaluation-calibration-definition-v1.json",
  );
  calibrationDefinition.criteria = [structuredClone(base.criterion)];
  calibrationDefinition.dataset = structuredClone(policy.dataset);
  calibrationDefinition.evaluator = {
    definitionSha256: evaluator.definitionSha256,
    evaluatorId: evaluator.evaluatorId,
    evaluatorVersionId: evaluator.evaluatorVersionId,
  };
  calibrationDefinition.modelProfile = {
    definitionSha256: profile.definitionSha256,
    modelProfileId: profile.modelProfileId,
    modelProfileVersionId: profile.modelProfileVersionId,
  };
  calibrationDefinition.population.riskTier = base.riskTier;
  calibrationDefinition.qualificationReport = {
    definitionSha256: baseQualification.definitionSha256,
    qualificationReportId: baseQualification.qualificationReportId,
  };
  const calibration = materialize("calibration_report", scope, calibrationDefinition, {
    recordedAt: "2026-09-02T00:20:01.000Z",
  });
  await repository.publish("calibration_report", calibration);

  const planDefinition = vector<BlindedEvaluationPlanDefinition>(
    "evaluation-blinded-plan-definition-v1.json",
  );
  planDefinition.calibrationReport = exact(
    calibration,
    "calibrationReportId",
    calibration.calibrationReportId,
  ) as typeof planDefinition.calibrationReport;
  planDefinition.criteria = [structuredClone(base.criterion)];
  planDefinition.evaluator = {
    definitionSha256: evaluator.definitionSha256,
    evaluatorId: evaluator.evaluatorId,
    evaluatorVersionId: evaluator.evaluatorVersionId,
  };
  planDefinition.independenceDeclaration = {
    definitionSha256: independence.definitionSha256,
    independenceDeclarationId: independence.independenceDeclarationId,
  };
  planDefinition.modelProfile = {
    definitionSha256: profile.definitionSha256,
    modelProfileId: profile.modelProfileId,
    modelProfileVersionId: profile.modelProfileVersionId,
  };
  const plan = materialize("blinded_evaluation_plan", scope, planDefinition, {
    publishedAt: "2026-09-02T00:29:59.000Z",
    publishedByPrincipalId: "usr_assurance_publisher",
  });
  await repository.publish("blinded_evaluation_plan", plan);

  const resultDefinition = vector<BlindedEvaluationResultDefinition>(
    "evaluation-blinded-result-definition-v1.json",
  );
  resultDefinition.plan = {
    blindedPlanId: plan.blindedPlanId,
    blindedPlanVersionId: plan.blindedPlanVersionId,
    definitionSha256: plan.definitionSha256,
  };
  const blindResult = materialize("blinded_evaluation_result", scope, resultDefinition, {
    recordedAt: "2026-09-02T00:45:02.000Z",
    recordedByPrincipalId: "wrk_model_runner",
  });
  await repository.publish("blinded_evaluation_result", blindResult);

  const suiteDefinition = vector<ModelQualificationSuiteDefinition>(
    "evaluation-model-qualification-suite-definition-v1.json",
  );
  suiteDefinition.blindedPlan = {
    blindedPlanId: plan.blindedPlanId,
    blindedPlanVersionId: plan.blindedPlanVersionId,
    definitionSha256: plan.definitionSha256,
  };
  suiteDefinition.criteria = [
    {
      criterionId: base.criterion.criterionId,
      criterionSetId: base.criterion.criterionSet.criterionSetId,
      criterionSetVersionId: base.criterion.criterionSet.criterionSetVersionId,
    },
  ];
  suiteDefinition.dataset = structuredClone(calibration.dataset);
  suiteDefinition.evaluator = {
    definitionSha256: evaluator.definitionSha256,
    evaluatorId: evaluator.evaluatorId,
    evaluatorVersionId: evaluator.evaluatorVersionId,
  };
  suiteDefinition.modelProfile = {
    definitionSha256: profile.definitionSha256,
    modelProfileId: profile.modelProfileId,
    modelProfileVersionId: profile.modelProfileVersionId,
  };
  const suite = materialize("model_qualification_suite", scope, suiteDefinition, {
    publishedAt: "2026-09-02T03:59:59.000Z",
    publishedByPrincipalId: "usr_assurance_publisher",
  });
  await repository.publish("model_qualification_suite", suite);

  const qualificationDefinition = vector<ModelQualificationReportDefinition>(
    "evaluation-model-qualification-report-definition-v1.json",
  );
  qualificationDefinition.baseQualificationReport = {
    definitionSha256: baseQualification.definitionSha256,
    qualificationReportId: baseQualification.qualificationReportId,
  };
  qualificationDefinition.calibrationReport = exact(
    calibration,
    "calibrationReportId",
    calibration.calibrationReportId,
  ) as typeof qualificationDefinition.calibrationReport;
  qualificationDefinition.evaluator = {
    definitionSha256: evaluator.definitionSha256,
    evaluatorId: evaluator.evaluatorId,
    evaluatorVersionId: evaluator.evaluatorVersionId,
  };
  qualificationDefinition.independenceDeclaration = {
    definitionSha256: independence.definitionSha256,
    independenceDeclarationId: independence.independenceDeclarationId,
  };
  qualificationDefinition.modelProfile = {
    definitionSha256: profile.definitionSha256,
    modelProfileId: profile.modelProfileId,
    modelProfileVersionId: profile.modelProfileVersionId,
  };
  qualificationDefinition.suite = {
    definitionSha256: suite.definitionSha256,
    suiteId: suite.suiteId,
    suiteVersionId: suite.suiteVersionId,
  };
  const qualification = materialize("model_qualification_report", scope, qualificationDefinition, {
    recordedAt: "2026-09-02T05:30:01.000Z",
  });
  await repository.publish("model_qualification_report", qualification);

  const protocolDefinition = vector<HumanReviewProtocolDefinition>(
    "evaluation-human-review-protocol-definition-v1.json",
  );
  protocolDefinition.claim.criteria = [structuredClone(base.criterion)];
  protocolDefinition.claim.riskTier = base.riskTier;
  const protocol = materialize("human_review_protocol", scope, protocolDefinition, {
    publishedAt: "2026-09-02T01:59:59.000Z",
    publishedByPrincipalId: "usr_assurance_publisher",
  });
  await repository.publish("human_review_protocol", protocol);

  const commandDefinition = vector<CreateModelAssuranceAssessmentCommand["definition"]>(
    "evaluation-model-assurance-assessment-definition-v1.json",
  );
  commandDefinition.assessmentExtensionId = "maa_derived_ineligible";
  commandDefinition.baseAssessment = {
    assessmentId: base.assessmentId,
    definitionSha256: base.definitionSha256,
  };
  commandDefinition.blindedPlan = {
    blindedPlanId: plan.blindedPlanId,
    blindedPlanVersionId: plan.blindedPlanVersionId,
    definitionSha256: plan.definitionSha256,
  };
  commandDefinition.blindedResult = {
    definitionSha256: blindResult.definitionSha256,
    resultId: blindResult.resultId,
  };
  commandDefinition.calibrationContext = {
    locale: calibration.population.locale,
    populationTags: structuredClone(calibration.population.populationTags),
    taskKindId: calibration.population.taskKindIds[0] ?? "task_missing",
  };
  commandDefinition.calibrationReport = exact(
    calibration,
    "calibrationReportId",
    calibration.calibrationReportId,
  ) as typeof commandDefinition.calibrationReport;
  commandDefinition.critiques = [];
  commandDefinition.humanReviewProtocol = {
    definitionSha256: protocol.definitionSha256,
    protocolId: protocol.protocolId,
    protocolVersionId: protocol.protocolVersionId,
  };
  commandDefinition.humanReviews = [];
  commandDefinition.independenceDeclarations = [];
  commandDefinition.modelQualificationReport = {
    definitionSha256: qualification.definitionSha256,
    reportId: qualification.reportId,
  };
  commandDefinition.nonModelEvidence = {
    observations: [
      {
        definitionSha256: observation.definitionSha256,
        observationId: observation.observationId,
      },
    ],
    oracles: [
      {
        definitionSha256: oracle.definitionSha256,
        oracleId: oracle.oracleId,
        oracleVersionId: oracle.oracleVersionId,
      },
    ],
  };
  commandDefinition.riskTier = base.riskTier;
  commandDefinition.validUntil = "2026-09-03T00:00:00.000Z";

  const command: CreateModelAssuranceAssessmentCommand = {
    definition: commandDefinition,
    environmentId: scope.environmentId,
    principal: principal(scope),
    projectId: scope.projectId,
    recordId: commandDefinition.assessmentExtensionId,
  };
  return { command, evaluation, repository };
}

describe("CreateModelAssuranceAssessment", () => {
  it("maps every subordinate verifier family to stable assessment reasons", () => {
    const reasons = new Set<import("@proofstack/contracts").ModelAssuranceIneligibilityReason>();
    addQualificationReasons(reasons, [
      "scope_mismatch",
      "report_not_current",
      "calibration_not_current",
      "independence_not_current",
      "report_unqualified",
      "calibration_unavailable",
      "independence_not_verified",
      "blinded_plan_invalid",
      "evaluator_mismatch",
    ]);
    addCalibrationReasons(reasons, [
      "scope_mismatch",
      "calibration_not_current",
      "profile_not_current",
      "calibration_unavailable",
      "dataset_mismatch",
    ]);
    addBlindReasons(reasons, [
      "attempt_failed",
      "attempt_missing",
      "label_leakage",
      "order_rationale_variance",
      "order_verdict_variance",
      "scope_mismatch",
      "plan_invalid",
    ]);
    addCritiqueReasons(reasons, [
      "scope_mismatch",
      "critique_correlated",
      "critique_unverifiable",
      "declaration_mismatch",
      "primary_declaration_missing",
      "opposing_finding",
      "uncertain_finding",
      "critique_missing",
    ]);
    addHumanReasons(reasons, [
      "scope_mismatch",
      "review_expired",
      "independence_not_current",
      "protocol_mismatch",
      "protocol_not_current",
      "quorum_shortfall",
      "role_requirement_shortfall",
      "independence_group_shortfall",
      "conflicted_reviewer",
      "opposing_review",
      "unresolved_escalation",
      "evidence_mismatch",
    ]);
    expect([...reasons].sort()).toEqual([
      "assurance_scope_mismatch",
      "blind_incomplete",
      "blind_invalid",
      "calibration_incompatible",
      "calibration_stale",
      "calibration_unavailable",
      "critique_invalid",
      "human_review_conflicted",
      "human_review_expired",
      "human_review_invalid",
      "human_review_protocol_mismatch",
      "human_review_quorum_shortfall",
      "independence_correlated",
      "independence_unverified",
      "model_qualification_invalid",
      "model_qualification_stale",
      "model_qualification_unqualified",
      "order_sensitive_result",
      "unresolved_disagreement",
    ]);
    expect(
      minimumEligibleValidity("2026-09-04T00:00:00.000Z", [
        "2026-09-03T00:00:00.000Z",
        "2026-09-05T00:00:00.000Z",
      ]),
    ).toBe("2026-09-03T00:00:00.000Z");
  });

  it("derives a conservative ineligible result instead of accepting caller verdicts", async () => {
    const setup = await fixture();
    const useCase = new CreateModelAssuranceAssessment({
      clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
      evaluationRepository: setup.evaluation.repository,
      modelAssuranceRepository: setup.repository,
    });
    const result = await useCase.execute(setup.command);
    expect(result.created).toBe(true);
    expect(result.record).toMatchObject({
      eligibility: "ineligible",
      evaluatedAt: "2026-09-02T06:00:00.000Z",
      recordedAt: "2026-09-02T06:00:00.000Z",
    });
    expect(result.record.reasons).toEqual(
      expect.arrayContaining([
        "human_review_missing",
        "human_review_quorum_shortfall",
        "independence_unverified",
        "unresolved_disagreement",
      ]),
    );
    await expect(useCase.execute(setup.command)).resolves.toEqual({
      created: false,
      record: result.record,
    });
  });

  it("authorizes before time or storage and rejects non-exact dependencies", async () => {
    const setup = await fixture();
    let accessed = false;
    const denied = new CreateModelAssuranceAssessment({
      clock: {
        now: () => {
          throw new Error("clock must not be read");
        },
      },
      evaluationRepository: new Proxy(setup.evaluation.repository, {
        get(target, property, receiver) {
          accessed = true;
          return Reflect.get(target, property, receiver);
        },
      }),
      modelAssuranceRepository: setup.repository,
    });
    await expect(
      denied.execute({
        ...setup.command,
        principal: principal(setup.evaluation.scope, ["evaluation:read"]),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(accessed).toBe(false);

    const exact = new CreateModelAssuranceAssessment({
      clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
      evaluationRepository: setup.evaluation.repository,
      modelAssuranceRepository: setup.repository,
    });
    const forged = structuredClone(setup.command);
    forged.definition.calibrationReport.definitionSha256 = "0".repeat(64);
    await expect(exact.execute(forged)).rejects.toBeInstanceOf(ModelAssuranceDependencyError);
  });

  it("records context and non-model gaps without permitting a false eligible result", async () => {
    const setup = await fixture();
    const gapDefinition = structuredClone(setup.command.definition);
    gapDefinition.assessmentExtensionId = "maa_context_gap";
    gapDefinition.calibrationContext.taskKindId = "task_outside_calibration";
    gapDefinition.nonModelEvidence = { observations: [], oracles: [] };
    gapDefinition.riskTier = "high";
    const command = {
      ...setup.command,
      definition: gapDefinition,
      recordId: gapDefinition.assessmentExtensionId,
    };
    const result = await new CreateModelAssuranceAssessment({
      clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
      evaluationRepository: setup.evaluation.repository,
      modelAssuranceRepository: setup.repository,
    }).execute(command);
    expect(result.record.eligibility).toBe("ineligible");
    expect(result.record.reasons).toEqual(
      expect.arrayContaining([
        "assurance_lineage_mismatch",
        "calibration_incompatible",
        "human_review_protocol_mismatch",
        "non_model_evidence_missing",
      ]),
    );
  });

  it("rejects malformed routes and clocks before dependency reads", async () => {
    const setup = await fixture();
    const dependencies = {
      clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
      evaluationRepository: setup.evaluation.repository,
      modelAssuranceRepository: setup.repository,
    };
    await expect(
      new CreateModelAssuranceAssessment(dependencies).execute({
        ...setup.command,
        principal: {} as never,
      }),
    ).rejects.toBeInstanceOf(InvalidModelAssuranceRecordInputError);
    await expect(
      new CreateModelAssuranceAssessment(dependencies).execute({
        ...setup.command,
        recordId: "maa_wrong_route",
      }),
    ).rejects.toBeInstanceOf(InvalidModelAssuranceRecordInputError);
    await expect(
      new CreateModelAssuranceAssessment({
        ...dependencies,
        clock: {
          now: () => {
            throw new Error("invalid clock");
          },
        },
      }).execute(setup.command),
    ).rejects.toBeInstanceOf(InvalidModelAssuranceRecordInputError);
  });

  it("fails closed on assessment conflicts and repository contract violations", async () => {
    const setup = await fixture();
    const dependencies = {
      clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
      evaluationRepository: setup.evaluation.repository,
      modelAssuranceRepository: setup.repository,
    };
    const useCase = new CreateModelAssuranceAssessment(dependencies);
    const first = await useCase.execute(setup.command);
    const conflict = structuredClone(setup.command);
    conflict.definition.knownLimitations = ["Different immutable assessment limitations"];
    await expect(useCase.execute(conflict)).rejects.toBeInstanceOf(
      ModelAssuranceRecordConflictError,
    );

    const retryViolation = new Proxy(setup.repository, {
      get(target, property, receiver) {
        if (property === "publish") {
          return async () => ({ created: true, record: first.record });
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      new CreateModelAssuranceAssessment({
        ...dependencies,
        modelAssuranceRepository: retryViolation,
      }).execute(setup.command),
    ).rejects.toBeInstanceOf(ModelAssuranceRepositoryContractError);

    const substitutedDefinition = structuredClone(setup.command.definition);
    substitutedDefinition.assessmentExtensionId = "maa_substituted";
    const substitutedCommand = {
      ...setup.command,
      definition: substitutedDefinition,
      recordId: substitutedDefinition.assessmentExtensionId,
    };
    const substitution = new Proxy(setup.repository, {
      get(target, property, receiver) {
        if (property === "find") {
          return async (scope: Assessment["scope"], kind: ModelAssuranceRecordKind, id: string) =>
            kind === "model_assurance_assessment" ? null : target.find(scope, kind, id);
        }
        if (property === "publish") {
          return async (kind: string) => {
            if (kind === "model_assurance_assessment") {
              return { created: true, record: first.record };
            }
            throw new Error(`Unexpected publication ${kind}`);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      new CreateModelAssuranceAssessment({
        ...dependencies,
        modelAssuranceRepository: substitution,
      }).execute(substitutedCommand),
    ).rejects.toBeInstanceOf(ModelAssuranceRepositoryContractError);
  });
});
