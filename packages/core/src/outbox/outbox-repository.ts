import type { JsonObject } from "@proofstack/contracts";

export interface OutboxLease {
  readonly expiresAt: string;
  readonly owner: string;
  readonly token: string;
}

export interface OutboxMessage {
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly eventType: string;
  readonly lease: OutboxLease;
  readonly outboxId: string;
  readonly payload: JsonObject;
  readonly schemaVersion: string;
  readonly tenantId: string;
}

export interface ClaimOutboxOptions {
  readonly leaseDurationMs: number;
  readonly limit: number;
  readonly workerId: string;
}

export interface RetryOutboxOptions {
  readonly error: string;
  readonly leaseToken: string;
  readonly outboxId: string;
  readonly retryDelayMs: number;
}

export interface AcknowledgeOutboxOptions {
  readonly leaseToken: string;
  readonly outboxId: string;
}

export interface OutboxRepository {
  acknowledge(tenantId: string, options: AcknowledgeOutboxOptions): Promise<boolean>;
  claim(tenantId: string, options: ClaimOutboxOptions): Promise<readonly OutboxMessage[]>;
  retry(tenantId: string, options: RetryOutboxOptions): Promise<boolean>;
}
