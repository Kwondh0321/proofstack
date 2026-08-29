import { createHash } from "node:crypto";
import {
  type RecordedBoundaryArtifactPayload,
  type RecordedBoundaryAttempt,
  type RecordedBoundaryExpectedRequest,
  type RecordedBoundaryReplayInvocationDefinition,
  RecordedBoundaryReplayInvocationDefinitionSchema,
  type RecordedInteractionFixtureContentExport,
  RecordedInteractionFixtureContentExportSchema,
  type ReplayTargetAdapterReference,
  ReplayTargetAdapterReferenceSchema,
} from "@proofstack/contracts";
import { validateAndProjectRecordedInteractionFixtureVersion } from "@proofstack/datasets";
import { RecordedBoundaryReplayPreflightError } from "./errors.js";
import { digestRecordedBoundaryReplayInvocationDefinition } from "./replay-digest.js";

export interface PreparedRecordedBoundaryAttempt {
  readonly expectedRequest: RecordedBoundaryExpectedRequest;
  readonly recordedAttempt: RecordedBoundaryAttempt;
  readonly returnedArtifacts: readonly RecordedBoundaryArtifactPayload[];
}

export interface PreparedRecordedBoundaryReplay {
  readonly attempts: readonly PreparedRecordedBoundaryAttempt[];
  readonly invocation: RecordedBoundaryReplayInvocationDefinition;
  readonly invocationDefinitionSha256: string;
}

function preflightFailure(
  code: ConstructorParameters<typeof RecordedBoundaryReplayPreflightError>[0],
  cause?: unknown,
): RecordedBoundaryReplayPreflightError {
  return new RecordedBoundaryReplayPreflightError(
    code,
    cause === undefined ? undefined : { cause },
  );
}

function parseInvocation(input: unknown): RecordedBoundaryReplayInvocationDefinition {
  const parsed = RecordedBoundaryReplayInvocationDefinitionSchema.safeParse(input);
  if (!parsed.success) throw preflightFailure("invalid_invocation", parsed.error);
  return parsed.data;
}

function parseTargetReference(input: unknown): ReplayTargetAdapterReference {
  const parsed = ReplayTargetAdapterReferenceSchema.safeParse(input);
  if (!parsed.success) throw preflightFailure("invalid_target_adapter", parsed.error);
  return parsed.data;
}

function parseContentExport(input: unknown): RecordedInteractionFixtureContentExport {
  const parsed = RecordedInteractionFixtureContentExportSchema.safeParse(input);
  if (!parsed.success) throw preflightFailure("invalid_content_export", parsed.error);
  return parsed.data;
}

function verifyRuntimeProfile(invocation: RecordedBoundaryReplayInvocationDefinition): void {
  try {
    const canonicalLocales = Intl.getCanonicalLocales(invocation.runtime.locale);
    const resolved = new Intl.DateTimeFormat(invocation.runtime.locale, {
      timeZone: invocation.runtime.timeZone,
    }).resolvedOptions();
    if (
      canonicalLocales.length !== 1 ||
      canonicalLocales[0] !== invocation.runtime.locale ||
      resolved.locale !== invocation.runtime.locale ||
      resolved.timeZone !== invocation.runtime.timeZone
    ) {
      throw new RangeError("Runtime locale or time zone is not canonical");
    }
  } catch (error) {
    throw preflightFailure("runtime_profile_unsupported", error);
  }
}

function verifyFixtureDefinition(
  contentExport: RecordedInteractionFixtureContentExport,
  invocation: RecordedBoundaryReplayInvocationDefinition,
): void {
  try {
    validateAndProjectRecordedInteractionFixtureVersion(contentExport.version);
  } catch (error) {
    throw preflightFailure("fixture_definition_invalid", error);
  }
  if (
    contentExport.version.fixtureId !== invocation.fixture.fixtureId ||
    contentExport.version.fixtureVersionId !== invocation.fixture.fixtureVersionId ||
    contentExport.version.definitionSha256 !== invocation.fixture.definitionSha256
  ) {
    throw preflightFailure("fixture_identity_mismatch");
  }
}

