import { describe, expect, it } from "vitest";
import type { InteractionArtifactBinding, ModelInteractionAttempt } from "./interaction.js";
import {
  RECORDED_BOUNDARY_REPLAY_SCHEMA_VERSION,
  RecordedBoundaryActualRequestMetadataSchema,
  RecordedBoundaryArtifactPayloadSchema,
  RecordedBoundaryReplayInvocationDefinitionSchema,
  RecordedBoundaryReplayObservationSchema,
  RecordedBoundaryReplayResultSchema,
  RecordedBoundaryReplayRuntimeEvidenceSchema,
  RecordedBoundaryRequestSchema,
  RecordedBoundaryResolutionMetadataSchema,
  RecordedBoundaryResponseSchema,
  ReplayBase64UrlBytesSchema,
} from "./replay.js";

const sha = (digit: string): string => digit.repeat(64);

function binding(
  artifactId: string,
  role: InteractionArtifactBinding["role"],
  digestDigit: string,
): InteractionArtifactBinding {
  return {
    contentReference: {
      artifactId,
      classification: "confidential",
      mediaType: "application/json",
      sha256: sha(digestDigit),
      sizeBytes: 2,
    },
    redaction: { status: "not_required" },
    retention: { mode: "retain" },
    role,
  };
}

const modelAttempt: ModelInteractionAttempt = {
  artifacts: {
    inputMessagesArtifactId: "art_input",
    outputMessagesArtifactId: "art_output",
    providerConfigurationArtifactId: "art_config",
    providerRequestArtifactId: "art_request",
    providerResponseArtifactId: "art_response",
  },
  attemptId: "att_model_001",
  endedAt: "2026-08-29T00:00:01.000Z",
  normalizedRequest: {
    adapterName: "proofstack.reference.model",
    adapterVersion: "1.0.0",
    artifactId: "art_normalized",
    sha256: sha("a"),
  },
  outcome: "succeeded",
  provider: {
    endpointProfileId: "end_reference",
    endpointProfileVersion: "1.0.0",
    name: "provider-neutral",
    operation: "chat",
    requestedModel: "reference-model-v1",
    returnedModel: "reference-model-v1",
  },
  providerMayHaveProcessed: true,
  providerRequestId: "request_reference",
  sequence: 0,
  startedAt: "2026-08-29T00:00:00.000Z",
  streaming: false,
};

const actualRequest = {
  adapterName: "proofstack.reference.model",
  adapterVersion: "1.0.0",
  boundaryRequestId: "req_boundary_001",
  kind: "model" as const,
  normalizedRequestSha256: sha("a"),
  sizeBytes: 2,
};

const expectedRequest = {
  adapterName: "proofstack.reference.model",
  adapterVersion: "1.0.0",
  attemptId: "att_model_001",
  attemptSequence: 0,
  interactionId: "int_model_001",
  interactionSequence: 0,
  kind: "model" as const,
  normalizedRequestSha256: sha("a"),
};

const outputBinding = binding("art_output", "model.output_messages", "b");
const responseBinding = binding("art_response", "model.provider_response", "c");

const resolution = {
  actualRequest,
  expectedRequest,
  recordedAttempt: {
    attempt: modelAttempt,
    interactionId: "int_model_001",
    interactionSequence: 0,
    kind: "model" as const,
  },
  returnedArtifacts: [outputBinding, responseBinding],
};

const invocation = {
  fixture: {
    definitionSha256: sha("d"),
    fixtureId: "fix_reference",
    fixtureVersionId: "fiv_reference_001",
  },
  invocationId: "rpi_reference_001",
  runtime: {
    boundaryMode: "recorded_stub" as const,
    clock: { instant: "2026-08-29T00:00:00.000Z", mode: "fixed" as const },
    isolation: { mode: "cooperative_in_process" as const },
    locale: "en-US",
    network: { policy: "deny_fallback" as const },
    random: {
      algorithm: "hmac_sha256_counter_v1" as const,
      mode: "seeded" as const,
      seedHex: sha("e"),
    },
    timeZone: "UTC",
  },
  schemaVersion: RECORDED_BOUNDARY_REPLAY_SCHEMA_VERSION,
  targetAdapter: { name: "proofstack.reference_target", version: "1.0.0" },
};

const baseLimitations = [
  "target_runtime_not_isolated",
  "ambient_filesystem_not_controlled",
  "process_egress_not_enforced",
  "dependency_snapshot_not_verified",
  "runtime_controls_are_cooperative",
] as const;

const completedControls = [
  "artifact_bytes_verified",
  "normalized_requests_matched",
  "recorded_attempt_order_consumed",
  "resolver_has_no_live_fallback",
  "runtime_interfaces_supplied",
] as const;

