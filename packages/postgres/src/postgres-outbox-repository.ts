import { randomUUID } from "node:crypto";
import {
  type JsonObject,
  JsonValueSchema,
  NamespacedExtensionKeySchema,
  OpaqueIdSchema,
  TimestampSchema,
} from "@proofstack/contracts";
import type {
  AcknowledgeOutboxOptions,
  ClaimOutboxOptions,
  OutboxMessage,
  OutboxRepository,
  RetryOutboxOptions,
} from "@proofstack/core";
import type { Pool, QueryResultRow } from "pg";
import { PostgresDataIntegrityError } from "./postgres-evidence-repository.js";
import { withTenantTransaction } from "./tenant-transaction.js";

export const MAX_OUTBOX_CLAIM_SIZE = 100;
export const MAX_OUTBOX_LEASE_DURATION_MS = 5 * 60 * 1_000;
export const MAX_OUTBOX_RETRY_DELAY_MS = 24 * 60 * 60 * 1_000;
export const MAX_OUTBOX_ERROR_LENGTH = 2_048;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AGGREGATE_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/;
const SCHEMA_VERSION_PATTERN = /^[0-9]+\.[0-9]+$/;
const MAX_BIGINT = 9_223_372_036_854_775_807n;

interface OutboxRow extends QueryResultRow {
  readonly aggregate_id: string;
  readonly aggregate_type: string;
  readonly attempt_count: number;
  readonly created_at: string;
  readonly event_type: string;
  readonly lease_expires_at: string;
  readonly lease_owner: string;
  readonly lease_token: string;
  readonly outbox_id: string;
  readonly payload: unknown;
  readonly schema_version: string;
  readonly tenant_id: string;
}

interface MutationRow extends QueryResultRow {
  readonly changed: boolean;
}

const CLAIM_OUTBOX_SQL = `
  WITH candidates AS (
    SELECT outbox_id
    FROM public.proofstack_outbox
    WHERE tenant_id = $1
      AND published_at IS NULL
      AND available_at <= clock_timestamp()
      AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
    ORDER BY available_at, outbox_id
    FOR UPDATE SKIP LOCKED
    LIMIT $2
  )
  UPDATE public.proofstack_outbox AS target
  SET lease_token = $3::uuid,
      lease_owner = $4,
      lease_expires_at = clock_timestamp() + ($5::integer * interval '1 millisecond'),
      attempt_count = target.attempt_count + 1
  FROM candidates
  WHERE target.tenant_id = $1 AND target.outbox_id = candidates.outbox_id
  RETURNING
    target.tenant_id,
    target.outbox_id::text,
    target.event_type,
    target.aggregate_type,
    target.aggregate_id,
    target.schema_version,
    target.payload,
    to_char(
      target.created_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) AS created_at,
    target.attempt_count,
    target.lease_token::text,
    target.lease_owner,
    to_char(
      target.lease_expires_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) AS lease_expires_at
`;

const ACKNOWLEDGE_OUTBOX_SQL = `
  UPDATE public.proofstack_outbox
  SET published_at = clock_timestamp(),
      lease_token = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error = NULL
  WHERE tenant_id = $1
    AND outbox_id = $2::bigint
    AND lease_token = $3::uuid
    AND published_at IS NULL
    AND lease_expires_at > clock_timestamp()
  RETURNING true AS changed
`;

const RETRY_OUTBOX_SQL = `
  UPDATE public.proofstack_outbox
  SET available_at = clock_timestamp() + ($4::integer * interval '1 millisecond'),
      lease_token = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error = $5
  WHERE tenant_id = $1
    AND outbox_id = $2::bigint
    AND lease_token = $3::uuid
    AND published_at IS NULL
    AND lease_expires_at > clock_timestamp()
  RETURNING true AS changed
`;

function requireOpaqueId(value: string, label: string): string {
  const parsed = OpaqueIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError(`${label} must be a valid opaque identifier`);
  return parsed.data;
}

function requireOutboxId(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value)) throw new TypeError("outboxId must be a positive integer");
  const parsed = BigInt(value);
  if (parsed > MAX_BIGINT) throw new TypeError("outboxId exceeds the PostgreSQL bigint range");
  return value;
}

function requireLeaseToken(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new TypeError("leaseToken must be a UUID");
  return value;
}

function requireBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function integrityViolation(message: string, cause?: unknown): never {
  throw new PostgresDataIntegrityError(message, cause === undefined ? undefined : { cause });
}

