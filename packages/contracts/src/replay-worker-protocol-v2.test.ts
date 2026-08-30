import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
  ReplayTargetToWorkerV2MessageSchema,
  ReplayWorkerToTargetV2MessageSchema,
} from "./replay-worker-protocol-v2.js";

const sha = (digit: string): string => digit.repeat(64);
const targetAdapter = {
  name: "proofstack.reference_target",
  protocolVersion: "0.2",
  version: "2.0.0",
} as const;
const workerProtocol = { name: "proofstack.replay-worker", version: "0.2" } as const;
const targetRelease = {
  definitionSha256: sha("1"),
  targetAdapter,
  targetId: "target_reference",
  targetReleaseId: "release_reference_002",
  workerProtocol,
} as const;

const invocation = {
  fixture: {
    definitionSha256: sha("2"),
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
      seedHex: sha("3"),
    },
    timeZone: "UTC",
  },
  schemaVersion: "0.1" as const,
  targetAdapter: { name: targetAdapter.name, version: targetAdapter.version },
};

const start = {
  boundaries: [
    { boundaryId: "bnd_live", kind: "model" as const, mode: "live_provider" as const },
    {
      boundaryId: "bnd_recorded",
      invocation,
      invocationDefinitionSha256: sha("4"),
      kind: "tool" as const,
      mode: "recorded_stub" as const,
    },
    { boundaryId: "bnd_simulation", kind: "retrieval" as const, mode: "simulation" as const },
  ],
  schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
  sessionId: "session_reference_002",
  targetRelease,
  type: "start" as const,
};

const boundaryRequest = {
  boundaryId: "bnd_live",
  request: {
    boundaryRequestId: "request_reference_001",
    kind: "model" as const,
    normalizedRequest: {
      adapter: { name: "proofstack.boundary", version: "1.0.0" },
      bytes: Buffer.from("{}", "utf8").toString("base64url"),
      encoding: "base64url" as const,
    },
    schemaVersion: "0.1" as const,
  },
  requestSequence: 0,
  schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
  sessionId: start.sessionId,
  type: "boundary_request" as const,
};

function normalizedOutput() {
  const bytes = Buffer.from("{}", "utf8");
  return {
    kind: "normalized_response" as const,
    response: {
      adapter: boundaryRequest.request.normalizedRequest.adapter,
      bytes: bytes.toString("base64url"),
      encoding: "base64url" as const,
      normalizedResponseSha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
    },
  };
}

describe("replay worker protocol v2 start projection", () => {
  it("accepts sorted multi-mode boundaries without exposing worker-owned authority", () => {
    expect(ReplayWorkerToTargetV2MessageSchema.parse(start)).toEqual(start);
    const keys = new Set<string>();
    JSON.stringify(start, (key, value: unknown) => {
      if (key !== "") keys.add(key);
      return value;
    });
    for (const forbidden of [
      "credentialId",
      "credentialVersionId",
      "destination",
      "endpointProfile",
      "fencingToken",
      "leaseId",
      "simulatorRelease",
      "workerFence",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("rejects duplicate, unsorted, expanded, and adapter-mismatched boundaries", () => {
    const recorded = start.boundaries[1];
    const candidates = [
      { ...start, boundaries: [] },
      { ...start, boundaries: [start.boundaries[2], start.boundaries[0]] },
      { ...start, boundaries: [start.boundaries[0], start.boundaries[0]] },
      {
        ...start,
        boundaries: [
          { ...start.boundaries[0], credentialId: "cred_forbidden" },
          start.boundaries[1],
          start.boundaries[2],
        ],
      },
      {
        ...start,
        boundaries: [
          start.boundaries[0],
          {
            ...recorded,
            invocation: {
              ...invocation,
              targetAdapter: { ...invocation.targetAdapter, version: "wrong" },
            },
          },
          start.boundaries[2],
        ],
      },
    ];
    for (const candidate of candidates) {
      expect(ReplayWorkerToTargetV2MessageSchema.safeParse(candidate).success).toBe(false);
    }
  });
});

describe("replay worker-to-target protocol v2 messages", () => {
  it("accepts projected boundary output, clock, random, stop, and abort messages", () => {
    const messages = [
      {
        boundaryId: boundaryRequest.boundaryId,
        output: normalizedOutput(),
        requestSequence: 0,
        schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        type: "boundary_result",
      },
      {
        boundaryId: "bnd_recorded",
        instant: invocation.runtime.clock.instant,
        requestId: "request_clock_001",
        requestSequence: 1,
        schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        type: "clock_response",
      },
      {
        boundaryId: "bnd_recorded",
        bytes: "AA",
        encoding: "base64url",
        requestId: "request_random_001",
        requestSequence: 2,
        schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        type: "random_response",
      },
      {
        reason: "lease_lost",
        schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        type: "stop",
      },
      {
        code: "boundary_mismatch",
        schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        type: "abort",
      },
    ];
    for (const message of messages) {
      expect(ReplayWorkerToTargetV2MessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it("rejects old versions, complete execution evidence, and invalid response output", () => {
    const base = {
      boundaryId: boundaryRequest.boundaryId,
      output: normalizedOutput(),
      requestSequence: 0,
      schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
      sessionId: start.sessionId,
      type: "boundary_result",
    };
    const candidates = [
      { ...base, schemaVersion: "0.1" },
      { ...base, declaration: { credential: "forbidden" } },
      { ...base, output: { ...normalizedOutput(), fallback: "recorded" } },
    ];
    for (const candidate of candidates) {
      expect(ReplayWorkerToTargetV2MessageSchema.safeParse(candidate).success).toBe(false);
    }
  });
});

describe("replay target-to-worker protocol v2 messages", () => {
  it("accepts ready, generalized boundary, recorded runtime, and completion messages", () => {
    const messages = [
      {
        schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        targetAdapter,
        type: "ready",
        workerProtocol,
      },
      boundaryRequest,
      {
        boundaryId: "bnd_recorded",
        requestId: "request_clock_001",
        requestSequence: 1,
        schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        type: "clock_request",
      },
      {
        boundaryId: "bnd_recorded",
        length: 1,
        requestId: "request_random_001",
        requestSequence: 2,
        schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        type: "random_request",
      },
      {
        requestCount: 3,
        schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        type: "completed",
      },
    ];
    for (const message of messages) {
      expect(ReplayTargetToWorkerV2MessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it("rejects authority expansion, old requests, oversized randomness, and invalid sequences", () => {
    const candidates = [
      { ...boundaryRequest, requestSequence: -1 },
      { ...boundaryRequest, credentialId: "cred_forbidden" },
      {
        ...boundaryRequest,
        request: {
          ...boundaryRequest.request,
          normalizedRequest: {
            adapterName: "legacy",
            adapterVersion: "0.1",
            bytes: "e30",
            encoding: "base64url",
          },
        },
      },
      {
        boundaryId: "bnd_recorded",
        length: 65_537,
        requestId: "request_random_001",
        requestSequence: 1,
        schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
        sessionId: start.sessionId,
        type: "random_request",
      },
    ];
    for (const candidate of candidates) {
      expect(ReplayTargetToWorkerV2MessageSchema.safeParse(candidate).success).toBe(false);
    }
  });
});
