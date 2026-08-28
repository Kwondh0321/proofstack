import type { Pool, PoolClient, QueryResultRow } from "pg";
import { assertMigrationsCurrentOnClient } from "./migration-runner.js";
import { PostgresTransactionCleanupError } from "./tenant-transaction.js";

export const DEFAULT_RUNTIME_ROLE_NAMES = {
  api: "proofstack_api",
  consumer: "proofstack_consumer",
  identity: "proofstack_identity",
  publisher: "proofstack_publisher",
} as const;

const ROLE_NAME_PATTERN = /^[a-z][a-z0-9_]{2,62}$/;
const MIN_ROLE_PASSWORD_LENGTH = 16;
const MAX_ROLE_PASSWORD_LENGTH = 1_024;
const PROVISIONING_LOCK_NAMESPACE = 1_347_571_531;
const PROVISIONING_LOCK_RESOURCE = 1_380_995_663;

type RuntimeRoleKind = keyof typeof DEFAULT_RUNTIME_ROLE_NAMES;

export interface RuntimeRoleCredentials {
  readonly name: string;
  readonly password: string;
}

export interface RuntimeRoleProvisioningOptions {
  readonly api: RuntimeRoleCredentials;
  readonly consumer: RuntimeRoleCredentials;
  readonly identity: RuntimeRoleCredentials;
  readonly publisher: RuntimeRoleCredentials;
}

export interface RuntimeRoleProvisioningResult {
  readonly createdRoles: readonly string[];
  readonly updatedRoles: readonly string[];
}

interface RoleInspectionRow extends QueryResultRow {
  readonly has_memberships: boolean;
  readonly marker: string | null;
  readonly rolbypassrls: boolean;
  readonly rolcreatedb: boolean;
  readonly rolcreaterole: boolean;
  readonly rolreplication: boolean;
  readonly rolsuper: boolean;
}

interface StatementRow extends QueryResultRow {
  readonly statement: string;
}

const PLATFORM_TABLES = [
  "proofstack_api_key_credentials",
  "proofstack_consumer_receipts",
  "proofstack_evidence_events",
  "proofstack_identity_audit_events",
  "proofstack_outbox",
  "proofstack_projection_cursors",
  "proofstack_schema_migrations",
] as const;

const PLATFORM_FUNCTIONS = [
  "public.proofstack_create_api_key(text, text, text, text, text, text[], jsonb, text, integer, integer, integer, integer, text, text, timestamptz, text)",
  "public.proofstack_find_active_api_key(text)",
  "public.proofstack_find_api_key(text, text)",
  "public.proofstack_guard_api_key_mutation()",
  "public.proofstack_guard_consumer_receipt_transition()",
  "public.proofstack_guard_outbox_mutation()",
  "public.proofstack_guard_projection_cursor()",
  "public.proofstack_record_api_key_use(text, text, text)",
  "public.proofstack_reject_evidence_mutation()",
  "public.proofstack_reject_identity_audit_mutation()",
  "public.proofstack_require_identity_tenant(text)",
  "public.proofstack_revoke_api_key(text, text, text, text)",
  "public.proofstack_rotate_api_key(text, text, text, text, text, integer, integer, integer, integer, text, text, timestamptz, text)",
  "public.proofstack_valid_resource_scope(jsonb)",
  "public.proofstack_valid_workload_capabilities(text[])",
  "public.proofstack_write_identity_audit(text, text, text, text, text, text, text, timestamptz)",
] as const;

