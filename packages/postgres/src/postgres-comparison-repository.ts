import { Buffer } from "node:buffer";
import type {
  ComparisonDefinition,
  ComparisonEvidenceSnapshot,
  ComparisonResult,
  EvidenceScope,
} from "@proofstack/contracts";
import {
  COMPARISON_DEFINITION_SCHEMA_VERSION,
  COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
  COMPARISON_RESULT_SCHEMA_VERSION,
} from "@proofstack/contracts";
import {
  ComparisonLineageError,
  type ComparisonRecord,
  ComparisonRecordConflictError,
  type ComparisonRecordKind,
  type ComparisonRepository,
  ComparisonRepositoryContractError,
  ComparisonResourceConflictError,
  comparisonRecordId,
  comparisonRecordReferences,
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
  readonly created_at_matches: boolean;
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

interface RegistryRow extends QueryResultRow {
  readonly project_id: string;
  readonly environment_id: string;
  readonly schema_version: string;
  readonly definition_sha256: string;
}
interface LineageRow extends QueryResultRow {
  readonly edge_position: number;
  readonly parent_record_kind: ComparisonRecordKind;
  readonly parent_record_id: string;
  readonly parent_definition_sha256: string;
  readonly parent_schema_version: string;
  readonly child_matches: boolean;
  readonly parent_matches: boolean;
}
interface ResourceRow extends QueryResultRow {
  readonly project_id: string;
  readonly environment_id: string;
  readonly root_record_kind: string;
  readonly root_record_id: string;
  readonly root_definition_sha256: string;
}
interface PresenceRow extends QueryResultRow {
  readonly retained_comparison_body: boolean;
  readonly retained_comparison_storage: boolean;
}

const schemaVersions = {
  comparison_definition: COMPARISON_DEFINITION_SCHEMA_VERSION,
  comparison_evidence_snapshot: COMPARISON_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
  comparison_result: COMPARISON_RESULT_SCHEMA_VERSION,
} satisfies Record<ComparisonRecordKind, string>;

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
  client: Pick<PoolClient, "query">,
  kind: ComparisonRecordKind,
  tenantId: string,
  recordId: string,
  exactScope?: EvidenceScope,
): Promise<StoredComparisonRow | null> {
  const result = await client.query<StoredComparisonRow>(
    `SELECT tenant_id, project_id, environment_id, record_kind, record_id,
       schema_version, definition_sha256, created_at_lexical,
       isfinite(created_at) AND created_at = created_at_lexical::timestamptz AS created_at_matches,
       actor_principal_id,
       comparison_id, comparison_version_id, comparison_role, lineage_count, record
     FROM public.proofstack_comparison_records
     WHERE tenant_id = $1 AND record_kind = $2 AND record_id = $3
       ${exactScope ? "AND project_id = $4 AND environment_id = $5" : ""}`,
    [
      tenantId,
      kind,
      recordId,
      ...(exactScope ? [exactScope.projectId, exactScope.environmentId] : []),
    ],
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
      row.created_at_matches !== true ||
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
  client: Pick<PoolClient, "query">,
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

async function requireRegistryAndLineage(
  client: Pick<PoolClient, "query">,
  kind: ComparisonRecordKind,
  record: ComparisonRecord,
): Promise<void> {
  const scope = record.scope;
  const id = comparisonRecordId(kind, record);
  const references = comparisonRecordReferences(kind, record);
  if (references.length > 3)
    throw new ComparisonRepositoryContractError("Comparison physical reference limit exceeded");
  const registry = await client.query<RegistryRow>(
    `SELECT project_id, environment_id, schema_version, definition_sha256
     FROM public.proofstack_comparison_record_registry
     WHERE tenant_id=$1 AND record_kind=$2 AND record_id=$3 LIMIT 2`,
    [scope.tenantId, kind, id],
  );
  const child = registry.rows[0];
  if (
    registry.rows.length !== 1 ||
    !child ||
    child.project_id !== scope.projectId ||
    child.environment_id !== scope.environmentId ||
    child.schema_version !== record.schemaVersion ||
    child.definition_sha256 !== record.definitionSha256
  )
    throw new ComparisonRepositoryContractError(
      "Stored comparison registry differs from its canonical body",
    );
  const lineage = await client.query<LineageRow>(
    `SELECT edge.edge_position, edge.parent_record_kind, edge.parent_record_id,
       edge.parent_definition_sha256, parent.schema_version AS parent_schema_version,
       (edge.project_id=$4 AND edge.environment_id=$5 AND edge.child_definition_sha256=$6) AS child_matches,
       (parent.record_id IS NOT NULL) AS parent_matches
     FROM public.proofstack_comparison_lineage AS edge
     LEFT JOIN public.proofstack_comparison_record_registry AS parent
       ON parent.tenant_id=edge.tenant_id AND parent.project_id=edge.project_id
       AND parent.environment_id=edge.environment_id AND parent.record_kind=edge.parent_record_kind
       AND parent.record_id=edge.parent_record_id AND parent.definition_sha256=edge.parent_definition_sha256
     WHERE edge.tenant_id=$1 AND edge.child_record_kind=$2 AND edge.child_record_id=$3
     ORDER BY edge.edge_position LIMIT $7`,
    [
      scope.tenantId,
      kind,
      id,
      scope.projectId,
      scope.environmentId,
      record.definitionSha256,
      references.length + 1,
    ],
  );
  if (lineage.rows.length !== references.length)
    throw new ComparisonRepositoryContractError(
      "Stored comparison physical lineage is incomplete or excessive",
    );
  for (const [position, edge] of lineage.rows.entries()) {
    const expected = references[position];
    if (
      !expected ||
      edge.edge_position !== position ||
      edge.child_matches !== true ||
      edge.parent_matches !== true ||
      edge.parent_record_kind !== expected.recordKind ||
      edge.parent_record_id !== expected.recordId ||
      edge.parent_definition_sha256 !== expected.definitionSha256 ||
      edge.parent_schema_version !== schemaVersions[expected.recordKind]
    )
      throw new ComparisonRepositoryContractError(
        "Stored comparison physical lineage differs from its canonical positional references",
      );
  }
  await requireCanonicalOutbox(
    client,
    outboxIntent(kind, id, record, projection(kind, record).createdAt),
  );
}

async function requirePhysicalIntegrity(
  client: Pick<PoolClient, "query">,
  kind: ComparisonRecordKind,
  record: ComparisonRecord,
): Promise<void> {
  await requireRegistryAndLineage(client, kind, record);
  const scope = record.scope;
  const comparisonId = projection(kind, record).comparisonId;
  const resources = await client.query<ResourceRow>(
    `SELECT project_id, environment_id, root_record_kind, root_record_id, root_definition_sha256
     FROM public.proofstack_comparison_resource_bindings
     WHERE tenant_id=$1 AND comparison_id=$2 LIMIT 2`,
    [scope.tenantId, comparisonId],
  );
  const binding = resources.rows[0];
  if (
    resources.rows.length !== 1 ||
    !binding ||
    binding.project_id !== scope.projectId ||
    binding.environment_id !== scope.environmentId ||
    binding.root_record_kind !== "comparison_definition"
  )
    throw new ComparisonRepositoryContractError(
      "Stored comparison logical resource binding is inconsistent",
    );
  let root: ComparisonRecord = record;
  if (
    kind !== "comparison_definition" ||
    binding.root_record_id !== comparisonRecordId(kind, record)
  ) {
    const stored = await loadStored(
      client,
      "comparison_definition",
      scope.tenantId,
      binding.root_record_id,
      scope,
    );
    if (!stored)
      throw new ComparisonRepositoryContractError("Stored comparison logical root body is missing");
    root = parseStored("comparison_definition", stored);
  }
  const definition = root as ComparisonDefinition;
  if (
    !scopesEqual(root.scope, scope) ||
    root.schemaVersion !== COMPARISON_DEFINITION_SCHEMA_VERSION ||
    definition.comparisonId !== comparisonId ||
    definition.comparisonVersionId !== binding.root_record_id ||
    root.definitionSha256 !== binding.root_definition_sha256
  )
    throw new ComparisonRepositoryContractError(
      "Stored comparison logical root differs from its canonical resource",
    );
  if (root !== record) await requireRegistryAndLineage(client, "comparison_definition", root);
}

async function inspectScopedPresence(
  client: Pick<PoolClient, "query">,
  scope: EvidenceScope,
  kind: ComparisonRecordKind,
  id: string,
): Promise<boolean> {
  const result = await client.query<PresenceRow>(
    `SELECT EXISTS (
       SELECT 1 FROM public.proofstack_comparison_records
       WHERE tenant_id=$1 AND project_id=$2 AND environment_id=$3 AND record_kind=$4 AND record_id=$5
     ) AS retained_comparison_body, EXISTS (
       SELECT 1 FROM public.proofstack_comparison_record_registry
       WHERE tenant_id=$1 AND project_id=$2 AND environment_id=$3 AND record_kind=$4 AND record_id=$5
     ) OR EXISTS (
       SELECT 1 FROM public.proofstack_comparison_lineage
       WHERE tenant_id=$1 AND project_id=$2 AND environment_id=$3 AND child_record_kind=$4 AND child_record_id=$5
     ) OR EXISTS (
       SELECT 1 FROM public.proofstack_comparison_resource_bindings
       WHERE tenant_id=$1 AND project_id=$2 AND environment_id=$3 AND root_record_kind=$4 AND root_record_id=$5
     ) AS retained_comparison_storage`,
    [scope.tenantId, scope.projectId, scope.environmentId, kind, id],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row ||
    typeof row.retained_comparison_body !== "boolean" ||
    typeof row.retained_comparison_storage !== "boolean" ||
    row.retained_comparison_body !== row.retained_comparison_storage
  )
    throw new ComparisonRepositoryContractError(
      "Stored comparison scoped presence violates its storage contract",
    );
  return row.retained_comparison_body;
}

type ComparisonRecordByKind = {
  readonly comparison_definition: ComparisonDefinition;
  readonly comparison_evidence_snapshot: ComparisonEvidenceSnapshot;
  readonly comparison_result: ComparisonResult;
};

/** Reuses every normalized projection check without changing the caller's transaction. */
export async function readPostgresComparisonRecordOnClient<K extends ComparisonRecordKind>(
  client: Pick<PoolClient, "query">,
  scopeInput: EvidenceScope,
  kind: K,
  recordId: string,
): Promise<ComparisonRecordByKind[K] | null> {
  const scope = { ...scopeInput };
  if (!(await inspectScopedPresence(client, scope, kind, recordId))) return null;
  const row = await loadStored(client, kind, scope.tenantId, recordId, scope);
  if (!row)
    throw new ComparisonRepositoryContractError(
      "Stored comparison body disappeared after its scoped presence observation",
    );
  const record = parseStored(kind, row);
  if (!scopesEqual(record.scope, scope)) return null;
  await requirePhysicalIntegrity(client, kind, record);
  return clone(record) as ComparisonRecordByKind[K];
}

export class PostgresComparisonRepository implements ComparisonRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  private async find<K extends ComparisonRecordKind>(
    scopeInput: EvidenceScope,
    kind: K,
    recordId: string,
  ): Promise<ComparisonRecordByKind[K] | null> {
    const scope = { ...scopeInput };
    return withTenantTransaction(this.pool, scope.tenantId, (client) =>
      readPostgresComparisonRecordOnClient(client, scope, kind, recordId),
    );
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
          await requirePhysicalIntegrity(client, kind, existing);
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
        const storedRow = await loadStored(
          client,
          kind,
          record.scope.tenantId,
          recordId,
          record.scope,
        );
        if (!storedRow)
          throw new ComparisonRepositoryContractError("Published comparison body is missing");
        const stored = parseStored(kind, storedRow);
        if (
          !scopesEqual(stored.scope, record.scope) ||
          stored.definitionSha256 !== record.definitionSha256
        )
          throw new ComparisonRepositoryContractError(
            "Published comparison differs from its requested definition",
          );
        await requirePhysicalIntegrity(client, kind, stored);
        return { created: true, record: clone(stored) as ComparisonRecordByKind[K] };
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
