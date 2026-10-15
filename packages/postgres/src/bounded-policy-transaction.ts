import { performance } from "node:perf_hooks";
import type { EvidenceScope } from "@proofstack/contracts";
import type { Pool, PoolClient } from "pg";
import { PostgresTransactionCleanupError } from "./tenant-transaction.js";
import { beginPolicyWireTransaction } from "./policy-wire-admission.js";

export type PolicyTransactionPool = Pick<Pool, "connect" | "options" | "waitingCount">;
export const MAX_POLICY_POOL_WAIT_MILLISECONDS = 500;
export const MAX_POLICY_POOL_WAITERS = 64;
export const POLICY_TRANSACTION_MILLISECONDS = 2000;
export const POLICY_RECOVERY_TRANSACTION_MILLISECONDS = 120000;
export const POLICY_SEAL_TRANSACTION_MILLISECONDS = 15000;
const STATEMENT_MILLISECONDS = 1000;
const LOCK_MILLISECONDS = 250;

export class PostgresPolicyIoError extends Error {
  constructor(
    readonly code:
      | "pool_admission"
      | "deadline_exceeded"
      | "port_expired"
      | "driver_timeout_unsupported"
      | "wire_pool_required"
      | "query_admission",
  ) {
    super(`Policy PostgreSQL I/O failed: ${code}`);
    this.name = "PostgresPolicyIoError";
  }
}
interface TransactionBudget {
  readonly beganAt: number;
  deadline: number;
  tighten: (milliseconds: number, invokedAt: number) => void;
  reject: (error: unknown) => void;
}
const budgets = new WeakMap<PoolClient, TransactionBudget>();

/** Internal server-owned admission. This can only shorten a transaction's monotonic limit. */
export function tightenPolicyTransaction(
  client: PoolClient,
  milliseconds: number,
  invokedAt: number,
): void {
  const budget = budgets.get(client);
  if (
    !budget ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0 ||
    !Number.isFinite(invokedAt) ||
    invokedAt < budget.beganAt ||
    invokedAt > performance.now()
  ) {
    const error = new PostgresPolicyIoError("deadline_exceeded");
    budget?.reject(error);
    throw error;
  }
  budget.tighten(milliseconds, invokedAt);
}
function admitPool(pool: PolicyTransactionPool): void {
  const wait = pool.options?.connectionTimeoutMillis;
  if (
    !Number.isSafeInteger(wait) ||
    wait === undefined ||
    wait <= 0 ||
    wait > MAX_POLICY_POOL_WAIT_MILLISECONDS ||
    !Number.isSafeInteger(pool.waitingCount) ||
    pool.waitingCount < 0 ||
    pool.waitingCount >= MAX_POLICY_POOL_WAITERS
  )
    throw new PostgresPolicyIoError("pool_admission");
  const size = pool.options.max ?? 10;
  if (!Number.isSafeInteger(size) || size <= 0 || size > 16)
    throw new PostgresPolicyIoError("pool_admission");
  if (pool.options.query_timeout !== undefined && pool.options.query_timeout !== 0)
    throw new PostgresPolicyIoError("driver_timeout_unsupported");
}

