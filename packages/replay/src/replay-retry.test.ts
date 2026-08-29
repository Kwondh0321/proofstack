import type { ReplayAttemptError, ReplayRetryPolicy } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { decideReplayRetry } from "./replay-retry.js";

const sha = (digit: string): string => digit.repeat(64);

function policy(overrides: Partial<ReplayRetryPolicy> = {}): ReplayRetryPolicy {
  return {
    automatic: true,
    backoff: { delayMilliseconds: 1_000, kind: "fixed" },
    idempotencyRequirement: "read_only",
    maxAttempts: 3,
    perAttemptTimeoutMilliseconds: 2_000,
    retryableErrors: ["boundary_rate_limited", "target_process_interrupted"],
    totalDeadlineMilliseconds: 10_000,
    ...overrides,
  };
}

function error(overrides: Partial<ReplayAttemptError> = {}): ReplayAttemptError {
  return {
    code: "boundary_rate_limited",
    effectCertainty: "none",
    message: "The declared boundary rate limit was reached.",
    ...overrides,
  };
}

function decision(options: Partial<Parameters<typeof decideReplayRetry>[0]> = {}) {
  return decideReplayRetry({
    attemptSequence: 0,
    error: error(),
    failedAt: "2026-08-29T00:00:02.000Z",
    jobStartedAt: "2026-08-29T00:00:00.000Z",
    policy: policy(),
    ...options,
  });
}

describe("durable replay retry decisions", () => {
  it("schedules a declared retry only when another complete attempt fits", () => {
    expect(decision()).toEqual({
      delayMilliseconds: 1_000,
      eligible: true,
      notBefore: "2026-08-29T00:00:03.000Z",
    });
  });

  it("maps lease expiry to the predeclared target interruption class", () => {
    expect(decision({ error: error({ code: "lease_expired" }) })).toMatchObject({
      eligible: true,
    });
    expect(
      decision({
        error: error({ code: "lease_expired" }),
        policy: policy({ retryableErrors: ["boundary_rate_limited"] }),
      }),
    ).toEqual({ eligible: false, reason: "error_not_declared" });
  });

  it.each([
    [
      "read-only",
      error({
        effectCertainty: "may_have_occurred",
        effectRetrySafety: { evidenceSha256: sha("1"), kind: "read_only" },
      }),
    ],
    [
      "destination-idempotent",
      error({
        effectCertainty: "confirmed",
        effectRetrySafety: {
          evidenceSha256: sha("2"),
          idempotencyKeySha256: sha("3"),
          kind: "destination_idempotency_verified",
        },
      }),
    ],
  ])("allows %s external effects with exact safety evidence", (_name, retryError) => {
    expect(decision({ error: retryError })).toMatchObject({ eligible: true });
  });

  it("blocks external effects explicitly classified as non-retryable", () => {
    expect(
      decision({
        error: error({
          effectCertainty: "may_have_occurred",
          effectRetrySafety: { kind: "not_retryable" },
        }),
      }),
    ).toEqual({ eligible: false, reason: "effect_not_retry_safe" });
  });

  it("blocks disabled, exhausted, undeclared, and malformed attempt sequences", () => {
    expect(
      decision({
        policy: policy({ automatic: false, backoff: { kind: "none" }, retryableErrors: [] }),
      }),
    ).toEqual({
      eligible: false,
      reason: "automatic_retry_disabled",
    });
    expect(decision({ attemptSequence: 2 })).toEqual({
      eligible: false,
      reason: "attempt_limit_reached",
    });
    expect(decision({ attemptSequence: -1 })).toEqual({
      eligible: false,
      reason: "attempt_limit_reached",
    });
    expect(decision({ attemptSequence: 0.5 })).toEqual({
      eligible: false,
      reason: "attempt_limit_reached",
    });
    expect(decision({ error: error({ code: "authority_denied" }) })).toEqual({
      eligible: false,
      reason: "error_not_declared",
    });
  });

  it("requires the backoff and complete next timeout to fit the total deadline", () => {
    expect(
      decision({
        failedAt: "2026-08-29T00:00:08.001Z",
      }),
    ).toEqual({ eligible: false, reason: "deadline_insufficient" });
    expect(
      decision({
        failedAt: "2026-08-29T00:00:02.000Z",
        policy: policy({ totalDeadlineMilliseconds: Number.MAX_SAFE_INTEGER }),
      }),
    ).toEqual({ eligible: false, reason: "deadline_insufficient" });
    expect(decision({ failedAt: "2026-08-28T23:59:59.999Z" })).toEqual({
      eligible: false,
      reason: "deadline_insufficient",
    });
    expect(
      decision({
        failedAt: "9999-12-31T23:59:59.999Z",
        jobStartedAt: "0001-01-01T00:00:00.000Z",
        policy: policy({
          perAttemptTimeoutMilliseconds: Number.MAX_SAFE_INTEGER,
          totalDeadlineMilliseconds: Number.MAX_SAFE_INTEGER,
        }),
      }),
    ).toEqual({ eligible: false, reason: "deadline_insufficient" });
  });

  it("computes none, fixed, and capped exponential backoff deterministically", () => {
    expect(
      decision({
        policy: policy({ backoff: { kind: "none" } }),
      }),
    ).toMatchObject({ delayMilliseconds: 0, notBefore: "2026-08-29T00:00:02.000Z" });
    expect(
      decision({
        attemptSequence: 2,
        policy: policy({
          backoff: {
            initialDelayMilliseconds: 100,
            kind: "exponential",
            maximumDelayMilliseconds: 250,
            multiplier: 2,
          },
          maxAttempts: 4,
        }),
      }),
    ).toMatchObject({ delayMilliseconds: 250, notBefore: "2026-08-29T00:00:02.250Z" });
  });

  it("rejects malformed policy, error, and timestamp contracts before deciding", () => {
    expect(() =>
      decision({ policy: { ...policy(), hidden: true } as ReplayRetryPolicy }),
    ).toThrow();
    expect(() =>
      decision({ error: { ...error(), effectCertainty: "confirmed" } as ReplayAttemptError }),
    ).toThrow();
    expect(() => decision({ failedAt: "not-a-time" })).toThrow();
    expect(() => decision({ jobStartedAt: "not-a-time" })).toThrow();
  });
});
