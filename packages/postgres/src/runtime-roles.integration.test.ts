import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { provisionRuntimeRoles, type RuntimeRoleProvisioningOptions } from "./runtime-roles.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const runKey = Date.now().toString();
const roleNames = {
  api: `proofstack_it_api_${runKey}`,
  consumer: `proofstack_it_consumer_${runKey}`,
  publisher: `proofstack_it_publisher_${runKey}`,
};
const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
const runtimePools: Pool[] = [];

function provisioningOptions(suffix: string): RuntimeRoleProvisioningOptions {
  return {
    api: { name: roleNames.api, password: `proofstack-api-${suffix}-password` },
    consumer: { name: roleNames.consumer, password: `proofstack-consumer-${suffix}-password` },
    publisher: { name: roleNames.publisher, password: `proofstack-publisher-${suffix}-password` },
  };
}

function poolFor(credentials: { readonly name: string; readonly password: string }): Pool {
  const url = new URL(databaseUrl as string);
  url.username = credentials.name;
  url.password = credentials.password;
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  runtimePools.push(pool);
  return pool;
}

beforeAll(async () => {
  await migrateDatabase(adminPool);
});

afterAll(async () => {
  await Promise.all(runtimePools.map((pool) => pool.end()));
  for (const roleName of Object.values(roleNames)) {
    const exists = await adminPool.query<{ readonly present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS present",
      [roleName],
    );
    if (exists.rows[0]?.present) {
      await adminPool.query(`DROP OWNED BY "${roleName}"`);
      await adminPool.query(`DROP ROLE "${roleName}"`);
    }
  }
  await adminPool.end();
});

