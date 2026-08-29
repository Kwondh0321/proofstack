import { createHash } from "node:crypto";
import {
  type InteractionArtifactBinding,
  type InteractionCaptureManifest,
  type InteractionNormalizedRequestReference,
  type InteractionPromptReference,
  type InteractionToolContractReference,
  type ModelInteractionAttempt,
  type RecordedInteractionFixtureVersionDefinition,
  RecordedInteractionFixtureVersionDefinitionSchema,
  type ToolInteractionAttempt,
} from "@proofstack/contracts";
import {
  concatenateBytes,
  encodeBoolean,
  encodeOptional,
  encodeSequence,
  encodeString,
  encodeUnsigned32,
} from "./binary-encoding.js";

export const RECORDED_INTERACTION_FIXTURE_DEFINITION_DOMAIN =
  "proofstack.fixture-version.v2" as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function encodeArtifactBinding(binding: InteractionArtifactBinding): Uint8Array {
  const reference = binding.contentReference;
  const redactionRecords =
    binding.redaction.status === "applied" ? binding.redaction.records : undefined;
  return concatenateBytes([
    encodeString(binding.role),
    encodeString(reference.artifactId),
    encodeString(reference.classification),
    encodeString(reference.mediaType),
    encodeOptional(reference.redactedAt, encodeString),
    encodeString(reference.sha256),
    encodeUnsigned32(reference.sizeBytes),
    encodeString(binding.redaction.status),
    encodeOptional(redactionRecords, (records) =>
      encodeSequence(records, (record) =>
        concatenateBytes([
          encodeString(record.stage),
          encodeString(record.rulesetId),
          encodeString(record.rulesetVersion),
          encodeUnsigned32(record.matchCount),
          encodeSequence(record.changedPaths, encodeString),
        ]),
      ),
    ),
    encodeString(binding.retention.mode),
  ]);
}

function encodeToolContractReference(reference: InteractionToolContractReference): Uint8Array {
  return concatenateBytes([
    encodeString(reference.toolId),
    encodeString(reference.toolVersion),
    encodeString(reference.definitionSha256),
    encodeString(reference.artifactId),
  ]);
}

function encodePromptReference(reference: InteractionPromptReference): Uint8Array {
  return concatenateBytes([
    encodeString(reference.promptId),
    encodeString(reference.promptVersion),
    encodeString(reference.definitionSha256),
    encodeString(reference.artifactId),
  ]);
}

function encodeNormalizedRequest(reference: InteractionNormalizedRequestReference): Uint8Array {
  return concatenateBytes([
    encodeString(reference.adapterName),
    encodeString(reference.adapterVersion),
    encodeString(reference.sha256),
    encodeString(reference.artifactId),
  ]);
}

function encodeAttemptBase(attempt: ModelInteractionAttempt | ToolInteractionAttempt): Uint8Array {
  return concatenateBytes([
    encodeString(attempt.attemptId),
    encodeUnsigned32(attempt.sequence),
    encodeString(attempt.startedAt),
    encodeString(attempt.endedAt),
    encodeString(attempt.outcome),
    encodeOptional(attempt.errorType, encodeString),
  ]);
}

function encodeModelAttempt(attempt: ModelInteractionAttempt): Uint8Array {
  return concatenateBytes([
    encodeAttemptBase(attempt),
    encodeString(attempt.provider.name),
    encodeString(attempt.provider.operation),
    encodeString(attempt.provider.requestedModel),
    encodeOptional(attempt.provider.returnedModel, encodeString),
    encodeString(attempt.provider.endpointProfileId),
    encodeString(attempt.provider.endpointProfileVersion),
    encodeOptional(attempt.providerRequestId, encodeString),
    encodeBoolean(attempt.providerMayHaveProcessed),
    encodeBoolean(attempt.streaming),
    encodeNormalizedRequest(attempt.normalizedRequest),
    encodeString(attempt.artifacts.providerConfigurationArtifactId),
    encodeString(attempt.artifacts.providerRequestArtifactId),
    encodeOptional(attempt.artifacts.providerResponseArtifactId, encodeString),
    encodeString(attempt.artifacts.inputMessagesArtifactId),
    encodeOptional(attempt.artifacts.outputMessagesArtifactId, encodeString),
    encodeOptional(attempt.artifacts.systemInstructionsArtifactId, encodeString),
    encodeOptional(attempt.artifacts.promptVariablesArtifactId, encodeString),
    encodeOptional(attempt.artifacts.streamingFramesArtifactId, encodeString),
  ]);
}

