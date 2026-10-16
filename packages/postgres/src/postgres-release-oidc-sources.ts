import {
  type EvidenceScope,
  EvidenceScopeSchema,
  OpaqueIdSchema,
  type ReleaseDecisionIdentityGrant,
  ReleaseDecisionIdentityGrantSchema,
  type ReleaseDecisionSessionState,
  ReleaseDecisionSessionStateSchema,
} from "@proofstack/contracts";
import type { PoolClient, QueryResultRow } from "pg";
import { PostgresIdentityDataIntegrityError } from "./postgres-api-key-credential-repository.js";

type Client = Pick<PoolClient, "query">;
export type ReleaseOidcSourceKind = "oidc_binding" | "oidc_session";

interface BindingRow extends QueryResultRow {
  tenant_id: unknown;
  binding_id: unknown;
  principal_id: unknown;
  inactive: unknown;
  capabilities: unknown;
  roles: unknown;
  resource_scope: unknown;
  authorization_version: unknown;
  updated_at: unknown;
}

interface SessionRow extends QueryResultRow {
  tenant_id: unknown;
  session_id: unknown;
  binding_id: unknown;
  principal_id: unknown;
  created_at: unknown;
  absolute_expires_at: unknown;
  idle_expires_at: unknown;
  idle_lifetime_seconds: unknown;
  last_used_at: unknown;
  use_count: unknown;
  revoked_at: unknown;
  revocation_reason: unknown;
}

function integrity(): never {
  // Never attach raw rows or a cause containing cookie/CSRF/verifier data.
  throw new PostgresIdentityDataIntegrityError("Stored release OIDC source is inconsistent");
}

function only<Row>(rows: readonly Row[]) {
  if (rows.length > 1) return integrity();
  return rows[0] ?? null;
}

function ordered(value: unknown) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return integrity();
  return [...value].sort(); // Keep duplicates so the owning schema rejects them.
}

/** Acquire on the caller's READ COMMITTED client; false requires its whole rollback. */
export async function tryPostgresReleaseOidcSourceGuardOnClient(
  client: Client,
  kind: ReleaseOidcSourceKind,
  id: string,
): Promise<boolean> {
  if (kind !== "oidc_binding" && kind !== "oidc_session")
    throw new TypeError("Unsupported release OIDC source kind");
  const sourceId = OpaqueIdSchema.parse(id);
  const result = await client.query<{ acquired: unknown }>(
    "SELECT public.proofstack_try_lock_release_oidc_source($1, $2) AS acquired",
    [kind, sourceId],
  );
  if (result.rows.length !== 1 || typeof result.rows[0]?.acquired !== "boolean") return integrity();
  return result.rows[0].acquired;
}

/** Sanitized owning row, including inactive bindings. No authentication or transaction here. */
export async function readPostgresReleaseOidcBindingOnClient(
  client: Client,
  scope: EvidenceScope,
  bindingId: string,
): Promise<ReleaseDecisionIdentityGrant | null> {
  const exact = EvidenceScopeSchema.parse(scope);
  const id = OpaqueIdSchema.parse(bindingId);
  const result = await client.query<BindingRow>(
    `SELECT tenant_id, binding_id, principal_id, roles, capabilities, resource_scope,
       authorization_version, disabled_at IS NOT NULL AS inactive,
       to_char(GREATEST(updated_at, disabled_at) AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
     FROM public.proofstack_oidc_bindings WHERE tenant_id = $1 AND binding_id = $2`,
    [exact.tenantId, id],
  );
  const row = only(result.rows);
  if (row === null) return null;
  if (
    row.tenant_id !== exact.tenantId ||
    row.binding_id !== id ||
    typeof row.inactive !== "boolean"
  )
    return integrity();
  const parsed = ReleaseDecisionIdentityGrantSchema.safeParse({
    identity: { kind: "oidc_binding", bindingId: row.binding_id, principalId: row.principal_id },
    tenantId: row.tenant_id,
    state: row.inactive ? "inactive" : "active",
    capabilities: ordered(row.capabilities),
    roles: ordered(row.roles),
    resourceScope: row.resource_scope,
    revision: row.authorization_version,
    updatedAt: row.updated_at,
  });
  if (!parsed.success) return integrity();
  return parsed.data;
}

/** Exact original session, including expired/revoked records. Never touches or refreshes it. */
export async function readPostgresReleaseOidcSessionOnClient(
  client: Client,
  scope: EvidenceScope,
  sessionId: string,
): Promise<ReleaseDecisionSessionState | null> {
  const exact = EvidenceScopeSchema.parse(scope);
  const id = OpaqueIdSchema.parse(sessionId);
  const result = await client.query<SessionRow>(
    `SELECT session.tenant_id, session.session_id, session.binding_id, binding.principal_id,
       session.idle_lifetime_seconds, session.use_count, session.revocation_reason,
       to_char(session.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
       to_char(session.absolute_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS absolute_expires_at,
       to_char(session.idle_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS idle_expires_at,
       to_char(session.last_used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_used_at,
       to_char(session.revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revoked_at
     FROM public.proofstack_browser_sessions AS session
     LEFT JOIN public.proofstack_oidc_bindings AS binding
       ON binding.tenant_id = session.tenant_id AND binding.binding_id = session.binding_id
     WHERE session.tenant_id = $1 AND session.session_id = $2`,
    [exact.tenantId, id],
  );
  const row = only(result.rows);
  if (row === null) return null;
  if (row.tenant_id !== exact.tenantId || row.session_id !== id) return integrity();
  const parsed = ReleaseDecisionSessionStateSchema.safeParse({
    schemaVersion: "0.1",
    kind: "oidc_session",
    credentialId: row.session_id,
    tenantId: row.tenant_id,
    bindingId: row.binding_id,
    principalId: row.principal_id,
    createdAt: row.created_at,
    absoluteExpiresAt: row.absolute_expires_at,
    idleExpiresAt: row.idle_expires_at,
    idleLifetimeSeconds: row.idle_lifetime_seconds,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason,
  });
  if (!parsed.success) return integrity();
  return parsed.data;
}
