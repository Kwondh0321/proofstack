import type {
  ComparisonDefinition,
  ComparisonEvidenceSnapshot,
  ComparisonResult,
  PolicyInstallationBinding,
  ReleaseCandidate,
  ReleasePolicy,
} from "@proofstack/contracts";
import { revalidatePolicyEvaluationCapturedRecord } from "./policy-evaluation-captured-record.js";
import {
  inspectPolicyEvaluationControlRecord,
  type PolicyEvaluationControlRead,
  type PolicyEvaluationControlRecord,
  type PolicyEvaluationControlSource,
} from "./policy-evaluation-control-record-reader.js";
import type { PolicyEvaluationDefinitionReadInput } from "./policy-evaluation-definition-reader.js";
import {
  PolicyEvaluationEvidenceReferenceError,
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
} from "./policy-evaluation-reference-collector.js";

function definitionReferences(
  record: ComparisonDefinition,
  out: PolicyEvaluationReferenceCollector,
) {
  for (const role of ["baseline", "candidate"] as const) {
    const subject = record[role];
    out.record(`/${role}/dataset`, "dataset_version", subject.dataset);
    subject.fixtures.forEach((fixture, index) => {
      const path = `/${role}/fixtures/${index}`;
      out.records(`${path}/assessments`, "assessment", fixture.assessments);
      out.record(`${path}/fixture`, "regression_fixture_version", fixture.fixture);
      out.records(
        `${path}/modelAssuranceAssessments`,
        "model_assurance_assessment",
        fixture.modelAssuranceAssessments,
      );
      out.replay(`${path}/replay`, fixture.replay);
    });
  }
  record.metrics.forEach((metric, index) => {
    if ("criterion" in metric) out.criterion(`/metrics/${index}/criterion`, metric.criterion);
  });
  if (record.predecessor) {
    // This declaration lacks comparisonId. Never invent it from the current parent identity.
    out.controlDeclaration("/predecessor", {
      kind: "comparison_predecessor",
      reference: record.predecessor,
    });
  }
}

function snapshotReferences(
  record: ComparisonEvidenceSnapshot,
  out: PolicyEvaluationReferenceCollector,
) {
  out.record("/comparison", "comparison_definition", record.comparison);
  out.record("/dataset", "dataset_version", record.dataset);
  record.fixtures.forEach((fixture, index) => {
    const path = `/fixtures/${index}`;
    fixture.artifacts.forEach(({ artifact }, child) => {
      out.artifact(`${path}/artifacts/${child}/artifact`, artifact);
    });
    fixture.assurance.forEach((state, child) => {
      if (state.kind === "assessment")
        out.record(`${path}/assurance/${child}/reference`, "assessment", state.reference);
      else
        out.record(
          `${path}/assurance/${child}/reference`,
          "model_assurance_assessment",
          state.reference,
        );
    });
    fixture.evaluationOutcomes.forEach((outcome, child) => {
      out.record(
        `${path}/evaluationOutcomes/${child}/assessment`,
        "assessment",
        outcome.assessment,
      );
      out.criterion(`${path}/evaluationOutcomes/${child}/criterion`, outcome.criterion);
    });
    out.record(`${path}/fixture`, "regression_fixture_version", fixture.fixture);
    fixture.numericObservations.forEach(({ observation }, child) => {
      out.record(
        `${path}/numericObservations/${child}/observation`,
        "raw_observation",
        observation,
      );
    });
    out.replay(`${path}/replay`, fixture.replay);
    fixture.safetyEvents.forEach((event, child) => {
      out.controlDeclaration(`${path}/safetyEvents/${child}`, {
        kind: "safety_event",
        reference: event,
      });
    });
  });
  record.omissions.forEach((omission, index) => {
    const path = `/omissions/${index}`;
    switch (omission.sourceKind) {
      case "artifact":
        out.controlDeclaration(`${path}/artifactId`, {
          kind: "artifact_identity",
          reference: omission.artifactId,
        });
        break;
      case "assessment":
        out.record(`${path}/assessment`, "assessment", omission.assessment);
        break;
      case "model_assurance_assessment":
        out.record(
          `${path}/modelAssuranceAssessment`,
          "model_assurance_assessment",
          omission.modelAssuranceAssessment,
        );
        break;
      case "classified_content":
      case "numeric_measurement":
        // Projection/measurement names are parent-bound omissions, not retrievable identities.
        break;
    }
  });
}

function resultReferences(record: ComparisonResult, out: PolicyEvaluationReferenceCollector) {
  record.artifactChanges.forEach((change, index) => {
    const path = `/artifactChanges/${index}`;
    out.controlDeclaration(`${path}/artifactId`, {
      kind: "artifact_identity",
      reference: change.artifactId,
    });
    if (change.baseline) out.artifact(`${path}/baseline`, change.baseline);
    if (change.candidate) out.artifact(`${path}/candidate`, change.candidate);
  });
  out.record("/baselineSnapshot", "comparison_snapshot", record.baselineSnapshot);
  out.record("/candidateSnapshot", "comparison_snapshot", record.candidateSnapshot);
  record.cases.forEach((item, index) => {
    if ("baseline" in item && item.baseline)
      out.record(`/cases/${index}/baseline`, "regression_fixture_version", item.baseline);
    if ("candidate" in item && item.candidate)
      out.record(`/cases/${index}/candidate`, "regression_fixture_version", item.candidate);
  });
  out.record("/comparison", "comparison_definition", record.comparison);
  record.verdictMarginals.forEach(({ criterion }, index) => {
    out.criterion(`/verdictMarginals/${index}/criterion`, criterion);
  });
  record.verdictTransitions.forEach(({ criterion }, index) => {
    out.criterion(`/verdictTransitions/${index}/criterion`, criterion);
  });
}