function encodeToolAttempt(attempt: ToolInteractionAttempt): Uint8Array {
  return concatenateBytes([
    encodeAttemptBase(attempt),
    encodeString(attempt.sideEffect),
    encodeBoolean(attempt.effectMayHaveOccurred),
    encodeNormalizedRequest(attempt.normalizedRequest),
    encodeString(attempt.artifacts.argumentsArtifactId),
    encodeOptional(attempt.artifacts.resultArtifactId, encodeString),
  ]);
}

function encodeCaptureManifest(manifest: InteractionCaptureManifest): Uint8Array {
  return concatenateBytes([
    encodeString(manifest.schemaVersion),
    encodeString(manifest.source.boundary),
    encodeString(manifest.source.captureAdapter.name),
    encodeString(manifest.source.captureAdapter.version),
    encodeString(manifest.source.sourceFormat.name),
    encodeString(manifest.source.sourceFormat.version),
    encodeString(manifest.source.completeness.status),
    encodeSequence(manifest.source.completeness.limitations, encodeString),
    encodeSequence(manifest.artifacts, encodeArtifactBinding),
    encodeSequence(manifest.interactions, (interaction) => {
      const common = [
        encodeString(interaction.kind),
        encodeString(interaction.interactionId),
        encodeUnsigned32(interaction.sequence),
        encodeString(interaction.terminalOutcome),
      ];
      if (interaction.kind === "model") {
        return concatenateBytes([
          ...common,
          encodePromptReference(interaction.prompt),
          encodeSequence(interaction.toolContracts, encodeToolContractReference),
          encodeSequence(interaction.attempts, encodeModelAttempt),
        ]);
      }
      return concatenateBytes([
        ...common,
        encodeString(interaction.callId),
        encodeToolContractReference(interaction.tool),
        encodeSequence(interaction.attempts, encodeToolAttempt),
      ]);
    }),
  ]);
}

export function encodeRecordedInteractionFixtureVersionDefinition(
  input: RecordedInteractionFixtureVersionDefinition,
): Uint8Array {
  const definition = RecordedInteractionFixtureVersionDefinitionSchema.parse(input);
  return concatenateBytes([
    encodeString(RECORDED_INTERACTION_FIXTURE_DEFINITION_DOMAIN),
    encodeString(definition.schemaVersion),
    encodeString(definition.scope.tenantId),
    encodeString(definition.scope.projectId),
    encodeString(definition.scope.environmentId),
    encodeString(definition.fixtureId),
    encodeString(definition.fixtureVersionId),
    encodeString(definition.name),
    encodeOptional(definition.description, encodeString),
    encodeString(definition.predecessor.fixtureVersionId),
    encodeString(definition.predecessor.definitionSha256),
    encodeString(definition.source.kind),
    encodeString(definition.source.traceId),
    encodeSequence(definition.source.eventIds, encodeString),
    encodeUnsigned32(definition.source.observedEventCount),
    encodeString(definition.source.sourceCompleteness),
    encodeString(definition.replayability),
    encodeCaptureManifest(definition.interactionCapture),
  ]);
}

export function digestRecordedInteractionFixtureVersionDefinition(
  input: RecordedInteractionFixtureVersionDefinition,
): string {
  return sha256(encodeRecordedInteractionFixtureVersionDefinition(input));
}
