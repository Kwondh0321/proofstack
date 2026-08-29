import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import {
  EvidenceScopeSchema,
  type EvidenceScope,
  OpaqueIdSchema,
  type ReplayBoundaryDeclaration,
  type ReplayPlan,
  type TargetRelease,
  type TargetReleaseReference,
} from "@proofstack/contracts";
import {
  areReplayPlanDefinitionsEqual,
  areTargetReleaseDefinitionsEqual,
  buildReplayPlanPublishedOutboxIntent,
  buildTargetReleasePublishedOutboxIntent,
  type PublishedReplayDefinitionOutboxIntent,
  type PublishReplayDefinitionResult,
  ReplayDefinitionConflictError,
  ReplayDefinitionLineageError,
  type ReplayDefinitionRepository,
  ReplayRepositoryContractError,
  validateAndProjectReplayPlan,
  validateAndProjectTargetRelease,
} from "@proofstack/replay";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { withTenantTransaction } from "./tenant-transaction.js";

interface ResourceRow extends QueryResultRow {
  readonly environment_id: string;
  readonly project_id: string;
  readonly tenant_id: string;
}

interface TargetReleaseRow extends QueryResultRow {
  readonly created_at_lexical: string;
  readonly created_at_matches: boolean;
  readonly created_by_principal_id: string;
  readonly definition_sha256: string;
  readonly emitted_artifact_bytes: string;
  readonly environment_id: string;
  readonly execution_artifact_id: string | null;
  readonly execution_kind: string;
  readonly project_id: string;
  readonly provenance_artifact_id: string;
  readonly release: unknown;
  readonly resource_matches: boolean;
  readonly schema_version: string;
  readonly stderr_bytes: string;
  readonly stdout_bytes: string;
  readonly target_adapter_name: string;
  readonly target_adapter_protocol_version: string;
  readonly target_adapter_version: string;
  readonly target_id: string;
  readonly target_release_id: string;
  readonly tenant_id: string;
  readonly worker_protocol_name: string;
  readonly worker_protocol_version: string;
}

interface ReplayPlanRow extends QueryResultRow {
  readonly boundary_count: number;
  readonly created_at_lexical: string;
  readonly created_at_matches: boolean;
  readonly created_by_principal_id: string;
  readonly dataset_definition_sha256: string;
  readonly dataset_id: string;
  readonly dataset_version_id: string;
  readonly definition_sha256: string;
  readonly environment_id: string;
  readonly isolation_profile_definition_sha256: string;
  readonly isolation_profile_id: string;
  readonly isolation_profile_version: string;
  readonly plan: unknown;
  readonly plan_id: string;
  readonly plan_version_id: string;
  readonly project_id: string;
  readonly resource_matches: boolean;
  readonly retry_automatic: boolean;
  readonly retry_max_attempts: number;
  readonly retry_per_attempt_timeout_milliseconds: string;
  readonly retry_total_deadline_milliseconds: string;
  readonly runtime_profile_definition_sha256: string;
  readonly runtime_profile_id: string;
  readonly runtime_profile_version: string;
  readonly schema_version: string;
  readonly target_adapter_name: string;
  readonly target_adapter_protocol_version: string;
  readonly target_adapter_version: string;
  readonly target_definition_sha256: string;
  readonly target_id: string;
  readonly target_release_id: string;
  readonly tenant_id: string;
  readonly worker_protocol_name: string;
  readonly worker_protocol_version: string;
}

interface BudgetRow extends QueryResultRow {
  readonly dimension: string;
  readonly limit_value: string;
  readonly measurement: string;
}

interface BoundaryRow extends QueryResultRow {
  readonly boundary_id: string;
  readonly boundary_kind: string;
  readonly boundary_mode: string;
  readonly boundary_position: number;
  readonly credential_id: string | null;
  readonly credential_version_id: string | null;
  readonly declaration: unknown;
  readonly destination_hostname: string | null;
  readonly destination_port: number | null;
  readonly destination_scheme: string | null;
  readonly endpoint_profile_definition_sha256: string | null;
  readonly endpoint_profile_id: string | null;
  readonly endpoint_profile_version: string | null;
  readonly operation: string | null;
  readonly qualification_artifact_id: string | null;
  readonly recorded_fixture_definition_sha256: string | null;
  readonly recorded_fixture_id: string | null;
  readonly recorded_fixture_version_id: string | null;
  readonly recorded_invocation_definition_sha256: string | null;
  readonly request_bytes: string | null;
  readonly response_bytes: string | null;
  readonly risk_acceptance_artifact_id: string | null;
  readonly side_effect_kind: string | null;
  readonly simulator_definition_sha256: string | null;
  readonly simulator_target_adapter_name: string | null;
  readonly simulator_target_adapter_protocol_version: string | null;
  readonly simulator_target_adapter_version: string | null;
  readonly simulator_target_id: string | null;
  readonly simulator_target_release_id: string | null;
  readonly simulator_worker_protocol_name: string | null;
  readonly simulator_worker_protocol_version: string | null;
}

interface PublicationIntentStatusRow extends QueryResultRow {
  readonly status: string;
}

