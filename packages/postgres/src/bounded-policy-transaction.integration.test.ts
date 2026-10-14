import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  tightenPolicyTransaction,
  withBoundedPolicyTransaction,
} from "./bounded-policy-transaction.js";

const databaseUrl = process.env["PROOFSTACK_TEST_DATABASE_URL"];
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 500 });
beforeAll(async () => {
  expect((await pool.query("SELECT current_database() AS name")).rows[0]!.name).toBe(
    "proofstack_test",
  );
});
afterAll(async () => {
  await pool.end();
});
describe("actual PostgreSQL policy I/O cancellation and clean reuse", () => {
  it("server-cancels pg_sleep and drains rollback before reusing the same backend", async () => {
    const own = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 500 });
    try {
      const before = (await own.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await expect(
        withBoundedPolicyTransaction(own, (client) => client.query("SELECT pg_sleep(5)")),
      ).rejects.toMatchObject({ code: "57014" });
      const next = await withBoundedPolicyTransaction(own, (client) =>
        client.query(
          "SELECT pg_backend_pid() AS pid,current_setting('statement_timeout') AS bound",
        ),
      );
      expect(next.rows[0]!.pid).toBe(before);
      expect(next.rows[0]!.bound).toBe("1s");
      expect(own.waitingCount).toBe(0);
    } finally {
      await own.end();
    }
  });
  it("bounds saturated pool acquisition, removes the waiter and admits later clean work", async () => {
    const own = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 500 });
    const held = await own.connect();
    try {
      let invoked = false;
      await expect(
        withBoundedPolicyTransaction(own, async () => {
          invoked = true;
        }),
      ).rejects.toThrow("timeout");
      expect(invoked).toBe(false);
      expect(own.waitingCount).toBe(0);
    } finally {
      held.release();
    }
    try {
      expect(
        (await withBoundedPolicyTransaction(own, (client) => client.query("SELECT 1 AS value")))
          .rows[0]!.value,
      ).toBe(1);
    } finally {
      await own.end();
    }
  });
  it("lock_timeout aborts a real competing advisory lock without leaving the reader locked", async () => {
    const key = BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 13)}`).toString();
    const held = await pool.connect();
    try {
      await held.query("BEGIN");
      await held.query("SELECT pg_advisory_xact_lock($1::bigint)", [key]);
      await expect(
        withBoundedPolicyTransaction(pool, (client) =>
          client.query("SELECT pg_advisory_xact_lock($1::bigint)", [key]),
        ),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await held.query("ROLLBACK");
      held.release();
    }
    await expect(
      withBoundedPolicyTransaction(pool, (client) =>
        client.query("SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired", [key]),
      ),
    ).resolves.toMatchObject({ rows: [{ acquired: true }] });
  });
  it("a tighter deadline destroys the active backend and a new checkout cannot use the expired port", async () => {
    const own = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 500 });
    let oldPid: number | undefined;
    try {
      await expect(
        withBoundedPolicyTransaction(own, async (client) => {
          oldPid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
          tightenPolicyTransaction(client, 50, performance.now());
          await client.query("SELECT pg_sleep(5)");
        }),
      ).rejects.toMatchObject({ code: "deadline_exceeded" });
      const next = (await own.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      expect(next).not.toBe(oldPid);
      expect(own.waitingCount).toBe(0);
    } finally {
      await own.end();
    }
  });
  it("a caught or unawaited native SQL failure cannot commit a normal callback return", async () => {
    await expect(
      withBoundedPolicyTransaction(pool, async (client) => {
        await client.query("SELECT 1/0").catch(() => undefined);
        return "must rollback";
      }),
    ).rejects.toMatchObject({ code: "22012" });
    await expect(
      withBoundedPolicyTransaction(pool, async (client) => {
        void client.query("SELECT 1/0");
        return "must drain";
      }),
    ).rejects.toMatchObject({ code: "22012" });
    expect(
      (await withBoundedPolicyTransaction(pool, (client) => client.query("SELECT 1 AS value")))
        .rows[0]!.value,
    ).toBe(1);
  });
});
