import type { RecordedBoundaryResponse } from "@proofstack/contracts";
import type { RecordedBoundaryReplayContext } from "@proofstack/replay";
import { describe, expect, it, vi } from "vitest";
import {
  createProviderNeutralRecordedTarget,
  PROVIDER_NEUTRAL_RECORDED_TARGET_REFERENCE,
} from "./reference-recorded-target.js";

function response(kind: "model" | "tool", outcome: "failed" | "succeeded") {
  return {
    resolution: { recordedAttempt: { attempt: { outcome }, kind } },
  } as RecordedBoundaryResponse;
}

function context(responses: readonly RecordedBoundaryResponse[]) {
  const resolveBoundary = vi.fn<RecordedBoundaryReplayContext["resolveBoundary"]>();
  for (const value of responses) resolveBoundary.mockResolvedValueOnce(value);
  return {
    context: {
      locale: "en-US",
      now: vi.fn(() => "2026-08-29T00:00:00.000Z"),
      randomBytes: vi.fn((length: number) => new Uint8Array(length)),
      resolveBoundary,
      timeZone: "UTC",
    } satisfies RecordedBoundaryReplayContext,
    resolveBoundary,
  };
}

describe("provider-neutral recorded target", () => {
  it("uses only supplied deterministic capabilities and preserves the recorded failure", async () => {
    const modelBytes = Buffer.from("model-normalized", "utf8");
    const toolBytes = Buffer.from("tool-normalized", "utf8");
    const target = createProviderNeutralRecordedTarget({
      modelNormalizedRequest: modelBytes,
      toolNormalizedRequest: toolBytes,
    });
    const controlled = context([response("model", "succeeded"), response("tool", "failed")]);

    await target.run(controlled.context);

    expect(target.reference).toEqual(PROVIDER_NEUTRAL_RECORDED_TARGET_REFERENCE);
    expect(controlled.context.now).toHaveBeenCalledOnce();
    expect(controlled.context.randomBytes).toHaveBeenCalledWith(16);
    expect(controlled.resolveBoundary).toHaveBeenNthCalledWith(1, {
      boundaryRequestId: "brr_reference_model",
      kind: "model",
      normalizedRequest: {
        adapterName: "proofstack.reference.model",
        adapterVersion: "1.0.0",
        bytes: modelBytes.toString("base64url"),
        encoding: "base64url",
      },
      schemaVersion: "0.1",
    });
    expect(controlled.resolveBoundary).toHaveBeenNthCalledWith(2, {
      boundaryRequestId: "brr_reference_tool",
      kind: "tool",
      normalizedRequest: {
        adapterName: "proofstack.reference.tool",
        adapterVersion: "1.0.0",
        bytes: toolBytes.toString("base64url"),
        encoding: "base64url",
      },
      schemaVersion: "0.1",
    });
  });

  it.each([
    [response("tool", "succeeded"), "recorded model attempt"],
    [response("model", "failed"), "recorded model attempt"],
  ])("rejects an incompatible first observation", async (first, message) => {
    const target = createProviderNeutralRecordedTarget({
      modelNormalizedRequest: Buffer.from("model", "utf8"),
      toolNormalizedRequest: Buffer.from("tool", "utf8"),
    });
    await expect(target.run(context([first]).context)).rejects.toThrow(message);
  });

  it.each([
    [response("model", "succeeded"), "recorded tool attempt"],
    [response("tool", "succeeded"), "recorded tool attempt"],
  ])("rejects an incompatible second observation", async (second, message) => {
    const target = createProviderNeutralRecordedTarget({
      modelNormalizedRequest: Buffer.from("model", "utf8"),
      toolNormalizedRequest: Buffer.from("tool", "utf8"),
    });
    await expect(
      target.run(context([response("model", "succeeded"), second]).context),
    ).rejects.toThrow(message);
  });
});
