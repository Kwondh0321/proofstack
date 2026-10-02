import { createHash, randomUUID } from "node:crypto";
import {
  ArtifactCipher,
  ArtifactProtectionError,
  LocalArtifactKeyring,
} from "@proofstack/artifacts";
import type { ArtifactMetadata } from "@proofstack/contracts";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { assertMigrationsCurrent, migrateDatabase } from "./migration-runner.js";
import { loadBundledMigrations } from "./migrations.js";
import { PostgresArtifactCatalogRepository } from "./postgres-artifact-catalog-repository.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl)
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
const repairId = "0051_artifact_timestamp_integrity";

async function isolatedDatabase(run: (pool: Pool) => Promise<void>): Promise<void> {
  const name = `proofstack_artifact_time_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const control = new Pool({ connectionString: databaseUrl, max: 1 });
  const url = new URL(databaseUrl as string);
  url.pathname = `/${name}`;
  let pool: Pool | undefined;
  let created = false;
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    pool = new Pool({ connectionString: url.toString(), max: 1 });
    await run(pool);
  } finally {
    await pool?.end();
    try {
      if (created) await control.query(`DROP DATABASE "${name}"`);
    } finally {
      await control.end();
    }
  }
}

async function fixture(expiresAt: string | undefined) {
  const plaintext = Buffer.from("legacy encrypted timestamp probe");
  const metadata: ArtifactMetadata = {
    schemaVersion: "0.1",
    state: "reserved",
    scope: { tenantId: "ten_time_upgrade", projectId: "prj_time", environmentId: "env_time" },
    contentReference: {
      artifactId: "art_time_upgrade",
      classification: "confidential",
      mediaType: "text/plain",
      sha256: createHash("sha256").update(plaintext).digest("hex"),
      sizeBytes: plaintext.byteLength,
    },
    createdAt: "2026-08-28T03:00:00.000Z",
    redaction: { status: "not_required" },
    retention: expiresAt ? { mode: "expire", expiresAt } : { mode: "retain" },
  };
  const cipher = new ArtifactCipher(
    new LocalArtifactKeyring({ activeKeyId: "key_time", keys: { key_time: Buffer.alloc(32, 9) } }),
  );
  const encryption = await cipher.createPlan(metadata);
  const encrypted = await cipher.encrypt(metadata, encryption, plaintext);
  const row = {
    tenant_id: metadata.scope.tenantId,
    project_id: metadata.scope.projectId,
    environment_id: metadata.scope.environmentId,
    artifact_id: metadata.contentReference.artifactId,
    schema_version: "0.1",
    state: "reserved",
    classification: "confidential",
    media_type: "text/plain",
    content_sha256: metadata.contentReference.sha256,
    content_size_bytes: plaintext.byteLength,
    redaction: metadata.redaction,
    retention_mode: metadata.retention.mode,
    expires_at: expiresAt ?? null,
    created_at: metadata.createdAt,
    created_by_principal_id: "wrk_time",
    object_key: "objects/time/upgrade",
    encryption_version: encryption.version,
    content_nonce: encryption.contentNonce,
    wrapped_key_algorithm: encryption.wrappedDataKey.algorithm,
    wrapped_key_id: encryption.wrappedDataKey.keyId,
    wrapped_key_ciphertext: encryption.wrappedDataKey.ciphertext,
    wrapped_key_nonce: encryption.wrappedDataKey.nonce,
    wrapped_key_tag: encryption.wrappedDataKey.tag,
  };
  return { cipher, encrypted, metadata, plaintext, row };
}

async function insertRaw(pool: Pool, row: unknown): Promise<void> {
  await pool.query(
    "INSERT INTO public.proofstack_artifact_catalog SELECT * FROM jsonb_populate_record(NULL::public.proofstack_artifact_catalog, $1::jsonb)",
    [JSON.stringify(row)],
  );
}

async function guardEnabled(pool: Pool): Promise<void> {
  expect(
    (
      await pool.query(
        "SELECT tgenabled FROM pg_trigger WHERE tgname = 'proofstack_artifact_catalog_mutation_guard'",
      )
    ).rows,
  ).toEqual([{ tgenabled: "O" }]);
}

describe("artifact timestamp integrity migration", () => {
  it.each([undefined, "2026-09-28T03:00:00.000Z"])(
    "preserves valid legacy ciphertext and history for expiry %s",
    async (expiresAt) => {
      await isolatedDatabase(async (pool) => {
        const migrations = await loadBundledMigrations();
        const index = migrations.findIndex((m) => m.id === repairId);
        expect(index).toBeGreaterThan(0);
        const repaired = migrations.slice(0, index + 1);
        await migrateDatabase(pool, migrations.slice(0, index));
        const h = await fixture(expiresAt);
        await insertRaw(pool, h.row);
        const before = (
          await pool.query("SELECT to_jsonb(a) AS record FROM public.proofstack_artifact_catalog a")
        ).rows;
        const ledger = (
          await pool.query(
            "SELECT id, checksum FROM public.proofstack_schema_migrations ORDER BY id",
          )
        ).rows;
        await expect(migrateDatabase(pool, repaired)).resolves.toMatchObject({
          newlyAppliedIds: [repairId],
        });
        await assertMigrationsCurrent(pool, repaired);
        expect(
          (
            await pool.query(
              "SELECT to_jsonb(a) - 'expires_at_lexical' - 'expires_at_order_key' AS record FROM public.proofstack_artifact_catalog a",
            )
          ).rows,
        ).toEqual(before);
        expect(
          (
            await pool.query(
              "SELECT id, checksum FROM public.proofstack_schema_migrations ORDER BY id",
            )
          ).rows.slice(0, -1),
        ).toEqual(ledger);
        await expect(migrateDatabase(pool, repaired)).resolves.toMatchObject({
          newlyAppliedIds: [],
        });
        await guardEnabled(pool);
        const stored = await new PostgresArtifactCatalogRepository(pool).find(
          h.metadata.scope,
          h.metadata.contentReference.artifactId,
        );
        if (!stored) throw new Error("Upgraded artifact is missing");
        expect(stored.metadata).toEqual(h.metadata);
        await expect(
          h.cipher.decrypt(stored.metadata, stored.encryption, h.encrypted.bytes),
        ).resolves.toEqual(Uint8Array.from(h.plaintext));
        const acl = await pool.query(`SELECT p.prosecdef, p.proconfig,
        EXISTS (SELECT FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute
        FROM pg_proc p WHERE p.oid = 'public.proofstack_guard_artifact_timestamp_integrity()'::regprocedure`);
        expect(acl.rows).toEqual([
          { prosecdef: false, proconfig: ["search_path=pg_catalog"], public_execute: false },
        ]);
      });
    },
  );

  it("does not guess unrecoverable historical AAD or rewrite its ciphertext", async () => {
    await isolatedDatabase(async (pool) => {
      const migrations = await loadBundledMigrations();
      const index = migrations.findIndex((m) => m.id === repairId);
      await migrateDatabase(pool, migrations.slice(0, index));
      const h = await fixture("2026-09-28T12:00:00+09:00");
      await insertRaw(pool, h.row);
      await migrateDatabase(pool, migrations.slice(0, index + 1));
      const stored = await new PostgresArtifactCatalogRepository(pool).find(
        h.metadata.scope,
        h.metadata.contentReference.artifactId,
      );
      if (!stored) throw new Error("Upgraded artifact is missing");
      expect(stored.metadata.retention).toEqual({
        mode: "expire",
        expiresAt: "2026-09-28T03:00:00.000Z",
      });
      expect(stored.encryption.wrappedDataKey.ciphertext).toBe(h.row.wrapped_key_ciphertext);
      await expect(
        h.cipher.decrypt(stored.metadata, stored.encryption, h.encrypted.bytes),
      ).rejects.toBeInstanceOf(ArtifactProtectionError);
    });
  });

  it("rolls back a failed backfill including its temporarily disabled lifecycle guard", async () => {
    await isolatedDatabase(async (pool) => {
      const migrations = await loadBundledMigrations();
      const index = migrations.findIndex((m) => m.id === repairId);
      const repair = migrations[index];
      if (!repair) throw new Error("Missing timestamp migration");
      const previous = migrations.slice(0, index);
      await migrateDatabase(pool, previous);
      const h = await fixture("2026-09-28T03:00:00.000Z");
      await insertRaw(pool, h.row);
      const before = (
        await pool.query("SELECT to_jsonb(a) AS record FROM public.proofstack_artifact_catalog a")
      ).rows;
      const sql = repair.sql.replace(
        "WHERE retention_mode = 'expire';",
        "WHERE retention_mode = 'expire'; SELECT 1 / 0;",
      );
      expect(sql).not.toBe(repair.sql);
      await expect(
        migrateDatabase(pool, [
          ...previous,
          { ...repair, sql, checksum: createHash("sha256").update(sql).digest("hex") },
        ]),
      ).rejects.toMatchObject({ code: "22012" });
      await assertMigrationsCurrent(pool, previous);
      await guardEnabled(pool);
      expect(
        (await pool.query("SELECT to_jsonb(a) AS record FROM public.proofstack_artifact_catalog a"))
          .rows,
      ).toEqual(before);
      await expect(
        pool.query("UPDATE public.proofstack_artifact_catalog SET media_type = 'application/json'"),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(migrateDatabase(pool, migrations.slice(0, index + 1))).resolves.toMatchObject({
        newlyAppliedIds: [repairId],
      });
    });
  });

  it("enforces exact projections and immutable lexical identity on direct SQL writes", async () => {
    await isolatedDatabase(async (pool) => {
      await migrateDatabase(pool);
      const h = await fixture("2026-09-28T03:00:00.000Z");
      for (const fields of [
        { expires_at_lexical: null },
        { expires_at_lexical: "2026-09-29T03:00:00Z" },
        { expires_at_lexical: "2026-09-28T03:00:00Z", expires_at_order_key: "1" },
        { expires_at_lexical: "2026-09-28T03:00:00.0000000000000000000000000000001Z" },
        { expires_at_lexical: "0000-09-28T03:00:00Z" },
        { expires_at_lexical: "2026-09-28T03:00:00+16:00" },
        { retention_mode: "retain", expires_at: null, expires_at_lexical: "2026-09-28T03:00:00Z" },
      ])
        await expect(insertRaw(pool, { ...h.row, ...fields })).rejects.toMatchObject({
          code: "23514",
        });
      await insertRaw(pool, { ...h.row, expires_at_lexical: h.row.expires_at });
      for (const assignment of [
        "expires_at_lexical = '2026-09-28T03:00:00Z'",
        "expires_at_order_key = expires_at_order_key + 1",
      ]) {
        await expect(
          pool.query(
            `UPDATE public.proofstack_artifact_catalog SET state = 'available', available_at = '2026-08-28T03:01:00Z', object_receipt_sha256 = '${"a".repeat(64)}', object_receipt_size_bytes = 44, ${assignment}`,
          ),
        ).rejects.toMatchObject({ code: "55000" });
      }
      expect(
        (await pool.query("SELECT state FROM public.proofstack_artifact_catalog")).rows,
      ).toEqual([{ state: "reserved" }]);
    });
  });
});
