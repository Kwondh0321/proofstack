import { OpaqueIdSchema, PrincipalContextSchema, TimestampSchema } from "@proofstack/contracts";
import {
  type ActiveOidcBinding,
  type AuthenticatableBrowserSession,
  type BrowserSessionCreator,
  BrowserSessionConflictError,
  type BrowserSessionLookup,
  type BrowserSessionRevoker,
  type ConsumedOidcLoginTransaction,
  type CreateBrowserSession,
  type CreatedBrowserSession,
  type CreatedOidcLoginTransaction,
  type CreateOidcLoginTransaction,
  OidcBindingNotActiveError,
  type OidcBindingLookup,
  oidcIdentityDigest,
  type OidcLoginTransactionStore,
  OidcLoginTransactionConflictError,
  requireOidcIssuer,
  requireOidcSubject,
} from "@proofstack/identity";
import type { Pool, QueryResultRow } from "pg";
import { PostgresIdentityDataIntegrityError } from "./postgres-api-key-credential-repository.js";

type IdentityPool = Pick<Pool, "query">;

interface ActiveBindingRow extends QueryResultRow {
  readonly binding_id: unknown;
  readonly capabilities: unknown;
  readonly issuer: unknown;
  readonly principal_id: unknown;
  readonly resource_scope: unknown;
  readonly roles: unknown;
  readonly subject: unknown;
  readonly tenant_id: unknown;
}

interface CreatedTransactionRow extends QueryResultRow {
  readonly created_at: unknown;
  readonly expires_at: unknown;
}

interface ConsumedTransactionRow extends QueryResultRow {
  readonly protected_payload: unknown;
  readonly state_digest: unknown;
}

interface CreatedSessionRow extends QueryResultRow {
  readonly absolute_expires_at: unknown;
  readonly created_at: unknown;
  readonly idle_expires_at: unknown;
  readonly session_id: unknown;
}

interface ActiveSessionRow extends QueryResultRow {
  readonly capabilities: unknown;
  readonly created_at: unknown;
  readonly csrf_digest: unknown;
  readonly principal_id: unknown;
  readonly resource_scope: unknown;
  readonly roles: unknown;
  readonly session_digest: unknown;
  readonly session_id: unknown;
  readonly tenant_id: unknown;
}

interface ResultRow extends QueryResultRow {
  readonly result: unknown;
}

interface PostgreSqlError extends Error {
  readonly code?: string;
}

const FIND_BINDING_SQL = `
  SELECT *
  FROM public.proofstack_find_active_oidc_binding($1, $2, $3)
`;

const CREATE_TRANSACTION_SQL = `
  SELECT created_at, expires_at
  FROM public.proofstack_create_oidc_login_transaction($1, $2, $3)
`;

const CONSUME_TRANSACTION_SQL = `
  SELECT protected_payload, state_digest
  FROM public.proofstack_consume_oidc_login_transaction($1)
`;

const PURGE_TRANSACTIONS_SQL = `
  SELECT public.proofstack_purge_oidc_login_transactions() AS result
`;

const CREATE_SESSION_SQL = `
  SELECT absolute_expires_at, created_at, idle_expires_at, session_id
  FROM public.proofstack_create_browser_session($1, $2, $3, $4, $5, $6)
`;

const FIND_SESSION_SQL = `
  SELECT *
  FROM public.proofstack_find_and_touch_active_browser_session($1)
`;

const REVOKE_SESSION_SQL = `
  SELECT public.proofstack_revoke_browser_session($1) AS result
`;

const PURGE_SESSIONS_SQL = `
  SELECT public.proofstack_purge_browser_sessions() AS result
`;

function integrity(message: string, cause?: unknown): never {
  throw new PostgresIdentityDataIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function oneRow<Row extends QueryResultRow>(rows: readonly Row[], operation: string): Row | null {
  if (rows.length > 1) return integrity(`${operation} returned more than one row`);
  return rows[0] ?? null;
}

function timestamp(value: unknown, label: string): string {
  const normalized =
    value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : value;
  const parsed = TimestampSchema.safeParse(normalized);
  if (!parsed.success) return integrity(`Stored ${label} is invalid`, parsed.error);
  return parsed.data;
}

function opaqueId(value: unknown, label: string): string {
  const parsed = OpaqueIdSchema.safeParse(value);
  if (!parsed.success) return integrity(`Stored ${label} is invalid`, parsed.error);
  return parsed.data;
}

function hexDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    return integrity(`Stored ${label} is invalid`);
  }
  return value;
}

