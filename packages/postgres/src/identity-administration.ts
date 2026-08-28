import {
  type Capability,
  OpaqueIdSchema,
  PrincipalContextSchema,
  type ResourceScope,
  ResourceScopeSchema,
  type Role,
  TimestampSchema,
  type WorkloadCapability,
} from "@proofstack/contracts";
import {
  ApiKeyLifecycle,
  type ApiKeyCredentialStore,
  type IssueApiKeyOptions,
  type IssuedApiKeyCredential,
  oidcIdentityDigest,
  requireOidcIssuer,
  requireOidcSubject,
} from "@proofstack/identity";
import type { Pool, QueryResultRow } from "pg";
import { assertMigrationsCurrent } from "./migration-runner.js";
import { PostgresApiKeyCredentialRepository } from "./postgres-api-key-credential-repository.js";
import { withTenantTransaction } from "./tenant-transaction.js";

type IdentityAdministrationPool = Pick<Pool, "connect" | "query">;

export interface BootstrapApiKeyOptions {
  readonly actorPrincipalId: string;
  readonly capabilities: readonly WorkloadCapability[];
  readonly expiresAt?: string;
  readonly name: string;
  readonly resourceScope: ResourceScope;
  readonly tenantId: string;
}

export interface IdentityCredentialStatus {
  readonly active: number;
  readonly expired: number;
  readonly revoked: number;
  readonly tenantId: string;
  readonly total: number;
}

export interface CreateOidcBindingOptions {
  readonly actorPrincipalId: string;
  readonly bindingId: string;
  readonly capabilities: readonly Capability[];
  readonly issuer: string;
  readonly principalId: string;
  readonly resourceScope: ResourceScope;
  readonly roles: readonly Role[];
  readonly subject: string;
  readonly tenantId: string;
}

export interface UpdateOidcBindingOptions {
  readonly actorPrincipalId: string;
  readonly bindingId: string;
  readonly capabilities: readonly Capability[];
  readonly resourceScope: ResourceScope;
  readonly roles: readonly Role[];
  readonly tenantId: string;
}

export interface DisableOidcBindingOptions {
  readonly actorPrincipalId: string;
  readonly bindingId: string;
  readonly reason: string;
  readonly tenantId: string;
}

export interface CreatedOidcBinding {
  readonly bindingId: string;
  readonly createdAt: string;
  readonly identityDigest: string;
  readonly issuer: string;
  readonly principalId: string;
  readonly subject: string;
  readonly tenantId: string;
}

interface IdentityStatusRow extends QueryResultRow {
  readonly active: unknown;
  readonly expired: unknown;
  readonly revoked: unknown;
  readonly total: unknown;
}

interface IdentityAdministrationDependencies {
  readonly assertCurrent: typeof assertMigrationsCurrent;
  readonly createLifecycle: (store: ApiKeyCredentialStore) => Pick<ApiKeyLifecycle, "issue">;
  readonly createRepository: (pool: IdentityAdministrationPool) => ApiKeyCredentialStore;
  readonly now: () => Date;
}

interface TimestampRow extends QueryResultRow {
  readonly result: unknown;
}

interface BooleanRow extends QueryResultRow {
  readonly result: unknown;
}

const defaultDependencies: IdentityAdministrationDependencies = {
  assertCurrent: assertMigrationsCurrent,
  createLifecycle: (store) => new ApiKeyLifecycle(store),
  createRepository: (pool) => new PostgresApiKeyCredentialRepository(pool),
  now: () => new Date(),
};

const STATUS_SQL = `
  SELECT
    count(*) FILTER (
      WHERE revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
    )::integer AS active,
    count(*) FILTER (
      WHERE revoked_at IS NULL AND expires_at <= CURRENT_TIMESTAMP
    )::integer AS expired,
    count(*) FILTER (WHERE revoked_at IS NOT NULL)::integer AS revoked,
    count(*)::integer AS total
  FROM public.proofstack_api_key_credentials
  WHERE tenant_id = $1
`;

