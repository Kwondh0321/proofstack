import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ReplayBoundaryExecutionRequest,
  ReplayBoundaryExecutionResult,
  ReplayWorkerStartTargetV2Message,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { ReplayLiveProviderBoundaryError } from "./errors.js";
import type { PreparedTargetLaunchV2 } from "./target-launch.js";
import {
  type SuperviseReplayTargetProcessV2Options,
  superviseReplayTargetProcessV2,
} from "./target-process-supervisor.js";

const sha = (digit: string): string => digit.repeat(64);
const requestBytes = Buffer.from("{}", "utf8").toString("base64url");
const requestSha256 = createHash("sha256")
  .update(Buffer.from(requestBytes, "base64url"))
  .digest("hex");
const boundaryAdapter = { name: "proofstack.boundary", version: "1.0.0" } as const;
const targetAdapter = {
  name: "proofstack.supervised_target",
  protocolVersion: "0.2",
  version: "2.0.0",
} as const;
const workerProtocol = { name: "proofstack.replay-worker", version: "0.2" } as const;
const invocation = {
  fixture: {
    definitionSha256: sha("1"),
    fixtureId: "fix_supervised",
    fixtureVersionId: "fiv_supervised_001",
  },
  invocationId: "rpi_supervised_001",
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
  schemaVersion: "0.2",
  sessionId: "session_supervised_002",
  targetRelease: {
    definitionSha256: sha("4"),
    targetAdapter,
    targetId: "target_supervised",
    targetReleaseId: "release_supervised_002",
    workerProtocol,
  },
  type: "start",
};

const targetSource = String.raw`
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.argv[2];
const input = createReadStream("/dev/null", {
  autoClose: false,
  fd: Number(process.env.PROOFSTACK_WORKER_PROTOCOL_INPUT_FD),
});
const output = createWriteStream("/dev/null", {
  autoClose: false,
  fd: Number(process.env.PROOFSTACK_WORKER_PROTOCOL_OUTPUT_FD),
});
const hold = setInterval(() => undefined, 1_000);
const send = (message) => output.write(JSON.stringify(message) + "\n");
const finish = () => {
  clearInterval(hold);
  input.destroy();
  output.end();
};
const boundaryRequest = (boundaryId, kind) => ({
  boundaryId,
  request: {
    boundaryRequestId: "request_supervised_001",
    kind,
    normalizedRequest: {
      adapter: { name: "proofstack.boundary", version: "1.0.0" },
      bytes: "e30",
      encoding: "base64url",
    },
    schemaVersion: "0.1",
  },
  requestSequence: 0,
  schemaVersion: "0.2",
  sessionId: "session_supervised_002",
  type: "boundary_request",
});

createInterface({ crlfDelay: Infinity, input }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "start") {
    send({
      schemaVersion: "0.2",
      sessionId: message.sessionId,
      targetAdapter: message.targetRelease.targetAdapter,
      type: "ready",
      workerProtocol: message.targetRelease.workerProtocol,
    });
    if (mode === "complete") {
      send({ requestCount: 0, schemaVersion: "0.2", sessionId: message.sessionId, type: "completed" });
      finish();
    } else if (mode === "live") {
      send(boundaryRequest("bnd_live", "model"));
    } else if (mode === "simulation") {
      send(boundaryRequest("bnd_simulation", "retrieval"));
    } else if (mode === "runtime") {
      send({ boundaryId: "bnd_recorded", requestId: "clock_001", requestSequence: 0, schemaVersion: "0.2", sessionId: message.sessionId, type: "clock_request" });
    }
    return;
  }
  if (message.type === "boundary_result") {
    send({ requestCount: 1, schemaVersion: "0.2", sessionId: message.sessionId, type: "completed" });
    finish();
  } else if (message.type === "clock_response") {
    send({ boundaryId: "bnd_recorded", length: 3, requestId: "random_001", requestSequence: 1, schemaVersion: "0.2", sessionId: message.sessionId, type: "random_request" });
  } else if (message.type === "random_response") {
    send({ requestCount: 2, schemaVersion: "0.2", sessionId: message.sessionId, type: "completed" });
    finish();
  } else if (message.type === "abort" || message.type === "stop") {
    finish();
  }
});
`;

