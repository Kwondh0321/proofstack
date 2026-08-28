export type ConsumerReceiptState = "available" | "completed" | "processing";

export interface ConsumerReceiptLease {
  readonly expiresAt: string;
  readonly owner: string;
  readonly token: string;
}

export interface ConsumerReceipt {
  readonly attemptCount: number;
  readonly availableAt: string;
  readonly completedAt: string | null;
  readonly consumerName: string;
  readonly createdAt: string;
  readonly lastError: string | null;
  readonly lease: ConsumerReceiptLease | null;
  readonly messageId: string;
  readonly payloadSha256: string;
  readonly state: ConsumerReceiptState;
  readonly tenantId: string;
}

export interface ConsumerReceiptKey {
  readonly consumerName: string;
  readonly messageId: string;
}

export interface ClaimConsumerReceiptOptions extends ConsumerReceiptKey {
  readonly leaseDurationMs: number;
  readonly payloadSha256: string;
  readonly workerId: string;
}

export interface CompleteConsumerReceiptOptions extends ConsumerReceiptKey {
  readonly leaseToken: string;
}

export interface ReleaseConsumerReceiptOptions extends CompleteConsumerReceiptOptions {
  readonly error: string;
  readonly retryDelayMs: number;
}

export type ClaimConsumerReceiptResult =
  | { readonly receipt: ConsumerReceipt; readonly status: "acquired" }
  | { readonly receipt: ConsumerReceipt; readonly status: "busy" }
  | { readonly receipt: ConsumerReceipt; readonly status: "completed" }
  | { readonly receipt: ConsumerReceipt; readonly status: "deferred" };

export class ConsumerReceiptConflictError extends Error {
  readonly consumerName: string;
  readonly messageId: string;

  constructor(consumerName: string, messageId: string) {
    super(`Consumer receipt ${consumerName}/${messageId} is bound to a different payload`);
    this.name = "ConsumerReceiptConflictError";
    this.consumerName = consumerName;
    this.messageId = messageId;
  }
}

export interface ConsumerReceiptRepository {
  claim(
    tenantId: string,
    options: ClaimConsumerReceiptOptions,
  ): Promise<ClaimConsumerReceiptResult>;
  complete(tenantId: string, options: CompleteConsumerReceiptOptions): Promise<boolean>;
  get(tenantId: string, key: ConsumerReceiptKey): Promise<ConsumerReceipt | null>;
  release(tenantId: string, options: ReleaseConsumerReceiptOptions): Promise<boolean>;
}
