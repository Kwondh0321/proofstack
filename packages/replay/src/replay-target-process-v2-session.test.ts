import { createHash } from "node:crypto";
import {
  REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
  type ReplayTargetBoundaryRequestV2Message,
  type ReplayTargetClockRequestV2Message,
  type ReplayTargetRandomRequestV2Message,
  type ReplayWorkerStartTargetV2Message,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { ReplayTargetProcessProtocolError } from "./errors.js";
import { ReplayTargetProcessV2Session } from "./replay-target-process-v2-session.js";

const sha = (digit: string): string => digit.repeat(64);
const normalizedBytes = Buffer.from("{}", "utf8").toString("base64url");
const normalizedSha256 = createHash("sha256")
  .update(Buffer.from(normalizedBytes, "base64url"))
  .digest("hex");
const targetAdapter = {
  name: "proofstack.reference_target",
  protocolVersion: "0.2",
  version: "2.0.0",
} as const;
const workerProtocol = { name: "proofstack.replay-worker", version: "0.2" } as const;
const invocation = {
  fixture: {
    definitionSha256: sha("1"),
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
      seedHex: sha("2"),
    },
    timeZone: "UTC",
  },
  schemaVersion: "0.1" as const,
  targetAdapter: { name: targetAdapter.name, version: targetAdapter.version },
};

const startMessage: ReplayWorkerStartTargetV2Message = {
  boundaries: [
    { boundaryId: "bnd_live", kind: "model", mode: "live_provider" },
    {
      boundaryId: "bnd_recorded",
      invocation,
      invocationDefinitionSha256: sha("3"),
      kind: "tool",
      mode: "recorded_stub",
    },
    { boundaryId: "bnd_simulation", kind: "retrieval", mode: "simulation" },
  ],
  schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
  sessionId: "session_reference_002",
  targetRelease: {
    definitionSha256: sha("4"),
    targetAdapter,
    targetId: "target_reference",
    targetReleaseId: "release_reference_002",
    workerProtocol,
  },
  type: "start",
};

const readyMessage = {
  schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
  sessionId: startMessage.sessionId,
  targetAdapter,
  type: "ready" as const,
  workerProtocol,
};

function boundaryRequest(
  requestSequence = 0,
  boundaryRequestId = "request_boundary_001",
  boundaryId = "bnd_live",
  kind: "data" | "model" | "retrieval" | "tool" = "model",
): ReplayTargetBoundaryRequestV2Message {
  return {
    boundaryId,
    request: {
      boundaryRequestId,
      kind,
      normalizedRequest: {
        adapter: { name: "proofstack.boundary", version: "1.0.0" },
        bytes: normalizedBytes,
        encoding: "base64url",
      },
      schemaVersion: "0.1",
    },
    requestSequence,
    schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
    sessionId: startMessage.sessionId,
    type: "boundary_request",
  };
}

function clockRequest(
  requestSequence = 0,
  requestId = "request_clock_001",
  boundaryId = "bnd_recorded",
): ReplayTargetClockRequestV2Message {
  return {
    boundaryId,
    requestId,
    requestSequence,
    schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
    sessionId: startMessage.sessionId,
    type: "clock_request",
  };
}

function randomRequest(
  requestSequence = 0,
  requestId = "request_random_001",
  length = 3,
  boundaryId = "bnd_recorded",
): ReplayTargetRandomRequestV2Message {
  return {
    boundaryId,
    length,
    requestId,
    requestSequence,
    schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
    sessionId: startMessage.sessionId,
    type: "random_request",
  };
}

function liveDeclaration() {
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
    requestLimits: { requestBytes: 64, responseBytes: 64 },
    sideEffect: { kind: "read_only" as const },
    usageSource: "measured" as const,
  };
}

function liveResult(boundaryRequestId = "request_boundary_001") {
  const responseBytes = Buffer.from("result", "utf8");
  return {
    actualRequest: {
      adapter: { name: "proofstack.boundary", version: "1.0.0" },
      boundaryRequestId,
      kind: "model" as const,
      normalizedRequestSha256: normalizedSha256,
      sizeBytes: 2,
    },
    boundaryId: "bnd_live",
    declaration: liveDeclaration(),
    effectCertainty: "none" as const,
    executionOrigin: "live" as const,
    mode: "live_provider" as const,
    output: {
      kind: "normalized_response" as const,
      response: {
        adapter: { name: "proofstack.boundary", version: "1.0.0" },
        bytes: responseBytes.toString("base64url"),
        encoding: "base64url" as const,
        normalizedResponseSha256: createHash("sha256").update(responseBytes).digest("hex"),
        sizeBytes: responseBytes.byteLength,
      },
    },
    schemaVersion: "0.1" as const,
    usage: [
      {
        dimension: "modelRequests" as const,
        usage: { amount: 1, source: "measured" as const, status: "observed" as const },
      },
    ],
  };
}

