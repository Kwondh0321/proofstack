import { Buffer } from "node:buffer";
import type { EvidenceScope } from "@proofstack/contracts";
import {
  InvalidModelAssuranceRecordInputError,
  ModelAssuranceLineageError,
  type ModelAssuranceRecord,
  type ModelAssuranceRecordByKind,
  ModelAssuranceRecordConflictError,
  type ModelAssuranceRecordKind,
  type ModelAssuranceRepository,
  ModelAssuranceRepositoryContractError,
  modelAssuranceRecordId,
  modelAssuranceRecordReferences,
  type PublishModelAssuranceRecordResult,
  validateModelAssuranceRecord,
} from "@proofstack/core";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { modelAssuranceStorageReferences } from "./model-assurance-storage-references.js";
import { withTenantTransaction } from "./tenant-transaction.js";

interface StoredRecordRow extends QueryResultRow {
  readonly record_kind: string;
  readonly record_id: string;
  readonly schema_version: string;
  readonly recorded_at_lexical: string;
  readonly recorded_at_matches: boolean;
  readonly actor_principal_id: string | null;
  readonly lifecycle_state: string | null;
  readonly lineage_count: number;
  readonly definition_sha256: string;
  readonly environment_id: string;
  readonly project_id: string;
  readonly record: unknown;
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
  readonly parent_record_kind: string;
  readonly parent_record_id: string;
  readonly parent_definition_sha256: string;
  readonly child_matches: boolean;
  readonly parent_matches: boolean;
  readonly position_matches: boolean;
}

interface ModelAssuranceProjection {
  readonly actorPrincipalId: string | null;
  readonly lifecycleState: string | null;
  readonly recordedAt: string;
}

interface ModelAssuranceOutboxIntent {
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly createdAt: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly schemaVersion: string;
}

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function field(record: ModelAssuranceRecord, name: string): unknown {
  return (record as unknown as Readonly<Record<string, unknown>>)[name];
}

function stringField(record: ModelAssuranceRecord, name: string): string {
  const result = field(record, name);
  if (typeof result !== "string") {
    throw new ModelAssuranceRepositoryContractError(
      `Validated model-assurance record omitted ${name}`,
    );
  }
  return result;
}

function nestedString(record: ModelAssuranceRecord, parent: string, name: string): string {
  const container = field(record, parent);
  if (typeof container !== "object" || container === null || Array.isArray(container)) {
    throw new ModelAssuranceRepositoryContractError(
      `Validated model-assurance record omitted ${parent}`,
    );
  }
  const result = (container as Readonly<Record<string, unknown>>)[name];
  if (typeof result !== "string") {
    throw new ModelAssuranceRepositoryContractError(
      `Validated model-assurance record omitted ${parent}.${name}`,
    );
  }
  return result;
}

function projection(
  kind: ModelAssuranceRecordKind,
  record: ModelAssuranceRecord,
): ModelAssuranceProjection {
  switch (kind) {
    case "blinded_evaluation_plan":
    case "human_review_protocol":
    case "model_assisted_evaluator":
    case "model_evaluator_profile":
    case "model_qualification_suite":
      return {
        actorPrincipalId: stringField(record, "publishedByPrincipalId"),
        lifecycleState: null,
        recordedAt: stringField(record, "publishedAt"),
      };
    case "blinded_evaluation_result":
      return {
        actorPrincipalId: stringField(record, "recordedByPrincipalId"),
        lifecycleState: stringField(record, "status"),
        recordedAt: stringField(record, "recordedAt"),
      };
    case "calibration_report":
    case "model_qualification_report":
      return {
        actorPrincipalId: stringField(record, "executedByPrincipalId"),
        lifecycleState: stringField(record, "status"),
        recordedAt: stringField(record, "recordedAt"),
      };
    case "human_review_record":
      return {
        actorPrincipalId: nestedString(record, "reviewer", "principalId"),
        lifecycleState: stringField(record, "action"),
        recordedAt: stringField(record, "recordedAt"),
      };
    case "human_reviewer_independence":
      return {
        actorPrincipalId: stringField(record, "reviewedByPrincipalId"),
        lifecycleState: stringField(record, "status"),
        recordedAt: stringField(record, "recordedAt"),
      };
    case "independence_declaration":
      return {
        actorPrincipalId: stringField(record, "reviewedByPrincipalId"),
        lifecycleState: stringField(record, "reviewStatus"),
        recordedAt: stringField(record, "recordedAt"),
      };
    case "independent_critique":
      return {
        actorPrincipalId: stringField(record, "recordedByPrincipalId"),
        lifecycleState: nestedString(record, "outcome", "status"),
        recordedAt: stringField(record, "recordedAt"),
      };
    case "model_assurance_assessment":
      return {
        actorPrincipalId: null,
        lifecycleState: stringField(record, "eligibility"),
        recordedAt: stringField(record, "recordedAt"),
      };
  }
}

