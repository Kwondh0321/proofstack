import type {
  ModelInteractionAttempt,
  RecordedInteractionFixtureVersion,
  ToolInteractionAttempt,
} from "@proofstack/contracts";
import {
  type PolicyEvaluationDefinitionReadInput,
  PolicyEvaluationEvidenceReferenceError,
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
  revalidatePolicyEvaluationCapturedRecord,
} from "@proofstack/core";
import {
  inspectPolicyEvaluationDataset,
  type PolicyEvaluationDatasetRead,
  type PolicyEvaluationDatasetRecord,
  type PolicyEvaluationDatasetSource,
} from "./policy-evaluation-dataset-reader.js";

// Explicit field inventory; new schema fields must be deliberately included here.
const modelArtifactFields = {
  inputMessagesArtifactId: true,
  outputMessagesArtifactId: true,
  promptVariablesArtifactId: true,
  providerConfigurationArtifactId: true,
  providerRequestArtifactId: true,
  providerResponseArtifactId: true,
  streamingFramesArtifactId: true,
  systemInstructionsArtifactId: true,
} satisfies Record<keyof ModelInteractionAttempt["artifacts"], true>;
const toolArtifactFields = { argumentsArtifactId: true, resultArtifactId: true } satisfies Record<
  keyof ToolInteractionAttempt["artifacts"],
  true
>;

function interactionReferences(
  record: RecordedInteractionFixtureVersion,
  out: PolicyEvaluationReferenceCollector,
): void {
  const capture = record.interactionCapture;
  const bindings = new Map(
    capture.artifacts.map(({ contentReference }) => [
      contentReference.artifactId,
      contentReference,
    ]),
  );
  const artifact = (path: string, id: string) => {
    const reference = bindings.get(id);
    // Domain validation establishes this join; fail closed if that invariant changes.
    if (!reference) throw new PolicyEvaluationEvidenceReferenceError("evidence_unverified");
    out.artifact(path, reference);
  };
  capture.artifacts.forEach((binding, index) => {
    out.artifact(
      `/interactionCapture/artifacts/${index}/contentReference`,
      binding.contentReference,
    );
  });
  capture.interactions.forEach((interaction, index) => {
    const path = `/interactionCapture/interactions/${index}`;
    interaction.attempts.forEach((attempt, attemptIndex) => {
      const location = `${path}/attempts/${attemptIndex}`;
      const fields = interaction.kind === "model" ? modelArtifactFields : toolArtifactFields;
      for (const key of Object.keys(fields)) {
        const id = Reflect.get(attempt.artifacts, key) as string | undefined;
        if (id !== undefined) artifact(`${location}/artifacts/${key}`, id);
      }
      out.protocol(`${location}/normalizedRequest`, {
        name: attempt.normalizedRequest.adapterName,
        version: attempt.normalizedRequest.adapterVersion,
      });
      artifact(`${location}/normalizedRequest/artifactId`, attempt.normalizedRequest.artifactId);
      if ("provider" in attempt) {
        out.endpointProfile(`${location}/provider`, {
          endpointProfileId: attempt.provider.endpointProfileId,
          endpointProfileVersion: attempt.provider.endpointProfileVersion,
        });
      }
    });
    if (interaction.kind === "model") {
      out.prompt(`${path}/prompt`, interaction.prompt);
      artifact(`${path}/prompt/artifactId`, interaction.prompt.artifactId);
      interaction.toolContracts.forEach((tool, index) => {
        out.toolContract(`${path}/toolContracts/${index}`, tool);
        artifact(`${path}/toolContracts/${index}/artifactId`, tool.artifactId);
      });
    } else {
      out.toolContract(`${path}/tool`, interaction.tool);
      artifact(`${path}/tool/artifactId`, interaction.tool.artifactId);
    }
  });
  out.protocol("/interactionCapture/source/captureAdapter", capture.source.captureAdapter);
  out.protocol("/interactionCapture/source/sourceFormat", capture.source.sourceFormat);
}

/**
 * Enumerates the observed parent's direct dependencies only, without repository or network I/O.
 * IDs are not evidence of retained bytes or installed authority. Trace selectors retain the exact
 * observed event order, not a claim of complete traces. Lifecycle and graph sealing remain separate.
 */
export function enumeratePolicyEvaluationDatasetReferences(
  input: PolicyEvaluationDefinitionReadInput<PolicyEvaluationDatasetSource>,
  evidence: PolicyEvaluationDatasetRead,
  limits: PolicyEvaluationEvidenceReferenceLimits,
) {
  const out = new PolicyEvaluationReferenceCollector(limits);
  try {
    const checked = revalidatePolicyEvaluationCapturedRecord<
      PolicyEvaluationDefinitionReadInput<PolicyEvaluationDatasetSource>,
      PolicyEvaluationDatasetRecord,
      PolicyEvaluationDatasetSource
    >(input, evidence, inspectPolicyEvaluationDataset);
    const record = checked.record;
    if ("datasetVersionId" in record) {
      out.records("/fixtureVersions", "regression_fixture_version", record.fixtureVersions);
      if (record.predecessor)
        out.record("/predecessor", "dataset_version", {
          ...record.predecessor,
          datasetId: record.datasetId,
        });
    } else {
      if (record.schemaVersion === "0.2") interactionReferences(record, out);
      if (record.predecessor)
        out.record("/predecessor", "regression_fixture_version", {
          ...record.predecessor,
          fixtureId: record.fixtureId,
        });
      out.traceSnapshot("/source", record.source);
    }
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
