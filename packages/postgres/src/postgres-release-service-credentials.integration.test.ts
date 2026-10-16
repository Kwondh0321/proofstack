import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { EvidenceScope } from "@proofstack/contracts";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "@proofstack/core";
import {
  generateApiKey,
  generateServiceToken,
  hashServiceTokenSecret,
  InvalidServiceTokenError,
  OidcSessionAuthenticator,
  ReleaseMutationAuthenticator,
  ServiceTokenAuthenticator,
  type ReleaseMutationAuthentication,
} from "@proofstack/identity";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresOidcIdentityRepository } from "./postgres-oidc-identity-repository.js";
import {
  PostgresReleaseServiceCredentialRepository,
  readPostgresReleaseServiceCredentialOnClient,
  recheckPostgresReleaseServicePublisherOnClient,
} from "./postgres-release-service-credentials.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const provider = new PostgresReleaseServiceCredentialRepository(pool);
const service = new ServiceTokenAuthenticator(provider);
const auth = new ReleaseMutationAuthenticator(
  new OidcSessionAuthenticator(new PostgresOidcIdentityRepository(pool)),
  service,
);
const key = randomUUID().replaceAll("-", "").slice(0, 8);
let sequence = 0;
const meter = () =>
  new ReleaseDecisionVerificationBudget({
    maxAcquisitionRecords: 1000,
    maxAcquisitionRecordBytes: 1024 * 1024,
    maxApprovalRecords: 0,
  });
