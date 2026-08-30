import { createHash } from "node:crypto";
import {
  REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
  type ReplayTargetBoundaryRequestMessage,
  type ReplayTargetClockRequestMessage,
  type ReplayTargetRandomRequestMessage,
  type ReplayWorkerStartTargetMessage,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { ReplayTargetProcessProtocolError } from "./errors.js";
import { ReplayTargetProcessSession } from "./replay-target-process-session.js";

const sha = (digit: string): string => digit.repeat(64);
const normalizedBytes = "e30";
const normalizedSha256 = createHash("sha256")
  .update(Buffer.from(normalizedBytes, "base64url"))
  .digest("hex");

const targetAdapter = {
  name: "proofstack.reference_target",
  protocolVersion: "0.1",
  version: "1.0.0",
} as const;

const workerProtocol = { name: "proofstack.replay-worker", version: "0.1" } as const;

const startMessage: ReplayWorkerStartTargetMessage = {
  boundaries: [
    {
      boundaryId: "bnd_recorded",
      invocation: {
        fixture: {
          definitionSha256: sha("b"),
          fixtureId: "fix_reference",
          fixtureVersionId: "fiv_reference_001",
        },
        invocationId: "rpi_reference_001",
        runtime: {
          boundaryMode: "recorded_stub",
          clock: { instant: "2026-08-30T00:00:00.000Z", mode: "fixed" },
          isolation: { mode: "cooperative_in_process" },
          locale: "en-US",
          network: { policy: "deny_fallback" },
          random: {
            algorithm: "hmac_sha256_counter_v1",
            mode: "seeded",
            seedHex: sha("c"),
          },
          timeZone: "UTC",
        },
        schemaVersion: "0.1",
        targetAdapter: {
          name: targetAdapter.name,
          version: targetAdapter.version,
        },
      },
      invocationDefinitionSha256: sha("d"),
    },
  ],
  schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
  sessionId: "rts_reference_001",
  targetRelease: {
    definitionSha256: sha("a"),
    targetAdapter,
    targetId: "tgt_reference",
    targetReleaseId: "trg_reference_001",
    workerProtocol,
  },
  type: "start",
};

const readyMessage = {
  schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
  sessionId: startMessage.sessionId,
  targetAdapter,
  type: "ready" as const,
  workerProtocol,
};

function boundaryRequest(
  requestSequence = 0,
  boundaryRequestId = "brr_reference_001",
): ReplayTargetBoundaryRequestMessage {
  return {
    boundaryId: "bnd_recorded",
    request: {
      boundaryRequestId,
      kind: "tool",
      normalizedRequest: {
        adapterName: "proofstack.reference.tool",
        adapterVersion: "1.0.0",
        bytes: normalizedBytes,
        encoding: "base64url",
      },
      schemaVersion: "0.1",
    },
    requestSequence,
    schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
    sessionId: startMessage.sessionId,
    type: "boundary_request",
  };
}

function clockRequest(
  requestSequence = 0,
  requestId = "rrq_clock_001",
): ReplayTargetClockRequestMessage {
  return {
    boundaryId: "bnd_recorded",
    requestId,
    requestSequence,
    schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
    sessionId: startMessage.sessionId,
    type: "clock_request",
  };
}

function randomRequest(
  requestSequence = 0,
  requestId = "rrq_random_001",
  length = 3,
): ReplayTargetRandomRequestMessage {
  return {
    boundaryId: "bnd_recorded",
    length,
    requestId,
    requestSequence,
    schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
    sessionId: startMessage.sessionId,
    type: "random_request",
  };
}

function failedBoundaryResponse(boundaryRequestId = "brr_reference_001") {
  return {
    artifacts: [],
    resolution: {
      actualRequest: {
        adapterName: "proofstack.reference.tool",
        adapterVersion: "1.0.0",
        boundaryRequestId,
        kind: "tool" as const,
        normalizedRequestSha256: normalizedSha256,
        sizeBytes: 2,
      },
      expectedRequest: {
        adapterName: "proofstack.reference.tool",
        adapterVersion: "1.0.0",
        attemptId: "att_reference_001",
        attemptSequence: 0,
        interactionId: "int_reference_001",
        interactionSequence: 0,
        kind: "tool" as const,
        normalizedRequestSha256: normalizedSha256,
      },
      recordedAttempt: {
        attempt: {
          artifacts: { argumentsArtifactId: "art_arguments" },
          attemptId: "att_reference_001",
          effectMayHaveOccurred: false,
          endedAt: "2026-08-30T00:00:01.000Z",
          errorType: "recorded_failure",
          normalizedRequest: {
            adapterName: "proofstack.reference.tool",
            adapterVersion: "1.0.0",
            artifactId: "art_normalized",
            sha256: normalizedSha256,
          },
          outcome: "failed" as const,
          sequence: 0,
          sideEffect: "read_only" as const,
          startedAt: "2026-08-30T00:00:00.000Z",
        },
        callId: "call_reference",
        interactionId: "int_reference_001",
        interactionSequence: 0,
        kind: "tool" as const,
      },
      returnedArtifacts: [],
    },
    schemaVersion: "0.1" as const,
  };
}

function readySession(): ReplayTargetProcessSession {
  const session = new ReplayTargetProcessSession(startMessage);
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

describe("replay target process session lifecycle", () => {
  it("orders readiness, one boundary exchange, and exact completion", () => {
    const session = new ReplayTargetProcessSession(startMessage);
    expect(session.snapshot()).toEqual({
      acceptedRequestCount: 0,
      pendingRequestType: null,
      sessionId: startMessage.sessionId,
      status: "created",
    });

    const start = session.start();
    expect(start).toEqual(startMessage);
    const returnedBoundary = start.boundaries[0];
    if (!returnedBoundary) throw new Error("Expected start boundary");
    returnedBoundary.boundaryId = "bnd_mutated_copy";
    expect(session.snapshot().status).toBe("awaiting_ready");

    expect(session.acceptTargetMessage(readyMessage)).toEqual(readyMessage);
    const request = boundaryRequest();
    expect(session.acceptTargetMessage(request)).toEqual(request);
    request.boundaryId = "bnd_mutated_copy";
    expect(session.snapshot()).toMatchObject({
      acceptedRequestCount: 0,
      pendingRequestType: "boundary_request",
      status: "awaiting_response",
    });

    expect(session.respondToBoundary(failedBoundaryResponse())).toMatchObject({
      boundaryId: "bnd_recorded",
      requestSequence: 0,
      type: "boundary_response",
    });
    expect(session.snapshot()).toMatchObject({
      acceptedRequestCount: 1,
      pendingRequestType: null,
      status: "ready",
    });

    const completed = {
      requestCount: 1,
      schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
      sessionId: startMessage.sessionId,
      type: "completed",
    } as const;
    expect(session.acceptTargetMessage(completed)).toEqual(completed);
    expect(session.snapshot().status).toBe("completed");
    expectProtocolCode(() => session.acceptTargetMessage(completed), "session_closed");
  });

  it("serves fixed clock and caller-generated deterministic bytes in one global sequence", () => {
    const session = readySession();
    session.acceptTargetMessage(clockRequest());
    expect(session.respondToClock()).toEqual({
      boundaryId: "bnd_recorded",
      instant: "2026-08-30T00:00:00.000Z",
      requestId: "rrq_clock_001",
      requestSequence: 0,
      schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
      sessionId: startMessage.sessionId,
      type: "clock_response",
    });

    session.acceptTargetMessage(randomRequest(1));
    expect(session.respondToRandom(Uint8Array.of(1, 2, 3))).toEqual({
      boundaryId: "bnd_recorded",
      bytes: "AQID",
      encoding: "base64url",
      requestId: "rrq_random_001",
      requestSequence: 1,
      schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
      sessionId: startMessage.sessionId,
      type: "random_response",
    });

    expect(
      session.acceptTargetMessage({
        requestCount: 2,
        schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
        sessionId: startMessage.sessionId,
        type: "completed",
      }),
    ).toMatchObject({ requestCount: 2, type: "completed" });
  });

  it("creates terminal stop and abort messages without reopening", () => {
    const stopped = readySession();
    expect(stopped.stop("cancellation_requested")).toMatchObject({
      reason: "cancellation_requested",
      type: "stop",
    });
    expectProtocolCode(() => stopped.stop("worker_shutdown"), "session_closed");

    const aborted = readySession();
    expect(aborted.abort("boundary_mismatch")).toMatchObject({
      code: "boundary_mismatch",
      type: "abort",
    });
    expectProtocolCode(() => aborted.abort("worker_internal_error"), "session_closed");
  });
});

describe("replay target process session rejection", () => {
  it("rejects invalid starts and every target message before start", () => {
    expectProtocolCode(
      () => new ReplayTargetProcessSession({ ...startMessage, shell: "node target.js" }),
      "invalid_start_message",
    );
    const session = new ReplayTargetProcessSession(startMessage);
    expectProtocolCode(() => session.acceptTargetMessage(readyMessage), "unexpected_message");
    expect(session.protocolFailureMessage()).toMatchObject({
      code: "session_contract_rejected",
      type: "abort",
    });
  });

  it("rejects duplicate starts and failure-message requests on healthy sessions", () => {
    const session = new ReplayTargetProcessSession(startMessage);
    session.start();
    expectProtocolCode(() => session.start(), "unexpected_message");

    const healthy = readySession();
    expectProtocolCode(() => healthy.protocolFailureMessage(), "unexpected_message");
    expect(healthy.snapshot().status).toBe("ready");

    const duplicateReady = readySession();
    expectProtocolCode(
      () => duplicateReady.acceptTargetMessage(readyMessage),
      "unexpected_message",
    );
  });

  it("binds ready to the exact session, target adapter, and worker protocol", () => {
    const cases = [
      [{ ...readyMessage, sessionId: "rts_other" }, "session_mismatch"],
      [
        { ...readyMessage, targetAdapter: { ...targetAdapter, version: "2.0.0" } },
        "target_adapter_mismatch",
      ],
      [
        { ...readyMessage, workerProtocol: { ...workerProtocol, version: "0.2" } },
        "worker_protocol_mismatch",
      ],
      [{ ...readyMessage, extraAuthority: true }, "invalid_target_message"],
    ] as const;
    for (const [message, code] of cases) {
      const session = new ReplayTargetProcessSession(startMessage);
      session.start();
      expectProtocolCode(() => session.acceptTargetMessage(message), code);
      expect(session.snapshot().status).toBe("failed");
    }
  });

  it("rejects unknown boundaries, gaps, duplicates, and overlapping requests", () => {
    const unknown = readySession();
    expectProtocolCode(
      () =>
        unknown.acceptTargetMessage({
          ...clockRequest(),
          boundaryId: "bnd_unknown",
        }),
      "unknown_boundary",
    );

    const gap = readySession();
    expectProtocolCode(() => gap.acceptTargetMessage(clockRequest(1)), "request_sequence_mismatch");

    const duplicate = readySession();
    duplicate.acceptTargetMessage(clockRequest());
    duplicate.respondToClock();
    expectProtocolCode(
      () => duplicate.acceptTargetMessage(randomRequest(1, "rrq_clock_001")),
      "duplicate_request_id",
    );

    const overlapping = readySession();
    overlapping.acceptTargetMessage(clockRequest());
    expectProtocolCode(
      () => overlapping.acceptTargetMessage(randomRequest()),
      "unexpected_message",
    );
  });

  it("rejects malformed, unrelated, and wrongly timed boundary responses", () => {
    const withoutPending = readySession();
    expectProtocolCode(
      () => withoutPending.respondToBoundary(failedBoundaryResponse()),
      "unexpected_message",
    );

    const malformed = readySession();
    malformed.acceptTargetMessage(boundaryRequest());
    expectProtocolCode(
      () => malformed.respondToBoundary({ ...failedBoundaryResponse(), fallback: "live" }),
      "invalid_worker_message",
    );

    const unrelated = readySession();
    unrelated.acceptTargetMessage(boundaryRequest());
    expectProtocolCode(
      () => unrelated.respondToBoundary(failedBoundaryResponse("brr_other")),
      "boundary_response_mismatch",
    );

    const wrongKind = readySession();
    wrongKind.acceptTargetMessage(clockRequest());
    expectProtocolCode(
      () => wrongKind.respondToBoundary(failedBoundaryResponse()),
      "unexpected_message",
    );
  });

  it("rejects wrong random lengths and completion while work is pending or miscounted", () => {
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
          schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
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
          schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
          sessionId: startMessage.sessionId,
          type: "completed",
        }),
      "request_sequence_mismatch",
    );
  });

  it("rejects worker termination before start and invalid runtime enum values", () => {
    const beforeStart = new ReplayTargetProcessSession(startMessage);
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
