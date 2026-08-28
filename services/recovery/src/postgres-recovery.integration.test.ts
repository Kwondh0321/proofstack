import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ArtifactCatalogEntry } from "@proofstack/artifacts";
import type { EvidenceEnvelope, EvidenceScope } from "@proofstack/contracts";
import {
  assertMigrationsCurrent,
  bootstrapApiKey,
  createOidcBinding,
  inspectVerifiedMigrationLedger,
  loadBundledMigrations,
  MigrationIntegrityError,
  migrateDatabase,
  PostgresArtifactCatalogRepository,
  PostgresConsumerReceiptRepository,
  PostgresEvidenceRepository,
  PostgresOidcIdentityRepository,
  PostgresProjectionCursorRepository,
  provisionRuntimeRoles,
  type RuntimeRoleProvisioningOptions,
} from "@proofstack/postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NativePostgresCommandRunner, type PostgresCommand } from "./postgres-command.js";
import {
  createPostgresLogicalBackup,
  restorePostgresLogicalBackup,
} from "./postgres-logical-backup.js";

function requiredTestEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the recovery integration test`);
  }
  return value;
}

const databaseUrl = requiredTestEnvironment("PROOFSTACK_TEST_DATABASE_URL");
const postgresToolImage = requiredTestEnvironment("PROOFSTACK_TEST_POSTGRES_TOOL_IMAGE");

const EXPECTED_TABLES = [
  "proofstack_api_key_credentials",
  "proofstack_artifact_catalog",
  "proofstack_artifact_purge_receipts",
  "proofstack_artifact_tombstones",
  "proofstack_browser_sessions",
  "proofstack_consumer_receipts",
  "proofstack_evidence_events",
  "proofstack_identity_audit_events",
  "proofstack_oidc_bindings",
  "proofstack_oidc_login_transactions",
  "proofstack_outbox",
  "proofstack_projection_cursors",
  "proofstack_schema_migrations",
] as const;

const runKey = `${Date.now().toString(36)}_${process.pid}`;
const restoredDatabaseName = `proofstack_restore_${runKey}`;
const scope: EvidenceScope = {
  environmentId: "env_recovery",
  projectId: "prj_recovery",
  tenantId: "ten_recovery",
};
const traceId = "9bf92f3577b34da6a3ce929d0e0e4736";
const sourcePool = new Pool({ connectionString: databaseUrl, max: 4 });
const runtimePools: Pool[] = [];
const temporaryDirectories: string[] = [];
const managedRoles: string[] = [];
let restoredPool: Pool;
let restoredDatabaseUrl: string;

function quotedIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{2,62}$/u.test(value)) throw new Error("Unsafe PostgreSQL identifier");
  return `"${value}"`;
}

class DockerPostgresCommandRunner extends NativePostgresCommandRunner {
  override async run(command: PostgresCommand) {
    const paths = command.arguments
      .map((argument) =>
        argument.startsWith("--file=") ? argument.slice("--file=".length) : argument,
      )
      .filter((argument) => isAbsolute(argument));
    const directories = [...new Set(paths.map((path) => dirname(path)))];
    if (directories.some((directory) => directory.includes(","))) {
      throw new Error("Docker recovery test path cannot contain a comma");
    }
    const postgresEnvironment = Object.entries(command.environment).filter(([name]) =>
      name.startsWith("PG"),
    );
    postgresEnvironment.sort(([left], [right]) => left.localeCompare(right));
    if (postgresEnvironment.some(([, value]) => /[\r\n]/u.test(value))) {
      throw new Error("Docker recovery test environment cannot contain newlines");
    }
    const environmentPath = join(tmpdir(), `proofstack-pg-env-${randomUUID()}`);
    await writeFile(
      environmentPath,
      `${postgresEnvironment.map(([name, value]) => `${name}=${value}`).join("\n")}\n`,
      { flag: "wx", mode: 0o600 },
    );
    try {
      return await super.run({
        arguments: [
          "run",
          "--rm",
          "--network=host",
          `--entrypoint=${command.executable}`,
          `--env-file=${environmentPath}`,
          ...directories.flatMap((directory) => [
            "--mount",
            `type=bind,source=${directory},target=${directory}`,
          ]),
          postgresToolImage,
          ...command.arguments,
        ],
        environment: command.environment,
        executable: "docker",
        ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      });
    } finally {
      await unlink(environmentPath);
    }
  }
}

function artifactEntry(artifactId: string, seed: number): ArtifactCatalogEntry {
  return {
    createdByPrincipalId: "usr_recovery",
    encryption: {
      contentNonce: Buffer.alloc(12, seed).toString("base64url"),
      version: "a256gcm-v1",
      wrappedDataKey: {
        algorithm: "A256GCM",
        ciphertext: Buffer.alloc(32, seed).toString("base64url"),
        keyId: `key_recovery_${seed}`,
        nonce: Buffer.alloc(12, seed + 1).toString("base64url"),
        tag: Buffer.alloc(16, seed + 2).toString("base64url"),
      },
    },
    metadata: {
      contentReference: {
        artifactId,
        classification: "confidential",
        mediaType: "application/json",
        sha256: seed.toString(16).repeat(64),
        sizeBytes: 18,
      },
      createdAt: "2026-08-28T03:00:00.000Z",
      redaction: { status: "not_required" },
      retention: { mode: "retain" },
      schemaVersion: "0.1",
      scope,
      state: "reserved",
    },
    objectKey: `objects/v1/recovery/${artifactId}`,
  };
}

function evidence(eventId: string, spanId: string): EvidenceEnvelope {
  return {
    evidence: {
      attributes: { recovery: true },
      contentReferences: [],
      eventId,
      extensions: {},
      kind: "agent.run",
      name: "recovery rehearsal",
      source: {
        sdkName: "@proofstack/recovery-operations",
        sdkVersion: "0.0.0",
        serviceName: "recovery-rehearsal",
      },
      spanId,
      startedAt: "2026-08-28T03:00:00.000Z",
      status: "ok",
      traceId,
    },
    receivedAt: "2026-08-28T03:00:01.000Z",
    schemaVersion: "0.1",
    scope,
  };
}

async function seedAuthoritativeState(): Promise<void> {
  await migrateDatabase(sourcePool);

  const artifactRepository = new PostgresArtifactCatalogRepository(sourcePool);
  const available = artifactEntry("art_recovery_available", 1);
  await artifactRepository.reserve(available);
  await artifactRepository.activate(
    scope,
    available.metadata.contentReference.artifactId,
    { sha256: "a".repeat(64), sizeBytes: 38 },
    "2026-08-28T03:01:00.000Z",
  );
  const purged = artifactEntry("art_recovery_purged", 2);
  await artifactRepository.reserve(purged);
  await artifactRepository.tombstone(scope, {
    actorPrincipalId: "usr_recovery",
    artifactId: purged.metadata.contentReference.artifactId,
    occurredAt: "2026-08-28T03:02:00.000Z",
    reason: "Recovery rehearsal lifecycle evidence",
    tombstoneId: "del_recovery_purged",
    trigger: "abandoned",
  });
  await artifactRepository.recordPurge(scope, {
    artifactId: purged.metadata.contentReference.artifactId,
    objectWasPresent: false,
    occurredAt: "2026-08-28T03:03:00.000Z",
    purgeId: "purge_recovery_purged",
  });

  await new PostgresEvidenceRepository(sourcePool).append([
    evidence("evt_recovery_original", "80f067aa0ba902b7"),
  ]);
  await new PostgresProjectionCursorRepository(sourcePool).advance(scope.tenantId, {
    consumerName: "trace.projector",
    generation: 1,
    lastOutboxId: "1",
  });
  const receiptToken = "70000000-0000-4000-8000-000000000001";
  const receipts = new PostgresConsumerReceiptRepository(sourcePool, () => receiptToken);
  await receipts.claim(scope.tenantId, {
    consumerName: "trace.projector",
    leaseDurationMs: 60_000,
    messageId: "message_recovery",
    payloadSha256: "c".repeat(64),
    workerId: "wrk_recovery",
  });
  await receipts.complete(scope.tenantId, {
    consumerName: "trace.projector",
    leaseToken: receiptToken,
    messageId: "message_recovery",
  });

  await bootstrapApiKey(sourcePool, {
    actorPrincipalId: "usr_recovery",
    capabilities: ["evidence:ingest", "evidence:read"],
    name: "recovery workload",
    resourceScope: { mode: "tenant" },
    tenantId: scope.tenantId,
  });
  await createOidcBinding(sourcePool, {
    actorPrincipalId: "usr_recovery",
    bindingId: "oid_recovery_binding",
    capabilities: ["evidence:read"],
    issuer: "https://identity.recovery.example",
    principalId: "usr_recovery_viewer",
    resourceScope: { mode: "tenant" },
    roles: ["viewer"],
    subject: "recovery-subject",
    tenantId: scope.tenantId,
  });
  const oidc = new PostgresOidcIdentityRepository(sourcePool);
  await oidc.create({
    lifetimeSeconds: 600,
    protectedPayload: `otx_v1_${"A".repeat(16)}_${"B".repeat(32)}_${"C".repeat(22)}`,
    stateDigest: "d".repeat(64),
  });
  await oidc.create({
    absoluteLifetimeSeconds: 3_600,
    bindingId: "oid_recovery_binding",
    csrfDigest: "e".repeat(64),
    idleLifetimeSeconds: 900,
    sessionDigest: "f".repeat(64),
    sessionId: "ses_recovery_browser",
  });
}

interface TableNamesRow {
  readonly table_name: string;
}

interface JsonRowsRow {
  readonly rows: unknown[] | null;
}

interface SequenceSnapshotRow {
  readonly last_value: string | null;
  readonly sequencename: string;
}

async function authoritativeSnapshot(pool: Pool): Promise<{
  readonly sequences: readonly SequenceSnapshotRow[];
  readonly tables: Readonly<Record<string, readonly unknown[]>>;
}> {
  const tables = await pool.query<TableNamesRow>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name LIKE 'proofstack_%'
    ORDER BY table_name
  `);
  expect(tables.rows.map(({ table_name }) => table_name)).toEqual(EXPECTED_TABLES);
  const contents: Record<string, readonly unknown[]> = {};
  for (const { table_name: tableName } of tables.rows) {
    const result = await pool.query<JsonRowsRow>(`
      SELECT jsonb_agg(to_jsonb(row_data) ORDER BY to_jsonb(row_data)::text) AS rows
      FROM public.${quotedIdentifier(tableName)} AS row_data
    `);
    const rows = result.rows[0]?.rows ?? [];
    expect(rows.length, `${tableName} must contain representative recovery state`).toBeGreaterThan(
      0,
    );
    contents[tableName] = rows;
  }
  const sequences = await pool.query<SequenceSnapshotRow>(`
    SELECT sequencename, last_value::text
    FROM pg_sequences
    WHERE schemaname = 'public' AND sequencename LIKE 'proofstack_%'
    ORDER BY sequencename
  `);
  expect(sequences.rows.length).toBeGreaterThan(0);
  return { sequences: sequences.rows, tables: contents };
}

