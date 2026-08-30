import { createHash } from "node:crypto";
import { digestRecordedBoundaryReplayInvocationDefinition } from "@proofstack/replay";
import { describe, expect, it } from "vitest";
import { ReplayRecordedStubBoundaryError } from "./errors.js";
import {
  executeRecordedStubBoundary,
  type ReplayRecordedBoundaryResolverInvocation,
  type ReplayRecordedBoundaryResolverPort,
} from "./recorded-stub-boundary.js";

const sha = (digit: string): string => digit.repeat(64);
const resultBytes = Buffer.from('{"ok":true}', "utf8");
const resultSha256 = createHash("sha256").update(resultBytes).digest("hex");
const normalizedBytes = Buffer.from("{}", "utf8").toString("base64url");
const normalizedSha256 = createHash("sha256")
  .update(Buffer.from(normalizedBytes, "base64url"))
  .digest("hex");
const adapter = { name: "proofstack.tool", version: "1.0.0" } as const;

function invocation() {
  return {
    fixture: {
      definitionSha256: sha("1"),
      fixtureId: "fix_recorded",
      fixtureVersionId: "fiv_recorded_001",
    },
    invocationId: "rpi_recorded_001",
    runtime: {
      boundaryMode: "recorded_stub" as const,
      clock: { instant: "2026-08-31T00:00:00.000Z", mode: "fixed" as const },
      isolation: { mode: "cooperative_in_process" as const },
      locale: "en-US",
      network: { policy: "deny_fallback" as const },
      random: {
        algorithm: "hmac_sha256_counter_v1" as const,
        mode: "seeded" as const,
        seedHex: sha("2"),
      },
      timeZone: "UTC",
    },
    schemaVersion: "0.1" as const,
    targetAdapter: { name: "proofstack.target", version: "2.0.0" },
  };
}

function declaration() {
  const definition = invocation();
  return {
    boundaryId: "bnd_recorded",
    invocation: definition,
    invocationDefinitionSha256: digestRecordedBoundaryReplayInvocationDefinition(definition),
    kind: "tool" as const,
    mode: "recorded_stub" as const,
  };
}

function request(kind: "model" | "tool" = "tool") {
  return {
    boundaryRequestId: "request_recorded_001",
    kind,
    normalizedRequest: { adapter, bytes: normalizedBytes, encoding: "base64url" as const },
    schemaVersion: "0.1" as const,
  };
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    contentReference: {
      artifactId: "art_tool_result",
      classification: "confidential" as const,
      mediaType: "application/json",
      sha256: resultSha256,
      sizeBytes: resultBytes.byteLength,
      ...overrides,
    },
    redaction: { status: "not_required" as const },
    retention: { mode: "retain" as const },
    role: "tool.result" as const,
  };
}

function response(options: { readonly bindingOverrides?: Record<string, unknown> } = {}) {
  const resultBinding = binding(options.bindingOverrides);
  const actualRequest = {
    adapterName: adapter.name,
    adapterVersion: adapter.version,
    boundaryRequestId: "request_recorded_001",
    kind: "tool" as const,
    normalizedRequestSha256: normalizedSha256,
    sizeBytes: 2,
  };
  const expectedRequest = {
    adapterName: adapter.name,
    adapterVersion: adapter.version,
    attemptId: "att_recorded_001",
    attemptSequence: 0,
    interactionId: "int_recorded_001",
    interactionSequence: 0,
    kind: "tool" as const,
    normalizedRequestSha256: normalizedSha256,
  };
  return {
    artifacts: [
      {
        binding: resultBinding,
        bytes: resultBytes.toString("base64url"),
        encoding: "base64url" as const,
      },
    ],
    resolution: {
      actualRequest,
      expectedRequest,
      recordedAttempt: {
        attempt: {
          artifacts: {
            argumentsArtifactId: "art_tool_arguments",
            resultArtifactId: "art_tool_result",
          },
          attemptId: "att_recorded_001",
          effectMayHaveOccurred: false,
          endedAt: "2026-08-31T00:00:01.000Z",
          normalizedRequest: {
            adapterName: adapter.name,
            adapterVersion: adapter.version,
            artifactId: "art_normalized_request",
            sha256: normalizedSha256,
          },
          outcome: "succeeded" as const,
          sequence: 0,
          sideEffect: "read_only" as const,
          startedAt: "2026-08-31T00:00:00.000Z",
        },
        callId: "call_recorded_001",
        interactionId: "int_recorded_001",
        interactionSequence: 0,
        kind: "tool" as const,
      },
      returnedArtifacts: [resultBinding],
    },
    schemaVersion: "0.1" as const,
  };
}

function failedModelResponse() {
  const actualRequest = {
    adapterName: adapter.name,
    adapterVersion: adapter.version,
    boundaryRequestId: "request_recorded_001",
    kind: "model" as const,
    normalizedRequestSha256: normalizedSha256,
    sizeBytes: 2,
  };
  const expectedRequest = {
    adapterName: adapter.name,
    adapterVersion: adapter.version,
    attemptId: "att_recorded_001",
    attemptSequence: 0,
    interactionId: "int_recorded_001",
    interactionSequence: 0,
    kind: "model" as const,
    normalizedRequestSha256: normalizedSha256,
  };
  return {
    artifacts: [],
    resolution: {
      actualRequest,
      expectedRequest,
      recordedAttempt: {
        attempt: {
          artifacts: {
            inputMessagesArtifactId: "art_model_input",
            providerConfigurationArtifactId: "art_model_configuration",
            providerRequestArtifactId: "art_model_request",
          },
          attemptId: expectedRequest.attemptId,
          endedAt: "2026-08-31T00:00:01.000Z",
          errorType: "recorded_provider_failure",
          normalizedRequest: {
            adapterName: adapter.name,
            adapterVersion: adapter.version,
            artifactId: "art_normalized_request",
            sha256: normalizedSha256,
          },
          outcome: "failed" as const,
          provider: {
            endpointProfileId: "end_recorded",
            endpointProfileVersion: "1.0.0",
            name: "provider-neutral",
            operation: "chat" as const,
            requestedModel: "reference-model",
            returnedModel: "reference-model",
          },
          providerMayHaveProcessed: false,
          sequence: 0,
          startedAt: "2026-08-31T00:00:00.000Z",
          streaming: false,
        },
        interactionId: expectedRequest.interactionId,
        interactionSequence: expectedRequest.interactionSequence,
        kind: "model" as const,
      },
      returnedArtifacts: [],
    },
    schemaVersion: "0.1" as const,
  };
}

