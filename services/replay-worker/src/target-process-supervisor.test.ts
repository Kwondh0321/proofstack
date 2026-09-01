import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RecordedBoundaryResponse,
  ReplayWorkerStartTargetMessage,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import type { PreparedTargetLaunch } from "./target-launch.js";
import {
  superviseReplayTargetProcess,
  type SuperviseReplayTargetProcessOptions,
} from "./target-process-supervisor.js";

const sha = (digit: string): string => digit.repeat(64);
const normalizedBytes = "e30";
const normalizedSha256 = createHash("sha256")
  .update(Buffer.from(normalizedBytes, "base64url"))
  .digest("hex");

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

const targetAdapter = {
  name: "proofstack.supervised_target",
  protocolVersion: "0.1",
  version: "1.0.0",
} as const;
const workerProtocol = { name: "proofstack.replay-worker", version: "0.1" } as const;

const startMessage: ReplayWorkerStartTargetMessage = {
  boundaries: [
    {
      boundaryId: "bnd_supervised",
      invocation: {
        fixture: {
          definitionSha256: sha("b"),
          fixtureId: "fix_supervised",
          fixtureVersionId: "fiv_supervised_001",
        },
        invocationId: "rpi_supervised_001",
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
        targetAdapter: { name: targetAdapter.name, version: targetAdapter.version },
      },
      invocationDefinitionSha256: sha("d"),
    },
  ],
  schemaVersion: "0.1",
  sessionId: "rts_supervised_001",
  targetRelease: {
    definitionSha256: sha("a"),
    targetAdapter,
    targetId: "tgt_supervised",
    targetReleaseId: "trg_supervised_001",
    workerProtocol,
  },
  type: "start",
};

const targetSource = String.raw`
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.argv[2];
if (mode === "ignore_kill") process.on("SIGTERM", () => undefined);
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
const exitAfterWrite = (code = 0) => {
  clearInterval(hold);
  process.exitCode = code;
  input.destroy();
  output.end();
};

createInterface({ crlfDelay: Infinity, input }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "start") {
    const ready = {
      schemaVersion: "0.1",
      sessionId: message.sessionId,
      targetAdapter: message.targetRelease.targetAdapter,
      type: "ready",
      workerProtocol: message.targetRelease.workerProtocol,
    };
    if (mode === "bad_message") {
      send({ nope: true });
      return;
    }
    if (mode === "incomplete_frame") {
      output.write("{\"type\":");
      exitAfterWrite();
      return;
    }
    send(ready);
    if (mode === "complete") {
      send({ requestCount: 0, schemaVersion: "0.1", sessionId: message.sessionId, type: "completed" });
      exitAfterWrite();
    } else if (mode === "completed_hang" || mode === "complete_overflow") {
      send({ requestCount: 0, schemaVersion: "0.1", sessionId: message.sessionId, type: "completed" });
      if (mode === "complete_overflow") setTimeout(() => process.stdout.write("x".repeat(64)), 10);
    } else if (mode === "clock_random") {
      send({ boundaryId: "bnd_supervised", requestId: "clk_001", requestSequence: 0, schemaVersion: "0.1", sessionId: message.sessionId, type: "clock_request" });
    } else if (mode === "boundary") {
      send({
        boundaryId: "bnd_supervised",
        request: {
          boundaryRequestId: "brr_supervised_001",
          kind: "tool",
          normalizedRequest: { adapterName: "proofstack.reference.tool", adapterVersion: "1.0.0", bytes: "e30", encoding: "base64url" },
          schemaVersion: "0.1",
        },
        requestSequence: 0,
        schemaVersion: "0.1",
        sessionId: message.sessionId,
        type: "boundary_request",
      });
    } else if (mode === "stdout_overflow") {
      process.stdout.write("x".repeat(64));
    } else if (mode === "stderr_overflow") {
      process.stderr.write("y".repeat(64));
    } else if (mode === "stdout_small") {
      process.stdout.write("ok");
      send({ requestCount: 0, schemaVersion: "0.1", sessionId: message.sessionId, type: "completed" });
      exitAfterWrite();
    } else if (mode === "stderr_small") {
      process.stderr.write("no");
      send({ requestCount: 0, schemaVersion: "0.1", sessionId: message.sessionId, type: "completed" });
      exitAfterWrite();
    } else if (mode === "exit_zero") {
      exitAfterWrite();
    } else if (mode === "exit_nonzero") {
      exitAfterWrite(7);
    }
    return;
  }
  if (message.type === "clock_response") {
    send({ boundaryId: "bnd_supervised", length: 3, requestId: "rnd_001", requestSequence: 1, schemaVersion: "0.1", sessionId: message.sessionId, type: "random_request" });
  } else if (message.type === "random_response") {
    send({ requestCount: 2, schemaVersion: "0.1", sessionId: message.sessionId, type: "completed" });
    exitAfterWrite();
  } else if (message.type === "boundary_response") {
    send({ requestCount: 1, schemaVersion: "0.1", sessionId: message.sessionId, type: "completed" });
    exitAfterWrite();
  } else if (
    (message.type === "stop" || message.type === "abort") &&
    mode !== "ignore_stop" &&
    mode !== "ignore_kill"
  ) {
    exitAfterWrite();
  }
});
`;

