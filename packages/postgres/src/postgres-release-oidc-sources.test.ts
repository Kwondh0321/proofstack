import type { EvidenceScope } from "@proofstack/contracts";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "@proofstack/core";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresIdentityDataIntegrityError } from "./postgres-api-key-credential-repository.js";
import {
  readPostgresReleaseOidcBindingOnClient,
  readPostgresReleaseOidcSessionOnClient,
  tryPostgresReleaseOidcSourceGuardOnClient,
} from "./postgres-release-oidc-sources.js";

const scope: EvidenceScope = {
  tenantId: "tenant_oidc",
  projectId: "project_oidc",
  environmentId: "environment_oidc",
};
const binding = {
  tenant_id: scope.tenantId,
  binding_id: "binding_oidc",
  principal_id: "principal_oidc",
  roles: ["viewer", "admin"],
  capabilities: ["release:read", "approval:decide"],
  resource_scope: { mode: "tenant" },
  authorization_version: 3,
  inactive: false,
  updated_at: "2026-10-16T01:00:00.000123Z",
};
const session = {
  tenant_id: scope.tenantId,
  binding_id: binding.binding_id,
  session_id: "session_oidc",
  principal_id: binding.principal_id,
  created_at: "2026-10-16T01:00:00.000123Z",
  absolute_expires_at: "2026-10-16T02:00:00.000123Z",
  idle_expires_at: "2026-10-16T01:30:00.000123Z",
  idle_lifetime_seconds: 1800,
  last_used_at: null,
  use_count: 0,
  revoked_at: null,
  revocation_reason: null,
};

function client(rows: Record<string, unknown>[]) {
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows }));
  return { query, view: { query } as unknown as Pick<PoolClient, "query"> };
}