type PublicationIntentStatus = "absent" | "canonical" | "conflict";
type BudgetDimension = keyof ReplayPlan["budget"];

const BUDGET_DIMENSIONS = [
  "concurrentInteractions",
  "elapsedMilliseconds",
  "emittedArtifactBytes",
  "inputTokens",
  "jobAttempts",
  "modelRequests",
  "outputTokens",
  "providerCostMicrounits",
  "retrievedBytes",
  "toolCalls",
] as const satisfies readonly BudgetDimension[];

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function scopesEqual(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function contractViolation(message: string, cause?: unknown): never {
  throw new ReplayRepositoryContractError(message, cause === undefined ? undefined : { cause });
}

function requireScope(input: EvidenceScope): EvidenceScope {
  return EvidenceScopeSchema.parse(input);
}

function requireOpaqueId(input: string): string {
  return OpaqueIdSchema.parse(input);
}

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function postgresMessage(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : undefined;
}

function mapPersistenceError(error: unknown): never {
  if (
    error instanceof ReplayDefinitionConflictError ||
    error instanceof ReplayDefinitionLineageError ||
    error instanceof ReplayRepositoryContractError
  ) {
    throw error;
  }
  const code = postgresCode(error);
  if (code === "23505") throw new ReplayDefinitionConflictError();
  if (code === "23503") throw new ReplayDefinitionLineageError();
  if (
    code === "23514" &&
    /exact retained artifact|Target release executable/.test(postgresMessage(error) ?? "")
  ) {
    throw new ReplayDefinitionLineageError();
  }
  if (code === "23514") {
    contractViolation("PostgreSQL rejected normalized replay definition persistence", error);
  }
  throw error;
}

function targetReference(release: TargetRelease): TargetReleaseReference {
  return {
    definitionSha256: release.definitionSha256,
    targetAdapter: release.targetAdapter,
    targetId: release.targetId,
    targetReleaseId: release.targetReleaseId,
    workerProtocol: release.workerProtocol,
  };
}

function targetReferencesEqual(
  left: TargetReleaseReference,
  right: TargetReleaseReference,
): boolean {
  return (
    left.targetId === right.targetId &&
    left.targetReleaseId === right.targetReleaseId &&
    left.definitionSha256 === right.definitionSha256 &&
    left.targetAdapter.name === right.targetAdapter.name &&
    left.targetAdapter.version === right.targetAdapter.version &&
    left.targetAdapter.protocolVersion === right.targetAdapter.protocolVersion &&
    left.workerProtocol.name === right.workerProtocol.name &&
    left.workerProtocol.version === right.workerProtocol.version
  );
}

function publicationIntentValues(intent: PublishedReplayDefinitionOutboxIntent): unknown[] {
  return [
    intent.tenantId,
    intent.eventType,
    intent.aggregateType,
    intent.aggregateId,
    intent.schemaVersion,
    JSON.stringify(intent.payload),
    intent.createdAt,
  ];
}

async function publicationIntentStatus(
  client: PoolClient,
  intent: PublishedReplayDefinitionOutboxIntent,
): Promise<PublicationIntentStatus> {
  const result = await client.query<PublicationIntentStatusRow>(
    `SELECT public.proofstack_replay_publication_intent_status(
      $1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz
    ) AS status`,
    publicationIntentValues(intent),
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row ||
    (row.status !== "absent" && row.status !== "canonical" && row.status !== "conflict")
  ) {
    contractViolation("PostgreSQL returned an invalid replay publication intent status");
  }
  return row.status;
}

async function requireCanonicalPublicationIntent(
  client: PoolClient,
  intent: PublishedReplayDefinitionOutboxIntent,
): Promise<void> {
  if ((await publicationIntentStatus(client, intent)) !== "canonical") {
    contractViolation("Stored replay definition is missing its canonical publication intent");
  }
}

async function requirePublicationIntentAbsent(
  client: PoolClient,
  intent: PublishedReplayDefinitionOutboxIntent,
): Promise<void> {
  if ((await publicationIntentStatus(client, intent)) !== "absent") {
    contractViolation("A replay publication intent exists without its immutable definition");
  }
}

async function insertPublicationIntent(
  client: PoolClient,
  intent: PublishedReplayDefinitionOutboxIntent,
): Promise<void> {
  await client.query(
    `INSERT INTO public.proofstack_outbox (
      tenant_id, event_type, aggregate_type, aggregate_id, schema_version, payload, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)`,
    publicationIntentValues(intent),
  );
}

async function acquirePublicationLocks(client: PoolClient, keys: readonly string[]): Promise<void> {
  const ordered = [...new Set(keys)].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  for (const key of ordered) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
  }
}

function targetLockKeys(release: TargetRelease): readonly string[] {
  const prefix = `proofstack:replay-definition:${release.scope.tenantId}`;
  return [
    `${prefix}:target-resource:${release.targetId}`,
    `${prefix}:target-release:${release.targetReleaseId}`,
  ];
}

function planLockKeys(plan: ReplayPlan): readonly string[] {
  const prefix = `proofstack:replay-definition:${plan.scope.tenantId}`;
  return [`${prefix}:plan-resource:${plan.planId}`, `${prefix}:plan-version:${plan.planVersionId}`];
}

