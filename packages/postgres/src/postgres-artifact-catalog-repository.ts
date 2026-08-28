import { isDeepStrictEqual } from "node:util";
import {
  type ArtifactCatalogEntry,
  type ArtifactCatalogRepository,
  ArtifactConflictError,
  type ArtifactKeyReferenceCounts,
  type ArtifactKeyReferenceSummary,
  ArtifactNotFoundError,
  type ArtifactObjectReceipt,
  type ArtifactPurgeReceipt,
  ArtifactStateTransitionError,
  artifactReservationIdentity,
  MAX_ARTIFACT_MAINTENANCE_BATCH_SIZE,
  type ReserveArtifactCatalogResult,
  type TombstoneArtifactCatalogResult,
} from "@proofstack/artifacts";
import {
  ArtifactMetadataSchema,
  type ArtifactTombstone,
  ArtifactTombstoneSchema,
  type EvidenceScope,
  OpaqueIdSchema,
} from "@proofstack/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { withTenantTransaction } from "./tenant-transaction.js";

interface StoredArtifactRow extends QueryResultRow {
  readonly artifact_id: string;
  readonly available_at: string | null;
  readonly classification: string;
  readonly content_nonce: string;
  readonly content_sha256: string;
  readonly content_size_bytes: number;
  readonly created_at: string;
  readonly created_by_principal_id: string;
  readonly encryption_version: string;
  readonly environment_id: string;
  readonly expires_at: string | null;
  readonly media_type: string;
  readonly object_key: string;
  readonly object_receipt_sha256: string | null;
  readonly object_receipt_size_bytes: number | null;
  readonly project_id: string;
  readonly purged_at: string | null;
  readonly redaction: unknown;
  readonly retention_mode: string;
  readonly schema_version: string;
  readonly state: string;
  readonly tenant_id: string;
  readonly tombstoned_at: string | null;
  readonly wrapped_key_algorithm: string;
  readonly wrapped_key_ciphertext: string;
  readonly wrapped_key_id: string;
  readonly wrapped_key_nonce: string;
  readonly wrapped_key_tag: string;
}

interface StoredTombstoneRow extends QueryResultRow {
  readonly actor_principal_id: string;
  readonly artifact_id: string;
  readonly occurred_at: string;
  readonly reason: string;
  readonly tombstone_id: string;
  readonly tombstone_trigger: string;
}

interface PresenceRow extends QueryResultRow {
  readonly present: boolean;
}

interface StoredKeyReferenceRow extends QueryResultRow {
  readonly key_id: string;
  readonly reference_count: string;
  readonly state: string;
}

export class PostgresArtifactDataIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PostgresArtifactDataIntegrityError";
  }
}

const UTC_TIMESTAMP_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const SELECT_ARTIFACT_COLUMNS = `
  tenant_id,
  project_id,
  environment_id,
  artifact_id,
  schema_version,
  state,
  classification,
  media_type,
  content_sha256,
  content_size_bytes,
  redaction,
  retention_mode,
  to_char(expires_at AT TIME ZONE 'UTC', ${UTC_TIMESTAMP_FORMAT}) AS expires_at,
  to_char(created_at AT TIME ZONE 'UTC', ${UTC_TIMESTAMP_FORMAT}) AS created_at,
  to_char(available_at AT TIME ZONE 'UTC', ${UTC_TIMESTAMP_FORMAT}) AS available_at,
  to_char(tombstoned_at AT TIME ZONE 'UTC', ${UTC_TIMESTAMP_FORMAT}) AS tombstoned_at,
  to_char(purged_at AT TIME ZONE 'UTC', ${UTC_TIMESTAMP_FORMAT}) AS purged_at,
  created_by_principal_id,
  object_key,
  encryption_version,
  content_nonce,
  wrapped_key_algorithm,
  wrapped_key_id,
  wrapped_key_ciphertext,
  wrapped_key_nonce,
  wrapped_key_tag,
  object_receipt_sha256,
  object_receipt_size_bytes
`;

const SELECT_TOMBSTONE_COLUMNS = `
  artifact_id,
  tombstone_id,
  actor_principal_id,
  tombstone_trigger,
  reason,
  to_char(occurred_at AT TIME ZONE 'UTC', ${UTC_TIMESTAMP_FORMAT}) AS occurred_at
`;

