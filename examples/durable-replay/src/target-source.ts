export const PROVIDER_NEUTRAL_DURABLE_TARGET_ADAPTER = {
  name: "proofstack.reference_durable_agent",
  protocolVersion: "0.2",
  version: "1.0.0",
} as const;

export const DURABLE_REPLAY_WORKER_PROTOCOL = {
  name: "proofstack.replay-worker",
  version: "2.0.0",
} as const;

export const DURABLE_REPLAY_BOUNDARIES = {
  model: "bnd_reference_model",
  tool: "bnd_reference_tool",
} as const;

export const DURABLE_REPLAY_HOLD_ENVIRONMENT_NAME = "PROOFSTACK_EXAMPLE_HOLD_MILLISECONDS" as const;

export interface ProviderNeutralDurableTargetSourceInput {
  readonly modelNormalizedRequest: Uint8Array;
  readonly toolNormalizedRequest: Uint8Array;
}

function encodedBytes(value: Uint8Array, label: string): string {
  if (!(value instanceof Uint8Array) || value.byteLength < 1) {
    throw new TypeError(`${label} must contain normalized request bytes`);
  }
  return Buffer.from(value).toString("base64url");
}

/**
 * Builds the exact audited target executable installed before a durable job is published.
 *
 * The executable is deliberately self-contained: it imports only Node standard-library stream
 * primitives, reads no files, opens no network sockets, receives worker messages only on fd 3,
 * and writes target messages only on fd 4. Captured normalized request bytes are embedded into the
 * release artifact so their digest is covered by the published executable hash.
 */
export function createProviderNeutralDurableTargetSource(
  input: ProviderNeutralDurableTargetSourceInput,
): string {
  const modelBytes = encodedBytes(input.modelNormalizedRequest, "modelNormalizedRequest");
  const toolBytes = encodedBytes(input.toolNormalizedRequest, "toolNormalizedRequest");
  const constants = JSON.stringify({
    boundaries: DURABLE_REPLAY_BOUNDARIES,
    holdEnvironmentName: DURABLE_REPLAY_HOLD_ENVIRONMENT_NAME,
    modelBytes,
    targetAdapter: PROVIDER_NEUTRAL_DURABLE_TARGET_ADAPTER,
    toolBytes,
    workerProtocol: DURABLE_REPLAY_WORKER_PROTOCOL,
  });

  return `import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";

const constants = ${constants};
const input = createReadStream("/dev/null", {
  autoClose: false,
  fd: Number(process.env.PROOFSTACK_WORKER_PROTOCOL_INPUT_FD),
});
const output = createWriteStream("/dev/null", {
  autoClose: false,
  fd: Number(process.env.PROOFSTACK_WORKER_PROTOCOL_OUTPUT_FD),
});
const hold = setInterval(() => undefined, 1_000);
let sessionId;
let phase = "awaiting_start";
let pendingTimer;

function fail() {
  clearInterval(hold);
  if (pendingTimer) clearTimeout(pendingTimer);
  process.exitCode = 1;
  input.destroy();
  output.end();
}

function finish() {
  clearInterval(hold);
  if (pendingTimer) clearTimeout(pendingTimer);
  process.exitCode = 0;
  input.destroy();
  output.end();
}

function send(message) {
  output.write(JSON.stringify(message) + "\\n");
}

function request(boundaryId, kind, bytes, requestSequence) {
  send({
    boundaryId,
    request: {
      boundaryRequestId: "brr_reference_" + kind,
      kind,
      normalizedRequest: {
        adapter: { name: "proofstack.reference." + kind, version: "1.0.0" },
        bytes,
        encoding: "base64url",
      },
      schemaVersion: "0.1",
    },
    requestSequence,
    schemaVersion: "0.2",
    sessionId,
    type: "boundary_request",
  });
}

function start(message) {
  const boundaries = message?.boundaries;
  if (
    phase !== "awaiting_start" ||
    message?.type !== "start" ||
    message?.schemaVersion !== "0.2" ||
    typeof message?.sessionId !== "string" ||
    JSON.stringify(message?.targetRelease?.targetAdapter) !==
      JSON.stringify(constants.targetAdapter) ||
    JSON.stringify(message?.targetRelease?.workerProtocol) !==
      JSON.stringify(constants.workerProtocol) ||
    !Array.isArray(boundaries) ||
    boundaries.length !== 2 ||
    boundaries[0]?.boundaryId !== constants.boundaries.model ||
    boundaries[0]?.kind !== "model" ||
    boundaries[0]?.mode !== "recorded_stub" ||
    boundaries[1]?.boundaryId !== constants.boundaries.tool ||
    boundaries[1]?.kind !== "tool" ||
    boundaries[1]?.mode !== "recorded_stub"
  ) {
    fail();
    return;
  }
  sessionId = message.sessionId;
  phase = "awaiting_model_result";
  send({
    schemaVersion: "0.2",
    sessionId,
    targetAdapter: constants.targetAdapter,
    type: "ready",
    workerProtocol: constants.workerProtocol,
  });
  const holdText = process.env[constants.holdEnvironmentName] ?? "0";
  const holdMilliseconds = Number(holdText);
  if (!Number.isSafeInteger(holdMilliseconds) || holdMilliseconds < 0 || holdMilliseconds > 10_000) {
    fail();
    return;
  }
  pendingTimer = setTimeout(() => {
    pendingTimer = undefined;
    request(constants.boundaries.model, "model", constants.modelBytes, 0);
  }, holdMilliseconds);
}

function boundaryResult(message) {
  const response = message?.output?.response?.resolution?.recordedAttempt;
  if (
    message?.type !== "boundary_result" ||
    message?.schemaVersion !== "0.2" ||
    message?.sessionId !== sessionId
  ) {
    fail();
    return;
  }
  if (phase === "awaiting_model_result") {
    if (
      message.boundaryId !== constants.boundaries.model ||
      message.requestSequence !== 0 ||
      response?.kind !== "model" ||
      response?.attempt?.outcome !== "succeeded"
    ) {
      fail();
      return;
    }
    phase = "awaiting_tool_result";
    request(constants.boundaries.tool, "tool", constants.toolBytes, 1);
    return;
  }
  if (
    phase !== "awaiting_tool_result" ||
    message.boundaryId !== constants.boundaries.tool ||
    message.requestSequence !== 1 ||
    response?.kind !== "tool" ||
    response?.attempt?.outcome !== "failed"
  ) {
    fail();
    return;
  }
  phase = "completed";
  send({ requestCount: 2, schemaVersion: "0.2", sessionId, type: "completed" });
  finish();
}

createInterface({ crlfDelay: Infinity, input }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail();
    return;
  }
  if (message?.type === "start") start(message);
  else if (message?.type === "boundary_result") boundaryResult(message);
  else if (message?.type === "stop" || message?.type === "abort") finish();
  else fail();
});
`;
}