function boundaryResponse(): RecordedBoundaryResponse {
  return {
    artifacts: [],
    resolution: {
      actualRequest: {
        adapterName: "proofstack.reference.tool",
        adapterVersion: "1.0.0",
        boundaryRequestId: "brr_supervised_001",
        kind: "tool",
        normalizedRequestSha256: normalizedSha256,
        sizeBytes: 2,
      },
      expectedRequest: {
        adapterName: "proofstack.reference.tool",
        adapterVersion: "1.0.0",
        attemptId: "att_supervised_001",
        attemptSequence: 0,
        interactionId: "int_supervised_001",
        interactionSequence: 0,
        kind: "tool",
        normalizedRequestSha256: normalizedSha256,
      },
      recordedAttempt: {
        attempt: {
          artifacts: { argumentsArtifactId: "art_arguments" },
          attemptId: "att_supervised_001",
          effectMayHaveOccurred: false,
          endedAt: "2026-08-30T00:00:01.000Z",
          errorType: "recorded_failure",
          normalizedRequest: {
            adapterName: "proofstack.reference.tool",
            adapterVersion: "1.0.0",
            artifactId: "art_normalized",
            sha256: normalizedSha256,
          },
          outcome: "failed",
          sequence: 0,
          sideEffect: "read_only",
          startedAt: "2026-08-30T00:00:00.000Z",
        },
        callId: "call_supervised",
        interactionId: "int_supervised_001",
        interactionSequence: 0,
        kind: "tool",
      },
      returnedArtifacts: [],
    },
    schemaVersion: "0.1",
  };
}

interface Fixture {
  readonly cleanupCount: () => number;
  readonly options: SuperviseReplayTargetProcessOptions;
  readonly root: string;
}

async function fixture(
  mode: string,
  overrides: Partial<SuperviseReplayTargetProcessOptions> = {},
  useDefaultGrace = false,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "proofstack-supervisor-test-"));
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
      TARGET_MODE: mode,
    },
    executablePath: process.execPath,
    startMessage,
    targetRelease: {
      outputLimits: { emittedArtifactBytes: 1_024, stderrBytes: 16, stdoutBytes: 16 },
    },
    verifiedEntryPointPath: targetPath,
    workspacePath: root,
  } as unknown as PreparedTargetLaunch;
  return {
    cleanupCount: () => cleanupCount,
    options: {
      deadlineAtMs: Date.now() + 2_000,
      launch,
      resolveBoundary: async () => boundaryResponse(),
      ...(useDefaultGrace ? {} : { terminationGraceMs: 10 }),
      ...overrides,
    },
    root,
  };
}