const CREATE_OIDC_BINDING_SQL = `
  SELECT created_at AS result
  FROM public.proofstack_create_oidc_binding(
    $1, $2, $3, $4, $5, $6, $7::text[], $8::text[], $9::jsonb, $10
  )
`;

const UPDATE_OIDC_BINDING_SQL = `
  SELECT updated_at AS result
  FROM public.proofstack_update_oidc_binding(
    $1, $2, $3::text[], $4::text[], $5::jsonb, $6
  )
`;

const DISABLE_OIDC_BINDING_SQL = `
  SELECT public.proofstack_disable_oidc_binding($1, $2, $3, $4) AS result
`;

function requiredOpaqueId(value: string, label: string): string {
  const parsed = OpaqueIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError(`${label} is invalid`);
  return parsed.data;
}

function bootstrapIssueOptions(options: BootstrapApiKeyOptions, now: Date): IssueApiKeyOptions {
  const tenantId = requiredOpaqueId(options.tenantId, "Bootstrap tenant identifier");
  const actorPrincipalId = requiredOpaqueId(
    options.actorPrincipalId,
    "Bootstrap actor principal identifier",
  );
  const resourceScope = ResourceScopeSchema.parse(options.resourceScope);
  const issuer = PrincipalContextSchema.parse({
    authentication: {
      authenticatedAt: now.toISOString(),
      credentialId: "sys_database_administration",
      method: "service_token",
    },
    capabilities: ["identity:manage", ...options.capabilities],
    principalId: actorPrincipalId,
    principalType: "user",
    requestId: "req_identity_bootstrap",
    resourceScope: { mode: "tenant" },
    roles: ["owner"],
    tenantId,
  });

  return {
    capabilities: options.capabilities,
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    issuer,
    name: options.name,
    resourceScope,
  };
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Identity status returned an invalid ${label} count`);
  }
  return value as number;
}

function oidcAuthorization(options: CreateOidcBindingOptions | UpdateOidcBindingOptions) {
  const tenantId = requiredOpaqueId(options.tenantId, "OIDC binding tenant identifier");
  const bindingId = requiredOpaqueId(options.bindingId, "OIDC binding identifier");
  const actorPrincipalId = requiredOpaqueId(
    options.actorPrincipalId,
    "OIDC binding actor principal identifier",
  );
  const principalId =
    "principalId" in options
      ? requiredOpaqueId(options.principalId, "OIDC binding principal identifier")
      : actorPrincipalId;
  const authorization = PrincipalContextSchema.parse({
    authentication: {
      authenticatedAt: "2000-01-01T00:00:00.000Z",
      credentialId: bindingId,
      method: "oidc",
    },
    capabilities: options.capabilities,
    principalId,
    principalType: "user",
    requestId: "req_oidc_binding_administration",
    resourceScope: options.resourceScope,
    roles: options.roles,
    tenantId,
  });
  return { actorPrincipalId, authorization, bindingId, tenantId };
}

function timestampResult(rows: readonly TimestampRow[], operation: string): string {
  const row = rows[0];
  if (!row || rows.length !== 1) throw new TypeError(`${operation} returned an invalid row count`);
  const normalized =
    row.result instanceof Date && !Number.isNaN(row.result.getTime())
      ? row.result.toISOString()
      : row.result;
  const parsed = TimestampSchema.safeParse(normalized);
  if (!parsed.success) throw new TypeError(`${operation} returned an invalid timestamp`);
  return parsed.data;
}

function disableReason(value: string): string {
  if (
    value.length === 0 ||
    Array.from(value).length > 512 ||
    value !== value.trim() ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    throw new TypeError("OIDC binding disable reason is invalid");
  }
  return value;
}

export async function bootstrapApiKey(
  pool: IdentityAdministrationPool,
  options: BootstrapApiKeyOptions,
  dependencies: IdentityAdministrationDependencies = defaultDependencies,
): Promise<IssuedApiKeyCredential> {
  const issueOptions = bootstrapIssueOptions(options, dependencies.now());
  await dependencies.assertCurrent(pool);
  const lifecycle = dependencies.createLifecycle(dependencies.createRepository(pool));
  return lifecycle.issue(issueOptions);
}

export async function inspectIdentityCredentials(
  pool: IdentityAdministrationPool,
  tenantIdInput: string,
  dependencies: Pick<IdentityAdministrationDependencies, "assertCurrent"> = defaultDependencies,
): Promise<IdentityCredentialStatus> {
  const tenantId = requiredOpaqueId(tenantIdInput, "Identity status tenant identifier");
  await dependencies.assertCurrent(pool);
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query<IdentityStatusRow>(STATUS_SQL, [tenantId]);
    const row = result.rows[0];
    if (!row || result.rows.length !== 1) {
      throw new TypeError("Identity status returned an invalid row count");
    }
    return {
      active: count(row.active, "active"),
      expired: count(row.expired, "expired"),
      revoked: count(row.revoked, "revoked"),
      tenantId,
      total: count(row.total, "total"),
    };
  });
}

export async function createOidcBinding(
  pool: IdentityAdministrationPool,
  options: CreateOidcBindingOptions,
  dependencies: Pick<IdentityAdministrationDependencies, "assertCurrent"> = defaultDependencies,
): Promise<CreatedOidcBinding> {
  const validated = oidcAuthorization(options);
  const issuer = requireOidcIssuer(options.issuer);
  const subject = requireOidcSubject(options.subject);
  const identityDigest = oidcIdentityDigest(issuer, subject);
  await dependencies.assertCurrent(pool);
  return withTenantTransaction(pool, validated.tenantId, async (client) => {
    const result = await client.query<TimestampRow>(CREATE_OIDC_BINDING_SQL, [
      validated.tenantId,
      validated.bindingId,
      identityDigest,
      issuer,
      subject,
      validated.authorization.principalId,
      validated.authorization.roles,
      validated.authorization.capabilities,
      JSON.stringify(validated.authorization.resourceScope),
      validated.actorPrincipalId,
    ]);
    return {
      bindingId: validated.bindingId,
      createdAt: timestampResult(result.rows, "OIDC binding creation"),
      identityDigest,
      issuer,
      principalId: validated.authorization.principalId,
      subject,
      tenantId: validated.tenantId,
    };
  });
}

export async function updateOidcBinding(
  pool: IdentityAdministrationPool,
  options: UpdateOidcBindingOptions,
  dependencies: Pick<IdentityAdministrationDependencies, "assertCurrent"> = defaultDependencies,
): Promise<{ readonly bindingId: string; readonly tenantId: string; readonly updatedAt: string }> {
  const validated = oidcAuthorization(options);
  await dependencies.assertCurrent(pool);
  return withTenantTransaction(pool, validated.tenantId, async (client) => {
    const result = await client.query<TimestampRow>(UPDATE_OIDC_BINDING_SQL, [
      validated.tenantId,
      validated.bindingId,
      validated.authorization.roles,
      validated.authorization.capabilities,
      JSON.stringify(validated.authorization.resourceScope),
      validated.actorPrincipalId,
    ]);
    return {
      bindingId: validated.bindingId,
      tenantId: validated.tenantId,
      updatedAt: timestampResult(result.rows, "OIDC binding update"),
    };
  });
}

export async function disableOidcBinding(
  pool: IdentityAdministrationPool,
  options: DisableOidcBindingOptions,
  dependencies: Pick<IdentityAdministrationDependencies, "assertCurrent"> = defaultDependencies,
): Promise<boolean> {
  const tenantId = requiredOpaqueId(options.tenantId, "OIDC binding tenant identifier");
  const bindingId = requiredOpaqueId(options.bindingId, "OIDC binding identifier");
  const actorPrincipalId = requiredOpaqueId(
    options.actorPrincipalId,
    "OIDC binding actor principal identifier",
  );
  const reason = disableReason(options.reason);
  await dependencies.assertCurrent(pool);
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query<BooleanRow>(DISABLE_OIDC_BINDING_SQL, [
      tenantId,
      bindingId,
      actorPrincipalId,
      reason,
    ]);
    const row = result.rows[0];
    if (!row || result.rows.length !== 1 || typeof row.result !== "boolean") {
      throw new TypeError("OIDC binding disable returned an invalid result");
    }
    return row.result;
  });
}
