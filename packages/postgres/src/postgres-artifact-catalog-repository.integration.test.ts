import { createHash, randomUUID } from "node:crypto";
import {
  ARTIFACT_OBJECT_FORMAT_OVERHEAD_BYTES,
  type ArtifactCatalogEntry,
  ArtifactCipher,
  ArtifactConflictError,
  InvalidArtifactLifecycleInputError,
  LocalArtifactKeyring,
  ReserveArtifact,
  readPolicyEvaluationArtifact,
} from "@proofstack/artifacts";
import { artifactCatalogRepositoryConformanceCases } from "@proofstack/artifacts/testing";
import { type PrincipalContext, policyEvaluationTimestampOrderKey } from "@proofstack/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import {
  PostgresArtifactCatalogRepository,
  PostgresArtifactDataIntegrityError,
  readPostgresArtifactCatalogOnClient,
} from "./postgres-artifact-catalog-repository.js";

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

async function reserveTimestampProbe(expiresAt: string) {
  const suffix = randomUUID().replaceAll("-", "");
  const scope = {
    tenantId: `ten_time_${suffix}`,
    projectId: "prj_time",
    environmentId: "env_time",
  };
  const artifactId = "art_time";
  const plaintext = Buffer.from('{"timestamp":"integrity"}', "utf8");
  const principal: PrincipalContext = {
    authentication: {
      authenticatedAt: "2026-08-28T02:00:00.000Z",
      credentialId: "key_time",
      method: "api_key",
    },
    capabilities: ["artifact:write", "artifact:read"],
    principalId: "wrk_time",
    principalType: "workload",
    requestId: "req_time",
    resourceScope: {
      mode: "restricted",
      projects: [{ projectId: scope.projectId, environmentIds: [scope.environmentId] }],
    },
    roles: ["ingest"],
    tenantId: scope.tenantId,
  };
  const catalog = new PostgresArtifactCatalogRepository(runtimePool);
  const cipher = new ArtifactCipher(
    new LocalArtifactKeyring({ activeKeyId: "key_time", keys: { key_time: Buffer.alloc(32, 7) } }),
  );
  const reserve = new ReserveArtifact({
    catalog,
    clock: { now: () => new Date("2026-08-28T03:00:00.000Z") },
    encryption: cipher,
    identities: {
      generateLifecycleId: () => "lifecycle_unused",
      generateObjectKey: () => `objects/${suffix}/${artifactId}`,
    },
  });
  const command = {
    principal,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    request: {
      artifactId,
      classification: "confidential" as const,
      mediaType: "application/json",
      redaction: { status: "not_required" as const },
      retention: { mode: "expire" as const, expiresAt },
      sha256: createHash("sha256").update(plaintext).digest("hex"),
      sizeBytes: plaintext.byteLength,
    },
  };
  await reserve.execute(command);
  const entry = await catalog.find(scope, artifactId);
  if (!entry) throw new Error("Reserved timestamp probe is missing");
  return { artifactId, catalog, cipher, command, entry, plaintext, principal, reserve, scope };
}

