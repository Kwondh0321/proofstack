import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import {
  type ArtifactOwnership,
  ArtifactOwnershipSchema,
  type ArtifactTombstone,
  ArtifactTombstoneSchema,
  EvidenceScopeSchema,
  type InteractionFixtureContentRevocation,
  InteractionFixtureContentRevocationSchema,
  OpaqueIdSchema,
  type EvidenceScope,
  type RecordedInteractionFixtureVersion,
  type RegressionDatasetVersion,
  type RegressionFixtureVersion,
  type RegressionFixtureVersionReference,
  type RequestedRegressionFixtureVersionReference,
  RequestedRegressionFixtureVersionReferenceSchema,
  Sha256Schema,
} from "@proofstack/contracts";
import {
  areRecordedInteractionFixtureVersionDefinitionsEqual,
  areRegressionDatasetVersionDefinitionsEqual,
  areRegressionFixtureVersionDefinitionsEqual,
  buildRecordedInteractionFixtureVersionPublishedOutboxIntent,
  buildRegressionDatasetVersionPublishedOutboxIntent,
  buildRegressionFixtureVersionPublishedOutboxIntent,
  type InteractionFixtureVersionRepository,
  type PublishRecordedInteractionFixtureVersionResult,
  RegressionRepositoryContractError,
  RegressionArtifactBindingError,
  RegressionFixtureContentRevocationConflictError,
  RegressionVersionConflictError,
  RegressionVersionLineageError,
  RegressionVersionNotFoundError,
  type PublishRegressionVersionResult,
  type RegressionVersionPublishedOutboxIntent,
  type RevokeInteractionFixtureContentCandidate,
  type RevokeInteractionFixtureContentResult,
  type ResolveRegressionFixtureVersionReferencesResult,
  type StoredInteractionFixtureContent,
  type StoredRecordedInteractionFixtureVersion,
  validateAndProjectRecordedInteractionFixtureVersion,
  validateAndProjectRegressionDatasetVersion,
  validateAndProjectRegressionFixtureVersion,
} from "@proofstack/datasets";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { withTenantTransaction } from "./tenant-transaction.js";

interface PresenceRow extends QueryResultRow {
  readonly present: boolean;
}

interface FixtureResourceRow extends QueryResultRow {
  readonly environment_id: string;
  readonly fixture_id: string;
  readonly project_id: string;
  readonly root_definition_sha256: string;
  readonly root_fixture_version_id: string;
  readonly tenant_id: string;
}

interface DatasetResourceRow extends QueryResultRow {
  readonly dataset_id: string;
  readonly environment_id: string;
  readonly project_id: string;
  readonly root_dataset_version_id: string;
  readonly root_definition_sha256: string;
  readonly tenant_id: string;
}

interface FixtureVersionRow extends QueryResultRow {
  readonly created_at_lexical: string;
  readonly created_at_matches: boolean;
  readonly created_by_principal_id: string;
  readonly definition_sha256: string;
  readonly description: string | null;
  readonly environment_id: string;
  readonly fixture_id: string;
  readonly fixture_version_id: string;
  readonly name: string;
  readonly predecessor_definition_sha256: string | null;
  readonly predecessor_fixture_version_id: string | null;
  readonly project_id: string;
  readonly replayability: string;
  readonly root_definition_sha256: string;
  readonly root_fixture_version_id: string;
  readonly schema_version: string;
  readonly source_captured_at_lexical: string;
  readonly source_captured_at_matches: boolean;
  readonly source_completeness: string;
  readonly source_event_count: number;
  readonly source_kind: string;
  readonly source_trace_id: string;
  readonly tenant_id: string;
}

interface FixtureEventRow extends QueryResultRow {
  readonly environment_id: string;
  readonly event_id: string;
  readonly event_position: number;
  readonly fixture_id: string;
  readonly fixture_version_id: string;
  readonly project_id: string;
  readonly source_event_count: number;
  readonly source_trace_id: string;
  readonly tenant_id: string;
}

interface RecordedFixtureManifestRow extends QueryResultRow {
  readonly environment_id: string;
  readonly fixture_id: string;
  readonly fixture_version_id: string;
  readonly interaction_capture: unknown;
  readonly project_id: string;
  readonly tenant_id: string;
}

interface ArtifactOwnershipRow extends QueryResultRow {
  readonly artifact_id: string;
  readonly artifact_position: number;
  readonly bound_at_lexical: string;
  readonly bound_at_matches: boolean;
  readonly bound_by_principal_id: string;
  readonly environment_id: string;
  readonly fixture_id: string;
  readonly fixture_version_id: string;
  readonly project_id: string;
  readonly schema_version: string;
  readonly tenant_id: string;
}

interface ArtifactBindingRow extends QueryResultRow {
  readonly artifact_id: string;
  readonly classification: string;
  readonly content_sha256: string;
  readonly content_size_bytes: number;
  readonly environment_id: string;
  readonly media_type: string;
  readonly project_id: string;
  readonly redaction: unknown;
  readonly retention_mode: string;
  readonly state: string;
  readonly tenant_id: string;
}

interface ArtifactAvailabilityRow extends QueryResultRow {
  readonly artifact_id: string;
  readonly state: string;
  readonly tombstoned_at_lexical: string | null;
}

interface FixtureRevocationRow extends QueryResultRow {
  readonly environment_id: string;
  readonly fixture_id: string;
  readonly fixture_version_id: string;
  readonly project_id: string;
  readonly reason: string;
  readonly revocation_id: string;
  readonly revoked_at_lexical: string;
  readonly revoked_at_matches: boolean;
  readonly revoked_by_principal_id: string;
  readonly schema_version: string;
  readonly tenant_id: string;
}

interface FixtureTombstoneRow extends QueryResultRow {
  readonly actor_principal_id: string;
  readonly artifact_id: string;
  readonly occurred_at_lexical: string;
  readonly reason: string;
  readonly tombstone_id: string;
  readonly tombstone_trigger: string;
}

interface DatasetVersionRow extends QueryResultRow {
  readonly created_at_lexical: string;
  readonly created_at_matches: boolean;
  readonly created_by_principal_id: string;
  readonly dataset_id: string;
  readonly dataset_version_id: string;
  readonly definition_sha256: string;
  readonly description: string | null;
  readonly environment_id: string;
  readonly fixture_version_count: number;
  readonly name: string;
  readonly predecessor_dataset_version_id: string | null;
  readonly predecessor_definition_sha256: string | null;
  readonly project_id: string;
  readonly root_dataset_version_id: string;
  readonly root_definition_sha256: string;
  readonly schema_version: string;
  readonly tenant_id: string;
}

interface DatasetMemberRow extends QueryResultRow {
  readonly dataset_id: string;
  readonly dataset_version_id: string;
  readonly environment_id: string;
  readonly fixture_definition_sha256: string;
  readonly fixture_id: string;
  readonly fixture_version_count: number;
  readonly fixture_version_id: string;
  readonly member_position: number;
  readonly project_id: string;
  readonly tenant_id: string;
}

interface PublicationIntentStatusRow extends QueryResultRow {
  readonly status: string;
}

type PublicationIntentStatus = "absent" | "canonical" | "conflict";

interface FixtureVersionIdentityRow extends QueryResultRow {
  readonly environment_id: string;
  readonly fixture_id: string;
  readonly fixture_version_id: string;
  readonly project_id: string;
  readonly tenant_id: string;
}

interface DatasetVersionIdentityRow extends QueryResultRow {
  readonly dataset_id: string;
  readonly dataset_version_id: string;
  readonly environment_id: string;
  readonly project_id: string;
  readonly tenant_id: string;
}

interface ResourceBinding {
  readonly rootDefinitionSha256: string;
  readonly rootVersionId: string;
  readonly scope: EvidenceScope;
}

interface StoredFixtureRecord {
  readonly rootDefinitionSha256: string;
  readonly rootVersionId: string;
  readonly version: RegressionFixtureVersion;
}

interface StoredRecordedFixtureRecord {
  readonly ownerships: readonly ArtifactOwnership[];
  readonly rootDefinitionSha256: string;
  readonly rootVersionId: string;
  readonly version: RecordedInteractionFixtureVersion;
}

type StoredAnyFixtureRecord = StoredFixtureRecord | StoredRecordedFixtureRecord;

interface StoredDatasetRecord {
  readonly rootDefinitionSha256: string;
  readonly rootVersionId: string;
  readonly version: RegressionDatasetVersion;
}

const FIXTURE_VERSION_COLUMNS = `
  tenant_id,
  project_id,
  environment_id,
  fixture_id,
  root_fixture_version_id,
  root_definition_sha256,
  fixture_version_id,
  schema_version,
  name,
  description,
  predecessor_fixture_version_id,
  predecessor_definition_sha256,
  replayability,
  source_kind,
  source_trace_id,
  source_event_count,
  source_completeness,
  source_captured_at_lexical,
  source_captured_at = source_captured_at_lexical::timestamptz AS source_captured_at_matches,
  created_at_lexical,
  created_at = created_at_lexical::timestamptz AS created_at_matches,
  created_by_principal_id,
  definition_sha256
`;

const DATASET_VERSION_COLUMNS = `
  tenant_id,
  project_id,
  environment_id,
  dataset_id,
  root_dataset_version_id,
  root_definition_sha256,
  dataset_version_id,
  schema_version,
  name,
  description,
  predecessor_dataset_version_id,
  predecessor_definition_sha256,
  fixture_version_count,
  created_at_lexical,
  created_at = created_at_lexical::timestamptz AS created_at_matches,
  created_by_principal_id,
  definition_sha256
`;

const SELECT_FIXTURE_VERSIONS_SQL = `
  SELECT ${FIXTURE_VERSION_COLUMNS}
  FROM public.proofstack_regression_fixture_versions
  WHERE tenant_id = $1 AND fixture_version_id = ANY($2::varchar[])
    AND replayability = 'evidence_only'
`;

const SELECT_RECORDED_FIXTURE_HEADERS_SQL = `
  SELECT ${FIXTURE_VERSION_COLUMNS}
  FROM public.proofstack_regression_fixture_versions
  WHERE tenant_id = $1 AND fixture_version_id = ANY($2::varchar[])
    AND replayability = 'recorded_interactions'
`;

const SELECT_FIXTURE_EVENTS_SQL = `
  SELECT
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id,
    source_trace_id,
    source_event_count,
    event_position,
    event_id
  FROM public.proofstack_regression_fixture_events
  WHERE tenant_id = $1 AND fixture_version_id = ANY($2::varchar[])
  ORDER BY fixture_version_id COLLATE "C", event_position
`;

const SELECT_RECORDED_FIXTURE_MANIFESTS_SQL = `
  SELECT
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id,
    interaction_capture
  FROM public.proofstack_recorded_interaction_fixture_versions
  WHERE tenant_id = $1 AND fixture_version_id = ANY($2::varchar[])
`;

