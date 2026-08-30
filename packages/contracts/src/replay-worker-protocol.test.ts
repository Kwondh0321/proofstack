import { describe, expect, it } from "vitest";
import {
  REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
  ReplayTargetToWorkerMessageSchema,
  ReplayWorkerToTargetMessageSchema,
} from "./replay-worker-protocol.js";

const sha = (digit: string): string => digit.repeat(64);

const targetAdapter = {
  name: "proofstack.reference_target",
  protocolVersion: "0.1",
  version: "1.0.0",
} as const;

const workerProtocol = { name: "proofstack.replay-worker", version: "0.1" } as const;

const targetRelease = {
  definitionSha256: sha("a"),
  targetAdapter,
  targetId: "tgt_reference",
  targetReleaseId: "trg_reference_001",
  workerProtocol,
} as const;

const invocation = {
  fixture: {
    definitionSha256: sha("b"),
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
      seedHex: sha("c"),
    },
    timeZone: "UTC",
  },
  schemaVersion: "0.1" as const,
  targetAdapter: { name: targetAdapter.name, version: targetAdapter.version },
};

const start = {
  boundaries: [
    {
      boundaryId: "bnd_recorded",
      invocation,
      invocationDefinitionSha256: sha("d"),
    },
  ],
  schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
  sessionId: "rts_reference_001",
  targetRelease,
  type: "start" as const,
};

const request = {
  boundaryId: "bnd_recorded",
  request: {
    boundaryRequestId: "brr_reference_001",
    kind: "tool" as const,
    normalizedRequest: {
      adapterName: "proofstack.reference.tool",
      adapterVersion: "1.0.0",
      bytes: "e30",
      encoding: "base64url" as const,
    },
    schemaVersion: "0.1" as const,
  },
  requestSequence: 0,
  schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
  sessionId: start.sessionId,
  type: "boundary_request" as const,
};

const failedToolResponse = {
  artifacts: [],
  resolution: {
    actualRequest: {
      adapterName: request.request.normalizedRequest.adapterName,
      adapterVersion: request.request.normalizedRequest.adapterVersion,
      boundaryRequestId: request.request.boundaryRequestId,
      kind: request.request.kind,
      normalizedRequestSha256: sha("e"),
      sizeBytes: 2,
    },
    expectedRequest: {
      adapterName: request.request.normalizedRequest.adapterName,
      adapterVersion: request.request.normalizedRequest.adapterVersion,
      attemptId: "att_reference_001",
      attemptSequence: 0,
      interactionId: "int_reference_001",
      interactionSequence: 0,
      kind: request.request.kind,
      normalizedRequestSha256: sha("e"),
    },
    recordedAttempt: {
      attempt: {
        artifacts: { argumentsArtifactId: "art_arguments" },
        attemptId: "att_reference_001",
        effectMayHaveOccurred: false,
        endedAt: "2026-08-30T00:00:01.000Z",
        errorType: "recorded_failure",
        normalizedRequest: {
          adapterName: request.request.normalizedRequest.adapterName,
          adapterVersion: request.request.normalizedRequest.adapterVersion,
          artifactId: "art_normalized",
          sha256: sha("e"),
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

describe("replay worker-to-target process messages", () => {
  it("accepts an exact recorded start without lease, budget, credential, or command authority", () => {
    expect(ReplayWorkerToTargetMessageSchema.parse(start)).toEqual(start);
    const keys = new Set<string>();
    JSON.stringify(start, (key, value: unknown) => {
      if (key !== "") keys.add(key);
      return value;
    });
    for (const forbidden of [
      "attemptId",
      "budget",
      "command",
      "credential",
      "fencingToken",
      "leaseId",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("rejects unsorted, duplicate, adapter-mismatched, empty, and expanded starts", () => {
    const other = { ...start.boundaries[0], boundaryId: "bnd_z_other" };
    const candidates = [
      { ...start, boundaries: [] },
      { ...start, boundaries: [other, start.boundaries[0]] },
      { ...start, boundaries: [start.boundaries[0], start.boundaries[0]] },
      {
        ...start,
        boundaries: [
          {
            ...start.boundaries[0],
            invocation: {
              ...invocation,
              targetAdapter: { ...invocation.targetAdapter, version: "2.0.0" },
            },
          },
        ],
      },
      { ...start, command: ["node", "target.js"] },
    ];
    for (const candidate of candidates) {
      expect(ReplayWorkerToTargetMessageSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("accepts only bounded response, stop, and abort variants", () => {
    const messages = [
      {
        boundaryId: request.boundaryId,
        requestSequence: 0,
        response: failedToolResponse,
        schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        type: "boundary_response",
      },
      {
        boundaryId: request.boundaryId,
        instant: invocation.runtime.clock.instant,
        requestId: "rrq_clock_001",
        requestSequence: 1,
        schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        type: "clock_response",
      },
      {
        boundaryId: request.boundaryId,
        bytes: "AA",
        encoding: "base64url",
        requestId: "rrq_random_001",
        requestSequence: 2,
        schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        type: "random_response",
      },
      {
        reason: "lease_lost",
        schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        type: "stop",
      },
      {
        code: "boundary_mismatch",
        schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        type: "abort",
      },
    ];
    for (const message of messages) {
      expect(ReplayWorkerToTargetMessageSchema.safeParse(message).success).toBe(true);
    }
    expect(
      ReplayWorkerToTargetMessageSchema.safeParse({
        ...messages[3],
        reason: "ignore_lease_and_continue",
      }).success,
    ).toBe(false);
  });
});

describe("replay target-to-worker process messages", () => {
  it("accepts ready, one sequenced boundary request, and counted completion", () => {
    const messages = [
      {
        schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        targetAdapter,
        type: "ready",
        workerProtocol,
      },
      request,
      {
        boundaryId: request.boundaryId,
        requestId: "rrq_clock_001",
        requestSequence: 1,
        schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        type: "clock_request",
      },
      {
        boundaryId: request.boundaryId,
        length: 1,
        requestId: "rrq_random_001",
        requestSequence: 2,
        schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        type: "random_request",
      },
      {
        requestCount: 3,
        schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        type: "completed",
      },
    ];
    for (const message of messages) {
      expect(ReplayTargetToWorkerMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it("rejects unknown message types, target authority expansion, and invalid sequences", () => {
    const candidates = [
      { ...request, requestSequence: -1 },
      { ...request, requestSequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...request, retry: true },
      {
        boundaryId: request.boundaryId,
        length: 65_537,
        requestId: "rrq_random_001",
        requestSequence: 1,
        schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        type: "random_request",
      },
      {
        requestCount: 0,
        schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        type: "log",
      },
    ];
    for (const candidate of candidates) {
      expect(ReplayTargetToWorkerMessageSchema.safeParse(candidate).success).toBe(false);
    }
  });
});
