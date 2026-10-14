import { Pool } from "pg";

export interface PostgresPoolOptions {
  readonly applicationName?: string;
  readonly connectionString: string;
  readonly connectionTimeoutMilliseconds?: number;
  readonly maxConnections?: number;
  readonly onIdleError: (error: Error) => void;
}

export function createPostgresPool(options: PostgresPoolOptions): Pool {
  if (
    options.connectionTimeoutMilliseconds !== undefined &&
    (!Number.isSafeInteger(options.connectionTimeoutMilliseconds) ||
      options.connectionTimeoutMilliseconds <= 0 ||
      options.connectionTimeoutMilliseconds > 5000)
  )
    throw new RangeError(
      "PostgreSQL connection timeout must be an integer between 1 and 5000 milliseconds",
    );
  const pool = new Pool({
    application_name: options.applicationName ?? "proofstack",
    connectionString: options.connectionString,
    connectionTimeoutMillis: options.connectionTimeoutMilliseconds ?? 5_000,
    idleTimeoutMillis: 30_000,
    max: options.maxConnections ?? 10,
  });
  pool.on("error", options.onIdleError);
  return pool;
}