/** Fixed policy transactions only. No pg read timeout or Promise.race substitutes for drain. */
export async function withBoundedPolicyTransaction<T>(
  pool: PolicyTransactionPool,
  work: (client: PoolClient) => Promise<T>,
  options: {
    readonly scope?: EvidenceScope;
    readonly recovery?: boolean;
    readonly sealing?: boolean;
    /** Server-owned initial source reads also require pre-decoder physical admission. */
    readonly requireWire?: boolean;
  } = {},
): Promise<T> {
  if (options.recovery && options.sealing)
    throw new TypeError("Policy sealing and owner recovery are separate transaction purposes");
  admitPool(pool);
  const physical = await pool.connect();
  const pending = new Set<Promise<unknown>>();
  let queryCount = 0;
  let active = true,
    expired = false,
    tainted = false,
    firstFailure: unknown;
  let transactionStarted = false,
    connectionDestroyed = false;
  let destruction: Promise<void> | undefined;
  const destroy = () => {
    connectionDestroyed = true;
    destruction ??= Promise.resolve()
      .then(() => {
        physical.connection.stream.destroy();
        return physical.end();
      })
      .then(() => undefined);
    // Keep the destruction promise observed even while an active query is rejecting.
    void destruction.catch(() => undefined);
    return destruction;
  };
  const fail = (error: unknown) => {
    if (!tainted) {
      tainted = true;
      firstFailure = error;
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline: (error: unknown) => void = () => undefined;
  const deadlineFailure = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  void deadlineFailure.catch(() => undefined);
  const beganAt = performance.now();
  const budget: TransactionBudget = {
    reject: fail,
    beganAt,
    deadline:
      beganAt +
      (options.sealing
        ? POLICY_SEAL_TRANSACTION_MILLISECONDS
        : options.recovery
          ? POLICY_RECOVERY_TRANSACTION_MILLISECONDS
          : POLICY_TRANSACTION_MILLISECONDS),
    tighten(milliseconds, invokedAt) {
      budget.deadline = Math.min(budget.deadline, invokedAt + milliseconds);
      schedule();
    },
  };
  function expire() {
    active = false;
    expired = true;
    fail(new PostgresPolicyIoError("deadline_exceeded"));
    rejectDeadline(firstFailure);
    void destroy();
  }
  function schedule() {
    if (timer !== undefined) clearTimeout(timer);
    const remaining = budget.deadline - performance.now();
    if (remaining <= 0) {
      expire();
      return;
    }
    timer = setTimeout(expire, remaining);
  }
  const track = <Result>(task: Promise<Result>): Promise<Result> => {
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      (error: unknown) => {
        pending.delete(task);
        fail(error);
      },
    );
    return task;
  };
  const client = new Proxy(physical, {
    get(target, property) {
      if (property === "query")
        return (statement: string, values?: readonly unknown[]) => {
          if (!active) return track(Promise.reject(new PostgresPolicyIoError("port_expired")));
          if (expired || performance.now() >= budget.deadline) {
            expire();
            return track(Promise.reject(firstFailure));
          }
          if (tainted) return track(Promise.reject(firstFailure));
          if (
            pending.size >= 16 ||
            ++queryCount > (options.recovery || options.sealing ? 1200016 : 256)
          ) {
            const error = new PostgresPolicyIoError("query_admission");
            fail(error);
            return track(Promise.reject(error));
          }
          if (typeof statement !== "string" || (values !== undefined && !Array.isArray(values)))
            return track(
              Promise.reject(
                new TypeError("Policy query port accepts fixed SQL and bound values only"),
              ),
            );
          const copied = values ? [...values] : undefined;
          return track(Promise.resolve().then(() => target.query(statement, copied)));
        };
      if (property === "release" || property === "end")
        return () => {
          const error = new PostgresPolicyIoError("port_expired");
          fail(error);
          throw error;
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PoolClient;
  budgets.set(client, budget);
  schedule();
  const drain = async () => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  };
  let finishWire: (() => void) | undefined;
  try {
    finishWire = beginPolicyWireTransaction(
      physical,
      options.sealing ? "sealing" : options.recovery === true,
      (error) => {
        active = false;
        fail(error);
        void destroy();
      },
    );
    if ((options.sealing || options.requireWire) && !finishWire)
      throw new PostgresPolicyIoError("wire_pool_required");
    // URI configuration may override pool options. Inspect the effective driver setting too.
    const effective = (
      physical as PoolClient & { connectionParameters?: { query_timeout?: unknown } }
    ).connectionParameters?.query_timeout;
    if (effective !== undefined && effective !== 0 && effective !== false)
      throw new PostgresPolicyIoError("driver_timeout_unsupported");
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    transactionStarted = true;
    await client.query(
      "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true),set_config('idle_in_transaction_session_timeout',$3,true)",
      [
        String(STATEMENT_MILLISECONDS),
        String(LOCK_MILLISECONDS),
        String(
          options.sealing
            ? POLICY_SEAL_TRANSACTION_MILLISECONDS
            : options.recovery
              ? POLICY_RECOVERY_TRANSACTION_MILLISECONDS
              : POLICY_TRANSACTION_MILLISECONDS,
        ),
      ],
    );
    if (options.scope)
      for (const [name, value] of [
        ["tenant_id", options.scope.tenantId],
        ["project_id", options.scope.projectId],
        ["environment_id", options.scope.environmentId],
      ] as const)
        await client.query(`SELECT set_config('proofstack.${name}',$1,true)`, [value]);
    // The watchdog also closes the physical connection and drains started SQL; racing the
    // callback alone would neither cancel its query nor prevent a later use of its port.
    const result = await Promise.race([
      Promise.resolve().then(() => work(client)),
      deadlineFailure,
    ]);
    active = false;
    await drain();
    if (tainted) throw firstFailure;
    if (performance.now() >= budget.deadline) {
      expire();
      throw firstFailure;
    }
    await track(physical.query("COMMIT"));
    transactionStarted = false;
    if (tainted) throw firstFailure;
    return result;
  } catch (error) {
    active = false;
    fail(error);
    await drain();
    if (connectionDestroyed) {
      await destruction?.catch(() => undefined);
      throw firstFailure;
    }
    if (!transactionStarted) {
      await destroy().catch(() => undefined);
      throw firstFailure;
    }
    try {
      await track(physical.query("ROLLBACK"));
      transactionStarted = false;
    } catch (rollbackError) {
      await destroy().catch(() => undefined);
      throw new PostgresTransactionCleanupError(firstFailure, rollbackError);
    }
    throw firstFailure;
  } finally {
    active = false;
    budgets.delete(client);
    if (timer !== undefined) clearTimeout(timer);
    await drain();
    await destruction?.catch(() => undefined);
    finishWire?.();
    if (connectionDestroyed) physical.release(true);
    else physical.release();
  }
}
