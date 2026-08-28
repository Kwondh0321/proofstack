import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { type DatabaseCliIo, DatabaseCliUsageError, runDatabaseCli } from "./cli.js";

function io() {
  const errors: string[] = [];
  const outputs: string[] = [];
  const value: DatabaseCliIo = {
    error: (message) => errors.push(message),
    output: (message) => outputs.push(message),
  };
  return { errors, outputs, value };
}

function dependencies(options: {
  readonly bootstrap?: () => Promise<{
    readonly credential: {
      readonly capabilities: readonly ["evidence:ingest"];
      readonly createdAt: string;
      readonly credentialId: string;
      readonly expiresAt: string;
      readonly name: string;
      readonly prefix: string;
      readonly principalId: string;
      readonly resourceScope: { readonly mode: "tenant" };
      readonly revokedAt: null;
      readonly rotatedFromCredentialId: null;
      readonly tenantId: string;
    };
    readonly value: string;
  }>;
  readonly inspect?: () => Promise<{
    readonly appliedIds: readonly string[];
    readonly ledgerExists: boolean;
    readonly pendingIds: readonly string[];
  }>;
  readonly migrate?: () => Promise<{
    readonly appliedIds: readonly string[];
    readonly ledgerExists: boolean;
    readonly newlyAppliedIds: readonly string[];
    readonly pendingIds: readonly string[];
  }>;
  readonly inspectIdentity?: () => Promise<{
    readonly active: number;
    readonly expired: number;
    readonly revoked: number;
    readonly tenantId: string;
    readonly total: number;
  }>;
  readonly provision?: () => Promise<{
    readonly createdRoles: readonly string[];
    readonly updatedRoles: readonly string[];
  }>;
}) {
  const end = vi.fn(async () => undefined);
  const createPool = vi.fn(
    (_connectionString: string, _onIdleError: (error: Error) => void) =>
      ({ end }) as unknown as Pool,
  );
  return {
    bootstrap: vi.fn(
      options.bootstrap ??
        (async () => ({
          credential: {
            capabilities: ["evidence:ingest"] as const,
            createdAt: "2026-08-28T04:00:00.000Z",
            credentialId: "key_bootstrap_cli",
            expiresAt: "2026-11-26T04:00:00.000Z",
            name: "agent-ingestion",
            prefix: "abcdefghijkl",
            principalId: "wrk_bootstrap_cli",
            resourceScope: { mode: "tenant" as const },
            revokedAt: null,
            rotatedFromCredentialId: null,
            tenantId: "ten_acme",
          },
          value: ["psk", "v1", "abcdefghijkl", "one-time-credential-value"].join("_"),
        })),
    ),
    createPool,
    end,
    inspect:
      options.inspect ?? (async () => ({ appliedIds: [], ledgerExists: true, pendingIds: [] })),
    inspectIdentity: vi.fn(
      options.inspectIdentity ??
        (async () => ({ active: 1, expired: 0, revoked: 0, tenantId: "ten_acme", total: 1 })),
    ),
    migrate:
      options.migrate ??
      (async () => ({
        appliedIds: [],
        ledgerExists: true,
        newlyAppliedIds: [],
        pendingIds: [],
      })),
    provision: vi.fn(
      options.provision ??
        (async () => ({
          createdRoles: [],
          updatedRoles: [],
        })),
    ),
  };
}

