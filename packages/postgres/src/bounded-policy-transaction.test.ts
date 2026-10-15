import { performance } from "node:perf_hooks";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PolicyTransactionPool,
  tightenPolicyTransaction,
  withBoundedPolicyTransaction,
} from "./bounded-policy-transaction.js";

const scope = { tenantId: "tenant_io", projectId: "project_io", environmentId: "environment_io" };
function fixture() {
  const calls: string[] = [];
  const blockRejects = new Set<(error: unknown) => void>();
  const original = new Error("original query failure");
  const query = vi.fn(async (text: string) => {
    calls.push(text);
    if (text === "SELECT fail") throw original;
    if (text === "SELECT block")
      return new Promise<never>((_resolve, reject) => {
        blockRejects.add(reject);
      });
    return { rows: [] };
  });
  const release = vi.fn(),
    end = vi.fn(async () => undefined);
  const destroy = vi.fn(() => {
    for (const reject of blockRejects) reject(new Error("connection destroyed"));
    blockRejects.clear();
  });
  const physical = {
    query,
    release,
    end,
    connection: { stream: { destroy } },
    connectionParameters: { query_timeout: false as unknown },
  };
  const pool = {
    options: { connectionTimeoutMillis: 500, max: 4 },
    waitingCount: 0,
    connect: vi.fn(async () => physical),
  } as unknown as PolicyTransactionPool;
  return { pool, physical, calls, original };
}
afterEach(() => vi.useRealTimers());
describe("bounded policy transaction lifecycle", () => {
  it.each(["sealing", "initial_sources"] as const)(
    "rejects %s on an unbranded client before SQL and destroys/releases it once",
    async (purpose) => {
      const f = fixture();
      const operation = vi.fn();
      await expect(
        withBoundedPolicyTransaction(f.pool, operation, {
          scope,
          ...(purpose === "sealing" ? { sealing: true } : { requireWire: true }),
        }),
      ).rejects.toMatchObject({ code: "wire_pool_required" });
      expect(operation).not.toHaveBeenCalled();
      expect(f.calls).toEqual([]);
      expect(f.physical.connection.stream.destroy).toHaveBeenCalledTimes(1);
      expect(f.physical.end).toHaveBeenCalledTimes(1);
      expect(f.physical.release).toHaveBeenCalledExactlyOnceWith(true);
    },
  );
  it("rejects mixed sealing/owner recovery before checking out a client", async () => {
    const f = fixture();
    await expect(
      withBoundedPolicyTransaction(f.pool, async () => undefined, {
        sealing: true,
        recovery: true,
      }),
    ).rejects.toThrow("separate transaction purposes");
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it("sets real server SQL bounds and exact scope, commits only once, then expires its port", async () => {
    const f = fixture();
    let retained: PoolClient | undefined;
    expect(
      await withBoundedPolicyTransaction(
        f.pool,
        async (client) => {
          retained = client;
          await client.query("SELECT okay");
          return "result";
        },
        { scope },
      ),
    ).toBe("result");
    expect(f.calls[0]).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(f.calls[1]).toContain("statement_timeout");
    expect(f.calls.filter((value) => value.includes("proofstack."))).toHaveLength(3);
    expect(f.calls.at(-1)).toBe("COMMIT");
    expect(f.physical.release).toHaveBeenCalledExactlyOnceWith();
    await expect(retained!.query("SELECT late")).rejects.toMatchObject({ code: "port_expired" });
    expect(f.calls).not.toContain("SELECT late");
  });
  it.each(["caught", "unawaited"])(
    "a %s query failure taints the whole operation",
    async (kind) => {
      const f = fixture();
      await expect(
        withBoundedPolicyTransaction(f.pool, async (client) => {
          const task = client.query("SELECT fail");
          if (kind === "caught") await task.catch(() => undefined);
          return "cannot commit";
        }),
      ).rejects.toBe(f.original);
      expect(f.calls.at(-1)).toBe("ROLLBACK");
      expect(f.calls).not.toContain("COMMIT");
      expect(f.physical.release).toHaveBeenCalledExactlyOnceWith();
    },
  );
  it.each(["release", "end"] as const)(
    "cannot catch a forbidden %s call and commit",
    async (method) => {
      const f = fixture();
      await expect(
        withBoundedPolicyTransaction(f.pool, async (client) => {
          try {
            client[method]();
          } catch {
            /* failure must still taint */
          }
        }),
      ).rejects.toMatchObject({ code: "port_expired" });
      expect(f.calls).not.toContain("COMMIT");
    },
  );
  it("physically destroys and drains a stalled query before destroying pool release", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const operation = withBoundedPolicyTransaction(f.pool, (client) =>
      client.query("SELECT block"),
    );
    const rejection = expect(operation).rejects.toMatchObject({ code: "deadline_exceeded" });
    await vi.waitFor(() => expect(f.calls).toContain("SELECT block"));
    await vi.advanceTimersByTimeAsync(2001);
    await rejection;
    expect(f.physical.connection.stream.destroy).toHaveBeenCalledOnce();
    expect(f.physical.end).toHaveBeenCalledOnce();
    expect(f.physical.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.calls).not.toContain("COMMIT");
  });
  it("can shorten but never extend a native remaining-time budget", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const operation = withBoundedPolicyTransaction(f.pool, async (client) => {
      tightenPolicyTransaction(client, 10, performance.now());
      tightenPolicyTransaction(client, 100000, performance.now());
      await client.query("SELECT block");
    });
    const rejection = expect(operation).rejects.toMatchObject({ code: "deadline_exceeded" });
    await vi.waitFor(() => expect(f.calls).toContain("SELECT block"));
    await vi.advanceTimersByTimeAsync(11);
    await rejection;
    expect(f.physical.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("ends an abandoned callback after closing SQL access without waiting for unrelated work", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let retained: PoolClient | undefined;
    const operation = withBoundedPolicyTransaction(f.pool, async (client) => {
      retained = client;
      await client.query("SELECT okay");
      return new Promise<never>(() => undefined);
    });
    const rejection = expect(operation).rejects.toMatchObject({ code: "deadline_exceeded" });
    await vi.waitFor(() => expect(f.calls).toContain("SELECT okay"));
    await vi.advanceTimersByTimeAsync(2001);
    await rejection;
    await expect(retained!.query("SELECT late")).rejects.toMatchObject({ code: "port_expired" });
    expect(f.calls).not.toContain("COMMIT");
    expect(f.physical.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it.each([0, 501, undefined])(
    "refuses an unbounded checkout configuration %s before connecting",
    async (timeout) => {
      const f = fixture();
      f.pool.options.connectionTimeoutMillis = timeout;
      await expect(
        withBoundedPolicyTransaction(f.pool, async () => undefined),
      ).rejects.toMatchObject({ code: "pool_admission" });
      expect(f.pool.connect).not.toHaveBeenCalled();
    },
  );
  it("refuses an already saturated pool without adding another waiter", async () => {
    const f = fixture();
    const crowded = { ...f.pool, waitingCount: 64 };
    await expect(
      withBoundedPolicyTransaction(crowded, async () => undefined),
    ).rejects.toMatchObject({ code: "pool_admission" });
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it("rejects pg read timeout both in pool config and URI-effective client settings", async () => {
    const f = fixture();
    f.pool.options.query_timeout = 1;
    await expect(withBoundedPolicyTransaction(f.pool, async () => undefined)).rejects.toMatchObject(
      { code: "driver_timeout_unsupported" },
    );
    expect(f.pool.connect).not.toHaveBeenCalled();
    f.pool.options.query_timeout = 0;
    f.physical.connectionParameters.query_timeout = 1;
    await expect(withBoundedPolicyTransaction(f.pool, async () => undefined)).rejects.toMatchObject(
      { code: "driver_timeout_unsupported" },
    );
    expect(f.calls).not.toContain("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(f.physical.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("keeps the original query cause if rollback also fails and destroys once", async () => {
    const f = fixture(),
      rollback = new Error("rollback failure");
    f.physical.query.mockImplementation(async (text) => {
      f.calls.push(text);
      if (text === "SELECT fail") throw f.original;
      if (text === "ROLLBACK") throw rollback;
      return { rows: [] };
    });
    await expect(
      withBoundedPolicyTransaction(f.pool, (client) => client.query("SELECT fail")),
    ).rejects.toMatchObject({
      name: "PostgresTransactionCleanupError",
      cause: f.original,
      rollbackError: rollback,
    });
    expect(f.physical.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("cannot catch invalid native-budget admission and commit", async () => {
    const f = fixture();
    await expect(
      withBoundedPolicyTransaction(f.pool, async (client) => {
        try {
          tightenPolicyTransaction(client, 0, performance.now());
        } catch {
          /* must remain tainted */
        }
      }),
    ).rejects.toMatchObject({ code: "deadline_exceeded" });
    expect(f.calls).not.toContain("COMMIT");
  });
  it("copies bound values before deferred driver dispatch", async () => {
    const f = fixture();
    await withBoundedPolicyTransaction(f.pool, async (client) => {
      const values = ["original"];
      const response = client.query("SELECT $1", values);
      values[0] = "substituted";
      await response;
    });
    expect(f.physical.query).toHaveBeenCalledWith("SELECT $1", ["original"]);
  });
  it("limits total query admission even when every query completes quickly", async () => {
    const f = fixture();
    await expect(
      withBoundedPolicyTransaction(f.pool, async (client) => {
        for (let i = 0; i < 300; i++) await client.query("SELECT okay");
      }),
    ).rejects.toMatchObject({ code: "query_admission" });
    expect(f.calls.filter((value) => value === "SELECT okay")).toHaveLength(254);
    expect(f.calls).not.toContain("COMMIT");
  });
  it("bounds pending query admission, destroys and drains every started query", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const operation = withBoundedPolicyTransaction(f.pool, async (client) => {
      const tasks = Array.from({ length: 17 }, () => client.query("SELECT block"));
      await Promise.allSettled(tasks);
    });
    const rejection = expect(operation).rejects.toMatchObject({ code: "query_admission" });
    await vi.waitFor(() =>
      expect(f.calls.filter((value) => value === "SELECT block")).toHaveLength(16),
    );
    await vi.advanceTimersByTimeAsync(2001);
    await rejection;
    expect(f.physical.release).toHaveBeenCalledExactlyOnceWith(true);
  });
});
