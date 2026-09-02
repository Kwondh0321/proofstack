import { readFileSync } from "node:fs";
import type {
  Assessment,
  BlindedEvaluationPlanDefinition,
  BlindedEvaluationResultDefinition,
  CalibrationReportDefinition,
  EvaluationAggregationPolicy,
  EvaluationRun,
  HumanReviewerIndependenceDefinition,
  HumanReviewProtocolDefinition,
  HumanReviewRecordDefinition,
  IndependenceDeclarationDefinition,
  IndependentCritiqueDefinition,
  ModelAssistedEvaluatorSpecDefinition,
  ModelAssuranceAssessmentDefinition,
  ModelEvaluatorProfileDefinition,
  ModelQualificationReportDefinition,
  ModelQualificationSuiteDefinition,
  OracleSpec,
  PrincipalContext,
  QualificationReport,
  RawObservation,
} from "@proofstack/contracts";
import type { CreateModelAssuranceAssessmentCommand } from "../evaluation/create-model-assurance-assessment.js";
import {
  digestModelAssuranceRecordDefinition,
  validateModelAssuranceRecord,
} from "../evaluation/model-assurance-record-validation.js";
import type {
  ModelAssuranceRecordByKind,
  ModelAssuranceRecordKind,
} from "../evaluation/model-assurance-repository.js";
import type { EvaluationRepositoryTestHarness } from "./evaluation-repository-conformance.js";
import { publishEvaluationFixture } from "./evaluation-repository-conformance.js";
import { createEvaluationRepositoryTestHarness } from "./evaluation-repository-fixtures.js";
import { MemoryModelAssuranceRepository } from "./memory-model-assurance-repository.js";

export type ModelAssuranceRepositoryFixtureRecord = {
  readonly [K in ModelAssuranceRecordKind]: {
    readonly kind: K;
    readonly record: ModelAssuranceRecordByKind[K];
  };
}[ModelAssuranceRecordKind];

export interface ModelAssuranceRepositoryTestHarness {
  readonly command: CreateModelAssuranceAssessmentCommand;
  readonly evaluation: EvaluationRepositoryTestHarness;
  readonly records: readonly ModelAssuranceRepositoryFixtureRecord[];
  readonly repository: MemoryModelAssuranceRepository;
}

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

function principal(scope: Assessment["scope"]): PrincipalContext {
  return {
    authentication: { authenticatedAt: "2026-09-02T05:59:00.000Z", method: "development" },
    capabilities: ["evaluation:manage"],
    principalId: "usr_assurance_manager",
    principalType: "user",
    requestId: "req_create_assurance",
    resourceScope: { mode: "tenant" },
    roles: ["admin"],
    tenantId: scope.tenantId,
  };
}