describe("provided-client release OIDC sources", () => {
  it.each(["binding", "session"] as const)(
    "admits actual raw %s and absent observations on the original meter",
    async (kind) => {
      const meter = new ReleaseDecisionVerificationBudget({
        maxAcquisitionRecords: 2,
        maxAcquisitionRecordBytes: 65536,
        maxApprovalRecords: 0,
      });
      const raw = kind === "binding" ? binding : session;
      const read =
        kind === "binding"
          ? readPostgresReleaseOidcBindingOnClient
          : readPostgresReleaseOidcSessionOnClient;
      const id = kind === "binding" ? binding.binding_id : session.session_id;
      await read(client([raw]).view, scope, id, meter);
      expect(meter.snapshot().records).toBe(1);
      await expect(read(client([]).view, scope, id, meter)).resolves.toBeNull();
      expect(meter.snapshot().records).toBe(2);
      await expect(read(client([raw]).view, scope, id, meter)).rejects.toMatchObject({
        reason: "record_limit",
      });
      expect(() => meter.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
    },
  );
  it.each(["binding", "session"] as const)(
    "taints a caught malformed %s source before another source can be used",
    async (kind) => {
      const meter = new ReleaseDecisionVerificationBudget({
        maxAcquisitionRecords: 10,
        maxAcquisitionRecordBytes: 65536,
        maxApprovalRecords: 0,
      });
      const raw = { ...(kind === "binding" ? binding : session), principal_id: "INVALID" };
      const read =
        kind === "binding"
          ? readPostgresReleaseOidcBindingOnClient
          : readPostgresReleaseOidcSessionOnClient;
      const id = kind === "binding" ? binding.binding_id : session.session_id;
      await expect(read(client([raw]).view, scope, id, meter)).rejects.toMatchObject({
        reason: "source_read_failed",
        cause: expect.any(PostgresIdentityDataIntegrityError),
      });
      expect(() => meter.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
    },
  );
  it.each(["binding", "session"] as const)(
    "admits oversized raw %s bytes before schema interpretation",
    async (kind) => {
      const meter = new ReleaseDecisionVerificationBudget({
        maxAcquisitionRecords: 10,
        maxAcquisitionRecordBytes: 8192,
        maxApprovalRecords: 0,
      });
      const raw = {
        ...(kind === "binding" ? binding : session),
        unknown_large_field: "x".repeat(1024 * 1024),
      };
      const read =
        kind === "binding"
          ? readPostgresReleaseOidcBindingOnClient
          : readPostgresReleaseOidcSessionOnClient;
      const id = kind === "binding" ? binding.binding_id : session.session_id;
      await expect(read(client([raw]).view, scope, id, meter)).rejects.toMatchObject({
        reason: "byte_limit",
      });
      expect(() => meter.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
    },
  );
  it("returns the exact sanitized binding with sorted grants and full native precision", async () => {
    const fixture = client([binding]);
    const result = await readPostgresReleaseOidcBindingOnClient(
      fixture.view,
      scope,
      binding.binding_id,
    );
    expect(result).toEqual({
      identity: {
        kind: "oidc_binding",
        bindingId: binding.binding_id,
        principalId: binding.principal_id,
      },
      tenantId: scope.tenantId,
      state: "active",
      capabilities: ["approval:decide", "release:read"],
      roles: ["admin", "viewer"],
      resourceScope: { mode: "tenant" },
      revision: 3,
      updatedAt: binding.updated_at,
    });
    expect(binding.roles).toEqual(["viewer", "admin"]);
    expect(fixture.query).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^SELECT/), [
      scope.tenantId,
      binding.binding_id,
    ]);
  });

  it("retains inactive grants rather than filtering them out", async () => {
    const fixture = client([{ ...binding, inactive: true }]);
    await expect(
      readPostgresReleaseOidcBindingOnClient(fixture.view, scope, binding.binding_id),
    ).resolves.toMatchObject({ state: "inactive", revision: 3, updatedAt: binding.updated_at });
  });

  it("preserves the original native session without mutation or secret projections", async () => {
    const fixture = client([session]);
    const result = await readPostgresReleaseOidcSessionOnClient(
      fixture.view,
      scope,
      session.session_id,
    );
    expect(result).toEqual({
      schemaVersion: "0.1",
      kind: "oidc_session",
      credentialId: session.session_id,
      principalId: session.principal_id,
      tenantId: scope.tenantId,
      bindingId: binding.binding_id,
      createdAt: session.created_at,
      absoluteExpiresAt: session.absolute_expires_at,
      idleExpiresAt: session.idle_expires_at,
      idleLifetimeSeconds: 1800,
      lastUsedAt: null,
      useCount: 0,
      revokedAt: null,
      revocationReason: null,
    });
    const sql = String(fixture.query.mock.calls[0]?.[0]);
    expect(sql).not.toMatch(
      /session_digest|csrf_digest|issuer|subject|find_and_touch|\bUPDATE\b|\bBEGIN\b/,
    );
    expect(fixture.query).toHaveBeenCalledTimes(1);
  });

  it("retains used and revoked sessions without refreshing their clocks", async () => {
    const fixture = client([
      {
        ...session,
        last_used_at: "2026-10-16T01:40:00.000456Z",
        use_count: 2_147_483_647,
        idle_expires_at: session.absolute_expires_at,
        revoked_at: "2026-10-16T01:41:00.000789Z",
        revocation_reason: "administrative",
      },
    ]);
    await expect(
      readPostgresReleaseOidcSessionOnClient(fixture.view, scope, session.session_id),
    ).resolves.toMatchObject({
      useCount: 2_147_483_647,
      revokedAt: "2026-10-16T01:41:00.000789Z",
      idleExpiresAt: session.absolute_expires_at,
    });
  });

  it.each(["binding", "session"] as const)(
    "returns true absence for an empty %s query",
    async (kind) => {
      const fixture = client([]);
      const read =
        kind === "binding"
          ? readPostgresReleaseOidcBindingOnClient
          : readPostgresReleaseOidcSessionOnClient;
      await expect(read(fixture.view, scope, "source_missing")).resolves.toBeNull();
    },
  );

  it.each([
    { tenant_id: "tenant_other" },
    { binding_id: "binding_other" },
    { principal_id: null },
    { roles: ["admin", "admin"] },
    { roles: "admin" },
    { capabilities: ["approval:decide", 2] },
    { capabilities: ["approval:decide", "approval:decide"] },
    { inactive: "false" },
    { resource_scope: { mode: "*" } },
    { authorization_version: 0 },
    { updated_at: new Date() },
  ])("rejects malformed binding data without exposing the row: %j", async (change) => {
    const fixture = client([{ ...binding, ...change, private_marker: "never-print-this-row" }]);
    await expect(
      readPostgresReleaseOidcBindingOnClient(fixture.view, scope, binding.binding_id),
    ).rejects.toThrow(
      new PostgresIdentityDataIntegrityError("Stored release OIDC source is inconsistent"),
    );
  });

  it.each([
    { tenant_id: "tenant_other" },
    { session_id: "session_other" },
    { principal_id: null },
    { binding_id: "?" },
    { created_at: new Date() },
    { idle_expires_at: "2026-10-16T01:30:00.000124Z" },
    { use_count: 1 },
    { revoked_at: "2026-10-16T01:31:00.000000Z" },
    { revocation_reason: "unsupported" },
  ])("rejects malformed or missing-owner session data: %j", async (change) => {
    const fixture = client([{ ...session, ...change }]);
    await expect(
      readPostgresReleaseOidcSessionOnClient(fixture.view, scope, session.session_id),
    ).rejects.toBeInstanceOf(PostgresIdentityDataIntegrityError);
  });

  it.each(["binding", "session"] as const)("rejects duplicate %s rows", async (kind) => {
    const row = kind === "binding" ? binding : session;
    const fixture = client([row, row]);
    const read =
      kind === "binding"
        ? readPostgresReleaseOidcBindingOnClient
        : readPostgresReleaseOidcSessionOnClient;
    await expect(
      read(fixture.view, scope, kind === "binding" ? binding.binding_id : session.session_id),
    ).rejects.toBeInstanceOf(PostgresIdentityDataIntegrityError);
  });

  it.each([true, false])("preserves a strict boolean guard result %s", async (acquired) => {
    const fixture = client([{ acquired }]);
    await expect(
      tryPostgresReleaseOidcSourceGuardOnClient(fixture.view, "oidc_session", session.session_id),
    ).resolves.toBe(acquired);
    expect(fixture.query).toHaveBeenCalledExactlyOnceWith(
      "SELECT public.proofstack_try_lock_release_oidc_source($1, $2) AS acquired",
      ["oidc_session", session.session_id],
    );
  });

  it.each([
    { rows: [] },
    { rows: [{ acquired: "true" }] },
    { rows: [{ acquired: null }] },
    { rows: [{ acquired: true }, { acquired: true }] },
  ])("rejects malformed guard rows %j", async ({ rows }) => {
    await expect(
      tryPostgresReleaseOidcSourceGuardOnClient(
        client(rows).view,
        "oidc_binding",
        binding.binding_id,
      ),
    ).rejects.toBeInstanceOf(PostgresIdentityDataIntegrityError);
  });

  it("rejects invalid caller identities and scope before any query", async () => {
    const fixture = client([]);
    await expect(
      readPostgresReleaseOidcBindingOnClient(
        fixture.view,
        { ...scope, projectId: "?" },
        binding.binding_id,
      ),
    ).rejects.toThrow();
    await expect(
      readPostgresReleaseOidcSessionOnClient(fixture.view, scope, "?"),
    ).rejects.toThrow();
    await expect(
      tryPostgresReleaseOidcSourceGuardOnClient(
        fixture.view,
        "artifact" as "oidc_binding",
        binding.binding_id,
      ),
    ).rejects.toThrow("Unsupported");
    await expect(
      tryPostgresReleaseOidcSourceGuardOnClient(fixture.view, "oidc_binding", "?"),
    ).rejects.toThrow();
    expect(fixture.query).not.toHaveBeenCalled();
  });

  it("propagates database failures without a second connection or retry", async () => {
    const failure = new Error("connection lost");
    const query = vi.fn().mockRejectedValue(failure);
    const view = { query } as unknown as Pick<PoolClient, "query">;
    for (const operation of [
      () => readPostgresReleaseOidcBindingOnClient(view, scope, binding.binding_id),
      () => readPostgresReleaseOidcSessionOnClient(view, scope, session.session_id),
      () => tryPostgresReleaseOidcSourceGuardOnClient(view, "oidc_binding", binding.binding_id),
    ])
      await expect(operation()).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(3);
  });
});
