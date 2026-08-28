import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  type RecoveryCliDependencies,
  type RecoveryCliIo,
  RecoveryCliUsageError,
  runRecoveryCli,
} from "./cli.js";

const receipt = {
  engineVersion: "16.15",
  sha256: "a".repeat(64),
  sizeBytes: 4_096,
};
const migrationLedger = [
  {
    checksum: "b".repeat(64),
    id: "0010_force_identity_tenant_rls",
  },
] as const;

function io(): {
  readonly errors: string[];
  readonly outputs: string[];
  readonly value: RecoveryCliIo;
} {
  const errors: string[] = [];
  const outputs: string[] = [];
  return {
    errors,
    outputs,
    value: {
      error: (message) => errors.push(message),
      output: (message) => outputs.push(message),
    },
  };
}

function dependencies(): RecoveryCliDependencies & {
  readonly backup: ReturnType<typeof vi.fn>;
  readonly createPool: ReturnType<typeof vi.fn>;
  readonly end: ReturnType<typeof vi.fn>;
  readonly inspectLedger: ReturnType<typeof vi.fn>;
  readonly restore: ReturnType<typeof vi.fn>;
} {
  const end = vi.fn(async () => undefined);
  return {
    backup: vi.fn(async () => receipt),
    createPool: vi.fn(
      () =>
        ({
          end,
        }) as unknown as Pool,
    ),
    end,
    inspectLedger: vi.fn(async () => migrationLedger),
    restore: vi.fn(async () => receipt),
  };
}

describe("runRecoveryCli", () => {
  it("rejects malformed commands before opening a database pool", async () => {
    const adapters = dependencies();

    await expect(
      runRecoveryCli(
        ["database-backup"],
        { PROOFSTACK_RECOVERY_DATABASE_URL: "postgresql://recovery@localhost/proofstack" },
        io().value,
        adapters,
      ),
    ).rejects.toBeInstanceOf(RecoveryCliUsageError);
    expect(adapters.createPool).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown", "/backup/proofstack.dump"],
    ["database-backup", ""],
    ["database-backup", "/backup/proofstack.dump", "extra"],
  ])("rejects invalid command arguments %#", async (...arguments_) => {
    const adapters = dependencies();

    await expect(
      runRecoveryCli(
        arguments_,
        { PROOFSTACK_RECOVERY_DATABASE_URL: "postgresql://recovery@localhost/proofstack" },
        io().value,
        adapters,
      ),
    ).rejects.toBeInstanceOf(RecoveryCliUsageError);
    expect(adapters.createPool).not.toHaveBeenCalled();
  });

  it("requires dedicated recovery credentials", async () => {
    const adapters = dependencies();

    await expect(
      runRecoveryCli(["database-backup", "/backup/proofstack.dump"], {}, io().value, adapters),
    ).rejects.toThrow("PROOFSTACK_RECOVERY_DATABASE_URL");
    expect(adapters.createPool).not.toHaveBeenCalled();
  });

  it("creates a verified database component without printing credentials", async () => {
    const adapters = dependencies();
    const streams = io();
    const connectionString = "postgresql://recovery:private@localhost/proofstack";

    await expect(
      runRecoveryCli(
        ["database-backup", "/backup/proofstack.dump"],
        { PROOFSTACK_RECOVERY_DATABASE_URL: connectionString },
        streams.value,
        adapters,
      ),
    ).resolves.toBe(0);

    expect(adapters.backup).toHaveBeenCalledWith({
      allowPlaintextLoopback: true,
      connectionString,
      database: expect.anything(),
      outputPath: "/backup/proofstack.dump",
    });
    expect(JSON.parse(streams.outputs[0] ?? "{}")).toEqual({
      component: "postgresql-logical-dump",
      engineVersion: "16.15",
      operation: "database-backup",
      path: "/backup/proofstack.dump",
      migrationLedger,
      sha256: "a".repeat(64),
      sizeBytes: 4_096,
      status: "verified",
    });
    expect(streams.outputs.join(" ")).not.toContain("private");
    expect(adapters.end).toHaveBeenCalledOnce();
  });

  it("restores only through the fail-closed restore operation", async () => {
    const adapters = dependencies();
    const streams = io();
    const connectionString =
      "postgresql://recovery@database.example/proofstack_restore?sslmode=require";

    await expect(
      runRecoveryCli(
        ["database-restore", "/backup/proofstack.dump"],
        {
          PROOFSTACK_ENV: "production",
          PROOFSTACK_RECOVERY_DATABASE_URL: connectionString,
        },
        streams.value,
        adapters,
      ),
    ).resolves.toBe(0);

    expect(adapters.restore).toHaveBeenCalledWith({
      allowPlaintextLoopback: false,
      connectionString,
      database: expect.anything(),
      dumpPath: "/backup/proofstack.dump",
    });
    expect(JSON.parse(streams.outputs[0] ?? "{}")).toMatchObject({
      component: "postgresql-logical-dump",
      migrationLedger,
      operation: "database-restore",
      status: "verified",
    });
    expect(adapters.inspectLedger).toHaveBeenCalledAfter(adapters.restore);
    expect(adapters.end).toHaveBeenCalledOnce();
  });

  it("closes the database pool after an operation failure", async () => {
    const adapters = dependencies();
    adapters.backup.mockRejectedValueOnce(new Error("backup failed"));

    await expect(
      runRecoveryCli(
        ["database-backup", "/backup/proofstack.dump"],
        { PROOFSTACK_RECOVERY_DATABASE_URL: "postgresql://recovery@localhost/proofstack" },
        io().value,
        adapters,
      ),
    ).rejects.toThrow("backup failed");
    expect(adapters.end).toHaveBeenCalledOnce();
  });

  it("refuses a backup before dumping when the migration ledger is not current", async () => {
    const adapters = dependencies();
    adapters.inspectLedger.mockRejectedValueOnce(new Error("migration ledger is not current"));

    await expect(
      runRecoveryCli(
        ["database-backup", "/backup/proofstack.dump"],
        { PROOFSTACK_RECOVERY_DATABASE_URL: "postgresql://recovery@localhost/proofstack" },
        io().value,
        adapters,
      ),
    ).rejects.toThrow("migration ledger is not current");
    expect(adapters.backup).not.toHaveBeenCalled();
    expect(adapters.end).toHaveBeenCalledOnce();
  });

  it("fails after reporting an idle database connection error", async () => {
    const adapters = dependencies();
    const streams = io();
    adapters.createPool.mockImplementationOnce(
      (_connectionString: string, onIdleError: (error: Error) => void) => {
        onIdleError(new Error("private idle failure"));
        return { end: adapters.end } as unknown as Pool;
      },
    );

    await expect(
      runRecoveryCli(
        ["database-backup", "/backup/proofstack.dump"],
        { PROOFSTACK_RECOVERY_DATABASE_URL: "postgresql://recovery@localhost/proofstack" },
        streams.value,
        adapters,
      ),
    ).resolves.toBe(1);
    expect(streams.errors).toEqual(["Idle PostgreSQL recovery connection failed"]);
    expect(streams.errors.join(" ")).not.toContain("private");
    expect(adapters.end).toHaveBeenCalledOnce();
  });
});