function issuer(value: unknown): string {
  if (typeof value !== "string") return integrity("Stored OIDC issuer is invalid");
  try {
    return requireOidcIssuer(value);
  } catch (error) {
    return integrity("Stored OIDC issuer is invalid", error);
  }
}

function subject(value: unknown): string {
  if (typeof value !== "string") return integrity("Stored OIDC subject is invalid");
  try {
    return requireOidcSubject(value);
  } catch (error) {
    return integrity("Stored OIDC subject is invalid", error);
  }
}

function protectedPayload(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 48 ||
    value.length > 4_144 ||
    !/^otx_v1_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{1,4096}_[A-Za-z0-9_-]{22}$/.test(value)
  ) {
    return integrity("Stored OIDC login transaction payload is invalid");
  }
  return value;
}

function authorization(
  row: {
    readonly capabilities: unknown;
    readonly principal_id: unknown;
    readonly resource_scope: unknown;
    readonly roles: unknown;
    readonly tenant_id: unknown;
  },
  credentialId: string,
  authenticatedAt: string,
) {
  const parsed = PrincipalContextSchema.safeParse({
    authentication: { authenticatedAt, credentialId, method: "oidc" },
    capabilities: row.capabilities,
    principalId: row.principal_id,
    principalType: "user",
    requestId: "req_postgres_oidc_validation",
    resourceScope: row.resource_scope,
    roles: row.roles,
    tenantId: row.tenant_id,
  });
  if (!parsed.success) return integrity("Stored OIDC authorization is invalid", parsed.error);
  return parsed.data;
}

function activeBinding(row: ActiveBindingRow): ActiveOidcBinding {
  const bindingId = opaqueId(row.binding_id, "OIDC binding identifier");
  const parsedIssuer = issuer(row.issuer);
  const parsedSubject = subject(row.subject);
  const principal = authorization(row, bindingId, "2000-01-01T00:00:00.000Z");
  return {
    bindingId,
    capabilities: principal.capabilities,
    issuer: parsedIssuer,
    principalId: principal.principalId,
    resourceScope: principal.resourceScope,
    roles: principal.roles,
    subject: parsedSubject,
    tenantId: principal.tenantId,
  };
}

function activeSession(row: ActiveSessionRow): AuthenticatableBrowserSession {
  const sessionId = opaqueId(row.session_id, "browser session identifier");
  const createdAt = timestamp(row.created_at, "browser session creation time");
  const principal = authorization(row, sessionId, createdAt);
  return {
    capabilities: principal.capabilities,
    createdAt,
    csrfDigest: hexDigest(row.csrf_digest, "browser session CSRF digest"),
    principalId: principal.principalId,
    resourceScope: principal.resourceScope,
    roles: principal.roles,
    sessionDigest: hexDigest(row.session_digest, "browser session digest"),
    sessionId,
    tenantId: principal.tenantId,
  };
}

function booleanResult(rows: readonly ResultRow[], operation: string): boolean {
  const row = oneRow(rows, operation);
  if (!row || typeof row.result !== "boolean") {
    return integrity(`${operation} returned an invalid result`);
  }
  return row.result;
}

function purgeResult(rows: readonly ResultRow[], operation: string): number {
  const row = oneRow(rows, operation);
  if (
    !row ||
    typeof row.result !== "number" ||
    !Number.isInteger(row.result) ||
    row.result < 0 ||
    row.result > 1_000
  ) {
    return integrity(`${operation} returned an invalid result`);
  }
  return row.result;
}

function postgresError(error: unknown): PostgreSqlError | undefined {
  return error instanceof Error ? (error as PostgreSqlError) : undefined;
}