function readySession(): ReplayTargetProcessV2Session {
  const session = new ReplayTargetProcessV2Session(startMessage);
  session.start();
  session.acceptTargetMessage(readyMessage);
  return session;
}

function expectProtocolCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected replay target protocol failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ReplayTargetProcessProtocolError);
    expect((error as ReplayTargetProcessProtocolError).code).toBe(code);
  }
}

describe("replay target process v2 session lifecycle", () => {
  it("projects one multi-mode boundary result and retains full worker evidence", () => {
    const session = new ReplayTargetProcessV2Session(startMessage);
    expect(session.snapshot()).toEqual({
      acceptedRequestCount: 0,
      boundaryResultCount: 0,
      pendingRequestType: null,
      sessionId: startMessage.sessionId,
      status: "created",
    });
    const start = session.start();
    (start.boundaries[0] as { boundaryId: string }).boundaryId = "bnd_copy_mutated";
    session.acceptTargetMessage(readyMessage);
    const request = boundaryRequest();
    session.acceptTargetMessage(request);
    request.boundaryId = "bnd_copy_mutated";

    const result = liveResult();
    const response = session.respondToBoundary(result);
    expect(response).toEqual({
      boundaryId: "bnd_live",
      output: result.output,
      requestSequence: 0,
      schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
      sessionId: startMessage.sessionId,
      type: "boundary_result",
    });
    expect(response).not.toHaveProperty("declaration");
    expect(JSON.stringify(response)).not.toContain("credentialId");
    expect(session.snapshot()).toMatchObject({
      acceptedRequestCount: 1,
      boundaryResultCount: 1,
      status: "ready",
    });
    const retained = session.boundaryResults;
    expect(retained).toEqual([result]);
    (retained[0] as { boundaryId: string }).boundaryId = "bnd_copy_mutated";
    expect(session.boundaryResults[0]?.boundaryId).toBe("bnd_live");

    const completed = {
      requestCount: 1,
      schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
      sessionId: startMessage.sessionId,
      type: "completed",
    } as const;
    session.acceptTargetMessage(completed);
    expect(session.snapshot().status).toBe("completed");
    expectProtocolCode(() => session.acceptTargetMessage(completed), "session_closed");
  });

  it("serves recorded-only clock and deterministic random exchanges", () => {
    const session = readySession();
    session.acceptTargetMessage(clockRequest());
    expect(session.respondToClock()).toMatchObject({
      instant: invocation.runtime.clock.instant,
      requestSequence: 0,
      type: "clock_response",
    });
    session.acceptTargetMessage(randomRequest(1));
    expect(session.respondToRandom(Uint8Array.of(1, 2, 3))).toMatchObject({
      bytes: "AQID",
      requestSequence: 1,
      type: "random_response",
    });
    expect(
      session.acceptTargetMessage({
        requestCount: 2,
        schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
        sessionId: startMessage.sessionId,
        type: "completed",
      }),
    ).toMatchObject({ requestCount: 2 });
  });

  it("creates terminal stop and abort messages without reopening", () => {
    const stopped = readySession();
    expect(stopped.stop("cancellation_requested")).toMatchObject({ type: "stop" });
    expectProtocolCode(() => stopped.stop("worker_shutdown"), "session_closed");
    const aborted = readySession();
    expect(aborted.abort("boundary_mismatch")).toMatchObject({ type: "abort" });
    expectProtocolCode(() => aborted.abort("worker_internal_error"), "session_closed");
  });
});

