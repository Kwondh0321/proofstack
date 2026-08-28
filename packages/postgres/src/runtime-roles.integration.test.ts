import type { EvidenceEnvelope } from "@proofstack/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresConsumerReceiptRepository } from "./postgres-consumer-receipt-repository.js";
import { PostgresEvidenceRepository } from "./postgres-evidence-repository.js";
import { PostgresOutboxRepository } from "./postgres-outbox-repository.js";
import { PostgresProjectionCursorRepository } from "./postgres-projection-cursor-repository.js";
import { provisionRuntimeRoles, type RuntimeRoleProvisioningOptions } from "./runtime-roles.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const runKey = Date.now().toString();
const roleNames = {
  api: `proofstack_it_api_${runKey}`,
  consumer: `proofstack_it_consumer_${runKey}`,
  identity: `proofstack_it_identity_role_${runKey}`,
  publisher: `proofstack_it_publisher_${runKey}`,
};
const sequenceName = `proofstack_it_sequence_${runKey}`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
const runtimePools: Pool[] = [];

function provisioningOptions(suffix: string): RuntimeRoleProvisioningOptions {
  return {
    api: { name: roleNames.api, password: `proofstack-api-${suffix}-password` },
    consumer: { name: roleNames.consumer, password: `proofstack-consumer-${suffix}-password` },
    identity: { name: roleNames.identity, password: `proofstack-identity-${suffix}-password` },
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
  await adminPool.query(`CREATE SEQUENCE public."${sequenceName}"`);
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
  await adminPool.query(`DROP SEQUENCE IF EXISTS public."${sequenceName}"`);
  await adminPool.end();
});

