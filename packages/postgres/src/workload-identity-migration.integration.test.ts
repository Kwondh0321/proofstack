import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const runKey = Date.now().toString();
const runtimeRole = `proofstack_it_identity_${runKey}`;
const runtimePassword = `proofstack-identity-${runKey}-password`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
let identityPool: Pool;

const HASH = {
  algorithm: "scrypt-v1",
  blockSize: 8,
  cost: 32_768,
  digest: "A".repeat(43),
  keyLength: 32,
  parallelization: 1,
  salt: "B".repeat(22),
};

interface CreatedRow extends QueryResultRow {
  readonly created_at: Date;
}

const CREATE_API_KEY_SQL = `
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

function createValues(
  credentialId: string,
  prefix: string,
  overrides: {
    readonly principalId?: string;
    readonly resourceScope?: object;
    readonly tenantId?: string;
  } = {},
): readonly unknown[] {
  return [
    overrides.tenantId ?? "ten_identity_alpha",
    credentialId,
    prefix,
    overrides.principalId ?? "wrk_identity_agent",
    "production agent",
    ["evidence:ingest", "evidence:read"],
    JSON.stringify(overrides.resourceScope ?? { mode: "tenant" }),
    HASH.algorithm,
    HASH.cost,
    HASH.blockSize,
    HASH.parallelization,
    HASH.keyLength,
    HASH.salt,
    HASH.digest,
    new Date(Date.now() + 24 * 60 * 60 * 1_000),
    "usr_identity_admin",
  ];
}

async function asIdentity<Row extends QueryResultRow = QueryResultRow>(
  tenantId: string | undefined,
  query: (client: PoolClient) => Promise<QueryResult<Row>>,
): Promise<QueryResult<Row>> {
  const client = await identityPool.connect();
  try {
    await client.query("BEGIN");
    if (tenantId) {
      await client.query("SELECT set_config('proofstack.tenant_id', $1, true)", [tenantId]);
    }
    const result = await query(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await migrateDatabase(adminPool);
  await adminPool.query(`
    CREATE ROLE "${runtimeRole}"
      WITH LOGIN PASSWORD '${runtimePassword}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  `);
  await adminPool.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await adminPool.query(`
    GRANT EXECUTE ON FUNCTION
      public.proofstack_find_active_api_key(text),
      public.proofstack_find_api_key(text, text),
      public.proofstack_create_api_key(
        text, text, text, text, text, text[], jsonb, text,
        integer, integer, integer, integer, text, text, timestamptz, text
      ),
      public.proofstack_rotate_api_key(
        text, text, text, text, text,
        integer, integer, integer, integer, text, text, timestamptz, text
      ),
      public.proofstack_revoke_api_key(text, text, text, text),
      public.proofstack_record_api_key_use(text, text, text)
    TO "${runtimeRole}"
  `);

  const url = new URL(databaseUrl as string);
  url.username = runtimeRole;
  url.password = runtimePassword;
  identityPool = new Pool({ connectionString: url.toString(), max: 2 });
});

afterAll(async () => {
  await identityPool?.end();
  await adminPool.query(`DROP OWNED BY "${runtimeRole}"`);
  await adminPool.query(`DROP ROLE "${runtimeRole}"`);
  await adminPool.end();
});

