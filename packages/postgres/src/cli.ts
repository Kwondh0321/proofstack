#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createPostgresPool } from "./database.js";
import { inspectMigrations, migrateDatabase } from "./migration-runner.js";

interface DatabaseCliEnvironment extends NodeJS.ProcessEnv {
  readonly PROOFSTACK_DATABASE_URL?: string;
  readonly PROOFSTACK_ENV?: string;
  readonly PROOFSTACK_MIGRATION_DATABASE_URL?: string;
}

export interface DatabaseCliIo {
  readonly error: (message: string) => void;
  readonly output: (message: string) => void;
}

interface DatabaseCliDependencies {
  readonly createPool: (connectionString: string, onIdleError: (error: Error) => void) => Pool;
  readonly inspect: typeof inspectMigrations;
  readonly migrate: typeof migrateDatabase;
}

const defaultDependencies: DatabaseCliDependencies = {
  createPool: (connectionString, onIdleError) =>
    createPostgresPool({
      applicationName: "proofstack-migrations",
      connectionString,
      maxConnections: 1,
      onIdleError,
    }),
  inspect: inspectMigrations,
  migrate: migrateDatabase,
};

export class DatabaseCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseCliUsageError";
  }
}

function migrationDatabaseUrl(environment: DatabaseCliEnvironment): string {
  const dedicatedUrl = environment.PROOFSTACK_MIGRATION_DATABASE_URL;
  if (dedicatedUrl) return dedicatedUrl;
  if (environment.PROOFSTACK_ENV === "production") {
    throw new DatabaseCliUsageError("PROOFSTACK_MIGRATION_DATABASE_URL is required in production");
  }
  if (environment.PROOFSTACK_DATABASE_URL) return environment.PROOFSTACK_DATABASE_URL;
  throw new DatabaseCliUsageError(
    "Set PROOFSTACK_MIGRATION_DATABASE_URL before running database commands",
  );
}

export async function runDatabaseCli(
  arguments_: readonly string[],
  environment: DatabaseCliEnvironment,
  io: DatabaseCliIo,
  dependencies: DatabaseCliDependencies = defaultDependencies,
): Promise<number> {
  const command = arguments_[0];
  if (command !== "migrate" && command !== "status") {
    throw new DatabaseCliUsageError("Usage: proofstack-db <migrate|status>");
  }

  const connectionString = migrationDatabaseUrl(environment);
  let idleError: Error | undefined;
  const pool = dependencies.createPool(connectionString, (error) => {
    idleError = error;
    io.error(`Idle PostgreSQL connection failed: ${error.message}`);
  });

  try {
    if (command === "migrate") {
      const result = await dependencies.migrate(pool);
      io.output(
        JSON.stringify({
          appliedIds: result.appliedIds,
          newlyAppliedIds: result.newlyAppliedIds,
          status: "current",
        }),
      );
      return idleError ? 1 : 0;
    }

    const status = await dependencies.inspect(pool);
    io.output(
      JSON.stringify({
        appliedIds: status.appliedIds,
        ledgerExists: status.ledgerExists,
        pendingIds: status.pendingIds,
        status: status.ledgerExists && status.pendingIds.length === 0 ? "current" : "pending",
      }),
    );
    return idleError || !status.ledgerExists || status.pendingIds.length > 0 ? 1 : 0;
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && fileURLToPath(import.meta.url) === resolve(entrypoint)) {
  try {
    process.exitCode = await runDatabaseCli(process.argv.slice(2), process.env, {
      error: (message) => console.error(message),
      output: (message) => console.log(message),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Database command failed");
    process.exitCode = 1;
  }
}
