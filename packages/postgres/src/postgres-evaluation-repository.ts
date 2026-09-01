import { Buffer } from "node:buffer";
import type {
  Assessment,
  CriterionSet,
  CriterionSetStatusRecord,
  DiscoveryRecord,
  EvaluationAggregate,
  EvaluationAggregationPolicy,
  EvaluationRun,
  EvaluationRunRejection,
  EvaluationRunResult,
  EvaluatorSpec,
  EvidenceScope,
  OracleSpec,
  QualificationFixtureSet,
  QualificationReport,
  RawObservation,
  SourceReviewRecord,
  SourceSnapshot,
} from "@proofstack/contracts";
import {
  EvaluationLineageError,
  EvaluationRecordConflictError,
  type EvaluationRecordKind,
  type EvaluationRepository,
  EvaluationRepositoryContractError,
  EvaluationResourceConflictError,
  type EvaluationStoredRecord,
  evaluationRecordId,
  evaluationRecordReferences,
  evaluationRecordUniqueBinding,
  evaluationResource,
  type PublishEvaluationRecordResult,
  validateEvaluationRecord,
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

interface ResourceBindingRow extends QueryResultRow {
  readonly environment_id: string;
  readonly project_id: string;
}

interface OutboxIntentRow extends QueryResultRow {
  readonly status: string;
}

interface EvaluationProjection {
  readonly actorPrincipalId: string;
  readonly attemptId: string | null;
  readonly attemptSequence: number | null;
  readonly lifecycleState: string | null;
  readonly recordedAt: string;
  readonly runId: string | null;
  readonly verdict: string | null;
}

interface EvaluationOutboxIntent {
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly createdAt: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly schemaVersion: string;
  readonly tenantId: string;
}

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function value(record: EvaluationStoredRecord, field: string): unknown {
  return (record as unknown as Readonly<Record<string, unknown>>)[field];
}

function stringValue(record: EvaluationStoredRecord, field: string): string {
  const result = value(record, field);
  if (typeof result !== "string") {
    throw new EvaluationRepositoryContractError(`Validated evaluation record omitted ${field}`);
  }
  return result;
}

function nestedString(record: EvaluationStoredRecord, parent: string, field: string): string {
  const container = value(record, parent);
  if (typeof container !== "object" || container === null || Array.isArray(container)) {
    throw new EvaluationRepositoryContractError(`Validated evaluation record omitted ${parent}`);
  }
  const result = (container as Readonly<Record<string, unknown>>)[field];
  if (typeof result !== "string") {
    throw new EvaluationRepositoryContractError(
      `Validated evaluation record omitted ${parent}.${field}`,
    );
  }
  return result;
}

function numberValue(record: EvaluationStoredRecord, field: string): number {
  const result = value(record, field);
  if (typeof result !== "number" || !Number.isInteger(result)) {
    throw new EvaluationRepositoryContractError(`Validated evaluation record omitted ${field}`);
  }
  return result;
}

function projection(
  kind: EvaluationRecordKind,
  record: EvaluationStoredRecord,
): EvaluationProjection {
  switch (kind) {
    case "aggregation_policy":
    case "criterion_set":
    case "evaluator_spec":
    case "oracle_spec":
    case "qualification_fixture_set":
      return {
        actorPrincipalId: stringValue(record, "publishedByPrincipalId"),
        attemptId: null,
        attemptSequence: null,
        lifecycleState: null,
        recordedAt: stringValue(record, "publishedAt"),
        runId: null,
        verdict: null,
      };
    case "assessment":
      return {
        actorPrincipalId: stringValue(record, "createdByPrincipalId"),
        attemptId: null,
        attemptSequence: null,
        lifecycleState: nestedString(record, "eligibility", "status"),
        recordedAt: stringValue(record, "createdAt"),
        runId: null,
        verdict: stringValue(record, "supportStatus"),
      };
    case "criterion_set_status":
      return {
        actorPrincipalId: stringValue(record, "recordedByPrincipalId"),
        attemptId: null,
        attemptSequence: null,
        lifecycleState: stringValue(record, "status"),
        recordedAt: stringValue(record, "recordedAt"),
        runId: null,
        verdict: null,
      };
    case "discovery_record":
      return {
        actorPrincipalId: stringValue(record, "recordedByPrincipalId"),
        attemptId: null,
        attemptSequence: null,
        lifecycleState: null,
        recordedAt: stringValue(record, "recordedAt"),
        runId: null,
        verdict: null,
      };
    case "evaluation_aggregate":
      return {
        actorPrincipalId: stringValue(record, "createdByPrincipalId"),
        attemptId: null,
        attemptSequence: null,
        lifecycleState: null,
        recordedAt: stringValue(record, "createdAt"),
        runId: null,
        verdict: null,
      };
    case "evaluation_run":
      return {
        actorPrincipalId: stringValue(record, "createdByPrincipalId"),
        attemptId: null,
        attemptSequence: null,
        lifecycleState: nestedString(record, "applicability", "result"),
        recordedAt: stringValue(record, "createdAt"),
        runId: stringValue(record, "evaluationRunId"),
        verdict: null,
      };
    case "evaluation_run_rejection":
      return {
        actorPrincipalId: stringValue(record, "requestedByPrincipalId"),
        attemptId: null,
        attemptSequence: null,
        lifecycleState: stringValue(record, "resolution"),
        recordedAt: stringValue(record, "recordedAt"),
        runId: null,
        verdict: null,
      };
    case "evaluation_run_result":
      return {
        actorPrincipalId: stringValue(record, "recordedByPrincipalId"),
        attemptId: null,
        attemptSequence: null,
        lifecycleState: stringValue(record, "terminalReason"),
        recordedAt: stringValue(record, "recordedAt"),
        runId: stringValue(record, "evaluationRunId"),
        verdict: stringValue(record, "verdict"),
      };
    case "qualification_report":
      return {
        actorPrincipalId: stringValue(record, "executedByPrincipalId"),
        attemptId: null,
        attemptSequence: null,
        lifecycleState: stringValue(record, "status"),
        recordedAt: stringValue(record, "recordedAt"),
        runId: null,
        verdict: null,
      };
    case "raw_observation":
      return {
        actorPrincipalId: stringValue(record, "executedByPrincipalId"),
        attemptId: stringValue(record, "attemptId"),
        attemptSequence: numberValue(record, "attemptSequence"),
        lifecycleState: null,
        recordedAt: stringValue(record, "recordedAt"),
        runId: nestedString(record, "run", "evaluationRunId"),
        verdict: stringValue(record, "verdict"),
      };
    case "source_review":
      return {
        actorPrincipalId: stringValue(record, "reviewedByPrincipalId"),
        attemptId: null,
        attemptSequence: null,
        lifecycleState: stringValue(record, "outcome"),
        recordedAt: stringValue(record, "reviewedAt"),
        runId: null,
        verdict: null,
      };
    case "source_snapshot":
      return {
        actorPrincipalId: stringValue(record, "publishedByPrincipalId"),
        attemptId: null,
        attemptSequence: null,
        lifecycleState: null,
        recordedAt: stringValue(record, "recordedAt"),
        runId: null,
        verdict: null,
      };
  }
}

const definitionKinds = new Set<EvaluationRecordKind>([
  "aggregation_policy",
  "criterion_set",
  "evaluator_spec",
  "oracle_spec",
  "qualification_fixture_set",
]);
const sourceKinds = new Set<EvaluationRecordKind>([
  "discovery_record",
  "source_review",
  "source_snapshot",
]);
const runKinds = new Set<EvaluationRecordKind>(["evaluation_run", "evaluation_run_rejection"]);
const resultKinds = new Set<EvaluationRecordKind>([
  "qualification_report",
  "raw_observation",
  "evaluation_run_result",
]);
const executionKinds = new Set<EvaluationRecordKind>(["evaluation_aggregate", ...resultKinds]);

function outboxEventType(kind: EvaluationRecordKind): string {
  if (definitionKinds.has(kind)) return "evaluation.definition.published";
  if (sourceKinds.has(kind)) return "evaluation.source.recorded";
  if (kind === "criterion_set_status") return "evaluation.criterion.status_recorded";
  if (runKinds.has(kind)) return "evaluation.run.recorded";
  if (resultKinds.has(kind)) return "evaluation.result.recorded";
  return "evaluation.assessment.recorded";
}

function outboxIntent(
  kind: EvaluationRecordKind,
  recordId: string,
  record: EvaluationStoredRecord,
  recordedAt: string,
): EvaluationOutboxIntent {
  return {
    aggregateId: recordId,
    aggregateType: `evaluation_${kind}`,
    createdAt: recordedAt,
    eventType: outboxEventType(kind),
    payload: { record: clone(record), recordKind: kind },
    schemaVersion: record.schemaVersion,
    tenantId: record.scope.tenantId,
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

function mapPersistenceError(error: unknown, kind: EvaluationRecordKind, recordId: string): never {
  if (
    error instanceof EvaluationLineageError ||
    error instanceof EvaluationRecordConflictError ||
    error instanceof EvaluationRepositoryContractError ||
    error instanceof EvaluationResourceConflictError
  ) {
    throw error;
  }
  const code = postgresCode(error);
  if (code === "23503" || (code === "23514" && /lineage/i.test(postgresMessage(error)))) {
    throw new EvaluationLineageError(kind, recordId, kind, recordId);
  }
  if (code === "23505") throw new EvaluationRecordConflictError(kind, recordId);
  if (code === "23514" || code === "22007" || code === "22P02") {
    throw new EvaluationRepositoryContractError(
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
  kind: EvaluationRecordKind,
  tenantId: string,
  recordId: string,
): Promise<StoredRecordRow | null> {
  const result = await client.query<StoredRecordRow>(
    `SELECT tenant_id, project_id, environment_id, definition_sha256, record
     FROM public.proofstack_evaluation_records
     WHERE tenant_id = $1 AND record_kind = $2 AND record_id = $3`,
    [tenantId, kind, recordId],
  );
  return result.rows[0] ?? null;
}

function parseStored(kind: EvaluationRecordKind, row: StoredRecordRow): EvaluationStoredRecord {
  try {
    const record = validateEvaluationRecord(kind, row.record);
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
    throw new EvaluationRepositoryContractError(
      `Stored ${kind} record violates the canonical evaluation contract`,
      { cause: error },
    );
  }
}

async function requireCanonicalOutbox(
  client: PoolClient,
  intent: EvaluationOutboxIntent,
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
  const row = result.rows[0];
  if (row?.status !== "canonical") {
    throw new EvaluationRepositoryContractError(
      `Stored evaluation record ${intent.aggregateId} is missing its canonical outbox intent`,
    );
  }
}

export class PostgresEvaluationRepository implements EvaluationRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  private async find<RecordType>(
    kind: EvaluationRecordKind,
    scope: EvidenceScope,
    recordId: string,
  ): Promise<RecordType | null> {
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const row = await loadStored(client, kind, scope.tenantId, recordId);
      if (!row) return null;
      const record = parseStored(kind, row);
      return scopesEqual(record.scope, scope) ? (clone(record) as RecordType) : null;
    });
  }

  private async publish<RecordType extends EvaluationStoredRecord>(
    kind: EvaluationRecordKind,
    candidate: RecordType,
  ): Promise<PublishEvaluationRecordResult<RecordType>> {
    const record = validateEvaluationRecord(kind, candidate) as RecordType;
    const recordId = evaluationRecordId(kind, record);
    const resource = evaluationResource(kind, record);
    const references = evaluationRecordReferences(kind, record);
    const uniqueBinding = evaluationRecordUniqueBinding(kind, record);
    const projected = projection(kind, record);
    const intent = outboxIntent(kind, recordId, record, projected.recordedAt);
    const lockPrefix = `proofstack:evaluation:${record.scope.tenantId}`;
    const lockKeys = [
      `${lockPrefix}:record:${kind}:${recordId}`,
      ...(resource ? [`${lockPrefix}:resource:${resource.kind}:${resource.resourceId}`] : []),
      ...references.map(
        (reference) => `${lockPrefix}:record:${reference.recordKind}:${reference.recordId}`,
      ),
      ...(uniqueBinding ? [`${lockPrefix}:unique:${uniqueBinding.key}`] : []),
    ];

    try {
      return await withTenantTransaction(this.pool, record.scope.tenantId, async (client) => {
        await acquireLocks(client, lockKeys);
        const existingRow = await loadStored(client, kind, record.scope.tenantId, recordId);
        if (existingRow) {
          const existing = parseStored(kind, existingRow);
          if (existing.definitionSha256 !== record.definitionSha256) {
            throw new EvaluationRecordConflictError(kind, recordId);
          }
          await requireCanonicalOutbox(client, intent);
          return { created: false, record: clone(existing) as RecordType };
        }

        if (resource) {
          const binding = await client.query<ResourceBindingRow>(
            `SELECT project_id, environment_id
             FROM public.proofstack_evaluation_resource_bindings
             WHERE tenant_id = $1 AND resource_kind = $2 AND resource_id = $3`,
            [record.scope.tenantId, resource.kind, resource.resourceId],
          );
          const bound = binding.rows[0];
          if (
            bound &&
            (bound.project_id !== record.scope.projectId ||
              bound.environment_id !== record.scope.environmentId)
          ) {
            throw new EvaluationResourceConflictError(resource.kind, resource.resourceId);
          }
        }

        const resolvedReferences: Array<{
          readonly definitionSha256: string;
          readonly recordId: string;
          readonly recordKind: EvaluationRecordKind;
        }> = [];
        for (const reference of references) {
          const row = await loadStored(
            client,
            reference.recordKind,
            record.scope.tenantId,
            reference.recordId,
          );
          if (!row) {
            throw new EvaluationLineageError(
              kind,
              recordId,
              reference.recordKind,
              reference.recordId,
            );
          }
          const parent = parseStored(reference.recordKind, row);
          if (
            !scopesEqual(parent.scope, record.scope) ||
            (reference.definitionSha256 !== undefined &&
              reference.definitionSha256 !== parent.definitionSha256)
          ) {
            throw new EvaluationLineageError(
              kind,
              recordId,
              reference.recordKind,
              reference.recordId,
            );
          }
          resolvedReferences.push({
            definitionSha256: parent.definitionSha256,
            recordId: reference.recordId,
            recordKind: reference.recordKind,
          });
        }

        const persistenceCommand = {
          actorPrincipalId: projected.actorPrincipalId,
          attemptId: projected.attemptId,
          attemptSequence: projected.attemptSequence,
          definitionSha256: record.definitionSha256,
          environmentId: record.scope.environmentId,
          lifecycleState: projected.lifecycleState,
          projectId: record.scope.projectId,
          record,
          recordedAt: projected.recordedAt,
          recordId,
          recordKind: kind,
          runId: projected.runId,
          schemaVersion: record.schemaVersion,
          tenantId: record.scope.tenantId,
          verdict: projected.verdict,
        };
        const commandJson = JSON.stringify(persistenceCommand);
        if (executionKinds.has(kind)) {
          await client.query(
            "SELECT public.proofstack_publish_evaluation_execution_record($1::jsonb)",
            [commandJson],
          );
        } else {
          await client.query(
            "SELECT public.proofstack_publish_evaluation_control_record($1::jsonb)",
            [commandJson],
          );
        }
        return { created: true, record: clone(record) };
      });
    } catch (error) {
      mapPersistenceError(error, kind, recordId);
    }
  }

  async findAggregationPolicy(scope: EvidenceScope, id: string) {
    return this.find<EvaluationAggregationPolicy>("aggregation_policy", scope, id);
  }
  async findAssessment(scope: EvidenceScope, id: string) {
    return this.find<Assessment>("assessment", scope, id);
  }
  async findCriterionSet(scope: EvidenceScope, id: string) {
    return this.find<CriterionSet>("criterion_set", scope, id);
  }
  async findCriterionSetStatus(scope: EvidenceScope, id: string) {
    return this.find<CriterionSetStatusRecord>("criterion_set_status", scope, id);
  }
  async findDiscoveryRecord(scope: EvidenceScope, id: string) {
    return this.find<DiscoveryRecord>("discovery_record", scope, id);
  }
  async findEvaluationAggregate(scope: EvidenceScope, id: string) {
    return this.find<EvaluationAggregate>("evaluation_aggregate", scope, id);
  }
  async findEvaluationRun(scope: EvidenceScope, id: string) {
    return this.find<EvaluationRun>("evaluation_run", scope, id);
  }
  async findEvaluationRunRejection(scope: EvidenceScope, id: string) {
    return this.find<EvaluationRunRejection>("evaluation_run_rejection", scope, id);
  }
  async findEvaluationRunResult(scope: EvidenceScope, id: string) {
    return this.find<EvaluationRunResult>("evaluation_run_result", scope, id);
  }
  async findEvaluatorSpec(scope: EvidenceScope, id: string) {
    return this.find<EvaluatorSpec>("evaluator_spec", scope, id);
  }
  async findOracleSpec(scope: EvidenceScope, id: string) {
    return this.find<OracleSpec>("oracle_spec", scope, id);
  }
  async findQualificationFixtureSet(scope: EvidenceScope, id: string) {
    return this.find<QualificationFixtureSet>("qualification_fixture_set", scope, id);
  }
  async findQualificationReport(scope: EvidenceScope, id: string) {
    return this.find<QualificationReport>("qualification_report", scope, id);
  }
  async findRawObservation(scope: EvidenceScope, id: string) {
    return this.find<RawObservation>("raw_observation", scope, id);
  }
  async findSourceReview(scope: EvidenceScope, id: string) {
    return this.find<SourceReviewRecord>("source_review", scope, id);
  }
  async findSourceSnapshot(scope: EvidenceScope, id: string) {
    return this.find<SourceSnapshot>("source_snapshot", scope, id);
  }

  async publishAggregationPolicy(candidate: EvaluationAggregationPolicy) {
    return this.publish("aggregation_policy", candidate);
  }
  async publishAssessment(candidate: Assessment) {
    return this.publish("assessment", candidate);
  }
  async publishCriterionSet(candidate: CriterionSet) {
    return this.publish("criterion_set", candidate);
  }
  async publishCriterionSetStatus(candidate: CriterionSetStatusRecord) {
    return this.publish("criterion_set_status", candidate);
  }
  async publishDiscoveryRecord(candidate: DiscoveryRecord) {
    return this.publish("discovery_record", candidate);
  }
  async publishEvaluationAggregate(candidate: EvaluationAggregate) {
    return this.publish("evaluation_aggregate", candidate);
  }
  async publishEvaluationRun(candidate: EvaluationRun) {
    return this.publish("evaluation_run", candidate);
  }
  async publishEvaluationRunRejection(candidate: EvaluationRunRejection) {
    return this.publish("evaluation_run_rejection", candidate);
  }
  async publishEvaluationRunResult(candidate: EvaluationRunResult) {
    return this.publish("evaluation_run_result", candidate);
  }
  async publishEvaluatorSpec(candidate: EvaluatorSpec) {
    return this.publish("evaluator_spec", candidate);
  }
  async publishOracleSpec(candidate: OracleSpec) {
    return this.publish("oracle_spec", candidate);
  }
  async publishQualificationFixtureSet(candidate: QualificationFixtureSet) {
    return this.publish("qualification_fixture_set", candidate);
  }
  async publishQualificationReport(candidate: QualificationReport) {
    return this.publish("qualification_report", candidate);
  }
  async publishRawObservation(candidate: RawObservation) {
    return this.publish("raw_observation", candidate);
  }
  async publishSourceReview(candidate: SourceReviewRecord) {
    return this.publish("source_review", candidate);
  }
  async publishSourceSnapshot(candidate: SourceSnapshot) {
    return this.publish("source_snapshot", candidate);
  }
}