describe("workload identity migration", () => {
  it("isolates base identity data behind exact security-definer functions", async () => {
    await expect(
      identityPool.query("SELECT * FROM proofstack_api_key_credentials"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      identityPool.query("SELECT * FROM proofstack_identity_audit_events"),
    ).rejects.toMatchObject({ code: "42501" });

    const privileges = await identityPool.query<{
      readonly audit_select: boolean;
      readonly credential_select: boolean;
      readonly lookup_execute: boolean;
    }>(`
      SELECT
        has_table_privilege(current_user, 'proofstack_api_key_credentials', 'SELECT')
          AS credential_select,
        has_table_privilege(current_user, 'proofstack_identity_audit_events', 'SELECT')
          AS audit_select,
        has_function_privilege(
          current_user,
          'proofstack_find_active_api_key(text)',
          'EXECUTE'
        ) AS lookup_execute
    `);
    expect(privileges.rows[0]).toEqual({
      audit_select: false,
      credential_select: false,
      lookup_execute: true,
    });
  });

  it("requires tenant context and creates a sanitized audit event atomically", async () => {
    await expect(
      asIdentity(undefined, (client) =>
        client.query<CreatedRow>(CREATE_API_KEY_SQL, [
          ...createValues("key_missing_context", "AbCdEf123_-a"),
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const created = await asIdentity("ten_identity_alpha", (client) =>
      client.query<CreatedRow>(CREATE_API_KEY_SQL, [
        ...createValues("key_identity_initial", "AbCdEf123_-b"),
      ]),
    );
    expect(created.rows[0]?.created_at).toBeInstanceOf(Date);

    const stored = await adminPool.query<{
      readonly audit_count: string;
      readonly hash_digest: string;
      readonly secret_columns: string[];
    }>(`
      SELECT
        credential.hash_digest,
        (
          SELECT count(*)::text
          FROM proofstack_identity_audit_events AS audit
          WHERE audit.tenant_id = credential.tenant_id
            AND audit.credential_id = credential.credential_id
            AND audit.event_type = 'api_key.issued'
            AND audit.outcome = 'succeeded'
        ) AS audit_count,
        ARRAY(
          SELECT column_name::text
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN (
              'proofstack_api_key_credentials',
              'proofstack_identity_audit_events'
            )
            AND column_name IN ('secret', 'api_key', 'authorization_header')
          ORDER BY column_name
        ) AS secret_columns
      FROM proofstack_api_key_credentials AS credential
      WHERE credential.tenant_id = 'ten_identity_alpha'
        AND credential.credential_id = 'key_identity_initial'
    `);
    expect(stored.rows[0]).toEqual({
      audit_count: "1",
      hash_digest: HASH.digest,
      secret_columns: [],
    });
  });

  it("performs exact active lookup and authoritative database-time revocation", async () => {
    const malformed = await identityPool.query(
      "SELECT * FROM proofstack_find_active_api_key('malformed')",
    );
    expect(malformed.rows).toEqual([]);

    const active = await identityPool.query<{
      readonly credential_id: string;
      readonly hash_algorithm: string;
      readonly key_prefix: string;
      readonly tenant_id: string;
    }>("SELECT * FROM proofstack_find_active_api_key($1)", ["AbCdEf123_-b"]);
    expect(active.rows).toMatchObject([
      {
        credential_id: "key_identity_initial",
        hash_algorithm: "scrypt-v1",
        key_prefix: "AbCdEf123_-b",
        tenant_id: "ten_identity_alpha",
      },
    ]);

    await expect(
      asIdentity("ten_identity_beta", (client) =>
        client.query("SELECT * FROM proofstack_find_api_key($1, $2)", [
          "ten_identity_alpha",
          "key_identity_initial",
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      identityPool.query("SELECT proofstack_record_api_key_use($1, $2, $3) AS recorded", [
        "ten_identity_alpha",
        "key_identity_initial",
        "AbCdEf123_-b",
      ]),
    ).resolves.toMatchObject({ rows: [{ recorded: true }] });

    const revoked = await asIdentity("ten_identity_alpha", (client) =>
      client.query<{ readonly revoked: boolean }>(
        "SELECT proofstack_revoke_api_key($1, $2, $3, $4) AS revoked",
        ["ten_identity_alpha", "key_identity_initial", "usr_identity_admin", "retired"],
      ),
    );
    expect(revoked.rows).toEqual([{ revoked: true }]);

    const repeated = await asIdentity("ten_identity_alpha", (client) =>
      client.query<{ readonly revoked: boolean }>(
        "SELECT proofstack_revoke_api_key($1, $2, $3, $4) AS revoked",
        ["ten_identity_alpha", "key_identity_initial", "usr_identity_admin", "retired"],
      ),
    );
    expect(repeated.rows).toEqual([{ revoked: false }]);
    await expect(
      identityPool.query("SELECT * FROM proofstack_find_active_api_key($1)", ["AbCdEf123_-b"]),
    ).resolves.toMatchObject({ rows: [] });

    const metadata = await adminPool.query<{
      readonly audit_count: string;
      readonly last_used: boolean;
      readonly use_count: number;
    }>(`
      SELECT
        credential.last_used_at IS NOT NULL AS last_used,
        credential.use_count,
        (
          SELECT count(*)::text
          FROM proofstack_identity_audit_events AS audit
          WHERE audit.tenant_id = credential.tenant_id
            AND audit.credential_id = credential.credential_id
            AND audit.event_type = 'api_key.revoked'
        ) AS audit_count
      FROM proofstack_api_key_credentials AS credential
      WHERE credential.tenant_id = 'ten_identity_alpha'
        AND credential.credential_id = 'key_identity_initial'
    `);
    expect(metadata.rows[0]).toEqual({ audit_count: "2", last_used: true, use_count: 1 });
  });

  it("copies authorization during atomic rotation and rolls back collisions", async () => {
    await asIdentity("ten_identity_alpha", (client) =>
      client.query<CreatedRow>(CREATE_API_KEY_SQL, [
        ...createValues("key_identity_rotation_source", "AbCdEf123_-c", {
          principalId: "wrk_identity_rotation",
          resourceScope: {
            mode: "restricted",
            projects: [{ environmentIds: ["env_prod"], projectId: "prj_agent" }],
          },
        }),
      ]),
    );

    const rotated = await asIdentity("ten_identity_alpha", (client) =>
      client.query<CreatedRow>(
        `SELECT created_at FROM proofstack_rotate_api_key(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
        )`,
        [
          "ten_identity_alpha",
          "key_identity_rotation_source",
          "key_identity_rotated",
          "AbCdEf123_-d",
          HASH.algorithm,
          HASH.cost,
          HASH.blockSize,
          HASH.parallelization,
          HASH.keyLength,
          HASH.salt,
          HASH.digest,
          new Date(Date.now() + 24 * 60 * 60 * 1_000),
          "usr_identity_admin",
        ],
      ),
    );
    expect(rotated.rows[0]?.created_at).toBeInstanceOf(Date);

    const lineage = await adminPool.query<{
      readonly capabilities: string[];
      readonly principal_id: string;
      readonly resource_scope: object;
      readonly rotated_from_credential_id: string;
      readonly source_revoked: boolean;
    }>(`
      SELECT
        rotated.capabilities,
        rotated.principal_id,
        rotated.resource_scope,
        rotated.rotated_from_credential_id,
        source.revoked_at IS NOT NULL AS source_revoked
      FROM proofstack_api_key_credentials AS rotated
      JOIN proofstack_api_key_credentials AS source
        ON source.tenant_id = rotated.tenant_id
        AND source.credential_id = rotated.rotated_from_credential_id
      WHERE rotated.tenant_id = 'ten_identity_alpha'
        AND rotated.credential_id = 'key_identity_rotated'
    `);
    expect(lineage.rows[0]).toEqual({
      capabilities: ["evidence:ingest", "evidence:read"],
      principal_id: "wrk_identity_rotation",
      resource_scope: {
        mode: "restricted",
        projects: [{ environmentIds: ["env_prod"], projectId: "prj_agent" }],
      },
      rotated_from_credential_id: "key_identity_rotation_source",
      source_revoked: true,
    });

    await asIdentity("ten_identity_alpha", (client) =>
      client.query<CreatedRow>(CREATE_API_KEY_SQL, [
        ...createValues("key_identity_collision_source", "AbCdEf123_-e"),
      ]),
    );
    await expect(
      asIdentity("ten_identity_alpha", (client) =>
        client.query(
          `SELECT created_at FROM proofstack_rotate_api_key(
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
          )`,
          [
            "ten_identity_alpha",
            "key_identity_collision_source",
            "key_identity_collision_target",
            "AbCdEf123_-d",
            HASH.algorithm,
            HASH.cost,
            HASH.blockSize,
            HASH.parallelization,
            HASH.keyLength,
            HASH.salt,
            HASH.digest,
            new Date(Date.now() + 24 * 60 * 60 * 1_000),
            "usr_identity_admin",
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "23505" });

    const source = await adminPool.query<{ readonly active: boolean }>(`
      SELECT revoked_at IS NULL AS active
      FROM proofstack_api_key_credentials
      WHERE tenant_id = 'ten_identity_alpha'
        AND credential_id = 'key_identity_collision_source'
    `);
    expect(source.rows).toEqual([{ active: true }]);
  });

  it("rejects malformed scope and mutations of identity or audit history", async () => {
    await expect(
      asIdentity("ten_identity_alpha", (client) =>
        client.query(CREATE_API_KEY_SQL, [
          ...createValues("key_identity_invalid_scope", "AbCdEf123_-f", {
            resourceScope: {
              mode: "restricted",
              projects: [{ projectId: "prj_duplicate" }, { projectId: "prj_duplicate" }],
            },
          }),
        ]),
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      adminPool.query(`
        UPDATE proofstack_api_key_credentials
        SET display_name = 'tampered'
        WHERE tenant_id = 'ten_identity_alpha'
          AND credential_id = 'key_identity_rotated'
      `),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      adminPool.query(`
        DELETE FROM proofstack_identity_audit_events
        WHERE tenant_id = 'ten_identity_alpha'
      `),
    ).rejects.toMatchObject({ code: "55000" });
  });
});
