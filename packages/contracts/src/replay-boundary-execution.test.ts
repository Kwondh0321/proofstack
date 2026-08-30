import { describe, expect, it } from "vitest";
import { RECORDED_BOUNDARY_REPLAY_SCHEMA_VERSION } from "./replay.js";
import {
  REPLAY_BOUNDARY_EXECUTION_SCHEMA_VERSION,
  ReplayBoundaryExecutionRequestSchema,
  ReplayBoundaryExecutionResultSchema,
  ReplayBoundaryExecutionUsageSchema,
} from "./replay-boundary-execution.js";

const sha = (digit: string): string => digit.repeat(64);
const adapter = { name: "proofstack.reference", version: "1.0.0" };
const targetAdapter = { ...adapter, protocolVersion: "1.0.0" };
const workerProtocol = { name: "proofstack.replay-worker", version: "2.0.0" };

function targetReleaseReference() {
  return {
    definitionSha256: sha("1"),
    targetAdapter,
    targetId: "target_reference",
    targetReleaseId: "trg_reference_001",
    workerProtocol,
  };
}

function qualification() {
  return {
    artifactId: "art_simulator_qualification",
    classification: "internal" as const,
    mediaType: "application/json",
    sha256: sha("2"),
    sizeBytes: 128,
  };
}

function simulationDeclaration() {
  return {
    boundaryId: "bnd_simulation",
    configurationSha256: sha("3"),
    kind: "model" as const,
    mode: "simulation" as const,
    qualification: qualification(),
    seedHex: sha("4"),
    simulatorRelease: targetReleaseReference(),
  };
}

function liveDeclaration(
  sideEffect:
    | { readonly kind: "read_only" }
    | {
        readonly idempotencyKeyScheme: string;
        readonly kind: "idempotent_write";
        readonly sandboxDestination: true;
      }
    | {
        readonly automaticRetry: false;
        readonly kind: "non_idempotent_write";
        readonly riskAcceptance: ReturnType<typeof qualification>;
      } = { kind: "read_only" },
  usageSource: "estimated" | "measured" | "provider_reported" | "unavailable" = "provider_reported",
) {
  return {
    boundaryId: "bnd_live",
    credential: {
      credentialId: "cred_reference",
      credentialVersionId: "crv_reference_001",
    },
    destination: { hostname: "api.example.com", port: 443 as const, scheme: "https" as const },
    endpointProfile: {
      definitionSha256: sha("5"),
      endpointProfileId: "end_reference",
      endpointProfileVersion: "1.0.0",
    },
    kind: "model" as const,
    mode: "live_provider" as const,
    operation: "chat",
    requestLimits: { requestBytes: 4_096, responseBytes: 65_536 },
    sideEffect,
    usageSource,
  };
}

function recordedDeclaration() {
  return {
    boundaryId: "bnd_recorded",
    invocation: {
      fixture: {
        definitionSha256: sha("6"),
        fixtureId: "fix_reference",
        fixtureVersionId: "fiv_reference_001",
      },
      invocationId: "rpi_reference_001",
      runtime: {
        boundaryMode: "recorded_stub" as const,
        clock: { instant: "2026-08-30T00:00:00.000Z", mode: "fixed" as const },
        isolation: { mode: "cooperative_in_process" as const },
        locale: "en-US",
        network: { policy: "deny_fallback" as const },
        random: {
          algorithm: "hmac_sha256_counter_v1" as const,
          mode: "seeded" as const,
          seedHex: sha("7"),
        },
        timeZone: "UTC",
      },
      schemaVersion: RECORDED_BOUNDARY_REPLAY_SCHEMA_VERSION,
      targetAdapter: adapter,
    },
    invocationDefinitionSha256: sha("8"),
    kind: "model" as const,
    mode: "recorded_stub" as const,
  };
}

function actualRequest(kind: "data" | "model" | "retrieval" | "tool" = "model") {
  return {
    adapter,
    boundaryRequestId: "req_boundary_001",
    kind,
    normalizedRequestSha256: sha("9"),
    sizeBytes: 2,
  };
}

function normalizedOutput() {
  return {
    kind: "normalized_response" as const,
    response: {
      adapter,
      bytes: "e30",
      encoding: "base64url" as const,
      normalizedResponseSha256: sha("a"),
      sizeBytes: 2,
    },
  };
}

function baseResult() {
  return {
    actualRequest: actualRequest(),
    boundaryId: "bnd_simulation",
    declaration: simulationDeclaration(),
    effectCertainty: "none" as const,
    executionOrigin: "simulated" as const,
    mode: "simulation" as const,
    output: normalizedOutput(),
    schemaVersion: REPLAY_BOUNDARY_EXECUTION_SCHEMA_VERSION,
    usage: [
      {
        dimension: "modelRequests" as const,
        usage: { amount: 1, source: "measured" as const, status: "observed" as const },
      },
    ],
  };
}