const SELECT_INTERACTION_OWNERSHIPS_SQL = `
  SELECT
    tenant_id,
    project_id,
    environment_id,
    artifact_id,
    fixture_id,
    fixture_version_id,
    artifact_position,
    schema_version,
    bound_at_lexical,
    bound_at = bound_at_lexical::timestamptz AS bound_at_matches,
    bound_by_principal_id
  FROM public.proofstack_interaction_fixture_artifact_ownerships
  WHERE tenant_id = $1 AND fixture_version_id = ANY($2::varchar[])
  ORDER BY fixture_version_id COLLATE "C", artifact_position
`;

const SELECT_DATASET_VERSIONS_SQL = `
  SELECT ${DATASET_VERSION_COLUMNS}
  FROM public.proofstack_regression_dataset_versions
  WHERE tenant_id = $1 AND dataset_version_id = ANY($2::varchar[])
`;

const SELECT_DATASET_MEMBERS_SQL = `
  SELECT
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    dataset_version_id,
    fixture_version_count,
    member_position,
    fixture_id,
    fixture_version_id,
    fixture_definition_sha256
  FROM public.proofstack_regression_dataset_members
  WHERE tenant_id = $1 AND dataset_version_id = ANY($2::varchar[])
  ORDER BY dataset_version_id COLLATE "C", member_position
`;

const SELECT_FIXTURE_VERSION_IDENTITIES_SQL = `
  SELECT tenant_id, project_id, environment_id, fixture_id, fixture_version_id
  FROM public.proofstack_regression_fixture_versions
  WHERE tenant_id = $1 AND fixture_version_id = ANY($2::varchar[])
`;

const SELECT_DATASET_VERSION_IDENTITIES_SQL = `
  SELECT tenant_id, project_id, environment_id, dataset_id, dataset_version_id
  FROM public.proofstack_regression_dataset_versions
  WHERE tenant_id = $1 AND dataset_version_id = ANY($2::varchar[])
`;

const SELECT_FIXTURE_RESOURCE_SQL = `
  SELECT
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    root_fixture_version_id,
    root_definition_sha256
  FROM public.proofstack_regression_fixtures
  WHERE tenant_id = $1 AND fixture_id = $2
`;

const SELECT_DATASET_RESOURCE_SQL = `
  SELECT
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    root_dataset_version_id,
    root_definition_sha256
  FROM public.proofstack_regression_datasets
  WHERE tenant_id = $1 AND dataset_id = $2
`;

const INSERT_FIXTURE_RESOURCE_SQL = `
  INSERT INTO public.proofstack_regression_fixtures (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    root_fixture_version_id,
    root_definition_sha256
  ) VALUES ($1, $2, $3, $4, $5, $6)
`;

const INSERT_FIXTURE_VERSION_SQL = `
  INSERT INTO public.proofstack_regression_fixture_versions (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    root_fixture_version_id,
    root_definition_sha256,
    fixture_version_id,
    schema_version,
    name,
    description,
    predecessor_fixture_version_id,
    predecessor_definition_sha256,
    replayability,
    source_kind,
    source_trace_id,
    source_event_count,
    source_completeness,
    source_captured_at,
    source_captured_at_lexical,
    created_at,
    created_at_lexical,
    created_by_principal_id,
    definition_sha256
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
    $17, $18::timestamptz, $19, $20::timestamptz, $21, $22, $23
  )
`;

const INSERT_FIXTURE_EVENTS_SQL = `
  INSERT INTO public.proofstack_regression_fixture_events (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id,
    source_trace_id,
    source_event_count,
    event_position,
    event_id
  )
  SELECT
    $1,
    $2,
    $3,
    $4,
    $5,
    $6,
    $7,
    member.event_position,
    member.event_id
  FROM unnest($8::smallint[], $9::varchar[]) AS member(event_position, event_id)
  ORDER BY member.event_position
`;

const INSERT_RECORDED_FIXTURE_MANIFEST_SQL = `
  INSERT INTO public.proofstack_recorded_interaction_fixture_versions (
    tenant_id,
    project_id,
    environment_id,
    fixture_id,
    fixture_version_id,
    interaction_capture
  ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
`;

const INSERT_INTERACTION_OWNERSHIPS_SQL = `
  INSERT INTO public.proofstack_interaction_fixture_artifact_ownerships (
    tenant_id,
    project_id,
    environment_id,
    artifact_id,
    fixture_id,
    fixture_version_id,
    artifact_position,
    schema_version,
    bound_at,
    bound_at_lexical,
    bound_by_principal_id
  )
  SELECT
    $1,
    $2,
    $3,
    ownership.artifact_id,
    $4,
    $5,
    ownership.artifact_position,
    '0.1',
    $6::timestamptz,
    $7,
    $8
  FROM unnest($9::varchar[], $10::smallint[]) AS ownership(
    artifact_id,
    artifact_position
  )
  ORDER BY ownership.artifact_position
`;

const INSERT_DATASET_RESOURCE_SQL = `
  INSERT INTO public.proofstack_regression_datasets (
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    root_dataset_version_id,
    root_definition_sha256
  ) VALUES ($1, $2, $3, $4, $5, $6)
`;

const INSERT_DATASET_VERSION_SQL = `
  INSERT INTO public.proofstack_regression_dataset_versions (
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    root_dataset_version_id,
    root_definition_sha256,
    dataset_version_id,
    schema_version,
    name,
    description,
    predecessor_dataset_version_id,
    predecessor_definition_sha256,
    fixture_version_count,
    created_at,
    created_at_lexical,
    created_by_principal_id,
    definition_sha256
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
    $14::timestamptz, $15, $16, $17
  )
`;

const INSERT_DATASET_MEMBERS_SQL = `
  INSERT INTO public.proofstack_regression_dataset_members (
    tenant_id,
    project_id,
    environment_id,
    dataset_id,
    dataset_version_id,
    fixture_version_count,
    member_position,
    fixture_id,
    fixture_version_id,
    fixture_definition_sha256
  )
  SELECT
    $1,
    $2,
    $3,
    $4,
    $5,
    $6,
    member.member_position,
    member.fixture_id,
    member.fixture_version_id,
    member.fixture_definition_sha256
  FROM unnest(
    $7::smallint[],
    $8::varchar[],
    $9::varchar[],
    $10::character(64)[]
  ) AS member(
    member_position,
    fixture_id,
    fixture_version_id,
    fixture_definition_sha256
  )
  ORDER BY member.member_position
`;

const PUBLICATION_INTENT_STATUS_SQL = `
  SELECT public.proofstack_regression_publication_intent_status(
    $1,
    $2,
    $3,
    $4,
    $5,
    $6::jsonb,
    $7::timestamptz
  ) AS status
`;

const INSERT_PUBLICATION_INTENT_SQL = `
  INSERT INTO public.proofstack_outbox (
    tenant_id,
    event_type,
    aggregate_type,
    aggregate_id,
    schema_version,
    payload,
    created_at
  ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
`;

