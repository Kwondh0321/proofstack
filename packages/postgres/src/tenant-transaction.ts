import type { Pool, PoolClient } from "pg";

export interface PostgresExactScope {
  readonly environmentId: string;
  readonly projectId: string;
  readonly tenantId: string;
}

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

async function withTransactionContext<Result>(
  pool: Pick<Pool, "connect">,
  context: readonly { readonly statement: string; readonly value: string }[],
  operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  let connectionDestroyed = false;
  let transactionStarted = false;

  try {
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      for (const { statement, value } of context) {
        await client.query(statement, [value]);
      }
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

export async function withTenantTransaction<Result>(
  pool: Pick<Pool, "connect">,
  tenantId: string,
  operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  return withTransactionContext(
    pool,
    [
      {
        statement: "SELECT set_config('proofstack.tenant_id', $1, true)",
        value: tenantId,
      },
    ],
    operation,
  );
}

/** Runs one transaction with all tenant-bearing policy scope dimensions set transaction-locally. */
export async function withExactScopeTransaction<Result>(
  pool: Pick<Pool, "connect">,
  scope: PostgresExactScope,
  operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  return withTransactionContext(
    pool,
    [
      {
        statement: "SELECT set_config('proofstack.tenant_id', $1, true)",
        value: scope.tenantId,
      },
      {
        statement: "SELECT set_config('proofstack.project_id', $1, true)",
        value: scope.projectId,
      },
      {
        statement: "SELECT set_config('proofstack.environment_id', $1, true)",
        value: scope.environmentId,
      },
    ],
    operation,
  );
}
