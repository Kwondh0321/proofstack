import { randomUUID } from "node:crypto";
import { OpaqueIdSchema, Sha256Schema, TimestampSchema } from "@proofstack/contracts";
import {
  type ClaimConsumerReceiptOptions,
  type ClaimConsumerReceiptResult,
  type CompleteConsumerReceiptOptions,
  type ConsumerReceipt,
  ConsumerReceiptConflictError,
  type ConsumerReceiptKey,
  type ConsumerReceiptRepository,
  type ReleaseConsumerReceiptOptions,
} from "@proofstack/core";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { PostgresDataIntegrityError } from "./postgres-evidence-repository.js";
import { withTenantTransaction } from "./tenant-transaction.js";

export const MAX_CONSUMER_RECEIPT_LEASE_DURATION_MS = 5 * 60 * 1_000;
export const MAX_CONSUMER_RECEIPT_RETRY_DELAY_MS = 24 * 60 * 60 * 1_000;
export const MAX_CONSUMER_RECEIPT_ERROR_LENGTH = 2_048;

const CONSUMER_NAME_PATTERN = /^[a-z][a-z0-9_.-]{2,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface ConsumerReceiptRow extends QueryResultRow {
  readonly attempt_count: number;
  readonly available_at: string;
  readonly available_due: boolean;
  readonly completed_at: string | null;
  readonly consumer_name: string;
  readonly created_at: string;
  readonly last_error: string | null;
  readonly lease_current: boolean | null;
  readonly lease_expires_at: string | null;
  readonly lease_owner: string | null;
  readonly lease_token: string | null;
  readonly message_id: string;
  readonly payload_sha256: string;
  readonly state: string;
  readonly tenant_id: string;
}

interface MutationRow extends QueryResultRow {
  readonly changed: boolean;
}

const SELECT_RECEIPT_COLUMNS = `
  tenant_id,
  consumer_name,
  message_id,
  payload_sha256,
  state,
  attempt_count,
  to_char(
    created_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) AS created_at,
  to_char(
    available_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) AS available_at,
  lease_token::text,
  lease_owner,
  to_char(
    lease_expires_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) AS lease_expires_at,
  to_char(
    completed_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) AS completed_at,
  last_error,
  available_at <= clock_timestamp() AS available_due,
  lease_expires_at > clock_timestamp() AS lease_current
`;

const GET_RECEIPT_SQL = `
  SELECT ${SELECT_RECEIPT_COLUMNS}
  FROM public.proofstack_consumer_receipts
  WHERE tenant_id = $1 AND consumer_name = $2 AND message_id = $3
`;

const LOCK_RECEIPT_SQL = `${GET_RECEIPT_SQL} FOR UPDATE`;

const INSERT_PROCESSING_RECEIPT_SQL = `
  INSERT INTO public.proofstack_consumer_receipts (
    tenant_id,
    consumer_name,
    message_id,
    payload_sha256,
    state,
    created_at,
    available_at,
    attempt_count,
    lease_token,
    lease_owner,
    lease_expires_at
  ) VALUES (
    $1,
    $2,
    $3,
    $4,
    'processing',
    clock_timestamp(),
    clock_timestamp(),
    1,
    $5::uuid,
    $6,
    clock_timestamp() + ($7::integer * interval '1 millisecond')
  )
  ON CONFLICT (tenant_id, consumer_name, message_id) DO NOTHING
  RETURNING ${SELECT_RECEIPT_COLUMNS}
`;

const RECLAIM_RECEIPT_SQL = `
  UPDATE public.proofstack_consumer_receipts
  SET state = 'processing',
      attempt_count = attempt_count + 1,
      lease_token = $4::uuid,
      lease_owner = $5,
      lease_expires_at = clock_timestamp() + ($6::integer * interval '1 millisecond')
  WHERE tenant_id = $1 AND consumer_name = $2 AND message_id = $3
  RETURNING ${SELECT_RECEIPT_COLUMNS}
`;

const COMPLETE_RECEIPT_SQL = `
  UPDATE public.proofstack_consumer_receipts
  SET state = 'completed',
      completed_at = clock_timestamp(),
      lease_token = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error = NULL
  WHERE tenant_id = $1
    AND consumer_name = $2
    AND message_id = $3
    AND state = 'processing'
    AND lease_token = $4::uuid
    AND lease_expires_at > clock_timestamp()
  RETURNING true AS changed
`;

const RELEASE_RECEIPT_SQL = `
  UPDATE public.proofstack_consumer_receipts
  SET state = 'available',
      available_at = clock_timestamp() + ($5::integer * interval '1 millisecond'),
      lease_token = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error = $6
  WHERE tenant_id = $1
    AND consumer_name = $2
    AND message_id = $3
    AND state = 'processing'
    AND lease_token = $4::uuid
    AND lease_expires_at > clock_timestamp()
  RETURNING true AS changed
`;

function requireTenantId(value: string): string {
  const parsed = OpaqueIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("tenantId must be a valid opaque identifier");
  return parsed.data;
}

function requireConsumerName(value: string): string {
  if (!CONSUMER_NAME_PATTERN.test(value)) {
    throw new TypeError("consumerName must be a valid namespaced consumer identifier");
  }
  return value;
}

function requireMessageId(value: string): string {
  if (value.length < 1 || value.length > 128) {
    throw new RangeError("messageId must contain between 1 and 128 characters");
  }
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

function validateKey(tenantId: string, key: ConsumerReceiptKey) {
  return {
    consumerName: requireConsumerName(key.consumerName),
    messageId: requireMessageId(key.messageId),
    tenantId: requireTenantId(tenantId),
  };
}

function integrityViolation(message: string): never {
  throw new PostgresDataIntegrityError(message);
}

function receiptFromRow(
  row: ConsumerReceiptRow,
  expected: {
    readonly consumerName: string;
    readonly messageId: string;
    readonly tenantId: string;
  },
): ConsumerReceipt {
  if (row.tenant_id !== expected.tenantId || !OpaqueIdSchema.safeParse(row.tenant_id).success) {
    integrityViolation("Stored consumer receipt tenant does not match its transaction scope");
  }
  if (
    row.consumer_name !== expected.consumerName ||
    !CONSUMER_NAME_PATTERN.test(row.consumer_name)
  ) {
    integrityViolation("Stored consumer receipt consumer is invalid");
  }
  if (
    row.message_id !== expected.messageId ||
    row.message_id.length < 1 ||
    row.message_id.length > 128
  ) {
    integrityViolation("Stored consumer receipt message identifier is invalid");
  }
  if (!Sha256Schema.safeParse(row.payload_sha256).success) {
    integrityViolation("Stored consumer receipt payload digest is invalid");
  }
  if (
    !Number.isInteger(row.attempt_count) ||
    row.attempt_count < 1 ||
    row.attempt_count > 1_000_000
  ) {
    integrityViolation("Stored consumer receipt attempt count is invalid");
  }
  if (!TimestampSchema.safeParse(row.created_at).success) {
    integrityViolation("Stored consumer receipt creation time is invalid");
  }
  if (
    !TimestampSchema.safeParse(row.available_at).success ||
    typeof row.available_due !== "boolean"
  ) {
    integrityViolation("Stored consumer receipt availability state is invalid");
  }
  if (row.last_error !== null && (row.last_error.length < 1 || row.last_error.length > 2_048)) {
    integrityViolation("Stored consumer receipt error summary is invalid");
  }

  const leaseValues = [row.lease_token, row.lease_owner, row.lease_expires_at];
  const hasNoLease = leaseValues.every((value) => value === null);
  const hasCompleteLease = leaseValues.every((value) => typeof value === "string");
  if (!hasNoLease && !hasCompleteLease) {
    integrityViolation("Stored consumer receipt has an incomplete lease");
  }
  if (hasCompleteLease) {
    if (!UUID_PATTERN.test(row.lease_token as string)) {
      integrityViolation("Stored consumer receipt lease token is invalid");
    }
    if (!OpaqueIdSchema.safeParse(row.lease_owner).success) {
      integrityViolation("Stored consumer receipt lease owner is invalid");
    }
    if (!TimestampSchema.safeParse(row.lease_expires_at).success) {
      integrityViolation("Stored consumer receipt lease expiry is invalid");
    }
  }

  if (row.state === "available") {
    if (
      !hasNoLease ||
      row.completed_at !== null ||
      row.last_error === null ||
      row.lease_current !== null
    ) {
      integrityViolation("Stored available consumer receipt has an invalid state shape");
    }
  } else if (row.state === "processing") {
    if (!hasCompleteLease || row.completed_at !== null || typeof row.lease_current !== "boolean") {
      integrityViolation("Stored processing consumer receipt has an invalid state shape");
    }
  } else if (row.state === "completed") {
    if (
      !hasNoLease ||
      row.last_error !== null ||
      row.lease_current !== null ||
      !TimestampSchema.safeParse(row.completed_at).success
    ) {
      integrityViolation("Stored completed consumer receipt has an invalid state shape");
    }
  } else {
    integrityViolation("Stored consumer receipt state is invalid");
  }

  return {
    attemptCount: row.attempt_count,
    availableAt: row.available_at,
    completedAt: row.completed_at,
    consumerName: row.consumer_name,
    createdAt: row.created_at,
    lastError: row.last_error,
    lease: hasNoLease
      ? null
      : {
          expiresAt: row.lease_expires_at as string,
          owner: row.lease_owner as string,
          token: row.lease_token as string,
        },
    messageId: row.message_id,
    payloadSha256: row.payload_sha256,
    state: row.state,
    tenantId: row.tenant_id,
  };
}

async function lockReceipt(
  client: PoolClient,
  key: { readonly consumerName: string; readonly messageId: string; readonly tenantId: string },
): Promise<{ readonly receipt: ConsumerReceipt; readonly row: ConsumerReceiptRow } | null> {
  const result = await client.query<ConsumerReceiptRow>(LOCK_RECEIPT_SQL, [
    key.tenantId,
    key.consumerName,
    key.messageId,
  ]);
  const row = result.rows[0];
  return row ? { receipt: receiptFromRow(row, key), row } : null;
}

export class PostgresConsumerReceiptRepository implements ConsumerReceiptRepository {
  constructor(
    private readonly pool: Pick<Pool, "connect">,
    private readonly createLeaseToken: () => string = randomUUID,
  ) {}

  async get(tenantId: string, key: ConsumerReceiptKey): Promise<ConsumerReceipt | null> {
    const validated = validateKey(tenantId, key);
    return withTenantTransaction(this.pool, validated.tenantId, async (client) => {
      const result = await client.query<ConsumerReceiptRow>(GET_RECEIPT_SQL, [
        validated.tenantId,
        validated.consumerName,
        validated.messageId,
      ]);
      const row = result.rows[0];
      return row ? receiptFromRow(row, validated) : null;
    });
  }

  async claim(
    tenantId: string,
    options: ClaimConsumerReceiptOptions,
  ): Promise<ClaimConsumerReceiptResult> {
    const validated = validateKey(tenantId, options);
    const payloadSha256 = Sha256Schema.parse(options.payloadSha256);
    const workerId = OpaqueIdSchema.parse(options.workerId);
    const leaseDurationMs = requireBoundedInteger(
      options.leaseDurationMs,
      1,
      MAX_CONSUMER_RECEIPT_LEASE_DURATION_MS,
      "leaseDurationMs",
    );
    const leaseToken = requireLeaseToken(this.createLeaseToken());

    return withTenantTransaction(this.pool, validated.tenantId, async (client) => {
      let current = await lockReceipt(client, validated);
      if (!current) {
        const inserted = await client.query<ConsumerReceiptRow>(INSERT_PROCESSING_RECEIPT_SQL, [
          validated.tenantId,
          validated.consumerName,
          validated.messageId,
          payloadSha256,
          leaseToken,
          workerId,
          leaseDurationMs,
        ]);
        const insertedRow = inserted.rows[0];
        if (insertedRow) {
          return { receipt: receiptFromRow(insertedRow, validated), status: "acquired" };
        }

        current = await lockReceipt(client, validated);
        if (!current) {
          throw new PostgresDataIntegrityError(
            "Consumer receipt disappeared after a concurrent insert",
          );
        }
      }

      if (current.receipt.payloadSha256 !== payloadSha256) {
        throw new ConsumerReceiptConflictError(validated.consumerName, validated.messageId);
      }
      if (current.receipt.state === "completed") {
        return { receipt: current.receipt, status: "completed" };
      }
      if (current.receipt.state === "processing" && current.row.lease_current) {
        return { receipt: current.receipt, status: "busy" };
      }
      if (current.receipt.state === "available" && !current.row.available_due) {
        return { receipt: current.receipt, status: "deferred" };
      }

      const reclaimed = await client.query<ConsumerReceiptRow>(RECLAIM_RECEIPT_SQL, [
        validated.tenantId,
        validated.consumerName,
        validated.messageId,
        leaseToken,
        workerId,
        leaseDurationMs,
      ]);
      const reclaimedRow = reclaimed.rows[0];
      if (!reclaimedRow) {
        throw new PostgresDataIntegrityError("Locked consumer receipt could not be reclaimed");
      }
      return { receipt: receiptFromRow(reclaimedRow, validated), status: "acquired" };
    });
  }

  async complete(tenantId: string, options: CompleteConsumerReceiptOptions): Promise<boolean> {
    const validated = validateKey(tenantId, options);
    const leaseToken = requireLeaseToken(options.leaseToken);
    return withTenantTransaction(this.pool, validated.tenantId, async (client) => {
      const result = await client.query<MutationRow>(COMPLETE_RECEIPT_SQL, [
        validated.tenantId,
        validated.consumerName,
        validated.messageId,
        leaseToken,
      ]);
      return result.rows[0]?.changed === true;
    });
  }

  async release(tenantId: string, options: ReleaseConsumerReceiptOptions): Promise<boolean> {
    const validated = validateKey(tenantId, options);
    const leaseToken = requireLeaseToken(options.leaseToken);
    const retryDelayMs = requireBoundedInteger(
      options.retryDelayMs,
      0,
      MAX_CONSUMER_RECEIPT_RETRY_DELAY_MS,
      "retryDelayMs",
    );
    if (options.error.length < 1 || options.error.length > MAX_CONSUMER_RECEIPT_ERROR_LENGTH) {
      throw new RangeError(
        `error must contain between 1 and ${MAX_CONSUMER_RECEIPT_ERROR_LENGTH} characters`,
      );
    }

    return withTenantTransaction(this.pool, validated.tenantId, async (client) => {
      const result = await client.query<MutationRow>(RELEASE_RECEIPT_SQL, [
        validated.tenantId,
        validated.consumerName,
        validated.messageId,
        leaseToken,
        retryDelayMs,
        options.error,
      ]);
      return result.rows[0]?.changed === true;
    });
  }
}