function recordedResponse() {
  const request = {
    adapterName: adapter.name,
    adapterVersion: adapter.version,
    boundaryRequestId: "req_boundary_001",
    kind: "model" as const,
    normalizedRequestSha256: sha("9"),
    sizeBytes: 2,
  };
  const expected = {
    adapterName: adapter.name,
    adapterVersion: adapter.version,
    attemptId: "att_recorded_001",
    attemptSequence: 0,
    interactionId: "int_recorded_001",
    interactionSequence: 0,
    kind: "model" as const,
    normalizedRequestSha256: sha("9"),
  };
  const binding = {
    contentReference: {
      artifactId: "art_recorded_response",
      classification: "confidential" as const,
      mediaType: "application/json",
      sha256: sha("b"),
      sizeBytes: 2,
    },
    redaction: { status: "not_required" as const },
    retention: { mode: "retain" as const },
    role: "model.provider_response" as const,
  };
  const outputBinding = {
    ...binding,
    contentReference: {
      ...binding.contentReference,
      artifactId: "art_recorded_output",
      sha256: sha("c"),
    },
    role: "model.output_messages" as const,
  };
  return {
    artifacts: [outputBinding, binding].map((item) => ({
      binding: item,
      bytes: "e30",
      encoding: "base64url" as const,
    })),
    resolution: {
      actualRequest: request,
      expectedRequest: expected,
      recordedAttempt: {
        attempt: {
          artifacts: {
            inputMessagesArtifactId: "art_input",
            outputMessagesArtifactId: outputBinding.contentReference.artifactId,
            providerConfigurationArtifactId: "art_configuration",
            providerRequestArtifactId: "art_request",
            providerResponseArtifactId: binding.contentReference.artifactId,
          },
          attemptId: expected.attemptId,
          endedAt: "2026-08-30T00:00:01.000Z",
          normalizedRequest: {
            adapterName: adapter.name,
            adapterVersion: adapter.version,
            artifactId: "art_normalized_request",
            sha256: sha("9"),
          },
          outcome: "succeeded" as const,
          provider: {
            endpointProfileId: "end_recorded",
            endpointProfileVersion: "1.0.0",
            name: "provider-neutral",
            operation: "chat",
            requestedModel: "reference-model",
            returnedModel: "reference-model",
          },
          providerMayHaveProcessed: true,
          providerRequestId: "request_recorded",
          sequence: 0,
          startedAt: "2026-08-30T00:00:00.000Z",
          streaming: false,
        },
        interactionId: expected.interactionId,
        interactionSequence: expected.interactionSequence,
        kind: "model" as const,
      },
      returnedArtifacts: [outputBinding, binding],
    },
    schemaVersion: RECORDED_BOUNDARY_REPLAY_SCHEMA_VERSION,
  };
}

describe("replay boundary execution request contract", () => {
  it.each(["data", "model", "retrieval", "tool"] as const)(
    "accepts a strict normalized %s request",
    (kind) => {
      const request = {
        boundaryRequestId: `req_${kind}`,
        kind,
        normalizedRequest: { adapter, bytes: "e30", encoding: "base64url" as const },
        schemaVersion: REPLAY_BOUNDARY_EXECUTION_SCHEMA_VERSION,
      };
      expect(ReplayBoundaryExecutionRequestSchema.parse(request)).toEqual(request);
      expect(
        ReplayBoundaryExecutionRequestSchema.safeParse({ ...request, fallback: "network" }).success,
      ).toBe(false);
    },
  );
});

