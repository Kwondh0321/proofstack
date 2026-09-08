import type { EvaluationRecordByKind } from "../evaluation/record-evaluation.js";
import type { PolicyEvaluationReferenceCollector } from "./policy-evaluation-reference-collector.js";

type Enumerators = {
  readonly [K in keyof EvaluationRecordByKind]: (
    record: EvaluationRecordByKind[K],
    out: PolicyEvaluationReferenceCollector,
  ) => void;
};

/** Explicit schema-field traversal; repository-local lineage helpers do not cover this boundary. */
export const policyEvaluationRecordReferences: Enumerators = {
  aggregation_policy(record, out) {
    out.record("/dataset", "dataset_version", record.dataset);
  },
  assessment(record, out) {
    out.record("/aggregate", "evaluation_aggregate", record.aggregate);
    out.record("/aggregationPolicy", "aggregation_policy", record.aggregationPolicy);
    out.evidence("/counterevidence", record.counterevidence);
    out.criterion("/criterion", record.criterion);
    out.record("/criterionStatus", "criterion_set_status", record.criterionStatus);
    out.records("/observations", "raw_observation", record.observations);
    out.records("/qualifications", "qualification_report", record.qualifications);
    out.records("/runs", "evaluation_run", record.runs);
    out.records("/sourceReviews", "source_review", record.sourceReviews);
  },
  criterion_set(record, out) {
    record.criteria.forEach((criterion, index) => {
      const path = `/criteria/${index}`;
      out.records(`${path}/counterevidence`, "source_snapshot", criterion.counterevidence);
      out.record(`${path}/evaluator`, "evaluator_spec", criterion.evaluator);
      out.record(`${path}/oracle`, "oracle_spec", criterion.oracle);
      criterion.qualificationFixtures.forEach(({ fixture }, caseIndex) => {
        out.record(
          `${path}/qualificationFixtures/${caseIndex}/fixture`,
          "regression_fixture_version",
          fixture,
        );
      });
    });
    out.optionalRecord("/predecessor", "criterion_set", record.predecessor);
    record.sources.forEach(({ review, source }, index) => {
      out.record(`/sources/${index}/review`, "source_review", review);
      out.record(`/sources/${index}/source`, "source_snapshot", source);
    });
  },
  criterion_set_status(record, out) {
    out.record("/criterionSet", "criterion_set", record.criterionSet);
    out.optionalRecord("/previousStatus", "criterion_set_status", record.previousStatus);
    out.optionalRecord("/supersededBy", "criterion_set", record.supersededBy);
  },
  discovery_record() {
    // URIs and search snippets are discovery claims, not retained records or fetch authority.
  },
  evaluation_aggregate(record, out) {
    out.record("/aggregationPolicy", "aggregation_policy", record.aggregationPolicy);
    out.criterion("/criterion", record.criterion);
    record.members.forEach(({ result, run }, index) => {
      out.record(`/members/${index}/result`, "evaluation_run_result", result);
      out.record(`/members/${index}/run`, "evaluation_run", run);
    });
    if (record.samplingAssumption.status === "supported") {
      out.artifacts("/samplingAssumption/evidence", record.samplingAssumption.evidence);
    }
  },
  evaluation_run(record, out) {
    out.record("/aggregationPolicy", "aggregation_policy", record.aggregationPolicy);
    out.implementation("/applicability/interpreter", record.applicability.interpreter);
    out.criterion("/criterion", record.criterion);
    out.record("/criterionStatus", "criterion_set_status", record.criterionStatus);
    out.record("/dataset", "dataset_version", record.dataset);
    out.artifacts("/environmentEvidence", record.environmentEvidence);
    out.record("/evaluator", "evaluator_spec", record.evaluator);
    out.record("/evaluatorQualification", "qualification_report", record.evaluatorQualification);
    out.record("/fixture", "regression_fixture_version", record.fixture);
    out.artifacts("/inputEvidence", record.inputEvidence);
    out.record("/oracle", "oracle_spec", record.oracle);
    out.record("/oracleQualification", "qualification_report", record.oracleQualification);
    out.replay("/replay", record.replay);
    out.records("/sourceReviews", "source_review", record.sourceReviews);
  },
  evaluation_run_rejection(record, out) {
    out.implementation("/applicability/interpreter", record.applicability.interpreter);
    out.criterion("/criterion", record.criterion);
    out.record("/criterionStatus", "criterion_set_status", record.criterionStatus);
    out.records("/sourceReviews", "source_review", record.sourceReviews);
  },
  evaluation_run_result(record, out) {
    out.runIdentity("/evaluationRunId", record.evaluationRunId);
    out.records("/observations", "raw_observation", record.observations);
  },
  evaluator_spec(record, out) {
    out.implementation("/implementation", record.implementation);
    out.artifact("/inputSchema", record.inputSchema);
    if (record.kindDeclaration.kind === "composite") {
      out.records(
        "/kindDeclaration/components",
        "evaluator_spec",
        record.kindDeclaration.components,
      );
    }
    out.records("/oracles", "oracle_spec", record.oracles);
    out.artifact("/outputSchema", record.outputSchema);
    out.optionalRecord("/predecessor", "evaluator_spec", record.predecessor);
    out.record(
      "/qualificationFixtureSet",
      "qualification_fixture_set",
      record.qualificationFixtureSet,
    );
    out.criterionSelectors("/supportedCriteria", record.supportedCriteria);
  },
  oracle_spec(record, out) {
    out.implementation("/implementation", record.implementation);
    out.artifact("/inputSchema", record.inputSchema);
    out.artifact("/outputSchema", record.outputSchema);
    out.optionalRecord("/predecessor", "oracle_spec", record.predecessor);
    out.record(
      "/qualificationFixtureSet",
      "qualification_fixture_set",
      record.qualificationFixtureSet,
    );
    out.criterionSelectors("/supportedCriteria", record.supportedCriteria);
  },
  qualification_fixture_set(record, out) {
    record.cases.forEach(({ criterion, fixture }, index) => {
      out.criterionSelector(`/cases/${index}/criterion`, criterion);
      out.record(`/cases/${index}/fixture`, "regression_fixture_version", fixture);
    });
    out.optionalRecord("/predecessor", "qualification_fixture_set", record.predecessor);
  },
  qualification_report(record, out) {
    record.caseResults.forEach(({ rawEvidence }, index) => {
      out.artifacts(`/caseResults/${index}/rawEvidence`, rawEvidence);
    });
    out.artifacts("/environmentEvidence", record.environmentEvidence);
    out.record("/fixtureSet", "qualification_fixture_set", record.fixtureSet);
    out.qualificationPolicy("/policy", record.policy);
    if (record.subject.kind === "oracle") {
      out.record("/subject/oracle", "oracle_spec", record.subject.oracle);
    } else {
      out.record("/subject/evaluator", "evaluator_spec", record.subject.evaluator);
    }
  },
  raw_observation(record, out) {
    out.evidence("/counterevidence", record.counterevidence);
    out.evidence("/evidence", record.evidence);
    if (record.output.produced && record.output.artifact) {
      out.artifact("/output/artifact", record.output.artifact);
    }
    out.record("/run", "evaluation_run", record.run);
  },
  source_review(record, out) {
    out.artifacts("/reviewBasis", record.reviewBasis);
    out.records("/reviewedConflicts", "source_snapshot", record.reviewedConflicts);
    out.optionalRecord(
      "/reviewerQualification",
      "source_reviewer_qualification",
      record.reviewerQualification,
    );
    out.record("/source", "source_snapshot", record.source);
    out.optionalRecord("/supersedesReview", "source_review", record.supersedesReview);
  },
  source_reviewer_qualification(record, out) {
    out.artifacts("/credentialEvidence", record.credentialEvidence);
    out.optionalRecord("/predecessor", "source_reviewer_qualification", record.predecessor);
  },
  source_snapshot(record, out) {
    out.records("/conflictsWith", "source_snapshot", record.conflictsWith);
    out.artifact("/content", record.content);
    if (record.discovery) {
      out.record("/discovery", "discovery_record", {
        definitionSha256: record.discovery.definitionSha256,
        discoveryId: record.discovery.discoveryId,
      });
    }
    if (record.identityVerification.status !== "unverified") {
      out.artifacts("/identityVerification/evidence", record.identityVerification.evidence);
    }
    out.records("/supersedes", "source_snapshot", record.supersedes);
  },
};
