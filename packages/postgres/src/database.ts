import { Pool } from "pg";

export interface PostgresPoolOptions {
  readonly applicationName?: string;
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly onIdleError: (error: Error) => void;
}

export function createPostgresPool(options: PostgresPoolOptions): Pool {
  const pool = new Pool({
    application_name: options.applicationName ?? "proofstack",
    connectionString: options.connectionString,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: options.maxConnections ?? 10,
  });
  pool.on("error", options.onIdleError);
  return pool;
}