describe("replay boundary execution result contract", () => {
  it("preserves an exact simulation declaration and simulated origin", () => {
    const result = baseResult();
    expect(ReplayBoundaryExecutionResultSchema.parse(result)).toEqual(result);
  });

  it("preserves recorded artifact lineage only for a recorded declaration", () => {
    const result = {
      ...baseResult(),
      boundaryId: "bnd_recorded",
      declaration: recordedDeclaration(),
      executionOrigin: "recorded" as const,
      mode: "recorded_stub" as const,
      output: { kind: "recorded_artifacts" as const, response: recordedResponse() },
    };
    expect(ReplayBoundaryExecutionResultSchema.parse(result)).toEqual(result);
  });

  it("accepts read-only, idempotent, and contract-valid non-idempotent live evidence", () => {
    const read = {
      ...baseResult(),
      boundaryId: "bnd_live",
      declaration: liveDeclaration(),
      executionOrigin: "live" as const,
      mode: "live_provider" as const,
      usage: [
        {
          dimension: "modelRequests" as const,
          usage: {
            amount: 1,
            source: "provider_reported" as const,
            status: "observed" as const,
          },
        },
      ],
    };
    const idempotent = {
      ...read,
      declaration: liveDeclaration({
        idempotencyKeyScheme: "proofstack.boundary.v1",
        kind: "idempotent_write",
        sandboxDestination: true,
      }),
      effectCertainty: "confirmed" as const,
      effectRetrySafety: {
        evidenceSha256: sha("c"),
        idempotencyKeySha256: sha("d"),
        kind: "destination_idempotency_verified" as const,
      },
    };
    const nonIdempotent = {
      ...read,
      declaration: liveDeclaration({
        automaticRetry: false,
        kind: "non_idempotent_write",
        riskAcceptance: qualification(),
      }),
      effectCertainty: "confirmed" as const,
      effectRetrySafety: { kind: "not_retryable" as const },
    };
    expect(ReplayBoundaryExecutionResultSchema.safeParse(read).success).toBe(true);
    expect(ReplayBoundaryExecutionResultSchema.safeParse(idempotent).success).toBe(true);
    expect(ReplayBoundaryExecutionResultSchema.safeParse(nonIdempotent).success).toBe(true);
  });

  it("preserves explicitly unavailable live usage", () => {
    const result = {
      ...baseResult(),
      boundaryId: "bnd_live",
      declaration: liveDeclaration({ kind: "read_only" }, "unavailable"),
      executionOrigin: "live" as const,
      mode: "live_provider" as const,
      usage: [
        {
          dimension: "providerCostMicrounits" as const,
          usage: { reason: "provider_did_not_report" as const, status: "unavailable" as const },
        },
      ],
    };
    expect(ReplayBoundaryExecutionResultSchema.safeParse(result).success).toBe(true);
  });

  it("rejects identity, mode, output, effect, safety, and usage semantic lies", () => {
    const liveRead = {
      ...baseResult(),
      boundaryId: "bnd_live",
      declaration: liveDeclaration(),
      executionOrigin: "live" as const,
      mode: "live_provider" as const,
      usage: [],
    };
    const idempotentDeclaration = liveDeclaration({
      idempotencyKeyScheme: "proofstack.boundary.v1",
      kind: "idempotent_write",
      sandboxDestination: true,
    });
    const nonIdempotentDeclaration = liveDeclaration({
      automaticRetry: false,
      kind: "non_idempotent_write",
      riskAcceptance: qualification(),
    });
    const candidates = [
      { ...baseResult(), boundaryId: "bnd_wrong" },
      { ...baseResult(), actualRequest: actualRequest("tool") },
      { ...baseResult(), mode: "live_provider" },
      { ...baseResult(), executionOrigin: "recorded" },
      {
        ...baseResult(),
        output: { kind: "recorded_artifacts", response: recordedResponse() },
      },
      { ...baseResult(), effectRetrySafety: { kind: "not_retryable" } },
      {
        ...baseResult(),
        effectCertainty: "confirmed",
        effectRetrySafety: { kind: "not_retryable" },
      },
      { ...liveRead, effectCertainty: "confirmed", effectRetrySafety: { kind: "not_retryable" } },
      {
        ...liveRead,
        declaration: idempotentDeclaration,
        effectCertainty: "confirmed",
        effectRetrySafety: { kind: "not_retryable" },
      },
      {
        ...liveRead,
        declaration: nonIdempotentDeclaration,
        effectCertainty: "confirmed",
        effectRetrySafety: {
          evidenceSha256: sha("c"),
          idempotencyKeySha256: sha("d"),
          kind: "destination_idempotency_verified",
        },
      },
      {
        ...liveRead,
        usage: [
          {
            dimension: "modelRequests",
            usage: { amount: 1, source: "measured", status: "observed" },
          },
        ],
      },
      {
        ...liveRead,
        declaration: liveDeclaration({ kind: "read_only" }, "unavailable"),
        usage: [
          {
            dimension: "modelRequests",
            usage: { amount: 1, source: "measured", status: "observed" },
          },
        ],
      },
    ];
    for (const candidate of candidates) {
      expect(ReplayBoundaryExecutionResultSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("requires unique sorted usage dimensions", () => {
    const usage = [
      {
        dimension: "toolCalls",
        usage: { amount: 1, source: "measured", status: "observed" },
      },
      {
        dimension: "modelRequests",
        usage: { amount: 1, source: "measured", status: "observed" },
      },
    ];
    expect(ReplayBoundaryExecutionUsageSchema.safeParse(usage).success).toBe(false);
  });
});
