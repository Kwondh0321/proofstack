import { describe, expect, it, vi } from "vitest";
import type {
  ClaimConsumerReceiptOptions,
  ClaimConsumerReceiptResult,
  CompleteConsumerReceiptOptions,
  ConsumerReceipt,
  ConsumerReceiptKey,
  ConsumerReceiptRepository,
  ReleaseConsumerReceiptOptions,
} from "./consumer-receipt-repository.js";
import {
  ConsumerReceiptCleanupError,
  ConsumerReceiptCompletionError,
  ConsumerReceiptLeaseLostError,
  MAX_CONSUMER_ERROR_SUMMARY_LENGTH,
  processConsumerMessage,
} from "./process-consumer-message.js";

const leaseToken = "40000000-0000-4000-8000-000000000001";

function receipt(overrides: Partial<ConsumerReceipt> = {}): ConsumerReceipt {
  return {
    attemptCount: 1,
    availableAt: "2026-08-28T03:00:00.000Z",
    completedAt: null,
    consumerName: "trace.projector",
    createdAt: "2026-08-28T03:00:00.000Z",
    lastError: null,
    lease: {
      expiresAt: "2026-08-28T03:01:00.000Z",
      owner: "wrk_primary",
      token: leaseToken,
    },
    messageId: "message-001",
    payloadSha256: "a".repeat(64),
    state: "processing",
    tenantId: "ten_local",
    ...overrides,
  };
}

class FakeRepository implements ConsumerReceiptRepository {
  claimResult: ClaimConsumerReceiptResult = { receipt: receipt(), status: "acquired" };
  completeError?: unknown;
  completeResult = true;
  releaseError?: unknown;
  releaseResult = true;
  readonly claimCalls: Array<{ options: ClaimConsumerReceiptOptions; tenantId: string }> = [];
  readonly completeCalls: Array<{
    options: CompleteConsumerReceiptOptions;
    tenantId: string;
  }> = [];
  readonly releaseCalls: Array<{
    options: ReleaseConsumerReceiptOptions;
    tenantId: string;
  }> = [];

  async claim(
    tenantId: string,
    options: ClaimConsumerReceiptOptions,
  ): Promise<ClaimConsumerReceiptResult> {
    this.claimCalls.push({ options, tenantId });
    return this.claimResult;
  }

  async complete(tenantId: string, options: CompleteConsumerReceiptOptions): Promise<boolean> {
    this.completeCalls.push({ options, tenantId });
    if (this.completeError) throw this.completeError;
    return this.completeResult;
  }

  async get(_tenantId: string, _key: ConsumerReceiptKey): Promise<ConsumerReceipt | null> {
    return null;
  }

  async release(tenantId: string, options: ReleaseConsumerReceiptOptions): Promise<boolean> {
    this.releaseCalls.push({ options, tenantId });
    if (this.releaseError) throw this.releaseError;
    return this.releaseResult;
  }
}

function options(repository: ConsumerReceiptRepository) {
  return {
    consumerName: "trace.projector",
    handler: vi.fn(async (message: { readonly eventId: string }) => `handled:${message.eventId}`),
    leaseDurationMs: 60_000,
    message: { eventId: "evt_001" },
    messageId: "message-001",
    payloadSha256: "a".repeat(64),
    repository,
    retryDelayMs: 1_000,
    tenantId: "ten_local",
    workerId: "wrk_primary",
  };
}

