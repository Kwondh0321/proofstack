import type { Pool, PoolClient } from "pg";

export class PostgresTransactionCleanupError extends Error {
  readonly rollbackError: unknown;

  constructor(operationError: unknown, rollbackError: unknown) {
    super("PostgreSQL transaction rollback failed; the connection was destroyed", {
      cause: operationError,
    });
    this.name = "PostgresTransactionCleanupError";
    this.rollbackError = rollbackError;
  }
}

export async function withTenantTransaction<Result>(
  pool: Pick<Pool, "connect">,
  tenantId: string,
  operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  let connectionDestroyed = false;
  let transactionStarted = false;

  try {
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query("SELECT set_config('proofstack.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      transactionStarted = false;
      return result;
    } catch (operationError) {
      if (!transactionStarted) {
        client.release(true);
        connectionDestroyed = true;
        throw operationError;
      }

      try {
        await client.query("ROLLBACK");
        transactionStarted = false;
      } catch (rollbackError) {
        client.release(true);
        connectionDestroyed = true;
        throw new PostgresTransactionCleanupError(operationError, rollbackError);
      }
      throw operationError;
    }
  } finally {
    if (!connectionDestroyed) client.release();
  }
}
