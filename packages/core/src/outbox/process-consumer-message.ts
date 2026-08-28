import type { ConsumerReceipt, ConsumerReceiptRepository } from "./consumer-receipt-repository.js";

export const MAX_CONSUMER_ERROR_SUMMARY_LENGTH = 2_048;

export interface ConsumerHandlerContext {
  readonly attemptCount: number;
  readonly consumerName: string;
  readonly messageId: string;
  readonly tenantId: string;
}

export interface ProcessConsumerMessageOptions<Message, Value> {
  readonly consumerName: string;
  readonly handler: (message: Message, context: ConsumerHandlerContext) => Promise<Value>;
  readonly leaseDurationMs: number;
  readonly message: Message;
  readonly messageId: string;
  readonly payloadSha256: string;
  readonly repository: ConsumerReceiptRepository;
  readonly retryDelayMs: number;
  readonly summarizeError?: (error: unknown) => string;
  readonly tenantId: string;
  readonly workerId: string;
}

export type ProcessConsumerMessageResult<Value> =
  | { readonly receipt: ConsumerReceipt; readonly status: "busy" }
  | { readonly receipt: ConsumerReceipt; readonly status: "completed" }
  | { readonly receipt: ConsumerReceipt; readonly status: "deferred" }
  | { readonly status: "processed"; readonly value: Value };

export class ConsumerReceiptLeaseLostError extends Error {
  readonly consumerName: string;
  readonly messageId: string;
  readonly phase: "complete" | "release";

  constructor(consumerName: string, messageId: string, phase: "complete" | "release") {
    super(`Consumer receipt lease was lost before ${phase}: ${consumerName}/${messageId}`);
    this.name = "ConsumerReceiptLeaseLostError";
    this.consumerName = consumerName;
    this.messageId = messageId;
    this.phase = phase;
  }
}

export class ConsumerReceiptCompletionError extends Error {
  readonly consumerName: string;
  readonly messageId: string;

  constructor(consumerName: string, messageId: string, cause: unknown) {
    super(
      `Consumer handler succeeded but receipt completion failed: ${consumerName}/${messageId}`,
      {
        cause,
      },
    );
    this.name = "ConsumerReceiptCompletionError";
    this.consumerName = consumerName;
    this.messageId = messageId;
  }
}

export class ConsumerReceiptCleanupError extends Error {
  readonly cleanupError: unknown;
  readonly consumerName: string;
  readonly handlerError: unknown;
  readonly messageId: string;

  constructor(
    consumerName: string,
    messageId: string,
    handlerError: unknown,
    cleanupError: unknown,
  ) {
    super(`Consumer handler and receipt release both failed: ${consumerName}/${messageId}`, {
      cause: handlerError,
    });
    this.name = "ConsumerReceiptCleanupError";
    this.cleanupError = cleanupError;
    this.consumerName = consumerName;
    this.handlerError = handlerError;
    this.messageId = messageId;
  }
}

function safeErrorSummary(
  error: unknown,
  summarizeError: ((error: unknown) => string) | undefined,
): string {
  const fallback = "Consumer handler failed";
  if (!summarizeError) return fallback;

  try {
    const summary = summarizeError(error).trim();
    return summary.length > 0 ? summary.slice(0, MAX_CONSUMER_ERROR_SUMMARY_LENGTH) : fallback;
  } catch {
    return fallback;
  }
}

export async function processConsumerMessage<Message, Value>(
  options: ProcessConsumerMessageOptions<Message, Value>,
): Promise<ProcessConsumerMessageResult<Value>> {
  const claim = await options.repository.claim(options.tenantId, {
    consumerName: options.consumerName,
    leaseDurationMs: options.leaseDurationMs,
    messageId: options.messageId,
    payloadSha256: options.payloadSha256,
    workerId: options.workerId,
  });
  if (claim.status !== "acquired") return claim;

  const leaseToken = claim.receipt.lease?.token;
  if (!leaseToken) {
    throw new ConsumerReceiptLeaseLostError(options.consumerName, options.messageId, "complete");
  }

  let value: Value;
  try {
    value = await options.handler(options.message, {
      attemptCount: claim.receipt.attemptCount,
      consumerName: options.consumerName,
      messageId: options.messageId,
      tenantId: options.tenantId,
    });
  } catch (handlerError) {
    try {
      const released = await options.repository.release(options.tenantId, {
        consumerName: options.consumerName,
        error: safeErrorSummary(handlerError, options.summarizeError),
        leaseToken,
        messageId: options.messageId,
        retryDelayMs: options.retryDelayMs,
      });
      if (!released) {
        throw new ConsumerReceiptLeaseLostError(options.consumerName, options.messageId, "release");
      }
    } catch (cleanupError) {
      throw new ConsumerReceiptCleanupError(
        options.consumerName,
        options.messageId,
        handlerError,
        cleanupError,
      );
    }
    throw handlerError;
  }

  let completed: boolean;
  try {
    completed = await options.repository.complete(options.tenantId, {
      consumerName: options.consumerName,
      leaseToken,
      messageId: options.messageId,
    });
  } catch (cause) {
    throw new ConsumerReceiptCompletionError(options.consumerName, options.messageId, cause);
  }
  if (!completed) {
    throw new ConsumerReceiptLeaseLostError(options.consumerName, options.messageId, "complete");
  }
  return { status: "processed", value };
}
