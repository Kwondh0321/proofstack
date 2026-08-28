import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { chmod, link, lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { validatePostgresConnectionString } from "@proofstack/postgres";
import type { Pool } from "pg";
import { RecoveryOperationError } from "./errors.js";
import { NativePostgresCommandRunner, type PostgresCommandRunner } from "./postgres-command.js";

const POSTGRES_VERSION_PATTERN = /\b(\d+)(?:\.\d+)*\b/u;

interface ServerVersionRow {
  readonly server_version: string;
}

interface UserObjectRow {
  readonly has_user_objects: boolean;
}

export interface PostgresLogicalBackupOptions {
  readonly allowPlaintextLoopback: boolean;
  readonly connectionString: string;
  readonly database: Pick<Pool, "query">;
  readonly dumpExecutable?: string;
  readonly outputPath: string;
  readonly runner?: PostgresCommandRunner;
}

export interface PostgresLogicalRestoreOptions {
  readonly allowPlaintextLoopback: boolean;
  readonly connectionString: string;
  readonly database: Pick<Pool, "query">;
  readonly dumpPath: string;
  readonly restoreExecutable?: string;
  readonly runner?: PostgresCommandRunner;
}

export interface PostgresLogicalBackupReceipt {
  readonly engineVersion: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

function operationError(
  operation: "database-backup" | "database-restore",
  reason: string,
  cause?: unknown,
): RecoveryOperationError {
  return new RecoveryOperationError(operation, reason, cause === undefined ? undefined : { cause });
}

function safeChildEnvironment(connectionString?: string): Readonly<Record<string, string>> {
  const inheritedNames = [
    "DYLD_LIBRARY_PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "LD_LIBRARY_PATH",
    "PATH",
    "SYSTEMROOT",
    "TMPDIR",
    "WINDIR",
  ] as const;
  const environment: Record<string, string> = {};
  for (const name of inheritedNames) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return {
    ...environment,
    PGAPPNAME: "proofstack-recovery",
    ...(connectionString === undefined ? {} : { PGDATABASE: connectionString }),
  };
}

function versionMajor(version: string, operation: "database-backup" | "database-restore"): number {
  const match = POSTGRES_VERSION_PATTERN.exec(version);
  const major = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(major) || major < 16) {
    throw operationError(operation, "PostgreSQL version is missing or unsupported");
  }
  return major;
}

async function toolVersion(
  executable: string,
  runner: PostgresCommandRunner,
  operation: "database-backup" | "database-restore",
): Promise<string> {
  const result = await runner.run({
    arguments: ["--version"],
    environment: safeChildEnvironment(),
    executable,
    timeoutMs: 10_000,
  });
  const version = result.stdout.trim();
  versionMajor(version, operation);
  return version;
}

async function serverVersion(
  database: Pick<Pool, "query">,
  operation: "database-backup" | "database-restore",
): Promise<string> {
  const result = await database.query<ServerVersionRow>("SHOW server_version");
  const version = result.rows[0]?.server_version;
  if (version === undefined) throw operationError(operation, "database returned no server version");
  versionMajor(version, operation);
  return version;
}

function requireMatchingMajor(
  tool: string,
  server: string,
  operation: "database-backup" | "database-restore",
): void {
  if (versionMajor(tool, operation) !== versionMajor(server, operation)) {
    throw operationError(operation, "PostgreSQL client and server major versions differ");
  }
}

async function digestFile(
  path: string,
  operation: "database-backup" | "database-restore",
): Promise<{ readonly sha256: string; readonly sizeBytes: number }> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.size === 0) throw operationError(operation, "dump is empty");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
    return { sha256: digest.digest("hex"), sizeBytes: status.size };
  } catch (error) {
    if (error instanceof RecoveryOperationError) throw error;
    throw operationError(operation, "dump could not be hashed", error);
  }
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function validateAbsoluteFilePath(
  path: string,
  operation: "database-backup" | "database-restore",
): Promise<void> {
  if (!isAbsolute(path) || basename(path).length === 0) {
    throw operationError(operation, "dump path must be an absolute file path");
  }
}

function validatedConnectionString(
  connectionString: string,
  allowPlaintextLoopback: boolean,
  operation: "database-backup" | "database-restore",
): string {
  try {
    return validatePostgresConnectionString(connectionString, { allowPlaintextLoopback });
  } catch (error) {
    throw operationError(operation, "database connection configuration is invalid", error);
  }
}

