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
    createPool,
    end,
    inspect:
      options.inspect ?? (async () => ({ appliedIds: [], ledgerExists: true, pendingIds: [] })),
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
        createdRoles: ["proofstack_api", "proofstack_publisher", "proofstack_consumer"],
        updatedRoles: [],
      }),
    });

    const exitCode = await runDatabaseCli(
      ["provision"],
      {
        PROOFSTACK_API_DATABASE_PASSWORD: "local-api-password",
        PROOFSTACK_CONSUMER_DATABASE_PASSWORD: "local-consumer-password",
        PROOFSTACK_DATABASE_URL: "postgresql://local@localhost/proofstack",
        PROOFSTACK_PUBLISHER_DATABASE_PASSWORD: "local-publisher-password",
      },
      streams.value,
      adapters,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(streams.outputs[0] ?? "{}")).toEqual({
      createdRoles: ["proofstack_api", "proofstack_publisher", "proofstack_consumer"],
      status: "provisioned",
      updatedRoles: [],
    });
    expect(streams.outputs.join(" ")).not.toContain("password");
    expect(adapters.provision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        api: { name: "proofstack_api", password: "local-api-password" },
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
        },
        io().value,
        adapters,
      ),
    ).rejects.toThrow("PROOFSTACK_CONSUMER_DATABASE_PASSWORD");
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
        PROOFSTACK_PUBLISHER_DATABASE_PASSWORD: "local-publisher-password",
        PROOFSTACK_PUBLISHER_DATABASE_ROLE: "custom_publisher",
      },
      io().value,
      adapters,
    );

    expect(adapters.provision).toHaveBeenCalledWith(expect.anything(), {
      api: { name: "custom_api", password: "local-api-password" },
      consumer: { name: "custom_consumer", password: "local-consumer-password" },
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
