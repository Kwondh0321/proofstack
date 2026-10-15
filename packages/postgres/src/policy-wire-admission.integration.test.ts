import { createPolicyPostgresPool } from "./database.js";
import { withBoundedPolicyTransaction } from "./bounded-policy-transaction.js";
import { POLICY_WIRE_FRAME_BYTES, POLICY_WIRE_TRANSACTION_ROWS } from "./policy-wire-admission.js";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env["PROOFSTACK_TEST_DATABASE_URL"];
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
function fixture() {
  const idleErrors: Error[] = [];
  const pool = createPolicyPostgresPool({
    connectionString: databaseUrl as string,
    maxConnections: 1,
    onIdleError: (error) => idleErrors.push(error),
  });
  return { pool, idleErrors };
}
describe("real native policy driver protocol bounds", () => {
  it("keeps the original decoder on normal replies and reuses a healthy backend", async () => {
    const { pool, idleErrors } = fixture();
    try {
      expect((await pool.query("SELECT current_database() AS name")).rows[0]!.name).toBe(
        "proofstack_test",
      );
      const first = await withBoundedPolicyTransaction(pool, (client) =>
        client.query("SELECT pg_backend_pid() AS pid, repeat('x',32768) AS value"),
      );
      const next = await withBoundedPolicyTransaction(pool, (client) =>
        client.query("SELECT pg_backend_pid() AS pid,42 AS value"),
      );
      expect(first.rows[0]!.value).toHaveLength(32768);
      expect(next.rows[0]!.pid).toBe(first.rows[0]!.pid);
      expect(next.rows[0]!.value).toBe(42);
      expect(pool.waitingCount).toBe(0);
      expect(idleErrors).toEqual([]);
    } finally {
      await pool.end();
    }
  });
  it.each([
    { kind: "frame", requireWire: false },
    { kind: "rows", requireWire: false },
    { kind: "frame", requireWire: true },
    { kind: "rows", requireWire: true },
  ])(
    "destroys an excess $kind response (required wire: $requireWire) before accepting decoded results, then admits a fresh backend",
    async ({ kind, requireWire }) => {
      const { pool } = fixture();
      try {
        const oldPid = (await pool.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        await expect(
          withBoundedPolicyTransaction(
            pool,
            async (client) => {
              if (kind === "frame")
                return client.query("SELECT repeat('x',$1::integer) AS value", [
                  POLICY_WIRE_FRAME_BYTES,
                ]);
              return client.query("SELECT generate_series(1,$1::integer) AS value", [
                POLICY_WIRE_TRANSACTION_ROWS + 1,
              ]);
            },
            { requireWire },
          ),
        ).rejects.toMatchObject({ code: "wire_admission" });
        const result = await withBoundedPolicyTransaction(pool, (client) =>
          client.query("SELECT pg_backend_pid() AS pid,1 AS value"),
        );
        expect(result.rows[0]!.pid).not.toBe(oldPid);
        expect(result.rows[0]!.value).toBe(1);
        expect(pool.waitingCount).toBe(0);
      } finally {
        await pool.end();
      }
    },
  );
  it("server cancellation still drains rollback and reuses the bounded decoder", async () => {
    const { pool } = fixture();
    try {
      const oldPid = (await pool.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await expect(
        withBoundedPolicyTransaction(pool, (client) => client.query("SELECT pg_sleep(5)")),
      ).rejects.toMatchObject({ code: "57014" });
      const result = await withBoundedPolicyTransaction(pool, (client) =>
        client.query("SELECT pg_backend_pid() AS pid"),
      );
      expect(result.rows[0]!.pid).toBe(oldPid);
      expect(pool.waitingCount).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
