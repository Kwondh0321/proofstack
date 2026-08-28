import { ProjectionCursorRegressionError } from "@proofstack/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresProjectionCursorRepository } from "./postgres-projection-cursor-repository.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const consumerRole = "proofstack_test_projection_worker";
const consumerPassword = "proofstack_test_projection_worker";
const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
const consumerDatabaseUrl = new URL(databaseUrl);
consumerDatabaseUrl.username = consumerRole;
consumerDatabaseUrl.password = consumerPassword;
const consumerPool = new Pool({ connectionString: consumerDatabaseUrl.toString(), max: 4 });
const runKey = Date.now().toString();
const tenantId = `ten_cursor_${runKey}`;
const otherTenantId = `ten_cursor_other_${runKey}`;

beforeAll(async () => {
  await migrateDatabase(adminPool);
  await adminPool.query(`
    DO $$
    BEGIN
      CREATE ROLE ${consumerRole} LOGIN PASSWORD '${consumerPassword}';
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$
  `);
  await adminPool.query(`ALTER ROLE ${consumerRole} LOGIN PASSWORD '${consumerPassword}'`);
  await adminPool.query(`GRANT USAGE ON SCHEMA public TO ${consumerRole}`);
  await adminPool.query(
    `GRANT SELECT, INSERT, UPDATE ON public.proofstack_projection_cursors TO ${consumerRole}`,
  );
});

afterAll(async () => {
  await Promise.all([consumerPool.end(), adminPool.end()]);
});

describe("PostgresProjectionCursorRepository contract", () => {
  it("isolates generations and rejects backward movement", async () => {
    const repository = new PostgresProjectionCursorRepository(consumerPool);
    const key = { consumerName: "trace.projector", generation: 1 };

    await expect(repository.get(tenantId, key)).resolves.toBeNull();
    const created = await repository.advance(tenantId, { ...key, lastOutboxId: "0" });
    expect(created).toMatchObject({
      advanced: true,
      cursor: { ...key, lastOutboxId: "0", tenantId },
    });

    const unchanged = await repository.advance(tenantId, { ...key, lastOutboxId: "0" });
    expect(unchanged).toEqual({ advanced: false, cursor: created.cursor });

    await expect(
      repository.advance(tenantId, { ...key, lastOutboxId: "10" }),
    ).resolves.toMatchObject({ advanced: true, cursor: { lastOutboxId: "10" } });
    await expect(
      repository.advance(tenantId, { ...key, lastOutboxId: "9" }),
    ).rejects.toBeInstanceOf(ProjectionCursorRegressionError);
    await expect(repository.get(tenantId, key)).resolves.toMatchObject({ lastOutboxId: "10" });
    await expect(repository.get(otherTenantId, key)).resolves.toBeNull();

    const rebuildKey = { consumerName: "trace.projector", generation: 2 };
    await expect(
      repository.advance(tenantId, { ...rebuildKey, lastOutboxId: "0" }),
    ).resolves.toMatchObject({
      advanced: true,
      cursor: { generation: 2, lastOutboxId: "0" },
    });
    await expect(repository.get(tenantId, key)).resolves.toMatchObject({
      generation: 1,
      lastOutboxId: "10",
    });
  });

  it("resolves concurrent initial creation as one advance and one idempotent result", async () => {
    const first = new PostgresProjectionCursorRepository(consumerPool);
    const second = new PostgresProjectionCursorRepository(consumerPool);
    const options = {
      consumerName: `evaluation.projector_${runKey}`,
      generation: 1,
      lastOutboxId: "40",
    };

    const results = await Promise.all([
      first.advance(tenantId, options),
      second.advance(tenantId, options),
    ]);
    expect(results.map(({ advanced }) => advanced).sort()).toEqual([false, true]);
    expect(results.every(({ cursor }) => cursor.lastOutboxId === "40")).toBe(true);
  });

  it("does not grant the projection worker access to authoritative evidence", async () => {
    await expect(
      consumerPool.query("SELECT count(*) FROM public.proofstack_evidence_events"),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
