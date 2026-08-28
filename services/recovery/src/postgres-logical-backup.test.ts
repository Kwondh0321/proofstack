import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool, QueryResultRow } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecoveryOperationError } from "./errors.js";
import type {
  PostgresCommand,
  PostgresCommandResult,
  PostgresCommandRunner,
} from "./postgres-command.js";
import {
  createPostgresLogicalBackup,
  restorePostgresLogicalBackup,
} from "./postgres-logical-backup.js";

const CONNECTION_STRING = "postgresql://recovery:private-password@127.0.0.1/proofstack_test";
const TLS_CONNECTION_STRING =
  "postgresql://recovery:private-password@db.example.test:5433/proofstack_tls?sslmode=verify-full&sslrootcert=%2Fetc%2Fssl%2Froot.pem";
const DUMP_BYTES = Buffer.from("test PostgreSQL custom dump", "utf8");

class FakeRunner implements PostgresCommandRunner {
  readonly calls: PostgresCommand[] = [];
  dumpBytes = DUMP_BYTES;
  failOperation?: unknown;
  onDump?: (path: string) => Promise<void>;
  onRestore?: () => Promise<void>;
  toolVersion = "pg_dump (PostgreSQL) 16.15";

  async run(command: PostgresCommand): Promise<PostgresCommandResult> {
    this.calls.push(command);
    if (command.arguments[0] === "--version") {
      return { stderr: "", stdout: this.toolVersion };
    }
    if (this.failOperation !== undefined) throw this.failOperation;
    const fileArgument = command.arguments.find((argument) => argument.startsWith("--file="));
    if (fileArgument !== undefined) {
      const path = fileArgument.slice("--file=".length);
      await writeFile(path, this.dumpBytes);
      await this.onDump?.(path);
    } else {
      await this.onRestore?.();
    }
    return { stderr: "", stdout: "" };
  }
}

interface FakeDatabaseOptions {
  readonly hasUserObjects?: boolean;
  readonly omitEmptyTargetRow?: boolean;
  readonly omitServerVersion?: boolean;
  readonly serverVersion?: string;
}

function fakeDatabase(options: FakeDatabaseOptions = {}): {
  readonly database: Pick<Pool, "query">;
  readonly queries: string[];
} {
  const queries: string[] = [];
  const database = {
    query: async <_Row extends QueryResultRow>(text: string) => {
      queries.push(text);
      if (text === "SHOW server_version") {
        return {
          rows: options.omitServerVersion
            ? []
            : [{ server_version: options.serverVersion ?? "16.15" }],
        };
      }
      return {
        rows: options.omitEmptyTargetRow
          ? []
          : [{ has_user_objects: options.hasUserObjects ?? false }],
      };
    },
  } as unknown as Pick<Pool, "query">;
  return { database, queries };
}

let temporaryDirectories: string[] = [];
const secretEnvironmentName: string = "PROOFSTACK_RECOVERY_TEST_SECRET";

