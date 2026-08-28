import {
  OpaqueIdSchema,
  PrincipalContextSchema,
  type ResourceScope,
  ResourceScopeSchema,
  type WorkloadCapability,
} from "@proofstack/contracts";
import {
  ApiKeyLifecycle,
  type ApiKeyCredentialStore,
  type IssueApiKeyOptions,
  type IssuedApiKeyCredential,
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
