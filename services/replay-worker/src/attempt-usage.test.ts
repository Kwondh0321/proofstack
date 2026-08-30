import { createHash } from "node:crypto";
import {
  MAX_REPLAY_ACCOUNTING_VALUE,
  type ReplayBoundaryDeclaration,
  type ReplayBoundaryExecutionResult,
  ReplayBoundaryExecutionResultSchema,
  type ReplayExecutionObservationPayload,
  type ReplayUsageMeasurement,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { measureReplayAttemptUsage } from "./attempt-usage.js";

const sha = (digit: string): string => digit.repeat(64);

function simulationDeclaration(boundaryId: string): ReplayBoundaryDeclaration {
  return {
    boundaryId,
    configurationSha256: sha("1"),
    kind: "model",
    mode: "simulation",
    qualification: {
      artifactId: `art_${boundaryId}_qualification`,
      classification: "internal",
      mediaType: "application/json",
      sha256: sha("2"),
      sizeBytes: 64,
    },
    seedHex: sha("3"),
    simulatorRelease: {
      definitionSha256: sha("4"),
      targetAdapter: {
        name: "proofstack.simulator",
        protocolVersion: "1.0.0",
        version: "1.0.0",
      },
      targetId: "target_simulator",
      targetReleaseId: "trg_simulator_001",
      workerProtocol: { name: "proofstack.replay-worker", version: "2.0.0" },
    },
  };
}

function liveDeclaration(
  boundaryId: string,
  kind: "model" | "retrieval" | "tool" = "model",
  usageSource: "estimated" | "measured" | "provider_reported" | "unavailable" = "provider_reported",
): ReplayBoundaryDeclaration {
  return {
    boundaryId,
    credential: {
      credentialId: "cred_provider",
      credentialVersionId: "crv_provider_001",
    },
    destination: { hostname: "api.example.com", port: 443, scheme: "https" },
    endpointProfile: {
      definitionSha256: sha("5"),
      endpointProfileId: "end_provider",
      endpointProfileVersion: "1.0.0",
    },
    kind,
    mode: "live_provider",
    operation: "execute",
    requestLimits: { requestBytes: 4_096, responseBytes: 65_536 },
    sideEffect: { kind: "read_only" },
    usageSource,
  };
}

function observed(
  dimension: string,
  amount: number,
  source: "estimated" | "measured" | "provider_reported",
) {
  return { dimension, usage: { amount, source, status: "observed" as const } };
}

function result(
  declaration: ReplayBoundaryDeclaration,
  usage: readonly { readonly dimension: string; readonly usage: ReplayUsageMeasurement }[],
): ReplayBoundaryExecutionResult {
  const bytes = Buffer.from(`response:${declaration.boundaryId}`, "utf8");
  const requestBytes = Buffer.from(`request:${declaration.boundaryId}`, "utf8");
  return ReplayBoundaryExecutionResultSchema.parse({
    actualRequest: {
      adapter: { name: "proofstack.target.boundary", version: "1.0.0" },
      boundaryRequestId: `req_${declaration.boundaryId}`,
      kind: declaration.kind,
      normalizedRequestSha256: createHash("sha256").update(requestBytes).digest("hex"),
      sizeBytes: requestBytes.byteLength,
    },
    boundaryId: declaration.boundaryId,
    declaration,
    effectCertainty: "none",
    executionOrigin: declaration.mode === "simulation" ? "simulated" : "live",
    mode: declaration.mode,
    output: {
      kind: "normalized_response",
      response: {
        adapter: { name: "proofstack.target.boundary", version: "1.0.0" },
        bytes: bytes.toString("base64url"),
        encoding: "base64url",
        normalizedResponseSha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength,
      },
    },
    schemaVersion: "0.1",
    usage,
  });
}

function boundaryObservation(
  candidate: ReplayBoundaryExecutionResult,
  phase: "failed" | "request_started" | "response_observed",
): ReplayExecutionObservationPayload {
  return {
    afterCancellationRequest: false,
    boundaryId: candidate.boundaryId,
    boundaryKind: candidate.actualRequest.kind,
    effectCertainty: phase === "response_observed" ? candidate.effectCertainty : "none",
    evidenceSha256: createHash("sha256")
      .update(`${candidate.boundaryId}:${phase}`, "utf8")
      .digest("hex"),
    executionOrigin: candidate.executionOrigin,
    kind: "boundary",
    mode: candidate.mode,
    phase,
  };
}

function observations(
  results: readonly ReplayBoundaryExecutionResult[],
): readonly ReplayExecutionObservationPayload[] {
  return results.flatMap((candidate) => [
    boundaryObservation(candidate, "request_started"),
    boundaryObservation(candidate, "response_observed"),
  ]);
}

function options(
  boundaryResults: readonly ReplayBoundaryExecutionResult[],
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    boundaryResults,
    elapsedMilliseconds: 123,
    emittedArtifactBytes: 456,
    executionObservations: observations(boundaryResults),
    ...overrides,
  };
}

