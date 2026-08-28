import {
  OpaqueIdSchema,
  ResourceScopeSchema,
  TimestampSchema,
  type WorkloadCapability,
  WorkloadCapabilitySchema,
} from "@proofstack/contracts";
import {
  ApiKeyCredentialConflictError,
  type ApiKeyCredentialLookup,
  ApiKeyCredentialNotActiveError,
  ApiKeyCredentialNotFoundError,
  type ApiKeyCredentialStore,
  type ApiKeyPasswordHash,
  type ApiKeyUseConfirmation,
  type AuthenticatableApiKey,
  type CreateApiKeyCredential,
  type ManagedApiKeyCredential,
  type RotateApiKeyCredential,
} from "@proofstack/identity";
import type { Pool, QueryResultRow } from "pg";
import { withTenantTransaction } from "./tenant-transaction.js";

type IdentityPool = Pick<Pool, "connect" | "query">;

interface ActiveApiKeyRow extends QueryResultRow {
  readonly authenticated_at: unknown;
  readonly capabilities: unknown;
  readonly credential_id: unknown;
  readonly hash_algorithm: unknown;
  readonly hash_block_size: unknown;
  readonly hash_cost: unknown;
  readonly hash_digest: unknown;
  readonly hash_key_length: unknown;
  readonly hash_parallelization: unknown;
  readonly hash_salt: unknown;
  readonly key_prefix: unknown;
  readonly principal_id: unknown;
  readonly resource_scope: unknown;
  readonly tenant_id: unknown;
}

interface ManagedApiKeyRow extends QueryResultRow {
  readonly capabilities: unknown;
  readonly created_at: unknown;
  readonly credential_id: unknown;
  readonly display_name: unknown;
  readonly expires_at: unknown;
  readonly key_prefix: unknown;
  readonly principal_id: unknown;
  readonly resource_scope: unknown;
  readonly revoked_at: unknown;
  readonly rotated_from_credential_id: unknown;
  readonly tenant_id: unknown;
}

interface TimestampRow extends QueryResultRow {
  readonly created_at: unknown;
}

interface BooleanRow extends QueryResultRow {
  readonly result: unknown;
}

interface PostgreSqlError extends Error {
  readonly code?: string;
}

const FIND_ACTIVE_SQL = `
  SELECT *
  FROM public.proofstack_find_active_api_key($1)
`;

const CONFIRM_ACTIVE_USE_SQL = `
  SELECT public.proofstack_record_api_key_use($1, $2, $3) AS result
`;

const FIND_MANAGED_SQL = `
  SELECT *
  FROM public.proofstack_find_api_key($1, $2)
`;

const CREATE_SQL = `
  SELECT created_at
  FROM public.proofstack_create_api_key(
    $1,
    $2,
    $3,
    $4,
    $5,
    $6::text[],
    $7::jsonb,
    $8,
    $9,
    $10,
    $11,
    $12,
    $13,
    $14,
    $15,
    $16
  )
`;

const ROTATE_SQL = `
  SELECT created_at
  FROM public.proofstack_rotate_api_key(
    $1,
    $2,
    $3,
    $4,
    $5,
    $6,
    $7,
    $8,
    $9,
    $10,
    $11,
    $12,
    $13
  )
`;

const REVOKE_SQL = `
  SELECT public.proofstack_revoke_api_key($1, $2, $3, $4) AS result
`;

export class PostgresIdentityDataIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PostgresIdentityDataIntegrityError";
  }
}

function integrity(message: string, cause?: unknown): never {
  throw new PostgresIdentityDataIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function opaqueId(value: unknown, label: string): string {
  const parsed = OpaqueIdSchema.safeParse(value);
  if (!parsed.success) integrity(`Stored ${label} is invalid`, parsed.error);
  return parsed.data;
}

function timestamp(value: unknown, label: string): string {
  const normalized =
    value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : value;
  const parsed = TimestampSchema.safeParse(normalized);
  if (!parsed.success) integrity(`Stored ${label} is invalid`, parsed.error);
  return parsed.data;
}

function optionalTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function capabilities(value: unknown): readonly WorkloadCapability[] {
  if (!Array.isArray(value) || value.length === 0) {
    return integrity("Stored API key capabilities are invalid");
  }
  const result: WorkloadCapability[] = [];
  for (const capability of value) {
    const parsed = WorkloadCapabilitySchema.safeParse(capability);
    if (!parsed.success) {
      return integrity("Stored API key capabilities are invalid", parsed.error);
    }
    result.push(parsed.data);
  }
  if (new Set(result).size !== result.length) {
    return integrity("Stored API key capabilities contain duplicates");
  }
  return result;
}

function resourceScope(value: unknown) {
  const parsed = ResourceScopeSchema.safeParse(value);
  if (!parsed.success) integrity("Stored API key resource scope is invalid", parsed.error);
  return parsed.data;
}

function boundedString(
  value: unknown,
  label: string,
  pattern: RegExp,
  minimumLength: number,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    !pattern.test(value)
  ) {
    return integrity(`Stored ${label} is invalid`);
  }
  return value;
}

