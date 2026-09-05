import { Buffer } from "node:buffer";
import type {
  ComparisonDefinition,
  ComparisonEvidenceSnapshot,
  ComparisonResult,
  EvidenceScope,
} from "@proofstack/contracts";
import {
  ComparisonLineageError,
  type ComparisonRecord,
  ComparisonRecordConflictError,
  comparisonRecordId,
  type ComparisonRecordKind,
  comparisonRecordReferences,
  type ComparisonRepository,
  ComparisonRepositoryContractError,
  ComparisonResourceConflictError,
  InvalidComparisonRecordInputError,
  type PublishComparisonRecordResult,
  validateComparisonRecord,
} from "@proofstack/core";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { withTenantTransaction } from "./tenant-transaction.js";

interface StoredComparisonRow extends QueryResultRow {
  readonly actor_principal_id: string;
  readonly comparison_id: string;
  readonly comparison_role: string | null;
  readonly comparison_version_id: string;
  readonly created_at_lexical: string;
  readonly definition_sha256: string;
  readonly environment_id: string;
  readonly lineage_count: number;
  readonly project_id: string;
  readonly record: unknown;
  readonly record_id: string;
  readonly record_kind: string;
  readonly schema_version: string;
  readonly tenant_id: string;
}

interface OutboxIntentRow extends QueryResultRow {
  readonly status: string;
}

interface ComparisonProjection {
  readonly actorPrincipalId: string;
  readonly comparisonId: string;
  readonly comparisonRole: "baseline" | "candidate" | null;
  readonly comparisonVersionId: string;
  readonly createdAt: string;
}

interface ComparisonOutboxIntent {
  readonly aggregateId: string;
  readonly aggregateType: ComparisonRecordKind;
  readonly createdAt: string;
  readonly eventType:
    | "comparison.definition.published"
    | "comparison.result.recorded"
    | "comparison.snapshot.recorded";
  readonly payload: Readonly<Record<string, unknown>>;
  readonly schemaVersion: string;
}

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function projection(kind: ComparisonRecordKind, record: ComparisonRecord): ComparisonProjection {
  switch (kind) {
    case "comparison_definition": {
      const definition = record as ComparisonDefinition;
      return {
        actorPrincipalId: definition.createdByPrincipalId,
        comparisonId: definition.comparisonId,
        comparisonRole: null,
        comparisonVersionId: definition.comparisonVersionId,
        createdAt: definition.createdAt,
      };
    }
    case "comparison_evidence_snapshot": {
      const snapshot = record as ComparisonEvidenceSnapshot;
      return {
        actorPrincipalId: snapshot.createdByPrincipalId,
        comparisonId: snapshot.comparison.comparisonId,
        comparisonRole: snapshot.role,
        comparisonVersionId: snapshot.comparison.comparisonVersionId,
        createdAt: snapshot.createdAt,
      };
    }
    case "comparison_result": {
      const result = record as ComparisonResult;
      return {
        actorPrincipalId: result.createdByPrincipalId,
        comparisonId: result.comparison.comparisonId,
        comparisonRole: null,
        comparisonVersionId: result.comparison.comparisonVersionId,
        createdAt: result.createdAt,
      };
    }
  }
}

function outboxIntent(
  kind: ComparisonRecordKind,
  recordId: string,
  record: ComparisonRecord,
  createdAt: string,
): ComparisonOutboxIntent {
  const eventType =
    kind === "comparison_definition"
      ? "comparison.definition.published"
      : kind === "comparison_evidence_snapshot"
        ? "comparison.snapshot.recorded"
        : "comparison.result.recorded";
  return {
    aggregateId: recordId,
    aggregateType: kind,
    createdAt,
    eventType,
    payload: { record: clone(record), recordKind: kind },
    schemaVersion: record.schemaVersion,
  };
}

