import { Buffer } from "node:buffer";
import type { EvidenceScope } from "@proofstack/contracts";
import {
  InvalidModelAssuranceRecordInputError,
  ModelAssuranceLineageError,
  type ModelAssuranceRecord,
  type ModelAssuranceRecordByKind,
  ModelAssuranceRecordConflictError,
  type ModelAssuranceRecordKind,
  modelAssuranceRecordId,
  modelAssuranceRecordReferences,
  type ModelAssuranceRepository,
  ModelAssuranceRepositoryContractError,
  type PublishModelAssuranceRecordResult,
  validateModelAssuranceRecord,
} from "@proofstack/core";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { withTenantTransaction } from "./tenant-transaction.js";

interface StoredRecordRow extends QueryResultRow {
  readonly definition_sha256: string;
  readonly environment_id: string;
  readonly project_id: string;
  readonly record: unknown;
  readonly tenant_id: string;
}

interface OutboxIntentRow extends QueryResultRow {
  readonly status: string;
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
  client: PoolClient,
  kind: ModelAssuranceRecordKind,
  tenantId: string,
  recordId: string,
): Promise<StoredRecordRow | null> {
  const result = await client.query<StoredRecordRow>(
    `SELECT tenant_id, project_id, environment_id, definition_sha256, record
     FROM public.proofstack_model_assurance_records
     WHERE tenant_id = $1 AND record_kind = $2 AND record_id = $3`,
    [tenantId, kind, recordId],
  );
  return result.rows[0] ?? null;
}

function parseStored(kind: ModelAssuranceRecordKind, row: StoredRecordRow): ModelAssuranceRecord {
  try {
    const record = validateModelAssuranceRecord(kind, row.record);
    if (
      record.scope.tenantId !== row.tenant_id ||
      record.scope.projectId !== row.project_id ||
      record.scope.environmentId !== row.environment_id ||
      record.definitionSha256 !== row.definition_sha256
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
  client: PoolClient,
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

export class PostgresModelAssuranceRepository implements ModelAssuranceRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async find<K extends ModelAssuranceRecordKind>(
    scope: EvidenceScope,
    kind: K,
    recordId: string,
  ): Promise<ModelAssuranceRecordByKind[K] | null> {
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const row = await loadStored(client, kind, scope.tenantId, recordId);
      if (!row) return null;
      const record = parseStored(kind, row);
      return scopesEqual(record.scope, scope)
        ? (clone(record) as ModelAssuranceRecordByKind[K])
        : null;
    });
  }

  async publish<K extends ModelAssuranceRecordKind>(
    kind: K,
    candidate: ModelAssuranceRecordByKind[K],
  ): Promise<PublishModelAssuranceRecordResult<ModelAssuranceRecordByKind[K]>> {
    const record = validateModelAssuranceRecord(kind, candidate) as ModelAssuranceRecordByKind[K];
    const recordId = modelAssuranceRecordId(kind, record);
    const references = modelAssuranceRecordReferences(kind, record);
    const projected = projection(kind, record);
    const intent = outboxIntent(kind, recordId, record, projected.recordedAt);
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
          await requireCanonicalOutbox(client, intent);
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
