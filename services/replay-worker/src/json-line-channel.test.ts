import {
  REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
  REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
  type ReplayWorkerStopTargetMessage,
  type ReplayWorkerStopTargetV2Message,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { ReplayTargetChannelError } from "./errors.js";
import {
  encodeReplayWorkerMessage,
  encodeReplayWorkerV2Message,
  MAX_REPLAY_TARGET_PROTOCOL_FRAME_BYTES,
  parseEncodedReplayWorkerMessage,
  parseEncodedReplayWorkerV2Message,
  ReplayTargetJsonLineDecoder,
} from "./json-line-channel.js";

const message: ReplayWorkerStopTargetMessage = {
  reason: "worker_shutdown",
  schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
  sessionId: "rts_channel_001",
  type: "stop",
};

const v2Message: ReplayWorkerStopTargetV2Message = {
  reason: "worker_shutdown",
  schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
  sessionId: "rts_channel_002",
  type: "stop",
};

function expectChannelCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected replay target channel failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ReplayTargetChannelError);
    expect((error as ReplayTargetChannelError).code).toBe(code);
  }
}

describe("replay target JSON-line decoding", () => {
  it("decodes fragmented and adjacent object frames without accepting trailing data", () => {
    const decoder = new ReplayTargetJsonLineDecoder(1_024);
    expect(decoder.feed(Buffer.alloc(0))).toEqual([]);
    expect(decoder.feed(Buffer.from('{"type":"ready"'))).toEqual([]);
    expect(
      decoder.feed(
        Buffer.from('}\n{"type":"completed","requestCount":0}\n{"type":"clock_request"'),
      ),
    ).toEqual([{ type: "ready" }, { requestCount: 0, type: "completed" }]);
    expect(decoder.feed(Buffer.from("}\n"))).toEqual([{ type: "clock_request" }]);
    decoder.finish();
    expectChannelCode(() => decoder.feed(Buffer.from("{}\n")), "channel_closed");
  });

  it("rejects invalid limits before retaining any process bytes", () => {
    for (const limit of [0, 0.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => new ReplayTargetJsonLineDecoder(limit)).toThrow(RangeError);
    }
  });

  it.each([
    [Buffer.from("\n"), "invalid_frame"],
    [Buffer.from("{}\r\n"), "invalid_frame"],
    [Buffer.from("[]\n"), "invalid_frame"],
    [Buffer.from("null\n"), "invalid_frame"],
    [Buffer.from("{]\n"), "invalid_frame"],
    [Uint8Array.of(0xc3, 0x28, 0x0a), "invalid_utf8"],
  ])("rejects a non-canonical frame with %s", (frame, code) => {
    const decoder = new ReplayTargetJsonLineDecoder(32);
    expectChannelCode(() => decoder.feed(frame), code);
    expectChannelCode(() => decoder.finish(), "channel_closed");
  });

  it("rejects over-limit complete and unterminated frames and incomplete EOF", () => {
    const complete = new ReplayTargetJsonLineDecoder(2);
    expectChannelCode(() => complete.feed(Buffer.from("{} \n")), "frame_too_large");

    const unterminated = new ReplayTargetJsonLineDecoder(2);
    expectChannelCode(() => unterminated.feed(Buffer.from("abc")), "frame_too_large");

    const incomplete = new ReplayTargetJsonLineDecoder(32);
    incomplete.feed(Buffer.from("{}"));
    expectChannelCode(() => incomplete.finish(), "incomplete_frame");
  });
});

describe("replay worker JSON-line encoding", () => {
  it("encodes and parses exactly one strict worker message", () => {
    const encoded = encodeReplayWorkerMessage(message, 1_024);
    expect(Buffer.from(encoded).at(-1)).toBe(0x0a);
    expect(parseEncodedReplayWorkerMessage(encoded, 1_024)).toEqual(message);
  });

  it("rejects expanded messages, small limits, and multiple encoded messages", () => {
    expectChannelCode(
      () => encodeReplayWorkerMessage({ ...message, shell: true }, 1_024),
      "invalid_worker_message",
    );
    expectChannelCode(() => encodeReplayWorkerMessage(message, 1), "frame_too_large");
    const encoded = encodeReplayWorkerMessage(message, 1_024);
    expectChannelCode(
      () =>
        parseEncodedReplayWorkerMessage(
          Buffer.concat([Buffer.from(encoded), Buffer.from(encoded)]),
          1_024,
        ),
      "invalid_worker_message",
    );
    expect(() =>
      encodeReplayWorkerMessage(message, MAX_REPLAY_TARGET_PROTOCOL_FRAME_BYTES + 1),
    ).toThrow(RangeError);
  });

  it("rejects a framed object that is not a worker-to-target message", () => {
    expectChannelCode(
      () => parseEncodedReplayWorkerMessage(Buffer.from('{"type":"ready"}\n'), 1_024),
      "invalid_worker_message",
    );
  });

  it("keeps v2 encoding strict and version-separated from recorded-only messages", () => {
    const encoded = encodeReplayWorkerV2Message(v2Message, 1_024);
    expect(Buffer.from(encoded).at(-1)).toBe(0x0a);
    expect(parseEncodedReplayWorkerV2Message(encoded, 1_024)).toEqual(v2Message);
    expectChannelCode(() => encodeReplayWorkerV2Message(message, 1_024), "invalid_worker_message");
    expectChannelCode(() => encodeReplayWorkerMessage(v2Message, 1_024), "invalid_worker_message");
    expectChannelCode(
      () => encodeReplayWorkerV2Message({ ...v2Message, command: "forbidden" }, 1_024),
      "invalid_worker_message",
    );
    expectChannelCode(() => encodeReplayWorkerV2Message(v2Message, 1), "frame_too_large");
    expectChannelCode(
      () =>
        parseEncodedReplayWorkerV2Message(
          Buffer.concat([Buffer.from(encoded), Buffer.from(encoded)]),
          1_024,
        ),
      "invalid_worker_message",
    );
    expectChannelCode(
      () => parseEncodedReplayWorkerV2Message(Buffer.from('{"type":"ready"}\n'), 1_024),
      "invalid_worker_message",
    );
    expect(() =>
      encodeReplayWorkerV2Message(v2Message, MAX_REPLAY_TARGET_PROTOCOL_FRAME_BYTES + 1),
    ).toThrow(RangeError);
  });
});