function resolver(
  resolve: (input: ReplayRecordedBoundaryResolverInvocation) => Promise<unknown> = async () =>
    response(),
): ReplayRecordedBoundaryResolverPort {
  return { resolve };
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    declaration: declaration(),
    request: request(),
    resolver: resolver(),
    ...overrides,
  };
}

async function expectCode(overrides: Record<string, unknown>, code: string) {
  await expect(executeRecordedStubBoundary(options(overrides))).rejects.toMatchObject({
    code,
    name: "ReplayRecordedStubBoundaryError",
  });
}

describe("executeRecordedStubBoundary", () => {
  it("adapts an exact recorded response and independently verifies artifact content", async () => {
    let received: ReplayRecordedBoundaryResolverInvocation | undefined;
    const result = await executeRecordedStubBoundary(
      options({
        resolver: resolver(async (input) => {
          received = input;
          return response();
        }),
      }),
    );
    expect(received).toMatchObject({
      declaration: declaration(),
      request: {
        boundaryRequestId: request().boundaryRequestId,
        kind: "tool",
        normalizedRequest: {
          adapterName: adapter.name,
          adapterVersion: adapter.version,
          bytes: normalizedBytes,
        },
      },
    });
    expect(result).toMatchObject({
      actualRequest: {
        adapter,
        normalizedRequestSha256: normalizedSha256,
        sizeBytes: 2,
      },
      boundaryId: declaration().boundaryId,
      effectCertainty: "none",
      executionOrigin: "recorded",
      mode: "recorded_stub",
      output: { kind: "recorded_artifacts", response: response() },
      usage: [
        {
          dimension: "toolCalls",
          usage: { amount: 1, source: "measured", status: "observed" },
        },
      ],
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("emits measured model request usage for a valid model declaration", async () => {
    const modelDeclaration = { ...declaration(), kind: "model" as const };
    await expect(
      executeRecordedStubBoundary(
        options({
          declaration: modelDeclaration,
          request: request("model"),
          resolver: resolver(async () => failedModelResponse()),
        }),
      ),
    ).resolves.toMatchObject({
      output: { kind: "recorded_artifacts", response: failedModelResponse() },
      usage: [
        {
          dimension: "modelRequests",
          usage: { amount: 1, source: "measured", status: "observed" },
        },
      ],
    });
  });

  it("rejects invalid declarations, invocation digests, requests, and kind mismatches", async () => {
    await expectCode(
      { declaration: { ...declaration(), fallback: "live" } },
      "invalid_declaration",
    );
    await expectCode(
      { declaration: { ...declaration(), invocationDefinitionSha256: sha("f") } },
      "invocation_digest_mismatch",
    );
    await expectCode({ request: { ...request(), retry: true } }, "invalid_request");
    await expectCode({ request: request("model") }, "request_kind_mismatch");
  });

  it("honors cancellation before resolution and after a late recorded response", async () => {
    const before = new AbortController();
    before.abort("shutdown");
    let calls = 0;
    await expectCode(
      {
        resolver: resolver(async () => {
          calls += 1;
          return response();
        }),
        signal: before.signal,
      },
      "cancelled",
    );
    expect(calls).toBe(0);

    const during = new AbortController();
    await expectCode(
      {
        resolver: resolver(async () => {
          during.abort("shutdown");
          return response();
        }),
        signal: during.signal,
      },
      "cancelled",
    );
  });

  it("rejects malformed responses and actual-request identity changes", async () => {
    await expectCode(
      { resolver: resolver(async () => ({ ...response(), extra: true })) },
      "invalid_response",
    );
    await expectCode(
      {
        resolver: resolver(async () => ({
          ...response(),
          resolution: {
            ...response().resolution,
            actualRequest: { ...response().resolution.actualRequest, boundaryRequestId: "other" },
          },
        })),
      },
      "response_mismatch",
    );
  });

  it("rejects payload bytes that do not match the immutable artifact digest", async () => {
    await expectCode(
      {
        resolver: resolver(async () => response({ bindingOverrides: { sha256: sha("f") } })),
      },
      "artifact_digest_mismatch",
    );
  });

  it("preserves resolver failures for the caller's typed retry classification", async () => {
    const failure = new Error("fixture unavailable");
    await expect(
      executeRecordedStubBoundary(
        options({
          resolver: resolver(async () => {
            throw failure;
          }),
        }),
      ),
    ).rejects.toBe(failure);
  });

  it("exposes a cause-free typed adapter error", () => {
    const error = new ReplayRecordedStubBoundaryError("response_mismatch");
    expect(error).toMatchObject({
      code: "response_mismatch",
      message: "Replay recorded-stub boundary failed: response_mismatch",
    });
    expect(error).not.toHaveProperty("cause");
  });
});