function candidateReferences(record: ReleaseCandidate, out: PolicyEvaluationReferenceCollector) {
  out.records("/assessments", "assessment", record.assessments);
  record.buildArtifacts.forEach(({ artifact }, index) => {
    out.artifact(`/buildArtifacts/${index}/artifact`, artifact);
  });
  out.records("/comparisons", "comparison_result", record.comparisons);
  out.records("/datasets", "dataset_version", record.datasets);
  out.records(
    "/modelAssuranceAssessments",
    "model_assurance_assessment",
    record.modelAssuranceAssessments,
  );
  out.optionalRecord("/predecessor", "release_candidate", record.predecessor);
  record.runtimeComponents.forEach((component, index) => {
    const path = `/runtimeComponents/${index}`;
    if (component.kind === "model") {
      const { providerId, providerModelId, resolution } = component;
      out.controlDeclaration(path, {
        kind: "model_declaration",
        reference: { providerId, providerModelId, resolution },
      });
      out.record(`${path}/adapter`, "runtime_adapter", component.adapter);
      if (resolution.status === "exact")
        out.artifact(`${path}/resolution/resolutionEvidence`, resolution.resolutionEvidence);
    } else out.artifact(`${path}/content`, component.content);
  });
  out.controlDeclaration("/source", { kind: "candidate_source", reference: record.source });
  out.record("/targetRelease", "target_release", record.targetRelease);
}

function qualifiedSources(
  path: string,
  sources: ReleasePolicy["sources"],
  out: PolicyEvaluationReferenceCollector,
) {
  sources.forEach(({ review, source }, index) => {
    out.record(`${path}/${index}/review`, "source_review", review);
    out.record(`${path}/${index}/source`, "source_snapshot", source);
  });
}

function policyReferences(record: ReleasePolicy, out: PolicyEvaluationReferenceCollector) {
  qualifiedSources("/counterevidence", record.counterevidence, out);
  out.record("/installationBinding", "policy_installation_binding", record.installationBinding);
  out.optionalRecord("/predecessor", "release_policy", record.predecessor);
  record.rules.forEach((rule, index) => {
    const path = `/rules/${index}/predicate`;
    const predicate = rule.predicate;
    switch (predicate.kind) {
      case "comparison_threshold":
      case "safety_event_ceiling":
        out.record(`${path}/comparison`, "comparison_definition", predicate.comparison);
        break;
      case "coverage_floor":
        if (predicate.sourceKind === "assessment_samples")
          out.record(`${path}/assessment`, "assessment", predicate.assessment);
        else out.record(`${path}/comparison`, "comparison_definition", predicate.comparison);
        break;
      case "uncertainty_bound":
        out.record(`${path}/assessment`, "assessment", predicate.assessment);
        break;
      case "eligibility_required":
        if (predicate.assessmentClass === "evaluation")
          out.record(`${path}/assessment`, "assessment", predicate.assessment);
        else out.record(`${path}/assessment`, "model_assurance_assessment", predicate.assessment);
        break;
      case "artifact_required":
        out.controlDeclaration(path, { kind: "artifact_requirement", reference: predicate });
        break;
      case "approval_required":
        out.controlDeclaration(path, { kind: "approval_requirement", reference: predicate });
        break;
    }
    qualifiedSources(`/rules/${index}/sources`, rule.sources, out);
  });
  qualifiedSources("/sources", record.sources, out);
}

type Records = {
  comparison_definition: ComparisonDefinition;
  comparison_snapshot: ComparisonEvidenceSnapshot;
  comparison_result: ComparisonResult;
  release_candidate: ReleaseCandidate;
  release_policy: ReleasePolicy;
  policy_installation_binding: PolicyInstallationBinding;
};
const enumerators = {
  comparison_definition: definitionReferences,
  comparison_snapshot: snapshotReferences,
  comparison_result: resultReferences,
  release_candidate: candidateReferences,
  release_policy: policyReferences,
  policy_installation_binding: (record, out) =>
    out.artifact("/authorityEvidence", record.authorityEvidence),
} satisfies {
  [K in PolicyEvaluationControlSource["kind"]]: (
    record: Records[K],
    out: PolicyEvaluationReferenceCollector,
  ) => void;
};

/** Direct occurrences only: no child reads, rule execution, current authority, or graph sealing. */
export function enumeratePolicyEvaluationControlReferences(
  input: PolicyEvaluationDefinitionReadInput<PolicyEvaluationControlSource>,
  evidence: PolicyEvaluationControlRead,
  limits: PolicyEvaluationEvidenceReferenceLimits,
) {
  const out = new PolicyEvaluationReferenceCollector(limits);
  try {
    const checked = revalidatePolicyEvaluationCapturedRecord<
      PolicyEvaluationDefinitionReadInput<PolicyEvaluationControlSource>,
      PolicyEvaluationControlRecord,
      PolicyEvaluationControlSource
    >(input, evidence, inspectPolicyEvaluationControlRecord);
    // The fixed inspector has already checked this exact source kind against its domain record.
    enumerators[checked.source.kind](checked.record as never, out);
    return {
      ...out.result(),
      recordSha256: checked.observation.recordSha256,
      source: checked.source,
    };
  } catch (cause) {
    if (cause instanceof PolicyEvaluationEvidenceReferenceError) throw cause;
    throw new PolicyEvaluationEvidenceReferenceError("input_invalid", { cause });
  }
}
