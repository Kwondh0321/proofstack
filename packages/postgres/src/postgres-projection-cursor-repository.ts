import { OpaqueIdSchema, TimestampSchema } from "@proofstack/contracts";
import {
  type AdvanceProjectionCursorOptions,
  type AdvanceProjectionCursorResult,
  type ProjectionCursor,
  type ProjectionCursorKey,
  ProjectionCursorRegressionError,
  type ProjectionCursorRepository,
} from "@proofstack/core";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { PostgresDataIntegrityError } from "./postgres-evidence-repository.js";
import { withTenantTransaction } from "./tenant-transaction.js";

export const MAX_PROJECTION_CURSOR_GENERATION = 1_000_000;

const CONSUMER_NAME_PATTERN = /^[a-z][a-z0-9_.-]{2,127}$/;
const MAX_BIGINT = 9_223_372_036_854_775_807n;

interface ProjectionCursorRow extends QueryResultRow {
  readonly consumer_name: string;
  readonly generation: number;
  readonly last_outbox_id: string;
  readonly tenant_id: string;
  readonly updated_at: string;
}

const SELECT_CURSOR_COLUMNS = `
  tenant_id,
  consumer_name,
  generation,
  last_outbox_id::text,
  to_char(
    updated_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) AS updated_at
`;

const GET_CURSOR_SQL = `
  SELECT ${SELECT_CURSOR_COLUMNS}
  FROM public.proofstack_projection_cursors
  WHERE tenant_id = $1 AND consumer_name = $2 AND generation = $3
`;

const LOCK_CURSOR_SQL = `${GET_CURSOR_SQL} FOR UPDATE`;

const INSERT_CURSOR_SQL = `
  INSERT INTO public.proofstack_projection_cursors (
    tenant_id,
    consumer_name,
    generation,
    last_outbox_id
  ) VALUES ($1, $2, $3, $4::bigint)
  ON CONFLICT (tenant_id, consumer_name, generation) DO NOTHING
  RETURNING ${SELECT_CURSOR_COLUMNS}
`;

const UPDATE_CURSOR_SQL = `
  UPDATE public.proofstack_projection_cursors
  SET last_outbox_id = $4::bigint,
      updated_at = clock_timestamp()
  WHERE tenant_id = $1 AND consumer_name = $2 AND generation = $3
  RETURNING ${SELECT_CURSOR_COLUMNS}
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

function requireGeneration(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PROJECTION_CURSOR_GENERATION) {
    throw new RangeError(`generation must be between 1 and ${MAX_PROJECTION_CURSOR_GENERATION}`);
  }
  return value;
}

function requirePosition(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError("lastOutboxId must be a non-negative integer");
  }
  if (BigInt(value) > MAX_BIGINT) {
    throw new TypeError("lastOutboxId exceeds the PostgreSQL bigint range");
  }
  return value;
}

function cursorFromRow(
  row: ProjectionCursorRow,
  expectedTenantId: string,
  expectedKey: ProjectionCursorKey,
): ProjectionCursor {
  if (row.tenant_id !== expectedTenantId || !OpaqueIdSchema.safeParse(row.tenant_id).success) {
    throw new PostgresDataIntegrityError(
      "Stored projection cursor tenant does not match its transaction scope",
    );
  }
  if (
    row.consumer_name !== expectedKey.consumerName ||
    !CONSUMER_NAME_PATTERN.test(row.consumer_name)
  ) {
    throw new PostgresDataIntegrityError("Stored projection cursor consumer is invalid");
  }
  if (row.generation !== expectedKey.generation || !Number.isInteger(row.generation)) {
    throw new PostgresDataIntegrityError("Stored projection cursor generation is invalid");
  }
  try {
    requirePosition(row.last_outbox_id);
  } catch (cause) {
    throw new PostgresDataIntegrityError("Stored projection cursor position is invalid", {
      cause,
    });
  }
  if (!TimestampSchema.safeParse(row.updated_at).success) {
    throw new PostgresDataIntegrityError("Stored projection cursor update time is invalid");
  }

  return {
    consumerName: row.consumer_name,
    generation: row.generation,
    lastOutboxId: row.last_outbox_id,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
  };
}

async function lockCursor(
  client: PoolClient,
  tenantId: string,
  key: ProjectionCursorKey,
): Promise<ProjectionCursor | null> {
  const result = await client.query<ProjectionCursorRow>(LOCK_CURSOR_SQL, [
    tenantId,
    key.consumerName,
    key.generation,
  ]);
  const row = result.rows[0];
  return row ? cursorFromRow(row, tenantId, key) : null;
}

export class PostgresProjectionCursorRepository implements ProjectionCursorRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async get(tenantId: string, key: ProjectionCursorKey): Promise<ProjectionCursor | null> {
    const tenant = requireTenantId(tenantId);
    const consumerName = requireConsumerName(key.consumerName);
    const generation = requireGeneration(key.generation);
    const validatedKey = { consumerName, generation };

    return withTenantTransaction(this.pool, tenant, async (client) => {
      const result = await client.query<ProjectionCursorRow>(GET_CURSOR_SQL, [
        tenant,
        consumerName,
        generation,
      ]);
      const row = result.rows[0];
      return row ? cursorFromRow(row, tenant, validatedKey) : null;
    });
  }

  async advance(
    tenantId: string,
    options: AdvanceProjectionCursorOptions,
  ): Promise<AdvanceProjectionCursorResult> {
    const tenant = requireTenantId(tenantId);
    const consumerName = requireConsumerName(options.consumerName);
    const generation = requireGeneration(options.generation);
    const lastOutboxId = requirePosition(options.lastOutboxId);
    const key = { consumerName, generation };

    return withTenantTransaction(this.pool, tenant, async (client) => {
      let current = await lockCursor(client, tenant, key);
      if (!current) {
        const inserted = await client.query<ProjectionCursorRow>(INSERT_CURSOR_SQL, [
          tenant,
          consumerName,
          generation,
          lastOutboxId,
        ]);
        const insertedRow = inserted.rows[0];
        if (insertedRow) {
          return { advanced: true, cursor: cursorFromRow(insertedRow, tenant, key) };
        }

        current = await lockCursor(client, tenant, key);
        if (!current) {
          throw new PostgresDataIntegrityError(
            "Projection cursor disappeared after a concurrent insert",
          );
        }
      }

      const currentPosition = BigInt(current.lastOutboxId);
      const requestedPosition = BigInt(lastOutboxId);
      if (requestedPosition < currentPosition) {
        throw new ProjectionCursorRegressionError(current.lastOutboxId, lastOutboxId);
      }
      if (requestedPosition === currentPosition) {
        return { advanced: false, cursor: current };
      }

      const updated = await client.query<ProjectionCursorRow>(UPDATE_CURSOR_SQL, [
        tenant,
        consumerName,
        generation,
        lastOutboxId,
      ]);
      const updatedRow = updated.rows[0];
      if (!updatedRow) {
        throw new PostgresDataIntegrityError("Locked projection cursor could not be advanced");
      }
      return { advanced: true, cursor: cursorFromRow(updatedRow, tenant, key) };
    });
  }
}