describe("superviseReplayTargetProcess", () => {
  it("completes a real child over dedicated file descriptors and cleans its workspace", async () => {
    const value = await fixture("complete", {}, true);
    const result = await superviseReplayTargetProcess(value.options);
    expect(result).toMatchObject({
      exitCode: 0,
      failureCode: null,
      signal: null,
      status: "completed",
      stderr: { capturedBytes: 0, truncated: false },
      stdout: { capturedBytes: 0, truncated: false },
    });
    expect(result.runtime).toEqual([
      {
        boundaryId: "bnd_supervised",
        evidence: { fixedClockReadCount: 0, randomByteCount: 0, randomRequestCount: 0 },
        violated: false,
      },
    ]);
    expect(
      result.executionObservations.map(({ kind, ...observation }) => [kind, observation]),
    ).toEqual([
      [
        "target",
        expect.objectContaining({
          afterCancellationRequest: false,
          event: "started",
        }),
      ],
      [
        "target",
        expect.objectContaining({
          afterCancellationRequest: false,
          event: "exited",
          exitCode: 0,
        }),
      ],
    ]);
    expect(result.isolation.map(({ control, verdict }) => [control, verdict])).toEqual([
      ["environment_allowlist", "verified"],
      ["filesystem_mounts", "not_verified"],
      ["network_policy", "not_verified"],
      ["no_new_privileges", "not_verified"],
      ["output_limits", "verified"],
      ["process_boundary", "verified"],
      ["resource_limits", "not_verified"],
      ["subprocess_policy", "not_verified"],
    ]);
    expect(value.cleanupCount()).toBe(1);
  });

  it("serves deterministic clock, random, and exact recorded boundaries", async () => {
    const runtime = await fixture("clock_random");
    const runtimeResult = await superviseReplayTargetProcess(runtime.options);
    expect(runtimeResult.status).toBe("completed");
    expect(runtimeResult.runtime[0]?.evidence).toEqual({
      fixedClockReadCount: 1,
      randomByteCount: 3,
      randomRequestCount: 1,
    });

    const boundary = await fixture("boundary");
    const boundaryResult = await superviseReplayTargetProcess(boundary.options);
    expect(boundaryResult.failureCode).toBeNull();
    expect(boundaryResult.status).toBe("completed");
    expect(
      boundaryResult.executionObservations.flatMap((observation) =>
        observation.kind === "boundary" ? [observation.phase] : [],
      ),
    ).toEqual(["request_started", "response_observed"]);
  });

  it("fails closed when boundary resolution or the protocol is invalid", async () => {
    for (const failure of [new Error("fixture unavailable"), "fixture unavailable"] as const) {
      const boundary = await fixture("boundary", {
        resolveBoundary: async () => {
          throw failure;
        },
      });
      const result = await superviseReplayTargetProcess(boundary.options);
      expect(result).toMatchObject({
        failureCode: "boundary_resolution_failed",
        status: "failed",
      });
      expect(
        result.executionObservations.flatMap((observation) =>
          observation.kind === "boundary" ? [observation.phase] : [],
        ),
      ).toEqual(["request_started", "failed"]);
    }
    for (const mode of ["bad_message", "incomplete_frame"]) {
      const value = await fixture(mode);
      const result = await superviseReplayTargetProcess(value.options);
      expect(result, mode).toMatchObject({
        failureCode: "protocol_failed",
        status: "failed",
      });
    }
  });

  it("terminates on either stdout or stderr overflow and preserves bounded evidence", async () => {
    for (const [mode, stream] of [
      ["stdout_overflow", "stdout"],
      ["stderr_overflow", "stderr"],
    ] as const) {
      const value = await fixture(mode);
      const result = await superviseReplayTargetProcess(value.options);
      expect(result).toMatchObject({ failureCode: "output_limit_exceeded", status: "failed" });
      expect(result[stream]).toMatchObject({
        capturedBytes: 16,
        observedAtLeastBytes: 17,
        truncated: true,
      });
      expect(result.isolation.find(({ control }) => control === "output_limits")?.verdict).toBe(
        "failed",
      );
      expect(result.executionObservations).toContainEqual(
        expect.objectContaining({ event: `${stream}_capped`, kind: "target" }),
      );
    }
    for (const [mode, stream] of [
      ["stdout_small", "stdout"],
      ["stderr_small", "stderr"],
    ] as const) {
      const value = await fixture(mode);
      const result = await superviseReplayTargetProcess(value.options);
      expect(result.status).toBe("completed");
      expect(result[stream]).toMatchObject({ capturedBytes: 2, truncated: false });
    }

    const afterCompletion = await fixture("complete_overflow");
    await expect(superviseReplayTargetProcess(afterCompletion.options)).resolves.toMatchObject({
      failureCode: "output_limit_exceeded",
      status: "failed",
    });
  });

  it("honors cooperative and forced deadlines", { timeout: 10_000 }, async () => {
    const results = await Promise.all(
      (
        [
          ["hang", null],
          ["ignore_stop", "SIGTERM"],
          ["ignore_kill", "SIGKILL"],
        ] as const
      ).map(async ([mode, expectedSignal]) => {
        const value = await fixture(mode, { deadlineAtMs: Date.now() + 3_000 }, true);
        const result = await superviseReplayTargetProcess(value.options);
        return { expectedSignal, mode, result };
      }),
    );
    for (const { expectedSignal, mode, result } of results) {
      expect(result).toMatchObject({
        failureCode: "deadline_reached",
        status: "deadline_reached",
      });
      expect(result.signal, mode).toBe(expectedSignal);
    }
  });

  it("honors cancellation before and after process creation", async () => {
    const beforeController = new AbortController();
    beforeController.abort();
    const before = await fixture("hang", { signal: beforeController.signal });
    await expect(superviseReplayTargetProcess(before.options)).resolves.toMatchObject({
      exitCode: -1,
      failureCode: "worker_cancelled",
      status: "cancelled",
    });

    const activeController = new AbortController();
    const active = await fixture("hang", {
      cancellationRequested: () => activeController.signal.aborted,
      signal: activeController.signal,
    });
    setTimeout(() => activeController.abort(), 30);
    const activeResult = await superviseReplayTargetProcess(active.options);
    expect(activeResult).toMatchObject({
      failureCode: "worker_cancelled",
      status: "cancelled",
    });
    expect(activeResult.executionObservations.at(-1)).toMatchObject({
      afterCancellationRequest: true,
      event: "exited",
      kind: "target",
    });

    const completedController = new AbortController();
    const completed = await fixture("completed_hang", { signal: completedController.signal });
    setTimeout(() => completedController.abort(), 500);
    await expect(superviseReplayTargetProcess(completed.options)).resolves.toMatchObject({
      failureCode: "worker_cancelled",
      status: "cancelled",
    });

    const expired = await fixture("hang", { deadlineAtMs: Date.now() - 1 });
    await expect(superviseReplayTargetProcess(expired.options)).resolves.toMatchObject({
      exitCode: -1,
      failureCode: "deadline_reached",
      status: "deadline_reached",
    });
  });

  it("preserves cancellation when pending boundary resolution later fails", async () => {
    const controller = new AbortController();
    const resolutionStarted = deferred<void>();
    const resolution = deferred<RecordedBoundaryResponse>();
    const pending = await fixture("boundary", {
      resolveBoundary: async () => {
        resolutionStarted.resolve();
        return await resolution.promise;
      },
      signal: controller.signal,
    });

    const supervised = superviseReplayTargetProcess(pending.options);
    await resolutionStarted.promise;
    controller.abort();
    resolution.reject(new Error("fixture failed after cancellation"));

    await expect(supervised).resolves.toMatchObject({
      failureCode: "worker_cancelled",
      status: "cancelled",
    });
  });

  it("distinguishes an incomplete zero exit from a nonzero target failure", async () => {
    for (const [mode, failureCode, exitCode] of [
      ["exit_zero", "target_incomplete", 0],
      ["exit_nonzero", "target_exit_failed", 7],
    ] as const) {
      const value = await fixture(mode);
      const result = await superviseReplayTargetProcess(value.options);
      expect(result, mode).toMatchObject({
        exitCode,
        failureCode,
        status: "failed",
      });
    }
  });

  it("rejects invalid limits and reports an unavailable executable", async () => {
    const invalid = await fixture("complete", { terminationGraceMs: 0 });
    await expect(superviseReplayTargetProcess(invalid.options)).rejects.toMatchObject({
      code: "invalid_supervisor_options",
    });
    expect(invalid.cleanupCount()).toBe(1);

    const invalidFrame = await fixture("complete", { maxProtocolFrameBytes: 0 });
    await expect(superviseReplayTargetProcess(invalidFrame.options)).rejects.toMatchObject({
      code: "invalid_supervisor_options",
    });

    const distantDeadline = await fixture("complete", {
      deadlineAtMs: Number.MAX_SAFE_INTEGER,
    });
    await expect(superviseReplayTargetProcess(distantDeadline.options)).rejects.toMatchObject({
      code: "invalid_supervisor_options",
    });

    const missing = await fixture("complete");
    const missingLaunch = {
      ...missing.options.launch,
      executablePath: join(missing.root, "missing-runtime"),
    };
    await expect(
      superviseReplayTargetProcess({ ...missing.options, launch: missingLaunch }),
    ).resolves.toMatchObject({
      executionObservations: [],
      failureCode: "spawn_failed",
      isolation: expect.arrayContaining([
        expect.objectContaining({ control: "process_boundary", verdict: "not_verified" }),
      ]),
      status: "failed",
    });

    const invalidExecutable = await fixture("complete");
    const invalidLaunch = {
      ...invalidExecutable.options.launch,
      executablePath: "bad\0runtime",
    };
    await expect(
      superviseReplayTargetProcess({ ...invalidExecutable.options, launch: invalidLaunch }),
    ).rejects.toMatchObject({ code: "spawn_failed" });

    const undersizedStartFrame = await fixture("complete", { maxProtocolFrameBytes: 64 });
    await expect(superviseReplayTargetProcess(undersizedStartFrame.options)).resolves.toMatchObject(
      {
        failureCode: "protocol_failed",
        status: "failed",
      },
    );

    const messageLimit = await fixture("clock_random", { maxProtocolMessages: 1 });
    await expect(superviseReplayTargetProcess(messageLimit.options)).resolves.toMatchObject({
      failureCode: "protocol_failed",
      status: "failed",
    });
  });
});