function verifyTargetAdapter(
  invocation: RecordedBoundaryReplayInvocationDefinition,
  target: ReplayTargetAdapterReference,
): void {
  if (
    invocation.targetAdapter.name !== target.name ||
    invocation.targetAdapter.version !== target.version
  ) {
    throw preflightFailure("target_adapter_mismatch");
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function verifiedArtifactPayloads(
  contentExport: RecordedInteractionFixtureContentExport,
): ReadonlyMap<string, RecordedBoundaryArtifactPayload> {
  if (contentExport.contentAvailability !== "available") {
    throw preflightFailure("fixture_content_unavailable");
  }
  const payloads = new Map<string, RecordedBoundaryArtifactPayload>();
  for (const item of contentExport.artifacts) {
    if (item.content.status !== "available" || item.artifact.lifecycleStatus !== "available") {
      throw preflightFailure("fixture_content_unavailable");
    }
    const bytes = Uint8Array.from(Buffer.from(item.content.bytes, "base64url"));
    const reference = item.artifact.binding.contentReference;
    if (bytes.byteLength !== reference.sizeBytes || sha256(bytes) !== reference.sha256) {
      throw preflightFailure("artifact_content_invalid");
    }
    payloads.set(reference.artifactId, {
      binding: item.artifact.binding,
      bytes: item.content.bytes,
      encoding: "base64url",
    });
  }
  /* v8 ignore next -- The strict content-export contract already enforces one unique item per manifest binding. */
  if (payloads.size !== contentExport.version.interactionCapture.artifacts.length) {
    throw preflightFailure("artifact_content_invalid");
  }
  return payloads;
}

function requirePayload(
  payloads: ReadonlyMap<string, RecordedBoundaryArtifactPayload>,
  artifactId: string,
): RecordedBoundaryArtifactPayload {
  const payload = payloads.get(artifactId);
  /* v8 ignore next -- The interaction manifest rejects references outside its complete artifact binding set. */
  if (!payload) throw preflightFailure("artifact_content_invalid");
  return payload;
}

function prepareAttempts(
  contentExport: RecordedInteractionFixtureContentExport,
  payloads: ReadonlyMap<string, RecordedBoundaryArtifactPayload>,
): readonly PreparedRecordedBoundaryAttempt[] {
  const prepared: PreparedRecordedBoundaryAttempt[] = [];
  for (const interaction of contentExport.version.interactionCapture.interactions) {
    if (interaction.kind === "model") {
      for (const attempt of interaction.attempts) {
        const expectedRequest: RecordedBoundaryExpectedRequest = {
          adapterName: attempt.normalizedRequest.adapterName,
          adapterVersion: attempt.normalizedRequest.adapterVersion,
          attemptId: attempt.attemptId,
          attemptSequence: attempt.sequence,
          interactionId: interaction.interactionId,
          interactionSequence: interaction.sequence,
          kind: "model",
          normalizedRequestSha256: attempt.normalizedRequest.sha256,
        };
        const recordedAttempt: RecordedBoundaryAttempt = {
          attempt,
          interactionId: interaction.interactionId,
          interactionSequence: interaction.sequence,
          kind: "model",
        };
        const returnedArtifacts = [
          attempt.artifacts.outputMessagesArtifactId,
          attempt.artifacts.providerResponseArtifactId,
          attempt.artifacts.streamingFramesArtifactId,
        ]
          .filter((artifactId): artifactId is string => artifactId !== undefined)
          .sort()
          .map((artifactId) => requirePayload(payloads, artifactId));
        prepared.push({ expectedRequest, recordedAttempt, returnedArtifacts });
      }
      continue;
    }
    for (const attempt of interaction.attempts) {
      const expectedRequest: RecordedBoundaryExpectedRequest = {
        adapterName: attempt.normalizedRequest.adapterName,
        adapterVersion: attempt.normalizedRequest.adapterVersion,
        attemptId: attempt.attemptId,
        attemptSequence: attempt.sequence,
        interactionId: interaction.interactionId,
        interactionSequence: interaction.sequence,
        kind: "tool",
        normalizedRequestSha256: attempt.normalizedRequest.sha256,
      };
      const recordedAttempt: RecordedBoundaryAttempt = {
        attempt,
        callId: interaction.callId,
        interactionId: interaction.interactionId,
        interactionSequence: interaction.sequence,
        kind: "tool",
      };
      const returnedArtifacts = [attempt.artifacts.resultArtifactId]
        .filter((artifactId): artifactId is string => artifactId !== undefined)
        .map((artifactId) => requirePayload(payloads, artifactId));
      prepared.push({ expectedRequest, recordedAttempt, returnedArtifacts });
    }
  }
  return prepared;
}

export function prepareRecordedBoundaryReplay(input: {
  readonly contentExport: unknown;
  readonly invocation: unknown;
  readonly targetAdapter: unknown;
}): PreparedRecordedBoundaryReplay {
  const invocation = parseInvocation(input.invocation);
  const targetAdapter = parseTargetReference(input.targetAdapter);
  const contentExport = parseContentExport(input.contentExport);
  verifyTargetAdapter(invocation, targetAdapter);
  verifyRuntimeProfile(invocation);
  verifyFixtureDefinition(contentExport, invocation);
  const payloads = verifiedArtifactPayloads(contentExport);
  const attempts = prepareAttempts(contentExport, payloads);
  return {
    attempts,
    invocation,
    invocationDefinitionSha256: digestRecordedBoundaryReplayInvocationDefinition(invocation),
  };
}