function messageFromRow(row: OutboxRow, expectedTenantId: string): OutboxMessage {
  const payload = JsonValueSchema.safeParse(row.payload);
  if (
    !payload.success ||
    typeof payload.data !== "object" ||
    payload.data === null ||
    Array.isArray(payload.data)
  ) {
    integrityViolation(
      "Stored outbox payload is not a canonical JSON object",
      payload.success ? undefined : payload.error,
    );
  }

  if (row.tenant_id !== expectedTenantId || !OpaqueIdSchema.safeParse(row.tenant_id).success) {
    integrityViolation("Stored outbox tenant does not match its transaction scope");
  }
  if (!OpaqueIdSchema.safeParse(row.aggregate_id).success) {
    integrityViolation("Stored outbox aggregate identifier is invalid");
  }
  if (!AGGREGATE_TYPE_PATTERN.test(row.aggregate_type)) {
    integrityViolation("Stored outbox aggregate type is invalid");
  }
  if (!NamespacedExtensionKeySchema.safeParse(row.event_type).success) {
    integrityViolation("Stored outbox event type is invalid");
  }
  if (!SCHEMA_VERSION_PATTERN.test(row.schema_version)) {
    integrityViolation("Stored outbox schema version is invalid");
  }
  if (!TimestampSchema.safeParse(row.created_at).success) {
    integrityViolation("Stored outbox creation time is invalid");
  }
  if (!TimestampSchema.safeParse(row.lease_expires_at).success) {
    integrityViolation("Stored outbox lease expiry is invalid");
  }
  if (!OpaqueIdSchema.safeParse(row.lease_owner).success) {
    integrityViolation("Stored outbox lease owner is invalid");
  }
  if (!UUID_PATTERN.test(row.lease_token)) {
    integrityViolation("Stored outbox lease token is invalid");
  }
  if (!/^[1-9][0-9]*$/.test(row.outbox_id) || BigInt(row.outbox_id) > MAX_BIGINT) {
    integrityViolation("Stored outbox identifier is invalid");
  }
  if (
    !Number.isInteger(row.attempt_count) ||
    row.attempt_count < 1 ||
    row.attempt_count > 1_000_000
  ) {
    integrityViolation("Stored outbox attempt count is invalid");
  }

  return {
    aggregateId: row.aggregate_id,
    aggregateType: row.aggregate_type,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    eventType: row.event_type,
    lease: {
      expiresAt: row.lease_expires_at,
      owner: row.lease_owner,
      token: row.lease_token,
    },
    outboxId: row.outbox_id,
    payload: payload.data as JsonObject,
    schemaVersion: row.schema_version,
    tenantId: row.tenant_id,
  };
}

export class PostgresOutboxRepository implements OutboxRepository {
  constructor(
    private readonly pool: Pick<Pool, "connect">,
    private readonly createLeaseToken: () => string = randomUUID,
  ) {}

  async claim(tenantId: string, options: ClaimOutboxOptions): Promise<readonly OutboxMessage[]> {
    const tenant = requireOpaqueId(tenantId, "tenantId");
    const workerId = requireOpaqueId(options.workerId, "workerId");
    const limit = requireBoundedInteger(options.limit, 1, MAX_OUTBOX_CLAIM_SIZE, "limit");
    const leaseDurationMs = requireBoundedInteger(
      options.leaseDurationMs,
      1,
      MAX_OUTBOX_LEASE_DURATION_MS,
      "leaseDurationMs",
    );
    const leaseToken = requireLeaseToken(this.createLeaseToken());

    return withTenantTransaction(this.pool, tenant, async (client) => {
      const result = await client.query<OutboxRow>(CLAIM_OUTBOX_SQL, [
        tenant,
        limit,
        leaseToken,
        workerId,
        leaseDurationMs,
      ]);
      return result.rows.map((row) => messageFromRow(row, tenant));
    });
  }

  async acknowledge(tenantId: string, options: AcknowledgeOutboxOptions): Promise<boolean> {
    const tenant = requireOpaqueId(tenantId, "tenantId");
    const outboxId = requireOutboxId(options.outboxId);
    const leaseToken = requireLeaseToken(options.leaseToken);

    return withTenantTransaction(this.pool, tenant, async (client) => {
      const result = await client.query<MutationRow>(ACKNOWLEDGE_OUTBOX_SQL, [
        tenant,
        outboxId,
        leaseToken,
      ]);
      return result.rows[0]?.changed === true;
    });
  }

  async retry(tenantId: string, options: RetryOutboxOptions): Promise<boolean> {
    const tenant = requireOpaqueId(tenantId, "tenantId");
    const outboxId = requireOutboxId(options.outboxId);
    const leaseToken = requireLeaseToken(options.leaseToken);
    const retryDelayMs = requireBoundedInteger(
      options.retryDelayMs,
      0,
      MAX_OUTBOX_RETRY_DELAY_MS,
      "retryDelayMs",
    );
    if (options.error.length < 1 || options.error.length > MAX_OUTBOX_ERROR_LENGTH) {
      throw new RangeError(
        `error must contain between 1 and ${MAX_OUTBOX_ERROR_LENGTH} characters`,
      );
    }

    return withTenantTransaction(this.pool, tenant, async (client) => {
      const result = await client.query<MutationRow>(RETRY_OUTBOX_SQL, [
        tenant,
        outboxId,
        leaseToken,
        retryDelayMs,
        options.error,
      ]);
      return result.rows[0]?.changed === true;
    });
  }
}