describe("runtime role provisioning", () => {
  it("creates isolated least-privilege roles and rotates their credentials", async () => {
    const initial = provisioningOptions("initial");
    await expect(provisionRuntimeRoles(adminPool, initial)).resolves.toEqual({
      createdRoles: [roleNames.api, roleNames.publisher, roleNames.consumer],
      updatedRoles: [],
    });

    const roleState = await adminPool.query<{
      readonly has_memberships: boolean;
      readonly marker: string | null;
      readonly rolbypassrls: boolean;
      readonly rolcreatedb: boolean;
      readonly rolcreaterole: boolean;
      readonly rolinherit: boolean;
      readonly rolreplication: boolean;
      readonly rolname: string;
      readonly rolsuper: boolean;
    }>(
      `
        SELECT
          rolname,
          rolsuper,
          rolcreatedb,
          rolcreaterole,
          rolinherit,
          rolreplication,
          rolbypassrls,
          shobj_description(oid, 'pg_authid') AS marker,
          EXISTS (
            SELECT 1
            FROM pg_auth_members
            WHERE roleid = pg_roles.oid OR member = pg_roles.oid
          ) AS has_memberships
        FROM pg_roles
        WHERE rolname = ANY($1::text[])
        ORDER BY rolname
      `,
      [Object.values(roleNames)],
    );
    expect(roleState.rows).toHaveLength(3);
    expect(
      roleState.rows.every(
        ({
          has_memberships,
          rolbypassrls,
          rolcreatedb,
          rolcreaterole,
          rolinherit,
          rolreplication,
          rolsuper,
        }) =>
          !has_memberships &&
          !rolbypassrls &&
          !rolcreatedb &&
          !rolcreaterole &&
          !rolinherit &&
          !rolreplication &&
          !rolsuper,
      ),
    ).toBe(true);
    expect(roleState.rows.map(({ marker }) => marker).sort()).toEqual([
      "proofstack-managed-runtime-role:v1:api",
      "proofstack-managed-runtime-role:v1:consumer",
      "proofstack-managed-runtime-role:v1:publisher",
    ]);

    const apiPool = poolFor(initial.api);
    const apiPrivileges = await apiPool.query<{
      readonly can_create_public: boolean;
      readonly evidence_insert: boolean;
      readonly evidence_select: boolean;
      readonly evidence_update: boolean;
      readonly ledger_select: boolean;
      readonly outbox_insert: boolean;
      readonly outbox_select: boolean;
    }>(`
      SELECT
        has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_public,
        has_table_privilege(current_user, 'proofstack_schema_migrations', 'SELECT') AS ledger_select,
        has_table_privilege(current_user, 'proofstack_evidence_events', 'SELECT') AS evidence_select,
        has_table_privilege(current_user, 'proofstack_evidence_events', 'INSERT') AS evidence_insert,
        has_table_privilege(current_user, 'proofstack_evidence_events', 'UPDATE') AS evidence_update,
        has_table_privilege(current_user, 'proofstack_outbox', 'INSERT') AS outbox_insert,
        has_table_privilege(current_user, 'proofstack_outbox', 'SELECT') AS outbox_select
    `);
    expect(apiPrivileges.rows[0]).toEqual({
      can_create_public: false,
      evidence_insert: true,
      evidence_select: true,
      evidence_update: false,
      ledger_select: true,
      outbox_insert: true,
      outbox_select: false,
    });

    const publisherPool = poolFor(initial.publisher);
    const publisherPrivileges = await publisherPool.query<{
      readonly evidence_select: boolean;
      readonly outbox_insert: boolean;
      readonly outbox_select: boolean;
      readonly outbox_update: boolean;
    }>(`
      SELECT
        has_table_privilege(current_user, 'proofstack_evidence_events', 'SELECT') AS evidence_select,
        has_table_privilege(current_user, 'proofstack_outbox', 'SELECT') AS outbox_select,
        has_table_privilege(current_user, 'proofstack_outbox', 'UPDATE') AS outbox_update,
        has_table_privilege(current_user, 'proofstack_outbox', 'INSERT') AS outbox_insert
    `);
    expect(publisherPrivileges.rows[0]).toEqual({
      evidence_select: false,
      outbox_insert: false,
      outbox_select: true,
      outbox_update: true,
    });

    const consumerPool = poolFor(initial.consumer);
    const consumerPrivileges = await consumerPool.query<{
      readonly cursor_insert: boolean;
      readonly cursor_select: boolean;
      readonly cursor_update: boolean;
      readonly evidence_select: boolean;
      readonly outbox_select: boolean;
      readonly receipt_insert: boolean;
      readonly receipt_select: boolean;
      readonly receipt_update: boolean;
    }>(`
      SELECT
        has_table_privilege(current_user, 'proofstack_consumer_receipts', 'SELECT') AS receipt_select,
        has_table_privilege(current_user, 'proofstack_consumer_receipts', 'INSERT') AS receipt_insert,
        has_table_privilege(current_user, 'proofstack_consumer_receipts', 'UPDATE') AS receipt_update,
        has_table_privilege(current_user, 'proofstack_projection_cursors', 'SELECT') AS cursor_select,
        has_table_privilege(current_user, 'proofstack_projection_cursors', 'INSERT') AS cursor_insert,
        has_table_privilege(current_user, 'proofstack_projection_cursors', 'UPDATE') AS cursor_update,
        has_table_privilege(current_user, 'proofstack_evidence_events', 'SELECT') AS evidence_select,
        has_table_privilege(current_user, 'proofstack_outbox', 'SELECT') AS outbox_select
    `);
    expect(consumerPrivileges.rows[0]).toEqual({
      cursor_insert: true,
      cursor_select: true,
      cursor_update: true,
      evidence_select: false,
      outbox_select: false,
      receipt_insert: true,
      receipt_select: true,
      receipt_update: true,
    });

    const rotated = provisioningOptions("rotated");
    await expect(provisionRuntimeRoles(adminPool, rotated)).resolves.toEqual({
      createdRoles: [],
      updatedRoles: [roleNames.api, roleNames.publisher, roleNames.consumer],
    });
    const rotatedApiPool = poolFor(rotated.api);
    await expect(rotatedApiPool.query("SELECT current_user AS role")).resolves.toMatchObject({
      rows: [{ role: roleNames.api }],
    });
  });
});
