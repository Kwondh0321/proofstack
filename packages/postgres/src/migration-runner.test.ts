import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  assertMigrationsCurrent,
  inspectMigrations,
  MigrationIntegrityError,
  MigrationRequiredError,
  migrateDatabase,
} from "./migration-runner.js";
import type { Migration } from "./migrations.js";

interface AppliedMigration {
  readonly checksum: string;
  readonly id: string;
}

class FakeClient {
  readonly queries: Array<{ readonly text: string; readonly values?: readonly unknown[] }> = [];
  readonly releaseArguments: Array<boolean | undefined> = [];
  readonly applied: AppliedMigration[];
  ledgerExists: boolean;
  failOn?: string;
  failRollback = false;

  constructor(options: { readonly applied?: AppliedMigration[]; readonly ledgerExists?: boolean }) {
    this.applied = [...(options.applied ?? [])];
    this.ledgerExists = options.ledgerExists ?? true;
  }

  async query(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, ...(values ? { values } : {}) });
    if (this.failOn && text.includes(this.failOn)) throw new Error(`failed: ${this.failOn}`);
    if (text === "ROLLBACK" && this.failRollback) throw new Error("rollback failed");
    if (text.includes("CREATE TABLE IF NOT EXISTS")) this.ledgerExists = true;
    if (text.includes("to_regclass")) {
      return { rows: [{ ledger: this.ledgerExists ? "proofstack_schema_migrations" : null }] };
    }
    if (text.startsWith("SELECT id, checksum")) return { rows: [...this.applied] };
    if (text.startsWith("INSERT INTO public.proofstack_schema_migrations")) {
      this.applied.push({ checksum: String(values?.[1]), id: String(values?.[0]) });
    }
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

function migration(sequence: number, name: string, sql = `SELECT ${sequence};`): Migration {
  const prefix = sequence.toString().padStart(4, "0");
  return {
    checksum: String(sequence).repeat(64),
    filename: `${prefix}_${name}.sql`,
    id: `${prefix}_${name}`,
    sequence,
    sql,
  };
}

describe("migration inspection", () => {
  it("reports every migration pending when the ledger is absent", async () => {
    const client = new FakeClient({ ledgerExists: false });
    const status = await inspectMigrations(poolWith(client), [migration(1, "first")]);

    expect(status).toEqual({
      appliedIds: [],
      ledgerExists: false,
      pendingIds: ["0001_first"],
    });
    expect(client.releaseArguments).toEqual([undefined]);
  });

  it("loads the bundled migration directory by default", async () => {
    const status = await inspectMigrations(poolWith(new FakeClient({})));

    expect(status).toEqual({
      appliedIds: [],
      ledgerExists: true,
      pendingIds: ["0001_evidence_store", "0002_outbox_delivery", "0003_leased_consumer_receipts"],
    });
  });

  it("accepts an exact migration prefix and reports the remainder", async () => {
    const first = migration(1, "first");
    const second = migration(2, "second");
    const client = new FakeClient({ applied: [first] });

    await expect(inspectMigrations(poolWith(client), [first, second])).resolves.toEqual({
      appliedIds: [first.id],
      ledgerExists: true,
      pendingIds: [second.id],
    });
  });

  it("rejects unknown, altered, and non-prefix migration histories", async () => {
    const first = migration(1, "first");
    const second = migration(2, "second");

    await expect(
      inspectMigrations(
        poolWith(new FakeClient({ applied: [{ checksum: "x".repeat(64), id: "0009_future" }] })),
        [first],
      ),
    ).rejects.toThrow("not known");
    await expect(
      inspectMigrations(
        poolWith(new FakeClient({ applied: [{ checksum: "f".repeat(64), id: first.id }] })),
        [first],
      ),
    ).rejects.toThrow("checksum mismatch");
    await expect(
      inspectMigrations(poolWith(new FakeClient({ applied: [second] })), [first, second]),
    ).rejects.toThrow("missing earlier migration");
  });

  it("requires a present, fully current ledger", async () => {
    const first = migration(1, "first");

    await expect(
      assertMigrationsCurrent(poolWith(new FakeClient({ ledgerExists: false })), [first]),
    ).rejects.toBeInstanceOf(MigrationRequiredError);
    await expect(
      assertMigrationsCurrent(poolWith(new FakeClient({ applied: [first] })), [first]),
    ).resolves.toBeUndefined();
  });

  it("distinguishes a missing empty ledger from pending migrations", async () => {
    await expect(
      assertMigrationsCurrent(poolWith(new FakeClient({ ledgerExists: false })), []),
    ).rejects.toThrow("migration ledger is missing");
  });
});

describe("migrateDatabase", () => {
  it("serializes migration work and atomically records each pending file", async () => {
    const first = migration(1, "first");
    const second = migration(2, "second");
    const client = new FakeClient({ applied: [first] });

    const result = await migrateDatabase(poolWith(client), [first, second]);

    expect(result).toEqual({
      appliedIds: [first.id, second.id],
      ledgerExists: true,
      newlyAppliedIds: [second.id],
      pendingIds: [],
    });
    expect(client.queries.map(({ text }) => text.trim())).toEqual(
      expect.arrayContaining([
        "SELECT pg_advisory_lock($1, $2)",
        "BEGIN",
        second.sql,
        "COMMIT",
        "SELECT pg_advisory_unlock($1, $2)",
      ]),
    );
    expect(client.releaseArguments).toEqual([undefined]);
  });

  it("rolls back a failed migration and still releases its advisory lock", async () => {
    const failing = migration(1, "failing", "CREATE BROKEN TABLE");
    const client = new FakeClient({});
    client.failOn = failing.sql;

    await expect(migrateDatabase(poolWith(client), [failing])).rejects.toThrow("failed");

    expect(client.queries.map(({ text }) => text.trim())).toContain("ROLLBACK");
    expect(client.queries.map(({ text }) => text.trim())).toContain(
      "SELECT pg_advisory_unlock($1, $2)",
    );
    expect(client.releaseArguments).toEqual([undefined]);
  });

  it("destroys a connection whose rollback fails", async () => {
    const failing = migration(1, "failing", "CREATE BROKEN TABLE");
    const client = new FakeClient({});
    client.failOn = failing.sql;
    client.failRollback = true;

    await expect(migrateDatabase(poolWith(client), [failing])).rejects.toThrow("failed");

    expect(client.releaseArguments).toEqual([true]);
    expect(client.queries.map(({ text }) => text.trim())).not.toContain(
      "SELECT pg_advisory_unlock($1, $2)",
    );
  });

  it("releases a connection when acquiring the advisory lock fails", async () => {
    const client = new FakeClient({});
    client.failOn = "pg_advisory_lock";

    await expect(migrateDatabase(poolWith(client), [])).rejects.toBeInstanceOf(Error);
    expect(client.releaseArguments).toEqual([undefined]);
  });

  it("destroys a connection when releasing the advisory lock fails", async () => {
    const client = new FakeClient({});
    client.failOn = "pg_advisory_unlock";

    await expect(migrateDatabase(poolWith(client), [])).rejects.toThrow("pg_advisory_unlock");
    expect(client.releaseArguments).toEqual([true]);
  });

  it("rejects a corrupted ledger before executing pending SQL", async () => {
    const first = migration(1, "first");
    const client = new FakeClient({
      applied: [{ checksum: "a".repeat(64), id: "0009_unknown" }],
    });

    await expect(migrateDatabase(poolWith(client), [first])).rejects.toBeInstanceOf(
      MigrationIntegrityError,
    );
    expect(client.queries.map(({ text }) => text.trim())).not.toContain("BEGIN");
  });
});
