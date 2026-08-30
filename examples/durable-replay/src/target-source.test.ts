import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProviderNeutralDurableTargetSource,
  DURABLE_REPLAY_BOUNDARIES,
  DURABLE_REPLAY_WORKER_PROTOCOL,
  PROVIDER_NEUTRAL_DURABLE_TARGET_ADAPTER,
} from "./target-source.js";

const temporaryDirectories: string[] = [];

function response(kind: "model" | "tool", outcome: "failed" | "succeeded") {
  return {
    output: {
      kind: "recorded_artifacts",
      response: { resolution: { recordedAttempt: { attempt: { outcome }, kind } } },
    },
  };
}

async function writeMessage(stream: Writable, message: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("provider-neutral durable replay target", () => {
  it("completes the exact recorded model and failed tool protocol without ambient I/O", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofstack-durable-target-test-"));
    temporaryDirectories.push(root);
    const path = join(root, "target.mjs");
    const source = createProviderNeutralDurableTargetSource({
      modelNormalizedRequest: Buffer.from("model-request", "utf8"),
      toolNormalizedRequest: Buffer.from("tool-request", "utf8"),
    });
    await writeFile(path, source, { mode: 0o500 });
    const child = spawn(process.execPath, [path], {
      env: {
        PROOFSTACK_EXAMPLE_HOLD_MILLISECONDS: "0",
        PROOFSTACK_WORKER_PROTOCOL_INPUT_FD: "3",
        PROOFSTACK_WORKER_PROTOCOL_OUTPUT_FD: "4",
      },
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    });
    const workerInput = child.stdio[3];
    const targetOutput = child.stdio[4];
    if (!(workerInput instanceof Writable) || !(targetOutput instanceof Readable)) {
      throw new Error("Target protocol pipes are unavailable");
    }
    const lines = createInterface({ crlfDelay: Infinity, input: targetOutput });
    const messages: unknown[] = [];
    lines.on("line", (line) => messages.push(JSON.parse(line)));
    const sessionId = "rts_reference_target_test";
    await writeMessage(workerInput, {
      boundaries: [
        {
          boundaryId: DURABLE_REPLAY_BOUNDARIES.model,
          invocation: {},
          invocationDefinitionSha256: "1".repeat(64),
          kind: "model",
          mode: "recorded_stub",
        },
        {
          boundaryId: DURABLE_REPLAY_BOUNDARIES.tool,
          invocation: {},
          invocationDefinitionSha256: "2".repeat(64),
          kind: "tool",
          mode: "recorded_stub",
        },
      ],
      schemaVersion: "0.2",
      sessionId,
      targetRelease: {
        targetAdapter: PROVIDER_NEUTRAL_DURABLE_TARGET_ADAPTER,
        workerProtocol: DURABLE_REPLAY_WORKER_PROTOCOL,
      },
      type: "start",
    });
    while (messages.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(messages[0]).toMatchObject({
      sessionId,
      targetAdapter: PROVIDER_NEUTRAL_DURABLE_TARGET_ADAPTER,
      type: "ready",
      workerProtocol: DURABLE_REPLAY_WORKER_PROTOCOL,
    });
    expect(messages[1]).toMatchObject({
      boundaryId: DURABLE_REPLAY_BOUNDARIES.model,
      request: {
        kind: "model",
        normalizedRequest: { bytes: Buffer.from("model-request").toString("base64url") },
      },
      requestSequence: 0,
      type: "boundary_request",
    });
    await writeMessage(workerInput, {
      boundaryId: DURABLE_REPLAY_BOUNDARIES.model,
      ...response("model", "succeeded"),
      requestSequence: 0,
      schemaVersion: "0.2",
      sessionId,
      type: "boundary_result",
    });
    while (messages.length < 3) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(messages[2]).toMatchObject({
      boundaryId: DURABLE_REPLAY_BOUNDARIES.tool,
      request: {
        kind: "tool",
        normalizedRequest: { bytes: Buffer.from("tool-request").toString("base64url") },
      },
      requestSequence: 1,
      type: "boundary_request",
    });
    await writeMessage(workerInput, {
      boundaryId: DURABLE_REPLAY_BOUNDARIES.tool,
      ...response("tool", "failed"),
      requestSequence: 1,
      schemaVersion: "0.2",
      sessionId,
      type: "boundary_result",
    });
    await once(child, "exit");
    expect(child.exitCode).toBe(0);
    expect(messages[3]).toEqual({
      requestCount: 2,
      schemaVersion: "0.2",
      sessionId,
      type: "completed",
    });
  });

  it("rejects missing request bytes and emits stable source for exact inputs", () => {
    expect(() =>
      createProviderNeutralDurableTargetSource({
        modelNormalizedRequest: new Uint8Array(),
        toolNormalizedRequest: Buffer.from("tool"),
      }),
    ).toThrow("modelNormalizedRequest");
    expect(() =>
      createProviderNeutralDurableTargetSource({
        modelNormalizedRequest: "model" as unknown as Uint8Array,
        toolNormalizedRequest: Buffer.from("tool"),
      }),
    ).toThrow("modelNormalizedRequest");
    expect(() =>
      createProviderNeutralDurableTargetSource({
        modelNormalizedRequest: Buffer.from("model"),
        toolNormalizedRequest: new Uint8Array(),
      }),
    ).toThrow("toolNormalizedRequest");
    const input = {
      modelNormalizedRequest: Buffer.from("model"),
      toolNormalizedRequest: Buffer.from("tool"),
    };
    expect(createProviderNeutralDurableTargetSource(input)).toBe(
      createProviderNeutralDurableTargetSource(input),
    );
  });
});