function completedResult() {
  return {
    consumedAttemptCount: 1,
    expectedAttemptCount: 1,
    invocation,
    invocationDefinitionSha256: sha("f"),
    observations: [{ resolution, sequence: 0, status: "matched" as const }],
    reproducibility: {
      classification: "bounded" as const,
      limitations: [...baseLimitations],
      verifiedControls: [...completedControls],
    },
    runtimeEvidence: {
      fixedClockReadCount: 1,
      randomByteCount: 8,
      randomRequestCount: 1,
    },
    schemaVersion: RECORDED_BOUNDARY_REPLAY_SCHEMA_VERSION,
    status: "completed" as const,
  };
}

function patchedRuntime(patch: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const runtime: Record<string, unknown> = structuredClone(invocation.runtime);
  for (const [key, value] of Object.entries(patch)) {
    const current = runtime[key];
    runtime[key] =
      typeof current === "object" && current !== null && typeof value === "object" && value !== null
        ? { ...(current as Record<string, unknown>), ...(value as Record<string, unknown>) }
        : value;
  }
  return runtime;
}

describe("recorded replay invocation contracts", () => {
  it("accepts only exact immutable lineage and the bounded runtime profile", () => {
    expect(RecordedBoundaryReplayInvocationDefinitionSchema.parse(invocation)).toEqual(invocation);
    expect(
      RecordedBoundaryReplayInvocationDefinitionSchema.safeParse({ ...invocation, latest: true })
        .success,
    ).toBe(false);
    expect(
      RecordedBoundaryReplayInvocationDefinitionSchema.safeParse({
        ...invocation,
        fixture: { ...invocation.fixture, definitionSha256: "not-a-digest" },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["live mode", { boundaryMode: "live_provider" }],
    ["ambient clock", { clock: { mode: "ambient" } }],
    ["invalid instant", { clock: { instant: "2026-08-29", mode: "fixed" } }],
    ["claimed isolation", { isolation: { mode: "sandboxed" } }],
    ["invalid locale", { locale: "en US" }],
    ["network fallback", { network: { policy: "allow" } }],
    ["unknown random algorithm", { random: { algorithm: "math_random" } }],
    ["short seed", { random: { seedHex: "00" } }],
    ["invalid time zone", { timeZone: "../UTC" }],
  ])("rejects %s", (_name, runtimePatch) => {
    const runtime = patchedRuntime(runtimePatch);
    expect(
      RecordedBoundaryReplayInvocationDefinitionSchema.safeParse({ ...invocation, runtime })
        .success,
    ).toBe(false);
  });
});

describe("recorded boundary request contracts", () => {
  const request = {
    boundaryRequestId: "req_boundary_001",
    kind: "model" as const,
    normalizedRequest: {
      adapterName: "proofstack.reference.model",
      adapterVersion: "1.0.0",
      bytes: "e30",
      encoding: "base64url" as const,
    },
    schemaVersion: RECORDED_BOUNDARY_REPLAY_SCHEMA_VERSION,
  };

  it("accepts canonical exact bytes without a caller-supplied digest", () => {
    expect(RecordedBoundaryRequestSchema.parse(request)).toEqual(request);
    expect(ReplayBase64UrlBytesSchema.parse("AA")).toBe("AA");
  });

  it.each(["A", "AB", "A=", "", "+w"])("rejects non-canonical bytes %j", (bytes) => {
    expect(
      RecordedBoundaryRequestSchema.safeParse({
        ...request,
        normalizedRequest: { ...request.normalizedRequest, bytes },
      }).success,
    ).toBe(false);
  });

  it("rejects unsupported kinds, unknown fields, and empty request metadata", () => {
    expect(RecordedBoundaryRequestSchema.safeParse({ ...request, kind: "retrieval" }).success).toBe(
      false,
    );
    expect(
      RecordedBoundaryRequestSchema.safeParse({ ...request, fallback: "network" }).success,
    ).toBe(false);
    expect(
      RecordedBoundaryActualRequestMetadataSchema.safeParse({ ...actualRequest, sizeBytes: 0 })
        .success,
    ).toBe(false);
  });
});

describe("recorded boundary resolution contracts", () => {
  it("binds the actual request to the exact recorded attempt and response artifacts", () => {
    expect(RecordedBoundaryResolutionMetadataSchema.parse(resolution)).toEqual(resolution);
  });

  it.each([
    ["kind", { expectedRequest: { ...expectedRequest, kind: "tool" } }],
    ["interaction", { expectedRequest: { ...expectedRequest, interactionId: "int_other" } }],
    ["attempt", { expectedRequest: { ...expectedRequest, attemptId: "att_other" } }],
    ["adapter", { expectedRequest: { ...expectedRequest, adapterVersion: "2.0.0" } }],
    ["digest", { actualRequest: { ...actualRequest, normalizedRequestSha256: sha("9") } }],
  ])("rejects mismatched %s lineage", (_name, patch) => {
    expect(
      RecordedBoundaryResolutionMetadataSchema.safeParse({ ...resolution, ...patch }).success,
    ).toBe(false);
  });

  it("rejects duplicate, unordered, wrong-role, missing, and extra response artifacts", () => {
    const candidates = [
      [outputBinding, outputBinding],
      [responseBinding, outputBinding],
      [binding("art_prompt", "prompt.template", "7"), responseBinding],
      [outputBinding],
      [outputBinding, responseBinding, binding("art_stream", "model.streaming_frames", "8")],
    ];
    for (const returnedArtifacts of candidates) {
      expect(
        RecordedBoundaryResolutionMetadataSchema.safeParse({ ...resolution, returnedArtifacts })
          .success,
      ).toBe(false);
    }
  });

  it("requires exact response payload coverage, bindings, and byte sizes", () => {
    const response = {
      artifacts: [outputBinding, responseBinding].map((item) => ({
        binding: item,
        bytes: "e30",
        encoding: "base64url" as const,
      })),
      resolution,
      schemaVersion: RECORDED_BOUNDARY_REPLAY_SCHEMA_VERSION,
    };
    expect(RecordedBoundaryResponseSchema.parse(response)).toEqual(response);
    expect(
      RecordedBoundaryResponseSchema.safeParse({
        ...response,
        artifacts: response.artifacts.slice(1),
      }).success,
    ).toBe(false);
    expect(
      RecordedBoundaryResponseSchema.safeParse({
        ...response,
        artifacts: [{ ...response.artifacts[0], binding: responseBinding }, response.artifacts[1]],
      }).success,
    ).toBe(false);
    expect(
      RecordedBoundaryArtifactPayloadSchema.safeParse({
        ...response.artifacts[0],
        bytes: "AA",
      }).success,
    ).toBe(false);
  });

  it("supports exact failed tool observations without inventing a result artifact", () => {
    const toolResolution = {
      actualRequest: {
        ...actualRequest,
        adapterName: "proofstack.reference.tool",
        boundaryRequestId: "req_tool_001",
        kind: "tool" as const,
      },
      expectedRequest: {
        ...expectedRequest,
        adapterName: "proofstack.reference.tool",
        attemptId: "att_tool_001",
        interactionId: "int_tool_001",
        interactionSequence: 1,
        kind: "tool" as const,
      },
      recordedAttempt: {
        attempt: {
          artifacts: { argumentsArtifactId: "art_arguments" },
          attemptId: "att_tool_001",
          effectMayHaveOccurred: false,
          endedAt: "2026-08-29T00:00:02.000Z",
          errorType: "warehouse_unavailable",
          normalizedRequest: {
            adapterName: "proofstack.reference.tool",
            adapterVersion: "1.0.0",
            artifactId: "art_tool_normalized",
            sha256: sha("a"),
          },
          outcome: "failed",
          sequence: 0,
          sideEffect: "read_only",
          startedAt: "2026-08-29T00:00:01.000Z",
        },
        callId: "call_reference",
        interactionId: "int_tool_001",
        interactionSequence: 1,
        kind: "tool" as const,
      },
      returnedArtifacts: [],
    };
    expect(RecordedBoundaryResolutionMetadataSchema.parse(toolResolution)).toEqual(toolResolution);
  });
});

describe("recorded replay result contracts", () => {
  it("accepts a completely consumed bounded result and rejects unknown fields", () => {
    const result = completedResult();
    expect(RecordedBoundaryReplayResultSchema.parse(result)).toEqual(result);
    expect(
      RecordedBoundaryReplayResultSchema.safeParse({ ...result, verdict: "pass" }).success,
    ).toBe(false);
  });

  it("requires completed results to preserve counts, matched observations, controls, and limits", () => {
    const result = completedResult();
    const invalid = [
      { ...result, consumedAttemptCount: 0 },
      { ...result, expectedAttemptCount: 2 },
      {
        ...result,
        reproducibility: { ...result.reproducibility, classification: "unknown" },
      },
      {
        ...result,
        reproducibility: {
          ...result.reproducibility,
          verifiedControls: completedControls.slice(0, -1),
        },
      },
      {
        ...result,
        reproducibility: {
          ...result.reproducibility,
          limitations: [...baseLimitations, "target_adapter_failed"],
        },
      },
      {
        ...result,
        reproducibility: {
          ...result.reproducibility,
          limitations: baseLimitations.slice(1),
        },
      },
    ];
    for (const candidate of invalid) {
      expect(RecordedBoundaryReplayResultSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("accepts a terminal mismatch only with a matching limitation and last observation", () => {
    const result = completedResult();
    const mismatchObservation = {
      actualRequest: { ...actualRequest, normalizedRequestSha256: sha("9") },
      code: "normalized_request_digest_mismatch" as const,
      expectedRequest,
      sequence: 0,
      status: "mismatch" as const,
    };
    const mismatch = {
      ...result,
      consumedAttemptCount: 0,
      observations: [mismatchObservation],
      reproducibility: {
        classification: "unknown" as const,
        limitations: [...baseLimitations, "boundary_request_mismatch" as const],
        verifiedControls: [
          "artifact_bytes_verified" as const,
          "resolver_has_no_live_fallback" as const,
        ],
      },
      runtimeEvidence: { fixedClockReadCount: 0, randomByteCount: 0, randomRequestCount: 0 },
      status: "mismatch" as const,
    };
    expect(RecordedBoundaryReplayResultSchema.parse(mismatch)).toEqual(mismatch);
    expect(
      RecordedBoundaryReplayObservationSchema.safeParse({
        ...mismatchObservation,
        code: "extra_boundary_request",
      }).success,
    ).toBe(false);
    expect(
      RecordedBoundaryReplayObservationSchema.safeParse({
        ...mismatchObservation,
        code: "extra_boundary_request",
        expectedRequest: null,
      }).success,
    ).toBe(true);
    expect(
      RecordedBoundaryReplayResultSchema.safeParse({
        ...mismatch,
        observations: [],
      }).success,
    ).toBe(false);
  });

  it.each([
    ["incomplete", "recorded_attempts_unconsumed"],
    ["target_failed", "target_adapter_failed"],
  ] as const)(
    "accepts %s only with unknown reproducibility and its terminal limitation",
    (status, limitation) => {
      const result = completedResult();
      const candidate = {
        ...result,
        consumedAttemptCount: 0,
        observations: [],
        reproducibility: {
          classification: "unknown" as const,
          limitations: [...baseLimitations, limitation],
          verifiedControls: [
            "artifact_bytes_verified" as const,
            "resolver_has_no_live_fallback" as const,
          ],
        },
        runtimeEvidence: { fixedClockReadCount: 0, randomByteCount: 0, randomRequestCount: 0 },
        status,
      };
      expect(RecordedBoundaryReplayResultSchema.parse(candidate)).toEqual(candidate);
      expect(
        RecordedBoundaryReplayResultSchema.safeParse({
          ...candidate,
          reproducibility: { ...candidate.reproducibility, classification: "bounded" },
        }).success,
      ).toBe(false);
    },
  );

  it("rejects invalid observation order, duplicate request IDs, impossible counts, and mixed status", () => {
    const result = completedResult();
    const second = {
      ...result.observations[0],
      sequence: 2,
    };
    const cases = [
      { ...result, observations: [second] },
      { ...result, expectedAttemptCount: 1, consumedAttemptCount: 2 },
      {
        ...result,
        expectedAttemptCount: 2,
        consumedAttemptCount: 2,
        observations: [result.observations[0], { ...result.observations[0], sequence: 1 }],
      },
      {
        ...result,
        status: "incomplete",
        reproducibility: {
          classification: "unknown",
          limitations: [...baseLimitations, "recorded_attempts_unconsumed"],
          verifiedControls: [],
        },
      },
    ];
    for (const candidate of cases) {
      expect(RecordedBoundaryReplayResultSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("enforces canonical reason order and consistent runtime evidence", () => {
    const result = completedResult();
    expect(
      RecordedBoundaryReplayResultSchema.safeParse({
        ...result,
        reproducibility: {
          ...result.reproducibility,
          verifiedControls: [...completedControls].reverse(),
        },
      }).success,
    ).toBe(false);
    expect(
      RecordedBoundaryReplayResultSchema.safeParse({
        ...result,
        reproducibility: {
          ...result.reproducibility,
          limitations: [...baseLimitations].reverse(),
        },
      }).success,
    ).toBe(false);
    expect(
      RecordedBoundaryReplayRuntimeEvidenceSchema.safeParse({
        fixedClockReadCount: 0,
        randomByteCount: 1,
        randomRequestCount: 0,
      }).success,
    ).toBe(false);
    expect(
      RecordedBoundaryReplayRuntimeEvidenceSchema.safeParse({
        fixedClockReadCount: 0,
        randomByteCount: 1,
        randomRequestCount: 2,
      }).success,
    ).toBe(false);
  });
});