describe("processConsumerMessage", () => {
  it.each(["busy", "completed", "deferred"] as const)(
    "does not invoke a handler for a %s receipt",
    async (status) => {
      const repository = new FakeRepository();
      const current = receipt({
        lease: status === "busy" ? receipt().lease : null,
        state:
          status === "busy" ? "processing" : status === "completed" ? "completed" : "available",
      });
      repository.claimResult = { receipt: current, status };
      const input = options(repository);

      await expect(processConsumerMessage(input)).resolves.toEqual({ receipt: current, status });
      expect(input.handler).not.toHaveBeenCalled();
      expect(repository.completeCalls).toEqual([]);
      expect(repository.releaseCalls).toEqual([]);
    },
  );

  it("claims, handles, and completes a message in order", async () => {
    const repository = new FakeRepository();
    const input = options(repository);

    await expect(processConsumerMessage(input)).resolves.toEqual({
      status: "processed",
      value: "handled:evt_001",
    });
    expect(repository.claimCalls).toEqual([
      {
        options: {
          consumerName: "trace.projector",
          leaseDurationMs: 60_000,
          messageId: "message-001",
          payloadSha256: "a".repeat(64),
          workerId: "wrk_primary",
        },
        tenantId: "ten_local",
      },
    ]);
    expect(input.handler).toHaveBeenCalledWith(
      { eventId: "evt_001" },
      {
        attemptCount: 1,
        consumerName: "trace.projector",
        messageId: "message-001",
        tenantId: "ten_local",
      },
    );
    expect(repository.completeCalls).toEqual([
      {
        options: { consumerName: "trace.projector", leaseToken, messageId: "message-001" },
        tenantId: "ten_local",
      },
    ]);
  });

  it("fails before invoking the handler when an acquired receipt has no lease", async () => {
    const repository = new FakeRepository();
    repository.claimResult = { receipt: receipt({ lease: null }), status: "acquired" };
    const input = options(repository);

    await expect(processConsumerMessage(input)).rejects.toMatchObject({
      name: "ConsumerReceiptLeaseLostError",
      phase: "complete",
    });
    expect(input.handler).not.toHaveBeenCalled();
  });

  it("releases a failed handler with a safe default summary and preserves its error", async () => {
    const repository = new FakeRepository();
    const input = options(repository);
    const handlerError = new Error("secret provider response");
    input.handler.mockRejectedValueOnce(handlerError);

    await expect(processConsumerMessage(input)).rejects.toBe(handlerError);
    expect(repository.releaseCalls).toEqual([
      {
        options: {
          consumerName: "trace.projector",
          error: "Consumer handler failed",
          leaseToken,
          messageId: "message-001",
          retryDelayMs: 1_000,
        },
        tenantId: "ten_local",
      },
    ]);
  });

  it("trims and bounds an explicitly safe error summary", async () => {
    const repository = new FakeRepository();
    const input = {
      ...options(repository),
      summarizeError: () => `  ${"x".repeat(MAX_CONSUMER_ERROR_SUMMARY_LENGTH + 10)}  `,
    };
    input.handler.mockRejectedValueOnce(new Error("failure"));

    await expect(processConsumerMessage(input)).rejects.toThrow("failure");
    expect(repository.releaseCalls[0]?.options.error).toBe(
      "x".repeat(MAX_CONSUMER_ERROR_SUMMARY_LENGTH),
    );
  });

  it.each([
    ["empty summary", () => "   "],
    [
      "throwing summary",
      () => {
        throw new Error("summarizer failed");
      },
    ],
  ])("falls back safely for an %s", async (_label, summarizeError) => {
    const repository = new FakeRepository();
    const input = { ...options(repository), summarizeError };
    input.handler.mockRejectedValueOnce(new Error("failure"));

    await expect(processConsumerMessage(input)).rejects.toThrow("failure");
    expect(repository.releaseCalls[0]?.options.error).toBe("Consumer handler failed");
  });

  it("preserves handler failure and a lost release lease", async () => {
    const repository = new FakeRepository();
    repository.releaseResult = false;
    const input = options(repository);
    const handlerError = new Error("handler failed");
    input.handler.mockRejectedValueOnce(handlerError);

    const promise = processConsumerMessage(input);
    await expect(promise).rejects.toMatchObject({
      cause: handlerError,
      cleanupError: expect.objectContaining({
        name: "ConsumerReceiptLeaseLostError",
        phase: "release",
      }),
      handlerError,
    });
    await expect(promise).rejects.toBeInstanceOf(ConsumerReceiptCleanupError);
  });

  it("preserves handler failure and a release exception", async () => {
    const repository = new FakeRepository();
    const cleanupError = new Error("database unavailable");
    repository.releaseError = cleanupError;
    const input = options(repository);
    const handlerError = new Error("handler failed");
    input.handler.mockRejectedValueOnce(handlerError);

    await expect(processConsumerMessage(input)).rejects.toMatchObject({
      cleanupError,
      handlerError,
      name: "ConsumerReceiptCleanupError",
    });
  });

  it("reports a lost lease after a successful handler", async () => {
    const repository = new FakeRepository();
    repository.completeResult = false;

    await expect(processConsumerMessage(options(repository))).rejects.toBeInstanceOf(
      ConsumerReceiptLeaseLostError,
    );
  });

  it("distinguishes completion failure after a successful handler", async () => {
    const repository = new FakeRepository();
    const completionError = new Error("database unavailable");
    repository.completeError = completionError;

    const promise = processConsumerMessage(options(repository));
    await expect(promise).rejects.toMatchObject({
      cause: completionError,
      consumerName: "trace.projector",
      messageId: "message-001",
    });
    await expect(promise).rejects.toBeInstanceOf(ConsumerReceiptCompletionError);
  });
});
