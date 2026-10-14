import { Pool } from "pg";
import { PolicyWireClient } from "./policy-wire-admission.js";

export interface PostgresPoolOptions {
  readonly applicationName?: string;
  readonly connectionString: string;
  readonly connectionTimeoutMilliseconds?: number;
  readonly maxConnections?: number;
  readonly onIdleError: (error: Error) => void;
}

export function createPostgresPool(options: PostgresPoolOptions): Pool {
  return createPool(options);
}

/** Dedicated native policy pool. General application pools retain their original defaults. */
export function createPolicyPostgresPool(options: PostgresPoolOptions): Pool {
  const timeout = options.connectionTimeoutMilliseconds ?? 500;
  const maximum = options.maxConnections ?? 10;
  if (timeout > 500 || !Number.isSafeInteger(maximum) || maximum <= 0 || maximum > 16)
    throw new RangeError(
      "Policy PostgreSQL pool requires at most 500 ms checkout and 1–16 clients",
    );
  return createPool({ ...options, connectionTimeoutMilliseconds: timeout }, PolicyWireClient);
}

function createPool(options: PostgresPoolOptions, Client?: typeof PolicyWireClient): Pool {
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
    ...(Client ? { Client } : {}),
    application_name: options.applicationName ?? "proofstack",
    connectionString: options.connectionString,
    connectionTimeoutMillis: options.connectionTimeoutMilliseconds ?? 5_000,
    idleTimeoutMillis: 30_000,
    max: options.maxConnections ?? 10,
  });
  pool.on("error", options.onIdleError);
  return pool;
}
