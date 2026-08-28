import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { CreateBucketCommand, DeleteBucketCommand } from "@aws-sdk/client-s3";
import {
  ArtifactCipher,
  ArtifactNotFoundError,
  ArtifactUnavailableError,
  LocalArtifactKeyring,
  PurgeArtifact,
  ReadArtifact,
  ReserveArtifact,
  SecureArtifactIdentityGenerator,
  TombstoneArtifact,
  UploadArtifact,
} from "@proofstack/artifacts";
import type {
  EvidenceEnvelope,
  EvidenceScope,
  PrincipalContext,
  RegressionDatasetVersion,
  RegressionFixtureVersion,
} from "@proofstack/contracts";
import {
  buildRegressionDatasetVersionPublishedOutboxIntent,
  buildRegressionFixtureVersionPublishedOutboxIntent,
  PublishRegressionDatasetVersion,
  PublishRegressionFixtureVersion,
  type RegressionVersionPublishedOutboxIntent,
} from "@proofstack/datasets";
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
  PostgresRegressionVersionRepository,
  provisionRuntimeRoles,
  type RuntimeRoleProvisioningOptions,
} from "@proofstack/postgres";
import { encodeRecoveryObjectInventory, verifyRecoverySet } from "@proofstack/recovery";
import { createS3ArtifactObjectStore, createS3Client } from "@proofstack/s3";
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
const s3AccessKeyId = requiredTestEnvironment("PROOFSTACK_TEST_S3_ACCESS_KEY_ID");
const s3Endpoint = requiredTestEnvironment("PROOFSTACK_TEST_S3_ENDPOINT");
const s3Region = requiredTestEnvironment("PROOFSTACK_TEST_S3_REGION");
const s3SecretAccessKey = requiredTestEnvironment("PROOFSTACK_TEST_S3_SECRET_ACCESS_KEY");

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
  "proofstack_regression_dataset_members",
  "proofstack_regression_dataset_versions",
  "proofstack_regression_datasets",
  "proofstack_regression_fixture_events",
  "proofstack_regression_fixture_versions",
  "proofstack_regression_fixtures",
  "proofstack_schema_migrations",
] as const;

const runKey = `${Date.now().toString(36)}_${process.pid}`;
const restoredDatabaseName = `proofstack_restore_${runKey}`;
const bucketSuffix = randomUUID();
const recoveryBuckets = {
  backup: `ps-recovery-backup-${bucketSuffix}`,
  restored: `ps-recovery-restored-${bucketSuffix}`,
  source: `ps-recovery-source-${bucketSuffix}`,
} as const;
const scope: EvidenceScope = {
  environmentId: "env_recovery",
  projectId: "prj_recovery",
  tenantId: "ten_recovery",
};
const traceId = "9bf92f3577b34da6a3ce929d0e0e4736";
const availableArtifactId = "art_recovery_available";
const purgedArtifactId = "art_recovery_purged";
const artifactKeyId = "key_recovery_integration";
const artifactKeyMaterial = Buffer.alloc(32, 29);
const availableArtifactContent = Buffer.from(
  JSON.stringify({ evidence: "coordinated recovery", status: "available" }),
  "utf8",
);
const s3Connection = {
  allowInsecureLoopback: true,
  credentials: { accessKeyId: s3AccessKeyId, secretAccessKey: s3SecretAccessKey },
  endpoint: s3Endpoint,
  forcePathStyle: true,
  region: s3Region,
};
const sourcePool = new Pool({ connectionString: databaseUrl, max: 4 });
const bucketClient = createS3Client(s3Connection);
const sourceObjects = createS3ArtifactObjectStore({
  ...s3Connection,
  bucket: recoveryBuckets.source,
});
const backupObjects = createS3ArtifactObjectStore({
  ...s3Connection,
  bucket: recoveryBuckets.backup,
});
const restoredObjects = createS3ArtifactObjectStore({
  ...s3Connection,
  bucket: recoveryBuckets.restored,
});
const runtimePools: Pool[] = [];
const temporaryDirectories: string[] = [];
const managedRoles: string[] = [];
const createdBuckets = new Set<string>();
const trackedObjectKeys = new Set<string>();
let restoredPool: Pool;
let restoredDatabaseUrl: string;
let regressionCatalogState:
  | {
      readonly datasetChild: RegressionDatasetVersion;
      readonly datasetRoot: RegressionDatasetVersion;
      readonly fixtureChild: RegressionFixtureVersion;
      readonly fixtureRoot: RegressionFixtureVersion;
      readonly secondFixtureRoot: RegressionFixtureVersion;
    }
  | undefined;

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

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function proofstackRevision(): string {
  const revision = Reflect.get(process.env, "GITHUB_SHA");
  return typeof revision === "string" && /^[0-9a-f]{40}$/u.test(revision)
    ? revision
    : "0".repeat(40);
}