const INSERT_ARTIFACT_SQL = `
  INSERT INTO public.proofstack_artifact_catalog (
    tenant_id,
    project_id,
    environment_id,
    artifact_id,
    schema_version,
    state,
    classification,
    media_type,
    content_sha256,
    content_size_bytes,
    redaction,
    retention_mode,
    expires_at,
    created_at,
    created_by_principal_id,
    object_key,
    encryption_version,
    content_nonce,
    wrapped_key_algorithm,
    wrapped_key_id,
    wrapped_key_ciphertext,
    wrapped_key_nonce,
    wrapped_key_tag
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13,
    $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
  )
  ON CONFLICT (tenant_id, artifact_id) DO NOTHING
  RETURNING artifact_id
`;

function redactedAt(redaction: unknown): unknown {
  if (
    typeof redaction !== "object" ||
    redaction === null ||
    !("status" in redaction) ||
    redaction.status !== "applied" ||
    !("records" in redaction) ||
    !Array.isArray(redaction.records)
  ) {
    return undefined;
  }
  const last = redaction.records.at(-1);
  return typeof last === "object" && last !== null && "stage" in last ? last.stage : undefined;
}

function validEncoded(value: unknown, expectedBytes: number): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === expectedBytes && decoded.toString("base64url") === value;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function optionalTimestamp(name: string, value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new PostgresArtifactDataIntegrityError(`Stored artifact ${name} is invalid`);
  }
  return value;
}

function storedEntry(row: StoredArtifactRow): ArtifactCatalogEntry {
  const availableAt = optionalTimestamp("availableAt", row.available_at);
  const tombstonedAt = optionalTimestamp("tombstonedAt", row.tombstoned_at);
  const purgedAt = optionalTimestamp("purgedAt", row.purged_at);
  const expiresAt = optionalTimestamp("expiresAt", row.expires_at);
  const latestRedactionStage = redactedAt(row.redaction);
  const metadata = ArtifactMetadataSchema.safeParse({
    ...(availableAt ? { availableAt } : {}),
    contentReference: {
      artifactId: row.artifact_id,
      classification: row.classification,
      mediaType: row.media_type,
      ...(latestRedactionStage ? { redactedAt: latestRedactionStage } : {}),
      sha256: row.content_sha256,
      sizeBytes: row.content_size_bytes,
    },
    createdAt: row.created_at,
    ...(purgedAt ? { purgedAt } : {}),
    redaction: row.redaction,
    retention:
      row.retention_mode === "expire"
        ? { expiresAt, mode: row.retention_mode }
        : { mode: row.retention_mode },
    schemaVersion: row.schema_version,
    scope: {
      environmentId: row.environment_id,
      projectId: row.project_id,
      tenantId: row.tenant_id,
    },
    state: row.state,
    ...(tombstonedAt ? { tombstonedAt } : {}),
  });
  if (!metadata.success) {
    throw new PostgresArtifactDataIntegrityError(
      "Stored artifact metadata does not satisfy the canonical contract",
      { cause: metadata.error },
    );
  }

  if (
    row.encryption_version !== "a256gcm-v1" ||
    !validEncoded(row.content_nonce, 12) ||
    row.wrapped_key_algorithm !== "A256GCM" ||
    !OpaqueIdSchema.safeParse(row.wrapped_key_id).success ||
    !validEncoded(row.wrapped_key_ciphertext, 32) ||
    !validEncoded(row.wrapped_key_nonce, 12) ||
    !validEncoded(row.wrapped_key_tag, 16) ||
    typeof row.object_key !== "string" ||
    row.object_key.length === 0 ||
    row.object_key.length > 512 ||
    row.object_key.trim() !== row.object_key ||
    hasControlCharacters(row.object_key) ||
    !OpaqueIdSchema.safeParse(row.created_by_principal_id).success
  ) {
    throw new PostgresArtifactDataIntegrityError("Stored artifact protection metadata is invalid");
  }

  let objectReceipt: ArtifactObjectReceipt | undefined;
  if (row.object_receipt_sha256 !== null || row.object_receipt_size_bytes !== null) {
    if (
      typeof row.object_receipt_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.object_receipt_sha256) ||
      !Number.isInteger(row.object_receipt_size_bytes) ||
      row.object_receipt_size_bytes !== metadata.data.contentReference.sizeBytes + 20
    ) {
      throw new PostgresArtifactDataIntegrityError("Stored artifact object receipt is invalid");
    }
    objectReceipt = {
      sha256: row.object_receipt_sha256,
      sizeBytes: row.object_receipt_size_bytes as number,
    };
  }

  return {
    createdByPrincipalId: row.created_by_principal_id,
    encryption: {
      contentNonce: row.content_nonce,
      version: row.encryption_version,
      wrappedDataKey: {
        algorithm: row.wrapped_key_algorithm,
        ciphertext: row.wrapped_key_ciphertext,
        keyId: row.wrapped_key_id,
        nonce: row.wrapped_key_nonce,
        tag: row.wrapped_key_tag,
      },
    },
    metadata: metadata.data,
    objectKey: row.object_key,
    ...(objectReceipt ? { objectReceipt } : {}),
  };
}

