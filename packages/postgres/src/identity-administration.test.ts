import type { IssueApiKeyOptions } from "@proofstack/identity";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  bootstrapApiKey,
  type BootstrapApiKeyOptions,
  inspectIdentityCredentials,
} from "./identity-administration.js";

const options: BootstrapApiKeyOptions = {
  actorPrincipalId: "usr_platform_operator",
  capabilities: ["evidence:ingest", "evidence:read"],
  expiresAt: "2026-11-26T04:00:00.000Z",
  name: "production-ingestion",
  resourceScope: {
    mode: "restricted",
    projects: [{ environmentIds: ["env_production"], projectId: "prj_agents" }],
  },
  tenantId: "ten_acme",
};

function poolWithRows(rows: readonly Record<string, unknown>[] = []) {
  const query = vi.fn(async (_sql: unknown, _values?: readonly unknown[]) => ({ rows }));
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  return {
    client,
    connect: vi.fn(async () => client),
    pool: { connect: vi.fn(async () => client), query } as unknown as Pool,
    query,
    release,
  };
}

describe("bootstrapApiKey", () => {
  it("uses a bounded administrative principal and returns the one-time credential", async () => {
    const database = poolWithRows();
    const assertCurrent = vi.fn(async () => undefined);
    const issue = vi.fn(async (_input: IssueApiKeyOptions) => ({
      credential: {
        capabilities: options.capabilities,
        createdAt: "2026-08-28T04:00:00.000Z",
        credentialId: "key_bootstrap_result",
        expiresAt: options.expiresAt ?? "",
        name: options.name,
        prefix: "abcdefghijkl",
        principalId: "wrk_bootstrap_result",
        resourceScope: options.resourceScope,
        revokedAt: null,
        rotatedFromCredentialId: null,
        tenantId: options.tenantId,
      },
      value: ["psk", "v1", "abcdefghijkl", "credential-value-shown-once"].join("_"),
    }));
    const repository = {};
    const result = await bootstrapApiKey(database.pool, options, {
      assertCurrent,
      createLifecycle: () => ({ issue }),
      createRepository: () => repository as never,
      now: () => new Date("2026-08-28T04:00:00.000Z"),
    });

    expect(assertCurrent).toHaveBeenCalledWith(database.pool);
    expect(issue).toHaveBeenCalledWith({
      capabilities: options.capabilities,
      expiresAt: options.expiresAt,
      issuer: expect.objectContaining({
        authentication: expect.objectContaining({ method: "service_token" }),
        capabilities: ["identity:manage", ...options.capabilities],
        principalId: options.actorPrincipalId,
        principalType: "user",
        resourceScope: { mode: "tenant" },
        tenantId: options.tenantId,
      }),
      name: options.name,
      resourceScope: options.resourceScope,
    });
    expect(result.value).toContain("credential-value-shown-once");
  });

  it("validates identifiers before accessing the database", async () => {
    const database = poolWithRows();
    const assertCurrent = vi.fn(async () => undefined);

    await expect(
      bootstrapApiKey(
        database.pool,
        { ...options, tenantId: "invalid tenant" },
        {
          assertCurrent,
          createLifecycle: () => ({ issue: vi.fn() }),
          createRepository: () => ({}) as never,
          now: () => new Date("2026-08-28T04:00:00.000Z"),
        },
      ),
    ).rejects.toThrow("tenant identifier is invalid");
    expect(assertCurrent).not.toHaveBeenCalled();
  });
});

describe("inspectIdentityCredentials", () => {
  it("returns only bounded aggregate lifecycle state within the requested tenant", async () => {
    const database = poolWithRows([{ active: 2, expired: 1, revoked: 3, total: 6 }]);
    const assertCurrent = vi.fn(async () => undefined);

    await expect(
      inspectIdentityCredentials(database.pool, "ten_acme", { assertCurrent }),
    ).resolves.toEqual({ active: 2, expired: 1, revoked: 3, tenantId: "ten_acme", total: 6 });
    expect(assertCurrent).toHaveBeenCalledWith(database.pool);
    expect(database.query).toHaveBeenCalledWith("BEGIN");
    expect(database.query).toHaveBeenCalledWith(
      "SELECT set_config('proofstack.tenant_id', $1, true)",
      ["ten_acme"],
    );
    expect(database.query.mock.calls.some(([sql]) => String(sql).includes("hash_"))).toBe(false);
    expect(database.query).toHaveBeenCalledWith("COMMIT");
    expect(database.release).toHaveBeenCalledOnce();
  });

  it("rejects malformed aggregate rows and rolls back", async () => {
    const database = poolWithRows([{ active: -1, expired: 0, revoked: 0, total: 0 }]);

    await expect(
      inspectIdentityCredentials(database.pool, "ten_acme", {
        assertCurrent: async () => undefined,
      }),
    ).rejects.toThrow("invalid active count");
    expect(database.query).toHaveBeenCalledWith("ROLLBACK");
    expect(database.release).toHaveBeenCalledOnce();
  });
});
