import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Capability, EvidenceScope } from "@proofstack/contracts";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "@proofstack/core";
import {
  generateBrowserSessionCredentials,
  oidcIdentityDigest,
  OidcSessionAuthenticator,
  ReleaseMutationAuthenticator,
  type ReleaseMutationOperation,
} from "@proofstack/identity";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresOidcIdentityRepository } from "./postgres-oidc-identity-repository.js";
import { recheckPostgresReleaseOidcMutationOnClient } from "./postgres-release-oidc-mutation.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, max: 6 });
const repository = new PostgresOidcIdentityRepository(pool);
const auth = new ReleaseMutationAuthenticator(new OidcSessionAuthenticator(repository));
const key = randomUUID().replaceAll("-", "").slice(0, 12);
const caps: Capability[] = [
  "approval:decide",
  "approval:authority:manage",
  "release:selection:manage",
  "release:decision:publish",
];
const meter = () =>
  new ReleaseDecisionVerificationBudget({
    maxAcquisitionRecords: 1000,
    maxAcquisitionRecordBytes: 1024 * 1024,
    maxApprovalRecords: 0,
  });
let sequence = 0;
async function begin(client: PoolClient, scope: EvidenceScope, isolation = "READ COMMITTED") {
  // Fixed fixture isolation only, never application SQL input.
  await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  await client.query(
    `SELECT set_config('proofstack.tenant_id',$1,true), set_config('proofstack.project_id',$2,true), set_config('proofstack.environment_id',$3,true)`,
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
async function fixture(operation: ReleaseMutationOperation = "record_approval", sharedId?: string) {
  sequence += 1;
  const scope: EvidenceScope = {
    tenantId: `tenant_mutation_${key}_${sequence}`,
    projectId: "project_mutation",
    environmentId: "environment_mutation",
  };
  const id = sharedId ?? `${key}_${sequence}`;
  const bindingId = `binding_mutation_${id}`,
    sessionId = `session_mutation_${id}`,
    principalId = `user_mutation_${id}`;
  const client = await pool.connect();
  try {
    await begin(client, scope);
    const issuer = `https://release-mutation.example.test/${scope.tenantId}`;
    await client.query(
      "SELECT * FROM public.proofstack_create_oidc_binding($1,$2,$3,$4,$5,$6,$7::text[],$8::text[],$9::jsonb,$10)",
      [
        scope.tenantId,
        bindingId,
        oidcIdentityDigest(issuer, id),
        issuer,
        id,
        principalId,
        ["member"],
        caps,
        JSON.stringify({ mode: "tenant" }),
        "user_fixture_installer",
      ],
    );
    await client.query("COMMIT");
  } finally {
    await close(client);
  }
  const credentials = generateBrowserSessionCredentials();
  await repository.create({
    bindingId,
    sessionId,
    ...credentials,
    absoluteLifetimeSeconds: 3600,
    idleLifetimeSeconds: 1800,
  });
  const requestId = `request_mutation_${key}_${sequence}`;
  const method = {
    record_approval: "authenticateApprovalReviewer",
    publish_decision: "authenticateDecisionPublisher",
    manage_selection: "authenticateSelectionInstaller",
    manage_reviewer_authority: "authenticateReviewerAuthorityAdministrator",
  } as const;
  const authentication = await auth[method[operation]]({
    sessionToken: credentials.sessionToken,
    csrfToken: credentials.csrfToken,
    scope,
    requestId,
  });
  return {
    scope,
    bindingId,
    sessionId,
    principalId,
    credentials,
    input: { authentication, scope, operation, requestId, budget: meter() },
  };
}
beforeAll(async () => {
  expect((await pool.query("SELECT current_database() AS name")).rows[0]?.name).toBe(
    "proofstack_test",
  );
  await migrateDatabase(pool);
});
afterAll(async () => {
  await pool.end();
});

describe("actual OIDC/CSRF to held native release identity guards", () => {
  it.each([
    "record_approval",
    "publish_decision",
    "manage_selection",
    "manage_reviewer_authority",
  ] as const)(
    "rechecks actual %s on one unchanged caller transaction and native cut",
    async (operation) => {
      const value = await fixture(operation),
        client = await pool.connect();
      try {
        await begin(client, value.scope);
        await client.query("SAVEPOINT original_owner");
        const identity = (
          await client.query("SELECT pg_backend_pid() AS pid, txid_current()::text AS xid")
        ).rows;
        const before = (
          await client.query(
            "SELECT use_count, last_used_at::text, idle_expires_at::text FROM public.proofstack_browser_sessions WHERE tenant_id=$1 AND session_id=$2",
            [value.scope.tenantId, value.sessionId],
          )
        ).rows;
        const report = await recheckPostgresReleaseOidcMutationOnClient(client, value.input);
        expect(report.receipt).toMatchObject({
          principalId: value.principalId,
          credentialId: value.sessionId,
          authenticationMethod: "oidc",
        });
        expect(report.grant.record.capabilities).toEqual([...caps].sort());
        expect(report.capturedAt).toMatch(/\.\d{6}Z$/);
        expect(value.input.budget.snapshot()).toMatchObject({ records: 9, approvalRecords: 0 });
        expect(
          (await client.query("SELECT pg_backend_pid() AS pid, txid_current()::text AS xid")).rows,
        ).toEqual(identity);
        expect(
          (
            await client.query(
              "SELECT use_count, last_used_at::text, idle_expires_at::text FROM public.proofstack_browser_sessions WHERE tenant_id=$1 AND session_id=$2",
              [value.scope.tenantId, value.sessionId],
            )
          ).rows,
        ).toEqual(before);
        await client.query("ROLLBACK TO SAVEPOINT original_owner");
      } finally {
        await close(client);
      }
    },
  );
  it.each(["revoke", "withdraw_capability"] as const)(
    "refuses %s after actual authentication and taints the same meter",
    async (change) => {
      const value = await fixture();
      if (change === "revoke") await repository.revokeActive(value.credentials.sessionDigest);
      else {
        const writer = await pool.connect();
        try {
          await begin(writer, value.scope);
          await writer.query(
            "SELECT public.proofstack_update_oidc_binding($1,$2,$3::text[],$4::text[],$5::jsonb,$6)",
            [
              value.scope.tenantId,
              value.bindingId,
              ["member"],
              ["release:read"],
              JSON.stringify({ mode: "tenant" }),
              "user_fixture_installer",
            ],
          );
          await writer.query("COMMIT");
        } finally {
          await close(writer);
        }
      }
      const client = await pool.connect();
      try {
        await begin(client, value.scope);
        await expect(
          recheckPostgresReleaseOidcMutationOnClient(client, value.input),
        ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
        expect(() => value.input.budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
      } finally {
        await close(client);
      }
    },
  );
  it("retains its guards after returning and blocks a real revocation until the owner rolls back", async () => {
    const value = await fixture(),
      reader = await pool.connect(),
      writer = await pool.connect();
    let writing: Promise<unknown> | undefined;
    try {
      await begin(reader, value.scope);
      await begin(writer, value.scope);
      await recheckPostgresReleaseOidcMutationOnClient(reader, value.input);
      const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      writing = writer.query("SELECT public.proofstack_revoke_browser_session($1)", [
        value.credentials.sessionDigest,
      ]);
      void writing.catch(() => undefined);
      const deadline = Date.now() + 3000;
      let blocked = false;
      while (Date.now() < deadline) {
        blocked =
          (await pool.query("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [pid])).rows[0]
            ?.blocked === true;
        if (blocked) break;
        await delay(10);
      }
      expect(blocked).toBe(true);
      expect(
        (
          await reader.query(
            "SELECT revoked_at FROM public.proofstack_browser_sessions WHERE tenant_id=$1 AND session_id=$2",
            [value.scope.tenantId, value.sessionId],
          )
        ).rows[0]?.revoked_at,
      ).toBeNull();
      await reader.query("ROLLBACK");
      await writing;
      await writer.query("COMMIT");
      await begin(reader, value.scope);
      const persisted = await reader.query(
        "SELECT revoked_at IS NOT NULL AS revoked FROM public.proofstack_browser_sessions WHERE tenant_id=$1 AND session_id=$2",
        [value.scope.tenantId, value.sessionId],
      );
      expect(persisted.rows[0]?.revoked).toBe(true);
    } finally {
      try {
        await close(reader);
        if (writing) await writing;
      } finally {
        await close(writer);
      }
    }
  });
  it("does not wait for a contended derived binding guard and requires whole rollback", async () => {
    const value = await fixture(),
      reader = await pool.connect(),
      writer = await pool.connect();
    try {
      await begin(writer, value.scope);
      await writer.query(
        "SELECT public.proofstack_update_oidc_binding($1,$2,$3::text[],$4::text[],$5::jsonb,$6)",
        [
          value.scope.tenantId,
          value.bindingId,
          ["member"],
          caps,
          JSON.stringify({ mode: "tenant" }),
          "user_fixture_installer",
        ],
      );
      await begin(reader, value.scope);
      await expect(
        recheckPostgresReleaseOidcMutationOnClient(reader, value.input),
      ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
      expect(() => value.input.budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
      await reader.query("ROLLBACK");
      await writer.query("ROLLBACK");
    } finally {
      await close(reader);
      await close(writer);
    }
  });
  it("preserves globally unique OIDC IDs and refuses proof substitution across three populated tenant scopes", async () => {
    const shared = `shared_${key}`;
    await fixture("record_approval", shared);
    await expect(fixture("record_approval", shared)).rejects.toMatchObject({
      code: "23505",
      constraint: "proofstack_oidc_binding_id_unique",
    });
    const values = [await fixture(), await fixture(), await fixture()];
    for (const value of values) {
      const client = await pool.connect();
      try {
        await begin(client, value.scope);
        const report = await recheckPostgresReleaseOidcMutationOnClient(client, value.input);
        expect(report.credential.record.tenantId).toBe(value.scope.tenantId);
        const other = values.find((item) => item.scope.tenantId !== value.scope.tenantId);
        if (!other) throw new Error("Missing independently populated tenant fixture");
        await expect(
          recheckPostgresReleaseOidcMutationOnClient(client, {
            ...value.input,
            authentication: other.input.authentication,
            requestId: other.input.requestId,
          }),
        ).rejects.toThrow("Invalid release mutation authentication");
      } finally {
        await close(client);
      }
    }
  });
});
