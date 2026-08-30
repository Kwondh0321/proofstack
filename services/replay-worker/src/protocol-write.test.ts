import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { writeReplayTargetProtocolFrame } from "./protocol-write.js";

function protocolInput(result?: Error): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback(result);
    },
  });
}

describe("writeReplayTargetProtocolFrame", () => {
  it("resolves only after the frame is accepted", async () => {
    await expect(
      writeReplayTargetProtocolFrame(protocolInput(), new Uint8Array([1, 2, 3])),
    ).resolves.toBeUndefined();
  });

  it("rejects deterministic asynchronous pipe failures", async () => {
    const failure = new Error("protocol pipe closed");
    await expect(
      writeReplayTargetProtocolFrame(protocolInput(failure), new Uint8Array([1, 2, 3])),
    ).rejects.toBe(failure);
  });
});