function contractViolation(message: string, cause?: unknown): never {
  throw new RegressionRepositoryContractError(message, cause === undefined ? undefined : { cause });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function scopesEqual(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function requireScope(input: EvidenceScope): EvidenceScope {
  return EvidenceScopeSchema.parse(input);
}

function requireOpaqueId(input: string): string {
  return OpaqueIdSchema.parse(input);
}

function requirePresence(rows: readonly PresenceRow[], label: string): boolean {
  if (rows.length !== 1 || typeof rows[0]?.present !== "boolean") {
    contractViolation(`PostgreSQL did not return a valid ${label} presence result`);
  }
  return rows[0].present;
}

function requireFixtureBinding(
  row: FixtureResourceRow,
  expectedTenantId: string,
  expectedFixtureId: string,
): ResourceBinding {
  const scope = EvidenceScopeSchema.safeParse({
    environmentId: row.environment_id,
    projectId: row.project_id,
    tenantId: row.tenant_id,
  });
  const rootVersionId = OpaqueIdSchema.safeParse(row.root_fixture_version_id);
  const rootDigest = Sha256Schema.safeParse(row.root_definition_sha256);
  if (
    !scope.success ||
    row.tenant_id !== expectedTenantId ||
    row.fixture_id !== expectedFixtureId ||
    !OpaqueIdSchema.safeParse(row.fixture_id).success ||
    !rootVersionId.success ||
    !rootDigest.success
  ) {
    contractViolation("Stored regression fixture resource binding is invalid");
  }
  return {
    rootDefinitionSha256: rootDigest.data,
    rootVersionId: rootVersionId.data,
    scope: scope.data,
  };
}

function requireDatasetBinding(
  row: DatasetResourceRow,
  expectedTenantId: string,
  expectedDatasetId: string,
): ResourceBinding {
  const scope = EvidenceScopeSchema.safeParse({
    environmentId: row.environment_id,
    projectId: row.project_id,
    tenantId: row.tenant_id,
  });
  const rootVersionId = OpaqueIdSchema.safeParse(row.root_dataset_version_id);
  const rootDigest = Sha256Schema.safeParse(row.root_definition_sha256);
  if (
    !scope.success ||
    row.tenant_id !== expectedTenantId ||
    row.dataset_id !== expectedDatasetId ||
    !OpaqueIdSchema.safeParse(row.dataset_id).success ||
    !rootVersionId.success ||
    !rootDigest.success
  ) {
    contractViolation("Stored regression dataset resource binding is invalid");
  }
  return {
    rootDefinitionSha256: rootDigest.data,
    rootVersionId: rootVersionId.data,
    scope: scope.data,
  };
}

function reconstructFixture(
  row: FixtureVersionRow,
  events: readonly FixtureEventRow[],
): StoredFixtureRecord {
  if (
    !Number.isInteger(row.source_event_count) ||
    row.source_event_count !== events.length ||
    row.source_captured_at_matches !== true ||
    row.created_at_matches !== true ||
    (row.description !== null && typeof row.description !== "string") ||
    (row.predecessor_fixture_version_id === null) !== (row.predecessor_definition_sha256 === null)
  ) {
    contractViolation("Stored regression fixture version header is invalid");
  }

  const eventIds: string[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (
      !event ||
      event.tenant_id !== row.tenant_id ||
      event.project_id !== row.project_id ||
      event.environment_id !== row.environment_id ||
      event.fixture_id !== row.fixture_id ||
      event.fixture_version_id !== row.fixture_version_id ||
      event.source_trace_id !== row.source_trace_id ||
      event.source_event_count !== row.source_event_count ||
      event.event_position !== index ||
      typeof event.event_id !== "string"
    ) {
      contractViolation("Stored regression fixture event membership is invalid");
    }
    eventIds.push(event.event_id);
  }

  const parsedRootVersionId = OpaqueIdSchema.safeParse(row.root_fixture_version_id);
  const parsedRootDigest = Sha256Schema.safeParse(row.root_definition_sha256);
  if (!parsedRootVersionId.success || !parsedRootDigest.success) {
    contractViolation("Stored regression fixture root binding is invalid");
  }

  const hasPredecessor = row.predecessor_fixture_version_id !== null;
  if (
    (hasPredecessor && row.fixture_version_id === row.root_fixture_version_id) ||
    (!hasPredecessor &&
      (row.fixture_version_id !== row.root_fixture_version_id ||
        row.definition_sha256 !== row.root_definition_sha256))
  ) {
    contractViolation("Stored regression fixture root lineage is invalid");
  }

  const input = {
    createdAt: row.created_at_lexical,
    createdByPrincipalId: row.created_by_principal_id,
    definitionSha256: row.definition_sha256,
    ...(row.description === null ? {} : { description: row.description }),
    fixtureId: row.fixture_id,
    fixtureVersionId: row.fixture_version_id,
    name: row.name,
    ...(row.predecessor_fixture_version_id === null
      ? {}
      : {
          predecessor: {
            definitionSha256: row.predecessor_definition_sha256,
            fixtureVersionId: row.predecessor_fixture_version_id,
          },
        }),
    replayability: row.replayability,
    schemaVersion: row.schema_version,
    scope: {
      environmentId: row.environment_id,
      projectId: row.project_id,
      tenantId: row.tenant_id,
    },
    source: {
      capturedAt: row.source_captured_at_lexical,
      eventIds,
      kind: row.source_kind,
      observedEventCount: row.source_event_count,
      sourceCompleteness: row.source_completeness,
      traceId: row.source_trace_id,
    },
  };

  try {
    return {
      rootDefinitionSha256: parsedRootDigest.data,
      rootVersionId: parsedRootVersionId.data,
      version: validateAndProjectRegressionFixtureVersion(input).version,
    };
  } catch (cause) {
    contractViolation("Stored regression fixture version violates the canonical contract", cause);
  }
}

function reconstructRecordedFixture(
  row: FixtureVersionRow,
  events: readonly FixtureEventRow[],
  manifest: RecordedFixtureManifestRow,
  ownershipRows: readonly ArtifactOwnershipRow[],
): StoredRecordedFixtureRecord {
  if (
    !Number.isInteger(row.source_event_count) ||
    row.source_event_count !== events.length ||
    row.source_captured_at_matches !== true ||
    row.created_at_matches !== true ||
    (row.description !== null && typeof row.description !== "string") ||
    row.predecessor_fixture_version_id === null ||
    row.predecessor_definition_sha256 === null ||
    manifest.tenant_id !== row.tenant_id ||
    manifest.project_id !== row.project_id ||
    manifest.environment_id !== row.environment_id ||
    manifest.fixture_id !== row.fixture_id ||
    manifest.fixture_version_id !== row.fixture_version_id
  ) {
    contractViolation("Stored recorded interaction fixture header is invalid");
  }

  const eventIds: string[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (
      !event ||
      event.tenant_id !== row.tenant_id ||
      event.project_id !== row.project_id ||
      event.environment_id !== row.environment_id ||
      event.fixture_id !== row.fixture_id ||
      event.fixture_version_id !== row.fixture_version_id ||
      event.source_trace_id !== row.source_trace_id ||
      event.source_event_count !== row.source_event_count ||
      event.event_position !== index ||
      typeof event.event_id !== "string"
    ) {
      contractViolation("Stored recorded interaction fixture event membership is invalid");
    }
    eventIds.push(event.event_id);
  }

  const parsedRootVersionId = OpaqueIdSchema.safeParse(row.root_fixture_version_id);
  const parsedRootDigest = Sha256Schema.safeParse(row.root_definition_sha256);
  if (
    !parsedRootVersionId.success ||
    !parsedRootDigest.success ||
    row.fixture_version_id === row.root_fixture_version_id
  ) {
    contractViolation("Stored recorded interaction fixture root lineage is invalid");
  }

  let version: RecordedInteractionFixtureVersion;
  try {
    version = validateAndProjectRecordedInteractionFixtureVersion({
      createdAt: row.created_at_lexical,
      createdByPrincipalId: row.created_by_principal_id,
      definitionSha256: row.definition_sha256,
      ...(row.description === null ? {} : { description: row.description }),
      fixtureId: row.fixture_id,
      fixtureVersionId: row.fixture_version_id,
      interactionCapture: manifest.interaction_capture,
      name: row.name,
      predecessor: {
        definitionSha256: row.predecessor_definition_sha256,
        fixtureVersionId: row.predecessor_fixture_version_id,
      },
      replayability: row.replayability,
      schemaVersion: row.schema_version,
      scope: {
        environmentId: row.environment_id,
        projectId: row.project_id,
        tenantId: row.tenant_id,
      },
      source: {
        capturedAt: row.source_captured_at_lexical,
        eventIds,
        kind: row.source_kind,
        observedEventCount: row.source_event_count,
        sourceCompleteness: row.source_completeness,
        traceId: row.source_trace_id,
      },
    }).version;
  } catch (cause) {
    contractViolation(
      "Stored recorded interaction fixture version violates the canonical contract",
      cause,
    );
  }

  if (ownershipRows.length !== version.interactionCapture.artifacts.length) {
    contractViolation("Stored recorded interaction fixture ownership is incomplete");
  }
  const ownerships = ownershipRows.map((ownershipRow, index) => {
    const expected = version.interactionCapture.artifacts[index]?.contentReference.artifactId;
    const parsed = ArtifactOwnershipSchema.safeParse({
      artifactId: ownershipRow.artifact_id,
      boundAt: ownershipRow.bound_at_lexical,
      boundByPrincipalId: ownershipRow.bound_by_principal_id,
      owner: {
        fixtureId: ownershipRow.fixture_id,
        fixtureVersionId: ownershipRow.fixture_version_id,
        kind: "regression_fixture_version",
      },
      schemaVersion: ownershipRow.schema_version,
      scope: {
        environmentId: ownershipRow.environment_id,
        projectId: ownershipRow.project_id,
        tenantId: ownershipRow.tenant_id,
      },
    });
    if (
      !parsed.success ||
      ownershipRow.artifact_position !== index ||
      ownershipRow.bound_at_matches !== true ||
      parsed.data.artifactId !== expected ||
      parsed.data.boundAt !== version.createdAt ||
      parsed.data.boundByPrincipalId !== version.createdByPrincipalId ||
      parsed.data.owner.fixtureId !== version.fixtureId ||
      parsed.data.owner.fixtureVersionId !== version.fixtureVersionId ||
      !scopesEqual(parsed.data.scope, version.scope)
    ) {
      contractViolation("Stored recorded interaction fixture ownership is non-canonical");
    }
    return parsed.data;
  });

  return {
    ownerships,
    rootDefinitionSha256: parsedRootDigest.data,
    rootVersionId: parsedRootVersionId.data,
    version,
  };
}

function reconstructDataset(
  row: DatasetVersionRow,
  members: readonly DatasetMemberRow[],
): StoredDatasetRecord {
  if (
    !Number.isInteger(row.fixture_version_count) ||
    row.fixture_version_count !== members.length ||
    row.created_at_matches !== true ||
    (row.description !== null && typeof row.description !== "string") ||
    (row.predecessor_dataset_version_id === null) !== (row.predecessor_definition_sha256 === null)
  ) {
    contractViolation("Stored regression dataset version header is invalid");
  }

  const fixtureVersions: RegressionFixtureVersionReference[] = [];
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    if (
      !member ||
      member.tenant_id !== row.tenant_id ||
      member.project_id !== row.project_id ||
      member.environment_id !== row.environment_id ||
      member.dataset_id !== row.dataset_id ||
      member.dataset_version_id !== row.dataset_version_id ||
      member.fixture_version_count !== row.fixture_version_count ||
      member.member_position !== index
    ) {
      contractViolation("Stored regression dataset membership is invalid");
    }
    fixtureVersions.push({
      definitionSha256: member.fixture_definition_sha256,
      fixtureId: member.fixture_id,
      fixtureVersionId: member.fixture_version_id,
    });
  }

  const parsedRootVersionId = OpaqueIdSchema.safeParse(row.root_dataset_version_id);
  const parsedRootDigest = Sha256Schema.safeParse(row.root_definition_sha256);
  if (!parsedRootVersionId.success || !parsedRootDigest.success) {
    contractViolation("Stored regression dataset root binding is invalid");
  }

  const hasPredecessor = row.predecessor_dataset_version_id !== null;
  if (
    (hasPredecessor && row.dataset_version_id === row.root_dataset_version_id) ||
    (!hasPredecessor &&
      (row.dataset_version_id !== row.root_dataset_version_id ||
        row.definition_sha256 !== row.root_definition_sha256))
  ) {
    contractViolation("Stored regression dataset root lineage is invalid");
  }

  const input = {
    createdAt: row.created_at_lexical,
    createdByPrincipalId: row.created_by_principal_id,
    datasetId: row.dataset_id,
    datasetVersionId: row.dataset_version_id,
    definitionSha256: row.definition_sha256,
    ...(row.description === null ? {} : { description: row.description }),
    fixtureVersions,
    name: row.name,
    ...(row.predecessor_dataset_version_id === null
      ? {}
      : {
          predecessor: {
            datasetVersionId: row.predecessor_dataset_version_id,
            definitionSha256: row.predecessor_definition_sha256,
          },
        }),
    schemaVersion: row.schema_version,
    scope: {
      environmentId: row.environment_id,
      projectId: row.project_id,
      tenantId: row.tenant_id,
    },
  };

  try {
    return {
      rootDefinitionSha256: parsedRootDigest.data,
      rootVersionId: parsedRootVersionId.data,
      version: validateAndProjectRegressionDatasetVersion(input).version,
    };
  } catch (cause) {
    contractViolation("Stored regression dataset version violates the canonical contract", cause);
  }
}

async function loadFixtureVersions(
  client: PoolClient,
  tenantId: string,
  versionIds: readonly string[],
): Promise<Map<string, StoredFixtureRecord>> {
  if (versionIds.length === 0) return new Map();
  const uniqueIds = [...new Set(versionIds)];
  const headers = await client.query<FixtureVersionRow>(SELECT_FIXTURE_VERSIONS_SQL, [
    tenantId,
    uniqueIds,
  ]);
  const headerIds = headers.rows.map(({ fixture_version_id }) => fixture_version_id);
  const events =
    headerIds.length === 0
      ? { rows: [] as FixtureEventRow[] }
      : await client.query<FixtureEventRow>(SELECT_FIXTURE_EVENTS_SQL, [tenantId, headerIds]);

  const eventsByVersion = new Map<string, FixtureEventRow[]>();
  for (const event of events.rows) {
    if (typeof event.fixture_version_id !== "string") {
      contractViolation("Stored regression fixture event has an invalid parent identifier");
    }
    const grouped = eventsByVersion.get(event.fixture_version_id) ?? [];
    grouped.push(event);
    eventsByVersion.set(event.fixture_version_id, grouped);
  }

  const records = new Map<string, StoredFixtureRecord>();
  for (const row of headers.rows) {
    if (
      typeof row.fixture_version_id !== "string" ||
      !uniqueIds.includes(row.fixture_version_id) ||
      records.has(row.fixture_version_id)
    ) {
      contractViolation("PostgreSQL returned an unexpected regression fixture version row");
    }
    records.set(
      row.fixture_version_id,
      reconstructFixture(row, eventsByVersion.get(row.fixture_version_id) ?? []),
    );
    eventsByVersion.delete(row.fixture_version_id);
  }
  if (eventsByVersion.size > 0) {
    contractViolation("PostgreSQL returned orphan regression fixture event rows");
  }
  return records;
}

async function loadRecordedFixtureVersions(
  client: PoolClient,
  tenantId: string,
  versionIds: readonly string[],
): Promise<Map<string, StoredRecordedFixtureRecord>> {
  if (versionIds.length === 0) return new Map();
  const uniqueIds = [...new Set(versionIds)];
  const headers = await client.query<FixtureVersionRow>(SELECT_RECORDED_FIXTURE_HEADERS_SQL, [
    tenantId,
    uniqueIds,
  ]);
  const headerIds = headers.rows.map(({ fixture_version_id }) => fixture_version_id);
  if (headerIds.length === 0) return new Map();
  const [events, manifests, ownerships] = await Promise.all([
    client.query<FixtureEventRow>(SELECT_FIXTURE_EVENTS_SQL, [tenantId, headerIds]),
    client.query<RecordedFixtureManifestRow>(SELECT_RECORDED_FIXTURE_MANIFESTS_SQL, [
      tenantId,
      headerIds,
    ]),
    client.query<ArtifactOwnershipRow>(SELECT_INTERACTION_OWNERSHIPS_SQL, [tenantId, headerIds]),
  ]);

  const eventsByVersion = new Map<string, FixtureEventRow[]>();
  for (const event of events.rows) {
    if (typeof event.fixture_version_id !== "string") {
      contractViolation("Stored recorded interaction fixture event has an invalid parent");
    }
    const grouped = eventsByVersion.get(event.fixture_version_id) ?? [];
    grouped.push(event);
    eventsByVersion.set(event.fixture_version_id, grouped);
  }

  const manifestsByVersion = new Map<string, RecordedFixtureManifestRow>();
  for (const manifest of manifests.rows) {
    if (
      typeof manifest.fixture_version_id !== "string" ||
      !headerIds.includes(manifest.fixture_version_id) ||
      manifestsByVersion.has(manifest.fixture_version_id)
    ) {
      contractViolation("PostgreSQL returned an unexpected interaction fixture manifest row");
    }
    manifestsByVersion.set(manifest.fixture_version_id, manifest);
  }

  const ownershipsByVersion = new Map<string, ArtifactOwnershipRow[]>();
  for (const ownership of ownerships.rows) {
    if (typeof ownership.fixture_version_id !== "string") {
      contractViolation("Stored interaction ownership has an invalid parent identifier");
    }
    const grouped = ownershipsByVersion.get(ownership.fixture_version_id) ?? [];
    grouped.push(ownership);
    ownershipsByVersion.set(ownership.fixture_version_id, grouped);
  }

  const records = new Map<string, StoredRecordedFixtureRecord>();
  for (const row of headers.rows) {
    const manifest = manifestsByVersion.get(row.fixture_version_id);
    if (
      typeof row.fixture_version_id !== "string" ||
      !uniqueIds.includes(row.fixture_version_id) ||
      records.has(row.fixture_version_id) ||
      !manifest
    ) {
      contractViolation("PostgreSQL returned an invalid recorded interaction fixture row set");
    }
    records.set(
      row.fixture_version_id,
      reconstructRecordedFixture(
        row,
        eventsByVersion.get(row.fixture_version_id) ?? [],
        manifest,
        ownershipsByVersion.get(row.fixture_version_id) ?? [],
      ),
    );
    eventsByVersion.delete(row.fixture_version_id);
    manifestsByVersion.delete(row.fixture_version_id);
    ownershipsByVersion.delete(row.fixture_version_id);
  }
  if (eventsByVersion.size > 0 || manifestsByVersion.size > 0 || ownershipsByVersion.size > 0) {
    contractViolation("PostgreSQL returned orphan recorded interaction fixture rows");
  }
  return records;
}

async function loadAnyFixtureVersions(
  client: PoolClient,
  tenantId: string,
  versionIds: readonly string[],
): Promise<Map<string, StoredAnyFixtureRecord>> {
  const [evidence, recorded] = await Promise.all([
    loadFixtureVersions(client, tenantId, versionIds),
    loadRecordedFixtureVersions(client, tenantId, versionIds),
  ]);
  const result = new Map<string, StoredAnyFixtureRecord>(evidence);
  for (const [versionId, value] of recorded) {
    if (result.has(versionId)) {
      contractViolation("A fixture version identifier exists in multiple storage families");
    }
    result.set(versionId, value);
  }
  return result;
}

async function loadFixtureVersionIdentities(
  client: PoolClient,
  tenantId: string,
  versionIds: readonly string[],
): Promise<Map<string, FixtureVersionIdentityRow>> {
  if (versionIds.length === 0) return new Map();
  const uniqueIds = [...new Set(versionIds)];
  const result = await client.query<FixtureVersionIdentityRow>(
    SELECT_FIXTURE_VERSION_IDENTITIES_SQL,
    [tenantId, uniqueIds],
  );
  const identities = new Map<string, FixtureVersionIdentityRow>();
  for (const row of result.rows) {
    if (
      typeof row.fixture_version_id !== "string" ||
      !uniqueIds.includes(row.fixture_version_id) ||
      identities.has(row.fixture_version_id)
    ) {
      contractViolation("PostgreSQL returned an unexpected regression fixture identity row");
    }
    identities.set(row.fixture_version_id, row);
  }
  return identities;
}

async function loadDatasetVersions(
  client: PoolClient,
  tenantId: string,
  versionIds: readonly string[],
): Promise<Map<string, StoredDatasetRecord>> {
  if (versionIds.length === 0) return new Map();
  const uniqueIds = [...new Set(versionIds)];
  const [headers, members] = await Promise.all([
    client.query<DatasetVersionRow>(SELECT_DATASET_VERSIONS_SQL, [tenantId, uniqueIds]),
    client.query<DatasetMemberRow>(SELECT_DATASET_MEMBERS_SQL, [tenantId, uniqueIds]),
  ]);

  const membersByVersion = new Map<string, DatasetMemberRow[]>();
  for (const member of members.rows) {
    if (typeof member.dataset_version_id !== "string") {
      contractViolation("Stored regression dataset member has an invalid parent identifier");
    }
    const grouped = membersByVersion.get(member.dataset_version_id) ?? [];
    grouped.push(member);
    membersByVersion.set(member.dataset_version_id, grouped);
  }

  const records = new Map<string, StoredDatasetRecord>();
  for (const row of headers.rows) {
    if (
      typeof row.dataset_version_id !== "string" ||
      !uniqueIds.includes(row.dataset_version_id) ||
      records.has(row.dataset_version_id)
    ) {
      contractViolation("PostgreSQL returned an unexpected regression dataset version row");
    }
    records.set(
      row.dataset_version_id,
      reconstructDataset(row, membersByVersion.get(row.dataset_version_id) ?? []),
    );
    membersByVersion.delete(row.dataset_version_id);
  }
  if (membersByVersion.size > 0) {
    contractViolation("PostgreSQL returned orphan regression dataset member rows");
  }
  return records;
}

async function loadDatasetVersionIdentities(
  client: PoolClient,
  tenantId: string,
  versionIds: readonly string[],
): Promise<Map<string, DatasetVersionIdentityRow>> {
  if (versionIds.length === 0) return new Map();
  const uniqueIds = [...new Set(versionIds)];
  const result = await client.query<DatasetVersionIdentityRow>(
    SELECT_DATASET_VERSION_IDENTITIES_SQL,
    [tenantId, uniqueIds],
  );
  const identities = new Map<string, DatasetVersionIdentityRow>();
  for (const row of result.rows) {
    if (
      typeof row.dataset_version_id !== "string" ||
      !uniqueIds.includes(row.dataset_version_id) ||
      identities.has(row.dataset_version_id)
    ) {
      contractViolation("PostgreSQL returned an unexpected regression dataset identity row");
    }
    identities.set(row.dataset_version_id, row);
  }
  return identities;
}

async function loadFixtureBinding(
  client: PoolClient,
  tenantId: string,
  fixtureId: string,
): Promise<ResourceBinding | null> {
  const result = await client.query<FixtureResourceRow>(SELECT_FIXTURE_RESOURCE_SQL, [
    tenantId,
    fixtureId,
  ]);
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1 || !result.rows[0]) {
    contractViolation("PostgreSQL returned duplicate regression fixture resources");
  }
  return requireFixtureBinding(result.rows[0], tenantId, fixtureId);
}

