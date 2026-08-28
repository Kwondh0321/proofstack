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
  readonly oidcCreate?: () => Promise<{
    readonly bindingId: string;
    readonly createdAt: string;
    readonly identityDigest: string;
    readonly issuer: string;
    readonly principalId: string;
    readonly subject: string;
    readonly tenantId: string;
  }>;
  readonly oidcDisable?: () => Promise<boolean>;
  readonly oidcUpdate?: () => Promise<{
    readonly bindingId: string;
    readonly tenantId: string;
    readonly updatedAt: string;
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
    oidcCreate: vi.fn(
      options.oidcCreate ??
        (async () => ({
          bindingId: "oidc_operator",
          createdAt: "2026-08-28T05:00:00.000Z",
          identityDigest: "a".repeat(64),
          issuer: "https://identity.example.test/tenant",
          principalId: "usr_oidc_operator",
          subject: "provider-subject-001",
          tenantId: "ten_acme",
        })),
    ),
    oidcDisable: vi.fn(options.oidcDisable ?? (async () => true)),
    oidcUpdate: vi.fn(
      options.oidcUpdate ??
        (async () => ({
          bindingId: "oidc_operator",
          tenantId: "ten_acme",
          updatedAt: "2026-08-28T05:30:00.000Z",
        })),
    ),
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

  it("creates an explicitly authorized OIDC binding without emitting credentials", async () => {
    const streams = io();
    const adapters = dependencies({});
    const exitCode = await runDatabaseCli(
      ["oidc-binding-create"],
      {
        PROOFSTACK_BOOTSTRAP_ACTOR_PRINCIPAL_ID: "usr_platform_operator",
        PROOFSTACK_IDENTITY_TENANT_ID: "ten_acme",
        PROOFSTACK_MIGRATION_DATABASE_URL: "postgresql://migration@localhost/proofstack",
        PROOFSTACK_OIDC_BINDING_ID: "oidc_operator",
        PROOFSTACK_OIDC_CAPABILITIES: "project:read,evidence:read,identity:manage",
        PROOFSTACK_OIDC_ISSUER: "https://identity.example.test/tenant",
        PROOFSTACK_OIDC_PRINCIPAL_ID: "usr_oidc_operator",
        PROOFSTACK_OIDC_RESOURCE_SCOPE: '{"mode":"tenant"}',
        PROOFSTACK_OIDC_ROLES: "admin",
        PROOFSTACK_OIDC_SUBJECT: "provider-subject-001",
      },
      streams.value,
      adapters,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(streams.outputs[0] ?? "{}")).toMatchObject({
      bindingId: "oidc_operator",
      status: "created",
      tenantId: "ten_acme",
    });
    expect(streams.outputs.join(" ")).not.toMatch(/token|password|session/i);
    expect(adapters.oidcCreate).toHaveBeenCalledWith(expect.anything(), {
      actorPrincipalId: "usr_platform_operator",
      bindingId: "oidc_operator",
      capabilities: ["project:read", "evidence:read", "identity:manage"],
      issuer: "https://identity.example.test/tenant",
      principalId: "usr_oidc_operator",
      resourceScope: { mode: "tenant" },
      roles: ["admin"],
      subject: "provider-subject-001",
      tenantId: "ten_acme",
    });
  });

  it("updates OIDC authorization without accepting identity replacement fields", async () => {
    const streams = io();
    const adapters = dependencies({});
    await runDatabaseCli(
      ["oidc-binding-update"],
      {
        PROOFSTACK_BOOTSTRAP_ACTOR_PRINCIPAL_ID: "usr_platform_operator",
        PROOFSTACK_IDENTITY_TENANT_ID: "ten_acme",
        PROOFSTACK_MIGRATION_DATABASE_URL: "postgresql://migration@localhost/proofstack",
        PROOFSTACK_OIDC_BINDING_ID: "oidc_operator",
        PROOFSTACK_OIDC_CAPABILITIES: "project:read",
        PROOFSTACK_OIDC_RESOURCE_SCOPE:
          '{"mode":"restricted","projects":[{"projectId":"prj_agents"}]}',
        PROOFSTACK_OIDC_ROLES: "viewer",
      },
      streams.value,
      adapters,
    );

    expect(JSON.parse(streams.outputs[0] ?? "{}")).toEqual({
      bindingId: "oidc_operator",
      status: "updated",
      tenantId: "ten_acme",
      updatedAt: "2026-08-28T05:30:00.000Z",
    });
    expect(adapters.oidcUpdate).toHaveBeenCalledWith(expect.anything(), {
      actorPrincipalId: "usr_platform_operator",
      bindingId: "oidc_operator",
      capabilities: ["project:read"],
      resourceScope: { mode: "restricted", projects: [{ projectId: "prj_agents" }] },
      roles: ["viewer"],
      tenantId: "ten_acme",
    });
  });

  it("supports an explicitly empty OIDC capability set", async () => {
    const adapters = dependencies({});
    await runDatabaseCli(
      ["oidc-binding-update"],
      {
        PROOFSTACK_BOOTSTRAP_ACTOR_PRINCIPAL_ID: "usr_platform_operator",
        PROOFSTACK_IDENTITY_TENANT_ID: "ten_acme",
        PROOFSTACK_MIGRATION_DATABASE_URL: "postgresql://migration@localhost/proofstack",
        PROOFSTACK_OIDC_BINDING_ID: "oidc_operator",
        PROOFSTACK_OIDC_CAPABILITIES: "",
        PROOFSTACK_OIDC_RESOURCE_SCOPE: '{"mode":"tenant"}',
        PROOFSTACK_OIDC_ROLES: "viewer",
      },
      io().value,
      adapters,
    );

    expect(adapters.oidcUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ capabilities: [] }),
    );
  });

  it("disables an OIDC binding idempotently", async () => {
    const streams = io();
    const adapters = dependencies({ oidcDisable: async () => false });
    await runDatabaseCli(
      ["oidc-binding-disable"],
      {
        PROOFSTACK_BOOTSTRAP_ACTOR_PRINCIPAL_ID: "usr_platform_operator",
        PROOFSTACK_IDENTITY_TENANT_ID: "ten_acme",
        PROOFSTACK_MIGRATION_DATABASE_URL: "postgresql://migration@localhost/proofstack",
        PROOFSTACK_OIDC_BINDING_ID: "oidc_operator",
        PROOFSTACK_OIDC_DISABLE_REASON: "access removed",
      },
      streams.value,
      adapters,
    );

    expect(JSON.parse(streams.outputs[0] ?? "{}")).toEqual({
      bindingId: "oidc_operator",
      status: "unchanged",
      tenantId: "ten_acme",
    });
    expect(adapters.oidcDisable).toHaveBeenCalledWith(expect.anything(), {
      actorPrincipalId: "usr_platform_operator",
      bindingId: "oidc_operator",
      reason: "access removed",
      tenantId: "ten_acme",
    });
  });

  it.each([
    [{ PROOFSTACK_OIDC_CAPABILITIES: "project:read,project:read" }, "unique"],
    [{ PROOFSTACK_OIDC_CAPABILITIES: "unknown" }, "unique"],
    [{ PROOFSTACK_OIDC_ROLES: "admin,admin" }, "unique"],
    [{ PROOFSTACK_OIDC_RESOURCE_SCOPE: "not-json" }, "valid JSON"],
    [{ PROOFSTACK_OIDC_RESOURCE_SCOPE: "{}" }, "valid resource scope"],
  ])("rejects malformed OIDC CLI input before opening a pool", async (override, message) => {
    const adapters = dependencies({});
    await expect(
      runDatabaseCli(
        ["oidc-binding-create"],
        {
          PROOFSTACK_BOOTSTRAP_ACTOR_PRINCIPAL_ID: "usr_platform_operator",
          PROOFSTACK_IDENTITY_TENANT_ID: "ten_acme",
          PROOFSTACK_MIGRATION_DATABASE_URL: "postgresql://migration@localhost/proofstack",
          PROOFSTACK_OIDC_BINDING_ID: "oidc_operator",
          PROOFSTACK_OIDC_CAPABILITIES: "project:read",
          PROOFSTACK_OIDC_ISSUER: "https://identity.example.test/tenant",
          PROOFSTACK_OIDC_PRINCIPAL_ID: "usr_oidc_operator",
          PROOFSTACK_OIDC_RESOURCE_SCOPE: '{"mode":"tenant"}',
          PROOFSTACK_OIDC_ROLES: "admin",
          PROOFSTACK_OIDC_SUBJECT: "provider-subject-001",
          ...override,
        },
        io().value,
        adapters,
      ),
    ).rejects.toThrow(message);
    expect(adapters.createPool).not.toHaveBeenCalled();
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