beforeEach(() => {
  temporaryDirectories = [];
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
  );
  delete process.env[secretEnvironmentName];
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "proofstack-recovery-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("PostgreSQL logical backup", () => {
  it("publishes a private immutable custom dump and keeps credentials out of arguments", async () => {
    const directory = await temporaryDirectory();
    const outputPath = join(directory, "database.dump");
    const runner = new FakeRunner();
    const { database } = fakeDatabase();
    process.env[secretEnvironmentName] = "must-not-be-inherited";

    await expect(
      createPostgresLogicalBackup({
        allowPlaintextLoopback: true,
        connectionString: CONNECTION_STRING,
        database,
        dumpExecutable: "test-pg-dump",
        outputPath,
        runner,
      }),
    ).resolves.toEqual({
      engineVersion: "16.15",
      sha256: createHash("sha256").update(DUMP_BYTES).digest("hex"),
      sizeBytes: DUMP_BYTES.byteLength,
    });

    expect(await readFile(outputPath)).toEqual(DUMP_BYTES);
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).filter((name) => name.includes(".partial"))).toEqual([]);
    const dumpCall = runner.calls.at(-1);
    expect(dumpCall).toBeDefined();
    if (dumpCall === undefined) throw new Error("Expected a pg_dump operation call");
    expect(dumpCall.arguments).toEqual([
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      expect.stringMatching(/^--file=.*\.partial$/u),
    ]);
    expect(dumpCall.arguments.join(" ")).not.toContain("private-password");
    expect(dumpCall.environment).toMatchObject({
      PGAPPNAME: "proofstack-recovery",
      PGDATABASE: "proofstack_test",
      PGHOST: "127.0.0.1",
      PGPASSWORD: "private-password",
      PGPORT: "5432",
      PGUSER: "recovery",
    });
    expect(dumpCall.environment).not.toHaveProperty("PROOFSTACK_RECOVERY_TEST_SECRET");
  });

  it("normalizes supported verified-TLS connection parameters for libpq", async () => {
    const directory = await temporaryDirectory();
    const runner = new FakeRunner();
    const { database } = fakeDatabase();
    await createPostgresLogicalBackup({
      allowPlaintextLoopback: false,
      connectionString: TLS_CONNECTION_STRING,
      database,
      outputPath: join(directory, "database.dump"),
      runner,
    });
    expect(runner.calls.at(-1)?.environment).toMatchObject({
      PGDATABASE: "proofstack_tls",
      PGHOST: "db.example.test",
      PGPORT: "5433",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "/etc/ssl/root.pem",
    });
  });

  it.each([
    ["unsupported", `${CONNECTION_STRING}?application_name=unsafe`],
    ["duplicate", `${CONNECTION_STRING}?sslrootcert=first&sslrootcert=second`],
    ["malformed", "postgresql://recovery:%@127.0.0.1:5432/proofstack_test"],
  ])("rejects a %s connection parameter before invoking a data command", async (_name, value) => {
    const directory = await temporaryDirectory();
    const runner = new FakeRunner();
    const { database } = fakeDatabase();
    await expect(
      createPostgresLogicalBackup({
        allowPlaintextLoopback: true,
        connectionString: value,
        database,
        outputPath: join(directory, "database.dump"),
        runner,
      }),
    ).rejects.toBeInstanceOf(RecoveryOperationError);
    expect(runner.calls).toEqual([]);
  });

  it.each([
    ["relative dump path", { outputPath: "database.dump" }, "dump path must be an absolute"],
    [
      "invalid connection",
      { connectionString: "not-a-url" },
      "connection configuration is invalid",
    ],
  ])("rejects %s before running pg_dump", async (_name, override, reason) => {
    const directory = await temporaryDirectory();
    const runner = new FakeRunner();
    const { database } = fakeDatabase();
    await expect(
      createPostgresLogicalBackup({
        allowPlaintextLoopback: true,
        connectionString: CONNECTION_STRING,
        database,
        outputPath: join(directory, "database.dump"),
        runner,
        ...override,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        operation: "database-backup",
        reason: expect.stringContaining(reason),
      }),
    );
    expect(runner.calls).toEqual([]);
  });

  it("refuses an unavailable or non-directory parent", async () => {
    const directory = await temporaryDirectory();
    const regularFile = join(directory, "regular-file");
    await writeFile(regularFile, "not a directory");
    const { database } = fakeDatabase();

    await expect(
      createPostgresLogicalBackup({
        allowPlaintextLoopback: true,
        connectionString: CONNECTION_STRING,
        database,
        outputPath: join(directory, "missing", "database.dump"),
      }),
    ).rejects.toEqual(expect.objectContaining({ reason: "output directory is unavailable" }));
    await expect(
      createPostgresLogicalBackup({
        allowPlaintextLoopback: true,
        connectionString: CONNECTION_STRING,
        database,
        outputPath: join(regularFile, "database.dump"),
      }),
    ).rejects.toEqual(expect.objectContaining({ reason: "output directory is not a directory" }));
  });

  it("never overwrites an existing output path", async () => {
    const directory = await temporaryDirectory();
    const outputPath = join(directory, "database.dump");
    await writeFile(outputPath, "existing backup");
    const runner = new FakeRunner();
    const { database } = fakeDatabase();

    await expect(
      createPostgresLogicalBackup({
        allowPlaintextLoopback: true,
        connectionString: CONNECTION_STRING,
        database,
        outputPath,
        runner,
      }),
    ).rejects.toEqual(expect.objectContaining({ reason: "output path already exists" }));
    expect(await readFile(outputPath, "utf8")).toBe("existing backup");
    expect(runner.calls).toEqual([]);
  });

  it.each([
    ["missing server version", { omitServerVersion: true }, "database returned no server version"],
    ["unsupported server version", { serverVersion: "15.9" }, "version is missing or unsupported"],
    [
      "different server major",
      { serverVersion: "17.1" },
      "client and server major versions differ",
    ],
  ])("refuses a %s", async (_name, databaseOptions, reason) => {
    const directory = await temporaryDirectory();
    const runner = new FakeRunner();
    const { database } = fakeDatabase(databaseOptions);
    await expect(
      createPostgresLogicalBackup({
        allowPlaintextLoopback: true,
        connectionString: CONNECTION_STRING,
        database,
        outputPath: join(directory, "database.dump"),
        runner,
      }),
    ).rejects.toEqual(expect.objectContaining({ reason: expect.stringContaining(reason) }));
  });

  it("rejects an unsupported pg_dump version", async () => {
    const directory = await temporaryDirectory();
    const runner = new FakeRunner();
    runner.toolVersion = "unexpected output";
    const { database } = fakeDatabase();
    await expect(
      createPostgresLogicalBackup({
        allowPlaintextLoopback: true,
        connectionString: CONNECTION_STRING,
        database,
        outputPath: join(directory, "database.dump"),
        runner,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ reason: "PostgreSQL version is missing or unsupported" }),
    );
  });

  it.each([
    [new Error("raw tool failure"), "logical dump did not complete"],
    [new RecoveryOperationError("postgres-tool", "safe tool failure"), "safe tool failure"],
  ])("removes partial output when pg_dump fails %#", async (failure, reason) => {
    const directory = await temporaryDirectory();
    const outputPath = join(directory, "database.dump");
    const runner = new FakeRunner();
    runner.failOperation = failure;
    const { database } = fakeDatabase();
    await expect(
      createPostgresLogicalBackup({
        allowPlaintextLoopback: true,
        connectionString: CONNECTION_STRING,
        database,
        outputPath,
        runner,
      }),
    ).rejects.toEqual(expect.objectContaining({ reason }));
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects an empty dump and cleans its partial file", async () => {
    const directory = await temporaryDirectory();
    const runner = new FakeRunner();
    runner.dumpBytes = Buffer.alloc(0);
    const { database } = fakeDatabase();
    await expect(
      createPostgresLogicalBackup({
        allowPlaintextLoopback: true,
        connectionString: CONNECTION_STRING,
        database,
        outputPath: join(directory, "database.dump"),
        runner,
      }),
    ).rejects.toEqual(expect.objectContaining({ reason: "dump is empty" }));
    expect(await readdir(directory)).toEqual([]);
  });

  it("does not delete a destination created by a publication race", async () => {
    const directory = await temporaryDirectory();
    const outputPath = join(directory, "database.dump");
    const runner = new FakeRunner();
    runner.onDump = async () => writeFile(outputPath, "racing writer");
    const { database } = fakeDatabase();
    await expect(
      createPostgresLogicalBackup({
        allowPlaintextLoopback: true,
        connectionString: CONNECTION_STRING,
        database,
        outputPath,
        runner,
      }),
    ).rejects.toEqual(expect.objectContaining({ reason: "logical dump did not complete" }));
    expect(await readFile(outputPath, "utf8")).toBe("racing writer");
    expect(await readdir(directory)).toEqual(["database.dump"]);
  });
});