function passwordHash(row: ActiveApiKeyRow): ApiKeyPasswordHash {
  if (
    row.hash_algorithm !== "scrypt-v1" ||
    row.hash_cost !== 32_768 ||
    row.hash_block_size !== 8 ||
    row.hash_parallelization !== 1 ||
    row.hash_key_length !== 32
  ) {
    return integrity("Stored API key hash profile is unsupported");
  }
  return {
    algorithm: "scrypt-v1",
    blockSize: 8,
    cost: 32_768,
    digest: boundedString(row.hash_digest, "API key hash digest", /^[A-Za-z0-9_-]{43}$/, 43, 43),
    keyLength: 32,
    parallelization: 1,
    salt: boundedString(row.hash_salt, "API key hash salt", /^[A-Za-z0-9_-]{22}$/, 22, 22),
  };
}

function oneRow<Row extends QueryResultRow>(rows: readonly Row[], label: string): Row | null {
  if (rows.length > 1) return integrity(`${label} returned more than one row`);
  return rows[0] ?? null;
}

function activeCredential(row: ActiveApiKeyRow): AuthenticatableApiKey {
  return {
    authenticatedAt: timestamp(row.authenticated_at, "API key authentication time"),
    capabilities: capabilities(row.capabilities),
    credentialId: opaqueId(row.credential_id, "API key credential identifier"),
    passwordHash: passwordHash(row),
    prefix: boundedString(row.key_prefix, "API key prefix", /^[A-Za-z0-9_-]{12}$/, 12, 12),
    principalId: opaqueId(row.principal_id, "API key principal identifier"),
    resourceScope: resourceScope(row.resource_scope),
    tenantId: opaqueId(row.tenant_id, "API key tenant identifier"),
  };
}

function managedCredential(row: ManagedApiKeyRow): ManagedApiKeyCredential {
  const displayName = boundedString(
    row.display_name,
    "API key display name",
    /^\S(?:.*\S)?$/s,
    1,
    128,
  );
  if (
    Array.from(displayName).length > 128 ||
    Array.from(displayName).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    return integrity("Stored API key display name is invalid");
  }
  return {
    capabilities: capabilities(row.capabilities),
    createdAt: timestamp(row.created_at, "API key creation time"),
    credentialId: opaqueId(row.credential_id, "API key credential identifier"),
    expiresAt: timestamp(row.expires_at, "API key expiration time"),
    name: displayName,
    prefix: boundedString(row.key_prefix, "API key prefix", /^[A-Za-z0-9_-]{12}$/, 12, 12),
    principalId: opaqueId(row.principal_id, "API key principal identifier"),
    resourceScope: resourceScope(row.resource_scope),
    revokedAt: optionalTimestamp(row.revoked_at, "API key revocation time"),
    rotatedFromCredentialId:
      row.rotated_from_credential_id === null
        ? null
        : opaqueId(row.rotated_from_credential_id, "rotated API key credential identifier"),
    tenantId: opaqueId(row.tenant_id, "API key tenant identifier"),
  };
}

function timestampResult(rows: readonly TimestampRow[], operation: string): string {
  const row = oneRow(rows, operation);
  if (!row) return integrity(`${operation} returned no row`);
  return timestamp(row.created_at, `${operation} creation time`);
}

function booleanResult(rows: readonly BooleanRow[], operation: string): boolean {
  const row = oneRow(rows, operation);
  if (!row || typeof row.result !== "boolean") {
    return integrity(`${operation} returned an invalid result`);
  }
  return row.result;
}

