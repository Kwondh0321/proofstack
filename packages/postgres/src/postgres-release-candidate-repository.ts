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
  client: PoolClient,
  tenantId: string,
  candidateVersionId: string,
): Promise<StoredReleaseCandidateRow | null> {
  const result = await client.query<StoredReleaseCandidateRow>(
    `SELECT tenant_id, project_id, environment_id, candidate_id, candidate_version_id,
       schema_version, definition_sha256, created_at_lexical, created_by_principal_id,
       lineage_count, record
     FROM public.proofstack_release_candidates
     WHERE tenant_id = $1 AND candidate_version_id = $2`,
    [tenantId, candidateVersionId],
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
  client: PoolClient,
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

export class PostgresReleaseCandidateRepository implements ReleaseCandidateRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async findReleaseCandidate(
    scope: EvidenceScope,
    candidateVersionId: string,
  ): Promise<ReleaseCandidate | null> {
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const row = await loadStored(client, scope.tenantId, candidateVersionId);
      if (!row) return null;
      const candidate = parseStored(row);
      return scopesEqual(candidate.scope, scope) ? clone(candidate) : null;
    });
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
          await requireCanonicalOutbox(client, existing);
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
        await requireCanonicalOutbox(client, stored);
        return { candidate: clone(stored), created: true };
      });
    } catch (error) {
      mapPersistenceError(error, candidate);
    }
  }
}
