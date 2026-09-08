import type { ModelAssuranceRecordByKind } from "../evaluation/model-assurance-repository.js";
import type { PolicyEvaluationReferenceCollector } from "./policy-evaluation-reference-collector.js";

type SourceKind<K> = K extends "blinded_evaluation_plan"
  ? "blinded_plan"
  : K extends "blinded_evaluation_result"
    ? "blinded_result"
    : K extends "model_assisted_evaluator"
      ? "model_assisted_evaluator_spec"
      : K;

type Enumerators = {
  readonly [K in keyof ModelAssuranceRecordByKind as SourceKind<K>]: (
    record: ModelAssuranceRecordByKind[K],
    out: PolicyEvaluationReferenceCollector,
  ) => void;
};

export const policyEvaluationAssuranceReferences: Enumerators = {
  blinded_plan(record, out) {
    out.artifact("/blindMap", record.blindMap);
    out.record("/calibrationReport", "calibration_report", record.calibrationReport);
    out.criteria("/criteria", record.criteria);
    out.record("/evaluator", "model_assisted_evaluator_spec", record.evaluator);
    out.record(
      "/independenceDeclaration",
      "independence_declaration",
      record.independenceDeclaration,
    );
    record.leakageChecks.forEach(({ evidence }, index) => {
      out.artifact(`/leakageChecks/${index}/evidence`, evidence);
    });
    out.record("/modelProfile", "model_evaluator_profile", record.modelProfile);
    out.optionalRecord("/predecessor", "blinded_plan", record.predecessor);
    out.artifact("/redactionReport", record.redactionReport);
    out.artifacts("/subjectArtifacts", record.subjectArtifacts);
  },
  blinded_result(record, out) {
    record.attempts.forEach((attempt, index) => {
      const path = `/attempts/${index}`;
      if (attempt.status === "completed") {
        out.record(`${path}/observation`, "raw_observation", attempt.observation);
        out.artifact(`${path}/providerResponse`, attempt.providerResponse);
        out.artifact(`${path}/rationale`, attempt.rationale);
      } else {
        out.artifacts(`${path}/errorEvidence`, attempt.errorEvidence);
      }
    });
    out.artifact("/blindMapAccessEvidence", record.blindMapAccessEvidence);
    out.artifacts("/disagreementEvidence", record.disagreementEvidence);
    out.artifact("/orderComparison", record.orderComparison);
    out.record("/plan", "blinded_plan", record.plan);
  },
  calibration_report(record, out) {
    out.artifacts("/calibrationEvidence", record.calibrationEvidence);
    out.criteria("/criteria", record.criteria);
    out.record("/dataset", "dataset_version", record.dataset);
    if (record.distributionShift.status !== "not_assessed") {
      out.artifacts("/distributionShift/evidence", record.distributionShift.evidence);
    }
    out.record("/evaluator", "model_assisted_evaluator_spec", record.evaluator);
    out.artifacts("/labelSources", record.labelSources);
    out.record("/modelProfile", "model_evaluator_profile", record.modelProfile);
    out.optionalRecord("/predecessor", "calibration_report", record.predecessor);
    out.record("/qualificationReport", "qualification_report", record.qualificationReport);
  },
  human_review_protocol(record, out) {
    out.artifact("/accessibility/accommodationProcess", record.accessibility.accommodationProcess);
    out.criteria("/claim/criteria", record.claim.criteria);
    out.artifacts("/claim/evidenceBundle", record.claim.evidenceBundle);
    out.artifact("/dissentPolicy/adjudicationRules", record.dissentPolicy.adjudicationRules);
    out.optionalRecord("/predecessor", "human_review_protocol", record.predecessor);
    record.reviewerRoles.forEach((role, index) => {
      out.artifacts(`/reviewerRoles/${index}/credentialRequirements`, role.credentialRequirements);
      out.artifacts(`/reviewerRoles/${index}/trainingRequirements`, role.trainingRequirements);
    });
  },
  human_review_record(record, out) {
    out.record("/assessment", "assessment", record.assessment);
    out.artifacts("/counterevidence", record.counterevidence);
    out.artifacts("/credentialEvidence", record.credentialEvidence);
    out.records("/critiques", "independent_critique", record.critiques);
    out.artifact("/evidenceAccessManifest", record.evidenceAccessManifest);
    out.artifacts("/expertiseEvidence", record.expertiseEvidence);
    out.record(
      "/independenceDeclaration",
      "human_reviewer_independence",
      record.independenceDeclaration,
    );
    out.records("/observations", "raw_observation", record.observations);
    out.record("/protocol", "human_review_protocol", record.protocol);
    out.artifact("/rationale", record.rationale);
    out.artifacts("/reviewedArtifacts", record.reviewedArtifacts);
    out.artifact("/reviewer/sessionEvidence", record.reviewer.sessionEvidence);
    out.artifacts("/sourceCitations", record.sourceCitations);
    out.optionalRecord("/supersedes", "human_review_record", record.supersedes);
    out.artifacts("/trainingEvidence", record.trainingEvidence);
  },
  human_reviewer_independence(record, out) {
    out.optionalRecord("/predecessor", "human_reviewer_independence", record.predecessor);
    out.artifacts("/reviewBasis", record.reviewBasis);
  },
  independence_declaration(record, out) {
    out.optionalRecord("/predecessor", "independence_declaration", record.predecessor);
    out.artifacts("/reviewBasis", record.reviewBasis);
    out.record("/subject/evaluator", "model_assisted_evaluator_spec", record.subject.evaluator);
    out.record("/subject/modelProfile", "model_evaluator_profile", record.subject.modelProfile);
  },
  independent_critique(record, out) {
    out.artifact("/accessAttestation/evidence", record.accessAttestation.evidence);
    out.artifacts("/allowedEvidence", record.allowedEvidence);
    out.record("/calibrationReport", "calibration_report", record.calibrationReport);
    out.criterion("/criterion", record.criterion);
    out.record("/evaluator", "model_assisted_evaluator_spec", record.evaluator);
    out.artifact("/evidenceAccessManifest", record.evidenceAccessManifest);
    out.record(
      "/independenceDeclaration",
      "independence_declaration",
      record.independenceDeclaration,
    );
    out.record("/modelProfile", "model_evaluator_profile", record.modelProfile);
    out.record(
      "/modelQualificationReport",
      "model_qualification_report",
      record.modelQualificationReport,
    );
    out.record("/observation", "raw_observation", record.observation);
    if (record.outcome.status === "produced") {
      record.outcome.findings.forEach(({ evidence }, index) => {
        out.artifacts(`/outcome/findings/${index}/evidence`, evidence);
      });
      out.artifact("/outcome/output", record.outcome.output);
    } else {
      out.artifacts("/outcome/evidence", record.outcome.evidence);
    }
    out.record("/qualificationReport", "qualification_report", record.qualificationReport);
    out.artifact("/question", record.question);
  },
  model_assisted_evaluator_spec(record, out) {
    out.artifact("/inputSchema", record.inputSchema);
    out.record("/modelProfile", "model_evaluator_profile", record.modelProfile);
    out.artifact("/outputSchema", record.outputSchema);
    out.optionalRecord("/predecessor", "model_assisted_evaluator_spec", record.predecessor);
    out.record(
      "/qualificationFixtureSet",
      "qualification_fixture_set",
      record.qualificationFixtureSet,
    );
    out.criterionSelectors("/supportedCriteria", record.supportedCriteria);
  },
  model_assurance_assessment(record, out) {
    out.record("/baseAssessment", "assessment", record.baseAssessment);
    out.record("/blindedPlan", "blinded_plan", record.blindedPlan);
    out.record("/blindedResult", "blinded_result", record.blindedResult);
    out.record("/calibrationReport", "calibration_report", record.calibrationReport);
    out.artifacts("/counterevidence", record.counterevidence);
    out.records("/critiques", "independent_critique", record.critiques);
    out.artifacts("/disagreementEvidence", record.disagreementEvidence);
    out.record("/humanReviewProtocol", "human_review_protocol", record.humanReviewProtocol);
    out.records("/humanReviews", "human_review_record", record.humanReviews);
    out.records(
      "/independenceDeclarations",
      "independence_declaration",
      record.independenceDeclarations,
    );
    out.record(
      "/modelQualificationReport",
      "model_qualification_report",
      record.modelQualificationReport,
    );
    out.records(
      "/nonModelEvidence/observations",
      "raw_observation",
      record.nonModelEvidence.observations,
    );
    out.records("/nonModelEvidence/oracles", "oracle_spec", record.nonModelEvidence.oracles);
    out.artifact("/policy", record.policy);
  },
  model_evaluator_profile(record, out) {
    out.modelEvaluatorSelector("/evaluator", record.evaluator);
    out.artifact("/outputSchema", record.outputSchema);
    out.optionalRecord("/predecessor", "model_evaluator_profile", record.predecessor);
    record.prompts.forEach(({ template }, index) => {
      out.artifact(`/prompts/${index}/template`, template);
    });
    if (record.provider.modelResolution.status === "exact") {
      out.artifact(
        "/provider/modelResolution/resolutionEvidence",
        record.provider.modelResolution.resolutionEvidence,
      );
    }
    out.criterionSelectors("/supportedCriteria", record.supportedCriteria);
    out.artifacts("/toolContracts", record.toolContracts);
  },
  model_qualification_report(record, out) {
    out.record("/baseQualificationReport", "qualification_report", record.baseQualificationReport);
    out.record("/calibrationReport", "calibration_report", record.calibrationReport);
    out.artifacts("/environmentEvidence", record.environmentEvidence);
    out.record("/evaluator", "model_assisted_evaluator_spec", record.evaluator);
    out.record(
      "/independenceDeclaration",
      "independence_declaration",
      record.independenceDeclaration,
    );
    out.record("/modelProfile", "model_evaluator_profile", record.modelProfile);
    out.optionalRecord("/predecessor", "model_qualification_report", record.predecessor);
    out.artifact("/resultManifest", record.resultManifest);
    out.artifact("/resultManifestSchema", record.resultManifestSchema);
    out.record("/suite", "model_qualification_suite", record.suite);
    out.artifacts("/validationEvidence", record.validationEvidence);
  },
  model_qualification_suite(record, out) {
    out.record(
      "/baseQualificationFixtureSet",
      "qualification_fixture_set",
      record.baseQualificationFixtureSet,
    );
    out.record("/blindedPlan", "blinded_plan", record.blindedPlan);
    out.artifact("/caseManifest", record.caseManifest);
    out.artifact("/caseManifestSchema", record.caseManifestSchema);
    out.criterionSelectors("/criteria", record.criteria);
    out.record("/dataset", "dataset_version", record.dataset);
    out.record("/evaluator", "model_assisted_evaluator_spec", record.evaluator);
    out.artifact("/executionPolicy/fixedSeeds", record.executionPolicy.fixedSeeds);
    out.artifact("/manifestValidationEvidence", record.manifestValidationEvidence);
    out.record("/modelProfile", "model_evaluator_profile", record.modelProfile);
    out.optionalRecord("/predecessor", "model_qualification_suite", record.predecessor);
  },
};
