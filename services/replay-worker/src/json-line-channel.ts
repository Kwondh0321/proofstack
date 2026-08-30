import {
  MAX_ARTIFACT_CONTENT_BYTES,
  type ReplayWorkerToTargetMessage,
  ReplayWorkerToTargetMessageSchema,
} from "@proofstack/contracts";
import { ReplayTargetChannelError, type ReplayTargetChannelErrorCode } from "./errors.js";

export const MAX_REPLAY_TARGET_PROTOCOL_FRAME_BYTES = MAX_ARTIFACT_CONTENT_BYTES * 4 + 1_048_576;

function assertFrameLimit(maxFrameBytes: number): void {
  if (
    !Number.isSafeInteger(maxFrameBytes) ||
    maxFrameBytes < 1 ||
    maxFrameBytes > MAX_REPLAY_TARGET_PROTOCOL_FRAME_BYTES
  ) {
    throw new RangeError("Replay target frame limit is outside the supported range");
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ReplayTargetJsonLineDecoder {
  private buffer = Buffer.alloc(0);
  private closed = false;
  private failed = false;
  private readonly textDecoder = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly maxFrameBytes: number) {
    assertFrameLimit(maxFrameBytes);
  }

  feed(chunk: Uint8Array): readonly Record<string, unknown>[] {
    this.requireOpen();
    if (chunk.byteLength === 0) return [];
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const messages: Record<string, unknown>[] = [];
    let newline = this.buffer.indexOf(0x0a);
    while (newline !== -1) {
      const frame = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      messages.push(this.parseFrame(frame));
      newline = this.buffer.indexOf(0x0a);
    }
    if (messages.length > 0) this.buffer = Buffer.from(this.buffer);
    if (this.buffer.byteLength > this.maxFrameBytes) this.fail("frame_too_large");
    return messages;
  }

  finish(): void {
    this.requireOpen();
    if (this.buffer.byteLength !== 0) this.fail("incomplete_frame");
    this.closed = true;
  }

  private fail(code: ReplayTargetChannelErrorCode, cause?: unknown): never {
    this.buffer = Buffer.alloc(0);
    this.failed = true;
    throw new ReplayTargetChannelError(code, cause === undefined ? undefined : { cause });
  }

  private parseFrame(frame: Uint8Array): Record<string, unknown> {
    if (frame.byteLength === 0 || frame.at(-1) === 0x0d) this.fail("invalid_frame");
    if (frame.byteLength > this.maxFrameBytes) this.fail("frame_too_large");
    let text: string;
    try {
      text = this.textDecoder.decode(frame);
    } catch (error) {
      this.fail("invalid_utf8", error);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.fail("invalid_frame", error);
    }
    if (!isJsonObject(parsed)) this.fail("invalid_frame");
    return parsed;
  }

  private requireOpen(): void {
    if (this.closed || this.failed) throw new ReplayTargetChannelError("channel_closed");
  }
}

export function encodeReplayWorkerMessage(input: unknown, maxFrameBytes: number): Uint8Array {
  assertFrameLimit(maxFrameBytes);
  const parsed = ReplayWorkerToTargetMessageSchema.safeParse(input);
  if (!parsed.success) {
    throw new ReplayTargetChannelError("invalid_worker_message", { cause: parsed.error });
  }
  const frame = Buffer.from(JSON.stringify(parsed.data), "utf8");
  if (frame.byteLength > maxFrameBytes) throw new ReplayTargetChannelError("frame_too_large");
  return Buffer.concat([frame, Buffer.from("\n", "utf8")]);
}

export function parseEncodedReplayWorkerMessage(
  value: Uint8Array,
  maxFrameBytes: number,
): ReplayWorkerToTargetMessage {
  const decoder = new ReplayTargetJsonLineDecoder(maxFrameBytes);
  const messages = decoder.feed(value);
  decoder.finish();
  if (messages.length !== 1) throw new ReplayTargetChannelError("invalid_worker_message");
  const parsed = ReplayWorkerToTargetMessageSchema.safeParse(messages[0]);
  if (!parsed.success) {
    throw new ReplayTargetChannelError("invalid_worker_message", { cause: parsed.error });
  }
  return parsed.data;
}