function storedTombstone(row: StoredTombstoneRow): ArtifactTombstone {
  const parsed = ArtifactTombstoneSchema.safeParse({
    actorPrincipalId: row.actor_principal_id,
    artifactId: row.artifact_id,
    occurredAt: row.occurred_at,
    reason: row.reason,
    tombstoneId: row.tombstone_id,
    trigger: row.tombstone_trigger,
  });
  if (!parsed.success) {
    throw new PostgresArtifactDataIntegrityError(
      "Stored artifact tombstone does not satisfy the canonical contract",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

const ARTIFACT_REFERENCE_STATES = new Set([
  "available",
  "purged",
  "reserved",
  "tombstoned",
] as const);

type ArtifactReferenceState = "available" | "purged" | "reserved" | "tombstoned";

function storedKeyReferences(
  rows: readonly StoredKeyReferenceRow[],
): readonly ArtifactKeyReferenceSummary[] {
  const references = new Map<
    string,
    { counts: ArtifactKeyReferenceCounts; states: Set<ArtifactReferenceState> }
  >();
  for (const row of rows) {
    if (
      !OpaqueIdSchema.safeParse(row.key_id).success ||
      !ARTIFACT_REFERENCE_STATES.has(row.state as ArtifactReferenceState) ||
      !/^[1-9][0-9]*$/.test(row.reference_count)
    ) {
      throw new PostgresArtifactDataIntegrityError("Stored artifact key references are invalid");
    }
    const state = row.state as ArtifactReferenceState;
    const count = Number(row.reference_count);
    const current = references.get(row.key_id) ?? {
      counts: { available: 0, purged: 0, reserved: 0, tombstoned: 0, total: 0 },
      states: new Set<ArtifactReferenceState>(),
    };
    if (!Number.isSafeInteger(count) || current.states.has(state)) {
      throw new PostgresArtifactDataIntegrityError("Stored artifact key references are invalid");
    }
    current.states.add(state);
    references.set(row.key_id, {
      counts: {
        ...current.counts,
        [state]: count,
        total: current.counts.total + count,
      },
      states: current.states,
    });
  }
  return [...references.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([keyId, value]) => ({ counts: value.counts, keyId }));
}

function isSameReservation(left: ArtifactCatalogEntry, right: ArtifactCatalogEntry): boolean {
  return isDeepStrictEqual(
    artifactReservationIdentity(left.metadata),
    artifactReservationIdentity(right.metadata),
  );
}

function isSameTombstone(left: ArtifactTombstone, right: ArtifactTombstone): boolean {
  return (
    left.actorPrincipalId === right.actorPrincipalId &&
    left.artifactId === right.artifactId &&
    left.reason === right.reason &&
    left.trigger === right.trigger
  );
}

function insertValues(candidate: ArtifactCatalogEntry): readonly unknown[] {
  const { contentReference, retention, scope } = candidate.metadata;
  return [
    scope.tenantId,
    scope.projectId,
    scope.environmentId,
    contentReference.artifactId,
    candidate.metadata.schemaVersion,
    candidate.metadata.state,
    contentReference.classification,
    contentReference.mediaType,
    contentReference.sha256,
    contentReference.sizeBytes,
    JSON.stringify(candidate.metadata.redaction),
    retention.mode,
    retention.mode === "expire" ? retention.expiresAt : null,
    candidate.metadata.createdAt,
    candidate.createdByPrincipalId,
    candidate.objectKey,
    candidate.encryption.version,
    candidate.encryption.contentNonce,
    candidate.encryption.wrappedDataKey.algorithm,
    candidate.encryption.wrappedDataKey.keyId,
    candidate.encryption.wrappedDataKey.ciphertext,
    candidate.encryption.wrappedDataKey.nonce,
    candidate.encryption.wrappedDataKey.tag,
  ];
}

function assertMaintenanceLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ARTIFACT_MAINTENANCE_BATCH_SIZE) {
    throw new RangeError(
      `Artifact maintenance limit must be between 1 and ${MAX_ARTIFACT_MAINTENANCE_BATCH_SIZE}`,
    );
  }
}

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

async function findByIdentity(
  client: PoolClient,
  tenantId: string,
  artifactId: string,
): Promise<ArtifactCatalogEntry | null> {
  const result = await client.query<StoredArtifactRow>(
    `
      SELECT ${SELECT_ARTIFACT_COLUMNS}
      FROM public.proofstack_artifact_catalog
      WHERE tenant_id = $1 AND artifact_id = $2
    `,
    [tenantId, artifactId],
  );
  const row = result.rows[0];
  return row ? storedEntry(row) : null;
}

async function findLocked(
  client: PoolClient,
  scope: EvidenceScope,
  artifactId: string,
): Promise<ArtifactCatalogEntry | null> {
  const result = await client.query<StoredArtifactRow>(
    `
      SELECT ${SELECT_ARTIFACT_COLUMNS}
      FROM public.proofstack_artifact_catalog
      WHERE tenant_id = $1
        AND project_id = $2
        AND environment_id = $3
        AND artifact_id = $4
      FOR UPDATE
    `,
    [scope.tenantId, scope.projectId, scope.environmentId, artifactId],
  );
  const row = result.rows[0];
  return row ? storedEntry(row) : null;
}

async function requiredLocked(
  client: PoolClient,
  scope: EvidenceScope,
  artifactId: string,
): Promise<ArtifactCatalogEntry> {
  const entry = await findLocked(client, scope, artifactId);
  if (!entry) throw new ArtifactNotFoundError();
  return entry;
}

async function findTombstone(
  client: PoolClient,
  tenantId: string,
  artifactId: string,
): Promise<ArtifactTombstone | null> {
  const result = await client.query<StoredTombstoneRow>(
    `
      SELECT ${SELECT_TOMBSTONE_COLUMNS}
      FROM public.proofstack_artifact_tombstones
      WHERE tenant_id = $1 AND artifact_id = $2
    `,
    [tenantId, artifactId],
  );
  const row = result.rows[0];
  return row ? storedTombstone(row) : null;
}

export class PostgresArtifactCatalogRepository implements ArtifactCatalogRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async reserve(candidate: ArtifactCatalogEntry): Promise<ReserveArtifactCatalogResult> {
    if (candidate.metadata.state !== "reserved" || candidate.objectReceipt !== undefined) {
      throw new ArtifactStateTransitionError();
    }
    const artifactId = candidate.metadata.contentReference.artifactId;
    const tenantId = candidate.metadata.scope.tenantId;
    return withTenantTransaction(this.pool, tenantId, async (client) => {
      const inserted = await client.query<{ readonly artifact_id: string }>(INSERT_ARTIFACT_SQL, [
        ...insertValues(candidate),
      ]);
      const entry = await findByIdentity(client, tenantId, artifactId);
      if (!entry) {
        throw new PostgresArtifactDataIntegrityError(
          `Reserved artifact ${artifactId} was not visible inside its tenant transaction`,
        );
      }
      const created = inserted.rows.length === 1;
      if (!created && !isSameReservation(entry, candidate)) throw new ArtifactConflictError();
      return { created, entry };
    });
  }

  async find(scope: EvidenceScope, artifactId: string): Promise<ArtifactCatalogEntry | null> {
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const result = await client.query<StoredArtifactRow>(
        `
          SELECT ${SELECT_ARTIFACT_COLUMNS}
          FROM public.proofstack_artifact_catalog
          WHERE tenant_id = $1
            AND project_id = $2
            AND environment_id = $3
            AND artifact_id = $4
        `,
        [scope.tenantId, scope.projectId, scope.environmentId, artifactId],
      );
      const row = result.rows[0];
      return row ? storedEntry(row) : null;
    });
  }

  async activate(
    scope: EvidenceScope,
    artifactId: string,
    objectReceipt: ArtifactObjectReceipt,
    availableAt: string,
  ): Promise<ArtifactCatalogEntry> {
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const existing = await requiredLocked(client, scope, artifactId);
      if (existing.metadata.state === "available") {
        if (!isDeepStrictEqual(existing.objectReceipt, objectReceipt)) {
          throw new ArtifactConflictError();
        }
        return existing;
      }
      if (existing.metadata.state !== "reserved") throw new ArtifactStateTransitionError();

      await client.query(
        `
          UPDATE public.proofstack_artifact_catalog
          SET state = 'available',
              available_at = $5,
              object_receipt_sha256 = $6,
              object_receipt_size_bytes = $7
          WHERE tenant_id = $1
            AND project_id = $2
            AND environment_id = $3
            AND artifact_id = $4
        `,
        [
          scope.tenantId,
          scope.projectId,
          scope.environmentId,
          artifactId,
          availableAt,
          objectReceipt.sha256,
          objectReceipt.sizeBytes,
        ],
      );
      const activated = await findByIdentity(client, scope.tenantId, artifactId);
      if (!activated)
        throw new PostgresArtifactDataIntegrityError("Activated artifact disappeared");
      return activated;
    });
  }

  async tombstone(
    scope: EvidenceScope,
    tombstone: ArtifactTombstone,
  ): Promise<TombstoneArtifactCatalogResult> {
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const existing = await requiredLocked(client, scope, tombstone.artifactId);
      const recorded = await findTombstone(client, scope.tenantId, tombstone.artifactId);
      if (recorded) {
        if (!isSameTombstone(recorded, tombstone)) throw new ArtifactConflictError();
        return { created: false, entry: existing, tombstone: recorded };
      }

      const allowed =
        (existing.metadata.state === "reserved" && tombstone.trigger === "abandoned") ||
        (existing.metadata.state === "available" && tombstone.trigger !== "abandoned");
      if (!allowed) throw new ArtifactStateTransitionError();

      try {
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
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          `,
          [
            scope.tenantId,
            tombstone.artifactId,
            tombstone.tombstoneId,
            tombstone.actorPrincipalId,
            tombstone.trigger,
            tombstone.reason,
            tombstone.occurredAt,
          ],
        );
      } catch (error) {
        if (postgresCode(error) === "23505") throw new ArtifactConflictError();
        throw error;
      }
      await client.query(
        `
          UPDATE public.proofstack_artifact_catalog
          SET state = 'tombstoned', tombstoned_at = $5
          WHERE tenant_id = $1
            AND project_id = $2
            AND environment_id = $3
            AND artifact_id = $4
        `,
        [
          scope.tenantId,
          scope.projectId,
          scope.environmentId,
          tombstone.artifactId,
          tombstone.occurredAt,
        ],
      );
      const entry = await findByIdentity(client, scope.tenantId, tombstone.artifactId);
      if (!entry) throw new PostgresArtifactDataIntegrityError("Tombstoned artifact disappeared");
      return { created: true, entry, tombstone };
    });
  }

  async recordPurge(
    scope: EvidenceScope,
    receipt: ArtifactPurgeReceipt,
  ): Promise<ArtifactCatalogEntry> {
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const existing = await requiredLocked(client, scope, receipt.artifactId);
      if (existing.metadata.state === "purged") {
        const recorded = await client.query<PresenceRow>(
          `
            SELECT EXISTS (
              SELECT 1
              FROM public.proofstack_artifact_purge_receipts
              WHERE tenant_id = $1 AND artifact_id = $2
            ) AS present
          `,
          [scope.tenantId, receipt.artifactId],
        );
        if (!recorded.rows[0]?.present) {
          throw new PostgresArtifactDataIntegrityError("Purged artifact has no purge receipt");
        }
        return existing;
      }
      if (existing.metadata.state !== "tombstoned") throw new ArtifactStateTransitionError();

      try {
        await client.query(
          `
            INSERT INTO public.proofstack_artifact_purge_receipts (
              tenant_id,
              artifact_id,
              purge_id,
              object_was_present,
              occurred_at
            ) VALUES ($1, $2, $3, $4, $5)
          `,
          [
            scope.tenantId,
            receipt.artifactId,
            receipt.purgeId,
            receipt.objectWasPresent,
            receipt.occurredAt,
          ],
        );
      } catch (error) {
        if (postgresCode(error) === "23505") throw new ArtifactConflictError();
        throw error;
      }
      await client.query(
        `
          UPDATE public.proofstack_artifact_catalog
          SET state = 'purged', purged_at = $5
          WHERE tenant_id = $1
            AND project_id = $2
            AND environment_id = $3
            AND artifact_id = $4
        `,
        [
          scope.tenantId,
          scope.projectId,
          scope.environmentId,
          receipt.artifactId,
          receipt.occurredAt,
        ],
      );
      const entry = await findByIdentity(client, scope.tenantId, receipt.artifactId);
      if (!entry) throw new PostgresArtifactDataIntegrityError("Purged artifact disappeared");
      return entry;
    });
  }

  async listExpired(
    scope: EvidenceScope,
    expiresBefore: string,
    limit: number,
  ): Promise<readonly ArtifactCatalogEntry[]> {
    assertMaintenanceLimit(limit);
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const result = await client.query<StoredArtifactRow>(
        `
          SELECT ${SELECT_ARTIFACT_COLUMNS}
          FROM public.proofstack_artifact_catalog
          WHERE tenant_id = $1
            AND project_id = $2
            AND environment_id = $3
            AND state = 'available'
            AND retention_mode = 'expire'
            AND expires_at <= $4
          ORDER BY expires_at, artifact_id
          LIMIT $5
        `,
        [scope.tenantId, scope.projectId, scope.environmentId, expiresBefore, limit],
      );
      return result.rows.map(storedEntry);
    });
  }

  async listAbandoned(
    scope: EvidenceScope,
    createdBefore: string,
    limit: number,
  ): Promise<readonly ArtifactCatalogEntry[]> {
    assertMaintenanceLimit(limit);
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const result = await client.query<StoredArtifactRow>(
        `
          SELECT ${SELECT_ARTIFACT_COLUMNS}
          FROM public.proofstack_artifact_catalog
          WHERE tenant_id = $1
            AND project_id = $2
            AND environment_id = $3
            AND state = 'reserved'
            AND created_at <= $4
          ORDER BY created_at, artifact_id
          LIMIT $5
        `,
        [scope.tenantId, scope.projectId, scope.environmentId, createdBefore, limit],
      );
      return result.rows.map(storedEntry);
    });
  }

  async listPendingPurge(
    scope: EvidenceScope,
    limit: number,
  ): Promise<readonly ArtifactCatalogEntry[]> {
    assertMaintenanceLimit(limit);
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const result = await client.query<StoredArtifactRow>(
        `
          SELECT ${SELECT_ARTIFACT_COLUMNS}
          FROM public.proofstack_artifact_catalog
          WHERE tenant_id = $1
            AND project_id = $2
            AND environment_id = $3
            AND state = 'tombstoned'
          ORDER BY tombstoned_at, artifact_id
          LIMIT $4
        `,
        [scope.tenantId, scope.projectId, scope.environmentId, limit],
      );
      return result.rows.map(storedEntry);
    });
  }

  async listKeyReferences(scope: EvidenceScope): Promise<readonly ArtifactKeyReferenceSummary[]> {
    return withTenantTransaction(this.pool, scope.tenantId, async (client) => {
      const result = await client.query<StoredKeyReferenceRow>(
        `
          SELECT
            wrapped_key_id AS key_id,
            state,
            count(*)::text AS reference_count
          FROM public.proofstack_artifact_catalog
          WHERE tenant_id = $1
            AND project_id = $2
            AND environment_id = $3
          GROUP BY wrapped_key_id, state
          ORDER BY wrapped_key_id, state
        `,
        [scope.tenantId, scope.projectId, scope.environmentId],
      );
      return storedKeyReferences(result.rows);
    });
  }
}
