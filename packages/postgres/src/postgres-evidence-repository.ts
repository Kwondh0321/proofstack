import {
  type EvidenceEnvelope,
  EvidenceEnvelopeSchema,
  type EvidenceScope,
} from "@proofstack/contracts";
import {
  EvidenceConflictError,
  type AppendEvidenceResult,
  type EvidencePage,
  type EvidencePageOptions,
  type EvidenceRepository,
} from "@proofstack/core";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { withTenantTransaction } from "./tenant-transaction.js";

interface InsertedEvidenceRow extends QueryResultRow {
  readonly event_id: string;
}

interface DuplicateEvidenceRow extends QueryResultRow {
  readonly identical: boolean;
}

interface CursorPresenceRow extends QueryResultRow {
  readonly cursor_found: boolean;
}

interface StoredEvidenceRow extends QueryResultRow {
  readonly environment_id: string;
  readonly evidence: unknown;
  readonly project_id: string;
  readonly received_at: string;
  readonly schema_version: string;
  readonly tenant_id: string;
}

export class PostgresDataIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PostgresDataIntegrityError";
  }
}

const INSERT_EVIDENCE_SQL = `
  INSERT INTO public.proofstack_evidence_events (
    tenant_id,
    project_id,
    environment_id,
    event_id,
    trace_id,
    span_id,
    parent_span_id,
    started_at,
    sequence,
    received_at,
    schema_version,
    evidence
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
  ON CONFLICT (tenant_id, event_id) DO NOTHING
  RETURNING event_id
`;

const IDENTICAL_EVIDENCE_SQL = `
  SELECT (
    project_id = $3
    AND environment_id = $4
    AND schema_version = $5
    AND evidence = $6::jsonb
  ) AS identical
  FROM public.proofstack_evidence_events
  WHERE tenant_id = $1 AND event_id = $2
`;

const CURSOR_EXISTS_SQL = `
  SELECT EXISTS (
    SELECT 1
    FROM public.proofstack_evidence_events
    WHERE tenant_id = $1
      AND project_id = $2
      AND environment_id = $3
      AND trace_id = $4
      AND started_at = $5::timestamptz
      AND sequence = $6::bigint
      AND event_id = $7
  ) AS cursor_found
`;

const SELECT_EVIDENCE_COLUMNS = `
  tenant_id,
  project_id,
  environment_id,
  schema_version,
  to_char(
    received_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) AS received_at,
  evidence
`;

const LIST_TRACE_FIRST_PAGE_SQL = `
  SELECT ${SELECT_EVIDENCE_COLUMNS}
  FROM public.proofstack_evidence_events
  WHERE tenant_id = $1
    AND project_id = $2
    AND environment_id = $3
    AND trace_id = $4
  ORDER BY started_at, sequence, event_id
  LIMIT $5
`;

const LIST_TRACE_AFTER_SQL = `
  SELECT ${SELECT_EVIDENCE_COLUMNS}
  FROM public.proofstack_evidence_events
  WHERE tenant_id = $1
    AND project_id = $2
    AND environment_id = $3
    AND trace_id = $4
    AND (started_at, sequence, event_id) > (
      $5::timestamptz,
      $6::bigint,
      $7::varchar
    )
  ORDER BY started_at, sequence, event_id
  LIMIT $8
`;

function insertValues(envelope: EvidenceEnvelope): unknown[] {
  return [
    envelope.scope.tenantId,
    envelope.scope.projectId,
    envelope.scope.environmentId,
    envelope.evidence.eventId,
    envelope.evidence.traceId,
    envelope.evidence.spanId,
    envelope.evidence.parentSpanId ?? null,
    envelope.evidence.startedAt,
    envelope.evidence.sequence ?? 0,
    envelope.receivedAt,
    envelope.schemaVersion,
    JSON.stringify(envelope.evidence),
  ];
}

