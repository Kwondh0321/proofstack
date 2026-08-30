import { createHash } from "node:crypto";
import {
  type RecordedBoundaryRequest,
  type RecordedBoundaryResponse,
  RecordedBoundaryResponseSchema,
  type ReplayBoundaryDeclaration,
  ReplayBoundaryDeclarationSchema,
  type ReplayBoundaryExecutionRequest,
  ReplayBoundaryExecutionRequestSchema,
  type ReplayBoundaryExecutionResult,
  ReplayBoundaryExecutionResultSchema,
} from "@proofstack/contracts";
import { digestRecordedBoundaryReplayInvocationDefinition } from "@proofstack/replay";
import { ReplayRecordedStubBoundaryError } from "./errors.js";

type RecordedDeclaration = Extract<ReplayBoundaryDeclaration, { readonly mode: "recorded_stub" }>;

export interface ReplayRecordedBoundaryResolverInvocation {
  readonly declaration: RecordedDeclaration;
  readonly request: RecordedBoundaryRequest;
  readonly signal: AbortSignal;
}

export interface ReplayRecordedBoundaryResolverPort {
  resolve(input: ReplayRecordedBoundaryResolverInvocation): Promise<unknown>;
}

export interface ExecuteRecordedStubBoundaryOptions {
  readonly declaration: unknown;
  readonly request: unknown;
  readonly resolver: ReplayRecordedBoundaryResolverPort;
  readonly signal?: AbortSignal;
}

function fail(code: ConstructorParameters<typeof ReplayRecordedStubBoundaryError>[0]): never {
  throw new ReplayRecordedStubBoundaryError(code);
}

function parseDeclaration(input: unknown): RecordedDeclaration {
  const parsed = ReplayBoundaryDeclarationSchema.safeParse(input);
  if (!parsed.success || parsed.data.mode !== "recorded_stub") fail("invalid_declaration");
  if (
    digestRecordedBoundaryReplayInvocationDefinition(parsed.data.invocation) !==
    parsed.data.invocationDefinitionSha256
  ) {
    fail("invocation_digest_mismatch");
  }
  return parsed.data;
}

function parseRequest(input: unknown): ReplayBoundaryExecutionRequest {
  const parsed = ReplayBoundaryExecutionRequestSchema.safeParse(input);
  if (!parsed.success) fail("invalid_request");
  return parsed.data;
}

function recordedRequest(request: ReplayBoundaryExecutionRequest): RecordedBoundaryRequest {
  return {
    boundaryRequestId: request.boundaryRequestId,
    kind: request.kind as "model" | "tool",
    normalizedRequest: {
      adapterName: request.normalizedRequest.adapter.name,
      adapterVersion: request.normalizedRequest.adapter.version,
      bytes: request.normalizedRequest.bytes,
      encoding: "base64url",
    },
    schemaVersion: "0.1",
  };
}

function actualRequest(request: ReplayBoundaryExecutionRequest) {
  const bytes = Buffer.from(request.normalizedRequest.bytes, "base64url");
  return {
    adapter: request.normalizedRequest.adapter,
    boundaryRequestId: request.boundaryRequestId,
    kind: request.kind,
    normalizedRequestSha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

function recordedActualRequest(request: ReplayBoundaryExecutionRequest) {
  const actual = actualRequest(request);
  return {
    adapterName: actual.adapter.name,
    adapterVersion: actual.adapter.version,
    boundaryRequestId: actual.boundaryRequestId,
    kind: actual.kind,
    normalizedRequestSha256: actual.normalizedRequestSha256,
    sizeBytes: actual.sizeBytes,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseResponse(
  input: unknown,
  request: ReplayBoundaryExecutionRequest,
): RecordedBoundaryResponse {
  const parsed = RecordedBoundaryResponseSchema.safeParse(input);
  if (!parsed.success) fail("invalid_response");
  if (!sameJson(parsed.data.resolution.actualRequest, recordedActualRequest(request))) {
    fail("response_mismatch");
  }
  for (const artifact of parsed.data.artifacts) {
    const digest = createHash("sha256")
      .update(Buffer.from(artifact.bytes, "base64url"))
      .digest("hex");
    if (digest !== artifact.binding.contentReference.sha256) fail("artifact_digest_mismatch");
  }
  return parsed.data;
}

/** Adapts one fail-closed recorded resolver into the common boundary execution result. */
export async function executeRecordedStubBoundary(
  options: ExecuteRecordedStubBoundaryOptions,
): Promise<ReplayBoundaryExecutionResult> {
  const declaration = parseDeclaration(options.declaration);
  const request = parseRequest(options.request);
  if (request.kind !== declaration.kind) fail("request_kind_mismatch");
  const signal = options.signal ?? new AbortController().signal;
  if (signal.aborted) fail("cancelled");
  const candidate = await options.resolver.resolve({
    declaration,
    request: recordedRequest(request),
    signal,
  });
  if (signal.aborted) fail("cancelled");
  const response = parseResponse(candidate, request);
  return Object.freeze(
    ReplayBoundaryExecutionResultSchema.parse({
      actualRequest: actualRequest(request),
      boundaryId: declaration.boundaryId,
      declaration,
      effectCertainty: "none",
      executionOrigin: "recorded",
      mode: "recorded_stub",
      output: { kind: "recorded_artifacts", response },
      schemaVersion: "0.1",
      usage: [
        {
          dimension: request.kind === "model" ? "modelRequests" : "toolCalls",
          usage: { amount: 1, source: "measured", status: "observed" },
        },
      ],
    }),
  );
}