function request(kind: "model" | "retrieval"): ReplayBoundaryExecutionRequest {
  return {
    boundaryRequestId: "request_supervised_001",
    kind,
    normalizedRequest: { adapter: boundaryAdapter, bytes: requestBytes, encoding: "base64url" },
    schemaVersion: "0.1",
  };
}

function normalizedResponse() {
  const bytes = Buffer.from("result", "utf8");
  return {
    adapter: boundaryAdapter,
    bytes: bytes.toString("base64url"),
    encoding: "base64url" as const,
    normalizedResponseSha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

function liveDeclaration() {
  return {
    boundaryId: "bnd_live",
    credential: {
      credentialId: "cred_supervised",
      credentialVersionId: "crv_supervised_001",
    },
    destination: { hostname: "api.example.com", port: 443 as const, scheme: "https" as const },
    endpointProfile: {
      definitionSha256: sha("5"),
      endpointProfileId: "end_supervised",
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

function simulationDeclaration() {
  return {
    boundaryId: "bnd_simulation",
    configurationSha256: sha("6"),
    kind: "retrieval" as const,
    mode: "simulation" as const,
    qualification: {
      artifactId: "art_qualification",
      classification: "internal" as const,
      mediaType: "application/json",
      sha256: sha("7"),
      sizeBytes: 128,
    },
    seedHex: sha("8"),
    simulatorRelease: {
      definitionSha256: sha("9"),
      targetAdapter,
      targetId: "target_simulator",
      targetReleaseId: "release_simulator_001",
      workerProtocol,
    },
  };
}

function result(mode: "live_provider" | "simulation"): ReplayBoundaryExecutionResult {
  const live = mode === "live_provider";
  const declaration = live ? liveDeclaration() : simulationDeclaration();
  const kind = live ? "model" : "retrieval";
  return {
    actualRequest: {
      adapter: boundaryAdapter,
      boundaryRequestId: "request_supervised_001",
      kind,
      normalizedRequestSha256: requestSha256,
      sizeBytes: 2,
    },
    boundaryId: declaration.boundaryId,
    declaration,
    effectCertainty: "none",
    executionOrigin: live ? "live" : "simulated",
    mode,
    output: { kind: "normalized_response", response: normalizedResponse() },
    schemaVersion: "0.1",
    usage: [
      {
        dimension: live ? "modelRequests" : "retrievedBytes",
        usage: { amount: 1, source: "measured", status: "observed" },
      },
    ],
  } as ReplayBoundaryExecutionResult;
}

interface Fixture {
  readonly cleanupCount: () => number;
  readonly options: SuperviseReplayTargetProcessV2Options;
}

async function fixture(
  mode: string,
  resolveBoundary: SuperviseReplayTargetProcessV2Options["resolveBoundary"],
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "proofstack-v2-supervisor-test-"));
  const targetPath = join(root, "target.mjs");
  await writeFile(targetPath, targetSource);
  let cleanupCount = 0;
  const launch = {
    arguments: [targetPath, mode],
    cleanup: async () => {
      cleanupCount += 1;
      await rm(root, { force: true, recursive: true });
    },
    environment: {
      PROOFSTACK_WORKER_PROTOCOL_INPUT_FD: "3",
      PROOFSTACK_WORKER_PROTOCOL_OUTPUT_FD: "4",
      PROOFSTACK_WORKER_WORKSPACE: root,
    },
    executablePath: process.execPath,
    startMessage,
    targetRelease: {
      outputLimits: { emittedArtifactBytes: 1_024, stderrBytes: 16, stdoutBytes: 16 },
    },
    verifiedEntryPointPath: targetPath,
    workspacePath: root,
  } as unknown as PreparedTargetLaunchV2;
  return {
    cleanupCount: () => cleanupCount,
    options: {
      deadlineAtMs: Date.now() + 2_000,
      launch,
      resolveBoundary,
      terminationGraceMs: 10,
    },
  };
}

function boundaryPhases(result: Awaited<ReturnType<typeof superviseReplayTargetProcessV2>>) {
  return result.executionObservations.flatMap((observation) =>
    observation.kind === "boundary"
      ? [
          {
            effectCertainty: observation.effectCertainty,
            executionOrigin: observation.executionOrigin,
            mode: observation.mode,
            phase: observation.phase,
          },
        ]
      : [],
  );
}

describe("superviseReplayTargetProcessV2", () => {
  it.each([
    ["live", "live_provider"],
    ["simulation", "simulation"],
  ] as const)("executes and retains one exact %s boundary result", async (targetMode, mode) => {
    const value = await fixture(targetMode, async ({ request: actual }) => {
      expect(actual).toEqual(request(mode === "live_provider" ? "model" : "retrieval"));
      return result(mode);
    });
    const supervised = await superviseReplayTargetProcessV2(value.options);
    expect(supervised).toMatchObject({
      exitCode: 0,
      failureCode: null,
      status: "completed",
    });
    expect(supervised.boundaryResults).toEqual([result(mode)]);
    expect(boundaryPhases(supervised)).toEqual([
      {
        effectCertainty: "none",
        executionOrigin: mode === "live_provider" ? "live" : "simulated",
        mode,
        phase: "request_started",
      },
      {
        effectCertainty: "none",
        executionOrigin: mode === "live_provider" ? "live" : "simulated",
        mode,
        phase: "response_observed",
      },
    ]);
    expect(supervised.runtime.map(({ boundaryId }) => boundaryId)).toEqual(["bnd_recorded"]);
    expect(value.cleanupCount()).toBe(1);
  });

  it("serves recorded runtime controls without creating opaque controls", async () => {
    const value = await fixture("runtime", async () => {
      throw new Error("Boundary resolver must not run");
    });
    const supervised = await superviseReplayTargetProcessV2(value.options);
    expect(supervised.status).toBe("completed");
    expect(supervised.boundaryResults).toEqual([]);
    expect(supervised.runtime).toEqual([
      {
        boundaryId: "bnd_recorded",
        evidence: { fixedClockReadCount: 1, randomByteCount: 3, randomRequestCount: 1 },
        violated: false,
      },
    ]);
  });

  it("preserves conservative live effect certainty on resolution failure", async () => {
    const failures: readonly [unknown, "confirmed" | "may_have_occurred" | "none"][] = [
      ["primitive failure", "none"],
      [null, "none"],
      [{ effectCertainty: "invalid" }, "none"],
      [
        new ReplayLiveProviderBoundaryError("provider_failed", {
          effectCertainty: "confirmed",
          effectRetrySafety: { evidenceSha256: sha("a"), kind: "read_only" },
        }),
        "confirmed",
      ],
      [
        new ReplayLiveProviderBoundaryError("provider_failed", {
          effectCertainty: "may_have_occurred",
          effectRetrySafety: { kind: "not_retryable" },
        }),
        "may_have_occurred",
      ],
    ];
    for (const [failure, effectCertainty] of failures) {
      const value = await fixture("live", async () => {
        throw failure;
      });
      const supervised = await superviseReplayTargetProcessV2(value.options);
      expect(supervised).toMatchObject({
        boundaryResults: [],
        failureCode: "boundary_resolution_failed",
        status: "failed",
      });
      expect(boundaryPhases(supervised).at(-1)).toEqual({
        effectCertainty,
        executionOrigin: "live",
        mode: "live_provider",
        phase: "failed",
      });
    }
  });

  it("returns an empty v2 result when cancellation wins before process start", async () => {
    const controller = new AbortController();
    controller.abort("shutdown");
    const value = await fixture("complete", async () => result("live_provider"));
    const supervised = await superviseReplayTargetProcessV2({
      ...value.options,
      signal: controller.signal,
    });
    expect(supervised).toMatchObject({
      boundaryResults: [],
      exitCode: -1,
      failureCode: "worker_cancelled",
      status: "cancelled",
    });
    expect(value.cleanupCount()).toBe(1);
  });
});
