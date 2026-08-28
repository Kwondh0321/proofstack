const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export interface PostgresConnectionRequirements {
  readonly allowPlaintextLoopback: boolean;
}

export class PostgresConnectionStringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresConnectionStringError";
  }
}

export function validatePostgresConnectionString(
  value: string,
  requirements: PostgresConnectionRequirements,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PostgresConnectionStringError("PostgreSQL connection string must be a valid URL");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new PostgresConnectionStringError(
      "PostgreSQL connection string must use postgres: or postgresql:",
    );
  }
  if (!url.hostname) {
    throw new PostgresConnectionStringError("PostgreSQL connection string must include a host");
  }
  if (!url.username) {
    throw new PostgresConnectionStringError("PostgreSQL connection string must include a role");
  }
  if (url.pathname.length <= 1) {
    throw new PostgresConnectionStringError("PostgreSQL connection string must include a database");
  }
  if (url.hash) {
    throw new PostgresConnectionStringError(
      "PostgreSQL connection string cannot include a fragment",
    );
  }

  const sslModes = url.searchParams.getAll("sslmode");
  if (sslModes.length > 1) {
    throw new PostgresConnectionStringError(
      "PostgreSQL connection string has duplicate sslmode values",
    );
  }
  const verifiedTls = sslModes[0] === "verify-full";
  const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (!verifiedTls && (!requirements.allowPlaintextLoopback || !loopback)) {
    throw new PostgresConnectionStringError(
      "PostgreSQL connections require sslmode=verify-full unless development uses loopback",
    );
  }

  return value;
}