function artifactPrincipal(tenantId = scope.tenantId): PrincipalContext {
  return {
    authentication: {
      authenticatedAt: "2026-08-28T03:00:00.000Z",
      credentialId: "key_recovery_rehearsal",
      method: "api_key",
    },
    capabilities: ["artifact:delete", "artifact:read", "artifact:write"],
    principalId: "wrk_recovery_rehearsal",
    principalType: "workload",
    requestId: "req_recovery_rehearsal",
    resourceScope: {
      mode: "restricted",
      projects: [{ environmentIds: [scope.environmentId], projectId: scope.projectId }],
    },
    roles: ["admin"],
    tenantId,
  };
}

function regressionPrincipal(tenantId = scope.tenantId): PrincipalContext {
  return {
    authentication: {
      authenticatedAt: "2026-08-28T03:00:00.000Z",
      method: "development",
    },
    capabilities: ["dataset:manage", "evidence:read"],
    principalId: "usr_recovery_regression",
    principalType: "user",
    requestId: "req_recovery_regression",
    resourceScope: { mode: "tenant" },
    roles: ["owner"],
    tenantId,
  };
}

async function seedRecoverableArtifacts(
  artifactRepository: PostgresArtifactCatalogRepository,
): Promise<void> {
  const cipher = new ArtifactCipher(
    new LocalArtifactKeyring({
      activeKeyId: artifactKeyId,
      keys: { [artifactKeyId]: artifactKeyMaterial },
    }),
  );
  const identities = new SecureArtifactIdentityGenerator();
  const principal = artifactPrincipal();
  const reserve = new ReserveArtifact({
    catalog: artifactRepository,
    clock: { now: () => new Date("2026-08-28T03:00:00.000Z") },
    encryption: cipher,
    identities,
  });
  const upload = new UploadArtifact({
    catalog: artifactRepository,
    clock: { now: () => new Date("2026-08-28T03:01:00.000Z") },
    encryption: cipher,
    objects: sourceObjects,
  });

  const store = async (artifactId: string, content: Uint8Array): Promise<void> => {
    await reserve.execute({
      environmentId: scope.environmentId,
      principal,
      projectId: scope.projectId,
      request: {
        artifactId,
        classification: "confidential",
        mediaType: "application/json",
        redaction: { status: "not_required" },
        retention: { mode: "retain" },
        sha256: sha256(content),
        sizeBytes: content.byteLength,
      },
    });
    await upload.execute({
      artifactId,
      content,
      environmentId: scope.environmentId,
      principal,
      projectId: scope.projectId,
    });
    const entry = await artifactRepository.find(scope, artifactId);
    if (!entry) throw new Error(`Recovery artifact ${artifactId} is missing after upload`);
    trackedObjectKeys.add(entry.objectKey);
  };

  await store(availableArtifactId, availableArtifactContent);
  await store(
    purgedArtifactId,
    Buffer.from(JSON.stringify({ evidence: "must remain deleted", status: "purged" }), "utf8"),
  );
  await new TombstoneArtifact({
    catalog: artifactRepository,
    clock: { now: () => new Date("2026-08-28T03:02:00.000Z") },
    identities,
  }).execute({
    artifactId: purgedArtifactId,
    environmentId: scope.environmentId,
    principal,
    projectId: scope.projectId,
    request: { reason: "Recovery rehearsal deletion evidence" },
  });
  await new PurgeArtifact({
    catalog: artifactRepository,
    clock: { now: () => new Date("2026-08-28T03:03:00.000Z") },
    identities,
    objects: sourceObjects,
  }).execute({
    artifactId: purgedArtifactId,
    environmentId: scope.environmentId,
    principal,
    projectId: scope.projectId,
  });
}

function evidence(
  eventId: string,
  spanId: string,
  options: { readonly sequence?: number; readonly startedAt?: string } = {},
): EvidenceEnvelope {
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
      ...(options.sequence === undefined ? {} : { sequence: options.sequence }),
      spanId,
      startedAt: options.startedAt ?? "2026-08-28T03:00:00.000Z",
      status: "ok",
      traceId,
    },
    receivedAt: "2026-08-28T03:00:01.000Z",
    schemaVersion: "0.1",
    scope,
  };
}