function eventType(kind: ModelAssuranceRecordKind): string {
  if (kind === "human_review_record") return "model_assurance.human_review.recorded";
  if (kind === "model_assurance_assessment") return "model_assurance.assessment.recorded";
  if (
    kind === "blinded_evaluation_result" ||
    kind === "calibration_report" ||
    kind === "independent_critique" ||
    kind === "model_qualification_report"
  ) {
    return "model_assurance.result.recorded";
  }
  return "model_assurance.definition.published";
}

function outboxIntent(
  kind: ModelAssuranceRecordKind,
  recordId: string,
  record: ModelAssuranceRecord,
  recordedAt: string,
): ModelAssuranceOutboxIntent {
  return {
    aggregateId: recordId,
    aggregateType: `model_assurance_${kind}`,
    createdAt: recordedAt,
    eventType: eventType(kind),
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
  kind: ModelAssuranceRecordKind,
  recordId: string,
): never {
  if (
    error instanceof InvalidModelAssuranceRecordInputError ||
    error instanceof ModelAssuranceLineageError ||
    error instanceof ModelAssuranceRecordConflictError ||
    error instanceof ModelAssuranceRepositoryContractError
  ) {
    throw error;
  }
  const code = postgresCode(error);
  if (code === "23503" || (code === "23514" && /lineage/i.test(postgresMessage(error)))) {
    throw new ModelAssuranceLineageError(kind, recordId, kind, recordId);
  }
  if (code === "23505") throw new ModelAssuranceRecordConflictError(kind, recordId);
  if (code === "23514" || code === "22007" || code === "22P02") {
    throw new ModelAssuranceRepositoryContractError(
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
  kind: ModelAssuranceRecordKind,
  tenantId: string,
  recordId: string,
  exactScope?: EvidenceScope,
): Promise<StoredRecordRow | null> {
  const result = await client.query<StoredRecordRow>(
    `SELECT tenant_id, project_id, environment_id, record_kind, record_id,
       schema_version, definition_sha256, recorded_at_lexical, actor_principal_id,
       lifecycle_state, lineage_count, record,
       recorded_at = recorded_at_lexical::timestamptz AS recorded_at_matches
     FROM public.proofstack_model_assurance_records
     WHERE tenant_id = $1 AND record_kind = $2 AND record_id = $3
       ${exactScope ? "AND project_id = $4 AND environment_id = $5" : ""}`,
    exactScope
      ? [tenantId, kind, recordId, exactScope.projectId, exactScope.environmentId]
      : [tenantId, kind, recordId],
  );
  return result.rows[0] ?? null;
}

async function inspectScopedPresence(
  client: Pick<PoolClient, "query">,
  scope: EvidenceScope,
  kind: ModelAssuranceRecordKind,
  recordId: string,
): Promise<boolean> {
  // One statement observes an absence cut before any subsequent READ COMMITTED read.
  // Child-owned normalized coordinates establish scope; parent-only edges and
  // outbox aggregate IDs cannot establish ownership of an absent child body.
  const result = await client.query<{
    retained_model_assurance_body: boolean;
    retained_model_assurance_storage: boolean;
  }>(
    `SELECT EXISTS (
       SELECT 1 FROM public.proofstack_model_assurance_records
       WHERE tenant_id = $1 AND record_kind = $2 AND record_id = $3
         AND project_id = $4 AND environment_id = $5
     ) AS retained_model_assurance_body,
     (EXISTS (
       SELECT 1 FROM public.proofstack_evaluation_record_registry
       WHERE tenant_id = $1 AND record_kind = $2 AND record_id = $3
         AND project_id = $4 AND environment_id = $5
     ) OR EXISTS (
       SELECT 1 FROM public.proofstack_evaluation_lineage
       WHERE tenant_id = $1 AND child_record_kind = $2 AND child_record_id = $3
         AND project_id = $4 AND environment_id = $5
     )) AS retained_model_assurance_storage`,
    [scope.tenantId, kind, recordId, scope.projectId, scope.environmentId],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row ||
    typeof row.retained_model_assurance_body !== "boolean" ||
    typeof row.retained_model_assurance_storage !== "boolean" ||
    row.retained_model_assurance_body !== row.retained_model_assurance_storage
  ) {
    throw new ModelAssuranceRepositoryContractError(
      "Stored model-assurance body and exact-scope ownership disagree",
    );
  }
  return row.retained_model_assurance_body;
}

function parseStored(kind: ModelAssuranceRecordKind, row: StoredRecordRow): ModelAssuranceRecord {
  try {
    const record = validateModelAssuranceRecord(kind, row.record);
    const projected = projection(kind, record);
    if (
      record.scope.tenantId !== row.tenant_id ||
      record.scope.projectId !== row.project_id ||
      record.scope.environmentId !== row.environment_id ||
      record.definitionSha256 !== row.definition_sha256 ||
      kind !== row.record_kind ||
      modelAssuranceRecordId(kind, record) !== row.record_id ||
      record.schemaVersion !== row.schema_version ||
      projected.recordedAt !== row.recorded_at_lexical ||
      row.recorded_at_matches !== true ||
      projected.actorPrincipalId !== row.actor_principal_id ||
      projected.lifecycleState !== row.lifecycle_state
    ) {
      throw new Error("normalized columns differ from the canonical record");
    }
    return record;
  } catch (error) {
    throw new ModelAssuranceRepositoryContractError(
      `Stored ${kind} record violates the canonical model-assurance contract`,
      { cause: error },
    );
  }
}

async function requireCanonicalOutbox(
  client: Pick<PoolClient, "query">,
  intent: ModelAssuranceOutboxIntent,
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
    throw new ModelAssuranceRepositoryContractError(
      `Stored model-assurance record ${intent.aggregateId} is missing its canonical outbox intent`,
    );
  }
}

async function requirePhysicalIntegrity(
  client: Pick<PoolClient, "query">,
  kind: ModelAssuranceRecordKind,
  record: ModelAssuranceRecord,
  row: StoredRecordRow,
): Promise<void> {
  const id = modelAssuranceRecordId(kind, record);
  const scope = record.scope;
  const references = modelAssuranceStorageReferences(kind, id, record);
  if (row.lineage_count !== references.length) {
    throw new ModelAssuranceRepositoryContractError(
      "Stored model-assurance lineage count differs from its canonical body",
    );
  }
  const registry = await client.query<RegistryRow>(
    `SELECT project_id, environment_id, schema_version, definition_sha256
     FROM public.proofstack_evaluation_record_registry
     WHERE tenant_id = $1 AND record_kind = $2 AND record_id = $3 LIMIT 2`,
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
  ) {
    throw new ModelAssuranceRepositoryContractError(
      "Stored model-assurance registry differs from its canonical body",
    );
  }
  // Native ordering preserves the deployed publication function's collation. The
  // independently derived count bounds returned rows, including a zero-ref sentinel.
  const lineage = await client.query<LineageRow>(
    `SELECT inspected.*, inspected.edge_position = inspected.expected_position AS position_matches
     FROM (
       SELECT edge.edge_position, edge.parent_record_kind, edge.parent_record_id,
         edge.parent_definition_sha256,
         (edge.project_id = $4 AND edge.environment_id = $5
          AND edge.child_definition_sha256 = $6) AS child_matches,
         (parent.record_id IS NOT NULL AND parent.schema_version = $7) AS parent_matches,
         row_number() OVER (ORDER BY edge.parent_record_kind, edge.parent_record_id,
           edge.parent_definition_sha256) - 1 AS expected_position
       FROM public.proofstack_evaluation_lineage AS edge
       LEFT JOIN public.proofstack_evaluation_record_registry AS parent
         ON parent.tenant_id = edge.tenant_id AND parent.project_id = edge.project_id
         AND parent.environment_id = edge.environment_id
         AND parent.record_kind = edge.parent_record_kind AND parent.record_id = edge.parent_record_id
         AND parent.definition_sha256 = edge.parent_definition_sha256
       WHERE edge.tenant_id = $1 AND edge.child_record_kind = $2 AND edge.child_record_id = $3
     ) AS inspected
     ORDER BY inspected.edge_position LIMIT $8`,
    [
      scope.tenantId,
      kind,
      id,
      scope.projectId,
      scope.environmentId,
      record.definitionSha256,
      record.schemaVersion,
      references.length + 1,
    ],
  );
  const expected = new Set(
    references.map(({ recordKind, recordId, definitionSha256 }) =>
      JSON.stringify([recordKind, recordId, definitionSha256]),
    ),
  );
  if (lineage.rows.length !== references.length) {
    throw new ModelAssuranceRepositoryContractError(
      "Stored model-assurance physical lineage is incomplete or excessive",
    );
  }
  for (const [index, edge] of lineage.rows.entries()) {
    if (
      edge.edge_position !== index ||
      edge.position_matches !== true ||
      edge.child_matches !== true ||
      edge.parent_matches !== true ||
      !expected.delete(
        JSON.stringify([
          edge.parent_record_kind,
          edge.parent_record_id,
          edge.parent_definition_sha256,
        ]),
      )
    ) {
      throw new ModelAssuranceRepositoryContractError(
        "Stored model-assurance physical lineage differs from its canonical body",
      );
    }
  }
  await requireCanonicalOutbox(
    client,
    outboxIntent(kind, id, record, projection(kind, record).recordedAt),
  );
}

function publicationFunction(kind: ModelAssuranceRecordKind): string {
  if (kind === "human_review_record") {
    return "public.proofstack_publish_model_assurance_human_review_record";
  }
  if (
    kind === "blinded_evaluation_result" ||
    kind === "independent_critique" ||
    kind === "model_qualification_report"
  ) {
    return "public.proofstack_publish_model_assurance_execution_record";
  }
  return "public.proofstack_publish_model_assurance_control_record";
}

/** Uses only the supplied client; exact scope is filtered before canonical scalar validation. */
export async function readPostgresModelAssuranceRecordOnClient<K extends ModelAssuranceRecordKind>(
  client: Pick<PoolClient, "query">,
  scopeInput: EvidenceScope,
  kind: K,
  recordId: string,
): Promise<ModelAssuranceRecordByKind[K] | null> {
  const scope = { ...scopeInput };
  if (!(await inspectScopedPresence(client, scope, kind, recordId))) return null;
  const row = await loadStored(client, kind, scope.tenantId, recordId, scope);
  if (!row) {
    throw new ModelAssuranceRepositoryContractError(
      "Stored model-assurance body disappeared after its presence observation",
    );
  }
  const record = parseStored(kind, row);
  if (!scopesEqual(record.scope, scope)) {
    throw new ModelAssuranceRepositoryContractError(
      "Stored model-assurance body changed scope after its presence observation",
    );
  }
  await requirePhysicalIntegrity(client, kind, record, row);
  return clone(record) as ModelAssuranceRecordByKind[K];
}

export class PostgresModelAssuranceRepository implements ModelAssuranceRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async find<K extends ModelAssuranceRecordKind>(
    scopeInput: EvidenceScope,
    kind: K,
    recordId: string,
  ): Promise<ModelAssuranceRecordByKind[K] | null> {
    const scope = { ...scopeInput };
    return withTenantTransaction(this.pool, scope.tenantId, (client) =>
      readPostgresModelAssuranceRecordOnClient(client, scope, kind, recordId),
    );
  }

  async publish<K extends ModelAssuranceRecordKind>(
    kind: K,
    candidate: ModelAssuranceRecordByKind[K],
  ): Promise<PublishModelAssuranceRecordResult<ModelAssuranceRecordByKind[K]>> {
    const record = validateModelAssuranceRecord(kind, candidate) as ModelAssuranceRecordByKind[K];
    const recordId = modelAssuranceRecordId(kind, record);
    const references = modelAssuranceRecordReferences(kind, record);
    const projected = projection(kind, record);
    const lockPrefix = `proofstack:model-assurance:${record.scope.tenantId}`;
    const lockKeys = [
      `${lockPrefix}:record:${kind}:${recordId}`,
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
            throw new ModelAssuranceRecordConflictError(kind, recordId);
          }
          await requirePhysicalIntegrity(client, kind, existing, existingRow);
          return {
            created: false,
            record: clone(existing) as ModelAssuranceRecordByKind[K],
          };
        }

        const command = {
          actorPrincipalId: projected.actorPrincipalId,
          definitionSha256: record.definitionSha256,
          environmentId: record.scope.environmentId,
          lifecycleState: projected.lifecycleState,
          projectId: record.scope.projectId,
          record,
          recordedAt: projected.recordedAt,
          recordId,
          recordKind: kind,
          schemaVersion: record.schemaVersion,
          tenantId: record.scope.tenantId,
        };
        await client.query(`SELECT ${publicationFunction(kind)}($1::jsonb)`, [
          JSON.stringify(command),
        ]);
        return { created: true, record: clone(record) };
      });
    } catch (error) {
      mapPersistenceError(error, kind, recordId);
    }
  }
}
