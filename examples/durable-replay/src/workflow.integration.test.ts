import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { type ApiConfig, createApp } from "@proofstack/api/composition";
import {
  createPostgresPool,
  migrateDatabase,
  provisionRuntimeRoles,
  type RuntimeRoleProvisioningOptions,
} from "@proofstack/postgres";
import { createS3Client } from "@proofstack/s3";
import { ProofStackRegressionClient, ProofStackReplayClient } from "@proofstack/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDurableReplayExample } from "./workflow.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for durable replay integration tests`);
  return value;
}

function setEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const databaseUrl = requiredEnvironment("PROOFSTACK_TEST_DATABASE_URL");
const s3AccessKeyId = requiredEnvironment("PROOFSTACK_TEST_S3_ACCESS_KEY_ID");
const s3SecretAccessKey = requiredEnvironment("PROOFSTACK_TEST_S3_SECRET_ACCESS_KEY");
const s3Endpoint = requiredEnvironment("PROOFSTACK_TEST_S3_ENDPOINT");
const s3Region = requiredEnvironment("PROOFSTACK_TEST_S3_REGION");
const runKey = randomUUID().replaceAll("-", "").slice(0, 16);
const artifactBucket = `proofstack-durable-${runKey}`;
const artifactKeyId = `key_durable_${runKey}`;
const artifactKey = Buffer.alloc(32, 41).toString("base64url");
const originalAwsEnvironment = new Map(
  ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"].map((name) => [
    name,
    process.env[name],
  ]),
);

function credentials(kind: string) {
  return {
    name: `proofstack_durable_${runKey}_${kind}`,
    password: randomUUID(),
  };
}

const runtimeRoles: RuntimeRoleProvisioningOptions = {
  api: credentials("api"),
  artifact: credentials("artifact"),
  consumer: credentials("consumer"),
  evaluationWorker: credentials("evaluation"),
  identity: credentials("identity"),
  publisher: credentials("publisher"),
  replayWorker: credentials("worker"),
};

function roleDatabaseUrl(role: { readonly name: string; readonly password: string }): string {
  const value = new URL(databaseUrl);
  value.username = role.name;
  value.password = role.password;
  return value.toString();
}

const adminPool = createPostgresPool({
  applicationName: "proofstack-durable-integration-setup",
  connectionString: databaseUrl,
  maxConnections: 1,
  onIdleError: (error) => {
    throw error;
  },
});
const artifactAdministrationClient = createS3Client({
  allowInsecureLoopback: true,
  credentials: { accessKeyId: s3AccessKeyId, secretAccessKey: s3SecretAccessKey },
  endpoint: s3Endpoint,
  forcePathStyle: true,
  region: s3Region,
});

const apiConfig: ApiConfig = {
  authMode: "development",
  environment: "test",
  host: "127.0.0.1",
  logLevel: "silent",
  otlp: { compressedBodyLimitBytes: 1_048_576, decompressedBodyLimitBytes: 1_048_576 },
  port: 4318,
  storage: {
    artifacts: {
      activeKeyId: artifactKeyId,
      allowInsecureLoopback: true,
      bucket: artifactBucket,
      endpoint: s3Endpoint,
      forcePathStyle: true,
      keys: { [artifactKeyId]: artifactKey },
      mode: "s3_local_keyring",
      region: s3Region,
    },
    databaseUrl: roleDatabaseUrl(runtimeRoles.api),
    mode: "postgres",
  },
};

let app: Awaited<ReturnType<typeof createApp>> | undefined;
let apiUrl: string;
let outputRoot: string | undefined;
let bucketCreated = false;
let rolesCreated = false;

async function emptyArtifactBucket(): Promise<void> {
  while (true) {
    const page = await artifactAdministrationClient.send(
      new ListObjectsV2Command({ Bucket: artifactBucket }),
    );
    const objects = (page.Contents ?? []).flatMap(({ Key }) => (Key ? [{ Key }] : []));
    if (objects.length === 0) return;
    const deleted = await artifactAdministrationClient.send(
      new DeleteObjectsCommand({ Bucket: artifactBucket, Delete: { Objects: objects } }),
    );
    expect(deleted.Errors ?? []).toEqual([]);
  }
}

beforeAll(async () => {
  setEnvironment("AWS_ACCESS_KEY_ID", s3AccessKeyId);
  setEnvironment("AWS_SECRET_ACCESS_KEY", s3SecretAccessKey);
  setEnvironment("AWS_SESSION_TOKEN", undefined);
  await migrateDatabase(adminPool);
  await provisionRuntimeRoles(adminPool, runtimeRoles);
  rolesCreated = true;
  await artifactAdministrationClient.send(new CreateBucketCommand({ Bucket: artifactBucket }));
  bucketCreated = true;
  outputRoot = await mkdtemp(join(tmpdir(), "proofstack-durable-integration-"));
  app = await createApp(apiConfig);
  apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
}, 60_000);

afterAll(async () => {
  try {
    await app?.close();
    if (bucketCreated) {
      await emptyArtifactBucket();
      await artifactAdministrationClient.send(new DeleteBucketCommand({ Bucket: artifactBucket }));
    }
    if (rolesCreated) {
      for (const role of Object.values(runtimeRoles)) {
        await adminPool.query(`DROP OWNED BY "${role.name}"`);
        await adminPool.query(`DROP ROLE "${role.name}"`);
      }
    }
  } finally {
    artifactAdministrationClient.destroy();
    for (const [name, value] of originalAwsEnvironment) setEnvironment(name, value);
    await adminPool.end();
    if (outputRoot) await rm(outputRoot, { force: true, recursive: true });
  }
}, 30_000);

describe("provider-neutral durable replay end to end", () => {
  it("persists success, cancellation, and stale-fence recovery through real HTTP, workers, PostgreSQL, and S3", async () => {
    if (!outputRoot) throw new Error("The durable replay integration workspace is unavailable");
    const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const summary = await runDurableReplayExample({
      apiUrl,
      environmentId: `env_durable_${runKey}`,
      outputRoot,
      projectId: `prj_durable_${runKey}`,
      sourceRevision,
      tenantId: "ten_local",
      workerDatabaseUrl: roleDatabaseUrl(runtimeRoles.replayWorker),
      workerEntryPointPath: fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
    });

    expect(summary.jobs.success).toMatchObject({
      attemptStatuses: ["succeeded"],
      cancellationAcknowledgementCount: 0,
      status: "succeeded",
    });
    expect(summary.jobs.success.budgetEntryCount).toBeGreaterThanOrEqual(2);
    expect(summary.jobs.success.executionObservationCount).toBeGreaterThan(0);
    expect(summary.jobs.success.usageObservationCount).toBeGreaterThan(0);
    expect(summary.jobs.cancellation).toMatchObject({
      attemptStatuses: ["cancelled"],
      status: "cancelled",
    });
    expect(summary.jobs.cancellation.cancellationAcknowledgementCount).toBeGreaterThan(0);
    expect(summary.jobs.staleFenceRecovery).toMatchObject({
      attemptStatuses: ["lease_expired", "succeeded"],
      recoveredFencingToken: 2,
      rejectedFencingToken: 1,
      status: "succeeded",
    });
    expect(await readdir(join(outputRoot, "commands"))).toEqual([]);
    expect(await readdir(join(outputRoot, "workspaces"))).toEqual([]);

    await app?.close();
    app = await createApp(apiConfig);
    apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const replay = new ProofStackReplayClient({
      authentication: { mode: "development" },
      endpoint: apiUrl,
      environmentId: summary.scope.environmentId,
      projectId: summary.scope.projectId,
    });
    const regression = new ProofStackRegressionClient({
      authentication: { mode: "development" },
      endpoint: apiUrl,
      environmentId: summary.scope.environmentId,
      projectId: summary.scope.projectId,
    });
    for (const job of Object.values(summary.jobs)) {
      const persisted = await replay.readReplayJob({ jobId: job.jobId });
      expect(persisted.snapshot.job.status).toBe(job.status);
      expect(persisted.snapshot.attempts.map(({ status }) => status)).toEqual(job.attemptStatuses);
      const result = persisted.snapshot.attempts.at(-1)?.result;
      if (!result) continue;
      const content = await readFile(join(outputRoot, "reports", `${result.artifactId}.json`));
      expect(content.byteLength).toBe(result.sizeBytes);
      expect(createHash("sha256").update(content).digest("hex")).toBe(result.sha256);
      expect(content.toString("utf8")).not.toContain(runtimeRoles.replayWorker.password);
      const persistedArtifact = await regression.readArtifactMetadata({
        artifactId: result.artifactId,
      });
      expect(persistedArtifact.metadata).toMatchObject({
        contentReference: result,
        redaction: { status: "not_required" },
        retention: { mode: "retain" },
        state: "available",
      });
      const persistedContent = await regression.readArtifactContent({
        artifactId: result.artifactId,
      });
      expect(persistedContent).toMatchObject({
        classification: result.classification,
        mediaType: result.mediaType,
        redactionStatus: "not_required",
        sha256: result.sha256,
      });
      expect(Buffer.from(persistedContent.content)).toEqual(content);
    }
    const exactPlan = await replay.readReplayPlan(summary.replayPlan);
    expect(exactPlan.plan.definitionSha256).toBe(summary.replayPlan.definitionSha256);
    const exactRelease = await replay.readTargetRelease(summary.targetRelease);
    expect(exactRelease.release.definitionSha256).toBe(summary.targetRelease.definitionSha256);
  });
});