describe("transaction-local artifact catalog reads", () => {
  it("sees its connection's uncommitted native receipts and preserves the caller's savepoint", async () => {
    const expiresAt = "2026-09-28T12:00:00.000000000000000000000000000001+09:00";
    const h = await reserveTimestampProbe(expiresAt);
    const client = await runtimePool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT set_config('proofstack.tenant_id', $1, true),
          set_config('proofstack.project_id', $2, true),
          set_config('proofstack.environment_id', $3, true)`,
        [h.scope.tenantId, h.scope.projectId, h.scope.environmentId],
      );
      await client.query("SAVEPOINT artifact_read_probe");
      await client.query(
        `UPDATE public.proofstack_artifact_catalog
         SET state = 'available', available_at = $5::timestamptz,
           object_receipt_sha256 = $6, object_receipt_size_bytes = $7
         WHERE tenant_id = $1 AND project_id = $2 AND environment_id = $3 AND artifact_id = $4`,
        [
          h.scope.tenantId,
          h.scope.projectId,
          h.scope.environmentId,
          h.artifactId,
          "2026-08-28T03:01:00.000001Z",
          "a".repeat(64),
          h.plaintext.byteLength + ARTIFACT_OBJECT_FORMAT_OVERHEAD_BYTES,
        ],
      );
      const observed = await readPostgresArtifactCatalogOnClient(client, h.scope, h.artifactId);
      expect(observed?.metadata).toMatchObject({
        state: "available",
        availableAt: "2026-08-28T03:01:00.000001Z",
        retention: { mode: "expire", expiresAt },
      });
      expect((await h.catalog.find(h.scope, h.artifactId))?.metadata.state).toBe("reserved");
      expect(
        await readPostgresArtifactCatalogOnClient(
          client,
          { ...h.scope, environmentId: "env_other" },
          h.artifactId,
        ),
      ).toBeNull();
      if (!observed) throw new Error("Expected the uncommitted catalog entry");
      const mutable = observed as unknown as { metadata: { retention: { expiresAt: string } } };
      mutable.metadata.retention.expiresAt = "2026-09-29T03:00:00Z";
      expect(
        (await readPostgresArtifactCatalogOnClient(client, h.scope, h.artifactId))?.metadata
          .retention,
      ).toEqual({ mode: "expire", expiresAt });
      await client.query("ROLLBACK TO SAVEPOINT artifact_read_probe");
      expect(await readPostgresArtifactCatalogOnClient(client, h.scope, h.artifactId)).toEqual(
        h.entry,
      );
      expect(
        (
          await client.query<{ readonly contexts: string[] }>(
            `SELECT ARRAY[current_setting('proofstack.tenant_id'),
              current_setting('proofstack.project_id'),
              current_setting('proofstack.environment_id')] AS contexts`,
          )
        ).rows,
      ).toEqual([{ contexts: [h.scope.tenantId, h.scope.projectId, h.scope.environmentId] }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await h.catalog.find(h.scope, h.artifactId)).toEqual(h.entry);
  });

  it("retains normalized expiry integrity checks on the supplied client", async () => {
    const h = await reserveTimestampProbe("2026-09-28T03:00:00.000001Z");
    const client = await adminPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query(
        `UPDATE public.proofstack_artifact_catalog
         SET expires_at_order_key = expires_at_order_key + 1
         WHERE tenant_id = $1 AND artifact_id = $2`,
        [h.scope.tenantId, h.artifactId],
      );
      await expect(
        readPostgresArtifactCatalogOnClient(client, h.scope, h.artifactId),
      ).rejects.toBeInstanceOf(PostgresArtifactDataIntegrityError);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await h.catalog.find(h.scope, h.artifactId)).toEqual(h.entry);
  });
});

describe("artifact timestamp integrity", () => {
  it.each([
    "2026-09-28T03:00:00.000Z",
    "2026-09-28T03:00:00Z",
    "2026-09-28T12:00:00.000+09:00",
    "2026-09-28T03:00:00.000001Z",
    "2026-09-28T03:00:00.000000000000000000000000000001Z",
    "2026-09-28T03:00:00.999999999999999999999999999999Z",
  ])("preserves encryption context through PostgreSQL for expiry %s", async (expiresAt) => {
    const h = await reserveTimestampProbe(expiresAt);
    expect(h.entry.metadata.retention).toEqual({ mode: "expire", expiresAt });
    const encrypted = await h.cipher.encrypt(h.entry.metadata, h.entry.encryption, h.plaintext);
    const restartedPool = new Pool({ connectionString: runtimeConnectionString, max: 1 });
    try {
      const reread = await new PostgresArtifactCatalogRepository(restartedPool).find(
        h.scope,
        h.artifactId,
      );
      if (!reread) throw new Error("Persisted timestamp probe is missing");
      await expect(
        h.cipher.decrypt(reread.metadata, reread.encryption, encrypted.bytes),
      ).resolves.toEqual(Uint8Array.from(h.plaintext));
    } finally {
      await restartedPool.end();
    }
  });

  it("does not truncate a retained submillisecond expiry", async () => {
    const expiresAt = "2026-09-28T03:00:00.000001Z";
    const h = await reserveTimestampProbe(expiresAt);
    if (h.entry.metadata.retention.mode !== "expire") throw new Error("Missing retention");
    expect(policyEvaluationTimestampOrderKey(h.entry.metadata.retention.expiresAt)).toBe(
      policyEvaluationTimestampOrderKey(expiresAt),
    );
  });

  it("does not admit an activation after the exact policy evaluation cut", async () => {
    const h = await reserveTimestampProbe("2026-09-28T03:00:00.000Z");
    const encrypted = await h.cipher.encrypt(h.entry.metadata, h.entry.encryption, h.plaintext);
    await h.catalog.activate(
      h.scope,
      h.artifactId,
      encrypted.receipt,
      "2026-08-28T03:01:00.000001Z",
    );
    const read = await readPolicyEvaluationArtifact(
      {
        scope: h.scope,
        principal: h.principal,
        reference: h.entry.metadata.contentReference,
        evaluationTime: "2026-08-28T03:01:00.000Z",
        maxReadBytes: encrypted.bytes.byteLength,
      },
      {
        catalog: h.catalog,
        encryption: h.cipher,
        objects: { get: async () => encrypted.bytes },
        clock: { now: () => new Date("2026-08-28T03:02:00.000Z") },
      },
    );
    expect(read.observation).toEqual({ status: "unavailable", reason: "not_yet_available" });
    expect(read.usage.objectReads).toBe(0);
  });

  it("keeps the first authenticated spelling on an equal-instant retry and rejects distinct fractions", async () => {
    const h = await reserveTimestampProbe("2026-09-28T03:00:00.000001Z");
    const retry = (expiresAt: string) =>
      h.reserve.execute({
        ...h.command,
        request: { ...h.command.request, retention: { mode: "expire", expiresAt } },
      });
    await expect(retry("2026-09-28T12:00:00.0000010+09:00")).resolves.toEqual({
      created: false,
      metadata: h.entry.metadata,
    });
    await expect(retry("2026-09-28T03:00:00.000002Z")).rejects.toBeInstanceOf(
      ArtifactConflictError,
    );
    await expect(
      retry("2026-09-28T03:00:00.000001000000000000000000000001Z"),
    ).rejects.toBeInstanceOf(ArtifactConflictError);
    expect(await h.catalog.find(h.scope, h.artifactId)).toEqual(h.entry);
  });

  it("accepts an expiry exactly one bounded fractional unit after creation without early maintenance", async () => {
    const expiresAt = "2026-08-28T03:00:00.000000000000000000000000000001Z";
    const h = await reserveTimestampProbe(expiresAt);
    const encrypted = await h.cipher.encrypt(h.entry.metadata, h.entry.encryption, h.plaintext);
    await h.catalog.activate(h.scope, h.artifactId, encrypted.receipt, h.entry.metadata.createdAt);
    expect(await h.catalog.listExpired(h.scope, h.entry.metadata.createdAt, 10)).toEqual([]);
    expect(
      (await h.catalog.listExpired(h.scope, expiresAt, 10)).map(
        (e) => e.metadata.contentReference.artifactId,
      ),
    ).toEqual([h.artifactId]);
  });

  it("orders expiry maintenance by all 30 fractional digits before artifact IDs", async () => {
    const h = await reserveTimestampProbe("2026-09-28T03:00:00.000000000000000000000000000002Z");
    for (const [artifactId, fraction] of [
      ["art_z", "1"],
      ["art_a", "3"],
    ] as const) {
      await h.catalog.reserve({
        ...h.entry,
        objectKey: `${h.entry.objectKey}/${artifactId}`,
        metadata: {
          ...h.entry.metadata,
          contentReference: { ...h.entry.metadata.contentReference, artifactId },
          retention: {
            mode: "expire",
            expiresAt: `2026-09-28T03:00:00.${"0".repeat(29)}${fraction}Z`,
          },
        },
      });
    }
    for (const artifactId of [h.artifactId, "art_z", "art_a"]) {
      await h.catalog.activate(
        h.scope,
        artifactId,
        { sha256: "a".repeat(64), sizeBytes: h.plaintext.byteLength + 20 },
        "2026-08-28T03:00:00.000Z",
      );
    }
    const ids = async (cut: string) =>
      (await h.catalog.listExpired(h.scope, cut, 10)).map(
        (e) => e.metadata.contentReference.artifactId,
      );
    expect(await ids("2026-09-28T03:00:00Z")).toEqual([]);
    expect(await ids("2026-09-28T03:00:00.000000000000000000000000000002Z")).toEqual([
      "art_z",
      h.artifactId,
    ]);
    expect(await ids("2026-09-28T03:00:01Z")).toEqual(["art_z", h.artifactId, "art_a"]);
  });

  it("rejects unrepresentable native receipt writes before changing catalog state", async () => {
    const h = await reserveTimestampProbe("2026-09-28T03:00:00Z");
    for (const timestamp of ["invalid", "2026-08-28T03:01:00.0000001Z"]) {
      await expect(
        h.catalog.activate(
          h.scope,
          h.artifactId,
          { sha256: "a".repeat(64), sizeBytes: 44 },
          timestamp,
        ),
      ).rejects.toBeInstanceOf(InvalidArtifactLifecycleInputError);
      await expect(h.catalog.listAbandoned(h.scope, timestamp, 10)).rejects.toBeInstanceOf(
        InvalidArtifactLifecycleInputError,
      );
    }
    expect(await h.catalog.find(h.scope, h.artifactId)).toEqual(h.entry);
  });

  it("preserves native microsecond creation and enforces lifecycle chronology", async () => {
    const h = await reserveTimestampProbe("2026-09-28T03:00:00Z");
    const artifactId = "art_micro_created";
    const entry = {
      ...h.entry,
      objectKey: `${h.entry.objectKey}/micro`,
      metadata: {
        ...h.entry.metadata,
        createdAt: "2026-08-28T03:00:00.000001Z",
        contentReference: { ...h.entry.metadata.contentReference, artifactId },
      },
    };
    await expect(h.catalog.reserve(entry)).resolves.toMatchObject({ entry });
    expect(await h.catalog.listAbandoned(h.scope, "2026-08-28T03:00:00.000Z", 10)).toEqual([
      h.entry,
    ]);
    await expect(
      h.catalog.activate(
        h.scope,
        artifactId,
        { sha256: "a".repeat(64), sizeBytes: h.plaintext.byteLength + 20 },
        "2026-08-28T03:00:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "proofstack_artifact_lifecycle_shape" });
    expect(await h.catalog.find(h.scope, artifactId)).toEqual(entry);
  });
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