function storedEnvelope(row: StoredEvidenceRow): EvidenceEnvelope {
  const parsed = EvidenceEnvelopeSchema.safeParse({
    evidence: row.evidence,
    receivedAt: row.received_at,
    schemaVersion: row.schema_version,
    scope: {
      environmentId: row.environment_id,
      projectId: row.project_id,
      tenantId: row.tenant_id,
    },
  });
  if (!parsed.success) {
    throw new PostgresDataIntegrityError(
      "Stored evidence does not satisfy the canonical contract",
      {
        cause: parsed.error,
      },
    );
  }
  return parsed.data;
}

async function appendEnvelope(client: PoolClient, envelope: EvidenceEnvelope): Promise<boolean> {
  const inserted = await client.query<InsertedEvidenceRow>(
    INSERT_EVIDENCE_SQL,
    insertValues(envelope),
  );
  if (inserted.rows.length === 1) return true;

  const duplicate = await client.query<DuplicateEvidenceRow>(IDENTICAL_EVIDENCE_SQL, [
    envelope.scope.tenantId,
    envelope.evidence.eventId,
    envelope.scope.projectId,
    envelope.scope.environmentId,
    envelope.schemaVersion,
    JSON.stringify(envelope.evidence),
  ]);
  const comparison = duplicate.rows[0];
  if (!comparison) {
    throw new PostgresDataIntegrityError(
      `Conflicting event ${envelope.evidence.eventId} was not visible inside its tenant transaction`,
    );
  }
  if (!comparison.identical) throw new EvidenceConflictError(envelope.evidence.eventId);
  return false;
}

export class PostgresEvidenceRepository implements EvidenceRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async append(envelopes: readonly EvidenceEnvelope[]): Promise<AppendEvidenceResult> {
    if (envelopes.length === 0) return { acceptedEventIds: [], duplicateEventIds: [] };

    const tenantId = envelopes[0]?.scope.tenantId;
    if (!tenantId || envelopes.some((envelope) => envelope.scope.tenantId !== tenantId)) {
      throw new TypeError("An evidence batch must belong to exactly one tenant");
    }

    return withTenantTransaction(this.pool, tenantId, async (client) => {
      const acceptedEventIds: string[] = [];
      const duplicateEventIds: string[] = [];

      for (const envelope of envelopes) {
        if (await appendEnvelope(client, envelope)) {
          acceptedEventIds.push(envelope.evidence.eventId);
        } else {
          duplicateEventIds.push(envelope.evidence.eventId);
        }
      }

      return { acceptedEventIds, duplicateEventIds };
    });
  }

  async listByTrace(
    scope: EvidenceScope,
    traceId: string,
    options: EvidencePageOptions,
  ): Promise<EvidencePage> {
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const after = options.after;
      if (after) {
        const cursor = await client.query<CursorPresenceRow>(CURSOR_EXISTS_SQL, [
          scope.tenantId,
          scope.projectId,
          scope.environmentId,
          traceId,
          after.startedAt,
          after.sequence,
          after.eventId,
        ]);
        if (!cursor.rows[0]?.cursor_found) {
          return { cursorFound: false, events: [], hasMore: false };
        }
      }

      const pageSize = options.limit + 1;
      const result = after
        ? await client.query<StoredEvidenceRow>(LIST_TRACE_AFTER_SQL, [
            scope.tenantId,
            scope.projectId,
            scope.environmentId,
            traceId,
            after.startedAt,
            after.sequence,
            after.eventId,
            pageSize,
          ])
        : await client.query<StoredEvidenceRow>(LIST_TRACE_FIRST_PAGE_SQL, [
            scope.tenantId,
            scope.projectId,
            scope.environmentId,
            traceId,
            pageSize,
          ]);
      const hasMore = result.rows.length > options.limit;
      return {
        cursorFound: true,
        events: result.rows.slice(0, options.limit).map(storedEnvelope),
        hasMore,
      };
    });
  }
}
