import { Buffer } from "node:buffer";
import type { EvidenceScope, ReleaseCandidate } from "@proofstack/contracts";
import {
  InvalidReleaseCandidateRecordInputError,
  type PublishReleaseCandidateResult,
  ReleaseCandidateLineageError,
  type ReleaseCandidateRepository,
  ReleaseCandidateRepositoryContractError,
  ReleaseCandidateResourceConflictError,
  ReleaseCandidateVersionConflictError,
  validateReleaseCandidateRecord,
} from "@proofstack/core";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { withTenantTransaction } from "./tenant-transaction.js";

interface StoredReleaseCandidateRow extends QueryResultRow {
  readonly candidate_id: string;
  readonly candidate_version_id: string;
  readonly created_at_lexical: string;
  readonly created_at_matches: boolean;
  readonly created_by_principal_id: string;
  readonly definition_sha256: string;
  readonly environment_id: string;
  readonly lineage_count: number;
  readonly project_id: string;
  readonly record: unknown;
  readonly schema_version: string;
  readonly tenant_id: string;
}

interface OutboxIntentRow extends QueryResultRow {
  readonly status: string;
}

interface CandidateRegistryRow extends QueryResultRow {
  readonly project_id: string;
  readonly environment_id: string;
  readonly schema_version: string;
  readonly definition_sha256: string;
}

interface CandidateLineageRow extends QueryResultRow {
  readonly parent_candidate_version_id: string;
  readonly parent_definition_sha256: string;
  readonly child_matches: boolean;
  readonly parent_matches: boolean;
}

interface CandidateResourceRow extends QueryResultRow {
  readonly project_id: string;
  readonly environment_id: string;
  readonly root_candidate_version_id: string;
  readonly root_definition_sha256: string;
  readonly root_matches: boolean;
}

interface CandidatePresenceRow extends QueryResultRow {
  readonly retained_candidate_body: boolean;
  readonly retained_candidate_storage: boolean;
}

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

