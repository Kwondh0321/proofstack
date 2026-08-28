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

export interface OutboxFailure {
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly attemptCount: number;
  readonly availableAt: string;
  readonly createdAt: string;
  readonly eventType: string;
  readonly lastError: string;
  readonly lease: OutboxLease | null;
  readonly outboxId: string;
  readonly schemaVersion: string;
  readonly tenantId: string;
}

export interface ClaimOutboxOptions {
  readonly leaseDurationMs: number;
  readonly limit: number;
  readonly workerId: string;
}

export interface ListOutboxFailuresOptions {
  readonly limit: number;
  readonly minimumAttempts: number;
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
  listFailures(
    tenantId: string,
    options: ListOutboxFailuresOptions,
  ): Promise<readonly OutboxFailure[]>;
  retry(tenantId: string, options: RetryOutboxOptions): Promise<boolean>;
}