describe("measureReplayAttemptUsage", () => {
  it("aggregates same-source live evidence while keeping worker counters measured", () => {
    const first = result(liveDeclaration("bnd_live_a"), [
      observed("inputTokens", 10, "provider_reported"),
      observed("modelRequests", 1, "provider_reported"),
      observed("outputTokens", 4, "provider_reported"),
      observed("providerCostMicrounits", 9, "provider_reported"),
    ]);
    const second = result(liveDeclaration("bnd_live_b"), [
      observed("inputTokens", 20, "provider_reported"),
      observed("modelRequests", 1, "provider_reported"),
      observed("outputTokens", 7, "provider_reported"),
      observed("providerCostMicrounits", 11, "provider_reported"),
    ]);

    const usage = measureReplayAttemptUsage(options([first, second]));
    expect(usage).toEqual({
      concurrentInteractions: { amount: 1, source: "measured", status: "observed" },
      elapsedMilliseconds: { amount: 123, source: "measured", status: "observed" },
      emittedArtifactBytes: { amount: 456, source: "measured", status: "observed" },
      inputTokens: { amount: 30, source: "provider_reported", status: "observed" },
      jobAttempts: { amount: 1, source: "measured", status: "observed" },
      modelRequests: { amount: 2, source: "measured", status: "observed" },
      outputTokens: { amount: 11, source: "provider_reported", status: "observed" },
      providerCostMicrounits: {
        amount: 20,
        source: "provider_reported",
        status: "observed",
      },
      retrievedBytes: { amount: 0, source: "measured", status: "observed" },
      toolCalls: { amount: 0, source: "measured", status: "observed" },
    });
    expect(Object.isFrozen(usage)).toBe(true);
    expect(Object.isFrozen(usage.inputTokens)).toBe(true);
  });

  it("measures retrieved response bytes and tool requests independently of provider claims", () => {
    const retrieval = result(liveDeclaration("bnd_retrieval", "retrieval"), [
      observed("providerCostMicrounits", 3, "provider_reported"),
      observed("retrievedBytes", 999, "provider_reported"),
    ]);
    const tool = result(liveDeclaration("bnd_tool", "tool"), [
      observed("providerCostMicrounits", 2, "provider_reported"),
      observed("toolCalls", 1, "provider_reported"),
    ]);
    const usage = measureReplayAttemptUsage(options([retrieval, tool]));
    expect(usage.retrievedBytes).toEqual({
      amount:
        retrieval.output.kind === "normalized_response" ? retrieval.output.response.sizeBytes : -1,
      source: "measured",
      status: "observed",
    });
    expect(usage.toolCalls).toEqual({ amount: 1, source: "measured", status: "observed" });
    expect(usage.providerCostMicrounits).toEqual({
      amount: 5,
      source: "provider_reported",
      status: "observed",
    });
  });

  it("keeps missing and mixed boundary evidence unavailable instead of fabricating zero", () => {
    const complete = result(simulationDeclaration("bnd_sim_a"), [
      observed("inputTokens", 5, "measured"),
      observed("modelRequests", 1, "measured"),
      observed("outputTokens", 2, "measured"),
    ]);
    const missing = result(simulationDeclaration("bnd_sim_b"), [
      observed("modelRequests", 1, "measured"),
      observed("outputTokens", 3, "measured"),
    ]);
    const missingUsage = measureReplayAttemptUsage(options([complete, missing]));
    expect(missingUsage.inputTokens).toEqual({
      reason: "source_unavailable",
      status: "unavailable",
    });
    expect(missingUsage.outputTokens).toEqual({
      amount: 5,
      source: "measured",
      status: "observed",
    });

    const estimated = result(simulationDeclaration("bnd_sim_c"), [
      observed("inputTokens", 8, "estimated"),
      observed("modelRequests", 1, "estimated"),
      observed("outputTokens", 4, "estimated"),
    ]);
    expect(measureReplayAttemptUsage(options([complete, estimated])).inputTokens).toEqual({
      reason: "measurement_failed",
      status: "unavailable",
    });

    const failedMeasurement = result(simulationDeclaration("bnd_sim_failed"), [
      {
        dimension: "inputTokens",
        usage: { reason: "measurement_failed", status: "unavailable" },
      },
      observed("modelRequests", 1, "measured"),
      observed("outputTokens", 1, "measured"),
    ]);
    expect(measureReplayAttemptUsage(options([failedMeasurement])).inputTokens).toEqual({
      reason: "measurement_failed",
      status: "unavailable",
    });

    const liveMissing = result(liveDeclaration("bnd_live_missing"), [
      observed("inputTokens", 6, "provider_reported"),
      observed("modelRequests", 1, "provider_reported"),
      observed("providerCostMicrounits", 1, "provider_reported"),
    ]);
    expect(measureReplayAttemptUsage(options([liveMissing])).outputTokens).toEqual({
      reason: "provider_did_not_report",
      status: "unavailable",
    });
  });

  it("settles non-applicable boundary dimensions as measured zero", () => {
    expect(measureReplayAttemptUsage(options([]))).toEqual({
      concurrentInteractions: { amount: 0, source: "measured", status: "observed" },
      elapsedMilliseconds: { amount: 123, source: "measured", status: "observed" },
      emittedArtifactBytes: { amount: 456, source: "measured", status: "observed" },
      inputTokens: { amount: 0, source: "measured", status: "observed" },
      jobAttempts: { amount: 1, source: "measured", status: "observed" },
      modelRequests: { amount: 0, source: "measured", status: "observed" },
      outputTokens: { amount: 0, source: "measured", status: "observed" },
      providerCostMicrounits: { amount: 0, source: "measured", status: "observed" },
      retrievedBytes: { amount: 0, source: "measured", status: "observed" },
      toolCalls: { amount: 0, source: "measured", status: "observed" },
    });
  });

  it("disputes usage for failed or incomplete relevant boundaries", () => {
    const failedModel = result(liveDeclaration("bnd_failed_model"), [
      observed("inputTokens", 1, "provider_reported"),
      observed("modelRequests", 1, "provider_reported"),
      observed("outputTokens", 1, "provider_reported"),
      observed("providerCostMicrounits", 1, "provider_reported"),
    ]);
    const failedUsage = measureReplayAttemptUsage(
      options([], {
        executionObservations: [
          boundaryObservation(failedModel, "request_started"),
          boundaryObservation(failedModel, "failed"),
        ],
      }),
    );
    expect(failedUsage.modelRequests).toEqual({
      amount: 1,
      source: "measured",
      status: "observed",
    });
    for (const dimension of ["inputTokens", "outputTokens", "providerCostMicrounits"] as const) {
      expect(failedUsage[dimension]).toEqual({
        reason: "measurement_failed",
        status: "unavailable",
      });
    }

    const incompleteRetrieval = result(liveDeclaration("bnd_incomplete_retrieval", "retrieval"), [
      observed("providerCostMicrounits", 1, "provider_reported"),
      observed("retrievedBytes", 1, "provider_reported"),
    ]);
    const incompleteUsage = measureReplayAttemptUsage(
      options([], {
        executionObservations: [boundaryObservation(incompleteRetrieval, "request_started")],
      }),
    );
    expect(incompleteUsage.retrievedBytes).toEqual({
      reason: "measurement_failed",
      status: "unavailable",
    });
    expect(incompleteUsage.providerCostMicrounits).toEqual({
      reason: "measurement_failed",
      status: "unavailable",
    });
  });

  it("rejects result, observation, counter, and worker-owned usage inconsistencies", () => {
    const valid = result(simulationDeclaration("bnd_valid"), [
      observed("inputTokens", 1, "measured"),
      observed("modelRequests", 1, "measured"),
      observed("outputTokens", 1, "measured"),
    ]);
    const wrongCount = result(simulationDeclaration("bnd_wrong_count"), [
      observed("inputTokens", 1, "measured"),
      observed("modelRequests", 2, "measured"),
      observed("outputTokens", 1, "measured"),
    ]);
    const attemptOwned = result(simulationDeclaration("bnd_attempt_owned"), [
      observed("elapsedMilliseconds", 1, "measured"),
      observed("modelRequests", 1, "measured"),
    ]);
    const wrongToolCount = result(liveDeclaration("bnd_wrong_tool", "tool"), [
      observed("providerCostMicrounits", 1, "provider_reported"),
      observed("toolCalls", 2, "provider_reported"),
    ]);
    const wrongRequestKind = result(liveDeclaration("bnd_tool_model_count", "tool"), [
      observed("modelRequests", 1, "provider_reported"),
      observed("providerCostMicrounits", 1, "provider_reported"),
    ]);
    const unavailableRequestCount = result(simulationDeclaration("bnd_unavailable_count"), [
      {
        dimension: "modelRequests",
        usage: { reason: "source_unavailable", status: "unavailable" },
      },
    ]);
    const mismatchedObservations = observations([valid]).map((observation) =>
      observation.kind === "boundary" && observation.phase === "response_observed"
        ? { ...observation, boundaryId: "bnd_other" }
        : observation,
    );
    const responseWithoutStart = [boundaryObservation(valid, "response_observed")];
    const overlappingRequests = [
      boundaryObservation(valid, "request_started"),
      boundaryObservation(valid, "request_started"),
    ];
    const extraObservedResult = result(simulationDeclaration("bnd_extra_observed"), [
      observed("inputTokens", 1, "measured"),
      observed("modelRequests", 1, "measured"),
      observed("outputTokens", 1, "measured"),
    ]);
    for (const candidate of [
      options([valid], { elapsedMilliseconds: -1 }),
      options([valid], { emittedArtifactBytes: 1.5 }),
      options([valid], { executionObservations: [{ kind: "unknown" }] }),
      options([valid], { executionObservations: mismatchedObservations }),
      options([valid], { executionObservations: responseWithoutStart }),
      options([valid], { executionObservations: overlappingRequests }),
      options([], { executionObservations: observations([extraObservedResult]) }),
      options([wrongCount]),
      options([wrongToolCount]),
      options([wrongRequestKind]),
      options([unavailableRequestCount]),
      options([attemptOwned]),
      options([], { boundaryResults: [{ invalid: true }] }),
    ]) {
      expect(() => measureReplayAttemptUsage(candidate)).toThrowError(
        expect.objectContaining({ code: "invalid_usage_evidence" }),
      );
    }
  });

  it("fails closed when aggregating boundary evidence would overflow", () => {
    const maximum = result(simulationDeclaration("bnd_maximum"), [
      observed("inputTokens", MAX_REPLAY_ACCOUNTING_VALUE, "measured"),
      observed("modelRequests", 1, "measured"),
      observed("outputTokens", 1, "measured"),
    ]);
    const additional = result(simulationDeclaration("bnd_additional"), [
      observed("inputTokens", 1, "measured"),
      observed("modelRequests", 1, "measured"),
      observed("outputTokens", 1, "measured"),
    ]);
    expect(() => measureReplayAttemptUsage(options([maximum, additional]))).toThrowError(
      expect.objectContaining({ code: "arithmetic_overflow" }),
    );
  });
});
