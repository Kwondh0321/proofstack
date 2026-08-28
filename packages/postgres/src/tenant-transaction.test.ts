import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresTransactionCleanupError, withTenantTransaction } from "./tenant-transaction.js";

class FakeClient {
  readonly queries: Array<{ readonly text: string; readonly values?: readonly unknown[] }> = [];
  readonly releaseArguments: Array<boolean | undefined> = [];
  failOn?: string;

  async query(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, ...(values ? { values } : {}) });
    if (this.failOn === text) throw new Error(`failed: ${text}`);
    return { rows: [] };
  }

  release(argument?: boolean): void {
    this.releaseArguments.push(argument);
  }
}

function poolWith(client: FakeClient): Pick<Pool, "connect"> {
  return {
    connect: async () => client,
  } as unknown as Pick<Pool, "connect">;
}

describe("withTenantTransaction", () => {
  it("sets transaction-local tenant context on one checked-out client", async () => {
    const client = new FakeClient();

    const result = await withTenantTransaction(poolWith(client), "ten_local", async (scoped) => {
      expect(scoped).toBe(client);
      await scoped.query("SELECT 1");
      return "done";
    });

    expect(result).toBe("done");
    expect(client.queries).toEqual([
      { text: "BEGIN" },
      {
        text: "SELECT set_config('proofstack.tenant_id', $1, true)",
        values: ["ten_local"],
      },
      { text: "SELECT 1" },
      { text: "COMMIT" },
    ]);
    expect(client.releaseArguments).toEqual([undefined]);
  });

  it("rolls back and preserves an operation error", async () => {
    const client = new FakeClient();
    const failure = new Error("operation failed");

    await expect(
      withTenantTransaction(poolWith(client), "ten_local", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(client.queries.map(({ text }) => text)).toEqual([
      "BEGIN",
      "SELECT set_config('proofstack.tenant_id', $1, true)",
      "ROLLBACK",
    ]);
    expect(client.releaseArguments).toEqual([undefined]);
  });

  it("rolls back when tenant context cannot be established", async () => {
    const client = new FakeClient();
    client.failOn = "SELECT set_config('proofstack.tenant_id', $1, true)";

    await expect(
      withTenantTransaction(poolWith(client), "ten_local", async () => "unreachable"),
    ).rejects.toThrow("set_config");
    expect(client.queries.map(({ text }) => text)).toContain("ROLLBACK");
    expect(client.releaseArguments).toEqual([undefined]);
  });

  it("destroys a connection when beginning the transaction fails", async () => {
    const client = new FakeClient();
    client.failOn = "BEGIN";

    await expect(
      withTenantTransaction(poolWith(client), "ten_local", async () => "unreachable"),
    ).rejects.toThrow("BEGIN");
    expect(client.queries.map(({ text }) => text)).not.toContain("ROLLBACK");
    expect(client.releaseArguments).toEqual([true]);
  });

  it("destroys a connection and reports a rollback failure", async () => {
    const client = new FakeClient();
    const operationFailure = new Error("operation failed");
    client.failOn = "ROLLBACK";

    const promise = withTenantTransaction(poolWith(client), "ten_local", async () => {
      throw operationFailure;
    });

    await expect(promise).rejects.toMatchObject({
      cause: operationFailure,
      name: "PostgresTransactionCleanupError",
      rollbackError: expect.objectContaining({ message: "failed: ROLLBACK" }),
    });
    await expect(promise).rejects.toBeInstanceOf(PostgresTransactionCleanupError);
    expect(client.releaseArguments).toEqual([true]);
  });

  it("rolls back an ambiguous commit failure", async () => {
    const client = new FakeClient();
    client.failOn = "COMMIT";

    await expect(
      withTenantTransaction(poolWith(client), "ten_local", async () => "result"),
    ).rejects.toThrow("COMMIT");
    expect(client.queries.map(({ text }) => text)).toContain("ROLLBACK");
    expect(client.releaseArguments).toEqual([undefined]);
  });
});
