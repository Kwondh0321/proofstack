import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { EvidenceScope } from "@proofstack/contracts";
import { generateBrowserSessionCredentials, oidcIdentityDigest } from "@proofstack/identity";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresOidcIdentityRepository } from "./postgres-oidc-identity-repository.js";
import {
  type ReleaseOidcSourceKind,
  readPostgresReleaseOidcBindingOnClient,
  readPostgresReleaseOidcSessionOnClient,
  tryPostgresReleaseOidcSourceGuardOnClient,
} from "./postgres-release-oidc-sources.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const key = randomUUID().replaceAll("-", "").slice(0, 12);
const scope: EvidenceScope = {
  tenantId: `tenant_oidc_cut_${key}`,
  projectId: "project_oidc_cut",
  environmentId: "environment_oidc_cut",
};
const role = `ps_oidc_cut_${key}`;
let counter = 0;

async function begin(client: PoolClient, exact = scope) {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  await client.query(
    `SELECT set_config('proofstack.tenant_id', $1, true),
              set_config('proofstack.project_id', $2, true),
              set_config('proofstack.environment_id', $3, true)`,
    [exact.tenantId, exact.projectId, exact.environmentId],
  );
}

async function scoped(exact = scope): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    await begin(client, exact);
    return client;
  } catch (error) {
    client.release(true);
    throw error;
  }
}