async function loadDatasetBinding(
  client: PoolClient,
  tenantId: string,
  datasetId: string,
): Promise<ResourceBinding | null> {
  const result = await client.query<DatasetResourceRow>(SELECT_DATASET_RESOURCE_SQL, [
    tenantId,
    datasetId,
  ]);
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1 || !result.rows[0]) {
    contractViolation("PostgreSQL returned duplicate regression dataset resources");
  }
  return requireDatasetBinding(result.rows[0], tenantId, datasetId);
}

function publicationIntentValues(intent: RegressionVersionPublishedOutboxIntent): unknown[] {
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

function requirePublicationIntentStatus(
  rows: readonly PublicationIntentStatusRow[],
): PublicationIntentStatus {
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    (row.status !== "absent" && row.status !== "canonical" && row.status !== "conflict")
  ) {
    contractViolation("PostgreSQL returned an invalid regression publication intent status");
  }
  return row.status;
}

async function requireCanonicalPublicationIntent(
  client: PoolClient,
  expected: RegressionVersionPublishedOutboxIntent,
): Promise<void> {
  const result = await client.query<PublicationIntentStatusRow>(
    PUBLICATION_INTENT_STATUS_SQL,
    publicationIntentValues(expected),
  );
  if (requirePublicationIntentStatus(result.rows) !== "canonical") {
    contractViolation("Stored regression version is missing its canonical publication intent");
  }
}

async function requirePublicationIntentAbsent(
  client: PoolClient,
  expected: RegressionVersionPublishedOutboxIntent,
): Promise<void> {
  const result = await client.query<PublicationIntentStatusRow>(
    PUBLICATION_INTENT_STATUS_SQL,
    publicationIntentValues(expected),
  );
  if (requirePublicationIntentStatus(result.rows) !== "absent") {
    contractViolation("A publication intent exists without its immutable regression version");
  }
}

async function insertPublicationIntent(
  client: PoolClient,
  intent: RegressionVersionPublishedOutboxIntent,
): Promise<void> {
  await client.query(INSERT_PUBLICATION_INTENT_SQL, publicationIntentValues(intent));
}

async function acquirePublicationLocks(client: PoolClient, keys: readonly string[]): Promise<void> {
  // Every publisher takes the resource and target locks in the same bytewise order. Hash
  // collisions can only add serialization; they cannot reverse the lock order or weaken safety.
  const ordered = [...new Set(keys)].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  for (const key of ordered) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
  }
}

