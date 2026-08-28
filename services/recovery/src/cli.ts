import type { Pool } from "pg";
import type { inspectVerifiedMigrationLedger, MigrationLedgerEntry } from "@proofstack/postgres";
import type {
  createPostgresLogicalBackup,
  PostgresLogicalBackupReceipt,
  restorePostgresLogicalBackup,
} from "./postgres-logical-backup.js";

interface RecoveryCliEnvironment extends NodeJS.ProcessEnv {
  readonly PROOFSTACK_ENV?: string;
  readonly PROOFSTACK_RECOVERY_DATABASE_URL?: string;
}

export interface RecoveryCliIo {
  readonly error: (message: string) => void;
  readonly output: (message: string) => void;
}

export interface RecoveryCliDependencies {
  readonly backup: typeof createPostgresLogicalBackup;
  readonly createPool: (connectionString: string, onIdleError: (error: Error) => void) => Pool;
  readonly inspectLedger: typeof inspectVerifiedMigrationLedger;
  readonly restore: typeof restorePostgresLogicalBackup;
}

export class RecoveryCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryCliUsageError";
  }
}

function databaseUrl(environment: RecoveryCliEnvironment): string {
  const value = environment.PROOFSTACK_RECOVERY_DATABASE_URL;
  if (typeof value !== "string" || value.length === 0) {
    throw new RecoveryCliUsageError(
      "Set PROOFSTACK_RECOVERY_DATABASE_URL to dedicated recovery credentials",
    );
  }
  return value;
}

function commandArguments(arguments_: readonly string[]): {
  readonly command: "database-backup" | "database-restore";
  readonly path: string;
} {
  const [command, path, extra] = arguments_;
  if (
    (command !== "database-backup" && command !== "database-restore") ||
    path === undefined ||
    path.length === 0 ||
    extra !== undefined
  ) {
    throw new RecoveryCliUsageError(
      "Usage: proofstack-recovery <database-backup|database-restore> <absolute-dump-path>",
    );
  }
  return { command, path };
}

function receiptOutput(
  operation: "database-backup" | "database-restore",
  path: string,
  receipt: PostgresLogicalBackupReceipt,
  migrationLedger: readonly MigrationLedgerEntry[],
): string {
  return JSON.stringify({
    component: "postgresql-logical-dump",
    engineVersion: receipt.engineVersion,
    operation,
    path,
    migrationLedger,
    sha256: receipt.sha256,
    sizeBytes: receipt.sizeBytes,
    status: "verified",
  });
}

export async function runRecoveryCli(
  arguments_: readonly string[],
  environment: RecoveryCliEnvironment,
  io: RecoveryCliIo,
  dependencies: RecoveryCliDependencies,
): Promise<number> {
  const { command, path } = commandArguments(arguments_);
  const connectionString = databaseUrl(environment);
  const allowPlaintextLoopback = environment.PROOFSTACK_ENV !== "production";
  let idleError: Error | undefined;
  const pool = dependencies.createPool(connectionString, (error) => {
    idleError = error;
    io.error("Idle PostgreSQL recovery connection failed");
  });

  try {
    const sourceLedger =
      command === "database-backup" ? await dependencies.inspectLedger(pool) : undefined;
    const receipt =
      command === "database-backup"
        ? await dependencies.backup({
            allowPlaintextLoopback,
            connectionString,
            database: pool,
            outputPath: path,
          })
        : await dependencies.restore({
            allowPlaintextLoopback,
            connectionString,
            database: pool,
            dumpPath: path,
          });
    const migrationLedger = sourceLedger ?? (await dependencies.inspectLedger(pool));
    io.output(receiptOutput(command, path, receipt, migrationLedger));
    return idleError === undefined ? 0 : 1;
  } finally {
    await pool.end();
  }
}