async function loadResource(
  client: PoolClient,
  table: "proofstack_replay_plan_resources" | "proofstack_replay_targets",
  tenantId: string,
  idColumn: "plan_id" | "target_id",
  id: string,
): Promise<EvidenceScope | null> {
  const result = await client.query<ResourceRow>(
    `SELECT tenant_id, project_id, environment_id
     FROM public.${table}
     WHERE tenant_id = $1 AND ${idColumn} = $2`,
    [tenantId, id],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  const parsed = EvidenceScopeSchema.safeParse({
    environmentId: row?.environment_id,
    projectId: row?.project_id,
    tenantId: row?.tenant_id,
  });
  if (result.rows.length !== 1 || !parsed.success) {
    contractViolation("Stored replay logical resource binding is invalid");
  }
  return parsed.data;
}

function requireTargetRowMatches(row: TargetReleaseRow, release: TargetRelease): void {
  const executionArtifactId =
    release.execution.kind === "artifact" ? release.execution.artifact.artifactId : null;
  if (
    row.resource_matches !== true ||
    row.created_at_matches !== true ||
    row.tenant_id !== release.scope.tenantId ||
    row.project_id !== release.scope.projectId ||
    row.environment_id !== release.scope.environmentId ||
    row.target_id !== release.targetId ||
    row.target_release_id !== release.targetReleaseId ||
    row.schema_version !== release.schemaVersion ||
    row.definition_sha256 !== release.definitionSha256 ||
    row.target_adapter_name !== release.targetAdapter.name ||
    row.target_adapter_version !== release.targetAdapter.version ||
    row.target_adapter_protocol_version !== release.targetAdapter.protocolVersion ||
    row.worker_protocol_name !== release.workerProtocol.name ||
    row.worker_protocol_version !== release.workerProtocol.version ||
    row.execution_kind !== release.execution.kind ||
    row.provenance_artifact_id !== release.build.provenance.artifactId ||
    row.execution_artifact_id !== executionArtifactId ||
    row.emitted_artifact_bytes !== String(release.outputLimits.emittedArtifactBytes) ||
    row.stderr_bytes !== String(release.outputLimits.stderrBytes) ||
    row.stdout_bytes !== String(release.outputLimits.stdoutBytes) ||
    row.created_at_lexical !== release.createdAt ||
    row.created_by_principal_id !== release.createdByPrincipalId
  ) {
    contractViolation("Stored target release normalized columns are inconsistent");
  }
}

async function loadTargetRelease(
  client: PoolClient,
  tenantId: string,
  targetReleaseId: string,
): Promise<TargetRelease | null> {
  const result = await client.query<TargetReleaseRow>(
    `SELECT
      release.*,
      release.created_at = release.created_at_lexical::timestamptz AS created_at_matches,
      EXISTS (
        SELECT 1 FROM public.proofstack_replay_targets AS resource
        WHERE resource.tenant_id = release.tenant_id
          AND resource.project_id = release.project_id
          AND resource.environment_id = release.environment_id
          AND resource.target_id = release.target_id
      ) AS resource_matches,
      release.emitted_artifact_bytes::text AS emitted_artifact_bytes,
      release.stderr_bytes::text AS stderr_bytes,
      release.stdout_bytes::text AS stdout_bytes
    FROM public.proofstack_target_releases AS release
    WHERE release.tenant_id = $1 AND release.target_release_id = $2`,
    [tenantId, targetReleaseId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row) {
    contractViolation("PostgreSQL returned duplicate target release identities");
  }
  let release: TargetRelease;
  try {
    release = validateAndProjectTargetRelease(row.release).release;
  } catch (error) {
    contractViolation("Stored target release violates the canonical contract", error);
  }
  requireTargetRowMatches(row, release);
  return release;
}

interface BoundaryProjection {
  readonly boundaryId: string;
  readonly boundaryKind: string;
  readonly boundaryMode: string;
  readonly credentialId: string | null;
  readonly credentialVersionId: string | null;
  readonly declaration: ReplayBoundaryDeclaration;
  readonly destinationHostname: string | null;
  readonly destinationPort: number | null;
  readonly destinationScheme: string | null;
  readonly endpointProfileDefinitionSha256: string | null;
  readonly endpointProfileId: string | null;
  readonly endpointProfileVersion: string | null;
  readonly operation: string | null;
  readonly qualificationArtifactId: string | null;
  readonly recordedFixtureDefinitionSha256: string | null;
  readonly recordedFixtureId: string | null;
  readonly recordedFixtureVersionId: string | null;
  readonly recordedInvocationDefinitionSha256: string | null;
  readonly requestBytes: string | null;
  readonly responseBytes: string | null;
  readonly riskAcceptanceArtifactId: string | null;
  readonly sideEffectKind: string | null;
  readonly simulatorDefinitionSha256: string | null;
  readonly simulatorTargetAdapterName: string | null;
  readonly simulatorTargetAdapterProtocolVersion: string | null;
  readonly simulatorTargetAdapterVersion: string | null;
  readonly simulatorTargetId: string | null;
  readonly simulatorTargetReleaseId: string | null;
  readonly simulatorWorkerProtocolName: string | null;
  readonly simulatorWorkerProtocolVersion: string | null;
}

function boundaryProjection(boundary: ReplayBoundaryDeclaration): BoundaryProjection {
  const recorded = boundary.mode === "recorded_stub" ? boundary : null;
  const simulation = boundary.mode === "simulation" ? boundary : null;
  const live = boundary.mode === "live_provider" ? boundary : null;
  const riskAcceptance =
    live?.sideEffect.kind === "non_idempotent_write" ? live.sideEffect.riskAcceptance : null;
  return {
    boundaryId: boundary.boundaryId,
    boundaryKind: boundary.kind,
    boundaryMode: boundary.mode,
    credentialId: live?.credential.credentialId ?? null,
    credentialVersionId: live?.credential.credentialVersionId ?? null,
    declaration: boundary,
    destinationHostname: live?.destination.hostname ?? null,
    destinationPort: live?.destination.port ?? null,
    destinationScheme: live?.destination.scheme ?? null,
    endpointProfileDefinitionSha256: live?.endpointProfile.definitionSha256 ?? null,
    endpointProfileId: live?.endpointProfile.endpointProfileId ?? null,
    endpointProfileVersion: live?.endpointProfile.endpointProfileVersion ?? null,
    operation: live?.operation ?? null,
    qualificationArtifactId: simulation?.qualification.artifactId ?? null,
    recordedFixtureDefinitionSha256: recorded?.invocation.fixture.definitionSha256 ?? null,
    recordedFixtureId: recorded?.invocation.fixture.fixtureId ?? null,
    recordedFixtureVersionId: recorded?.invocation.fixture.fixtureVersionId ?? null,
    recordedInvocationDefinitionSha256: recorded?.invocationDefinitionSha256 ?? null,
    requestBytes: live ? String(live.requestLimits.requestBytes) : null,
    responseBytes: live ? String(live.requestLimits.responseBytes) : null,
    riskAcceptanceArtifactId: riskAcceptance?.artifactId ?? null,
    sideEffectKind: live?.sideEffect.kind ?? null,
    simulatorDefinitionSha256: simulation?.simulatorRelease.definitionSha256 ?? null,
    simulatorTargetAdapterName: simulation?.simulatorRelease.targetAdapter.name ?? null,
    simulatorTargetAdapterProtocolVersion:
      simulation?.simulatorRelease.targetAdapter.protocolVersion ?? null,
    simulatorTargetAdapterVersion: simulation?.simulatorRelease.targetAdapter.version ?? null,
    simulatorTargetId: simulation?.simulatorRelease.targetId ?? null,
    simulatorTargetReleaseId: simulation?.simulatorRelease.targetReleaseId ?? null,
    simulatorWorkerProtocolName: simulation?.simulatorRelease.workerProtocol.name ?? null,
    simulatorWorkerProtocolVersion: simulation?.simulatorRelease.workerProtocol.version ?? null,
  };
}

function requirePlanRowMatches(row: ReplayPlanRow, plan: ReplayPlan): void {
  if (
    row.resource_matches !== true ||
    row.created_at_matches !== true ||
    row.tenant_id !== plan.scope.tenantId ||
    row.project_id !== plan.scope.projectId ||
    row.environment_id !== plan.scope.environmentId ||
    row.plan_id !== plan.planId ||
    row.plan_version_id !== plan.planVersionId ||
    row.schema_version !== plan.schemaVersion ||
    row.definition_sha256 !== plan.definitionSha256 ||
    row.target_id !== plan.targetRelease.targetId ||
    row.target_release_id !== plan.targetRelease.targetReleaseId ||
    row.target_definition_sha256 !== plan.targetRelease.definitionSha256 ||
    row.target_adapter_name !== plan.targetRelease.targetAdapter.name ||
    row.target_adapter_version !== plan.targetRelease.targetAdapter.version ||
    row.target_adapter_protocol_version !== plan.targetRelease.targetAdapter.protocolVersion ||
    row.worker_protocol_name !== plan.workerProtocol.name ||
    row.worker_protocol_version !== plan.workerProtocol.version ||
    row.dataset_id !== plan.dataset.datasetId ||
    row.dataset_version_id !== plan.dataset.datasetVersionId ||
    row.dataset_definition_sha256 !== plan.dataset.definitionSha256 ||
    row.runtime_profile_id !== plan.runtimeProfile.id ||
    row.runtime_profile_version !== plan.runtimeProfile.version ||
    row.runtime_profile_definition_sha256 !== plan.runtimeProfile.definitionSha256 ||
    row.isolation_profile_id !== plan.isolationProfile.id ||
    row.isolation_profile_version !== plan.isolationProfile.version ||
    row.isolation_profile_definition_sha256 !== plan.isolationProfile.definitionSha256 ||
    row.boundary_count !== plan.boundaries.length ||
    row.retry_automatic !== plan.retryPolicy.automatic ||
    row.retry_max_attempts !== plan.retryPolicy.maxAttempts ||
    row.retry_per_attempt_timeout_milliseconds !==
      String(plan.retryPolicy.perAttemptTimeoutMilliseconds) ||
    row.retry_total_deadline_milliseconds !== String(plan.retryPolicy.totalDeadlineMilliseconds) ||
    row.created_at_lexical !== plan.createdAt ||
    row.created_by_principal_id !== plan.createdByPrincipalId
  ) {
    contractViolation("Stored replay plan normalized columns are inconsistent");
  }
}

function requireBudgetRowsMatch(rows: readonly BudgetRow[], plan: ReplayPlan): void {
  if (rows.length !== BUDGET_DIMENSIONS.length) {
    contractViolation("Stored replay plan budget row set is incomplete");
  }
  for (const [index, dimension] of BUDGET_DIMENSIONS.entries()) {
    const row = rows[index];
    const expected = plan.budget[dimension];
    if (
      !row ||
      row.dimension !== dimension ||
      row.limit_value !== String(expected.limit) ||
      row.measurement !== expected.measurement
    ) {
      contractViolation("Stored replay plan budget rows are inconsistent");
    }
  }
}

function requireBoundaryRowsMatch(rows: readonly BoundaryRow[], plan: ReplayPlan): void {
  if (rows.length !== plan.boundaries.length) {
    contractViolation("Stored replay plan boundary row set is incomplete");
  }
  for (const [position, boundary] of plan.boundaries.entries()) {
    const row = rows[position];
    const expected = boundaryProjection(boundary);
    if (
      !row ||
      row.boundary_position !== position ||
      row.boundary_id !== expected.boundaryId ||
      row.boundary_kind !== expected.boundaryKind ||
      row.boundary_mode !== expected.boundaryMode ||
      row.recorded_fixture_id !== expected.recordedFixtureId ||
      row.recorded_fixture_version_id !== expected.recordedFixtureVersionId ||
      row.recorded_fixture_definition_sha256 !== expected.recordedFixtureDefinitionSha256 ||
      row.recorded_invocation_definition_sha256 !== expected.recordedInvocationDefinitionSha256 ||
      row.simulator_target_id !== expected.simulatorTargetId ||
      row.simulator_target_release_id !== expected.simulatorTargetReleaseId ||
      row.simulator_definition_sha256 !== expected.simulatorDefinitionSha256 ||
      row.simulator_target_adapter_name !== expected.simulatorTargetAdapterName ||
      row.simulator_target_adapter_version !== expected.simulatorTargetAdapterVersion ||
      row.simulator_target_adapter_protocol_version !==
        expected.simulatorTargetAdapterProtocolVersion ||
      row.simulator_worker_protocol_name !== expected.simulatorWorkerProtocolName ||
      row.simulator_worker_protocol_version !== expected.simulatorWorkerProtocolVersion ||
      row.qualification_artifact_id !== expected.qualificationArtifactId ||
      row.credential_id !== expected.credentialId ||
      row.credential_version_id !== expected.credentialVersionId ||
      row.endpoint_profile_id !== expected.endpointProfileId ||
      row.endpoint_profile_version !== expected.endpointProfileVersion ||
      row.endpoint_profile_definition_sha256 !== expected.endpointProfileDefinitionSha256 ||
      row.destination_hostname !== expected.destinationHostname ||
      row.destination_port !== expected.destinationPort ||
      row.destination_scheme !== expected.destinationScheme ||
      row.operation !== expected.operation ||
      row.request_bytes !== expected.requestBytes ||
      row.response_bytes !== expected.responseBytes ||
      row.side_effect_kind !== expected.sideEffectKind ||
      row.risk_acceptance_artifact_id !== expected.riskAcceptanceArtifactId ||
      !isDeepStrictEqual(row.declaration, expected.declaration)
    ) {
      contractViolation("Stored replay plan boundary rows are inconsistent");
    }
  }
}

async function loadReplayPlan(
  client: PoolClient,
  tenantId: string,
  planVersionId: string,
): Promise<ReplayPlan | null> {
  const result = await client.query<ReplayPlanRow>(
    `SELECT
      plan.*,
      plan.created_at = plan.created_at_lexical::timestamptz AS created_at_matches,
      EXISTS (
        SELECT 1 FROM public.proofstack_replay_plan_resources AS resource
        WHERE resource.tenant_id = plan.tenant_id
          AND resource.project_id = plan.project_id
          AND resource.environment_id = plan.environment_id
          AND resource.plan_id = plan.plan_id
      ) AS resource_matches,
      plan.retry_per_attempt_timeout_milliseconds::text AS retry_per_attempt_timeout_milliseconds,
      plan.retry_total_deadline_milliseconds::text AS retry_total_deadline_milliseconds
    FROM public.proofstack_replay_plans AS plan
    WHERE plan.tenant_id = $1 AND plan.plan_version_id = $2`,
    [tenantId, planVersionId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row) {
    contractViolation("PostgreSQL returned duplicate replay plan identities");
  }
  let plan: ReplayPlan;
  try {
    plan = validateAndProjectReplayPlan(row.plan).plan;
  } catch (error) {
    contractViolation("Stored replay plan violates the canonical contract", error);
  }
  requirePlanRowMatches(row, plan);
  const budgetResult = await client.query<BudgetRow>(
    `SELECT dimension, limit_value::text AS limit_value, measurement
     FROM public.proofstack_replay_plan_budgets
     WHERE tenant_id = $1 AND plan_version_id = $2
     ORDER BY dimension COLLATE "C"`,
    [tenantId, planVersionId],
  );
  const boundaryResult = await client.query<BoundaryRow>(
    `SELECT
      boundary_position, boundary_id, boundary_kind, boundary_mode,
      recorded_fixture_id, recorded_fixture_version_id,
      recorded_fixture_definition_sha256, recorded_invocation_definition_sha256,
      simulator_target_id, simulator_target_release_id, simulator_definition_sha256,
      simulator_target_adapter_name, simulator_target_adapter_version,
      simulator_target_adapter_protocol_version, simulator_worker_protocol_name,
      simulator_worker_protocol_version, qualification_artifact_id, credential_id,
      credential_version_id, endpoint_profile_id, endpoint_profile_version,
      endpoint_profile_definition_sha256, destination_hostname, destination_port,
      destination_scheme, operation, request_bytes::text AS request_bytes,
      response_bytes::text AS response_bytes, side_effect_kind,
      risk_acceptance_artifact_id, declaration
     FROM public.proofstack_replay_plan_boundaries
     WHERE tenant_id = $1 AND plan_version_id = $2
     ORDER BY boundary_position`,
    [tenantId, planVersionId],
  );
  requireBudgetRowsMatch(budgetResult.rows, plan);
  requireBoundaryRowsMatch(boundaryResult.rows, plan);
  return plan;
}

async function requireTargetLineage(client: PoolClient, plan: ReplayPlan): Promise<void> {
  const references = [
    plan.targetRelease,
    ...plan.boundaries.flatMap((boundary) =>
      boundary.mode === "simulation" ? [boundary.simulatorRelease] : [],
    ),
  ];
  for (const reference of references) {
    const release = await loadTargetRelease(client, plan.scope.tenantId, reference.targetReleaseId);
    if (
      !release ||
      !scopesEqual(release.scope, plan.scope) ||
      !targetReferencesEqual(targetReference(release), reference)
    ) {
      throw new ReplayDefinitionLineageError();
    }
  }
}

async function requireDatasetAndFixtureLineage(
  client: PoolClient,
  plan: ReplayPlan,
): Promise<void> {
  const dataset = await client.query<{ readonly present: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM public.proofstack_regression_dataset_versions
      WHERE tenant_id = $1 AND project_id = $2 AND environment_id = $3
        AND dataset_id = $4 AND dataset_version_id = $5 AND definition_sha256 = $6
    ) AS present`,
    [
      plan.scope.tenantId,
      plan.scope.projectId,
      plan.scope.environmentId,
      plan.dataset.datasetId,
      plan.dataset.datasetVersionId,
      plan.dataset.definitionSha256,
    ],
  );
  if (dataset.rows.length !== 1 || dataset.rows[0]?.present !== true) {
    throw new ReplayDefinitionLineageError();
  }
  for (const boundary of plan.boundaries) {
    if (boundary.mode !== "recorded_stub") continue;
    const fixture = await client.query<{ readonly present: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM public.proofstack_regression_fixture_versions
        WHERE tenant_id = $1 AND project_id = $2 AND environment_id = $3
          AND fixture_id = $4 AND fixture_version_id = $5 AND definition_sha256 = $6
      ) AS present`,
      [
        plan.scope.tenantId,
        plan.scope.projectId,
        plan.scope.environmentId,
        boundary.invocation.fixture.fixtureId,
        boundary.invocation.fixture.fixtureVersionId,
        boundary.invocation.fixture.definitionSha256,
      ],
    );
    if (fixture.rows.length !== 1 || fixture.rows[0]?.present !== true) {
      throw new ReplayDefinitionLineageError();
    }
  }
}

async function insertTargetRelease(client: PoolClient, release: TargetRelease): Promise<void> {
  const executionArtifactId =
    release.execution.kind === "artifact" ? release.execution.artifact.artifactId : null;
  await client.query(
    `INSERT INTO public.proofstack_target_releases (
      tenant_id, project_id, environment_id, target_id, target_release_id,
      schema_version, definition_sha256, target_adapter_name, target_adapter_version,
      target_adapter_protocol_version, worker_protocol_name, worker_protocol_version,
      execution_kind, provenance_artifact_id, execution_artifact_id,
      emitted_artifact_bytes, stderr_bytes, stdout_bytes, created_at, created_at_lexical,
      created_by_principal_id, release
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
      $16, $17, $18, $19::timestamptz, $20, $21, $22::jsonb
    )`,
    [
      release.scope.tenantId,
      release.scope.projectId,
      release.scope.environmentId,
      release.targetId,
      release.targetReleaseId,
      release.schemaVersion,
      release.definitionSha256,
      release.targetAdapter.name,
      release.targetAdapter.version,
      release.targetAdapter.protocolVersion,
      release.workerProtocol.name,
      release.workerProtocol.version,
      release.execution.kind,
      release.build.provenance.artifactId,
      executionArtifactId,
      release.outputLimits.emittedArtifactBytes,
      release.outputLimits.stderrBytes,
      release.outputLimits.stdoutBytes,
      release.createdAt,
      release.createdAt,
      release.createdByPrincipalId,
      JSON.stringify(release),
    ],
  );
}

async function insertReplayPlan(client: PoolClient, plan: ReplayPlan): Promise<void> {
  await client.query(
    `INSERT INTO public.proofstack_replay_plans (
      tenant_id, project_id, environment_id, plan_id, plan_version_id, schema_version,
      definition_sha256, target_id, target_release_id, target_definition_sha256,
      target_adapter_name, target_adapter_version, target_adapter_protocol_version,
      worker_protocol_name, worker_protocol_version, dataset_id, dataset_version_id,
      dataset_definition_sha256, runtime_profile_id, runtime_profile_version,
      runtime_profile_definition_sha256, isolation_profile_id, isolation_profile_version,
      isolation_profile_definition_sha256, boundary_count, retry_automatic,
      retry_max_attempts, retry_per_attempt_timeout_milliseconds,
      retry_total_deadline_milliseconds, created_at, created_at_lexical,
      created_by_principal_id, plan
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
      $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29,
      $30::timestamptz, $31, $32, $33::jsonb
    )`,
    [
      plan.scope.tenantId,
      plan.scope.projectId,
      plan.scope.environmentId,
      plan.planId,
      plan.planVersionId,
      plan.schemaVersion,
      plan.definitionSha256,
      plan.targetRelease.targetId,
      plan.targetRelease.targetReleaseId,
      plan.targetRelease.definitionSha256,
      plan.targetRelease.targetAdapter.name,
      plan.targetRelease.targetAdapter.version,
      plan.targetRelease.targetAdapter.protocolVersion,
      plan.workerProtocol.name,
      plan.workerProtocol.version,
      plan.dataset.datasetId,
      plan.dataset.datasetVersionId,
      plan.dataset.definitionSha256,
      plan.runtimeProfile.id,
      plan.runtimeProfile.version,
      plan.runtimeProfile.definitionSha256,
      plan.isolationProfile.id,
      plan.isolationProfile.version,
      plan.isolationProfile.definitionSha256,
      plan.boundaries.length,
      plan.retryPolicy.automatic,
      plan.retryPolicy.maxAttempts,
      plan.retryPolicy.perAttemptTimeoutMilliseconds,
      plan.retryPolicy.totalDeadlineMilliseconds,
      plan.createdAt,
      plan.createdAt,
      plan.createdByPrincipalId,
      JSON.stringify(plan),
    ],
  );
  for (const dimension of BUDGET_DIMENSIONS) {
    const budget = plan.budget[dimension];
    await client.query(
      `INSERT INTO public.proofstack_replay_plan_budgets (
        tenant_id, project_id, environment_id, plan_id, plan_version_id,
        dimension, limit_value, measurement
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        plan.scope.tenantId,
        plan.scope.projectId,
        plan.scope.environmentId,
        plan.planId,
        plan.planVersionId,
        dimension,
        budget.limit,
        budget.measurement,
      ],
    );
  }
  for (const [position, boundary] of plan.boundaries.entries()) {
    const value = boundaryProjection(boundary);
    await client.query(
      `INSERT INTO public.proofstack_replay_plan_boundaries (
        tenant_id, project_id, environment_id, plan_id, plan_version_id,
        boundary_position, boundary_id, boundary_kind, boundary_mode,
        recorded_fixture_id, recorded_fixture_version_id, recorded_fixture_definition_sha256,
        recorded_invocation_definition_sha256, simulator_target_id,
        simulator_target_release_id, simulator_definition_sha256,
        simulator_target_adapter_name, simulator_target_adapter_version,
        simulator_target_adapter_protocol_version, simulator_worker_protocol_name,
        simulator_worker_protocol_version, qualification_artifact_id, credential_id,
        credential_version_id, endpoint_profile_id, endpoint_profile_version,
        endpoint_profile_definition_sha256, destination_hostname, destination_port,
        destination_scheme, operation, request_bytes, response_bytes, side_effect_kind,
        risk_acceptance_artifact_id, declaration
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28,
        $29, $30, $31, $32, $33, $34, $35, $36::jsonb
      )`,
      [
        plan.scope.tenantId,
        plan.scope.projectId,
        plan.scope.environmentId,
        plan.planId,
        plan.planVersionId,
        position,
        value.boundaryId,
        value.boundaryKind,
        value.boundaryMode,
        value.recordedFixtureId,
        value.recordedFixtureVersionId,
        value.recordedFixtureDefinitionSha256,
        value.recordedInvocationDefinitionSha256,
        value.simulatorTargetId,
        value.simulatorTargetReleaseId,
        value.simulatorDefinitionSha256,
        value.simulatorTargetAdapterName,
        value.simulatorTargetAdapterVersion,
        value.simulatorTargetAdapterProtocolVersion,
        value.simulatorWorkerProtocolName,
        value.simulatorWorkerProtocolVersion,
        value.qualificationArtifactId,
        value.credentialId,
        value.credentialVersionId,
        value.endpointProfileId,
        value.endpointProfileVersion,
        value.endpointProfileDefinitionSha256,
        value.destinationHostname,
        value.destinationPort,
        value.destinationScheme,
        value.operation,
        value.requestBytes,
        value.responseBytes,
        value.sideEffectKind,
        value.riskAcceptanceArtifactId,
        JSON.stringify(value.declaration),
      ],
    );
  }
}

/** PostgreSQL authority for immutable, tenant-isolated replay definitions. */
export class PostgresReplayDefinitionRepository implements ReplayDefinitionRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async findReplayPlan(
    scopeInput: EvidenceScope,
    planVersionIdInput: string,
  ): Promise<ReplayPlan | null> {
    const scope = requireScope(scopeInput);
    const planVersionId = requireOpaqueId(planVersionIdInput);
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const plan = await loadReplayPlan(client, scope.tenantId, planVersionId);
      return !plan || !scopesEqual(plan.scope, scope) ? null : clone(plan);
    });
  }

  async findTargetRelease(
    scopeInput: EvidenceScope,
    targetReleaseIdInput: string,
  ): Promise<TargetRelease | null> {
    const scope = requireScope(scopeInput);
    const targetReleaseId = requireOpaqueId(targetReleaseIdInput);
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const release = await loadTargetRelease(client, scope.tenantId, targetReleaseId);
      return !release || !scopesEqual(release.scope, scope) ? null : clone(release);
    });
  }

  async publishReplayPlan(
    candidate: ReplayPlan,
  ): Promise<PublishReplayDefinitionResult<ReplayPlan>> {
    const validated = validateAndProjectReplayPlan(candidate);
    const plan = validated.plan;
    try {
      return await withTenantTransaction(this.pool, plan.scope.tenantId, async (client) => {
        await acquirePublicationLocks(client, planLockKeys(plan));
        const existing = await loadReplayPlan(client, plan.scope.tenantId, plan.planVersionId);
        if (existing) {
          const stored = validateAndProjectReplayPlan(existing);
          if (!areReplayPlanDefinitionsEqual(stored.definition, validated.definition)) {
            throw new ReplayDefinitionConflictError();
          }
          await requireCanonicalPublicationIntent(
            client,
            buildReplayPlanPublishedOutboxIntent(stored.plan),
          );
          return { created: false, definition: clone(stored.plan) };
        }

        const intent = buildReplayPlanPublishedOutboxIntent(plan);
        await requirePublicationIntentAbsent(client, intent);
        const resource = await loadResource(
          client,
          "proofstack_replay_plan_resources",
          plan.scope.tenantId,
          "plan_id",
          plan.planId,
        );
        if (resource && !scopesEqual(resource, plan.scope)) {
          throw new ReplayDefinitionConflictError();
        }
        await requireTargetLineage(client, plan);
        await requireDatasetAndFixtureLineage(client, plan);
        if (!resource) {
          await client.query(
            `INSERT INTO public.proofstack_replay_plan_resources (
              tenant_id, project_id, environment_id, plan_id
            ) VALUES ($1, $2, $3, $4)`,
            [plan.scope.tenantId, plan.scope.projectId, plan.scope.environmentId, plan.planId],
          );
        }
        await insertReplayPlan(client, plan);
        await insertPublicationIntent(client, intent);
        return { created: true, definition: clone(plan) };
      });
    } catch (error) {
      mapPersistenceError(error);
    }
  }

  async publishTargetRelease(
    candidate: TargetRelease,
  ): Promise<PublishReplayDefinitionResult<TargetRelease>> {
    const validated = validateAndProjectTargetRelease(candidate);
    const release = validated.release;
    try {
      return await withTenantTransaction(this.pool, release.scope.tenantId, async (client) => {
        await acquirePublicationLocks(client, targetLockKeys(release));
        const existing = await loadTargetRelease(
          client,
          release.scope.tenantId,
          release.targetReleaseId,
        );
        if (existing) {
          const stored = validateAndProjectTargetRelease(existing);
          if (!areTargetReleaseDefinitionsEqual(stored.definition, validated.definition)) {
            throw new ReplayDefinitionConflictError();
          }
          await requireCanonicalPublicationIntent(
            client,
            buildTargetReleasePublishedOutboxIntent(stored.release),
          );
          return { created: false, definition: clone(stored.release) };
        }

        const intent = buildTargetReleasePublishedOutboxIntent(release);
        await requirePublicationIntentAbsent(client, intent);
        const resource = await loadResource(
          client,
          "proofstack_replay_targets",
          release.scope.tenantId,
          "target_id",
          release.targetId,
        );
        if (resource && !scopesEqual(resource, release.scope)) {
          throw new ReplayDefinitionConflictError();
        }
        if (!resource) {
          await client.query(
            `INSERT INTO public.proofstack_replay_targets (
              tenant_id, project_id, environment_id, target_id
            ) VALUES ($1, $2, $3, $4)`,
            [
              release.scope.tenantId,
              release.scope.projectId,
              release.scope.environmentId,
              release.targetId,
            ],
          );
        }
        await insertTargetRelease(client, release);
        await insertPublicationIntent(client, intent);
        return { created: true, definition: clone(release) };
      });
    } catch (error) {
      mapPersistenceError(error);
    }
  }
}
