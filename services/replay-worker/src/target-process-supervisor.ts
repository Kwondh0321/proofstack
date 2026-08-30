import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type {
  RecordedBoundaryRequest,
  RecordedBoundaryResponse,
  RecordedBoundaryReplayRuntimeEvidence,
  ReplayExecutionObservationPayload,
  ReplayTargetProcessStopReason,
  ReplayWorkerToTargetMessage,
} from "@proofstack/contracts";
import {
  createRecordedBoundaryRuntimeControls,
  type RecordedBoundaryRuntimeControls,
  ReplayTargetProcessSession,
} from "@proofstack/replay";
import { BoundedReplayTargetOutput, type ReplayTargetOutputEvidence } from "./bounded-output.js";
import { ReplayTargetSupervisorError, type ReplayTargetSupervisorFailureCode } from "./errors.js";
import {
  encodeReplayWorkerMessage,
  MAX_REPLAY_TARGET_PROTOCOL_FRAME_BYTES,
  ReplayTargetJsonLineDecoder,
} from "./json-line-channel.js";
import type { PreparedTargetLaunch } from "./target-launch.js";

export const DEFAULT_REPLAY_TARGET_TERMINATION_GRACE_MS = 1_000;
export const MAX_REPLAY_TARGET_PROTOCOL_MESSAGES = 10_000;
export const MAX_REPLAY_TARGET_TIMER_DELAY_MS = 2_147_483_647;

export interface ResolveReplayTargetBoundaryInput {
  readonly boundaryId: string;
  readonly request: RecordedBoundaryRequest;
}

export interface SuperviseReplayTargetProcessOptions {
  readonly cancellationRequested?: () => boolean;
  readonly deadlineAtMs: number;
  readonly launch: PreparedTargetLaunch;
  readonly maxProtocolFrameBytes?: number;
  readonly maxProtocolMessages?: number;
  readonly resolveBoundary: (
    input: ResolveReplayTargetBoundaryInput,
  ) => Promise<RecordedBoundaryResponse>;
  readonly signal?: AbortSignal;
  readonly terminationGraceMs?: number;
}

export type ReplayTargetProcessStatus = "cancelled" | "completed" | "deadline_reached" | "failed";

export interface ReplayTargetRuntimeEvidence {
  readonly boundaryId: string;
  readonly evidence: RecordedBoundaryReplayRuntimeEvidence;
  readonly violated: boolean;
}

export interface ReplayTargetProcessResult {
  readonly executionObservations: readonly Exclude<
    ReplayExecutionObservationPayload,
    { kind: "cancellation" | "isolation" }
  >[];
  readonly exitCode: number;
  readonly failureCode: ReplayTargetSupervisorFailureCode | null;
  readonly isolation: readonly Extract<ReplayExecutionObservationPayload, { kind: "isolation" }>[];
  readonly runtime: readonly ReplayTargetRuntimeEvidence[];
  readonly signal: NodeJS.Signals | null;
  readonly status: ReplayTargetProcessStatus;
  readonly stderr: ReplayTargetOutputEvidence;
  readonly stdout: ReplayTargetOutputEvidence;
}

type Termination = {
  readonly failureCode: ReplayTargetSupervisorFailureCode;
  readonly status: Exclude<ReplayTargetProcessStatus, "completed">;
  readonly stopReason?: ReplayTargetProcessStopReason;
};

function assertSafePositive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ReplayTargetSupervisorError("invalid_supervisor_options", {
      cause: new RangeError(`${name} must be a safe positive integer`),
    });
  }
}

function evidenceSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function isolationEvidence(
  spawned: boolean,
  outputLimitsVerified: boolean,
): ReplayTargetProcessResult["isolation"] {
  const verdicts = [
    ["environment_allowlist", "verified"],
    ["filesystem_mounts", "not_verified"],
    ["network_policy", "not_verified"],
    ["no_new_privileges", "not_verified"],
    ["output_limits", outputLimitsVerified ? "verified" : "failed"],
    ["process_boundary", spawned ? "verified" : "not_verified"],
    ["resource_limits", "not_verified"],
    ["subprocess_policy", "not_verified"],
  ] as const;
  return Object.freeze(
    verdicts.map(([control, verdict]) =>
      Object.freeze({
        control,
        evidenceSha256: evidenceSha256({ control, verdict }),
        kind: "isolation" as const,
        verdict,
      }),
    ),
  );
}