function regressionClock(instant: string): { readonly now: () => Date } {
  return { now: () => new Date(instant) };
}

async function seedRecoverableRegressionCatalog(): Promise<void> {
  const evidenceRepository = new PostgresEvidenceRepository(sourcePool);
  await evidenceRepository.append([
    evidence("evt_recovery_snapshot_middle", "80f067aa0ba902b7", {
      sequence: 1,
      startedAt: "2026-08-28T02:59:59.000Z",
    }),
    evidence("evt_recovery_snapshot_started", "81f067aa0ba902b7", {
      startedAt: "2026-08-28T02:59:58.000Z",
    }),
    evidence("evt_recovery_snapshot_first", "82f067aa0ba902b7", {
      sequence: 0,
      startedAt: "2026-08-28T02:59:59.000Z",
    }),
  ]);

  const versionRepository = new PostgresRegressionVersionRepository(sourcePool);
  const principal = regressionPrincipal();
  const publishFixture = (instant: string) =>
    new PublishRegressionFixtureVersion({
      clock: regressionClock(instant),
      evidenceRepository,
      versionRepository,
    });
  const fixtureRoot = await publishFixture("2026-08-28T03:04:00.000Z").execute({
    environmentId: scope.environmentId,
    fixtureId: "fix_recovery_primary",
    principal,
    projectId: scope.projectId,
    request: {
      fixtureVersionId: "fixv_recovery_primary_001",
      name: "Recovery primary fixture",
      source: { kind: "trace_snapshot", traceId },
    },
  });
  const secondFixtureRoot = await publishFixture("2026-08-28T03:05:00.000Z").execute({
    environmentId: scope.environmentId,
    fixtureId: "fix_recovery_secondary",
    principal,
    projectId: scope.projectId,
    request: {
      fixtureVersionId: "fixv_recovery_secondary_001",
      name: "Recovery secondary fixture",
      source: { kind: "trace_snapshot", traceId },
    },
  });

  await evidenceRepository.append([
    evidence("evt_recovery_snapshot_late", "83f067aa0ba902b7", {
      startedAt: "2026-08-28T03:00:00.000Z",
    }),
  ]);
  const fixtureChild = await publishFixture("2026-08-28T03:06:00.000Z").execute({
    environmentId: scope.environmentId,
    fixtureId: fixtureRoot.version.fixtureId,
    principal,
    projectId: scope.projectId,
    request: {
      fixtureVersionId: "fixv_recovery_primary_002",
      name: "Recovery primary fixture after late evidence",
      predecessorVersionId: fixtureRoot.version.fixtureVersionId,
      source: { kind: "trace_snapshot", traceId },
    },
  });

  const datasetRoot = await new PublishRegressionDatasetVersion({
    clock: regressionClock("2026-08-28T03:07:00.000Z"),
    versionRepository,
  }).execute({
    datasetId: "dat_recovery_catalog",
    environmentId: scope.environmentId,
    principal,
    projectId: scope.projectId,
    request: {
      datasetVersionId: "datv_recovery_catalog_001",
      fixtureVersions: [
        {
          fixtureId: secondFixtureRoot.version.fixtureId,
          fixtureVersionId: secondFixtureRoot.version.fixtureVersionId,
        },
        {
          fixtureId: fixtureChild.version.fixtureId,
          fixtureVersionId: fixtureChild.version.fixtureVersionId,
        },
      ],
      name: "Recovery regression catalog",
    },
  });
  const datasetChild = await new PublishRegressionDatasetVersion({
    clock: regressionClock("2026-08-28T03:08:00.000Z"),
    versionRepository,
  }).execute({
    datasetId: datasetRoot.version.datasetId,
    environmentId: scope.environmentId,
    principal,
    projectId: scope.projectId,
    request: {
      datasetVersionId: "datv_recovery_catalog_002",
      fixtureVersions: [
        {
          fixtureId: fixtureChild.version.fixtureId,
          fixtureVersionId: fixtureChild.version.fixtureVersionId,
        },
        {
          fixtureId: secondFixtureRoot.version.fixtureId,
          fixtureVersionId: secondFixtureRoot.version.fixtureVersionId,
        },
      ],
      name: "Recovery regression catalog reordered",
      predecessorVersionId: datasetRoot.version.datasetVersionId,
    },
  });

  regressionCatalogState = {
    datasetChild: datasetChild.version,
    datasetRoot: datasetRoot.version,
    fixtureChild: fixtureChild.version,
    fixtureRoot: fixtureRoot.version,
    secondFixtureRoot: secondFixtureRoot.version,
  };
}