async function close(client: PoolClient) {
  try {
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

function ids() {
  counter += 1;
  return {
    bindingId: `binding_cut_${key}_${counter}`,
    sessionId: `session_cut_${key}_${counter}`,
    principalId: `principal_cut_${key}_${counter}`,
  };
}

async function createBinding(client: PoolClient, value: ReturnType<typeof ids>) {
  const issuer = "https://release-oidc-cut.example.test";
  const subject = value.bindingId;
  await client.query(
    `SELECT * FROM public.proofstack_create_oidc_binding(
       $1,$2,$3,$4,$5,$6,$7::text[],$8::text[],$9::jsonb,$10)`,
    [
      scope.tenantId,
      value.bindingId,
      oidcIdentityDigest(issuer, subject),
      issuer,
      subject,
      value.principalId,
      ["viewer", "admin"],
      ["release:read", "approval:decide"],
      JSON.stringify({ mode: "tenant" }),
      "principal_installer",
    ],
  );
}

async function fixture() {
  const value = ids();
  const client = await scoped();
  try {
    await createBinding(client, value);
    await client.query("COMMIT");
  } finally {
    await close(client);
  }
  const credentials = generateBrowserSessionCredentials();
  await new PostgresOidcIdentityRepository(pool).create({
    bindingId: value.bindingId,
    sessionId: value.sessionId,
    ...credentials,
    absoluteLifetimeSeconds: 3600,
    idleLifetimeSeconds: 1800,
  });
  return { ...value, credentials };
}

beforeAll(async () => {
  expect((await pool.query("SELECT current_database() AS name")).rows[0]?.name).toBe(
    "proofstack_test",
  );
  await migrateDatabase(pool);
  await pool.query(
    `CREATE ROLE "${role}" NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  await pool.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
});

afterAll(async () => {
  await pool.query(`DROP OWNED BY "${role}"`);
  await pool.query(`DROP ROLE "${role}"`);
  await pool.end();
});

describe("native release OIDC source guards and observations", () => {
  it("reads native microseconds without touching the session and retains inactive/revoked state", async () => {
    const value = await fixture();
    const client = await scoped();
    try {
      await client.query("SAVEPOINT original_transaction");
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      expect(
        await tryPostgresReleaseOidcSourceGuardOnClient(client, "oidc_binding", value.bindingId),
      ).toBe(true);
      expect(
        await tryPostgresReleaseOidcSourceGuardOnClient(client, "oidc_session", value.sessionId),
      ).toBe(true);
      const before = (
        await client.query(
          "SELECT idle_expires_at::text, last_used_at::text, use_count FROM public.proofstack_browser_sessions WHERE session_id=$1",
          [value.sessionId],
        )
      ).rows;
      const view = { query: client.query.bind(client) } as Pick<PoolClient, "query">;
      const binding = await readPostgresReleaseOidcBindingOnClient(view, scope, value.bindingId);
      const session = await readPostgresReleaseOidcSessionOnClient(view, scope, value.sessionId);
      expect(binding).toMatchObject({
        state: "active",
        identity: { principalId: value.principalId },
        roles: ["admin", "viewer"],
      });
      expect(session).toMatchObject({
        principalId: value.principalId,
        useCount: 0,
        lastUsedAt: null,
      });
      expect(session?.createdAt).toMatch(/\.\d{6}Z$/);
      expect(
        (
          await client.query(
            "SELECT idle_expires_at::text, last_used_at::text, use_count FROM public.proofstack_browser_sessions WHERE session_id=$1",
            [value.sessionId],
          )
        ).rows,
      ).toEqual(before);
      expect((await client.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid).toBe(pid);
      // The helpers never committed or replaced this caller-owned transaction/savepoint.
      await client.query("ROLLBACK TO SAVEPOINT original_transaction");
      await client.query("SELECT public.proofstack_disable_oidc_binding($1,$2,$3,$4)", [
        scope.tenantId,
        value.bindingId,
        "principal_installer",
        "fixture disabled",
      ]);
      const inactive = await readPostgresReleaseOidcBindingOnClient(client, scope, value.bindingId);
      expect(inactive).toMatchObject({ state: "inactive", revision: 1 });
      expect(inactive?.updatedAt).toBe(
        (
          await client.query(
            `SELECT to_char(disabled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
         FROM public.proofstack_oidc_bindings WHERE binding_id=$1`,
            [value.bindingId],
          )
        ).rows[0]?.at,
      );
      await client.query("SELECT public.proofstack_revoke_browser_session($1)", [
        value.credentials.sessionDigest,
      ]);
      expect(
        await readPostgresReleaseOidcSessionOnClient(client, scope, value.sessionId),
      ).toMatchObject({ revocationReason: "binding_disabled", useCount: 0 });
      expect(
        await readPostgresReleaseOidcSessionOnClient(
          client,
          { ...scope, tenantId: "tenant_other" },
          value.sessionId,
        ),
      ).toBeNull();
    } finally {
      await close(client);
    }
  });

  it.each(["oidc_binding", "oidc_session"] as const)(
    "protects absent %s creation on the same physical identity",
    async (kind) => {
      const value = kind === "oidc_binding" ? ids() : await fixture();
      const sourceId = kind === "oidc_binding" ? value.bindingId : `absent_session_${key}`;
      const reader = await scoped();
      const writer = await scoped();
      let write: Promise<unknown> | undefined;
      try {
        expect(await tryPostgresReleaseOidcSourceGuardOnClient(reader, kind, sourceId)).toBe(true);
        const read = () =>
          kind === "oidc_binding"
            ? readPostgresReleaseOidcBindingOnClient(reader, scope, sourceId)
            : readPostgresReleaseOidcSessionOnClient(reader, scope, sourceId);
        expect(await read()).toBeNull();
        const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        if (kind === "oidc_binding") write = createBinding(writer, value);
        else {
          const credentials = generateBrowserSessionCredentials();
          write = writer.query(
            "SELECT * FROM public.proofstack_create_browser_session($1,$2,$3,$4,$5,$6)",
            [
              sourceId,
              credentials.sessionDigest,
              credentials.csrfDigest,
              value.bindingId,
              3600,
              1800,
            ],
          );
        }
        // Attach immediately without replacing the original promise/error. Await it below;
        // a failed writer must not become an unhandled rejection while we inspect lock state.
        void write.catch(() => undefined);
        // Observe a real advisory-lock wait, not a scheduling-dependent timer assertion.
        const deadline = Date.now() + 3000;
        let blocked = false;
        while (Date.now() < deadline) {
          blocked =
            (
              await pool.query("SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [
                writerPid,
              ])
            ).rows[0]?.blocked === true;
          if (blocked) break;
          await delay(10);
        }
        expect(blocked).toBe(true);
        expect(await read()).toBeNull();
        await reader.query("ROLLBACK");
        await write;
        await writer.query("COMMIT");
        await begin(reader);
        expect(await tryPostgresReleaseOidcSourceGuardOnClient(reader, kind, sourceId)).toBe(true);
        expect(await read()).not.toBeNull();
      } finally {
        await reader.query("ROLLBACK");
        await write?.catch(() => undefined);
        await close(reader);
        await close(writer);
      }
    },
  );

  it.each(["grant", "disable", "disable_session", "touch", "revoke", "purge"] as const)(
    "blocks %s writes until the held observation ends",
    async (operation) => {
      const value = await fixture();
      if (operation === "purge") {
        // An authentic old receipt, not a destructive deletion of a live session.
        const seed = await scoped();
        try {
          const credentials = generateBrowserSessionCredentials();
          await seed.query(
            `INSERT INTO public.proofstack_browser_sessions
          (tenant_id,session_id,session_digest,csrf_digest,binding_id,created_at,
           absolute_expires_at,idle_lifetime_seconds,idle_expires_at)
          VALUES($1,$2,$3,$4,$5,statement_timestamp()-interval '32 days',
           statement_timestamp()-interval '32 days'+interval '1 hour',1800,
           statement_timestamp()-interval '32 days'+interval '30 minutes')`,
            [
              scope.tenantId,
              `old_${value.sessionId}`,
              credentials.sessionDigest,
              credentials.csrfDigest,
              value.bindingId,
            ],
          );
          await seed.query("COMMIT");
        } finally {
          await close(seed);
        }
      }
      const kind: ReleaseOidcSourceKind =
        operation === "grant" || operation === "disable" ? "oidc_binding" : "oidc_session";
      const sourceId =
        kind === "oidc_binding"
          ? value.bindingId
          : operation === "purge"
            ? `old_${value.sessionId}`
            : value.sessionId;
      const reader = await scoped();
      const writer = await scoped();
      try {
        expect(await tryPostgresReleaseOidcSourceGuardOnClient(reader, kind, sourceId)).toBe(true);
        await writer.query("SET LOCAL lock_timeout = '250ms'");
        const write = () => {
          switch (operation) {
            case "grant":
              return writer.query(
                `SELECT * FROM public.proofstack_update_oidc_binding($1,$2,$3::text[],$4::text[],$5::jsonb,$6)`,
                [
                  scope.tenantId,
                  value.bindingId,
                  ["viewer"],
                  ["release:read"],
                  JSON.stringify({ mode: "tenant" }),
                  "principal_installer",
                ],
              );
            case "disable":
            case "disable_session":
              return writer.query("SELECT public.proofstack_disable_oidc_binding($1,$2,$3,$4)", [
                scope.tenantId,
                value.bindingId,
                "principal_installer",
                "fixture disabled",
              ]);
            case "touch":
              return writer.query(
                "SELECT * FROM public.proofstack_find_and_touch_active_browser_session($1)",
                [value.credentials.sessionDigest],
              );
            case "revoke":
              return writer.query("SELECT public.proofstack_revoke_browser_session($1)", [
                value.credentials.sessionDigest,
              ]);
            case "purge":
              return writer.query("SELECT public.proofstack_purge_browser_sessions()");
          }
        };
        await expect(write()).rejects.toMatchObject({ code: "55P03" });
        await writer.query("ROLLBACK");
        if (kind === "oidc_binding")
          expect(
            await readPostgresReleaseOidcBindingOnClient(reader, scope, sourceId),
          ).toMatchObject({ state: "active", revision: 1 });
        else
          expect(
            await readPostgresReleaseOidcSessionOnClient(reader, scope, sourceId),
          ).toMatchObject({ revokedAt: null, useCount: 0 });
        await reader.query("ROLLBACK");
        await begin(writer);
        await writer.query("SET LOCAL statement_timeout = '3s'");
        await write();
        await writer.query("COMMIT");
        await begin(reader);
        expect(await tryPostgresReleaseOidcSourceGuardOnClient(reader, kind, sourceId)).toBe(true);
        if (operation === "grant")
          expect(
            await readPostgresReleaseOidcBindingOnClient(reader, scope, sourceId),
          ).toMatchObject({ revision: 2, roles: ["viewer"], capabilities: ["release:read"] });
        if (operation === "disable")
          expect(
            await readPostgresReleaseOidcBindingOnClient(reader, scope, sourceId),
          ).toMatchObject({ state: "inactive", revision: 1 });
        if (operation === "touch")
          expect(
            await readPostgresReleaseOidcSessionOnClient(reader, scope, sourceId),
          ).toMatchObject({ useCount: 1 });
        if (operation === "revoke")
          expect(
            await readPostgresReleaseOidcSessionOnClient(reader, scope, sourceId),
          ).toMatchObject({ revocationReason: "logout" });
        if (operation === "disable_session")
          expect(
            await readPostgresReleaseOidcSessionOnClient(reader, scope, sourceId),
          ).toMatchObject({ revocationReason: "binding_disabled" });
        if (operation === "purge")
          expect(await readPostgresReleaseOidcSessionOnClient(reader, scope, sourceId)).toBeNull();
      } finally {
        await close(reader);
        await close(writer);
      }
    },
  );

  it("fails a reader immediately behind an existing writer and isolates tenant/kind keys", async () => {
    const value = await fixture();
    const writer = await scoped();
    const reader = await scoped();
    const other = await scoped({ ...scope, tenantId: "tenant_other" });
    try {
      await writer.query("SELECT public.proofstack_disable_oidc_binding($1,$2,$3,$4)", [
        scope.tenantId,
        value.bindingId,
        "principal_installer",
        "fixture disabled",
      ]);
      expect(
        await tryPostgresReleaseOidcSourceGuardOnClient(reader, "oidc_binding", value.bindingId),
      ).toBe(false);
      await reader.query("ROLLBACK"); // Whole rollback, never keep partial guards after false.
      expect(
        await tryPostgresReleaseOidcSourceGuardOnClient(other, "oidc_binding", value.bindingId),
      ).toBe(true);
      expect(
        await tryPostgresReleaseOidcSourceGuardOnClient(other, "oidc_session", value.bindingId),
      ).toBe(true);
    } finally {
      await close(writer);
      await close(reader);
      await close(other);
    }
  });

  it("requires exact scope, valid source kinds, READ COMMITTED, and explicit execution authority", async () => {
    const client = await pool.connect();
    try {
      for (const [setup, sql, values, code] of [
        [
          "BEGIN",
          "SELECT public.proofstack_try_lock_release_oidc_source($1,$2)",
          ["oidc_binding", "binding_missing"],
          "42501",
        ],
        [
          "BEGIN ISOLATION LEVEL REPEATABLE READ",
          "SELECT public.proofstack_try_lock_release_oidc_source($1,$2)",
          ["oidc_binding", "binding_missing"],
          "0A000",
        ],
        [
          "BEGIN",
          "SELECT public.proofstack_try_lock_release_oidc_source($1,$2)",
          ["artifact", "binding_missing"],
          "22023",
        ],
        [
          "BEGIN",
          "SELECT public.proofstack_try_lock_release_oidc_source($1,$2)",
          ["oidc_binding", "?"],
          "22023",
        ],
      ] as const) {
        await client.query(setup);
        if (code !== "42501")
          await client.query(
            `SELECT set_config('proofstack.tenant_id',$1,true),set_config('proofstack.project_id',$2,true),set_config('proofstack.environment_id',$3,true)`,
            [scope.tenantId, scope.projectId, scope.environmentId],
          );
        await expect(client.query(sql, [...values])).rejects.toMatchObject({ code });
        await client.query("ROLLBACK");
      }
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE "${role}"`);
      await expect(
        client.query(
          "SELECT public.proofstack_try_lock_release_oidc_source('oidc_binding','binding_missing')",
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE "${role}"`);
      await expect(
        readPostgresReleaseOidcBindingOnClient(client, scope, "binding_missing"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await close(client);
    }
  });
});