function runtimeControls(
  launch: PreparedTargetLaunch,
): ReadonlyMap<string, RecordedBoundaryRuntimeControls> {
  return new Map(
    launch.startMessage.boundaries.map((boundary) => [
      boundary.boundaryId,
      createRecordedBoundaryRuntimeControls(boundary.invocation.runtime),
    ]),
  );
}

function runtimeEvidence(
  controls: ReadonlyMap<string, RecordedBoundaryRuntimeControls>,
): readonly ReplayTargetRuntimeEvidence[] {
  return Object.freeze(
    [...controls.entries()].map(([boundaryId, control]) => {
      control.close();
      return Object.freeze({
        boundaryId,
        evidence: Object.freeze(control.evidence()),
        violated: control.violated,
      });
    }),
  );
}

function emptyOutput(stream: "stderr" | "stdout", limitBytes: number): ReplayTargetOutputEvidence {
  return new BoundedReplayTargetOutput(stream, limitBytes).finish();
}

function stoppedBeforeStart(
  options: SuperviseReplayTargetProcessOptions,
  termination: Termination,
): ReplayTargetProcessResult {
  const controls = runtimeControls(options.launch);
  return Object.freeze({
    executionObservations: Object.freeze([]),
    exitCode: -1,
    failureCode: termination.failureCode,
    isolation: isolationEvidence(false, false),
    runtime: runtimeEvidence(controls),
    signal: null,
    status: termination.status,
    stderr: emptyOutput("stderr", options.launch.targetRelease.outputLimits.stderrBytes),
    stdout: emptyOutput("stdout", options.launch.targetRelease.outputLimits.stdoutBytes),
  });
}

function protocolStreams(child: ChildProcess): {
  readonly input: Writable;
  readonly output: Readable;
  readonly stderr: Readable;
  readonly stdout: Readable;
} {
  return {
    input: child.stdio[3] as Writable,
    output: child.stdio[4] as Readable,
    stderr: child.stderr as Readable,
    stdout: child.stdout as Readable,
  };
}

