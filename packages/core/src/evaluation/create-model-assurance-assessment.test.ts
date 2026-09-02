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
import { publishEvaluationFixture } from "../testing/evaluation-repository-conformance.js";
import { createEvaluationRepositoryTestHarness } from "../testing/evaluation-repository-fixtures.js";
import { FixedClock } from "../testing/fixed-clock.js";
import { MemoryModelAssuranceRepository } from "../testing/memory-model-assurance-repository.js";
import {
  addBlindReasons,
  addCalibrationReasons,
  addCritiqueReasons,
  addHumanReasons,
  addQualificationReasons,
  CreateModelAssuranceAssessment,
  type CreateModelAssuranceAssessmentCommand,
  ModelAssuranceDependencyError,
  minimumEligibleValidity,
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

async function fixture(options: { readonly completeAssurance?: boolean } = {}) {
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

  if (options.completeAssurance) {
    const critiqueDefinition = vector<IndependentCritiqueDefinition>(
      "evaluation-independent-critique-definition-v1.json",
    );
    const critiqueCriterion = plan.criteria[0];
    if (!critiqueCriterion) throw new Error("Expected a blind-plan criterion");
    const criticProfileDefinition = vector<ModelEvaluatorProfileDefinition>(
      "evaluation-model-assurance-definition-v1.json",
    );
    criticProfileDefinition.modelProfileId = "mep_derived_critic";
    criticProfileDefinition.modelProfileVersionId = "mpv_derived_critic_v1";
    criticProfileDefinition.evaluator = {
      evaluatorId: "evl_derived_critic",
      evaluatorVersionId: "evv_derived_critic_v1",
    };
    criticProfileDefinition.supportedCriteria = [
      {
        criterionId: base.criterion.criterionId,
        criterionSetId: base.criterion.criterionSet.criterionSetId,
        criterionSetVersionId: base.criterion.criterionSet.criterionSetVersionId,
      },
    ];
    const criticProfile = materialize(
      "model_evaluator_profile",
      scope,
      criticProfileDefinition,
      publishedBy,
    );
    await repository.publish("model_evaluator_profile", criticProfile);
    const criticEvaluatorDefinition = vector<ModelAssistedEvaluatorSpecDefinition>(
      "evaluation-model-assisted-spec-definition-v1.json",
    );
    criticEvaluatorDefinition.evaluatorId = "evl_derived_critic";
    criticEvaluatorDefinition.evaluatorVersionId = "evv_derived_critic_v1";
    criticEvaluatorDefinition.modelProfile = {
      definitionSha256: criticProfile.definitionSha256,
      modelProfileId: criticProfile.modelProfileId,
      modelProfileVersionId: criticProfile.modelProfileVersionId,
    };
    const criticEvaluator = materialize(
      "model_assisted_evaluator",
      scope,
      criticEvaluatorDefinition,
      {
        publishedAt: "2026-09-02T00:49:59.000Z",
        publishedByPrincipalId: "usr_assurance_publisher",
      },
    );
    await repository.publish("model_assisted_evaluator", criticEvaluator);
    const criticCalibrationDefinition = vector<CalibrationReportDefinition>(
      "evaluation-calibration-definition-v1.json",
    );
    criticCalibrationDefinition.calibrationReportId = "cal_derived_critic_v1";
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
    const criticCalibration = materialize(
      "calibration_report",
      scope,
      criticCalibrationDefinition,
      { recordedAt: "2026-09-02T00:20:01.000Z" },
    );
    await repository.publish("calibration_report", criticCalibration);
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
    if (critiqueDefinition.outcome.status !== "produced") {
      throw new Error("Expected a produced critique vector");
    }
    for (const finding of critiqueDefinition.outcome.findings) finding.impact = "supports";

    const criticIndependenceDefinition = vector<IndependenceDeclarationDefinition>(
      "evaluation-independence-definition-v1.json",
    );
    criticIndependenceDefinition.independenceDeclarationId = "ind_derived_critic_v1";
    criticIndependenceDefinition.subject = {
      evaluator: structuredClone(critiqueDefinition.evaluator),
      modelProfile: structuredClone(critiqueDefinition.modelProfile),
    };
    for (const [dimension, lineage] of Object.entries(criticIndependenceDefinition.dimensions)) {
      if (lineage.status !== "declared") throw new Error("Expected declared critic lineage");
      lineage.identifiers = [`critic:${dimension}`];
    }
    const criticIndependence = materialize(
      "independence_declaration",
      scope,
      criticIndependenceDefinition,
      { recordedAt: "2026-09-02T00:55:01.000Z" },
    );
    await repository.publish("independence_declaration", criticIndependence);
    critiqueDefinition.independenceDeclaration = {
      definitionSha256: criticIndependence.definitionSha256,
      independenceDeclarationId: criticIndependence.independenceDeclarationId,
    };
    const criticSuiteDefinition = vector<ModelQualificationSuiteDefinition>(
      "evaluation-model-qualification-suite-definition-v1.json",
    );
    criticSuiteDefinition.suiteId = "mqs_derived_critic";
    criticSuiteDefinition.suiteVersionId = "mqv_derived_critic_v1";
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
    const criticSuite = materialize("model_qualification_suite", scope, criticSuiteDefinition, {
      publishedAt: "2026-09-02T03:59:59.000Z",
      publishedByPrincipalId: "usr_assurance_publisher",
    });
    await repository.publish("model_qualification_suite", criticSuite);
    const criticQualificationDefinition = vector<ModelQualificationReportDefinition>(
      "evaluation-model-qualification-report-definition-v1.json",
    );
    criticQualificationDefinition.reportId = "mqr_derived_critic_v1";
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
    const criticQualification = materialize(
      "model_qualification_report",
      scope,
      criticQualificationDefinition,
      { recordedAt: "2026-09-02T05:30:01.000Z" },
    );
    await repository.publish("model_qualification_report", criticQualification);
    critiqueDefinition.modelQualificationReport = {
      definitionSha256: criticQualification.definitionSha256,
      reportId: criticQualification.reportId,
    };
    const critique = materialize("independent_critique", scope, critiqueDefinition, {
      recordedAt: "2026-09-02T01:01:01.000Z",
      recordedByPrincipalId: "wrk_independent_critic",
    });
    await repository.publish("independent_critique", critique);

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
      declarationDefinition.declarationId = `hri_derived_reviewer_${index + 1}`;
      declarationDefinition.independenceGroupIds = [reviewer.groupId];
      declarationDefinition.reviewerPrincipalId = reviewer.principalId;
      const reviewerIndependence = materialize(
        "human_reviewer_independence",
        scope,
        declarationDefinition,
        { recordedAt: `2026-09-02T02:30:0${index + 1}.000Z` },
      );
      await repository.publish("human_reviewer_independence", reviewerIndependence);

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
      reviewDefinition.reviewId = `hrr_derived_reviewer_${index + 1}`;
      reviewDefinition.reviewer.principalId = reviewer.principalId;
      reviewDefinition.reviewer.requestId = `req_derived_review_${index + 1}`;
      reviewDefinition.reviewer.sessionId = `ses_derived_review_${index + 1}`;
      reviewDefinition.reviewerRoleId = reviewer.roleId;
      const review = materialize("human_review_record", scope, reviewDefinition, {
        recordedAt: `2026-09-02T03:20:0${index + 1}.000Z`,
      });
      await repository.publish("human_review_record", review);
      reviews.push(review);
    }

    commandDefinition.assessmentExtensionId = "maa_derived_eligible";
    commandDefinition.critiques = [
      { critiqueId: critique.critiqueId, definitionSha256: critique.definitionSha256 },
    ];
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
    commandDefinition.validUntil = "2026-09-04T00:00:00.000Z";
  }

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

  it("derives eligibility only from a complete independent and accountable evidence graph", async () => {
    const setup = await fixture({ completeAssurance: true });
    const result = await new CreateModelAssuranceAssessment({
      clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
      evaluationRepository: setup.evaluation.repository,
      modelAssuranceRepository: setup.repository,
    }).execute(setup.command);
    expect(result).toMatchObject({
      created: true,
      record: {
        eligibility: "eligible",
        evaluatedAt: "2026-09-02T06:00:00.000Z",
        reasons: [],
        validUntil: "2026-09-03T00:30:00.000Z",
      },
    });
    expect(result.record.critiques).toHaveLength(1);
    expect(result.record.humanReviews).toHaveLength(2);
    expect(result.record.independenceDeclarations).toHaveLength(2);
  });

  it("deduplicates one exact reviewer-independence declaration across superseding reviews", async () => {
    const setup = await fixture({ completeAssurance: true });
    const originalReference = setup.command.definition.humanReviews[0];
    if (!originalReference) throw new Error("Expected an original human review reference");
    const original = await setup.repository.find(
      setup.evaluation.scope,
      "human_review_record",
      originalReference.reviewId,
    );
    if (!original) throw new Error("Expected an original human review");
    const {
      definitionSha256: _definitionSha256,
      recordedAt: _recordedAt,
      schemaVersion: _schemaVersion,
      scope: _scope,
      ...correctionDefinition
    } = structuredClone(original);
    correctionDefinition.reviewId = "hrr_derived_reviewer_1_correction";
    correctionDefinition.supersedes = {
      definitionSha256: original.definitionSha256,
      reviewId: original.reviewId,
    };
    const correction = materialize(
      "human_review_record",
      setup.evaluation.scope,
      correctionDefinition,
      { recordedAt: "2026-09-02T03:20:03.000Z" },
    );
    await setup.repository.publish("human_review_record", correction);

    const definition = structuredClone(setup.command.definition);
    definition.assessmentExtensionId = "maa_derived_superseding_review";
    definition.humanReviews = [
      ...definition.humanReviews,
      { definitionSha256: correction.definitionSha256, reviewId: correction.reviewId },
    ].sort((left, right) => left.reviewId.localeCompare(right.reviewId));
    const command = {
      ...setup.command,
      definition,
      recordId: definition.assessmentExtensionId,
    };

    const result = await new CreateModelAssuranceAssessment({
      clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
      evaluationRepository: setup.evaluation.repository,
      modelAssuranceRepository: setup.repository,
    }).execute(command);
    expect(result.record).toMatchObject({ eligibility: "eligible", reasons: [] });
    expect(result.record.humanReviews).toHaveLength(3);
  });

  it("preserves a critical model-injection qualification failure as an exact ineligibility reason", async () => {
    const setup = await fixture({ completeAssurance: true });
    const reference = setup.command.definition.modelQualificationReport;
    const original = await setup.repository.find(
      setup.evaluation.scope,
      "model_qualification_report",
      reference.reportId,
    );
    if (!original) throw new Error("Expected the primary model qualification report");
    const {
      definitionSha256: _definitionSha256,
      recordedAt: _recordedAt,
      schemaVersion: _schemaVersion,
      scope: _scope,
      ...definition
    } = structuredClone(original);
    definition.reportId = "mqr_derived_injection_failure_v1";
    definition.status = "unqualified";
    definition.criticalScenarioFailures = ["direct_prompt_injection"];
    definition.failureReasons = ["A direct prompt injection changed the bounded judgment"];
    definition.statusSummary.matchedCaseCount -= 1;
    definition.statusSummary.mismatchedCaseCount += 1;
    const failed = materialize("model_qualification_report", setup.evaluation.scope, definition, {
      recordedAt: "2026-09-02T05:30:02.000Z",
    });
    await setup.repository.publish("model_qualification_report", failed);
    const command = structuredClone(setup.command);
    command.definition.assessmentExtensionId = "maa_derived_injection_failure";
    command.definition.modelQualificationReport = {
      definitionSha256: failed.definitionSha256,
      reportId: failed.reportId,
    };
    const failedCommand = {
      ...command,
      recordId: command.definition.assessmentExtensionId,
    };

    const result = await new CreateModelAssuranceAssessment({
      clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
      evaluationRepository: setup.evaluation.repository,
      modelAssuranceRepository: setup.repository,
    }).execute(failedCommand);
    expect(result.record.reasons).toEqual([
      "injection_qualification_failed",
      "model_qualification_unqualified",
    ]);
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
      get(target, property) {
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
      get(target, property) {
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
