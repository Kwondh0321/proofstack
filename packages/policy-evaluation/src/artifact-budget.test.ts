import { describe, expect, it, vi } from "vitest";
import { AcquisitionBudget } from "./acquisition-budget.js";

function budget(bytes: number) {
  return new AcquisitionBudget({
    heartbeatIntervalMilliseconds: 1000,
    leaseDurationMilliseconds: 3000,
    maxAcquisitionRecordBytes: 1024,
    maxAcquisitionRecords: 10,
    maxArtifactReadBytes: bytes,
    maxAttempts: 1,
    maxRuleEvaluations: 1,
    perAttemptTimeoutMilliseconds: 10000,
    retryBackoffMilliseconds: 0,
    retryableErrors: [],
    totalDeadlineMilliseconds: 10000,
  });
}

describe("artifact object admission", () => {
  it("reserves exact repeated reads before I/O and rejects the first byte over the shared ceiling", async () => {
    const meter = budget(6);
    const read = vi.fn(async () => new Uint8Array(3));
    await meter.readArtifactObject(3, read);
    await meter.readArtifactObject(3, read);
    await expect(meter.readArtifactObject(1, read)).rejects.toMatchObject({
      reason: "artifact_byte_limit",
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(meter.artifactUsage()).toEqual({
      reads: 2,
      reservedBytes: 6,
      receivedBytes: 6,
      chargedBytes: 6,
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])(
    "rejects invalid or excessive reservation %s without invoking storage",
    async (bytes) => {
      const meter = budget(6);
      const read = vi.fn(async () => null);
      await expect(meter.readArtifactObject(bytes, read)).rejects.toMatchObject({
        reason: "artifact_byte_limit",
      });
      expect(read).not.toHaveBeenCalled();
      expect(meter.artifactUsage().reads).toBe(0);
    },
  );

  it("never treats zero budget as a waiver", async () => {
    const read = vi.fn(async () => null);
    await expect(budget(0).readArtifactObject(1, read)).rejects.toMatchObject({
      reason: "artifact_byte_limit",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["missing", "short", "invalid", "failure"])(
    "retains reservations for %s responses",
    async (kind) => {
      const meter = budget(3);
      const failure = new Error("object transport failed");
      const read = vi.fn(async () => {
        if (kind === "failure") throw failure;
        if (kind === "short") return new Uint8Array(1);
        if (kind === "invalid") return {} as Uint8Array;
        return null;
      });
      const pending = meter.readArtifactObject(3, read);
      if (kind === "failure") await expect(pending).rejects.toBe(failure);
      else await pending;
      await expect(meter.readArtifactObject(1, read)).rejects.toMatchObject({
        reason: "artifact_byte_limit",
      });
      expect(read).toHaveBeenCalledOnce();
      expect(meter.artifactUsage()).toEqual({
        reads: 1,
        reservedBytes: 3,
        receivedBytes: kind === "short" ? 1 : 0,
        chargedBytes: 3,
      });
      await meter.settle();
    },
  );

  it("charges unexpectedly larger buffers before allowing another read", async () => {
    const meter = budget(10);
    await meter.readArtifactObject(3, async () => new Uint8Array(5));
    await meter.readArtifactObject(5, async () => null);
    expect(meter.artifactUsage()).toEqual({
      reads: 2,
      reservedBytes: 8,
      receivedBytes: 5,
      chargedBytes: 10,
    });
    await expect(meter.readArtifactObject(1, async () => null)).rejects.toMatchObject({
      reason: "artifact_byte_limit",
    });
  });

  it("records an oversized observed buffer and rejects it before downstream processing", async () => {
    const meter = budget(4);
    await expect(meter.readArtifactObject(3, async () => new Uint8Array(5))).rejects.toMatchObject({
      reason: "artifact_byte_limit",
    });
    expect(meter.artifactUsage()).toEqual({
      reads: 1,
      reservedBytes: 3,
      receivedBytes: 5,
      chargedBytes: 5,
    });
  });

  it("drains pending object reads under the shared acquisition lifecycle", async () => {
    const meter = budget(3);
    let release!: (value: null) => void;
    const pending = meter.readArtifactObject(
      3,
      () =>
        new Promise<null>((resolve) => {
          release = resolve;
        }),
    );
    let finished = false;
    const settled = meter.settle().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    release(null);
    await pending;
    await settled;
    expect(finished).toBe(true);
  });
});