const GRANTS: Record<RuntimeRoleKind, readonly string[]> = {
  api: [
    "GRANT SELECT ON TABLE public.proofstack_schema_migrations TO %ROLE%",
    "GRANT SELECT, INSERT ON TABLE public.proofstack_evidence_events TO %ROLE%",
    "GRANT INSERT ON TABLE public.proofstack_outbox TO %ROLE%",
  ],
  consumer: [
    "GRANT SELECT, INSERT, UPDATE ON TABLE public.proofstack_consumer_receipts TO %ROLE%",
    "GRANT SELECT, INSERT, UPDATE ON TABLE public.proofstack_projection_cursors TO %ROLE%",
  ],
  identity: [
    "GRANT SELECT ON TABLE public.proofstack_schema_migrations TO %ROLE%",
    "GRANT EXECUTE ON FUNCTION public.proofstack_find_active_api_key(text) TO %ROLE%",
    "GRANT EXECUTE ON FUNCTION public.proofstack_find_api_key(text, text) TO %ROLE%",
    "GRANT EXECUTE ON FUNCTION public.proofstack_create_api_key(text, text, text, text, text, text[], jsonb, text, integer, integer, integer, integer, text, text, timestamptz, text) TO %ROLE%",
    "GRANT EXECUTE ON FUNCTION public.proofstack_rotate_api_key(text, text, text, text, text, integer, integer, integer, integer, text, text, timestamptz, text) TO %ROLE%",
    "GRANT EXECUTE ON FUNCTION public.proofstack_revoke_api_key(text, text, text, text) TO %ROLE%",
    "GRANT EXECUTE ON FUNCTION public.proofstack_record_api_key_use(text, text, text) TO %ROLE%",
  ],
  publisher: ["GRANT SELECT, UPDATE ON TABLE public.proofstack_outbox TO %ROLE%"],
};

export class RuntimeRoleProvisioningError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeRoleProvisioningError";
  }
}

function validateCredentials(
  kind: RuntimeRoleKind,
  credentials: RuntimeRoleCredentials,
): RuntimeRoleCredentials {
  if (!ROLE_NAME_PATTERN.test(credentials.name)) {
    throw new RuntimeRoleProvisioningError(
      `${kind} role name must match ${ROLE_NAME_PATTERN.source}`,
    );
  }
  if (
    credentials.password.length < MIN_ROLE_PASSWORD_LENGTH ||
    credentials.password.length > MAX_ROLE_PASSWORD_LENGTH ||
    credentials.password.includes("\0")
  ) {
    throw new RuntimeRoleProvisioningError(
      `${kind} role password must contain between ${MIN_ROLE_PASSWORD_LENGTH} and ${MAX_ROLE_PASSWORD_LENGTH} non-NUL characters`,
    );
  }
  return credentials;
}

function validateOptions(options: RuntimeRoleProvisioningOptions): RuntimeRoleProvisioningOptions {
  const validated = {
    api: validateCredentials("api", options.api),
    consumer: validateCredentials("consumer", options.consumer),
    identity: validateCredentials("identity", options.identity),
    publisher: validateCredentials("publisher", options.publisher),
  };
  const names = Object.values(validated).map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    throw new RuntimeRoleProvisioningError("Runtime database role names must be distinct");
  }
  return validated;
}

function quotedRole(roleName: string): string {
  return `"${roleName}"`;
}

function markerFor(kind: RuntimeRoleKind): string {
  return `proofstack-managed-runtime-role:v1:${kind}`;
}

async function formattedRoleStatement(
  client: PoolClient,
  operation: "ALTER" | "CREATE",
  roleName: string,
  password: string,
): Promise<string> {
  const result = await client.query<StatementRow>(
    `SELECT format(
      '${operation} ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      $1::text,
      $2::text
    ) AS statement`,
    [roleName, password],
  );
  const statement = result.rows[0]?.statement;
  if (!statement)
    throw new RuntimeRoleProvisioningError("PostgreSQL did not format a role statement");
  return statement;
}

async function inspectRole(
  client: PoolClient,
  roleName: string,
): Promise<RoleInspectionRow | null> {
  const result = await client.query<RoleInspectionRow>(
    `
      SELECT
        rolsuper,
        rolcreatedb,
        rolcreaterole,
        rolreplication,
        rolbypassrls,
        shobj_description(oid, 'pg_authid') AS marker,
        EXISTS (
          SELECT 1
          FROM pg_auth_members
          WHERE roleid = pg_roles.oid OR member = pg_roles.oid
        ) AS has_memberships
      FROM pg_roles
      WHERE rolname = $1
    `,
    [roleName],
  );
  return result.rows[0] ?? null;
}