describe("replay target process v2 session rejection", () => {
  it("rejects invalid starts, messages before start, and duplicate starts", () => {
    expectProtocolCode(
      () => new ReplayTargetProcessV2Session({ ...startMessage, command: "node target.js" }),
      "invalid_start_message",
    );
    const beforeStart = new ReplayTargetProcessV2Session(startMessage);
    expectProtocolCode(() => beforeStart.acceptTargetMessage(readyMessage), "unexpected_message");
    expect(beforeStart.protocolFailureMessage()).toMatchObject({
      code: "session_contract_rejected",
    });
    const duplicate = new ReplayTargetProcessV2Session(startMessage);
    duplicate.start();
    expectProtocolCode(() => duplicate.start(), "unexpected_message");
    const healthy = readySession();
    expectProtocolCode(() => healthy.protocolFailureMessage(), "unexpected_message");
    const duplicateReady = readySession();
    expectProtocolCode(
      () => duplicateReady.acceptTargetMessage(readyMessage),
      "unexpected_message",
    );
  });

  it("binds ready to the exact session, target adapter, and worker protocol", () => {
    const cases = [
      [{ ...readyMessage, sessionId: "session_other" }, "session_mismatch"],
      [
        { ...readyMessage, targetAdapter: { ...targetAdapter, version: "wrong" } },
        "target_adapter_mismatch",
      ],
      [
        { ...readyMessage, workerProtocol: { ...workerProtocol, version: "wrong" } },
        "worker_protocol_mismatch",
      ],
      [{ ...readyMessage, authority: "expanded" }, "invalid_target_message"],
    ] as const;
    for (const [message, code] of cases) {
      const session = new ReplayTargetProcessV2Session(startMessage);
      session.start();
      expectProtocolCode(() => session.acceptTargetMessage(message), code);
    }
  });

  it("rejects unknown boundaries, kind mismatches, sequence gaps, duplicates, and overlap", () => {
    const unknown = readySession();
    expectProtocolCode(
      () => unknown.acceptTargetMessage(clockRequest(0, "clock_unknown", "bnd_unknown")),
      "unknown_boundary",
    );
    const wrongKind = readySession();
    expectProtocolCode(
      () => wrongKind.acceptTargetMessage(boundaryRequest(0, "request_wrong", "bnd_live", "tool")),
      "boundary_request_mismatch",
    );
    const gap = readySession();
    expectProtocolCode(() => gap.acceptTargetMessage(clockRequest(1)), "request_sequence_mismatch");
    const duplicate = readySession();
    duplicate.acceptTargetMessage(clockRequest());
    duplicate.respondToClock();
    expectProtocolCode(
      () => duplicate.acceptTargetMessage(randomRequest(1, "request_clock_001")),
      "duplicate_request_id",
    );
    const overlapping = readySession();
    overlapping.acceptTargetMessage(clockRequest());
    expectProtocolCode(
      () => overlapping.acceptTargetMessage(randomRequest()),
      "unexpected_message",
    );
  });

  it("denies clock and random controls for opaque simulation or live boundaries", () => {
    const liveClock = readySession();
    expectProtocolCode(
      () => liveClock.acceptTargetMessage(clockRequest(0, "clock_live", "bnd_live")),
      "runtime_control_unavailable",
    );
    const simulationRandom = readySession();
    expectProtocolCode(
      () =>
        simulationRandom.acceptTargetMessage(
          randomRequest(0, "random_simulation", 3, "bnd_simulation"),
        ),
      "runtime_control_unavailable",
    );
  });

  it("rejects malformed, unrelated, and wrongly timed boundary results", () => {
    const withoutPending = readySession();
    expectProtocolCode(() => withoutPending.respondToBoundary(liveResult()), "unexpected_message");
    const malformed = readySession();
    malformed.acceptTargetMessage(boundaryRequest());
    expectProtocolCode(
      () => malformed.respondToBoundary({ ...liveResult(), fallback: "recorded" }),
      "invalid_worker_message",
    );
    const otherBoundaryResult = {
      ...liveResult(),
      boundaryId: "bnd_other",
      declaration: { ...liveDeclaration(), boundaryId: "bnd_other" },
    };
    for (const result of [liveResult("request_other"), otherBoundaryResult]) {
      const session = readySession();
      session.acceptTargetMessage(boundaryRequest());
      expectProtocolCode(() => session.respondToBoundary(result), "boundary_result_mismatch");
    }
    const wrongPending = readySession();
    wrongPending.acceptTargetMessage(clockRequest());
    expectProtocolCode(() => wrongPending.respondToBoundary(liveResult()), "unexpected_message");
  });

  it("checks recorded result definitions, random lengths, and exact completion counts", () => {
    const recordedPending = readySession();
    recordedPending.acceptTargetMessage(boundaryRequest(0, "request_tool", "bnd_recorded", "tool"));
    expectProtocolCode(
      () => recordedPending.respondToBoundary(liveResult("request_tool")),
      "boundary_result_mismatch",
    );
    const random = readySession();
    random.acceptTargetMessage(randomRequest());
    expectProtocolCode(
      () => random.respondToRandom(Uint8Array.of(1, 2)),
      "random_response_mismatch",
    );
    const pending = readySession();
    pending.acceptTargetMessage(clockRequest());
    expectProtocolCode(
      () =>
        pending.acceptTargetMessage({
          requestCount: 0,
          schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
          sessionId: startMessage.sessionId,
          type: "completed",
        }),
      "unexpected_message",
    );
    const miscounted = readySession();
    expectProtocolCode(
      () =>
        miscounted.acceptTargetMessage({
          requestCount: 1,
          schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
          sessionId: startMessage.sessionId,
          type: "completed",
        }),
      "request_sequence_mismatch",
    );
  });

  it("rejects termination before start and invalid worker enum values", () => {
    const beforeStart = new ReplayTargetProcessV2Session(startMessage);
    expectProtocolCode(() => beforeStart.stop("worker_shutdown"), "unexpected_message");
    const invalidStop = readySession();
    expectProtocolCode(
      () => invalidStop.stop("continue_anyway" as never),
      "invalid_worker_message",
    );
    const invalidAbort = readySession();
    expectProtocolCode(
      () => invalidAbort.abort("ignore_contract" as never),
      "invalid_worker_message",
    );
  });
});