function scopesEqual(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function postgresMessage(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : "";
}

function mapPersistenceError(
  error: unknown,
  kind: ComparisonRecordKind,
  recordId: string,
  comparisonId: string,
  references: ReturnType<typeof comparisonRecordReferences>,
): never {
  if (
    error instanceof ComparisonLineageError ||
    error instanceof ComparisonRecordConflictError ||
    error instanceof ComparisonRepositoryContractError ||
    error instanceof ComparisonResourceConflictError ||
    error instanceof InvalidComparisonRecordInputError
  ) {
    throw error;
  }
  const code = postgresCode(error);
  const message = postgresMessage(error);
  if (code === "23503" || (code === "23514" && /lineage/i.test(message))) {
    const reference = references[0] ?? { recordId, recordKind: kind };
    throw new ComparisonLineageError(kind, recordId, reference.recordKind, reference.recordId);
  }
  if (code === "23505" && /comparison resource/i.test(message)) {
    throw new ComparisonResourceConflictError(comparisonId);
  }
  if (code === "23505") throw new ComparisonRecordConflictError(kind, recordId);
  if (code === "23514" || code === "22007" || code === "22P02") {
    throw new ComparisonRepositoryContractError(
      `PostgreSQL rejected normalized ${kind} persistence`,
      { cause: error },
    );
  }
  throw error;
}

async function acquireLocks(client: PoolClient, keys: readonly string[]): Promise<void> {
  const ordered = [...new Set(keys)].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  for (const key of ordered) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
  }
}

async function loadStored(
  client: PoolClient,
  kind: ComparisonRecordKind,
  tenantId: string,
  recordId: string,
): Promise<StoredComparisonRow | null> {
  const result = await client.query<StoredComparisonRow>(
    `SELECT tenant_id, project_id, environment_id, record_kind, record_id,
       schema_version, definition_sha256, created_at_lexical, actor_principal_id,
       comparison_id, comparison_version_id, comparison_role, lineage_count, record
     FROM public.proofstack_comparison_records
     WHERE tenant_id = $1 AND record_kind = $2 AND record_id = $3`,
    [tenantId, kind, recordId],
  );
  return result.rows[0] ?? null;
}

function parseStored(kind: ComparisonRecordKind, row: StoredComparisonRow): ComparisonRecord {
  try {
    const record = validateComparisonRecord(kind, row.record);
    const projected = projection(kind, record);
    if (
      record.scope.tenantId !== row.tenant_id ||
      record.scope.projectId !== row.project_id ||
      record.scope.environmentId !== row.environment_id ||
      kind !== row.record_kind ||
      comparisonRecordId(kind, record) !== row.record_id ||
      record.schemaVersion !== row.schema_version ||
      record.definitionSha256 !== row.definition_sha256 ||
      projected.createdAt !== row.created_at_lexical ||
      projected.actorPrincipalId !== row.actor_principal_id ||
      projected.comparisonId !== row.comparison_id ||
      projected.comparisonVersionId !== row.comparison_version_id ||
      projected.comparisonRole !== row.comparison_role ||
      comparisonRecordReferences(kind, record).length !== row.lineage_count
    ) {
      throw new Error("normalized columns differ from the canonical record");
    }
    return record;
  } catch (error) {
    throw new ComparisonRepositoryContractError(
      `Stored ${kind} record violates the canonical comparison contract`,
      { cause: error },
    );
  }
}

async function requireCanonicalOutbox(
  client: PoolClient,
  intent: ComparisonOutboxIntent,
): Promise<void> {
  const result = await client.query<OutboxIntentRow>(
    `SELECT public.proofstack_evaluation_intent_status(
       $1, $2, $3, $4, $5::jsonb, $6::timestamptz
     ) AS status`,
    [
      intent.eventType,
      intent.aggregateType,
      intent.aggregateId,
      intent.schemaVersion,
      JSON.stringify(intent.payload),
      intent.createdAt,
    ],
  );
  if (result.rows[0]?.status !== "canonical") {
    throw new ComparisonRepositoryContractError(
      `Stored comparison record ${intent.aggregateId} is missing its canonical outbox intent`,
    );
  }
}

