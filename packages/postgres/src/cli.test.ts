import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { DatabaseCliUsageError, runDatabaseCli, type DatabaseCliIo } from "./cli.js";

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
