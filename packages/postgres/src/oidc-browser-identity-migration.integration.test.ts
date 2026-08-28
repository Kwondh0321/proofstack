import { createHash } from "node:crypto";
import {
  generateBrowserSessionCredentials,
  generateOidcLoginSecrets,
  generateOidcTransactionSecret,
  OidcLoginTransactionCipher,
} from "@proofstack/identity";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const runKey = Date.now().toString();
const tenantId = `ten_oidc_${runKey}`;
const bindingId = `oidc_binding_${runKey}`;
const principalId = `usr_oidc_${runKey}`;
const subject = `subject-${runKey}`;
const issuer = "https://identity.example.test/tenant";
const runtimeRole = `proofstack_oidc_identity_${runKey}`;
const runtimePassword = `proofstack-oidc-identity-${runKey}`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
let identityPool: Pool;

function source(start: number) {
  let value = start;
  return (size: number) => {
    const result = new Uint8Array(size).fill(value);
    value += 1;
    return result;
  };
}

function identityDigest(): string {
  return createHash("sha256")
    .update("proofstack:oidc-binding:v1\0", "utf8")
    .update(issuer, "utf8")
    .update("\0", "utf8")
    .update(subject, "utf8")
    .digest("hex");
}

async function asIdentity<Row extends QueryResultRow = QueryResultRow>(
  tenant: string | undefined,
  query: (client: PoolClient) => Promise<QueryResult<Row>>,
): Promise<QueryResult<Row>> {
  const client = await identityPool.connect();
  try {
    await client.query("BEGIN");
    if (tenant) {
      await client.query("SELECT set_config('proofstack.tenant_id', $1, true)", [tenant]);
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
      public.proofstack_create_oidc_binding(
        text, text, text, text, text, text, text[], text[], jsonb, text
      ),
      public.proofstack_find_active_oidc_binding(text, text, text),
      public.proofstack_update_oidc_binding(text, text, text[], text[], jsonb, text),
      public.proofstack_disable_oidc_binding(text, text, text, text),
      public.proofstack_create_oidc_login_transaction(text, text, integer),
      public.proofstack_consume_oidc_login_transaction(text),
      public.proofstack_create_browser_session(text, text, text, text, integer, integer),
      public.proofstack_find_and_touch_active_browser_session(text),
      public.proofstack_revoke_browser_session(text)
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

describe("OIDC browser identity migration", () => {
  it("isolates identity tables and requires tenant context for explicit bindings", async () => {
    await expect(
      identityPool.query("SELECT * FROM proofstack_oidc_bindings"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      identityPool.query("SELECT * FROM proofstack_oidc_login_transactions"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      identityPool.query("SELECT * FROM proofstack_browser_sessions"),
    ).rejects.toMatchObject({ code: "42501" });

    const createValues = [
      tenantId,
      bindingId,
      identityDigest(),
      issuer,
      subject,
      principalId,
      ["admin"],
      ["project:read", "evidence:read", "identity:manage"],
      JSON.stringify({ mode: "tenant" }),
      "usr_oidc_bootstrap",
    ];
    await expect(
      asIdentity(undefined, (client) =>
        client.query(
          `SELECT created_at FROM proofstack_create_oidc_binding(
            $1, $2, $3, $4, $5, $6, $7::text[], $8::text[], $9::jsonb, $10
          )`,
          createValues,
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const created = await asIdentity(tenantId, (client) =>
      client.query<{ readonly created_at: Date }>(
        `SELECT created_at FROM proofstack_create_oidc_binding(
          $1, $2, $3, $4, $5, $6, $7::text[], $8::text[], $9::jsonb, $10
        )`,
        createValues,
      ),
    );
    expect(created.rows[0]?.created_at).toBeInstanceOf(Date);

    const privileges = await identityPool.query<{
      readonly binding_select: boolean;
      readonly lookup_execute: boolean;
      readonly session_select: boolean;
      readonly transaction_select: boolean;
    }>(`
      SELECT
        has_table_privilege(current_user, 'proofstack_oidc_bindings', 'SELECT')
          AS binding_select,
        has_table_privilege(current_user, 'proofstack_oidc_login_transactions', 'SELECT')
          AS transaction_select,
        has_table_privilege(current_user, 'proofstack_browser_sessions', 'SELECT')
          AS session_select,
        has_function_privilege(
          current_user,
          'proofstack_find_active_oidc_binding(text, text, text)',
          'EXECUTE'
        ) AS lookup_execute
    `);
    expect(privileges.rows[0]).toEqual({
      binding_select: false,
      lookup_execute: true,
      session_select: false,
      transaction_select: false,
    });
  });

  it("matches only the exact active issuer and subject", async () => {
    const active = await identityPool.query(
      "SELECT * FROM proofstack_find_active_oidc_binding($1, $2, $3)",
      [identityDigest(), issuer, subject],
    );
    expect(active.rows).toMatchObject([
      {
        binding_id: bindingId,
        capabilities: ["project:read", "evidence:read", "identity:manage"],
        issuer,
        principal_id: principalId,
        resource_scope: { mode: "tenant" },
        roles: ["admin"],
        subject,
        tenant_id: tenantId,
      },
    ]);
    await expect(
      identityPool.query("SELECT * FROM proofstack_find_active_oidc_binding($1, $2, $3)", [
        identityDigest(),
        issuer,
        `${subject}-different`,
      ]),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      identityPool.query("SELECT * FROM proofstack_find_active_oidc_binding($1, $2, $3)", [
        "0".repeat(64),
        issuer,
        subject,
      ]),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("creates and consumes an encrypted login transaction exactly once", async () => {
    const cipher = new OidcLoginTransactionCipher(generateOidcTransactionSecret(source(20)));
    const secrets = generateOidcLoginSecrets(source(30));
    const protectedPayload = cipher.encrypt(
      {
        codeVerifier: secrets.codeVerifier,
        nonce: secrets.nonce,
        returnTo: "/traces",
        state: secrets.state,
      },
      source(40),
    );
    const created = await identityPool.query<{
      readonly created_at: Date;
      readonly expires_at: Date;
    }>("SELECT * FROM proofstack_create_oidc_login_transaction($1, $2, $3)", [
      secrets.stateDigest,
      protectedPayload,
      600,
    ]);
    expect(
      (created.rows[0]?.expires_at.getTime() ?? 0) - (created.rows[0]?.created_at.getTime() ?? 0),
    ).toBe(600_000);

    const consumed = await identityPool.query<{
      readonly protected_payload: string;
      readonly state_digest: string;
    }>("SELECT * FROM proofstack_consume_oidc_login_transaction($1)", [secrets.stateDigest]);
    expect(consumed.rows).toEqual([
      { protected_payload: protectedPayload, state_digest: secrets.stateDigest },
    ]);
    expect(cipher.decrypt(consumed.rows[0]?.protected_payload ?? "")).toMatchObject({
      returnTo: "/traces",
      state: secrets.state,
    });
    await expect(
      identityPool.query("SELECT * FROM proofstack_consume_oidc_login_transaction($1)", [
        secrets.stateDigest,
      ]),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("re-reads changed binding authorization on every active session use", async () => {
    const credentials = generateBrowserSessionCredentials(source(50));
    const sessionId = `ses_oidc_first_${runKey}`;
    const created = await identityPool.query<{
      readonly absolute_expires_at: Date;
      readonly created_at: Date;
      readonly idle_expires_at: Date;
      readonly session_id: string;
    }>("SELECT * FROM proofstack_create_browser_session($1, $2, $3, $4, $5, $6)", [
      sessionId,
      credentials.sessionDigest,
      credentials.csrfDigest,
      bindingId,
      3_600,
      600,
    ]);
    expect(created.rows[0]).toMatchObject({ session_id: sessionId });
    expect(
      (created.rows[0]?.absolute_expires_at.getTime() ?? 0) -
        (created.rows[0]?.created_at.getTime() ?? 0),
    ).toBe(3_600_000);
    expect(
      (created.rows[0]?.idle_expires_at.getTime() ?? 0) -
        (created.rows[0]?.created_at.getTime() ?? 0),
    ).toBe(600_000);

    const firstUse = await identityPool.query(
      "SELECT * FROM proofstack_find_and_touch_active_browser_session($1)",
      [credentials.sessionDigest],
    );
    expect(firstUse.rows).toMatchObject([
      {
        capabilities: ["project:read", "evidence:read", "identity:manage"],
        principal_id: principalId,
        roles: ["admin"],
        session_id: sessionId,
        tenant_id: tenantId,
      },
    ]);

    await asIdentity(tenantId, (client) =>
      client.query(
        `SELECT updated_at FROM proofstack_update_oidc_binding(
          $1, $2, $3::text[], $4::text[], $5::jsonb, $6
        )`,
        [
          tenantId,
          bindingId,
          ["viewer"],
          ["evidence:read"],
          JSON.stringify({ mode: "tenant" }),
          "usr_oidc_bootstrap",
        ],
      ),
    );
    const secondUse = await identityPool.query(
      "SELECT * FROM proofstack_find_and_touch_active_browser_session($1)",
      [credentials.sessionDigest],
    );
    expect(secondUse.rows).toMatchObject([
      { capabilities: ["evidence:read"], roles: ["viewer"], session_id: sessionId },
    ]);

    await expect(
      identityPool.query("SELECT proofstack_revoke_browser_session($1) AS revoked", [
        credentials.sessionDigest,
      ]),
    ).resolves.toMatchObject({ rows: [{ revoked: true }] });
    await expect(
      identityPool.query("SELECT proofstack_revoke_browser_session($1) AS revoked", [
        credentials.sessionDigest,
      ]),
    ).resolves.toMatchObject({ rows: [{ revoked: false }] });
    await expect(
      identityPool.query("SELECT * FROM proofstack_find_and_touch_active_browser_session($1)", [
        credentials.sessionDigest,
      ]),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("disables a binding and revokes every remaining session atomically", async () => {
    const credentials = generateBrowserSessionCredentials(source(60));
    await identityPool.query(
      "SELECT * FROM proofstack_create_browser_session($1, $2, $3, $4, $5, $6)",
      [
        `ses_oidc_second_${runKey}`,
        credentials.sessionDigest,
        credentials.csrfDigest,
        bindingId,
        3_600,
        600,
      ],
    );

    await expect(
      asIdentity(tenantId, (client) =>
        client.query("SELECT proofstack_disable_oidc_binding($1, $2, $3, $4) AS disabled", [
          tenantId,
          bindingId,
          "usr_oidc_bootstrap",
          "operator access removed",
        ]),
      ),
    ).resolves.toMatchObject({ rows: [{ disabled: true }] });
    await expect(
      identityPool.query("SELECT * FROM proofstack_find_active_oidc_binding($1, $2, $3)", [
        identityDigest(),
        issuer,
        subject,
      ]),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      identityPool.query("SELECT * FROM proofstack_find_and_touch_active_browser_session($1)", [
        credentials.sessionDigest,
      ]),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      asIdentity(tenantId, (client) =>
        client.query("SELECT proofstack_disable_oidc_binding($1, $2, $3, $4) AS disabled", [
          tenantId,
          bindingId,
          "usr_oidc_bootstrap",
          "operator access removed",
        ]),
      ),
    ).resolves.toMatchObject({ rows: [{ disabled: false }] });

    const audit = await adminPool.query<{ readonly event_type: string }>(
      `SELECT event_type
       FROM proofstack_identity_audit_events
       WHERE tenant_id = $1
       ORDER BY audit_id`,
      [tenantId],
    );
    expect(audit.rows.map(({ event_type }) => event_type)).toEqual([
      "oidc_binding.created",
      "browser_session.created",
      "oidc_binding.updated",
      "browser_session.revoked",
      "browser_session.created",
      "oidc_binding.disabled",
    ]);
  });

  it("rejects direct mutation of binding, transaction, and session identity", async () => {
    await expect(
      adminPool.query("UPDATE proofstack_oidc_bindings SET issuer = $1 WHERE binding_id = $2", [
        "https://other.example.test",
        bindingId,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      adminPool.query("DELETE FROM proofstack_oidc_bindings WHERE binding_id = $1", [bindingId]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      adminPool.query(
        "UPDATE proofstack_oidc_login_transactions SET protected_payload = protected_payload || 'A' WHERE state_digest IS NOT NULL",
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      adminPool.query(
        "UPDATE proofstack_browser_sessions SET session_digest = repeat('0', 64) WHERE tenant_id = $1",
        [tenantId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });
});