describe("runDatabaseCli", () => {
  it("rejects unknown commands before opening a pool", async () => {
    const streams = io();
    const adapters = dependencies({});

    await expect(
      runDatabaseCli(
        ["drop-everything"],
        { PROOFSTACK_MIGRATION_DATABASE_URL: "postgresql://migration@localhost/proofstack" },
        streams.value,
        adapters,
      ),
    ).rejects.toBeInstanceOf(DatabaseCliUsageError);
    expect(adapters.createPool).not.toHaveBeenCalled();
  });

  it("requires dedicated migration credentials in production", async () => {
    const streams = io();
    const adapters = dependencies({});

    await expect(
      runDatabaseCli(
        ["status"],
        {
          PROOFSTACK_DATABASE_URL: "postgresql://runtime@localhost/proofstack",
          PROOFSTACK_ENV: "production",
        },
        streams.value,
        adapters,
      ),
    ).rejects.toThrow("PROOFSTACK_MIGRATION_DATABASE_URL is required");
  });

  it("requires a database URL in non-production environments", async () => {
    await expect(runDatabaseCli(["status"], {}, io().value, dependencies({}))).rejects.toThrow(
      "Set PROOFSTACK_MIGRATION_DATABASE_URL",
    );
  });

  it("applies migrations and closes the single-purpose pool", async () => {
    const streams = io();
    const adapters = dependencies({
      migrate: async () => ({
        appliedIds: ["0001_evidence_store"],
        ledgerExists: true,
        newlyAppliedIds: ["0001_evidence_store"],
        pendingIds: [],
      }),
    });

    const exitCode = await runDatabaseCli(
      ["migrate"],
      { PROOFSTACK_DATABASE_URL: "postgresql://local@localhost/proofstack" },
      streams.value,
      adapters,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(streams.outputs[0] ?? "{}")).toEqual({
      appliedIds: ["0001_evidence_store"],
      newlyAppliedIds: ["0001_evidence_store"],
      status: "current",
    });
    expect(adapters.end).toHaveBeenCalledOnce();
  });

  it("returns failure status while migrations are pending", async () => {
    const streams = io();
    const adapters = dependencies({
      inspect: async () => ({
        appliedIds: [],
        ledgerExists: false,
        pendingIds: ["0001_evidence_store"],
      }),
    });

    const exitCode = await runDatabaseCli(
      ["status"],
      { PROOFSTACK_MIGRATION_DATABASE_URL: "postgresql://migration@localhost/proofstack" },
      streams.value,
      adapters,
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(streams.outputs[0] ?? "{}")).toMatchObject({ status: "pending" });
    expect(adapters.end).toHaveBeenCalledOnce();
  });

  it("provisions runtime roles without printing credentials", async () => {
    const streams = io();
    const adapters = dependencies({
      provision: async () => ({
        createdRoles: [
          "proofstack_api",
          "proofstack_identity",
          "proofstack_publisher",
          "proofstack_consumer",
        ],
        updatedRoles: [],
      }),
    });

    const exitCode = await runDatabaseCli(
      ["provision"],
      {
        PROOFSTACK_API_DATABASE_PASSWORD: "local-api-password",
        PROOFSTACK_CONSUMER_DATABASE_PASSWORD: "local-consumer-password",
        PROOFSTACK_DATABASE_URL: "postgresql://local@localhost/proofstack",
        PROOFSTACK_IDENTITY_DATABASE_PASSWORD: "local-identity-password",
        PROOFSTACK_PUBLISHER_DATABASE_PASSWORD: "local-publisher-password",
      },
      streams.value,
      adapters,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(streams.outputs[0] ?? "{}")).toEqual({
      createdRoles: [
        "proofstack_api",
        "proofstack_identity",
        "proofstack_publisher",
        "proofstack_consumer",
      ],
      status: "provisioned",
      updatedRoles: [],
    });
    expect(streams.outputs.join(" ")).not.toContain("password");
    expect(adapters.provision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        api: { name: "proofstack_api", password: "local-api-password" },
        identity: { name: "proofstack_identity", password: "local-identity-password" },
      }),
    );
    expect(adapters.end).toHaveBeenCalledOnce();
  });

  it("requires all runtime passwords before opening a provisioning connection", async () => {
    const adapters = dependencies({});

    await expect(
      runDatabaseCli(
        ["provision"],
        {
          PROOFSTACK_API_DATABASE_PASSWORD: "local-api-password",
          PROOFSTACK_DATABASE_URL: "postgresql://local@localhost/proofstack",
          PROOFSTACK_IDENTITY_DATABASE_PASSWORD: "local-identity-password",
        },
        io().value,
        adapters,
      ),
    ).rejects.toThrow("PROOFSTACK_CONSUMER_DATABASE_PASSWORD");
    expect(adapters.createPool).not.toHaveBeenCalled();
  });

  it("creates one explicitly scoped bootstrap key and prints its value once", async () => {
    const streams = io();
    const adapters = dependencies({});
    const exitCode = await runDatabaseCli(
      ["identity-bootstrap"],
      {
        PROOFSTACK_BOOTSTRAP_ACTOR_PRINCIPAL_ID: "usr_platform_operator",
        PROOFSTACK_BOOTSTRAP_KEY_CAPABILITIES: "evidence:ingest",
        PROOFSTACK_BOOTSTRAP_KEY_EXPIRES_AT: "2026-11-26T04:00:00.000Z",
        PROOFSTACK_BOOTSTRAP_KEY_NAME: "agent-ingestion",
        PROOFSTACK_BOOTSTRAP_KEY_RESOURCE_SCOPE: '{"mode":"tenant"}',
        PROOFSTACK_IDENTITY_TENANT_ID: "ten_acme",
        PROOFSTACK_MIGRATION_DATABASE_URL: "postgresql://migration@localhost/proofstack",
      },
      streams.value,
      adapters,
    );

    const output = streams.outputs[0] ?? "";
    const result = JSON.parse(output);
    expect(exitCode).toBe(0);
    expect(result).toMatchObject({
      credential: { credentialId: "key_bootstrap_cli", tenantId: "ten_acme" },
      status: "created",
    });
    expect(output.split("one-time-credential-value")).toHaveLength(2);
    expect(output).not.toContain("hash");
    expect(output).not.toContain("salt");
    expect(adapters.bootstrap).toHaveBeenCalledWith(expect.anything(), {
      actorPrincipalId: "usr_platform_operator",
      capabilities: ["evidence:ingest"],
      expiresAt: "2026-11-26T04:00:00.000Z",
      name: "agent-ingestion",
      resourceScope: { mode: "tenant" },
      tenantId: "ten_acme",
    });
    expect(adapters.end).toHaveBeenCalledOnce();
  });

  it("reports aggregate identity status without credential material", async () => {
    const streams = io();
    const adapters = dependencies({});
    const exitCode = await runDatabaseCli(
      ["identity-status"],
      {
        PROOFSTACK_IDENTITY_TENANT_ID: "ten_acme",
        PROOFSTACK_MIGRATION_DATABASE_URL: "postgresql://migration@localhost/proofstack",
      },
      streams.value,
      adapters,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(streams.outputs[0] ?? "{}")).toEqual({
      active: 1,
      expired: 0,
      revoked: 0,
      status: "current",
      tenantId: "ten_acme",
      total: 1,
    });
    expect(adapters.inspectIdentity).toHaveBeenCalledWith(expect.anything(), "ten_acme");
    expect(streams.outputs.join(" ")).not.toMatch(/hash|salt|prefix/i);
  });

  it("rejects malformed bootstrap scope before opening a connection", async () => {
    const adapters = dependencies({});

    await expect(
      runDatabaseCli(
        ["identity-bootstrap"],
        {
          PROOFSTACK_BOOTSTRAP_ACTOR_PRINCIPAL_ID: "usr_platform_operator",
          PROOFSTACK_BOOTSTRAP_KEY_CAPABILITIES: "evidence:ingest",
          PROOFSTACK_BOOTSTRAP_KEY_NAME: "agent-ingestion",
          PROOFSTACK_BOOTSTRAP_KEY_RESOURCE_SCOPE: "not-json",
          PROOFSTACK_IDENTITY_TENANT_ID: "ten_acme",
          PROOFSTACK_MIGRATION_DATABASE_URL: "postgresql://migration@localhost/proofstack",
        },
        io().value,
        adapters,
      ),
    ).rejects.toThrow("must be valid JSON");
    expect(adapters.createPool).not.toHaveBeenCalled();
  });

  it("passes explicit runtime role names to provisioning", async () => {
    const adapters = dependencies({});

    await runDatabaseCli(
      ["provision"],
      {
        PROOFSTACK_API_DATABASE_PASSWORD: "local-api-password",
        PROOFSTACK_API_DATABASE_ROLE: "custom_api",
        PROOFSTACK_CONSUMER_DATABASE_PASSWORD: "local-consumer-password",
        PROOFSTACK_CONSUMER_DATABASE_ROLE: "custom_consumer",
        PROOFSTACK_DATABASE_URL: "postgresql://local@localhost/proofstack",
        PROOFSTACK_IDENTITY_DATABASE_PASSWORD: "local-identity-password",
        PROOFSTACK_IDENTITY_DATABASE_ROLE: "custom_identity",
        PROOFSTACK_PUBLISHER_DATABASE_PASSWORD: "local-publisher-password",
        PROOFSTACK_PUBLISHER_DATABASE_ROLE: "custom_publisher",
      },
      io().value,
      adapters,
    );

    expect(adapters.provision).toHaveBeenCalledWith(expect.anything(), {
      api: { name: "custom_api", password: "local-api-password" },
      consumer: { name: "custom_consumer", password: "local-consumer-password" },
      identity: { name: "custom_identity", password: "local-identity-password" },
      publisher: { name: "custom_publisher", password: "local-publisher-password" },
    });
  });

  it("reports current status and surfaces idle connection failures", async () => {
    const streams = io();
    const adapters = dependencies({});
    adapters.createPool.mockImplementation((_url, onIdleError) => {
      onIdleError(new Error("socket closed"));
      return { end: adapters.end } as unknown as Pool;
    });

    const exitCode = await runDatabaseCli(
      ["status"],
      { PROOFSTACK_MIGRATION_DATABASE_URL: "postgresql://migration@localhost/proofstack" },
      streams.value,
      adapters,
    );

    expect(exitCode).toBe(1);
    expect(streams.errors).toEqual(["Idle PostgreSQL connection failed: socket closed"]);
    expect(JSON.parse(streams.outputs[0] ?? "{}")).toMatchObject({ status: "current" });
  });
});
