import type { RecordedBoundaryReplayRuntimeProfile } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import type { RecordedBoundaryRuntimeControlError } from "./errors.js";
import { validateRecordedReplayRandomRequest } from "./random-budget.js";
import {
  createRecordedBoundaryRuntimeControls,
  MAX_RANDOM_BYTES_PER_INVOCATION,
  MAX_RANDOM_BYTES_PER_REQUEST,
  RECORDED_REPLAY_RANDOM_DOMAIN,
} from "./runtime-controls.js";

const profile = (seedDigit = "a"): RecordedBoundaryReplayRuntimeProfile => ({
  boundaryMode: "recorded_stub",
  clock: { instant: "2026-08-29T00:00:00.000Z", mode: "fixed" },
  isolation: { mode: "cooperative_in_process" },
  locale: "en-US",
  network: { policy: "deny_fallback" },
  random: {
    algorithm: "hmac_sha256_counter_v1",
    mode: "seeded",
    seedHex: seedDigit.repeat(64),
  },
  timeZone: "UTC",
});

describe("recorded replay runtime controls", () => {
  it("returns one fixed instant and reports exact usage", () => {
    const controls = createRecordedBoundaryRuntimeControls(profile());
    expect(controls.contextValues).toEqual({ locale: "en-US", timeZone: "UTC" });
    expect(controls.now()).toBe("2026-08-29T00:00:00.000Z");
    expect(controls.now()).toBe("2026-08-29T00:00:00.000Z");
    expect(controls.evidence()).toEqual({
      fixedClockReadCount: 2,
      randomByteCount: 0,
      randomRequestCount: 0,
    });
    expect(controls.violated).toBe(false);
  });

  it("provides a stable domain-separated byte stream independent of request chunking", () => {
    expect(RECORDED_REPLAY_RANDOM_DOMAIN).toBe("proofstack.replay.random.v1");
    const whole = createRecordedBoundaryRuntimeControls(profile());
    const split = createRecordedBoundaryRuntimeControls(profile());
    const changed = createRecordedBoundaryRuntimeControls(profile("b"));
    const wholeBytes = whole.randomBytes(64);
    const splitBytes = Buffer.concat([
      split.randomBytes(1),
      split.randomBytes(31),
      split.randomBytes(32),
    ]);
    expect(Buffer.from(wholeBytes).toString("hex")).toBe(
      "019f67817d94fd05b55cf41e1d8b6d21bfeb0520181f97b284b71c1a0dcc20199e72be685f2002025c9d83e0d325996ff44bc3ff13d320729ef77c8cec822b15",
    );
    expect(splitBytes).toEqual(Buffer.from(wholeBytes));
    expect(changed.randomBytes(64)).not.toEqual(wholeBytes);
    expect(whole.evidence()).toEqual({
      fixedClockReadCount: 0,
      randomByteCount: 64,
      randomRequestCount: 1,
    });
    expect(split.evidence()).toEqual({
      fixedClockReadCount: 0,
      randomByteCount: 64,
      randomRequestCount: 3,
    });
  });

  it.each([0, -1, 1.5, MAX_RANDOM_BYTES_PER_REQUEST + 1])(
    "fails closed for invalid random request length %s",
    (length) => {
      const controls = createRecordedBoundaryRuntimeControls(profile());
      expect(() => controls.randomBytes(length)).toThrowError(
        expect.objectContaining<Partial<RecordedBoundaryRuntimeControlError>>({
          code: "random_request_out_of_range",
        }),
      );
      expect(controls.violated).toBe(true);
      expect(controls.evidence()).toEqual({
        fixedClockReadCount: 0,
        randomByteCount: 0,
        randomRequestCount: 0,
      });
    },
  );

  it("enforces a finite invocation random-byte ceiling", () => {
    const controls = createRecordedBoundaryRuntimeControls(profile());
    expect(controls.randomBytes(MAX_RANDOM_BYTES_PER_REQUEST)).toHaveLength(
      MAX_RANDOM_BYTES_PER_REQUEST,
    );
    expect(validateRecordedReplayRandomRequest(MAX_RANDOM_BYTES_PER_INVOCATION - 1, 1)).toBe(
      MAX_RANDOM_BYTES_PER_INVOCATION,
    );
    expect(() =>
      validateRecordedReplayRandomRequest(MAX_RANDOM_BYTES_PER_INVOCATION, 1),
    ).toThrowError(
      expect.objectContaining<Partial<RecordedBoundaryRuntimeControlError>>({
        code: "random_budget_exhausted",
      }),
    );
    expect(controls.evidence()).toEqual({
      fixedClockReadCount: 0,
      randomByteCount: MAX_RANDOM_BYTES_PER_REQUEST,
      randomRequestCount: 1,
    });
    expect(controls.violated).toBe(false);
  });

  it("permanently rejects clock and random access after close", () => {
    const controls = createRecordedBoundaryRuntimeControls(profile());
    controls.close();
    expect(() => controls.now()).toThrowError(
      expect.objectContaining<Partial<RecordedBoundaryRuntimeControlError>>({
        code: "runtime_controls_closed",
      }),
    );
    expect(() => controls.randomBytes(1)).toThrowError(
      expect.objectContaining<Partial<RecordedBoundaryRuntimeControlError>>({
        code: "runtime_controls_closed",
      }),
    );
    expect(controls.violated).toBe(true);
  });
});