type ComparisonRecordByKind = {
  readonly comparison_definition: ComparisonDefinition;
  readonly comparison_evidence_snapshot: ComparisonEvidenceSnapshot;
  readonly comparison_result: ComparisonResult;
};

export class PostgresComparisonRepository implements ComparisonRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  private async find<K extends ComparisonRecordKind>(
    scope: EvidenceScope,
    kind: K,
    recordId: string,
  ): Promise<ComparisonRecordByKind[K] | null> {
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const row = await loadStored(client, kind, scope.tenantId, recordId);
      if (!row) return null;
      const record = parseStored(kind, row);
      return scopesEqual(record.scope, scope) ? (clone(record) as ComparisonRecordByKind[K]) : null;
    });
  }

  private async publish<K extends ComparisonRecordKind>(
    kind: K,
    candidate: ComparisonRecordByKind[K],
  ): Promise<PublishComparisonRecordResult<ComparisonRecordByKind[K]>> {
    const record = validateComparisonRecord(kind, candidate) as ComparisonRecordByKind[K];
    const recordId = comparisonRecordId(kind, record);
    const references = comparisonRecordReferences(kind, record);
    const projected = projection(kind, record);
    const lockPrefix = `proofstack:comparison:${record.scope.tenantId}`;
    const lockKeys = [
      `${lockPrefix}:record:${kind}:${recordId}`,
      `${lockPrefix}:resource:${projected.comparisonId}`,
      ...references.map(
        (reference) => `${lockPrefix}:record:${reference.recordKind}:${reference.recordId}`,
      ),
    ];

    try {
      return await withTenantTransaction(this.pool, record.scope.tenantId, async (client) => {
        await acquireLocks(client, lockKeys);
        const existingRow = await loadStored(client, kind, record.scope.tenantId, recordId);
        if (existingRow) {
          const existing = parseStored(kind, existingRow);
          if (existing.definitionSha256 !== record.definitionSha256) {
            throw new ComparisonRecordConflictError(kind, recordId);
          }
          const existingProjection = projection(kind, existing);
          await requireCanonicalOutbox(
            client,
            outboxIntent(kind, recordId, existing, existingProjection.createdAt),
          );
          return {
            created: false,
            record: clone(existing) as ComparisonRecordByKind[K],
          };
        }

        const command = {
          actorPrincipalId: projected.actorPrincipalId,
          comparisonId: projected.comparisonId,
          comparisonRole: projected.comparisonRole,
          comparisonVersionId: projected.comparisonVersionId,
          createdAt: projected.createdAt,
          definitionSha256: record.definitionSha256,
          environmentId: record.scope.environmentId,
          projectId: record.scope.projectId,
          record,
          recordId,
          recordKind: kind,
          schemaVersion: record.schemaVersion,
          tenantId: record.scope.tenantId,
        };
        await client.query("SELECT public.proofstack_publish_comparison_record($1::jsonb)", [
          JSON.stringify(command),
        ]);
        return { created: true, record: clone(record) };
      });
    } catch (error) {
      mapPersistenceError(error, kind, recordId, projected.comparisonId, references);
    }
  }

  async findComparisonDefinition(scope: EvidenceScope, comparisonVersionId: string) {
    return this.find(scope, "comparison_definition", comparisonVersionId);
  }

  async findComparisonEvidenceSnapshot(scope: EvidenceScope, snapshotId: string) {
    return this.find(scope, "comparison_evidence_snapshot", snapshotId);
  }

  async findComparisonResult(scope: EvidenceScope, resultId: string) {
    return this.find(scope, "comparison_result", resultId);
  }

  async publishComparisonDefinition(candidate: ComparisonDefinition) {
    return this.publish("comparison_definition", candidate);
  }

  async publishComparisonEvidenceSnapshot(candidate: ComparisonEvidenceSnapshot) {
    return this.publish("comparison_evidence_snapshot", candidate);
  }

  async publishComparisonResult(candidate: ComparisonResult) {
    return this.publish("comparison_result", candidate);
  }
}
