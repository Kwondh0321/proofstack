import { createHash } from "node:crypto";
import {
  type RecordedBoundaryReplayInvocationDefinition,
  RecordedBoundaryReplayInvocationDefinitionSchema,
  type RecordedBoundaryRequest,
  RecordedBoundaryRequestSchema,
} from "@proofstack/contracts";
import { concatenateBytes, encodeBytes, encodeString } from "./binary-encoding.js";

export const RECORDED_BOUNDARY_REPLAY_INVOCATION_DOMAIN =
  "proofstack.recorded-boundary-replay.v1" as const;
export const RECORDED_BOUNDARY_REQUEST_DOMAIN = "proofstack.recorded-boundary-request.v1" as const;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeBase64Url(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64url"));
}

export function encodeRecordedBoundaryReplayInvocationDefinition(
  input: RecordedBoundaryReplayInvocationDefinition,
): Uint8Array {
  const definition = RecordedBoundaryReplayInvocationDefinitionSchema.parse(input);
  return concatenateBytes([
    encodeString(RECORDED_BOUNDARY_REPLAY_INVOCATION_DOMAIN),
    encodeString(definition.schemaVersion),
    encodeString(definition.invocationId),
    encodeString(definition.fixture.fixtureId),
    encodeString(definition.fixture.fixtureVersionId),
    encodeString(definition.fixture.definitionSha256),
    encodeString(definition.targetAdapter.name),
    encodeString(definition.targetAdapter.version),
    encodeString(definition.runtime.boundaryMode),
    encodeString(definition.runtime.clock.mode),
    encodeString(definition.runtime.clock.instant),
    encodeString(definition.runtime.random.mode),
    encodeString(definition.runtime.random.algorithm),
    encodeString(definition.runtime.random.seedHex),
    encodeString(definition.runtime.locale),
    encodeString(definition.runtime.timeZone),
    encodeString(definition.runtime.network.policy),
    encodeString(definition.runtime.isolation.mode),
  ]);
}

export function digestRecordedBoundaryReplayInvocationDefinition(
  input: RecordedBoundaryReplayInvocationDefinition,
): string {
  return sha256(encodeRecordedBoundaryReplayInvocationDefinition(input));
}

export function encodeRecordedBoundaryRequest(input: RecordedBoundaryRequest): Uint8Array {
  const request = RecordedBoundaryRequestSchema.parse(input);
  return concatenateBytes([
    encodeString(RECORDED_BOUNDARY_REQUEST_DOMAIN),
    encodeString(request.schemaVersion),
    encodeString(request.boundaryRequestId),
    encodeString(request.kind),
    encodeString(request.normalizedRequest.adapterName),
    encodeString(request.normalizedRequest.adapterVersion),
    encodeBytes(decodeBase64Url(request.normalizedRequest.bytes)),
  ]);
}

export function digestRecordedBoundaryRequest(input: RecordedBoundaryRequest): string {
  return sha256(encodeRecordedBoundaryRequest(input));
}

export function digestNormalizedRequestBytes(value: Uint8Array): string {
  return sha256(value);
}