async function begin(client: PoolClient, scope: EvidenceScope, isolation = "READ COMMITTED") {
  await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  await client.query(
    "SELECT set_config('proofstack.tenant_id',$1,true),set_config('proofstack.project_id',$2,true),set_config('proofstack.environment_id',$3,true)",
    [scope.tenantId, scope.projectId, scope.environmentId],
  );
}
async function close(client: PoolClient) {
  try {
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}
async function fixture(publish = true) {
  const scope = {
    tenantId: `tenant_service_${key}_${++sequence}`,
    projectId: "project_service",
    environmentId: "environment_service",
  };
  const token = generateServiceToken();
  const body = {
    credentialId: "credential_service_shared",
    principalId: "service_publisher_shared",
    prefix: token.prefix,
    passwordHash: await hashServiceTokenSecret(token.secret),
    resourceScope: {
      mode: "restricted",
      projects: [{ projectId: scope.projectId, environmentIds: [scope.environmentId] }],
    },
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  async function publishRecord() {
    const client = await pool.connect();
    try {
      await begin(client, scope);
      const result = await client.query(
        "SELECT public.proofstack_create_release_service_credential($1::jsonb,$2::jsonb) AS created",
        [JSON.stringify(scope), JSON.stringify(body)],
      );
      await client.query("COMMIT");
      return result.rows[0]?.created;
    } finally {
      await close(client);
    }
  }
  async function revoke() {
    const client = await pool.connect();
    try {
      await begin(client, scope);
      const r = await client.query(
        "SELECT public.proofstack_revoke_release_service_credential($1::jsonb,$2,'administrative') AS created",
        [JSON.stringify(scope), body.credentialId],
      );
      await client.query("COMMIT");
      return r.rows[0]?.created;
    } finally {
      await close(client);
    }
  }
  if (publish) expect(await publishRecord()).toBe(true);
  return { scope, token, body, publishRecord, revoke };
}
beforeAll(async () => {
  expect(
    (
      await pool.query(
        "SELECT current_database() AS name,current_setting('server_version') AS version",
      )
    ).rows,
  ).toEqual([{ name: "proofstack_test", version: "16.15" }]);
  await migrateDatabase(pool);
});
afterAll(async () => {
  await pool.end();
});
describe("actual native private service publisher authentication", () => {
  it("retains colliding credential/principal IDs across three tenants and rechecks every exact owner", async () => {
    const fixtures = [await fixture(), await fixture(), await fixture()];
    expect(new Set(fixtures.map((f) => f.body.credentialId)).size).toBe(1);
    for (const f of fixtures) {
      const principal = await service.authenticate(f.token.value, "request_three_tenants");
      expect(principal.tenantId).toBe(f.scope.tenantId);
      const client = await pool.connect();
      try {
        await begin(client, f.scope);
        const row = await readPostgresReleaseServiceCredentialOnClient(
          client,
          f.scope,
          f.body.credentialId,
          meter(),
        );
        expect(row?.credential.tenantId).toBe(f.scope.tenantId);
      } finally {
        await close(client);
      }
    }
  });
  it("refuses a stale isolation level before source reads", async () => {
    const f = await fixture(),
      authentication = await auth.authenticateServiceDecisionPublisher({
        serviceToken: f.token.value,
        requestId: "request_isolation",
        scope: f.scope,
      });
    const client = await pool.connect(),
      budget = meter();
    try {
      await begin(client, f.scope, "REPEATABLE READ");
      await expect(
        recheckPostgresReleaseServicePublisherOnClient(client, {
          authentication,
          scope: f.scope,
          requestId: "request_isolation",
          budget,
        }),
      ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
      expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
    } finally {
      await close(client);
    }
  });
  it("refuses contention without waiting or returning partial authority", async () => {
    const f = await fixture(),
      authentication = await auth.authenticateServiceDecisionPublisher({
        serviceToken: f.token.value,
        requestId: "request_contention",
        scope: f.scope,
      });
    const writer = await pool.connect(),
      reader = await pool.connect();
    try {
      await begin(writer, f.scope);
      await writer.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.release-service.v1',$1::text,$2::text)::text,0))",
        [f.scope.tenantId, f.body.credentialId],
      );
      await begin(reader, f.scope);
      const budget = meter();
      await expect(
        recheckPostgresReleaseServicePublisherOnClient(reader, {
          authentication,
          scope: f.scope,
          requestId: "request_contention",
          budget,
        }),
      ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
      expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
    } finally {
      await close(reader);
      await close(writer);
    }
  });
  it("forces resource/tenant RLS for a private credential table owner", async () => {
    const f = await fixture(),
      role = `ps_service_owner_${key}`;
    await pool.query(
      `CREATE ROLE "${role}" NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    const client = await pool.connect();
    try {
      await begin(client, f.scope);
      await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await client.query(
        `ALTER TABLE public.proofstack_release_service_credentials OWNER TO "${role}"`,
      );
      await client.query(`SET LOCAL ROLE "${role}"`);
      expect(
        (
          await client.query(
            "SELECT count(*)::integer AS count FROM public.proofstack_release_service_credentials",
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      for (const field of ["tenant_id", "project_id", "environment_id"]) {
        await client.query("SAVEPOINT context_check");
        await client.query("SELECT set_config($1,'scope_foreign',true)", [`proofstack.${field}`]);
        expect(
          (
            await client.query(
              "SELECT count(*)::integer AS count FROM public.proofstack_release_service_credentials",
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
        await client.query("ROLLBACK TO SAVEPOINT context_check");
      }
    } finally {
      await close(client);
      await pool.query(`DROP OWNED BY "${role}"`);
      await pool.query(`DROP ROLE "${role}"`);
    }
  });
  it.each(["principal_id", "password_hash", "resource_scope", "expires_at_lexical"])(
    "refuses mutation of immutable %s",
    async (field) => {
      const f = await fixture(),
        client = await pool.connect();
      try {
        await begin(client, f.scope);
        const assignment =
          field === "principal_id"
            ? "'principal_changed'"
            : field === "password_hash"
              ? "password_hash||'{\"cost\":16384}'::jsonb"
              : field === "resource_scope"
                ? '\'{"mode":"tenant"}\'::jsonb'
                : "'2030-01-01T00:00:00.000Z'";
        await expect(
          client.query(
            `UPDATE public.proofstack_release_service_credentials SET ${field}=${assignment} WHERE tenant_id=$1 AND credential_id=$2`,
            [f.scope.tenantId, f.body.credentialId],
          ),
        ).rejects.toMatchObject({ code: "55000" });
      } finally {
        await close(client);
      }
    },
  );
  it("verifies the real service secret and confirms complete native identity/grants without issuing approval power", async () => {
    const f = await fixture();
    const principal = await service.authenticate(f.token.value, "service_native_request");
    expect(principal).toMatchObject({
      principalType: "service",
      principalId: f.body.principalId,
      capabilities: ["release:decision:publish"],
      resourceScope: f.body.resourceScope,
      authentication: { method: "service_token", credentialId: f.body.credentialId },
    });
    const proof = await auth.authenticateServiceDecisionPublisher({
      serviceToken: f.token.value,
      requestId: "service_native_request",
      scope: f.scope,
    });
    const client = await pool.connect();
    try {
      await begin(client, f.scope);
      await client.query("SAVEPOINT owner");
      const before = (
        await client.query("SELECT pg_backend_pid() AS pid,txid_current()::text AS xid")
      ).rows;
      const result = await recheckPostgresReleaseServicePublisherOnClient(client, {
        authentication: proof,
        scope: f.scope,
        requestId: "service_native_request",
        budget: meter(),
      });
      expect(result.receipt.principalType).toBe("service");
      expect(result.grant.capabilities).toEqual(["release:decision:publish"]);
      expect(result.credential.revokedAt).toBeNull();
      expect(result.credentialLimit).toBe(f.body.expiresAt);
      const serialized = JSON.stringify(result);
      for (const secret of [
        f.token.value,
        f.token.prefix,
        f.body.passwordHash.salt,
        f.body.passwordHash.digest,
      ])
        expect(serialized.includes(secret)).toBe(false);
      expect(
        (await client.query("SELECT pg_backend_pid() AS pid,txid_current()::text AS xid")).rows,
      ).toEqual(before);
      await client.query("ROLLBACK TO SAVEPOINT owner");
    } finally {
      await close(client);
    }
  });
  it("rejects API keys and wrong service secrets", async () => {
    const f = await fixture();
    await expect(
      service.authenticate(generateApiKey().value, "request_api_key"),
    ).rejects.toBeInstanceOf(InvalidServiceTokenError);
    const wrong = generateServiceToken();
    await expect(
      service.authenticate(`pss_v1_${f.token.prefix}_${wrong.secret}`, "request_wrong"),
    ).rejects.toBeInstanceOf(InvalidServiceTokenError);
  });
  it("rechecks revocation after asynchronous secret verification and before native publication", async () => {
    const f = await fixture();
    const original = await provider.findActiveServiceByPrefix(f.token.prefix);
    if (!original) throw new Error("Missing private test fixture");
    const { authenticatedAt: _at, ...expected } = original;
    const proof = await auth.authenticateServiceDecisionPublisher({
      serviceToken: f.token.value,
      requestId: "request_revoke",
      scope: f.scope,
    });
    expect(await f.revoke()).toBe(true);
    expect(await f.revoke()).toBe(false);
    expect(await provider.confirmActiveServiceUse(expected)).toBe(false);
    await expect(
      service.authenticate(f.token.value, "request_after_revoke"),
    ).rejects.toBeInstanceOf(InvalidServiceTokenError);
    const client = await pool.connect(),
      budget = meter();
    try {
      await begin(client, f.scope);
      await expect(
        recheckPostgresReleaseServicePublisherOnClient(client, {
          authentication: proof,
          scope: f.scope,
          requestId: "request_revoke",
          budget,
        }),
      ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
      expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
    } finally {
      await close(client);
    }
    expect(await f.publishRecord()).toBe(false);
    expect(await provider.findActiveServiceByPrefix(f.token.prefix)).toBeNull();
  });
  it.each(["principalId", "passwordHash", "resourceScope"] as const)(
    "refuses a substituted %s on final native confirmation",
    async (field) => {
      const f = await fixture(),
        record = await provider.findActiveServiceByPrefix(f.token.prefix);
      if (!record) throw new Error("Missing private test fixture");
      const { authenticatedAt: _at, ...expected } = record;
      const different =
        field === "principalId"
          ? "service_other"
          : field === "passwordHash"
            ? await hashServiceTokenSecret(generateServiceToken().secret)
            : {
                mode: "restricted",
                projects: [{ projectId: "project_other", environmentIds: ["env_other"] }],
              };
      expect(await provider.confirmActiveServiceUse({ ...expected, [field]: different })).toBe(
        false,
      );
    },
  );
  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "refuses a substituted authenticated %s before native source acquisition",
    async (field) => {
      const f = await fixture();
      await expect(
        auth.authenticateServiceDecisionPublisher({
          serviceToken: f.token.value,
          requestId: "request_scope",
          scope: { ...f.scope, [field]: "scope_foreign" },
        }),
      ).rejects.toThrow();
    },
  );
  it("cannot turn a serialized receipt into private authentication", async () => {
    const f = await fixture(),
      client = await pool.connect();
    try {
      await begin(client, f.scope);
      await expect(
        recheckPostgresReleaseServicePublisherOnClient(client, {
          authentication: {} as ReleaseMutationAuthentication,
          scope: f.scope,
          requestId: "request_fake",
          budget: meter(),
        }),
      ).rejects.toThrow();
    } finally {
      await close(client);
    }
  });
  it.each(["absent", "revocation"] as const)(
    "holds %s stable through the caller's transaction",
    async (kind) => {
      const f = await fixture(kind !== "absent"),
        client = await pool.connect();
      let writing: Promise<unknown> | undefined;
      try {
        await begin(client, f.scope);
        expect(
          (
            await client.query(
              "SELECT public.proofstack_try_lock_release_service_credential($1::jsonb,$2) AS acquired",
              [JSON.stringify(f.scope), f.body.credentialId],
            )
          ).rows,
        ).toEqual([{ acquired: true }]);
        const before = await readPostgresReleaseServiceCredentialOnClient(
          client,
          f.scope,
          f.body.credentialId,
          meter(),
        );
        expect(before === null).toBe(kind === "absent");
        writing = kind === "absent" ? f.publishRecord() : f.revoke();
        void writing.catch(() => undefined);
        let blocked = false;
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          blocked =
            (
              await pool.query(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%proofstack_%release_service_credential%') AS blocked",
              )
            ).rows[0]?.blocked === true;
          if (blocked) break;
          await delay(10);
        }
        expect(blocked).toBe(true);
        expect(
          await readPostgresReleaseServiceCredentialOnClient(
            client,
            f.scope,
            f.body.credentialId,
            meter(),
          ),
        ).toEqual(before);
        await client.query("ROLLBACK");
        await writing;
        const lookup = await provider.findActiveServiceByPrefix(f.token.prefix);
        expect(lookup === null).toBe(kind === "revocation");
      } finally {
        await close(client);
        if (writing) await writing;
      }
    },
  );
});