function runtimeRoleOptions(): RuntimeRoleProvisioningOptions {
  const role = (purpose: string) => `proofstack_rr_${purpose}_${runKey}`;
  const options = {
    api: { name: role("api"), password: `recovery-api-${runKey}` },
    artifact: { name: role("artifact"), password: `recovery-artifact-${runKey}` },
    consumer: { name: role("consumer"), password: `recovery-consumer-${runKey}` },
    identity: { name: role("identity"), password: `recovery-identity-${runKey}` },
    publisher: { name: role("publisher"), password: `recovery-publisher-${runKey}` },
  } satisfies RuntimeRoleProvisioningOptions;
  managedRoles.push(...Object.values(options).map(({ name }) => name));
  return options;
}

beforeAll(async () => {
  const sourceDatabase = await sourcePool.query<{ current_database: string }>(
    "SELECT current_database()",
  );
  expect(sourceDatabase.rows[0]?.current_database).toBe("proofstack_test");
  await seedAuthoritativeState();
  await sourcePool.query(
    `CREATE DATABASE ${quotedIdentifier(restoredDatabaseName)} TEMPLATE template0`,
  );
  const target = new URL(databaseUrl);
  target.pathname = `/${restoredDatabaseName}`;
  restoredDatabaseUrl = target.toString();
  restoredPool = new Pool({ connectionString: restoredDatabaseUrl, max: 4 });
});