export async function createModelAssuranceRepositoryTestHarness(
  namespace: string,
): Promise<ModelAssuranceRepositoryTestHarness> {
  const evaluation = createEvaluationRepositoryTestHarness(namespace);
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
  const records: ModelAssuranceRepositoryFixtureRecord[] = [];
  const scope = evaluation.scope;

  async function add<K extends ModelAssuranceRecordKind>(
    kind: K,
    record: ModelAssuranceRecordByKind[K],
  ): Promise<ModelAssuranceRecordByKind[K]> {
    await repository.publish(kind, record);
    records.push({ kind, record } as ModelAssuranceRepositoryFixtureRecord);
    return record;
  }

  const publishedBy = {
    publishedAt: "2026-09-01T23:59:59.000Z",
    publishedByPrincipalId: "usr_assurance_publisher",
  };
  const profileDefinition = vector<ModelEvaluatorProfileDefinition>(
    "evaluation-model-assurance-definition-v1.json",
  );
  profileDefinition.modelProfileId = `mep_${namespace}_primary`;
  profileDefinition.modelProfileVersionId = `mpv_${namespace}_primary_v1`;
  profileDefinition.evaluator = {
    evaluatorId: `evl_${namespace}_primary`,
    evaluatorVersionId: `evv_${namespace}_primary_v1`,
  };
  profileDefinition.supportedCriteria = [
    {
      criterionId: base.criterion.criterionId,
      criterionSetId: base.criterion.criterionSet.criterionSetId,
      criterionSetVersionId: base.criterion.criterionSet.criterionSetVersionId,
    },
  ];
  const profile = await add(
    "model_evaluator_profile",
    materialize("model_evaluator_profile", scope, profileDefinition, publishedBy),
  );

  const evaluatorDefinition = vector<ModelAssistedEvaluatorSpecDefinition>(
    "evaluation-model-assisted-spec-definition-v1.json",
  );
  evaluatorDefinition.evaluatorId = `evl_${namespace}_primary`;
  evaluatorDefinition.evaluatorVersionId = `evv_${namespace}_primary_v1`;
  evaluatorDefinition.modelProfile = {
    definitionSha256: profile.definitionSha256,
    modelProfileId: profile.modelProfileId,
    modelProfileVersionId: profile.modelProfileVersionId,
  };
  const evaluator = await add(
    "model_assisted_evaluator",
    materialize("model_assisted_evaluator", scope, evaluatorDefinition, {
      publishedAt: "2026-09-02T00:04:59.000Z",
      publishedByPrincipalId: "usr_assurance_publisher",
    }),
  );

  const independenceDefinition = vector<IndependenceDeclarationDefinition>(
    "evaluation-independence-definition-v1.json",
  );
  independenceDefinition.independenceDeclarationId = `ind_${namespace}_primary_v1`;
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
  const independence = await add(
    "independence_declaration",
    materialize("independence_declaration", scope, independenceDefinition, {
      recordedAt: "2026-09-02T00:10:01.000Z",
    }),
  );

  const calibrationDefinition = vector<CalibrationReportDefinition>(
    "evaluation-calibration-definition-v1.json",
  );
  calibrationDefinition.calibrationReportId = `cal_${namespace}_primary_v1`;
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
  const calibration = await add(
    "calibration_report",
    materialize("calibration_report", scope, calibrationDefinition, {
      recordedAt: "2026-09-02T00:20:01.000Z",
    }),
  );

  const planDefinition = vector<BlindedEvaluationPlanDefinition>(
    "evaluation-blinded-plan-definition-v1.json",
  );
  planDefinition.blindedPlanId = `blp_${namespace}_primary`;
  planDefinition.blindedPlanVersionId = `blv_${namespace}_primary_v1`;
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
  const plan = await add(
    "blinded_evaluation_plan",
    materialize("blinded_evaluation_plan", scope, planDefinition, {
      publishedAt: "2026-09-02T00:29:59.000Z",
      publishedByPrincipalId: "usr_assurance_publisher",
    }),
  );

  const resultDefinition = vector<BlindedEvaluationResultDefinition>(
    "evaluation-blinded-result-definition-v1.json",
  );
  resultDefinition.resultId = `blr_${namespace}_primary_v1`;
  resultDefinition.plan = {
    blindedPlanId: plan.blindedPlanId,
    blindedPlanVersionId: plan.blindedPlanVersionId,
    definitionSha256: plan.definitionSha256,
  };
  const blindResult = await add(
    "blinded_evaluation_result",
    materialize("blinded_evaluation_result", scope, resultDefinition, {
      recordedAt: "2026-09-02T00:45:02.000Z",
      recordedByPrincipalId: "wrk_model_runner",
    }),
  );

  const suiteDefinition = vector<ModelQualificationSuiteDefinition>(
    "evaluation-model-qualification-suite-definition-v1.json",
  );
  suiteDefinition.suiteId = `mqs_${namespace}_primary`;
  suiteDefinition.suiteVersionId = `mqv_${namespace}_primary_v1`;
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
  suiteDefinition.evaluator = structuredClone(calibration.evaluator);
  suiteDefinition.modelProfile = structuredClone(calibration.modelProfile);
  const suite = await add(
    "model_qualification_suite",
    materialize("model_qualification_suite", scope, suiteDefinition, {
      publishedAt: "2026-09-02T03:59:59.000Z",
      publishedByPrincipalId: "usr_assurance_publisher",
    }),
  );

  const qualificationDefinition = vector<ModelQualificationReportDefinition>(
    "evaluation-model-qualification-report-definition-v1.json",
  );
  qualificationDefinition.reportId = `mqr_${namespace}_primary_v1`;
  qualificationDefinition.baseQualificationReport = {
    definitionSha256: baseQualification.definitionSha256,
    qualificationReportId: baseQualification.qualificationReportId,
  };
  qualificationDefinition.calibrationReport = exact(
    calibration,
    "calibrationReportId",
    calibration.calibrationReportId,
  ) as typeof qualificationDefinition.calibrationReport;
  qualificationDefinition.evaluator = structuredClone(calibration.evaluator);
  qualificationDefinition.independenceDeclaration = {
    definitionSha256: independence.definitionSha256,
    independenceDeclarationId: independence.independenceDeclarationId,
  };
  qualificationDefinition.modelProfile = structuredClone(calibration.modelProfile);
  qualificationDefinition.suite = {
    definitionSha256: suite.definitionSha256,
    suiteId: suite.suiteId,
    suiteVersionId: suite.suiteVersionId,
  };
  const qualification = await add(
    "model_qualification_report",
    materialize("model_qualification_report", scope, qualificationDefinition, {
      recordedAt: "2026-09-02T05:30:01.000Z",
    }),
  );

  const protocolDefinition = vector<HumanReviewProtocolDefinition>(
    "evaluation-human-review-protocol-definition-v1.json",
  );
  protocolDefinition.protocolId = `hrp_${namespace}_primary`;
  protocolDefinition.protocolVersionId = `hrv_${namespace}_primary_v1`;
  protocolDefinition.claim.criteria = [structuredClone(base.criterion)];
  protocolDefinition.claim.riskTier = base.riskTier;
  const protocol = await add(
    "human_review_protocol",
    materialize("human_review_protocol", scope, protocolDefinition, {
      publishedAt: "2026-09-02T01:59:59.000Z",
      publishedByPrincipalId: "usr_assurance_publisher",
    }),
  );

  const critiqueDefinition = vector<IndependentCritiqueDefinition>(
    "evaluation-independent-critique-definition-v1.json",
  );
  const critiqueCriterion = plan.criteria[0];
  if (!critiqueCriterion) throw new Error("Expected a blind-plan criterion");
  const criticProfileDefinition = vector<ModelEvaluatorProfileDefinition>(
    "evaluation-model-assurance-definition-v1.json",
  );
  criticProfileDefinition.modelProfileId = `mep_${namespace}_critic`;
  criticProfileDefinition.modelProfileVersionId = `mpv_${namespace}_critic_v1`;
  criticProfileDefinition.evaluator = {
    evaluatorId: `evl_${namespace}_critic`,
    evaluatorVersionId: `evv_${namespace}_critic_v1`,
  };
  criticProfileDefinition.supportedCriteria = structuredClone(profile.supportedCriteria);
  const criticProfile = await add(
    "model_evaluator_profile",
    materialize("model_evaluator_profile", scope, criticProfileDefinition, publishedBy),
  );
  const criticEvaluatorDefinition = vector<ModelAssistedEvaluatorSpecDefinition>(
    "evaluation-model-assisted-spec-definition-v1.json",
  );
  criticEvaluatorDefinition.evaluatorId = `evl_${namespace}_critic`;
  criticEvaluatorDefinition.evaluatorVersionId = `evv_${namespace}_critic_v1`;
  criticEvaluatorDefinition.modelProfile = {
    definitionSha256: criticProfile.definitionSha256,
    modelProfileId: criticProfile.modelProfileId,
    modelProfileVersionId: criticProfile.modelProfileVersionId,
  };
  const criticEvaluator = await add(
    "model_assisted_evaluator",
    materialize("model_assisted_evaluator", scope, criticEvaluatorDefinition, {
      publishedAt: "2026-09-02T00:49:59.000Z",
      publishedByPrincipalId: "usr_assurance_publisher",
    }),
  );
  const criticCalibrationDefinition = vector<CalibrationReportDefinition>(
    "evaluation-calibration-definition-v1.json",
  );
  criticCalibrationDefinition.calibrationReportId = `cal_${namespace}_critic_v1`;
  criticCalibrationDefinition.criteria = [structuredClone(base.criterion)];
  criticCalibrationDefinition.dataset = structuredClone(policy.dataset);
  criticCalibrationDefinition.evaluator = {
    definitionSha256: criticEvaluator.definitionSha256,
    evaluatorId: criticEvaluator.evaluatorId,
    evaluatorVersionId: criticEvaluator.evaluatorVersionId,
  };
  criticCalibrationDefinition.modelProfile = {
    definitionSha256: criticProfile.definitionSha256,
    modelProfileId: criticProfile.modelProfileId,
    modelProfileVersionId: criticProfile.modelProfileVersionId,
  };
  criticCalibrationDefinition.population.riskTier = base.riskTier;
  criticCalibrationDefinition.qualificationReport = {
    definitionSha256: baseQualification.definitionSha256,
    qualificationReportId: baseQualification.qualificationReportId,
  };
  const criticCalibration = await add(
    "calibration_report",
    materialize("calibration_report", scope, criticCalibrationDefinition, {
      recordedAt: "2026-09-02T00:20:01.000Z",
    }),
  );
  critiqueDefinition.evaluator = {
    definitionSha256: criticEvaluator.definitionSha256,
    evaluatorId: criticEvaluator.evaluatorId,
    evaluatorVersionId: criticEvaluator.evaluatorVersionId,
  };
  critiqueDefinition.modelProfile = {
    definitionSha256: criticProfile.definitionSha256,
    modelProfileId: criticProfile.modelProfileId,
    modelProfileVersionId: criticProfile.modelProfileVersionId,
  };
  critiqueDefinition.calibrationReport = {
    calibrationReportId: criticCalibration.calibrationReportId,
    definitionSha256: criticCalibration.definitionSha256,
  };
  critiqueDefinition.criterion = structuredClone(critiqueCriterion);
  critiqueDefinition.observation = {
    definitionSha256: observation.definitionSha256,
    observationId: observation.observationId,
  };
  critiqueDefinition.qualificationReport = {
    definitionSha256: baseQualification.definitionSha256,
    qualificationReportId: baseQualification.qualificationReportId,
  };
  if (critiqueDefinition.outcome.status !== "produced") {
    throw new Error("Expected a produced critique vector");
  }
  for (const finding of critiqueDefinition.outcome.findings) finding.impact = "supports";

  const criticIndependenceDefinition = vector<IndependenceDeclarationDefinition>(
    "evaluation-independence-definition-v1.json",
  );
  criticIndependenceDefinition.independenceDeclarationId = `ind_${namespace}_critic_v1`;
  criticIndependenceDefinition.subject = {
    evaluator: structuredClone(critiqueDefinition.evaluator),
    modelProfile: structuredClone(critiqueDefinition.modelProfile),
  };
  for (const [dimension, lineage] of Object.entries(criticIndependenceDefinition.dimensions)) {
    if (lineage.status !== "declared") throw new Error("Expected declared critic lineage");
    lineage.identifiers = [`critic:${namespace}:${dimension}`];
  }
  const criticIndependence = await add(
    "independence_declaration",
    materialize("independence_declaration", scope, criticIndependenceDefinition, {
      recordedAt: "2026-09-02T00:55:01.000Z",
    }),
  );
  const criticSuiteDefinition = vector<ModelQualificationSuiteDefinition>(
    "evaluation-model-qualification-suite-definition-v1.json",
  );
  criticSuiteDefinition.suiteId = `mqs_${namespace}_critic`;
  criticSuiteDefinition.suiteVersionId = `mqv_${namespace}_critic_v1`;
  criticSuiteDefinition.blindedPlan = {
    blindedPlanId: plan.blindedPlanId,
    blindedPlanVersionId: plan.blindedPlanVersionId,
    definitionSha256: plan.definitionSha256,
  };
  criticSuiteDefinition.criteria = [
    {
      criterionId: base.criterion.criterionId,
      criterionSetId: base.criterion.criterionSet.criterionSetId,
      criterionSetVersionId: base.criterion.criterionSet.criterionSetVersionId,
    },
  ];
  criticSuiteDefinition.dataset = structuredClone(criticCalibration.dataset);
  criticSuiteDefinition.evaluator = structuredClone(critiqueDefinition.evaluator);
  criticSuiteDefinition.modelProfile = structuredClone(critiqueDefinition.modelProfile);
  const criticSuite = await add(
    "model_qualification_suite",
    materialize("model_qualification_suite", scope, criticSuiteDefinition, {
      publishedAt: "2026-09-02T03:59:59.000Z",
      publishedByPrincipalId: "usr_assurance_publisher",
    }),
  );
  const criticQualificationDefinition = vector<ModelQualificationReportDefinition>(
    "evaluation-model-qualification-report-definition-v1.json",
  );
  criticQualificationDefinition.reportId = `mqr_${namespace}_critic_v1`;
  criticQualificationDefinition.baseQualificationReport = {
    definitionSha256: baseQualification.definitionSha256,
    qualificationReportId: baseQualification.qualificationReportId,
  };
  criticQualificationDefinition.calibrationReport = {
    calibrationReportId: criticCalibration.calibrationReportId,
    definitionSha256: criticCalibration.definitionSha256,
  };
  criticQualificationDefinition.evaluator = structuredClone(critiqueDefinition.evaluator);
  criticQualificationDefinition.independenceDeclaration = {
    definitionSha256: criticIndependence.definitionSha256,
    independenceDeclarationId: criticIndependence.independenceDeclarationId,
  };
  criticQualificationDefinition.modelProfile = structuredClone(critiqueDefinition.modelProfile);
  criticQualificationDefinition.suite = {
    definitionSha256: criticSuite.definitionSha256,
    suiteId: criticSuite.suiteId,
    suiteVersionId: criticSuite.suiteVersionId,
  };
  const criticQualification = await add(
    "model_qualification_report",
    materialize("model_qualification_report", scope, criticQualificationDefinition, {
      recordedAt: "2026-09-02T05:30:01.000Z",
    }),
  );
  critiqueDefinition.independenceDeclaration = {
    definitionSha256: criticIndependence.definitionSha256,
    independenceDeclarationId: criticIndependence.independenceDeclarationId,
  };
  critiqueDefinition.modelQualificationReport = {
    definitionSha256: criticQualification.definitionSha256,
    reportId: criticQualification.reportId,
  };
  const critique = await add(
    "independent_critique",
    materialize("independent_critique", scope, critiqueDefinition, {
      recordedAt: "2026-09-02T01:01:01.000Z",
      recordedByPrincipalId: "wrk_independent_critic",
    }),
  );

  const reviews: ModelAssuranceRecordByKind["human_review_record"][] = [];
  for (const [index, reviewer] of [
    {
      groupId: "hig_domain_lab",
      principalId: "usr_domain_reviewer",
      roleId: "role_domain_reviewer",
    },
    {
      groupId: "hig_safety_lab",
      principalId: "usr_safety_reviewer",
      roleId: "role_safety_reviewer",
    },
  ].entries()) {
    const declarationDefinition = vector<HumanReviewerIndependenceDefinition>(
      "evaluation-human-reviewer-independence-definition-v1.json",
    );
    declarationDefinition.affiliations = [`org:independent-review-lab-${index + 1}`];
    declarationDefinition.declarationId = `hri_${namespace}_reviewer_${index + 1}`;
    declarationDefinition.independenceGroupIds = [reviewer.groupId];
    declarationDefinition.reviewerPrincipalId = reviewer.principalId;
    const reviewerIndependence = await add(
      "human_reviewer_independence",
      materialize("human_reviewer_independence", scope, declarationDefinition, {
        recordedAt: `2026-09-02T02:30:0${index + 1}.000Z`,
      }),
    );

    const reviewDefinition = vector<HumanReviewRecordDefinition>(
      "evaluation-human-review-record-definition-v1.json",
    );
    reviewDefinition.assessment = {
      assessmentId: base.assessmentId,
      definitionSha256: base.definitionSha256,
    };
    reviewDefinition.critiques = [
      { critiqueId: critique.critiqueId, definitionSha256: critique.definitionSha256 },
    ];
    reviewDefinition.independenceDeclaration = {
      declarationId: reviewerIndependence.declarationId,
      definitionSha256: reviewerIndependence.definitionSha256,
    };
    reviewDefinition.observations = [
      {
        definitionSha256: observation.definitionSha256,
        observationId: observation.observationId,
      },
    ];
    reviewDefinition.protocol = {
      definitionSha256: protocol.definitionSha256,
      protocolId: protocol.protocolId,
      protocolVersionId: protocol.protocolVersionId,
    };
    reviewDefinition.reviewedArtifacts = structuredClone(protocol.claim.evidenceBundle);
    reviewDefinition.reviewId = `hrr_${namespace}_reviewer_${index + 1}`;
    reviewDefinition.reviewer.principalId = reviewer.principalId;
    reviewDefinition.reviewer.requestId = `req_${namespace}_review_${index + 1}`;
    reviewDefinition.reviewer.sessionId = `ses_${namespace}_review_${index + 1}`;
    reviewDefinition.reviewerRoleId = reviewer.roleId;
    reviews.push(
      await add(
        "human_review_record",
        materialize("human_review_record", scope, reviewDefinition, {
          recordedAt: `2026-09-02T03:20:0${index + 1}.000Z`,
        }),
      ),
    );
  }

  const assessmentDefinition = vector<ModelAssuranceAssessmentDefinition>(
    "evaluation-model-assurance-assessment-definition-v1.json",
  );
  const {
    eligibility: _eligibility,
    evaluatedAt: _evaluatedAt,
    reasons: _reasons,
    ...commandDefinition
  } = assessmentDefinition;
  commandDefinition.assessmentExtensionId = `maa_${namespace}_eligible`;
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
  commandDefinition.critiques = [
    { critiqueId: critique.critiqueId, definitionSha256: critique.definitionSha256 },
  ];
  commandDefinition.humanReviewProtocol = {
    definitionSha256: protocol.definitionSha256,
    protocolId: protocol.protocolId,
    protocolVersionId: protocol.protocolVersionId,
  };
  commandDefinition.humanReviews = reviews.map((review) => ({
    definitionSha256: review.definitionSha256,
    reviewId: review.reviewId,
  }));
  commandDefinition.independenceDeclarations = [
    {
      definitionSha256: independence.definitionSha256,
      independenceDeclarationId: independence.independenceDeclarationId,
    },
    {
      definitionSha256: criticIndependence.definitionSha256,
      independenceDeclarationId: criticIndependence.independenceDeclarationId,
    },
  ].sort((left, right) =>
    left.independenceDeclarationId.localeCompare(right.independenceDeclarationId),
  );
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
  commandDefinition.validUntil = "2026-09-04T00:00:00.000Z";

  return {
    command: {
      definition: commandDefinition,
      environmentId: scope.environmentId,
      principal: principal(scope),
      projectId: scope.projectId,
      recordId: commandDefinition.assessmentExtensionId,
    },
    evaluation,
    records,
    repository,
  };
}
