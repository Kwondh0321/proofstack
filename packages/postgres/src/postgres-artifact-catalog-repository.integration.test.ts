import type { ArtifactCatalogEntry } from "@proofstack/artifacts";
import { artifactCatalogRepositoryConformanceCases } from "@proofstack/artifacts/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresArtifactCatalogRepository } from "./postgres-artifact-catalog-repository.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const runtimeRole = "proofstack_test_artifact_repository";
const runtimePassword = "proofstack_test_artifact_repository";
const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
const runtimeDatabaseUrl = new URL(databaseUrl);
runtimeDatabaseUrl.username = runtimeRole;
runtimeDatabaseUrl.password = runtimePassword;
const runtimeConnectionString = runtimeDatabaseUrl.toString();
const runtimePool = new Pool({ connectionString: runtimeConnectionString, max: 4 });

beforeAll(async () => {
  await migrateDatabase(adminPool);
  await adminPool.query(`
    DO $$
    BEGIN
      CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}';
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$
  `);
  await adminPool.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
  await adminPool.query(
    `GRANT SELECT, INSERT, UPDATE ON public.proofstack_artifact_catalog TO ${runtimeRole}`,
  );
  await adminPool.query(
    `GRANT SELECT, INSERT ON public.proofstack_artifact_tombstones TO ${runtimeRole}`,
  );
  await adminPool.query(
    `GRANT SELECT, INSERT ON public.proofstack_artifact_purge_receipts TO ${runtimeRole}`,
  );
  await adminPool.query(
    `GRANT SELECT ON public.proofstack_interaction_fixture_artifact_ownerships, public.proofstack_interaction_fixture_content_revocations TO ${runtimeRole}`,
  );
});

afterAll(async () => {
  await Promise.all([runtimePool.end(), adminPool.end()]);
});

describe("PostgresArtifactCatalogRepository contract", () => {
  for (const testCase of artifactCatalogRepositoryConformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(() => ({
        repository: new PostgresArtifactCatalogRepository(runtimePool),
      }));
    });
  }

  it("retains protected catalog metadata across connection pool restarts", async () => {
    const entry: ArtifactCatalogEntry = {
      createdByPrincipalId: "usr_artifact_restart",
      encryption: {
        contentNonce: Buffer.alloc(12, 1).toString("base64url"),
        version: "a256gcm-v1",
        wrappedDataKey: {
          algorithm: "A256GCM",
          ciphertext: Buffer.alloc(32, 2).toString("base64url"),
          keyId: "key_artifact_restart",
          nonce: Buffer.alloc(12, 3).toString("base64url"),
          tag: Buffer.alloc(16, 4).toString("base64url"),
        },
      },
      metadata: {
        contentReference: {
          artifactId: "art_postgres_restart",
          classification: "restricted",
          mediaType: "application/json",
          sha256: "5".repeat(64),
          sizeBytes: 18,
        },
        createdAt: "2026-08-28T03:00:00.000Z",
        redaction: { status: "not_required" },
        retention: { mode: "retain" },
        schemaVersion: "0.1",
        scope: {
          environmentId: "env_artifact_restart",
          projectId: "prj_artifact_restart",
          tenantId: "ten_artifact_restart",
        },
        state: "reserved",
      },
      objectKey: "objects/v1/re/restart-contract",
    };

    const firstPool = new Pool({ connectionString: runtimeConnectionString, max: 1 });
    await new PostgresArtifactCatalogRepository(firstPool).reserve(entry);
    await firstPool.end();

    const restartedPool = new Pool({ connectionString: runtimeConnectionString, max: 1 });
    try {
      await expect(
        new PostgresArtifactCatalogRepository(restartedPool).find(
          entry.metadata.scope,
          entry.metadata.contentReference.artifactId,
        ),
      ).resolves.toEqual(entry);
    } finally {
      await restartedPool.end();
    }
  });
});