function postgresError(error: unknown): PostgreSqlError | undefined {
  return error instanceof Error ? (error as PostgreSqlError) : undefined;
}

function createValues(input: CreateApiKeyCredential): readonly unknown[] {
  return [
    input.tenantId,
    input.credentialId,
    input.prefix,
    input.principalId,
    input.name,
    input.capabilities,
    JSON.stringify(input.resourceScope),
    input.passwordHash.algorithm,
    input.passwordHash.cost,
    input.passwordHash.blockSize,
    input.passwordHash.parallelization,
    input.passwordHash.keyLength,
    input.passwordHash.salt,
    input.passwordHash.digest,
    input.expiresAt,
    input.actorPrincipalId,
  ];
}

export class PostgresApiKeyCredentialRepository
  implements ApiKeyCredentialLookup, ApiKeyCredentialStore
{
  constructor(private readonly pool: IdentityPool) {}

  async findActiveByPrefix(prefix: string): Promise<AuthenticatableApiKey | null> {
    const result = await this.pool.query<ActiveApiKeyRow>(FIND_ACTIVE_SQL, [prefix]);
    const row = oneRow(result.rows, "Active API key lookup");
    return row ? activeCredential(row) : null;
  }

  async confirmActiveUse(input: ApiKeyUseConfirmation): Promise<boolean> {
    const result = await this.pool.query<BooleanRow>(CONFIRM_ACTIVE_USE_SQL, [
      input.tenantId,
      input.credentialId,
      input.prefix,
    ]);
    return booleanResult(result.rows, "API key use confirmation");
  }

  async findById(tenantId: string, credentialId: string): Promise<ManagedApiKeyCredential | null> {
    return withTenantTransaction(this.pool, tenantId, async (client) => {
      const result = await client.query<ManagedApiKeyRow>(FIND_MANAGED_SQL, [
        tenantId,
        credentialId,
      ]);
      const row = oneRow(result.rows, "Managed API key lookup");
      return row ? managedCredential(row) : null;
    });
  }

  async create(input: CreateApiKeyCredential): Promise<{ readonly createdAt: string }> {
    try {
      return await withTenantTransaction(this.pool, input.tenantId, async (client) => {
        const result = await client.query<TimestampRow>(CREATE_SQL, [...createValues(input)]);
        return { createdAt: timestampResult(result.rows, "API key creation") };
      });
    } catch (error) {
      if (postgresError(error)?.code === "23505") throw new ApiKeyCredentialConflictError();
      throw error;
    }
  }

  async rotate(input: RotateApiKeyCredential): Promise<{ readonly createdAt: string }> {
    const credential = input.credential;
    try {
      return await withTenantTransaction(this.pool, credential.tenantId, async (client) => {
        const hash = credential.passwordHash;
        const result = await client.query<TimestampRow>(ROTATE_SQL, [
          credential.tenantId,
          input.previousCredentialId,
          credential.credentialId,
          credential.prefix,
          hash.algorithm,
          hash.cost,
          hash.blockSize,
          hash.parallelization,
          hash.keyLength,
          hash.salt,
          hash.digest,
          credential.expiresAt,
          input.actorPrincipalId,
        ]);
        return { createdAt: timestampResult(result.rows, "API key rotation") };
      });
    } catch (error) {
      const databaseError = postgresError(error);
      if (databaseError?.code === "23505") throw new ApiKeyCredentialConflictError();
      if (databaseError?.code === "P0002") {
        throw new ApiKeyCredentialNotFoundError(input.previousCredentialId);
      }
      if (
        databaseError?.code === "55000" &&
        databaseError.message === "ProofStack API key credential is not active"
      ) {
        throw new ApiKeyCredentialNotActiveError(input.previousCredentialId);
      }
      throw error;
    }
  }

  async revoke(
    tenantId: string,
    credentialId: string,
    actorPrincipalId: string,
    reason: string,
  ): Promise<boolean> {
    try {
      return await withTenantTransaction(this.pool, tenantId, async (client) => {
        const result = await client.query<BooleanRow>(REVOKE_SQL, [
          tenantId,
          credentialId,
          actorPrincipalId,
          reason,
        ]);
        return booleanResult(result.rows, "API key revocation");
      });
    } catch (error) {
      if (postgresError(error)?.code === "P0002") {
        throw new ApiKeyCredentialNotFoundError(credentialId);
      }
      throw error;
    }
  }
}