async function seedAuthoritativeState(): Promise<void> {
  await migrateDatabase(sourcePool);

  const artifactRepository = new PostgresArtifactCatalogRepository(sourcePool);
  await seedRecoverableArtifacts(artifactRepository);

  await seedRecoverableRegressionCatalog();
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

interface StoredRegressionIntentRow {
  readonly aggregate_id: string;
  readonly aggregate_type: string;
  readonly created_at: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly schema_version: string;
  readonly tenant_id: string;
}

function requiredRegressionCatalogState(): NonNullable<typeof regressionCatalogState> {
  if (!regressionCatalogState) throw new Error("Recovery regression catalog was not seeded");
  return regressionCatalogState;
}

function intentOrderKey(intent: RegressionVersionPublishedOutboxIntent): Buffer {
  return Buffer.from(`${intent.eventType}\0${intent.aggregateType}\0${intent.aggregateId}`, "utf8");
}

function expectedRegressionPublicationIntents(): readonly RegressionVersionPublishedOutboxIntent[] {
  const state = requiredRegressionCatalogState();
  return [
    buildRegressionFixtureVersionPublishedOutboxIntent(state.fixtureRoot),
    buildRegressionFixtureVersionPublishedOutboxIntent(state.secondFixtureRoot),
    buildRegressionFixtureVersionPublishedOutboxIntent(state.fixtureChild),
    buildRegressionDatasetVersionPublishedOutboxIntent(state.datasetRoot),
    buildRegressionDatasetVersionPublishedOutboxIntent(state.datasetChild),
  ].sort((left, right) => Buffer.compare(intentOrderKey(left), intentOrderKey(right)));
}

async function regressionPublicationIntents(
  database: Pool,
): Promise<readonly RegressionVersionPublishedOutboxIntent[]> {
  const result = await database.query<StoredRegressionIntentRow>(`
    SELECT
      tenant_id,
      event_type,
      aggregate_type,
      aggregate_id,
      schema_version,
      payload,
      to_char(
        created_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) AS created_at
    FROM public.proofstack_outbox
    WHERE tenant_id = 'ten_recovery'
      AND event_type IN (
        'regression.fixture-version.published',
        'regression.dataset-version.published'
      )
  `);
  return result.rows
    .map((row) => ({
      aggregateId: row.aggregate_id,
      aggregateType: row.aggregate_type,
      createdAt: row.created_at,
      eventType: row.event_type,
      payload: row.payload,
      schemaVersion: row.schema_version,
      tenantId: row.tenant_id,
    }))
    .map((intent) => intent as RegressionVersionPublishedOutboxIntent)
    .sort((left, right) => Buffer.compare(intentOrderKey(left), intentOrderKey(right)));
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
  for (const bucket of Object.values(recoveryBuckets)) {
    await bucketClient.send(new CreateBucketCommand({ Bucket: bucket }));
    createdBuckets.add(bucket);
  }
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
  for (const objectKey of trackedObjectKeys) {
    await Promise.all([
      sourceObjects.delete(objectKey),
      backupObjects.delete(objectKey),
      restoredObjects.delete(objectKey),
    ]);
  }
  sourceObjects.destroy();
  backupObjects.destroy();
  restoredObjects.destroy();
  for (const bucket of createdBuckets) {
    await bucketClient.send(new DeleteBucketCommand({ Bucket: bucket }));
  }
  bucketClient.destroy();
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("coordinated recovery rehearsal", () => {
  it("restores database, ciphertext, and key versions into isolated targets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "proofstack-pg-recovery-"));
    temporaryDirectories.push(directory);
    const dumpPath = join(directory, "database.dump");
    const runner = new DockerPostgresCommandRunner({
      onFailure: ({ stderr }) => {
        process.stderr.write(`PostgreSQL tool diagnostic: ${stderr.trim()}\n`);
      },
    });
    const sourceSnapshot = await authoritativeSnapshot(sourcePool);
    expect(await regressionPublicationIntents(sourcePool)).toEqual(
      expectedRegressionPublicationIntents(),
    );
    const sourceLedger = await inspectVerifiedMigrationLedger(sourcePool);
    const sourceCatalog = new PostgresArtifactCatalogRepository(sourcePool);
    const sourceAvailable = await sourceCatalog.find(scope, availableArtifactId);
    const sourcePurged = await sourceCatalog.find(scope, purgedArtifactId);
    expect(sourceAvailable?.metadata.state).toBe("available");
    expect(sourcePurged?.metadata.state).toBe("purged");
    if (!sourceAvailable || !sourcePurged) {
      throw new Error("Recovery artifact catalog fixtures are incomplete");
    }

    const backup = await createPostgresLogicalBackup({
      allowPlaintextLoopback: true,
      connectionString: databaseUrl,
      database: sourcePool,
      dumpExecutable: "pg_dump",
      outputPath: dumpPath,
      runner,
    });
    expect(backup.sizeBytes).toBe((await stat(dumpPath)).size);
    const databaseDump = await readFile(dumpPath);
    const sourceCiphertext = await sourceObjects.get(sourceAvailable.objectKey);
    if (!sourceCiphertext) throw new Error("Available recovery ciphertext is missing");
    const inventory = [
      {
        ciphertextSha256: sha256(sourceCiphertext),
        objectKey: sourceAvailable.objectKey,
        sizeBytes: sourceCiphertext.byteLength,
      },
    ];
    const encodedInventory = encodeRecoveryObjectInventory(inventory);
    await expect(
      backupObjects.putIfAbsent(sourceAvailable.objectKey, sourceCiphertext),
    ).resolves.toMatchObject({
      created: true,
      receipt: {
        sha256: inventory[0]?.ciphertextSha256,
        sizeBytes: inventory[0]?.sizeBytes,
      },
    });
    await expect(sourceObjects.get(sourcePurged.objectKey)).resolves.toBeNull();
    await expect(backupObjects.get(sourcePurged.objectKey)).resolves.toBeNull();

    const keySnapshot = {
      [artifactKeyId]: Uint8Array.from(artifactKeyMaterial),
    };
    const configuration = Buffer.from(
      `${JSON.stringify({
        artifactEncryption: "a256gcm-v1",
        databaseEngine: backup.engineVersion,
        objectProvider: "s3-compatible",
        revision: proofstackRevision(),
      })}\n`,
      "utf8",
    );
    const bucketPolicy = Buffer.from(
      '{"restoreTarget":"empty","serverSidePlaintext":"forbidden"}\n',
      "utf8",
    );
    const manifest = {
      capture: {
        completedAt: "2026-08-28T03:14:00.000Z",
        databaseCapturedAt: "2026-08-28T03:11:00.000Z",
        fencedAt: "2026-08-28T03:10:00.000Z",
        keySnapshotCapturedAt: "2026-08-28T03:13:00.000Z",
        objectSnapshotCapturedAt: "2026-08-28T03:12:00.000Z",
      },
      configurationSha256: sha256(configuration),
      database: {
        dumpFormat: "postgresql-custom",
        engineVersion: backup.engineVersion,
        migrationLedger: sourceLedger,
        reference: "file:database.dump",
        sha256: backup.sha256,
        sizeBytes: backup.sizeBytes,
      },
      deploymentId: "dep_recovery_rehearsal",
      keyProvider: {
        provider: "test-keyring",
        reference: "provider:test-key-snapshot",
        referencedKeyIds: [artifactKeyId],
      },
      objectSnapshot: {
        bucketPolicySha256: sha256(bucketPolicy),
        inventoryReference: "file:objects.ndjson",
        inventorySha256: encodedInventory.summary.inventorySha256,
        objectCount: encodedInventory.summary.objectCount,
        provider: "s3-compatible",
        reference: `s3:${recoveryBuckets.backup}`,
        totalCiphertextBytes: encodedInventory.summary.totalCiphertextBytes,
      },
      proofstackRevision: proofstackRevision(),
      recoverySetId: "rec_foundation_two_rehearsal",
      schemaVersion: "0.1",
    };
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

    await expect(restoredObjects.get(sourceAvailable.objectKey)).resolves.toBeNull();
    for (const entry of inventory) {
      const ciphertext = await backupObjects.get(entry.objectKey);
      if (!ciphertext) throw new Error(`Backup object ${entry.objectKey} is missing`);
      expect({ sha256: sha256(ciphertext), sizeBytes: ciphertext.byteLength }).toEqual({
        sha256: entry.ciphertextSha256,
        sizeBytes: entry.sizeBytes,
      });
      await expect(restoredObjects.putIfAbsent(entry.objectKey, ciphertext)).resolves.toMatchObject(
        {
          created: true,
          receipt: { sha256: entry.ciphertextSha256, sizeBytes: entry.sizeBytes },
        },
      );
    }
    await expect(restoredObjects.get(sourcePurged.objectKey)).resolves.toBeNull();

    await expect(assertMigrationsCurrent(restoredPool)).resolves.toBeUndefined();
    const restoredLedger = await inspectVerifiedMigrationLedger(restoredPool);
    expect(restoredLedger).toEqual(sourceLedger);
    const restoredTraceOrderIndex = await restoredPool.query<{
      readonly collation_name: string;
      readonly collation_schema: string;
      readonly ready: boolean;
      readonly valid: boolean;
    }>(`
      SELECT
        selected_collation.collname AS collation_name,
        selected_collation_namespace.nspname AS collation_schema,
        index_metadata.indisready AS ready,
        index_metadata.indisvalid AS valid
      FROM pg_index AS index_metadata
      CROSS JOIN LATERAL
        unnest(index_metadata.indcollation::oid[]) WITH ORDINALITY
          AS index_key(collation_oid, key_position)
      JOIN pg_collation AS selected_collation
        ON selected_collation.oid = index_key.collation_oid
      JOIN pg_namespace AS selected_collation_namespace
        ON selected_collation_namespace.oid = selected_collation.collnamespace
      WHERE index_metadata.indexrelid =
        'public.proofstack_evidence_trace_order_idx'::regclass
        AND index_key.key_position = 7
    `);
    expect(restoredTraceOrderIndex.rows).toEqual([
      {
        collation_name: "C",
        collation_schema: "pg_catalog",
        ready: true,
        valid: true,
      },
    ]);
    await expect(authoritativeSnapshot(restoredPool)).resolves.toEqual(sourceSnapshot);
    await expect(regressionPublicationIntents(restoredPool)).resolves.toEqual(
      expectedRegressionPublicationIntents(),
    );
    const restoredCatalog = new PostgresArtifactCatalogRepository(restoredPool);
    const restoredKeyIds = (await restoredCatalog.listKeyReferences(scope)).map(
      ({ keyId }) => keyId,
    );
    expect(
      verifyRecoverySet({
        configuration,
        databaseDump,
        databaseEngineVersion: backup.engineVersion,
        inventory,
        manifest,
        migrationLedger: restoredLedger,
        referencedKeyIds: restoredKeyIds,
      }),
    ).toEqual({
      databaseBytes: databaseDump.byteLength,
      keyCount: 1,
      migrationCount: sourceLedger.length,
      objectCount: 1,
      recoverySetId: "rec_foundation_two_rehearsal",
      totalCiphertextBytes: sourceCiphertext.byteLength,
    });

    const migrations = await loadBundledMigrations();
    await expect(
      assertMigrationsCurrent(restoredPool, migrations.slice(0, -1)),
    ).rejects.toBeInstanceOf(MigrationIntegrityError);

    const roles = runtimeRoleOptions();
    await provisionRuntimeRoles(restoredPool, roles);
    const restoredPublicFunctionPrivileges = await restoredPool.query<{ readonly count: number }>(`
      SELECT count(*)::integer AS count
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname LIKE 'proofstack_%'
        AND EXISTS (
          SELECT 1
          FROM aclexplode(
            COALESCE(
              procedure.proacl,
              acldefault('f', procedure.proowner)
            )
          ) AS privilege
          WHERE privilege.grantee = 0
            AND privilege.privilege_type = 'EXECUTE'
        )
    `);
    expect(restoredPublicFunctionPrivileges.rows).toEqual([{ count: 0 }]);
    const restoredRegressionHelperPrivileges = await restoredPool.query<{
      readonly regression_execute: boolean;
      readonly role_name: string;
    }>(
      `
        SELECT
          role_name,
          has_function_privilege(
            role_name,
            'public.proofstack_regression_publication_intent_status(text, text, text, text, text, jsonb, timestamptz)',
            'EXECUTE'
          ) AS regression_execute
        FROM unnest($1::text[]) AS runtime_role(role_name)
        ORDER BY role_name COLLATE "C"
      `,
      [Object.values(roles).map(({ name }) => name)],
    );
    expect(restoredRegressionHelperPrivileges.rows).toEqual(
      Object.entries(roles)
        .map(([kind, { name }]) => ({
          regression_execute: kind === "api",
          role_name: name,
        }))
        .sort((left, right) =>
          Buffer.compare(Buffer.from(left.role_name, "utf8"), Buffer.from(right.role_name, "utf8")),
        ),
    );
    const runtimeUrl = new URL(restoredDatabaseUrl);
    runtimeUrl.username = roles.api.name;
    runtimeUrl.password = roles.api.password;
    const runtimePool = new Pool({ connectionString: runtimeUrl.toString(), max: 2 });
    runtimePools.push(runtimePool);
    const artifactUrl = new URL(restoredDatabaseUrl);
    artifactUrl.username = roles.artifact.name;
    artifactUrl.password = roles.artifact.password;
    const artifactPool = new Pool({ connectionString: artifactUrl.toString(), max: 2 });
    runtimePools.push(artifactPool);
    const restoredArtifactCatalog = new PostgresArtifactCatalogRepository(artifactPool);
    const restoredArtifactReader = new ReadArtifact({
      catalog: restoredArtifactCatalog,
      encryption: new ArtifactCipher(
        new LocalArtifactKeyring({
          activeKeyId: artifactKeyId,
          keys: keySnapshot,
        }),
      ),
      objects: restoredObjects,
    });
    const restoredArtifact = await restoredArtifactReader.execute({
      artifactId: availableArtifactId,
      environmentId: scope.environmentId,
      principal: artifactPrincipal(),
      projectId: scope.projectId,
    });
    expect(Buffer.from(restoredArtifact.content)).toEqual(availableArtifactContent);
    expect(restoredArtifact.metadata.state).toBe("available");
    await expect(
      restoredArtifactReader.execute({
        artifactId: availableArtifactId,
        environmentId: scope.environmentId,
        principal: artifactPrincipal("ten_recovery_other"),
        projectId: scope.projectId,
      }),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
    await expect(
      restoredArtifactReader.execute({
        artifactId: purgedArtifactId,
        environmentId: scope.environmentId,
        principal: artifactPrincipal(),
        projectId: scope.projectId,
      }),
    ).rejects.toBeInstanceOf(ArtifactUnavailableError);
    await expect(
      artifactPool.query("SELECT count(*)::integer AS count FROM proofstack_artifact_catalog"),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const expectedRegression = requiredRegressionCatalogState();
    const restoredRegression = new PostgresRegressionVersionRepository(runtimePool);
    await expect(
      restoredRegression.findFixtureVersion(
        scope,
        expectedRegression.fixtureChild.fixtureVersionId,
      ),
    ).resolves.toEqual(expectedRegression.fixtureChild);
    await expect(
      restoredRegression.findDatasetVersion(
        scope,
        expectedRegression.datasetChild.datasetVersionId,
      ),
    ).resolves.toEqual(expectedRegression.datasetChild);
    expect(expectedRegression.fixtureChild.source.eventIds).toEqual([
      "evt_recovery_snapshot_started",
      "evt_recovery_snapshot_first",
      "evt_recovery_snapshot_middle",
      "evt_recovery_snapshot_late",
    ]);
    expect(expectedRegression.datasetChild.fixtureVersions).toEqual([
      {
        definitionSha256: expectedRegression.fixtureChild.definitionSha256,
        fixtureId: expectedRegression.fixtureChild.fixtureId,
        fixtureVersionId: expectedRegression.fixtureChild.fixtureVersionId,
      },
      {
        definitionSha256: expectedRegression.secondFixtureRoot.definitionSha256,
        fixtureId: expectedRegression.secondFixtureRoot.fixtureId,
        fixtureVersionId: expectedRegression.secondFixtureRoot.fixtureVersionId,
      },
    ]);

    for (const hiddenScope of [
      { ...scope, projectId: "prj_recovery_other" },
      { ...scope, environmentId: "env_recovery_other" },
      { ...scope, tenantId: "ten_recovery_other" },
    ]) {
      await expect(
        restoredRegression.findFixtureVersion(
          hiddenScope,
          expectedRegression.fixtureChild.fixtureVersionId,
        ),
      ).resolves.toBeNull();
      await expect(
        restoredRegression.findDatasetVersion(
          hiddenScope,
          expectedRegression.datasetChild.datasetVersionId,
        ),
      ).resolves.toBeNull();
    }
    await expect(
      runtimePool.query(
        "SELECT count(*)::integer AS count FROM proofstack_regression_fixture_versions",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      runtimePool.query(
        "SELECT count(*)::integer AS count FROM proofstack_regression_dataset_versions",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const evidenceRepository = new PostgresEvidenceRepository(runtimePool);
    await expect(
      evidenceRepository.listByTrace(scope, traceId, { limit: 10 }),
    ).resolves.toMatchObject({
      events: [
        { evidence: { eventId: "evt_recovery_snapshot_started" } },
        { evidence: { eventId: "evt_recovery_snapshot_first" } },
        { evidence: { eventId: "evt_recovery_snapshot_middle" } },
        { evidence: { eventId: "evt_recovery_snapshot_late" } },
      ],
    });
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
        { evidence: { eventId: "evt_recovery_snapshot_started" } },
        { evidence: { eventId: "evt_recovery_snapshot_first" } },
        { evidence: { eventId: "evt_recovery_snapshot_middle" } },
        { evidence: { eventId: "evt_recovery_after_restore" } },
        { evidence: { eventId: "evt_recovery_snapshot_late" } },
      ],
    });

    const restoredFixtureAfterWrite = await new PublishRegressionFixtureVersion({
      clock: regressionClock("2026-08-28T03:09:00.000Z"),
      evidenceRepository,
      versionRepository: restoredRegression,
    }).execute({
      environmentId: scope.environmentId,
      fixtureId: expectedRegression.fixtureChild.fixtureId,
      principal: regressionPrincipal(),
      projectId: scope.projectId,
      request: {
        fixtureVersionId: "fixv_recovery_primary_003",
        name: "Recovery primary fixture after restore",
        predecessorVersionId: expectedRegression.fixtureChild.fixtureVersionId,
        source: { kind: "trace_snapshot", traceId },
      },
    });
    expect(restoredFixtureAfterWrite.version.source.eventIds).toEqual([
      "evt_recovery_snapshot_started",
      "evt_recovery_snapshot_first",
      "evt_recovery_snapshot_middle",
      "evt_recovery_after_restore",
      "evt_recovery_snapshot_late",
    ]);
    await expect(
      restoredRegression.findFixtureVersion(
        scope,
        restoredFixtureAfterWrite.version.fixtureVersionId,
      ),
    ).resolves.toEqual(restoredFixtureAfterWrite.version);

    const restoredDatasetAfterWrite = await new PublishRegressionDatasetVersion({
      clock: regressionClock("2026-08-28T03:10:00.000Z"),
      versionRepository: restoredRegression,
    }).execute({
      datasetId: expectedRegression.datasetChild.datasetId,
      environmentId: scope.environmentId,
      principal: regressionPrincipal(),
      projectId: scope.projectId,
      request: {
        datasetVersionId: "datv_recovery_catalog_003",
        fixtureVersions: [
          {
            fixtureId: restoredFixtureAfterWrite.version.fixtureId,
            fixtureVersionId: restoredFixtureAfterWrite.version.fixtureVersionId,
          },
          {
            fixtureId: expectedRegression.secondFixtureRoot.fixtureId,
            fixtureVersionId: expectedRegression.secondFixtureRoot.fixtureVersionId,
          },
        ],
        name: "Recovery regression catalog after restore",
        predecessorVersionId: expectedRegression.datasetChild.datasetVersionId,
      },
    });
    await expect(
      restoredRegression.findDatasetVersion(
        scope,
        restoredDatasetAfterWrite.version.datasetVersionId,
      ),
    ).resolves.toEqual(restoredDatasetAfterWrite.version);

    const restoredRegressionIntents = [
      ...expectedRegressionPublicationIntents(),
      buildRegressionFixtureVersionPublishedOutboxIntent(restoredFixtureAfterWrite.version),
      buildRegressionDatasetVersionPublishedOutboxIntent(restoredDatasetAfterWrite.version),
    ].sort((left, right) => Buffer.compare(intentOrderKey(left), intentOrderKey(right)));
    await expect(regressionPublicationIntents(restoredPool)).resolves.toEqual(
      restoredRegressionIntents,
    );

    const sourceRegression = new PostgresRegressionVersionRepository(sourcePool);
    await expect(
      sourceRegression.findFixtureVersion(
        scope,
        restoredFixtureAfterWrite.version.fixtureVersionId,
      ),
    ).resolves.toBeNull();
    await expect(
      sourceRegression.findDatasetVersion(
        scope,
        restoredDatasetAfterWrite.version.datasetVersionId,
      ),
    ).resolves.toBeNull();
    await expect(regressionPublicationIntents(sourcePool)).resolves.toEqual(
      expectedRegressionPublicationIntents(),
    );
    await expect(
      sourcePool.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM proofstack_evidence_events WHERE event_id = 'evt_recovery_after_restore'",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});