function fixtureLockKeys(version: RegressionFixtureVersion): readonly string[] {
  const prefix = `proofstack:regression:${version.scope.tenantId}`;
  return [
    `${prefix}:fixture-resource:${version.fixtureId}`,
    `${prefix}:fixture-version:${version.fixtureVersionId}`,
  ];
}

function datasetLockKeys(version: RegressionDatasetVersion): readonly string[] {
  const prefix = `proofstack:regression:${version.scope.tenantId}`;
  return [
    `${prefix}:dataset-resource:${version.datasetId}`,
    `${prefix}:dataset-version:${version.datasetVersionId}`,
  ];
}

function recordedFixtureLockKeys(version: RecordedInteractionFixtureVersion): readonly string[] {
  const prefix = `proofstack:regression:${version.scope.tenantId}`;
  return [
    `${prefix}:fixture-resource:${version.fixtureId}`,
    `${prefix}:fixture-version:${version.fixtureVersionId}`,
    ...version.interactionCapture.artifacts.map(
      ({ contentReference }) => `${prefix}:artifact:${contentReference.artifactId}`,
    ),
  ];
}

function revocationLockKeys(
  candidate: RevokeInteractionFixtureContentCandidate,
  ownerships: readonly ArtifactOwnership[],
): readonly string[] {
  const { revocation, tombstones } = candidate;
  const prefix = `proofstack:regression:${revocation.scope.tenantId}`;
  return [
    `${prefix}:fixture-version:${revocation.fixtureVersionId}`,
    `${prefix}:revocation-id:${revocation.revocationId}`,
    ...ownerships.map(({ artifactId }) => `${prefix}:artifact:${artifactId}`),
    ...tombstones.map(({ tombstoneId }) => `${prefix}:tombstone-id:${tombstoneId}`),
  ];
}

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function requireBindingMatchesStoredFixture(
  binding: ResourceBinding | null,
  stored: StoredFixtureRecord,
): void {
  if (
    !binding ||
    !scopesEqual(binding.scope, stored.version.scope) ||
    binding.rootVersionId !== stored.rootVersionId ||
    binding.rootDefinitionSha256 !== stored.rootDefinitionSha256
  ) {
    contractViolation("Stored regression fixture version is detached from its logical resource");
  }
}

function requireBindingMatchesStoredRecordedFixture(
  binding: ResourceBinding | null,
  stored: StoredRecordedFixtureRecord,
): void {
  if (
    !binding ||
    !scopesEqual(binding.scope, stored.version.scope) ||
    binding.rootVersionId !== stored.rootVersionId ||
    binding.rootDefinitionSha256 !== stored.rootDefinitionSha256
  ) {
    contractViolation("Stored recorded interaction fixture is detached from its logical resource");
  }
}

function requireBindingMatchesStoredDataset(
  binding: ResourceBinding | null,
  stored: StoredDatasetRecord,
): void {
  if (
    !binding ||
    !scopesEqual(binding.scope, stored.version.scope) ||
    binding.rootVersionId !== stored.rootVersionId ||
    binding.rootDefinitionSha256 !== stored.rootDefinitionSha256
  ) {
    contractViolation("Stored regression dataset version is detached from its logical resource");
  }
}

async function insertFixtureVersion(
  client: PoolClient,
  version: RegressionFixtureVersion | RecordedInteractionFixtureVersion,
  binding: ResourceBinding,
  createResource: boolean,
): Promise<void> {
  if (createResource) {
    await client.query(INSERT_FIXTURE_RESOURCE_SQL, [
      version.scope.tenantId,
      version.scope.projectId,
      version.scope.environmentId,
      version.fixtureId,
      binding.rootVersionId,
      binding.rootDefinitionSha256,
    ]);
  }
  await client.query(INSERT_FIXTURE_VERSION_SQL, [
    version.scope.tenantId,
    version.scope.projectId,
    version.scope.environmentId,
    version.fixtureId,
    binding.rootVersionId,
    binding.rootDefinitionSha256,
    version.fixtureVersionId,
    version.schemaVersion,
    version.name,
    version.description ?? null,
    version.predecessor?.fixtureVersionId ?? null,
    version.predecessor?.definitionSha256 ?? null,
    version.replayability,
    version.source.kind,
    version.source.traceId,
    version.source.observedEventCount,
    version.source.sourceCompleteness,
    version.source.capturedAt,
    version.source.capturedAt,
    version.createdAt,
    version.createdAt,
    version.createdByPrincipalId,
    version.definitionSha256,
  ]);
  await client.query(INSERT_FIXTURE_EVENTS_SQL, [
    version.scope.tenantId,
    version.scope.projectId,
    version.scope.environmentId,
    version.fixtureId,
    version.fixtureVersionId,
    version.source.traceId,
    version.source.observedEventCount,
    version.source.eventIds.map((_eventId, index) => index),
    [...version.source.eventIds],
  ]);
}

function expectedOwnerships(
  version: RecordedInteractionFixtureVersion,
): readonly ArtifactOwnership[] {
  return version.interactionCapture.artifacts.map(({ contentReference }) =>
    ArtifactOwnershipSchema.parse({
      artifactId: contentReference.artifactId,
      boundAt: version.createdAt,
      boundByPrincipalId: version.createdByPrincipalId,
      owner: {
        fixtureId: version.fixtureId,
        fixtureVersionId: version.fixtureVersionId,
        kind: "regression_fixture_version",
      },
      schemaVersion: "0.1",
      scope: version.scope,
    }),
  );
}

async function ownershipsForRecordedPublication(
  client: PoolClient,
  version: RecordedInteractionFixtureVersion,
): Promise<readonly ArtifactOwnership[]> {
  const artifactIds = version.interactionCapture.artifacts.map(
    ({ contentReference }) => contentReference.artifactId,
  );
  const artifacts = await client.query<ArtifactBindingRow>(
    `
      SELECT
        tenant_id,
        project_id,
        environment_id,
        artifact_id,
        state,
        classification,
        media_type,
        content_sha256,
        content_size_bytes,
        redaction,
        retention_mode
      FROM public.proofstack_artifact_catalog
      WHERE tenant_id = $1 AND artifact_id = ANY($2::varchar[])
      ORDER BY artifact_id COLLATE "C"
      FOR UPDATE
    `,
    [version.scope.tenantId, artifactIds],
  );
  const byId = new Map<string, ArtifactBindingRow>();
  for (const artifact of artifacts.rows) {
    if (!artifactIds.includes(artifact.artifact_id) || byId.has(artifact.artifact_id)) {
      contractViolation("PostgreSQL returned an unexpected interaction artifact row");
    }
    byId.set(artifact.artifact_id, artifact);
  }

  const existingOwnerships = await client.query<{ readonly artifact_id: string }>(
    `
      SELECT artifact_id
      FROM public.proofstack_interaction_fixture_artifact_ownerships
      WHERE tenant_id = $1 AND artifact_id = ANY($2::varchar[])
    `,
    [version.scope.tenantId, artifactIds],
  );
  if (existingOwnerships.rows.length > 0) throw new RegressionArtifactBindingError();

  for (const binding of version.interactionCapture.artifacts) {
    const reference = binding.contentReference;
    const artifact = byId.get(reference.artifactId);
    if (
      !artifact ||
      artifact.tenant_id !== version.scope.tenantId ||
      artifact.project_id !== version.scope.projectId ||
      artifact.environment_id !== version.scope.environmentId ||
      artifact.state !== "available" ||
      artifact.retention_mode !== "retain" ||
      artifact.classification !== reference.classification ||
      artifact.media_type !== reference.mediaType ||
      artifact.content_sha256 !== reference.sha256 ||
      artifact.content_size_bytes !== reference.sizeBytes ||
      !isDeepStrictEqual(artifact.redaction, binding.redaction)
    ) {
      throw new RegressionArtifactBindingError();
    }
  }
  return expectedOwnerships(version);
}

async function insertRecordedFixtureVersion(
  client: PoolClient,
  version: RecordedInteractionFixtureVersion,
  binding: ResourceBinding,
  ownerships: readonly ArtifactOwnership[],
): Promise<void> {
  await insertFixtureVersion(client, version, binding, false);
  await client.query(INSERT_RECORDED_FIXTURE_MANIFEST_SQL, [
    version.scope.tenantId,
    version.scope.projectId,
    version.scope.environmentId,
    version.fixtureId,
    version.fixtureVersionId,
    JSON.stringify(version.interactionCapture),
  ]);
  await client.query(INSERT_INTERACTION_OWNERSHIPS_SQL, [
    version.scope.tenantId,
    version.scope.projectId,
    version.scope.environmentId,
    version.fixtureId,
    version.fixtureVersionId,
    version.createdAt,
    version.createdAt,
    version.createdByPrincipalId,
    ownerships.map(({ artifactId }) => artifactId),
    ownerships.map((_ownership, index) => index),
  ]);
}

async function insertDatasetVersion(
  client: PoolClient,
  version: RegressionDatasetVersion,
  binding: ResourceBinding,
  createResource: boolean,
): Promise<void> {
  if (createResource) {
    await client.query(INSERT_DATASET_RESOURCE_SQL, [
      version.scope.tenantId,
      version.scope.projectId,
      version.scope.environmentId,
      version.datasetId,
      binding.rootVersionId,
      binding.rootDefinitionSha256,
    ]);
  }
  await client.query(INSERT_DATASET_VERSION_SQL, [
    version.scope.tenantId,
    version.scope.projectId,
    version.scope.environmentId,
    version.datasetId,
    binding.rootVersionId,
    binding.rootDefinitionSha256,
    version.datasetVersionId,
    version.schemaVersion,
    version.name,
    version.description ?? null,
    version.predecessor?.datasetVersionId ?? null,
    version.predecessor?.definitionSha256 ?? null,
    version.fixtureVersions.length,
    version.createdAt,
    version.createdAt,
    version.createdByPrincipalId,
    version.definitionSha256,
  ]);
  await client.query(INSERT_DATASET_MEMBERS_SQL, [
    version.scope.tenantId,
    version.scope.projectId,
    version.scope.environmentId,
    version.datasetId,
    version.datasetVersionId,
    version.fixtureVersions.length,
    version.fixtureVersions.map((_reference, index) => index),
    version.fixtureVersions.map(({ fixtureId }) => fixtureId),
    version.fixtureVersions.map(({ fixtureVersionId }) => fixtureVersionId),
    version.fixtureVersions.map(({ definitionSha256 }) => definitionSha256),
  ]);
}