function spawnTarget(launch: PreparedTargetLaunch): ChildProcess {
  return spawn(launch.executablePath, launch.arguments, {
    cwd: launch.workspacePath,
    env: launch.environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

export async function superviseReplayTargetProcess(
  options: SuperviseReplayTargetProcessOptions,
): Promise<ReplayTargetProcessResult> {
  const graceMs = options.terminationGraceMs ?? DEFAULT_REPLAY_TARGET_TERMINATION_GRACE_MS;
  const maxFrameBytes = options.maxProtocolFrameBytes ?? MAX_REPLAY_TARGET_PROTOCOL_FRAME_BYTES;
  const maxMessages = options.maxProtocolMessages ?? MAX_REPLAY_TARGET_PROTOCOL_MESSAGES;
  let decoder: ReplayTargetJsonLineDecoder;
  try {
    assertSafePositive(options.deadlineAtMs, "deadlineAtMs");
    assertSafePositive(graceMs, "terminationGraceMs");
    assertSafePositive(maxMessages, "maxProtocolMessages");
    if (options.deadlineAtMs - Date.now() > MAX_REPLAY_TARGET_TIMER_DELAY_MS) {
      throw new RangeError("deadlineAtMs exceeds the maximum safe timer delay");
    }
    decoder = new ReplayTargetJsonLineDecoder(maxFrameBytes);
  } catch (error) {
    await options.launch.cleanup();
    throw new ReplayTargetSupervisorError("invalid_supervisor_options", { cause: error });
  }

  if (options.signal?.aborted) {
    try {
      return stoppedBeforeStart(options, {
        failureCode: "worker_cancelled",
        status: "cancelled",
      });
    } finally {
      await options.launch.cleanup();
    }
  }
  if (options.deadlineAtMs <= Date.now()) {
    try {
      return stoppedBeforeStart(options, {
        failureCode: "deadline_reached",
        status: "deadline_reached",
      });
    } finally {
      await options.launch.cleanup();
    }
  }

  const session = new ReplayTargetProcessSession(options.launch.startMessage);
  const controls = runtimeControls(options.launch);
  const stdout = new BoundedReplayTargetOutput(
    "stdout",
    options.launch.targetRelease.outputLimits.stdoutBytes,
  );
  const stderr = new BoundedReplayTargetOutput(
    "stderr",
    options.launch.targetRelease.outputLimits.stderrBytes,
  );
  const executionObservations: Exclude<
    ReplayExecutionObservationPayload,
    { kind: "cancellation" | "isolation" }
  >[] = [];
  const afterCancellationRequest = (): boolean => options.cancellationRequested?.() === true;
  const recordExecutionObservation = (
    payload: Exclude<ReplayExecutionObservationPayload, { kind: "cancellation" | "isolation" }>,
  ): void => {
    executionObservations.push(Object.freeze(payload));
  };
  let child: ChildProcess;
  try {
    child = spawnTarget(options.launch);
  } catch (error) {
    await options.launch.cleanup();
    throw new ReplayTargetSupervisorError("spawn_failed", { cause: error });
  }

  const streams = protocolStreams(child);

  let messageCount = 0;
  let processing = Promise.resolve();
  let protocolEnded = false;
  let targetCompleted = false;
  let processSpawned = false;
  let termination: Termination | undefined;
  let termTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  const writeMessage = (message: ReplayWorkerToTargetMessage): Promise<void> =>
    new Promise((resolve, reject) => {
      const frame = encodeReplayWorkerMessage(message, maxFrameBytes);
      streams.input.write(frame, (error) => (error ? reject(error) : resolve()));
    });

  const bestEffortMessage = (message: ReplayWorkerToTargetMessage): void => {
    try {
      streams.input.write(encodeReplayWorkerMessage(message, maxFrameBytes), () => undefined);
    } catch {
      // Termination still proceeds through signals when the protocol pipe is unavailable.
    }
  };

  const abortSession = (
    code: Parameters<ReplayTargetProcessSession["abort"]>[0],
  ): ReplayWorkerToTargetMessage | undefined => {
    try {
      return session.abort(code);
    } catch {
      return undefined;
    }
  };

  const stopSession = (
    reason: ReplayTargetProcessStopReason,
  ): ReplayWorkerToTargetMessage | undefined => {
    try {
      return session.stop(reason);
    } catch {
      return undefined;
    }
  };

  const beginTermination = (next: Termination, message?: ReplayWorkerToTargetMessage): void => {
    if (termination) return;
    termination = next;
    if (message) bestEffortMessage(message);
    termTimer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), graceMs);
    }, graceMs);
  };

  const failProtocol = (error: unknown): void => {
    let abortMessage: ReplayWorkerToTargetMessage | undefined;
    try {
      abortMessage =
        session.snapshot().status === "failed"
          ? session.protocolFailureMessage()
          : session.abort("session_contract_rejected");
    } catch {
      abortMessage = undefined;
    }
    beginTermination({ failureCode: "protocol_failed", status: "failed" }, abortMessage);
    void error;
  };

  const handleMessage = async (input: unknown): Promise<void> => {
    messageCount += 1;
    if (messageCount > maxMessages) {
      throw new ReplayTargetSupervisorError("protocol_failed");
    }
    const message = session.acceptTargetMessage(input);
    if (message.type === "boundary_request") {
      const boundaryEvidence = {
        boundaryId: message.boundaryId,
        boundaryKind: message.request.kind,
        requestSequence: message.requestSequence,
      } as const;
      recordExecutionObservation({
        afterCancellationRequest: afterCancellationRequest(),
        boundaryId: message.boundaryId,
        boundaryKind: message.request.kind,
        effectCertainty: "none",
        evidenceSha256: evidenceSha256({ ...boundaryEvidence, phase: "request_started" }),
        executionOrigin: "recorded",
        kind: "boundary",
        mode: "recorded_stub",
        phase: "request_started",
      });
      let response: RecordedBoundaryResponse;
      try {
        response = await options.resolveBoundary({
          boundaryId: message.boundaryId,
          request: message.request,
        });
      } catch (error) {
        recordExecutionObservation({
          afterCancellationRequest: afterCancellationRequest(),
          boundaryId: message.boundaryId,
          boundaryKind: message.request.kind,
          effectCertainty: "none",
          evidenceSha256: evidenceSha256({
            ...boundaryEvidence,
            errorType: error instanceof Error ? error.name : typeof error,
            phase: "failed",
          }),
          executionOrigin: "recorded",
          kind: "boundary",
          mode: "recorded_stub",
          phase: "failed",
        });
        beginTermination(
          { failureCode: "boundary_resolution_failed", status: "failed" },
          abortSession("boundary_contract_rejected"),
        );
        void error;
        return;
      }
      recordExecutionObservation({
        afterCancellationRequest: afterCancellationRequest(),
        boundaryId: message.boundaryId,
        boundaryKind: message.request.kind,
        effectCertainty: "none",
        evidenceSha256: evidenceSha256({
          ...boundaryEvidence,
          phase: "response_observed",
          response,
        }),
        executionOrigin: "recorded",
        kind: "boundary",
        mode: "recorded_stub",
        phase: "response_observed",
      });
      await writeMessage(session.respondToBoundary(response));
      return;
    }
    if (message.type === "clock_request") {
      controls.get(message.boundaryId)?.now();
      await writeMessage(session.respondToClock());
      return;
    }
    if (message.type === "random_request") {
      const control = controls.get(message.boundaryId) as RecordedBoundaryRuntimeControls;
      await writeMessage(session.respondToRandom(control.randomBytes(message.length)));
      return;
    }
    if (message.type === "completed") {
      targetCompleted = true;
      streams.input.end();
    }
  };

  const enqueue = (action: () => Promise<void> | void): void => {
    processing = processing.then(action).catch(failProtocol);
  };

  streams.output.on("data", (chunk: Buffer) => {
    enqueue(async () => {
      for (const message of decoder.feed(chunk)) await handleMessage(message);
    });
  });
  streams.output.on("end", () => {
    enqueue(() => {
      decoder.finish();
      protocolEnded = true;
    });
  });
  streams.output.on("error", failProtocol);
  streams.input.on("error", failProtocol);
  streams.stdout.on("data", (chunk: Buffer) => {
    if (stdout.write(chunk)) {
      recordExecutionObservation({
        afterCancellationRequest: afterCancellationRequest(),
        evidenceSha256: evidenceSha256(stdout.finish()),
        event: "stdout_capped",
        kind: "target",
      });
      beginTermination(
        { failureCode: "output_limit_exceeded", status: "failed" },
        abortSession("worker_internal_error"),
      );
    }
  });
  streams.stderr.on("data", (chunk: Buffer) => {
    if (stderr.write(chunk)) {
      recordExecutionObservation({
        afterCancellationRequest: afterCancellationRequest(),
        evidenceSha256: evidenceSha256(stderr.finish()),
        event: "stderr_capped",
        kind: "target",
      });
      beginTermination(
        { failureCode: "output_limit_exceeded", status: "failed" },
        abortSession("worker_internal_error"),
      );
    }
  });

  const abortListener = () => {
    beginTermination(
      {
        failureCode: "worker_cancelled",
        status: "cancelled",
        stopReason: "cancellation_requested",
      },
      stopSession("cancellation_requested"),
    );
  };
  options.signal?.addEventListener("abort", abortListener, { once: true });
  const deadlineTimer = setTimeout(() => {
    beginTermination(
      {
        failureCode: "deadline_reached",
        status: "deadline_reached",
        stopReason: "deadline_reached",
      },
      stopSession("deadline_reached"),
    );
  }, options.deadlineAtMs - Date.now());

  const resultPromise = new Promise<ReplayTargetProcessResult>((resolve) => {
    child.once("spawn", () => {
      processSpawned = true;
      recordExecutionObservation({
        afterCancellationRequest: afterCancellationRequest(),
        evidenceSha256: evidenceSha256({
          event: "started",
          targetRelease: options.launch.startMessage.targetRelease,
        }),
        event: "started",
        kind: "target",
      });
    });
    child.once("error", (error) => {
      beginTermination({ failureCode: "spawn_failed", status: "failed" });
      void error;
    });
    child.once("close", (code, signal) => {
      void (async () => {
        await processing;
        if (processSpawned) {
          recordExecutionObservation({
            afterCancellationRequest: afterCancellationRequest(),
            evidenceSha256: evidenceSha256({ code: code ?? -1, event: "exited", signal }),
            event: "exited",
            exitCode: code ?? -1,
            kind: "target",
          });
        }
        clearTimeout(deadlineTimer);
        if (termTimer) clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", abortListener);
        if (!termination) {
          termination =
            code === 0 && targetCompleted && protocolEnded
              ? undefined
              : {
                  failureCode: code === 0 ? "target_incomplete" : "target_exit_failed",
                  status: "failed",
                };
        }
        const outputLimitsVerified = !stdout.finish().truncated && !stderr.finish().truncated;
        const result = Object.freeze({
          executionObservations: Object.freeze([...executionObservations]),
          exitCode: code ?? -1,
          failureCode: termination?.failureCode ?? null,
          isolation: isolationEvidence(processSpawned, outputLimitsVerified),
          runtime: runtimeEvidence(controls),
          signal,
          status: termination?.status ?? "completed",
          stderr: stderr.finish(),
          stdout: stdout.finish(),
        });
        try {
          await options.launch.cleanup();
        } finally {
          resolve(result);
        }
      })();
    });
  });
  const startMessage = session.start();
  try {
    await writeMessage(startMessage);
  } catch (error) {
    failProtocol(error);
  }
  return await resultPromise;
}