export async function createPostgresLogicalBackup(
  options: PostgresLogicalBackupOptions,
): Promise<PostgresLogicalBackupReceipt> {
  await validateAbsoluteFilePath(options.outputPath, "database-backup");
  const connectionString = validatedConnectionString(
    options.connectionString,
    options.allowPlaintextLoopback,
    "database-backup",
  );
  const directory = dirname(options.outputPath);
  let directoryStatus: Stats;
  try {
    directoryStatus = await lstat(directory);
  } catch (error) {
    throw operationError("database-backup", "output directory is unavailable", error);
  }
  if (!directoryStatus.isDirectory()) {
    throw operationError("database-backup", "output directory is not a directory");
  }
  try {
    await lstat(options.outputPath);
    throw operationError("database-backup", "output path already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const runner = options.runner ?? new NativePostgresCommandRunner();
  const executable = options.dumpExecutable ?? "pg_dump";
  const [tool, server] = await Promise.all([
    toolVersion(executable, runner, "database-backup"),
    serverVersion(options.database, "database-backup"),
  ]);
  requireMatchingMajor(tool, server, "database-backup");

  const temporaryPath = join(directory, `.${basename(options.outputPath)}.${randomUUID()}.partial`);
  let published = false;
  const handle = await open(temporaryPath, "wx", 0o600);
  await handle.close();
  try {
    await runner.run({
      arguments: ["--format=custom", "--no-owner", "--no-privileges", `--file=${temporaryPath}`],
      environment: safeChildEnvironment(connectionString),
      executable,
    });
    const receipt = await digestFile(temporaryPath, "database-backup");
    await syncPath(temporaryPath);
    await link(temporaryPath, options.outputPath);
    published = true;
    await chmod(options.outputPath, 0o600);
    await syncPath(options.outputPath);
    await syncPath(directory);
    return { engineVersion: server, ...receipt };
  } catch (error) {
    if (published) await removeIfPresent(options.outputPath);
    if (error instanceof RecoveryOperationError) throw error;
    throw operationError("database-backup", "logical dump did not complete", error);
  } finally {
    await removeIfPresent(temporaryPath);
  }
}

async function assertEmptyTarget(database: Pick<Pool, "query">): Promise<void> {
  const result = await database.query<UserObjectRow>(`
    SELECT (
      EXISTS (
        SELECT 1
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
          AND namespace.nspname !~ '^pg_toast'
      )
      OR EXISTS (
        SELECT 1
        FROM pg_proc AS routine
        JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      )
      OR EXISTS (
        SELECT 1
        FROM pg_namespace
        WHERE nspname NOT IN ('public', 'pg_catalog', 'information_schema')
          AND nspname !~ '^pg_toast'
      )
      OR EXISTS (
        SELECT 1
        FROM pg_type AS data_type
        JOIN pg_namespace AS namespace ON namespace.oid = data_type.typnamespace
        WHERE namespace.nspname = 'public'
          AND data_type.typtype IN ('d', 'e', 'm', 'r')
      )
      OR EXISTS (
        SELECT 1
        FROM pg_extension
        WHERE extname <> 'plpgsql'
      )
    ) AS has_user_objects
  `);
  if (result.rows[0]?.has_user_objects !== false) {
    throw operationError("database-restore", "target database is not empty");
  }
}

export async function restorePostgresLogicalBackup(
  options: PostgresLogicalRestoreOptions,
): Promise<PostgresLogicalBackupReceipt> {
  await validateAbsoluteFilePath(options.dumpPath, "database-restore");
  let dumpStatus: Stats;
  try {
    dumpStatus = await lstat(options.dumpPath);
  } catch (error) {
    throw operationError("database-restore", "dump file is unavailable", error);
  }
  if (!dumpStatus.isFile() || dumpStatus.size === 0) {
    throw operationError("database-restore", "dump path is not a non-empty regular file");
  }
  const connectionString = validatedConnectionString(
    options.connectionString,
    options.allowPlaintextLoopback,
    "database-restore",
  );
  await assertEmptyTarget(options.database);

  const runner = options.runner ?? new NativePostgresCommandRunner();
  const executable = options.restoreExecutable ?? "pg_restore";
  const [tool, server] = await Promise.all([
    toolVersion(executable, runner, "database-restore"),
    serverVersion(options.database, "database-restore"),
  ]);
  requireMatchingMajor(tool, server, "database-restore");

  try {
    await runner.run({
      arguments: [
        "--exit-on-error",
        "--single-transaction",
        "--no-owner",
        "--no-privileges",
        options.dumpPath,
      ],
      environment: safeChildEnvironment(connectionString),
      executable,
    });
  } catch (error) {
    if (error instanceof RecoveryOperationError) throw error;
    throw operationError("database-restore", "logical restore did not complete", error);
  }
  const receipt = await digestFile(options.dumpPath, "database-restore");
  return { engineVersion: server, ...receipt };
}