function mapPersistenceError(error: unknown, candidate: ReleaseCandidate): never {
  if (
    error instanceof InvalidReleaseCandidateRecordInputError ||
    error instanceof ReleaseCandidateLineageError ||
    error instanceof ReleaseCandidateRepositoryContractError ||
    error instanceof ReleaseCandidateResourceConflictError ||
    error instanceof ReleaseCandidateVersionConflictError
  ) {
    throw error;
  }

  const code = postgresCode(error);
  const message = postgresMessage(error);
  if (code === "23503" || (code === "23514" && /lineage/i.test(message))) {
    throw new ReleaseCandidateLineageError(
      candidate.candidateVersionId,
      candidate.predecessor?.candidateVersionId ?? "missing_predecessor",
    );
  }
  if (code === "23505" && /release candidate resource/i.test(message)) {
    throw new ReleaseCandidateResourceConflictError(candidate.candidateId);
  }
  if (code === "23505") {
    throw new ReleaseCandidateVersionConflictError(candidate.candidateVersionId);
  }
  if (code === "23514" || code === "22007" || code === "22P02") {
    throw new ReleaseCandidateRepositoryContractError(
      "PostgreSQL rejected normalized release candidate persistence",
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
  tenantId: string,
  candidateVersionId: string,
  exactScope?: EvidenceScope,
): Promise<StoredReleaseCandidateRow | null> {
  const result = await client.query<StoredReleaseCandidateRow>(
    `SELECT tenant_id, project_id, environment_id, candidate_id, candidate_version_id,
       schema_version, definition_sha256, created_at_lexical, created_by_principal_id,
       lineage_count, record,
       created_at = created_at_lexical::timestamptz AS created_at_matches
     FROM public.proofstack_release_candidates
     WHERE tenant_id = $1 AND candidate_version_id = $2
       ${exactScope ? "AND project_id = $3 AND environment_id = $4" : ""}`,
    [
      tenantId,
      candidateVersionId,
      ...(exactScope ? [exactScope.projectId, exactScope.environmentId] : []),
    ],
  );
  return result.rows[0] ?? null;
}

function parseStored(row: StoredReleaseCandidateRow): ReleaseCandidate {
  try {
    const candidate = validateReleaseCandidateRecord(row.record);
    if (
      candidate.scope.tenantId !== row.tenant_id ||
      candidate.scope.projectId !== row.project_id ||
      candidate.scope.environmentId !== row.environment_id ||
      candidate.candidateId !== row.candidate_id ||
      candidate.candidateVersionId !== row.candidate_version_id ||
      candidate.schemaVersion !== row.schema_version ||
      candidate.definitionSha256 !== row.definition_sha256 ||
      candidate.createdAt !== row.created_at_lexical ||
      row.created_at_matches !== true ||
      candidate.createdByPrincipalId !== row.created_by_principal_id ||
      Number(candidate.predecessor !== undefined) !== row.lineage_count
    ) {
      throw new Error("normalized columns differ from the canonical record");
    }
    return candidate;
  } catch (error) {
    throw new ReleaseCandidateRepositoryContractError(
      "Stored release candidate violates the canonical contract",
      { cause: error },
    );
  }
}

function outboxPayload(candidate: ReleaseCandidate): Readonly<Record<string, unknown>> {
  return { record: clone(candidate), recordKind: "release_candidate" };
}

async function requireCanonicalOutbox(
  client: Pick<PoolClient, "query">,
  candidate: ReleaseCandidate,
): Promise<void> {
  const result = await client.query<OutboxIntentRow>(
    `SELECT public.proofstack_release_candidate_intent_status(
       $1, $2, $3::jsonb, $4::timestamptz
     ) AS status`,
    [
      candidate.candidateVersionId,
      candidate.schemaVersion,
      JSON.stringify(outboxPayload(candidate)),
      candidate.createdAt,
    ],
  );
  if (result.rows[0]?.status !== "canonical") {
    throw new ReleaseCandidateRepositoryContractError(
      `Stored release candidate ${candidate.candidateVersionId} is missing its canonical outbox intent`,
    );
  }
}

async function requireRegistryAndLineage(
  client: Pick<PoolClient, "query">,
  candidate: ReleaseCandidate,
): Promise<void> {
  const values = [
    candidate.scope.tenantId,
    candidate.candidateVersionId,
    candidate.scope.projectId,
    candidate.scope.environmentId,
    candidate.definitionSha256,
    candidate.schemaVersion,
  ];
  const registry = await client.query<CandidateRegistryRow>(
    `SELECT project_id, environment_id, schema_version, definition_sha256
     FROM public.proofstack_release_candidate_registry
     WHERE tenant_id = $1 AND candidate_version_id = $2 LIMIT 2`,
    values.slice(0, 2),
  );
  const child = registry.rows[0];
  if (
    registry.rows.length !== 1 ||
    !child ||
    child.project_id !== candidate.scope.projectId ||
    child.environment_id !== candidate.scope.environmentId ||
    child.schema_version !== candidate.schemaVersion ||
    child.definition_sha256 !== candidate.definitionSha256
  ) {
    throw new ReleaseCandidateRepositoryContractError(
      "Stored release candidate registry differs from its canonical body",
    );
  }
  const lineage = await client.query<CandidateLineageRow>(
    `SELECT edge.parent_candidate_version_id, edge.parent_definition_sha256,
       edge.project_id = $3 AND edge.environment_id = $4
         AND edge.child_definition_sha256 = $5 AS child_matches,
       EXISTS (
         SELECT 1 FROM public.proofstack_release_candidate_registry AS parent
         WHERE parent.tenant_id = edge.tenant_id
           AND parent.project_id = edge.project_id
           AND parent.environment_id = edge.environment_id
           AND parent.candidate_version_id = edge.parent_candidate_version_id
           AND parent.definition_sha256 = edge.parent_definition_sha256
           AND parent.schema_version = $6
       ) AS parent_matches
     FROM public.proofstack_release_candidate_lineage AS edge
     WHERE edge.tenant_id = $1 AND edge.child_candidate_version_id = $2 LIMIT 2`,
    values,
  );
  const expected = candidate.predecessor;
  const edge = lineage.rows[0];
  if (
    lineage.rows.length !== Number(expected !== undefined) ||
    (expected &&
      (!edge ||
        edge.parent_candidate_version_id !== expected.candidateVersionId ||
        edge.parent_definition_sha256 !== expected.definitionSha256 ||
        edge.child_matches !== true ||
        edge.parent_matches !== true))
  ) {
    throw new ReleaseCandidateRepositoryContractError(
      "Stored release candidate lineage differs from its canonical predecessor",
    );
  }
}

async function requirePhysicalIntegrity(
  client: Pick<PoolClient, "query">,
  candidate: ReleaseCandidate,
): Promise<void> {
  await requireRegistryAndLineage(client, candidate);
  const resources = await client.query<CandidateResourceRow>(
    `SELECT binding.project_id, binding.environment_id, binding.root_candidate_version_id,
       binding.root_definition_sha256,
       EXISTS (
         SELECT 1 FROM public.proofstack_release_candidate_registry AS root
         WHERE root.tenant_id = binding.tenant_id
           AND root.project_id = binding.project_id
           AND root.environment_id = binding.environment_id
           AND root.candidate_version_id = binding.root_candidate_version_id
           AND root.definition_sha256 = binding.root_definition_sha256
           AND root.schema_version = $3
       ) AS root_matches
     FROM public.proofstack_release_candidate_resources AS binding
     WHERE binding.tenant_id = $1 AND binding.candidate_id = $2 LIMIT 2`,
    [candidate.scope.tenantId, candidate.candidateId, candidate.schemaVersion],
  );
  const binding = resources.rows[0];
  if (
    resources.rows.length !== 1 ||
    !binding ||
    binding.project_id !== candidate.scope.projectId ||
    binding.environment_id !== candidate.scope.environmentId ||
    binding.root_matches !== true
  ) {
    throw new ReleaseCandidateRepositoryContractError(
      "Stored release candidate logical resource binding is inconsistent",
    );
  }
  let root = candidate;
  if (binding.root_candidate_version_id !== candidate.candidateVersionId) {
    const row = await loadStored(
      client,
      candidate.scope.tenantId,
      binding.root_candidate_version_id,
      candidate.scope,
    );
    if (!row) {
      throw new ReleaseCandidateRepositoryContractError(
        "Stored release candidate logical root is missing its exact body",
      );
    }
    root = parseStored(row);
  }
  if (
    root.candidateId !== candidate.candidateId ||
    root.candidateVersionId !== binding.root_candidate_version_id ||
    root.definitionSha256 !== binding.root_definition_sha256 ||
    root.schemaVersion !== candidate.schemaVersion ||
    !scopesEqual(root.scope, candidate.scope) ||
    root.predecessor !== undefined
  ) {
    throw new ReleaseCandidateRepositoryContractError(
      "Stored release candidate logical root differs from its canonical body",
    );
  }
  if (root !== candidate) {
    await requireRegistryAndLineage(client, root);
    await requireCanonicalOutbox(client, root);
  }
  await requireCanonicalOutbox(client, candidate);
}

async function inspectScopedPresence(
  client: Pick<PoolClient, "query">,
  scope: EvidenceScope,
  candidateVersionId: string,
): Promise<boolean> {
  const result = await client.query<CandidatePresenceRow>(
    `SELECT EXISTS (
       SELECT 1 FROM public.proofstack_release_candidates
       WHERE tenant_id = $1 AND project_id = $2 AND environment_id = $3
         AND candidate_version_id = $4
     ) AS retained_candidate_body, EXISTS (
       SELECT 1 FROM public.proofstack_release_candidate_registry
       WHERE tenant_id = $1 AND project_id = $2 AND environment_id = $3
         AND candidate_version_id = $4
     ) OR EXISTS (
       SELECT 1 FROM public.proofstack_release_candidate_lineage
       WHERE tenant_id = $1 AND project_id = $2 AND environment_id = $3
         AND child_candidate_version_id = $4
     ) OR EXISTS (
       SELECT 1 FROM public.proofstack_release_candidate_resources
       WHERE tenant_id = $1 AND project_id = $2 AND environment_id = $3
         AND root_candidate_version_id = $4
     ) AS retained_candidate_storage`,
    [scope.tenantId, scope.projectId, scope.environmentId, candidateVersionId],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row ||
    typeof row.retained_candidate_body !== "boolean" ||
    typeof row.retained_candidate_storage !== "boolean" ||
    row.retained_candidate_body !== row.retained_candidate_storage
  ) {
    throw new ReleaseCandidateRepositoryContractError(
      "Stored release candidate scoped presence violates its storage contract",
    );
  }
  return row.retained_candidate_body;
}

/** Exact normalized candidate read on the caller-owned scoped connection. */
export async function readPostgresReleaseCandidateOnClient(
  client: Pick<PoolClient, "query">,
  scopeInput: EvidenceScope,
  candidateVersionId: string,
): Promise<ReleaseCandidate | null> {
  const scope = { ...scopeInput };
  if (!(await inspectScopedPresence(client, scope, candidateVersionId))) return null;
  const row = await loadStored(client, scope.tenantId, candidateVersionId, scope);
  if (!row) {
    throw new ReleaseCandidateRepositoryContractError(
      "Stored release candidate body disappeared after its scoped presence observation",
    );
  }
  const candidate = parseStored(row);
  if (!scopesEqual(candidate.scope, scope)) return null;
  await requirePhysicalIntegrity(client, candidate);
  return clone(candidate);
}

export class PostgresReleaseCandidateRepository implements ReleaseCandidateRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async findReleaseCandidate(
    scopeInput: EvidenceScope,
    candidateVersionId: string,
  ): Promise<ReleaseCandidate | null> {
    const scope = { ...scopeInput };
    return withTenantTransaction(this.pool, scope.tenantId, (client) =>
      readPostgresReleaseCandidateOnClient(client, scope, candidateVersionId),
    );
  }

  async publishReleaseCandidate(input: ReleaseCandidate): Promise<PublishReleaseCandidateResult> {
    const candidate = validateReleaseCandidateRecord(input);
    const lockPrefix = `proofstack:release-candidate:${candidate.scope.tenantId}`;
    const lockKeys = [
      `${lockPrefix}:resource:${candidate.candidateId}`,
      `${lockPrefix}:version:${candidate.candidateVersionId}`,
      ...(candidate.predecessor
        ? [`${lockPrefix}:version:${candidate.predecessor.candidateVersionId}`]
        : []),
    ];

    try {
      return await withTenantTransaction(this.pool, candidate.scope.tenantId, async (client) => {
        await acquireLocks(client, lockKeys);
        const existingRow = await loadStored(
          client,
          candidate.scope.tenantId,
          candidate.candidateVersionId,
        );
        if (existingRow) {
          const existing = parseStored(existingRow);
          if (existing.definitionSha256 !== candidate.definitionSha256) {
            throw new ReleaseCandidateVersionConflictError(candidate.candidateVersionId);
          }
          await requirePhysicalIntegrity(client, existing);
          return { candidate: clone(existing), created: false };
        }

        const command = {
          candidateId: candidate.candidateId,
          candidateVersionId: candidate.candidateVersionId,
          createdAt: candidate.createdAt,
          createdByPrincipalId: candidate.createdByPrincipalId,
          definitionSha256: candidate.definitionSha256,
          environmentId: candidate.scope.environmentId,
          projectId: candidate.scope.projectId,
          record: candidate,
          schemaVersion: candidate.schemaVersion,
          tenantId: candidate.scope.tenantId,
        };
        await client.query("SELECT public.proofstack_publish_release_candidate($1::jsonb)", [
          JSON.stringify(command),
        ]);

        const storedRow = await loadStored(
          client,
          candidate.scope.tenantId,
          candidate.candidateVersionId,
        );
        if (!storedRow) {
          throw new ReleaseCandidateRepositoryContractError(
            "PostgreSQL accepted release candidate publication without retaining the record",
          );
        }
        const stored = parseStored(storedRow);
        await requirePhysicalIntegrity(client, stored);
        return { candidate: clone(stored), created: true };
      });
    } catch (error) {
      mapPersistenceError(error, candidate);
    }
  }
}