export class PostgresOidcIdentityRepository
  implements
    OidcBindingLookup,
    OidcLoginTransactionStore,
    BrowserSessionCreator,
    BrowserSessionLookup,
    BrowserSessionRevoker
{
  constructor(private readonly pool: IdentityPool) {}

  async findActiveByIssuerSubject(
    issuerValue: string,
    subjectValue: string,
  ): Promise<ActiveOidcBinding | null> {
    const digest = oidcIdentityDigest(issuerValue, subjectValue);
    const result = await this.pool.query<ActiveBindingRow>(FIND_BINDING_SQL, [
      digest,
      issuerValue,
      subjectValue,
    ]);
    const row = oneRow(result.rows, "Active OIDC binding lookup");
    return row ? activeBinding(row) : null;
  }

  async create(input: CreateOidcLoginTransaction): Promise<CreatedOidcLoginTransaction>;
  async create(input: CreateBrowserSession): Promise<CreatedBrowserSession>;
  async create(
    input: CreateOidcLoginTransaction | CreateBrowserSession,
  ): Promise<CreatedOidcLoginTransaction | CreatedBrowserSession> {
    if ("stateDigest" in input) return this.createTransaction(input);
    return this.createSession(input);
  }

  async consumeActive(stateDigest: string): Promise<ConsumedOidcLoginTransaction | null> {
    const result = await this.pool.query<ConsumedTransactionRow>(CONSUME_TRANSACTION_SQL, [
      stateDigest,
    ]);
    const row = oneRow(result.rows, "OIDC login transaction consumption");
    return row
      ? {
          protectedPayload: protectedPayload(row.protected_payload),
          stateDigest: hexDigest(row.state_digest, "OIDC login state digest"),
        }
      : null;
  }

  async findAndTouchActive(sessionDigest: string): Promise<AuthenticatableBrowserSession | null> {
    const result = await this.pool.query<ActiveSessionRow>(FIND_SESSION_SQL, [sessionDigest]);
    const row = oneRow(result.rows, "Active browser session lookup");
    return row ? activeSession(row) : null;
  }

  async revokeActive(sessionDigest: string): Promise<boolean> {
    const result = await this.pool.query<ResultRow>(REVOKE_SESSION_SQL, [sessionDigest]);
    return booleanResult(result.rows, "Browser session revocation");
  }

  async purgeExpiredTransactions(): Promise<number> {
    const result = await this.pool.query<ResultRow>(PURGE_TRANSACTIONS_SQL);
    return purgeResult(result.rows, "OIDC login transaction purge");
  }

  async purgeExpiredSessions(): Promise<number> {
    const result = await this.pool.query<ResultRow>(PURGE_SESSIONS_SQL);
    return purgeResult(result.rows, "Browser session purge");
  }

  private async createTransaction(
    input: CreateOidcLoginTransaction,
  ): Promise<CreatedOidcLoginTransaction> {
    try {
      const result = await this.pool.query<CreatedTransactionRow>(CREATE_TRANSACTION_SQL, [
        input.stateDigest,
        input.protectedPayload,
        input.lifetimeSeconds,
      ]);
      const row = oneRow(result.rows, "OIDC login transaction creation");
      if (!row) return integrity("OIDC login transaction creation returned no row");
      return {
        createdAt: timestamp(row.created_at, "OIDC login transaction creation time"),
        expiresAt: timestamp(row.expires_at, "OIDC login transaction expiration time"),
      };
    } catch (error) {
      if (postgresError(error)?.code === "23505") throw new OidcLoginTransactionConflictError();
      throw error;
    }
  }

  private async createSession(input: CreateBrowserSession): Promise<CreatedBrowserSession> {
    try {
      const result = await this.pool.query<CreatedSessionRow>(CREATE_SESSION_SQL, [
        input.sessionId,
        input.sessionDigest,
        input.csrfDigest,
        input.bindingId,
        input.absoluteLifetimeSeconds,
        input.idleLifetimeSeconds,
      ]);
      const row = oneRow(result.rows, "Browser session creation");
      if (!row) return integrity("Browser session creation returned no row");
      return {
        absoluteExpiresAt: timestamp(
          row.absolute_expires_at,
          "browser session absolute expiration time",
        ),
        createdAt: timestamp(row.created_at, "browser session creation time"),
        idleExpiresAt: timestamp(row.idle_expires_at, "browser session idle expiration time"),
        sessionId: opaqueId(row.session_id, "browser session identifier"),
      };
    } catch (error) {
      const databaseError = postgresError(error);
      if (databaseError?.code === "23505") throw new BrowserSessionConflictError();
      if (databaseError?.code === "P0002") throw new OidcBindingNotActiveError();
      throw error;
    }
  }
}