async function loadInteractionFixtureRevocation(
  client: PoolClient,
  stored: StoredRecordedFixtureRecord,
): Promise<InteractionFixtureContentRevocation | null> {
  const result = await client.query<FixtureRevocationRow>(
    `
      SELECT
        tenant_id,
        project_id,
        environment_id,
        fixture_id,
        fixture_version_id,
        revocation_id,
        schema_version,
        reason,
        revoked_at_lexical,
        revoked_at = revoked_at_lexical::timestamptz AS revoked_at_matches,
        revoked_by_principal_id
      FROM public.proofstack_interaction_fixture_content_revocations
      WHERE tenant_id = $1 AND fixture_version_id = $2
    `,
    [stored.version.scope.tenantId, stored.version.fixtureVersionId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row || row.revoked_at_matches !== true) {
    contractViolation("Stored interaction fixture revocation row is invalid");
  }
  const parsed = InteractionFixtureContentRevocationSchema.safeParse({
    fixtureId: row.fixture_id,
    fixtureVersionId: row.fixture_version_id,
    reason: row.reason,
    revocationId: row.revocation_id,
    revokedAt: row.revoked_at_lexical,
    revokedByPrincipalId: row.revoked_by_principal_id,
    schemaVersion: row.schema_version,
    scope: {
      environmentId: row.environment_id,
      projectId: row.project_id,
      tenantId: row.tenant_id,
    },
  });
  if (
    !parsed.success ||
    parsed.data.fixtureId !== stored.version.fixtureId ||
    parsed.data.fixtureVersionId !== stored.version.fixtureVersionId ||
    !scopesEqual(parsed.data.scope, stored.version.scope)
  ) {
    contractViolation("Stored interaction fixture revocation violates the canonical contract");
  }
  return parsed.data;
}

async function loadInteractionArtifactAvailability(
  client: PoolClient,
  stored: StoredRecordedFixtureRecord,
): Promise<Map<string, ArtifactAvailabilityRow>> {
  const artifactIds = stored.ownerships.map(({ artifactId }) => artifactId);
  const result = await client.query<ArtifactAvailabilityRow>(
    `
      SELECT
        artifact_id,
        state,
        to_char(
          tombstoned_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS tombstoned_at_lexical
      FROM public.proofstack_artifact_catalog
      WHERE tenant_id = $1 AND artifact_id = ANY($2::varchar[])
    `,
    [stored.version.scope.tenantId, artifactIds],
  );
  const availability = new Map<string, ArtifactAvailabilityRow>();
  for (const row of result.rows) {
    if (!artifactIds.includes(row.artifact_id) || availability.has(row.artifact_id)) {
      contractViolation("PostgreSQL returned an unexpected interaction artifact state row");
    }
    availability.set(row.artifact_id, row);
  }
  if (availability.size !== artifactIds.length) {
    contractViolation("Stored interaction fixture ownership references a missing artifact");
  }
  return availability;
}

async function loadInteractionFixtureTombstones(
  client: PoolClient,
  stored: StoredRecordedFixtureRecord,
): Promise<Map<string, ArtifactTombstone>> {
  const artifactIds = stored.ownerships.map(({ artifactId }) => artifactId);
  const result = await client.query<FixtureTombstoneRow>(
    `
      SELECT
        artifact_id,
        tombstone_id,
        actor_principal_id,
        tombstone_trigger,
        reason,
        to_char(
          occurred_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS occurred_at_lexical
      FROM public.proofstack_artifact_tombstones
      WHERE tenant_id = $1 AND artifact_id = ANY($2::varchar[])
    `,
    [stored.version.scope.tenantId, artifactIds],
  );
  const tombstones = new Map<string, ArtifactTombstone>();
  for (const row of result.rows) {
    const parsed = ArtifactTombstoneSchema.safeParse({
      actorPrincipalId: row.actor_principal_id,
      artifactId: row.artifact_id,
      occurredAt: row.occurred_at_lexical,
      reason: row.reason,
      tombstoneId: row.tombstone_id,
      trigger: row.tombstone_trigger,
    });
    if (
      !parsed.success ||
      !artifactIds.includes(parsed.data.artifactId) ||
      tombstones.has(parsed.data.artifactId)
    ) {
      contractViolation("Stored interaction fixture tombstone row is invalid");
    }
    tombstones.set(parsed.data.artifactId, parsed.data);
  }
  return tombstones;
}

async function storedInteractionFixtureContent(
  client: PoolClient,
  stored: StoredRecordedFixtureRecord,
): Promise<StoredInteractionFixtureContent> {
  const [revocation, availability, tombstonesByArtifact] = await Promise.all([
    loadInteractionFixtureRevocation(client, stored),
    loadInteractionArtifactAvailability(client, stored),
    loadInteractionFixtureTombstones(client, stored),
  ]);
  if (!revocation) {
    if (tombstonesByArtifact.size > 0) {
      contractViolation("Fixture-owned content was tombstoned without an immutable revocation");
    }
    const available = stored.ownerships.every(
      ({ artifactId }) => availability.get(artifactId)?.state === "available",
    );
    return {
      contentAvailability: available ? "available" : "unavailable",
      ownerships: clone(stored.ownerships),
      revocation: null,
      tombstones: [],
      version: clone(stored.version),
    };
  }

  const tombstones = stored.ownerships.map(({ artifactId }) => {
    const tombstone = tombstonesByArtifact.get(artifactId);
    const state = availability.get(artifactId);
    if (
      !tombstone ||
      tombstone.actorPrincipalId !== revocation.revokedByPrincipalId ||
      tombstone.occurredAt !== revocation.revokedAt ||
      tombstone.reason !== revocation.reason ||
      tombstone.trigger !== "fixture_revocation" ||
      !state ||
      (state.state !== "tombstoned" && state.state !== "purged") ||
      state.tombstoned_at_lexical !== revocation.revokedAt
    ) {
      contractViolation("Stored interaction fixture revocation is not fully materialized");
    }
    return tombstone;
  });
  if (tombstonesByArtifact.size !== tombstones.length) {
    contractViolation("Stored interaction fixture has an unexpected revocation tombstone");
  }
  return {
    contentAvailability: "revoked",
    ownerships: clone(stored.ownerships),
    revocation: clone(revocation),
    tombstones: clone(tombstones),
    version: clone(stored.version),
  };
}

/** PostgreSQL authority for immutable, tenant-isolated regression fixture and dataset versions. */
export class PostgresRegressionVersionRepository implements InteractionFixtureVersionRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async datasetResourceExists(scopeInput: EvidenceScope, datasetIdInput: string): Promise<boolean> {
    const scope = requireScope(scopeInput);
    const datasetId = requireOpaqueId(datasetIdInput);
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const result = await client.query<PresenceRow>(
        `SELECT EXISTS (
          SELECT 1 FROM public.proofstack_regression_datasets
          WHERE tenant_id = $1 AND project_id = $2 AND environment_id = $3 AND dataset_id = $4
        ) AS present`,
        [scope.tenantId, scope.projectId, scope.environmentId, datasetId],
      );
      return requirePresence(result.rows, "regression dataset resource");
    });
  }

  async findDatasetVersion(
    scopeInput: EvidenceScope,
    datasetVersionIdInput: string,
  ): Promise<RegressionDatasetVersion | null> {
    const scope = requireScope(scopeInput);
    const datasetVersionId = requireOpaqueId(datasetVersionIdInput);
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const identity = (
        await loadDatasetVersionIdentities(client, scope.tenantId, [datasetVersionId])
      ).get(datasetVersionId);
      if (
        !identity ||
        identity.tenant_id !== scope.tenantId ||
        identity.project_id !== scope.projectId ||
        identity.environment_id !== scope.environmentId
      ) {
        return null;
      }
      const stored = (await loadDatasetVersions(client, scope.tenantId, [datasetVersionId])).get(
        datasetVersionId,
      );
      if (!stored || !scopesEqual(stored.version.scope, scope)) return null;
      return clone(stored.version);
    });
  }

  async findFixtureVersion(
    scopeInput: EvidenceScope,
    fixtureVersionIdInput: string,
  ): Promise<RegressionFixtureVersion | null> {
    const scope = requireScope(scopeInput);
    const fixtureVersionId = requireOpaqueId(fixtureVersionIdInput);
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const identity = (
        await loadFixtureVersionIdentities(client, scope.tenantId, [fixtureVersionId])
      ).get(fixtureVersionId);
      if (
        !identity ||
        identity.tenant_id !== scope.tenantId ||
        identity.project_id !== scope.projectId ||
        identity.environment_id !== scope.environmentId
      ) {
        return null;
      }
      const stored = (await loadFixtureVersions(client, scope.tenantId, [fixtureVersionId])).get(
        fixtureVersionId,
      );
      if (!stored || !scopesEqual(stored.version.scope, scope)) return null;
      return clone(stored.version);
    });
  }

  async findRecordedInteractionFixtureVersion(
    scopeInput: EvidenceScope,
    fixtureVersionIdInput: string,
  ): Promise<StoredRecordedInteractionFixtureVersion | null> {
    const scope = requireScope(scopeInput);
    const fixtureVersionId = requireOpaqueId(fixtureVersionIdInput);
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const identity = (
        await loadFixtureVersionIdentities(client, scope.tenantId, [fixtureVersionId])
      ).get(fixtureVersionId);
      if (
        !identity ||
        identity.tenant_id !== scope.tenantId ||
        identity.project_id !== scope.projectId ||
        identity.environment_id !== scope.environmentId
      ) {
        return null;
      }
      const stored = (
        await loadRecordedFixtureVersions(client, scope.tenantId, [fixtureVersionId])
      ).get(fixtureVersionId);
      if (!stored || !scopesEqual(stored.version.scope, scope)) return null;
      requireBindingMatchesStoredRecordedFixture(
        await loadFixtureBinding(client, scope.tenantId, stored.version.fixtureId),
        stored,
      );
      await requireCanonicalPublicationIntent(
        client,
        buildRecordedInteractionFixtureVersionPublishedOutboxIntent(stored.version),
      );
      return { ownerships: clone(stored.ownerships), version: clone(stored.version) };
    });
  }

  async findRecordedInteractionFixtureContent(
    scopeInput: EvidenceScope,
    fixtureVersionIdInput: string,
  ): Promise<StoredInteractionFixtureContent | null> {
    const scope = requireScope(scopeInput);
    const fixtureVersionId = requireOpaqueId(fixtureVersionIdInput);
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const identity = (
        await loadFixtureVersionIdentities(client, scope.tenantId, [fixtureVersionId])
      ).get(fixtureVersionId);
      if (
        !identity ||
        identity.tenant_id !== scope.tenantId ||
        identity.project_id !== scope.projectId ||
        identity.environment_id !== scope.environmentId
      ) {
        return null;
      }
      const stored = (
        await loadRecordedFixtureVersions(client, scope.tenantId, [fixtureVersionId])
      ).get(fixtureVersionId);
      if (!stored || !scopesEqual(stored.version.scope, scope)) return null;
      requireBindingMatchesStoredRecordedFixture(
        await loadFixtureBinding(client, scope.tenantId, stored.version.fixtureId),
        stored,
      );
      await requireCanonicalPublicationIntent(
        client,
        buildRecordedInteractionFixtureVersionPublishedOutboxIntent(stored.version),
      );
      return storedInteractionFixtureContent(client, stored);
    });
  }

  async fixtureResourceExists(scopeInput: EvidenceScope, fixtureIdInput: string): Promise<boolean> {
    const scope = requireScope(scopeInput);
    const fixtureId = requireOpaqueId(fixtureIdInput);
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const result = await client.query<PresenceRow>(
        `SELECT EXISTS (
          SELECT 1 FROM public.proofstack_regression_fixtures
          WHERE tenant_id = $1 AND project_id = $2 AND environment_id = $3 AND fixture_id = $4
        ) AS present`,
        [scope.tenantId, scope.projectId, scope.environmentId, fixtureId],
      );
      return requirePresence(result.rows, "regression fixture resource");
    });
  }

  async publishDatasetVersion(
    candidate: RegressionDatasetVersion,
  ): Promise<PublishRegressionVersionResult<RegressionDatasetVersion>> {
    const validated = validateAndProjectRegressionDatasetVersion(candidate);
    const version = validated.version;
    return withTenantTransaction(this.pool, version.scope.tenantId, async (client) => {
      await acquirePublicationLocks(client, datasetLockKeys(version));
      const existingIdentity = (
        await loadDatasetVersionIdentities(client, version.scope.tenantId, [
          version.datasetVersionId,
        ])
      ).get(version.datasetVersionId);
      if (
        existingIdentity &&
        (existingIdentity.tenant_id !== version.scope.tenantId ||
          existingIdentity.project_id !== version.scope.projectId ||
          existingIdentity.environment_id !== version.scope.environmentId ||
          existingIdentity.dataset_id !== version.datasetId)
      ) {
        throw new RegressionVersionConflictError();
      }
      const existing = (
        await loadDatasetVersions(client, version.scope.tenantId, [version.datasetVersionId])
      ).get(version.datasetVersionId);
      if (existing) {
        const storedDefinition = validateAndProjectRegressionDatasetVersion(
          existing.version,
        ).definition;
        if (!areRegressionDatasetVersionDefinitionsEqual(storedDefinition, validated.definition)) {
          throw new RegressionVersionConflictError();
        }
        requireBindingMatchesStoredDataset(
          await loadDatasetBinding(client, version.scope.tenantId, existing.version.datasetId),
          existing,
        );
        await requireCanonicalPublicationIntent(
          client,
          buildRegressionDatasetVersionPublishedOutboxIntent(existing.version),
        );
        return { created: false, version: clone(existing.version) };
      }

      const intent = buildRegressionDatasetVersionPublishedOutboxIntent(version);
      await requirePublicationIntentAbsent(client, intent);
      const currentBinding = await loadDatasetBinding(
        client,
        version.scope.tenantId,
        version.datasetId,
      );
      let binding: ResourceBinding;
      let createResource = false;
      if (!currentBinding) {
        if (version.predecessor) throw new RegressionVersionLineageError();
        binding = {
          rootDefinitionSha256: version.definitionSha256,
          rootVersionId: version.datasetVersionId,
          scope: clone(version.scope),
        };
        createResource = true;
      } else {
        if (!scopesEqual(currentBinding.scope, version.scope)) {
          throw new RegressionVersionConflictError();
        }
        if (!version.predecessor) throw new RegressionVersionLineageError();
        const predecessorIdentity = (
          await loadDatasetVersionIdentities(client, version.scope.tenantId, [
            version.predecessor.datasetVersionId,
          ])
        ).get(version.predecessor.datasetVersionId);
        if (
          !predecessorIdentity ||
          predecessorIdentity.tenant_id !== version.scope.tenantId ||
          predecessorIdentity.project_id !== version.scope.projectId ||
          predecessorIdentity.environment_id !== version.scope.environmentId ||
          predecessorIdentity.dataset_id !== version.datasetId
        ) {
          throw new RegressionVersionLineageError();
        }
        const predecessor = (
          await loadDatasetVersions(client, version.scope.tenantId, [
            version.predecessor.datasetVersionId,
          ])
        ).get(version.predecessor.datasetVersionId);
        if (
          !predecessor ||
          predecessor.version.datasetId !== version.datasetId ||
          !scopesEqual(predecessor.version.scope, version.scope) ||
          predecessor.version.definitionSha256 !== version.predecessor.definitionSha256 ||
          predecessor.rootVersionId !== currentBinding.rootVersionId ||
          predecessor.rootDefinitionSha256 !== currentBinding.rootDefinitionSha256
        ) {
          throw new RegressionVersionLineageError();
        }
        binding = currentBinding;
      }

      const fixtureIdentities = await loadFixtureVersionIdentities(
        client,
        version.scope.tenantId,
        version.fixtureVersions.map(({ fixtureVersionId }) => fixtureVersionId),
      );
      for (const reference of version.fixtureVersions) {
        const identity = fixtureIdentities.get(reference.fixtureVersionId);
        if (
          !identity ||
          identity.tenant_id !== version.scope.tenantId ||
          identity.project_id !== version.scope.projectId ||
          identity.environment_id !== version.scope.environmentId ||
          identity.fixture_id !== reference.fixtureId
        ) {
          throw new RegressionVersionConflictError();
        }
      }
      const fixtureRecords = await loadAnyFixtureVersions(
        client,
        version.scope.tenantId,
        version.fixtureVersions.map(({ fixtureVersionId }) => fixtureVersionId),
      );
      for (const reference of version.fixtureVersions) {
        const authoritative = fixtureRecords.get(reference.fixtureVersionId)?.version;
        if (
          !authoritative ||
          authoritative.fixtureId !== reference.fixtureId ||
          !scopesEqual(authoritative.scope, version.scope) ||
          authoritative.definitionSha256 !== reference.definitionSha256
        ) {
          throw new RegressionVersionConflictError();
        }
      }

      await insertDatasetVersion(client, version, binding, createResource);
      await insertPublicationIntent(client, intent);
      return { created: true, version: clone(version) };
    });
  }

  async publishFixtureVersion(
    candidate: RegressionFixtureVersion,
  ): Promise<PublishRegressionVersionResult<RegressionFixtureVersion>> {
    const validated = validateAndProjectRegressionFixtureVersion(candidate);
    const version = validated.version;
    return withTenantTransaction(this.pool, version.scope.tenantId, async (client) => {
      await acquirePublicationLocks(client, fixtureLockKeys(version));
      const existingIdentity = (
        await loadFixtureVersionIdentities(client, version.scope.tenantId, [
          version.fixtureVersionId,
        ])
      ).get(version.fixtureVersionId);
      if (
        existingIdentity &&
        (existingIdentity.tenant_id !== version.scope.tenantId ||
          existingIdentity.project_id !== version.scope.projectId ||
          existingIdentity.environment_id !== version.scope.environmentId ||
          existingIdentity.fixture_id !== version.fixtureId)
      ) {
        throw new RegressionVersionConflictError();
      }
      const existing = (
        await loadFixtureVersions(client, version.scope.tenantId, [version.fixtureVersionId])
      ).get(version.fixtureVersionId);
      if (existing) {
        const storedDefinition = validateAndProjectRegressionFixtureVersion(
          existing.version,
        ).definition;
        if (!areRegressionFixtureVersionDefinitionsEqual(storedDefinition, validated.definition)) {
          throw new RegressionVersionConflictError();
        }
        requireBindingMatchesStoredFixture(
          await loadFixtureBinding(client, version.scope.tenantId, existing.version.fixtureId),
          existing,
        );
        await requireCanonicalPublicationIntent(
          client,
          buildRegressionFixtureVersionPublishedOutboxIntent(existing.version),
        );
        return { created: false, version: clone(existing.version) };
      }
      if (existingIdentity) throw new RegressionVersionConflictError();

      const intent = buildRegressionFixtureVersionPublishedOutboxIntent(version);
      await requirePublicationIntentAbsent(client, intent);
      const currentBinding = await loadFixtureBinding(
        client,
        version.scope.tenantId,
        version.fixtureId,
      );
      let binding: ResourceBinding;
      let createResource = false;
      if (!currentBinding) {
        if (version.predecessor) throw new RegressionVersionLineageError();
        binding = {
          rootDefinitionSha256: version.definitionSha256,
          rootVersionId: version.fixtureVersionId,
          scope: clone(version.scope),
        };
        createResource = true;
      } else {
        if (!scopesEqual(currentBinding.scope, version.scope)) {
          throw new RegressionVersionConflictError();
        }
        if (!version.predecessor) throw new RegressionVersionLineageError();
        const predecessorIdentity = (
          await loadFixtureVersionIdentities(client, version.scope.tenantId, [
            version.predecessor.fixtureVersionId,
          ])
        ).get(version.predecessor.fixtureVersionId);
        if (
          !predecessorIdentity ||
          predecessorIdentity.tenant_id !== version.scope.tenantId ||
          predecessorIdentity.project_id !== version.scope.projectId ||
          predecessorIdentity.environment_id !== version.scope.environmentId ||
          predecessorIdentity.fixture_id !== version.fixtureId
        ) {
          throw new RegressionVersionLineageError();
        }
        const predecessor = (
          await loadFixtureVersions(client, version.scope.tenantId, [
            version.predecessor.fixtureVersionId,
          ])
        ).get(version.predecessor.fixtureVersionId);
        if (
          !predecessor ||
          predecessor.version.fixtureId !== version.fixtureId ||
          !scopesEqual(predecessor.version.scope, version.scope) ||
          predecessor.version.definitionSha256 !== version.predecessor.definitionSha256 ||
          predecessor.rootVersionId !== currentBinding.rootVersionId ||
          predecessor.rootDefinitionSha256 !== currentBinding.rootDefinitionSha256
        ) {
          throw new RegressionVersionLineageError();
        }
        binding = currentBinding;
      }

      await insertFixtureVersion(client, version, binding, createResource);
      await insertPublicationIntent(client, intent);
      return { created: true, version: clone(version) };
    });
  }

  async publishRecordedInteractionFixtureVersion(
    candidate: RecordedInteractionFixtureVersion,
  ): Promise<PublishRecordedInteractionFixtureVersionResult> {
    const validated = validateAndProjectRecordedInteractionFixtureVersion(candidate);
    const version = validated.version;
    return withTenantTransaction(this.pool, version.scope.tenantId, async (client) => {
      await acquirePublicationLocks(client, recordedFixtureLockKeys(version));
      const existingIdentity = (
        await loadFixtureVersionIdentities(client, version.scope.tenantId, [
          version.fixtureVersionId,
        ])
      ).get(version.fixtureVersionId);
      if (
        existingIdentity &&
        (existingIdentity.tenant_id !== version.scope.tenantId ||
          existingIdentity.project_id !== version.scope.projectId ||
          existingIdentity.environment_id !== version.scope.environmentId ||
          existingIdentity.fixture_id !== version.fixtureId)
      ) {
        throw new RegressionVersionConflictError();
      }
      const existing = (
        await loadRecordedFixtureVersions(client, version.scope.tenantId, [
          version.fixtureVersionId,
        ])
      ).get(version.fixtureVersionId);
      if (existing) {
        const storedDefinition = validateAndProjectRecordedInteractionFixtureVersion(
          existing.version,
        ).definition;
        if (
          !areRecordedInteractionFixtureVersionDefinitionsEqual(
            storedDefinition,
            validated.definition,
          )
        ) {
          throw new RegressionVersionConflictError();
        }
        requireBindingMatchesStoredRecordedFixture(
          await loadFixtureBinding(client, version.scope.tenantId, existing.version.fixtureId),
          existing,
        );
        await requireCanonicalPublicationIntent(
          client,
          buildRecordedInteractionFixtureVersionPublishedOutboxIntent(existing.version),
        );
        return {
          created: false,
          ownerships: clone(existing.ownerships),
          version: clone(existing.version),
        };
      }
      if (existingIdentity) throw new RegressionVersionConflictError();

      const intent = buildRecordedInteractionFixtureVersionPublishedOutboxIntent(version);
      await requirePublicationIntentAbsent(client, intent);
      const binding = await loadFixtureBinding(client, version.scope.tenantId, version.fixtureId);
      if (!binding) throw new RegressionVersionLineageError();
      if (!scopesEqual(binding.scope, version.scope)) {
        throw new RegressionVersionConflictError();
      }
      const predecessorIdentity = (
        await loadFixtureVersionIdentities(client, version.scope.tenantId, [
          version.predecessor.fixtureVersionId,
        ])
      ).get(version.predecessor.fixtureVersionId);
      if (
        !predecessorIdentity ||
        predecessorIdentity.tenant_id !== version.scope.tenantId ||
        predecessorIdentity.project_id !== version.scope.projectId ||
        predecessorIdentity.environment_id !== version.scope.environmentId ||
        predecessorIdentity.fixture_id !== version.fixtureId
      ) {
        throw new RegressionVersionLineageError();
      }
      const predecessor = (
        await loadFixtureVersions(client, version.scope.tenantId, [
          version.predecessor.fixtureVersionId,
        ])
      ).get(version.predecessor.fixtureVersionId);
      if (
        !predecessor ||
        predecessor.version.fixtureId !== version.fixtureId ||
        !scopesEqual(predecessor.version.scope, version.scope) ||
        predecessor.version.definitionSha256 !== version.predecessor.definitionSha256 ||
        !isDeepStrictEqual(predecessor.version.source, version.source) ||
        predecessor.rootVersionId !== binding.rootVersionId ||
        predecessor.rootDefinitionSha256 !== binding.rootDefinitionSha256
      ) {
        throw new RegressionVersionLineageError();
      }

      const ownerships = await ownershipsForRecordedPublication(client, version);
      await insertRecordedFixtureVersion(client, version, binding, ownerships);
      await insertPublicationIntent(client, intent);
      return {
        created: true,
        ownerships: clone(ownerships),
        version: clone(version),
      };
    });
  }

  async revokeRecordedInteractionFixtureContent(
    candidateInput: RevokeInteractionFixtureContentCandidate,
  ): Promise<RevokeInteractionFixtureContentResult> {
    const revocation = InteractionFixtureContentRevocationSchema.parse(candidateInput.revocation);
    const tombstones = candidateInput.tombstones.map((value) =>
      ArtifactTombstoneSchema.parse(value),
    );
    if (
      new Set(tombstones.map(({ artifactId }) => artifactId)).size !== tombstones.length ||
      new Set(tombstones.map(({ tombstoneId }) => tombstoneId)).size !== tombstones.length
    ) {
      throw new RegressionRepositoryContractError(
        "Interaction fixture revocation tombstones must have unique artifact and tombstone IDs",
      );
    }
    const candidate = { revocation, tombstones } as const;

    return withTenantTransaction(this.pool, revocation.scope.tenantId, async (client) => {
      const initial = (
        await loadRecordedFixtureVersions(client, revocation.scope.tenantId, [
          revocation.fixtureVersionId,
        ])
      ).get(revocation.fixtureVersionId);
      if (
        !initial ||
        initial.version.fixtureId !== revocation.fixtureId ||
        !scopesEqual(initial.version.scope, revocation.scope)
      ) {
        throw new RegressionVersionNotFoundError();
      }
      await acquirePublicationLocks(client, revocationLockKeys(candidate, initial.ownerships));

      const stored = (
        await loadRecordedFixtureVersions(client, revocation.scope.tenantId, [
          revocation.fixtureVersionId,
        ])
      ).get(revocation.fixtureVersionId);
      if (
        !stored ||
        stored.version.fixtureId !== revocation.fixtureId ||
        !scopesEqual(stored.version.scope, revocation.scope)
      ) {
        throw new RegressionVersionNotFoundError();
      }
      requireBindingMatchesStoredRecordedFixture(
        await loadFixtureBinding(client, revocation.scope.tenantId, stored.version.fixtureId),
        stored,
      );
      await requireCanonicalPublicationIntent(
        client,
        buildRecordedInteractionFixtureVersionPublishedOutboxIntent(stored.version),
      );

      const existingRevocation = await loadInteractionFixtureRevocation(client, stored);
      if (existingRevocation) {
        if (existingRevocation.reason !== revocation.reason) {
          throw new RegressionFixtureContentRevocationConflictError();
        }
        return {
          created: false,
          ...(await storedInteractionFixtureContent(client, stored)),
        };
      }

      if (tombstones.length !== stored.ownerships.length) {
        throw new RegressionRepositoryContractError(
          "Interaction fixture revocation tombstone set is incomplete",
        );
      }
      for (const [index, tombstone] of tombstones.entries()) {
        const ownership = stored.ownerships[index];
        if (
          !ownership ||
          tombstone.artifactId !== ownership.artifactId ||
          tombstone.actorPrincipalId !== revocation.revokedByPrincipalId ||
          tombstone.occurredAt !== revocation.revokedAt ||
          tombstone.reason !== revocation.reason ||
          tombstone.trigger !== "fixture_revocation"
        ) {
          throw new RegressionRepositoryContractError(
            "Interaction fixture revocation tombstone set is invalid",
          );
        }
      }

      const before = await storedInteractionFixtureContent(client, stored);
      if (before.contentAvailability !== "available") {
        throw new RegressionRepositoryContractError(
          "Only a complete available interaction fixture content set can be revoked",
        );
      }
      const conflictingRevocationId = await client.query<{ readonly present: boolean }>(
        `
          SELECT EXISTS (
            SELECT 1
            FROM public.proofstack_interaction_fixture_content_revocations
            WHERE tenant_id = $1 AND revocation_id = $2
          ) AS present
        `,
        [revocation.scope.tenantId, revocation.revocationId],
      );
      if (requirePresence(conflictingRevocationId.rows, "interaction revocation identity")) {
        throw new RegressionFixtureContentRevocationConflictError();
      }
      const conflictingTombstoneId = await client.query<{ readonly present: boolean }>(
        `
          SELECT EXISTS (
            SELECT 1
            FROM public.proofstack_artifact_tombstones
            WHERE tenant_id = $1 AND tombstone_id = ANY($2::varchar[])
          ) AS present
        `,
        [revocation.scope.tenantId, tombstones.map(({ tombstoneId }) => tombstoneId)],
      );
      if (requirePresence(conflictingTombstoneId.rows, "fixture tombstone identity")) {
        throw new RegressionRepositoryContractError(
          "Interaction fixture revocation tombstone identity is already in use",
        );
      }

      try {
        await client.query(
          `
            INSERT INTO public.proofstack_interaction_fixture_content_revocations (
              tenant_id,
              project_id,
              environment_id,
              fixture_id,
              fixture_version_id,
              revocation_id,
              schema_version,
              reason,
              revoked_at,
              revoked_at_lexical,
              revoked_by_principal_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11)
          `,
          [
            revocation.scope.tenantId,
            revocation.scope.projectId,
            revocation.scope.environmentId,
            revocation.fixtureId,
            revocation.fixtureVersionId,
            revocation.revocationId,
            revocation.schemaVersion,
            revocation.reason,
            revocation.revokedAt,
            revocation.revokedAt,
            revocation.revokedByPrincipalId,
          ],
        );
        for (const tombstone of tombstones) {
          await client.query(
            `
              INSERT INTO public.proofstack_artifact_tombstones (
                tenant_id,
                artifact_id,
                tombstone_id,
                actor_principal_id,
                tombstone_trigger,
                reason,
                occurred_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
            `,
            [
              revocation.scope.tenantId,
              tombstone.artifactId,
              tombstone.tombstoneId,
              tombstone.actorPrincipalId,
              tombstone.trigger,
              tombstone.reason,
              tombstone.occurredAt,
            ],
          );
          const updated = await client.query(
            `
              UPDATE public.proofstack_artifact_catalog
              SET state = 'tombstoned', tombstoned_at = $5::timestamptz
              WHERE tenant_id = $1
                AND project_id = $2
                AND environment_id = $3
                AND artifact_id = $4
                AND state = 'available'
            `,
            [
              revocation.scope.tenantId,
              revocation.scope.projectId,
              revocation.scope.environmentId,
              tombstone.artifactId,
              tombstone.occurredAt,
            ],
          );
          if (updated.rowCount !== 1) {
            throw new RegressionRepositoryContractError(
              "Interaction fixture revocation did not tombstone one exact owned artifact",
            );
          }
        }
      } catch (error) {
        if (postgresCode(error) === "23505") {
          throw new RegressionFixtureContentRevocationConflictError();
        }
        throw error;
      }

      return {
        created: true,
        ...(await storedInteractionFixtureContent(client, stored)),
      };
    });
  }

  async resolveFixtureVersionReferences(
    scopeInput: EvidenceScope,
    referencesInput: readonly RequestedRegressionFixtureVersionReference[],
  ): Promise<ResolveRegressionFixtureVersionReferencesResult> {
    const scope = requireScope(scopeInput);
    if (referencesInput.length === 0) return [];
    const references = referencesInput.map((reference) =>
      RequestedRegressionFixtureVersionReferenceSchema.parse(reference),
    );
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const identities = await loadFixtureVersionIdentities(
        client,
        scope.tenantId,
        references.map(({ fixtureVersionId }) => fixtureVersionId),
      );
      for (const reference of references) {
        const identity = identities.get(reference.fixtureVersionId);
        if (
          !identity ||
          identity.tenant_id !== scope.tenantId ||
          identity.project_id !== scope.projectId ||
          identity.environment_id !== scope.environmentId ||
          identity.fixture_id !== reference.fixtureId
        ) {
          return null;
        }
      }
      const stored = await loadAnyFixtureVersions(
        client,
        scope.tenantId,
        references.map(({ fixtureVersionId }) => fixtureVersionId),
      );
      const resolved: RegressionFixtureVersionReference[] = [];
      for (const reference of references) {
        const authoritative = stored.get(reference.fixtureVersionId)?.version;
        if (
          !authoritative ||
          authoritative.fixtureId !== reference.fixtureId ||
          !scopesEqual(authoritative.scope, scope)
        ) {
          return null;
        }
        resolved.push({
          definitionSha256: authoritative.definitionSha256,
          fixtureId: authoritative.fixtureId,
          fixtureVersionId: authoritative.fixtureVersionId,
        });
      }
      return clone(resolved);
    });
  }
}