describe("runtime role provisioning", () => {
  it("creates isolated least-privilege roles and rotates their credentials", async () => {
    const initial = provisioningOptions("initial");
    await expect(provisionRuntimeRoles(adminPool, initial)).resolves.toEqual({
      createdRoles: [roleNames.api, roleNames.identity, roleNames.publisher, roleNames.consumer],
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
    expect(roleState.rows).toHaveLength(4);
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
      "proofstack-managed-runtime-role:v1:identity",
      "proofstack-managed-runtime-role:v1:publisher",
    ]);

    const apiPool = poolFor(initial.api);
    const apiPrivileges = await apiPool.query<{
      readonly can_create_public: boolean;
      readonly evidence_insert: boolean;
      readonly evidence_select: boolean;
      readonly evidence_update: boolean;
      readonly identity_lookup_execute: boolean;
      readonly identity_select: boolean;
      readonly ledger_select: boolean;
      readonly outbox_insert: boolean;
      readonly outbox_select: boolean;
      readonly sequence_usage: boolean;
    }>(
      `
      SELECT
        has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_public,
        has_table_privilege(current_user, 'proofstack_schema_migrations', 'SELECT') AS ledger_select,
        has_table_privilege(current_user, 'proofstack_evidence_events', 'SELECT') AS evidence_select,
        has_table_privilege(current_user, 'proofstack_evidence_events', 'INSERT') AS evidence_insert,
        has_table_privilege(current_user, 'proofstack_evidence_events', 'UPDATE') AS evidence_update,
        has_table_privilege(
          current_user,
          'proofstack_api_key_credentials',
          'SELECT'
        ) AS identity_select,
        has_function_privilege(
          current_user,
          'proofstack_find_active_api_key(text)',
          'EXECUTE'
        ) AS identity_lookup_execute,
        has_table_privilege(current_user, 'proofstack_outbox', 'INSERT') AS outbox_insert,
        has_table_privilege(current_user, 'proofstack_outbox', 'SELECT') AS outbox_select,
        has_sequence_privilege(
          current_user,
          $1,
          'USAGE'
        ) AS sequence_usage
    `,
      [`public.${sequenceName}`],
    );
    expect(apiPrivileges.rows[0]).toEqual({
      can_create_public: false,
      evidence_insert: true,
      evidence_select: true,
      evidence_update: false,
      identity_lookup_execute: false,
      identity_select: false,
      ledger_select: true,
      outbox_insert: true,
      outbox_select: false,
      sequence_usage: false,
    });

    const publisherPool = poolFor(initial.publisher);
    const publisherPrivileges = await publisherPool.query<{
      readonly evidence_select: boolean;
      readonly identity_lookup_execute: boolean;
      readonly identity_select: boolean;
      readonly outbox_insert: boolean;
      readonly outbox_select: boolean;
      readonly outbox_update: boolean;
    }>(`
      SELECT
        has_table_privilege(current_user, 'proofstack_evidence_events', 'SELECT') AS evidence_select,
        has_table_privilege(current_user, 'proofstack_api_key_credentials', 'SELECT')
          AS identity_select,
        has_function_privilege(
          current_user,
          'proofstack_find_active_api_key(text)',
          'EXECUTE'
        ) AS identity_lookup_execute,
        has_table_privilege(current_user, 'proofstack_outbox', 'SELECT') AS outbox_select,
        has_table_privilege(current_user, 'proofstack_outbox', 'UPDATE') AS outbox_update,
        has_table_privilege(current_user, 'proofstack_outbox', 'INSERT') AS outbox_insert
    `);
    expect(publisherPrivileges.rows[0]).toEqual({
      evidence_select: false,
      identity_lookup_execute: false,
      identity_select: false,
      outbox_insert: false,
      outbox_select: true,
      outbox_update: true,
    });

    const identityPool = poolFor(initial.identity);
    const identityPrivileges = await identityPool.query<{
      readonly audit_select: boolean;
      readonly create_execute: boolean;
      readonly evidence_select: boolean;
      readonly helper_execute: boolean;
      readonly identity_select: boolean;
      readonly ledger_select: boolean;
      readonly lookup_execute: boolean;
    }>(`
      SELECT
        has_table_privilege(current_user, 'proofstack_schema_migrations', 'SELECT')
          AS ledger_select,
        has_table_privilege(current_user, 'proofstack_api_key_credentials', 'SELECT')
          AS identity_select,
        has_table_privilege(current_user, 'proofstack_identity_audit_events', 'SELECT')
          AS audit_select,
        has_table_privilege(current_user, 'proofstack_evidence_events', 'SELECT')
          AS evidence_select,
        has_function_privilege(
          current_user,
          'proofstack_find_active_api_key(text)',
          'EXECUTE'
        ) AS lookup_execute,
        has_function_privilege(
          current_user,
          'proofstack_create_api_key(text, text, text, text, text, text[], jsonb, text, integer, integer, integer, integer, text, text, timestamptz, text)',
          'EXECUTE'
        ) AS create_execute,
        has_function_privilege(
          current_user,
          'proofstack_write_identity_audit(text, text, text, text, text, text, text, timestamptz)',
          'EXECUTE'
        ) AS helper_execute
    `);
    expect(identityPrivileges.rows[0]).toEqual({
      audit_select: false,
      create_execute: true,
      evidence_select: false,
      helper_execute: false,
      identity_select: false,
      ledger_select: true,
      lookup_execute: true,
    });

    const consumerPool = poolFor(initial.consumer);
    const consumerPrivileges = await consumerPool.query<{
      readonly cursor_insert: boolean;
      readonly cursor_select: boolean;
      readonly cursor_update: boolean;
      readonly evidence_select: boolean;
      readonly identity_lookup_execute: boolean;
      readonly identity_select: boolean;
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
        has_table_privilege(current_user, 'proofstack_api_key_credentials', 'SELECT')
          AS identity_select,
        has_function_privilege(
          current_user,
          'proofstack_find_active_api_key(text)',
          'EXECUTE'
        ) AS identity_lookup_execute,
        has_table_privilege(current_user, 'proofstack_outbox', 'SELECT') AS outbox_select
    `);
    expect(consumerPrivileges.rows[0]).toEqual({
      cursor_insert: true,
      cursor_select: true,
      cursor_update: true,
      evidence_select: false,
      identity_lookup_execute: false,
      identity_select: false,
      outbox_select: false,
      receipt_insert: true,
      receipt_select: true,
      receipt_update: true,
    });

    const tenantId = `ten_roles_${runKey}`;
    const evidence: EvidenceEnvelope = {
      evidence: {
        attributes: {},
        contentReferences: [],
        eventId: `evt_roles_${runKey}`,
        extensions: {},
        kind: "agent.run",
        name: "runtime-role-contract",
        source: {
          sdkName: "@proofstack/testkit",
          sdkVersion: "0.0.0",
          serviceName: "runtime-role-contract",
        },
        spanId: "70f067aa0ba902b7",
        startedAt: "2026-08-28T04:59:59.000Z",
        status: "ok",
        traceId: "8bf92f3577b34da6a3ce929d0e0e4736",
      },
      receivedAt: "2026-08-28T05:00:00.000Z",
      schemaVersion: "0.1",
      scope: {
        environmentId: "env_roles",
        projectId: "prj_roles",
        tenantId,
      },
    };
    await expect(new PostgresEvidenceRepository(apiPool).append([evidence])).resolves.toEqual({
      acceptedEventIds: [evidence.evidence.eventId],
      duplicateEventIds: [],
    });

    const outbox = new PostgresOutboxRepository(
      publisherPool,
      () => "11111111-1111-4111-8111-111111111111",
    );
    const claimed = await outbox.claim(tenantId, {
      leaseDurationMs: 60_000,
      limit: 1,
      workerId: "worker_roles",
    });
    const message = claimed[0];
    expect(message).toMatchObject({ aggregateId: evidence.evidence.eventId, tenantId });
    if (!message) throw new Error("Provisioned publisher did not receive the evidence outbox row");

    const receipts = new PostgresConsumerReceiptRepository(
      consumerPool,
      () => "22222222-2222-4222-8222-222222222222",
    );
    const receipt = await receipts.claim(tenantId, {
      consumerName: "projection.roles",
      leaseDurationMs: 60_000,
      messageId: `outbox:${message.outboxId}`,
      payloadSha256: "a".repeat(64),
      workerId: "worker_roles",
    });
    expect(receipt.status).toBe("acquired");
    if (receipt.status !== "acquired" || !receipt.receipt.lease) {
      throw new Error("Provisioned consumer did not acquire a consumer receipt lease");
    }
    await expect(
      receipts.complete(tenantId, {
        consumerName: "projection.roles",
        leaseToken: receipt.receipt.lease.token,
        messageId: `outbox:${message.outboxId}`,
      }),
    ).resolves.toBe(true);
    await expect(
      new PostgresProjectionCursorRepository(consumerPool).advance(tenantId, {
        consumerName: "projection.roles",
        generation: 1,
        lastOutboxId: message.outboxId,
      }),
    ).resolves.toMatchObject({ advanced: true });
    await expect(
      outbox.acknowledge(tenantId, {
        leaseToken: message.lease.token,
        outboxId: message.outboxId,
      }),
    ).resolves.toBe(true);

    const rotated = provisioningOptions("rotated");
    await adminPool.query(`GRANT USAGE ON SEQUENCE public."${sequenceName}" TO "${roleNames.api}"`);
    await adminPool.query(`
      GRANT EXECUTE ON FUNCTION public.proofstack_write_identity_audit(
        text, text, text, text, text, text, text, timestamptz
      ) TO "${roleNames.identity}"
    `);
    await expect(provisionRuntimeRoles(adminPool, rotated)).resolves.toEqual({
      createdRoles: [],
      updatedRoles: [roleNames.api, roleNames.identity, roleNames.publisher, roleNames.consumer],
    });
    const rotatedApiPool = poolFor(rotated.api);
    await expect(rotatedApiPool.query("SELECT current_user AS role")).resolves.toMatchObject({
      rows: [{ role: roleNames.api }],
    });
    await expect(
      rotatedApiPool.query<{ readonly sequence_usage: boolean }>(
        "SELECT has_sequence_privilege(current_user, $1, 'USAGE') AS sequence_usage",
        [`public.${sequenceName}`],
      ),
    ).resolves.toMatchObject({ rows: [{ sequence_usage: false }] });
    const rotatedIdentityPool = poolFor(rotated.identity);
    await expect(
      rotatedIdentityPool.query<{
        readonly helper_execute: boolean;
        readonly lookup_execute: boolean;
      }>(`
        SELECT
          has_function_privilege(
            current_user,
            'proofstack_find_active_api_key(text)',
            'EXECUTE'
          ) AS lookup_execute,
          has_function_privilege(
            current_user,
            'proofstack_write_identity_audit(text, text, text, text, text, text, text, timestamptz)',
            'EXECUTE'
          ) AS helper_execute
      `),
    ).resolves.toMatchObject({
      rows: [{ helper_execute: false, lookup_execute: true }],
    });
  });
});