describe("PostgreSQL logical restore", () => {
  async function dumpFile(contents: Uint8Array = DUMP_BYTES): Promise<string> {
    const directory = await temporaryDirectory();
    const path = join(directory, "database.dump");
    await writeFile(path, contents);
    return path;
  }

  it("restores only into an empty database in one transaction", async () => {
    const dumpPath = await dumpFile();
    const runner = new FakeRunner();
    runner.toolVersion = "pg_restore (PostgreSQL) 16.15";
    const { database, queries } = fakeDatabase();

    await expect(
      restorePostgresLogicalBackup({
        allowPlaintextLoopback: true,
        connectionString: CONNECTION_STRING,
        database,
        dumpPath,
        restoreExecutable: "test-pg-restore",
        runner,
      }),
    ).resolves.toEqual({
      engineVersion: "16.15",
      sha256: createHash("sha256").update(DUMP_BYTES).digest("hex"),
      sizeBytes: DUMP_BYTES.byteLength,
    });
    expect(runner.calls.at(-1)?.arguments).toEqual([
      "--exit-on-error",
      "--single-transaction",
      "--no-owner",
      "--no-privileges",
      "--dbname=proofstack_test",
      dumpPath,
    ]);
    expect(runner.calls.at(-1)?.arguments.join(" ")).not.toContain("private-password");
    expect(runner.calls.at(-1)?.environment).toMatchObject({
      PGDATABASE: "proofstack_test",
      PGHOST: "127.0.0.1",
      PGPASSWORD: "private-password",
      PGPORT: "5432",
      PGUSER: "recovery",
    });
    expect(queries.some((query) => query.includes("pg_extension"))).toBe(true);
    expect(queries.some((query) => query.includes("pg_type"))).toBe(true);
  });

  it.each([
    ["relative path", async () => "database.dump", "dump path must be an absolute"],
    [
      "missing file",
      async () => join(await temporaryDirectory(), "missing.dump"),
      "dump file is unavailable",
    ],
    ["empty file", async () => dumpFile(Buffer.alloc(0)), "not a non-empty regular file"],
    ["directory", async () => temporaryDirectory(), "not a non-empty regular file"],
  ])("refuses a %s", async (_name, createPath, reason) => {
    const { database } = fakeDatabase();
    await expect(
      restorePostgresLogicalBackup({
        allowPlaintextLoopback: true,
        connectionString: CONNECTION_STRING,
        database,
        dumpPath: await createPath(),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        operation: "database-restore",
        reason: expect.stringContaining(reason),
      }),
    );
  });

  it.each([
    [{ hasUserObjects: true }, "target database is not empty"],
    [{ omitEmptyTargetRow: true }, "target database is not empty"],
  ])("fails closed when target emptiness is not proven %#", async (databaseOptions, reason) => {
    const dumpPath = await dumpFile();
    const runner = new FakeRunner();
    const { database } = fakeDatabase(databaseOptions);
    await expect(
      restorePostgresLogicalBackup({
        allowPlaintextLoopback: true,
        connectionString: CONNECTION_STRING,
        database,
        dumpPath,
        runner,
      }),
    ).rejects.toEqual(expect.objectContaining({ reason }));
    expect(runner.calls).toEqual([]);
  });

  it("wraps invalid restore connection configuration", async () => {
    const dumpPath = await dumpFile();
    const { database } = fakeDatabase();
    await expect(
      restorePostgresLogicalBackup({
        allowPlaintextLoopback: false,
        connectionString: CONNECTION_STRING,
        database,
        dumpPath,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        operation: "database-restore",
        reason: "database connection configuration is invalid",
      }),
    );
  });

  it.each([
    [new Error("raw restore failure"), "logical restore did not complete"],
    [new RecoveryOperationError("postgres-tool", "safe restore failure"), "safe restore failure"],
  ])("preserves only bounded restore failures %#", async (failure, reason) => {
    const dumpPath = await dumpFile();
    const runner = new FakeRunner();
    runner.toolVersion = "pg_restore (PostgreSQL) 16.15";
    runner.failOperation = failure;
    const { database } = fakeDatabase();
    await expect(
      restorePostgresLogicalBackup({
        allowPlaintextLoopback: true,
        connectionString: CONNECTION_STRING,
        database,
        dumpPath,
        runner,
      }),
    ).rejects.toEqual(expect.objectContaining({ reason }));
  });

  it("fails closed if the restored dump cannot be rehashed", async () => {
    const dumpPath = await dumpFile();
    const runner = new FakeRunner();
    runner.toolVersion = "pg_restore (PostgreSQL) 16.15";
    runner.onRestore = async () => rm(dumpPath);
    const { database } = fakeDatabase();
    await expect(
      restorePostgresLogicalBackup({
        allowPlaintextLoopback: true,
        connectionString: CONNECTION_STRING,
        database,
        dumpPath,
        runner,
      }),
    ).rejects.toEqual(expect.objectContaining({ reason: "dump could not be hashed" }));
  });
});