afterAll(async () => {
  await Promise.all(runtimePools.map((pool) => pool.end()));
  if (restoredPool) {
    for (const roleName of managedRoles) {
      await restoredPool.query(`DROP OWNED BY ${quotedIdentifier(roleName)}`);
    }
    await restoredPool.end();
  }
  for (const roleName of managedRoles) {
    await sourcePool.query(`DROP ROLE IF EXISTS ${quotedIdentifier(roleName)}`);
  }
  await sourcePool.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [restoredDatabaseName],
  );
  await sourcePool.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(restoredDatabaseName)}`);
  await sourcePool.end();
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("PostgreSQL coordinated recovery rehearsal", () => {
  it("restores every authoritative table into an isolated database and resumes safely", async () => {
    const directory = await mkdtemp(join(tmpdir(), "proofstack-pg-recovery-"));
    temporaryDirectories.push(directory);
    const dumpPath = join(directory, "database.dump");
    const runner = new DockerPostgresCommandRunner({
      onFailure: ({ stderr }) => {
        process.stderr.write(`PostgreSQL tool diagnostic: ${stderr.trim()}\n`);
      },
    });
    const sourceSnapshot = await authoritativeSnapshot(sourcePool);
    const sourceLedger = await inspectVerifiedMigrationLedger(sourcePool);

    const backup = await createPostgresLogicalBackup({
      allowPlaintextLoopback: true,
      connectionString: databaseUrl,
      database: sourcePool,
      dumpExecutable: "pg_dump",
      outputPath: dumpPath,
      runner,
    });
    expect(backup.sizeBytes).toBe((await stat(dumpPath)).size);
    await expect(
      restorePostgresLogicalBackup({
        allowPlaintextLoopback: true,
        connectionString: restoredDatabaseUrl,
        database: restoredPool,
        dumpPath,
        restoreExecutable: "pg_restore",
        runner,
      }),
    ).resolves.toEqual(backup);

    await expect(assertMigrationsCurrent(restoredPool)).resolves.toBeUndefined();
    await expect(inspectVerifiedMigrationLedger(restoredPool)).resolves.toEqual(sourceLedger);
    await expect(authoritativeSnapshot(restoredPool)).resolves.toEqual(sourceSnapshot);

    const migrations = await loadBundledMigrations();
    await expect(
      assertMigrationsCurrent(restoredPool, migrations.slice(0, -1)),
    ).rejects.toBeInstanceOf(MigrationIntegrityError);

    const roles = runtimeRoleOptions();
    await provisionRuntimeRoles(restoredPool, roles);
    const runtimeUrl = new URL(restoredDatabaseUrl);
    runtimeUrl.username = roles.api.name;
    runtimeUrl.password = roles.api.password;
    const runtimePool = new Pool({ connectionString: runtimeUrl.toString(), max: 2 });
    runtimePools.push(runtimePool);
    const evidenceRepository = new PostgresEvidenceRepository(runtimePool);
    await expect(
      evidenceRepository.listByTrace(scope, traceId, { limit: 10 }),
    ).resolves.toMatchObject({ events: [{ evidence: { eventId: "evt_recovery_original" } }] });
    await expect(
      evidenceRepository.listByTrace({ ...scope, tenantId: "ten_recovery_other" }, traceId, {
        limit: 10,
      }),
    ).resolves.toEqual({ cursorFound: true, events: [], hasMore: false });
    await expect(
      runtimePool.query("SELECT count(*)::integer AS count FROM proofstack_evidence_events"),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await evidenceRepository.append([evidence("evt_recovery_after_restore", "90f067aa0ba902b7")]);
    await expect(
      evidenceRepository.listByTrace(scope, traceId, { limit: 10 }),
    ).resolves.toMatchObject({
      events: [
        { evidence: { eventId: "evt_recovery_after_restore" } },
        { evidence: { eventId: "evt_recovery_original" } },
      ],
    });
    await expect(
      sourcePool.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM proofstack_evidence_events WHERE event_id = 'evt_recovery_after_restore'",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});