function assertManagedRole(kind: RuntimeRoleKind, roleName: string, row: RoleInspectionRow): void {
  if (row.marker !== markerFor(kind)) {
    throw new RuntimeRoleProvisioningError(
      `Refusing to modify existing unmanaged PostgreSQL role ${roleName}`,
    );
  }
  if (
    row.rolsuper ||
    row.rolcreatedb ||
    row.rolcreaterole ||
    row.rolreplication ||
    row.rolbypassrls ||
    row.has_memberships
  ) {
    throw new RuntimeRoleProvisioningError(
      `Managed PostgreSQL role ${roleName} has elevated attributes or memberships`,
    );
  }
}

async function provisionRole(
  client: PoolClient,
  kind: RuntimeRoleKind,
  credentials: RuntimeRoleCredentials,
): Promise<"created" | "updated"> {
  const existing = await inspectRole(client, credentials.name);
  const operation = existing ? "ALTER" : "CREATE";
  if (existing) assertManagedRole(kind, credentials.name, existing);

  const roleStatement = await formattedRoleStatement(
    client,
    operation,
    credentials.name,
    credentials.password,
  );
  await client.query(roleStatement);
  const role = quotedRole(credentials.name);
  if (!existing) {
    await client.query(`COMMENT ON ROLE ${role} IS '${markerFor(kind)}'`);
  }

  await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await client.query(
    `REVOKE ALL PRIVILEGES ON TABLE ${PLATFORM_TABLES.map((table) => `public.${table}`).join(", ")} FROM ${role}`,
  );
  await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${role}`);
  await client.query(
    `REVOKE ALL PRIVILEGES ON FUNCTION ${PLATFORM_FUNCTIONS.join(", ")} FROM ${role}`,
  );
  for (const grant of GRANTS[kind]) {
    await client.query(grant.replace("%ROLE%", role));
  }
  return existing ? "updated" : "created";
}

async function assertSchemaCurrent(client: PoolClient): Promise<void> {
  try {
    await assertMigrationsCurrentOnClient(client);
  } catch (error) {
    throw new RuntimeRoleProvisioningError(
      "ProofStack migrations must be current before provisioning runtime roles",
      { cause: error },
    );
  }

  const result = await client.query<{ readonly present: boolean }>(`
    SELECT every(to_regclass(name) IS NOT NULL) AS present
    FROM unnest(ARRAY[
      'public.proofstack_schema_migrations',
      'public.proofstack_api_key_credentials',
      'public.proofstack_evidence_events',
      'public.proofstack_identity_audit_events',
      'public.proofstack_outbox',
      'public.proofstack_projection_cursors',
      'public.proofstack_consumer_receipts'
    ]) AS required(name)
  `);
  if (result.rows[0]?.present !== true) {
    throw new RuntimeRoleProvisioningError(
      "ProofStack migrations must be current before provisioning runtime roles",
    );
  }
}

export async function provisionRuntimeRoles(
  pool: Pick<Pool, "connect">,
  options: RuntimeRoleProvisioningOptions,
): Promise<RuntimeRoleProvisioningResult> {
  const validated = validateOptions(options);
  const client = await pool.connect();
  let connectionDestroyed = false;
  let transactionStarted = false;

  try {
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
        PROVISIONING_LOCK_NAMESPACE,
        PROVISIONING_LOCK_RESOURCE,
      ]);
      await assertSchemaCurrent(client);
      await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");

      const createdRoles: string[] = [];
      const updatedRoles: string[] = [];
      for (const kind of ["api", "identity", "publisher", "consumer"] as const) {
        const outcome = await provisionRole(client, kind, validated[kind]);
        (outcome === "created" ? createdRoles : updatedRoles).push(validated[kind].name);
      }

      await client.query("COMMIT");
      transactionStarted = false;
      return { createdRoles, updatedRoles };
    } catch (operationError) {
      if (!transactionStarted) {
        client.release(true);
        connectionDestroyed = true;
        throw operationError;
      }
      try {
        await client.query("ROLLBACK");
        transactionStarted = false;
      } catch (rollbackError) {
        client.release(true);
        connectionDestroyed = true;
        throw new PostgresTransactionCleanupError(operationError, rollbackError);
      }
      throw operationError;
    }
  } finally {
    if (!connectionDestroyed) client.release();
  }
}
