import {
  generateBrowserSessionCredentials,
  generateOidcLoginSecrets,
  generateOidcTransactionSecret,
  OidcBindingNotActiveError,
  oidcIdentityDigest,
  OidcLoginTransactionCipher,
  OidcLoginTransactionConflictError,
} from "@proofstack/identity";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresOidcIdentityRepository } from "./postgres-oidc-identity-repository.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const runKey = Date.now().toString();
const runtimeRole = `proofstack_it_oidc_repo_${runKey}`;
const runtimePassword = `proofstack-oidc-repo-${runKey}-password`;
const tenantId = `ten_oidc_repo_${runKey}`;
const bindingId = `oidc_repo_${runKey}`;
const disabledBindingId = `oidc_disabled_${runKey}`;
const issuer = `https://identity-${runKey}.example.test`;
const subject = `provider-subject-${runKey}`;
const actorPrincipalId = `usr_admin_${runKey}`;
const userPrincipalId = `usr_operator_${runKey}`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
let identityPool: Pool;
let repository: PostgresOidcIdentityRepository;

async function asAdminTenant<Result>(
  operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('proofstack.tenant_id', $1, true)", [tenantId]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createBinding(binding: string, bindingSubject: string): Promise<void> {
  await asAdminTenant((client) =>
    client.query(
      `
        SELECT created_at
        FROM public.proofstack_create_oidc_binding(
          $1, $2, $3, $4, $5, $6, $7::text[], $8::text[], $9::jsonb, $10
        )
      `,
      [
        tenantId,
        binding,
        oidcIdentityDigest(issuer, bindingSubject),
        issuer,
        bindingSubject,
        userPrincipalId,
        ["admin"],
        ["project:read", "evidence:read", "identity:manage"],
        JSON.stringify({ mode: "tenant" }),
        actorPrincipalId,
      ],
    ),
  );
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
      public.proofstack_find_active_oidc_binding(text, text, text),
      public.proofstack_create_oidc_login_transaction(text, text, integer),
      public.proofstack_consume_oidc_login_transaction(text),
      public.proofstack_purge_oidc_login_transactions(),
      public.proofstack_create_browser_session(text, text, text, text, integer, integer),
      public.proofstack_find_and_touch_active_browser_session(text),
      public.proofstack_revoke_browser_session(text),
      public.proofstack_purge_browser_sessions()
    TO "${runtimeRole}"
  `);

  await createBinding(bindingId, subject);
  await createBinding(disabledBindingId, `${subject}-disabled`);

  const url = new URL(databaseUrl as string);
  url.username = runtimeRole;
  url.password = runtimePassword;
  identityPool = new Pool({ connectionString: url.toString(), max: 2 });
  repository = new PostgresOidcIdentityRepository(identityPool);
});

afterAll(async () => {
  await identityPool?.end();
  await adminPool.query(`DROP OWNED BY "${runtimeRole}"`);
  await adminPool.query(`DROP ROLE "${runtimeRole}"`);
  await adminPool.end();
});

describe("PostgresOidcIdentityRepository", () => {
  it("looks up an exact active OIDC binding without base-table access", async () => {
    await expect(repository.findActiveByIssuerSubject(issuer, subject)).resolves.toEqual({
      bindingId,
      capabilities: ["project:read", "evidence:read", "identity:manage"],
      issuer,
      principalId: userPrincipalId,
      resourceScope: { mode: "tenant" },
      roles: ["admin"],
      subject,
      tenantId,
    });
    await expect(
      repository.findActiveByIssuerSubject(issuer, `${subject}-unknown`),
    ).resolves.toBeNull();
    await expect(
      identityPool.query("SELECT * FROM proofstack_oidc_bindings"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("persists, consumes once, and collision-protects encrypted login transactions", async () => {
    const secrets = generateOidcLoginSecrets();
    const cipher = new OidcLoginTransactionCipher(generateOidcTransactionSecret());
    const protectedPayload = cipher.encrypt({
      codeVerifier: secrets.codeVerifier,
      nonce: secrets.nonce,
      returnTo: "/traces",
      state: secrets.state,
    });

    const created = await repository.create({
      lifetimeSeconds: 600,
      protectedPayload,
      stateDigest: secrets.stateDigest,
    });
    expect(new Date(created.expiresAt).getTime() - new Date(created.createdAt).getTime()).toBe(
      600_000,
    );

    const consumed = await repository.consumeActive(secrets.stateDigest);
    expect(consumed).toEqual({ protectedPayload, stateDigest: secrets.stateDigest });
    expect(cipher.decrypt(consumed?.protectedPayload ?? "")).toEqual({
      codeVerifier: secrets.codeVerifier,
      nonce: secrets.nonce,
      returnTo: "/traces",
      state: secrets.state,
    });
    await expect(repository.consumeActive(secrets.stateDigest)).resolves.toBeNull();
    await expect(
      repository.create({
        lifetimeSeconds: 600,
        protectedPayload,
        stateDigest: secrets.stateDigest,
      }),
    ).rejects.toBeInstanceOf(OidcLoginTransactionConflictError);
  });

  it("re-reads current binding authorization on every session use and revokes exactly once", async () => {
    const credentials = generateBrowserSessionCredentials();
    const sessionId = `ses_oidc_repo_${runKey}`;
    const created = await repository.create({
      absoluteLifetimeSeconds: 43_200,
      bindingId,
      csrfDigest: credentials.csrfDigest,
      idleLifetimeSeconds: 1_800,
      sessionDigest: credentials.sessionDigest,
      sessionId,
    });
    expect(created.sessionId).toBe(sessionId);
    expect(
      new Date(created.absoluteExpiresAt).getTime() - new Date(created.createdAt).getTime(),
    ).toBe(43_200_000);

    await expect(repository.findAndTouchActive(credentials.sessionDigest)).resolves.toMatchObject({
      capabilities: ["project:read", "evidence:read", "identity:manage"],
      roles: ["admin"],
      sessionId,
      tenantId,
    });

    await asAdminTenant((client) =>
      client.query(
        `
          SELECT updated_at
          FROM public.proofstack_update_oidc_binding(
            $1, $2, $3::text[], $4::text[], $5::jsonb, $6
          )
        `,
        [
          tenantId,
          bindingId,
          ["viewer"],
          ["project:read"],
          JSON.stringify({
            mode: "restricted",
            projects: [{ environmentIds: [`env_${runKey}`], projectId: `prj_${runKey}` }],
          }),
          actorPrincipalId,
        ],
      ),
    );

    await expect(repository.findAndTouchActive(credentials.sessionDigest)).resolves.toMatchObject({
      capabilities: ["project:read"],
      resourceScope: {
        mode: "restricted",
        projects: [{ environmentIds: [`env_${runKey}`], projectId: `prj_${runKey}` }],
      },
      roles: ["viewer"],
    });
    await expect(repository.revokeActive(credentials.sessionDigest)).resolves.toBe(true);
    await expect(repository.revokeActive(credentials.sessionDigest)).resolves.toBe(false);
    await expect(repository.findAndTouchActive(credentials.sessionDigest)).resolves.toBeNull();
  });

  it("rejects session creation after a binding is disabled", async () => {
    await asAdminTenant((client) =>
      client.query("SELECT proofstack_disable_oidc_binding($1, $2, $3, $4)", [
        tenantId,
        disabledBindingId,
        actorPrincipalId,
        "access removed",
      ]),
    );
    const credentials = generateBrowserSessionCredentials();

    await expect(
      repository.create({
        absoluteLifetimeSeconds: 43_200,
        bindingId: disabledBindingId,
        csrfDigest: credentials.csrfDigest,
        idleLifetimeSeconds: 1_800,
        sessionDigest: credentials.sessionDigest,
        sessionId: `ses_oidc_disabled_${runKey}`,
      }),
    ).rejects.toBeInstanceOf(OidcBindingNotActiveError);
    await expect(
      repository.findActiveByIssuerSubject(issuer, `${subject}-disabled`),
    ).resolves.toBeNull();
  });

  it("runs bounded retention maintenance through exact functions", async () => {
    await expect(repository.purgeExpiredTransactions()).resolves.toBe(0);
    await expect(repository.purgeExpiredSessions()).resolves.toBe(0);
  });
});
