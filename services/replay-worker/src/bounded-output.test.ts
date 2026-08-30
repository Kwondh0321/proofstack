import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BoundedReplayTargetOutput } from "./bounded-output.js";

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("BoundedReplayTargetOutput", () => {
  it("hashes an exact-limit byte stream without retaining its contents", () => {
    const output = new BoundedReplayTargetOutput("stdout", 5);
    expect(output.write(Uint8Array.of())).toBe(false);
    expect(output.write(Buffer.from("ab"))).toBe(false);
    expect(output.write(Buffer.from("cde"))).toBe(false);
    const evidence = output.finish();
    expect(evidence).toMatchObject({
      capturedBytes: 5,
      contentSha256: sha256("abcde"),
      limitBytes: 5,
      observedAtLeastBytes: 5,
      stream: "stdout",
      truncated: false,
    });
    expect(evidence.evidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(output.finish()).toBe(evidence);
    expect(() => output.write(Buffer.from("x"))).toThrow("closed");
  });

  it("captures only the prefix and permanently records the first overflow byte", () => {
    const output = new BoundedReplayTargetOutput("stderr", 4);
    expect(output.write(Buffer.from("abcdef"))).toBe(true);
    expect(output.write(Buffer.from("ignored after cap"))).toBe(false);
    expect(output.finish()).toMatchObject({
      capturedBytes: 4,
      contentSha256: sha256("abcd"),
      limitBytes: 4,
      observedAtLeastBytes: 5,
      stream: "stderr",
      truncated: true,
    });
  });

  it("supports a zero-byte limit and rejects unsafe limits", () => {
    const output = new BoundedReplayTargetOutput("stdout", 0);
    expect(output.write(Buffer.from("x"))).toBe(true);
    expect(output.finish()).toMatchObject({
      capturedBytes: 0,
      contentSha256: sha256(""),
      observedAtLeastBytes: 1,
      truncated: true,
    });
    for (const limit of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new BoundedReplayTargetOutput("stderr", limit)).toThrow(RangeError);
    }
  });
});
