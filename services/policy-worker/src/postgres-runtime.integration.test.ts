import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import {
  ArtifactCipher,
  LocalArtifactKeyring,
  ReserveArtifact,
  UploadArtifact,
  SecureArtifactIdentityGenerator,
  StrictArtifactContentInspector,
} from "@proofstack/artifacts";
import { PrincipalContextSchema, type PolicyEvaluationRequest } from "@proofstack/contracts";
import {
  digestReleaseCandidateDefinition,
  digestPolicyEvaluationRequestDefinition,
  readCompletePolicyEvaluationSnapshot,
} from "@proofstack/core";
import {
  releaseCandidateFixture,
  releasePolicyRepositoryFixture,
  policyJobConformanceRequest,
} from "@proofstack/core/testing";
import {
  generateServiceToken,
  hashServiceTokenSecret,
  ServiceTokenAuthenticator,
} from "@proofstack/identity";
import {
  createPostgresPool,
  createPolicyPostgresPool,
  migrateDatabase,
  provisionRuntimeRoles,
  PostgresArtifactCatalogRepository,
  PostgresReleaseCandidateRepository,
  PostgresReleasePolicyRepository,
  PostgresPolicyEvaluationJobControlRepository,
  PostgresPolicyEvaluationJobWorkerRepository,
  PostgresPolicySnapshotRepository,
  PostgresPolicyEvaluationResultRepository,
  type RuntimeRoleProvisioningOptions,
} from "@proofstack/postgres";
import { createS3ArtifactObjectStore, createS3Client } from "@proofstack/s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPolicyWorkerAttempt } from "./attempt.js";
import {
  createPostgresPolicyWorkerRuntime,
  createS3PolicyWorkerArtifacts,
} from "./postgres-runtime.js";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for policy worker integration`);
  return value;
}
const databaseUrl = required("PROOFSTACK_TEST_DATABASE_URL");
if (new URL(databaseUrl).pathname !== "/proofstack_test")
  throw new Error("Policy worker integration requires disposable proofstack_test");
const tag = randomUUID().replaceAll("-", "").slice(0, 12);
const scope = {
  tenantId: `tenant_runtime_${tag}`,
  projectId: `project_runtime_${tag}`,
  environmentId: `env_runtime_${tag}`,
};
const role = (kind: string) => ({
  name: `ps_pwrk_${kind}_${tag}`,
  password: `test-only-${kind}-${tag}`,
});
const roles: RuntimeRoleProvisioningOptions = {
  api: role("api"),
  artifact: role("artifact"),
  consumer: role("consumer"),
  evaluationWorker: role("evaluation"),
  humanReviewer: role("reviewer"),
  identity: role("identity"),
  modelEvaluationWorker: role("model"),
  policyAuthor: role("author"),
  publisher: role("publisher"),
  replayWorker: role("replay"),
  policyEvaluationControl: role("control"),
  policyEvaluator: role("worker"),
};
const idleErrors: Error[] = [];
const pool = (url: string) =>
  createPostgresPool({
    connectionString: url,
    maxConnections: 2,
    onIdleError: (error) => idleErrors.push(error),
  });
const admin = pool(databaseUrl);
const roleUrl = (credentials: { name: string; password: string }) => {
  const url = new URL(databaseUrl);
  url.username = credentials.name;
  url.password = credentials.password;
  return url.toString();
};
const api = pool(roleUrl(roles.api)),
  author = pool(roleUrl(roles.policyAuthor)),
  controlPool = createPolicyPostgresPool({
    connectionString: roleUrl(roles.policyEvaluationControl!),
    maxConnections: 2,
    onIdleError: (error) => idleErrors.push(error),
  });
const control = new PostgresPolicyEvaluationJobControlRepository(controlPool);
const workerPool = createPolicyPostgresPool({
  connectionString: roleUrl(roles.policyEvaluator!),
  maxConnections: 2,
  onIdleError: (error) => idleErrors.push(error),
});
const worker = new PostgresPolicyEvaluationJobWorkerRepository(workerPool);
const connection = {
  allowInsecureLoopback: true,
  forcePathStyle: true,
  credentials: {
    accessKeyId: required("PROOFSTACK_TEST_S3_ACCESS_KEY_ID"),
    secretAccessKey: required("PROOFSTACK_TEST_S3_SECRET_ACCESS_KEY"),
  },
  endpoint: required("PROOFSTACK_TEST_S3_ENDPOINT"),
  region: required("PROOFSTACK_TEST_S3_REGION"),
};
const bucket = `proofstack-policy-worker-${tag}`;
const bucketClient = createS3Client(connection);
const objects = createS3ArtifactObjectStore({ ...connection, bucket });
const encryption = new ArtifactCipher(
  new LocalArtifactKeyring({
    activeKeyId: "key_policy_runtime",
    keys: { key_policy_runtime: Buffer.alloc(32, 73) },
  }),
);
const token = generateServiceToken();
let authenticator: ServiceTokenAuthenticator;
let request: PolicyEvaluationRequest;
let encryptedBytes = 0;
const objectReads: number[] = [];
let resourcesClosed = 0;
let credentialDirectory: string;
let credentialFile: string;

beforeAll(async () => {
  await migrateDatabase(admin);
  await provisionRuntimeRoles(admin, roles);
  await bucketClient.send(new CreateBucketCommand({ Bucket: bucket }));
  const bytes = Buffer.from('{"fixture":"actual encrypted policy worker object"}');
  const clock = { now: () => new Date(Date.now() - 5000) };
  const writer = PrincipalContextSchema.parse({
    principalType: "workload",
    principalId: "worker_artifact_writer",
    tenantId: scope.tenantId,
    roles: ["ingest"],
    capabilities: ["artifact:write"],
    authentication: {
      method: "api_key",
      credentialId: "credential_writer",
      authenticatedAt: new Date().toISOString(),
    },
    resourceScope: {
      mode: "restricted",
      projects: [{ projectId: scope.projectId, environmentIds: [scope.environmentId] }],
    },
    requestId: "request_artifact_writer",
  });
  const catalog = new PostgresArtifactCatalogRepository(api);
  const artifactId = `artifact_runtime_${tag}`;
  await new ReserveArtifact({
    catalog,
    clock,
    encryption,
    identities: new SecureArtifactIdentityGenerator(),
  }).execute({
    principal: writer,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    request: {
      artifactId,
      classification: "internal",
      mediaType: "application/json",
      redaction: { status: "not_required" },
      retention: { mode: "retain" },
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    },
  });
  await new UploadArtifact({
    catalog,
    clock,
    encryption,
    objects,
    inspection: new StrictArtifactContentInspector(),
  }).execute({
    principal: writer,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    artifactId,
    content: bytes,
  });
  const stored = await catalog.find(scope, artifactId);
  if (!stored?.objectReceipt) throw new Error("Actual artifact upload missing");
  encryptedBytes = stored.objectReceipt.sizeBytes;
  const candidate = releaseCandidateFixture(`runtime_${tag}`, scope);
  candidate.buildArtifacts[0]!.artifact = stored.metadata.contentReference;
  const {
    definitionSha256: _sha,
    scope: _scope,
    schemaVersion: _version,
    createdAt: _at,
    createdByPrincipalId: _actor,
    ...definition
  } = candidate;
  candidate.definitionSha256 = digestReleaseCandidateDefinition(scope, definition);
  await new PostgresReleaseCandidateRepository(api).publishReleaseCandidate(candidate);
  const policy = releasePolicyRepositoryFixture(`runtime_${tag}`, scope);
  await new PostgresReleasePolicyRepository(author).publishReleasePolicy(policy);
  request = policyJobConformanceRequest(scope);
  request.evaluationRequestId = `request_runtime_${tag}`;
  request.createdAt = new Date().toISOString();
  request.evaluationTime = request.createdAt;
  request.candidate = {
    candidateId: candidate.candidateId,
    candidateVersionId: candidate.candidateVersionId,
    definitionSha256: candidate.definitionSha256,
  };
  request.policy = {
    policyId: policy.policyId,
    policyVersionId: policy.policyVersionId,
    definitionSha256: policy.definitionSha256,
  };
  request.limits.leaseDurationMilliseconds = 60000;
  const {
    definitionSha256: _requestSha,
    scope: _requestScope,
    schemaVersion: _requestVersion,
    createdAt: _requestAt,
    createdByPrincipalId: _requestActor,
    ...requestDefinition
  } = request;
  request.definitionSha256 = digestPolicyEvaluationRequestDefinition(scope, requestDefinition);
  const record = {
    kind: "service_token" as const,
    prefix: token.prefix,
    passwordHash: await hashServiceTokenSecret(token.secret),
    credentialId: `credential_runtime_${tag}`,
    principalId: `worker_runtime_${tag}`,
    tenantId: scope.tenantId,
    capabilities: ["policy:evaluation:execute", "artifact:read"] as const,
    resourceScope: {
      mode: "restricted" as const,
      projects: [{ projectId: scope.projectId, environmentIds: [scope.environmentId] }],
    },
  };
  authenticator = new ServiceTokenAuthenticator({
    findActiveServiceByPrefix: async (prefix) =>
      prefix === record.prefix ? { ...record, authenticatedAt: new Date().toISOString() } : null,
    confirmActiveServiceUse: async (expected) =>
      JSON.stringify(expected) === JSON.stringify(record),
  });
  credentialDirectory = await mkdtemp(join(tmpdir(), "proofstack-native-worker-credentials-"));
  await chmod(credentialDirectory, 0o700);
  credentialFile = join(credentialDirectory, "credentials.json");
  await writeFile(
    credentialFile,
    JSON.stringify({
      schemaVersion: "0.1",
      revision: "catalogue_native",
      credentials: [
        {
          ...record,
          status: "active",
          notBefore: new Date(Date.now() - 60000).toISOString(),
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        },
      ],
    }),
    { mode: 0o600, flag: "wx" },
  );
});
afterAll(async () => {
  objects.destroy();
  bucketClient.destroy();
  await Promise.all([api.end(), author.end(), controlPool.end(), workerPool.end(), admin.end()]);
  if (credentialDirectory) await rm(credentialDirectory, { recursive: true, force: true });
  // The uniquely named disposable service fixture retains DB/object data for diagnostics.
  expect(idleErrors).toEqual([]);
});

function execute(
  jobId: string,
  workerDatabaseUrl = roleUrl(roles.policyEvaluator!),
  workerDatabaseRole = roles.policyEvaluator!.name,
) {
  return runPolicyWorkerAttempt(
    {
      serviceToken: token.value,
      requestId: `delivery_${tag}`,
      delivery: {
        schemaVersion: "0.1",
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        jobId,
      },
    },
    {
      authenticator,
      nextId: (kind) => `${kind}_${randomUUID().replaceAll("-", "")}`,
      createRuntime: (exact, principal) =>
        createPostgresPolicyWorkerRuntime(
          { scope: exact, principal },
          {
            databaseUrl: workerDatabaseUrl,
            databaseRole: workerDatabaseRole,
            allowPlaintextLoopback: true,
            onIdleError: (error) => idleErrors.push(error),
            async openArtifacts() {
              const resource = createS3PolicyWorkerArtifacts({ ...connection, bucket }, encryption);
              return {
                ...resource,
                reader: {
                  async get(key, bound) {
                    const active = await admin.query<{ count: number }>(
                      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='proofstack-policy-worker' AND state != 'idle'",
                    );
                    expect(active.rows[0]!.count).toBe(0);
                    objectReads.push(bound.expectedBytes);
                    return resource.reader.get(key, bound);
                  },
                },
                close() {
                  resourcesClosed++;
                  return resource.close();
                },
              };
            },
          },
        ),
    },
  );
}
async function queued(suffix: string, shortLease = false) {
  const jobId = `job_${suffix}_${tag}`;
  const next = {
    ...request,
    limits: { ...request.limits },
    evaluationRequestId: `request_${suffix}_${tag}`,
  };
  if (shortLease) {
    next.limits.leaseDurationMilliseconds = 10000;
    next.limits.heartbeatIntervalMilliseconds = 1000;
    next.limits.retryBackoffMilliseconds = 0;
  }
  const {
    definitionSha256: _sha,
    scope: _scope,
    schemaVersion: _version,
    createdAt: _at,
    createdByPrincipalId: _actor,
    ...definition
  } = next;
  next.definitionSha256 = digestPolicyEvaluationRequestDefinition(scope, definition);
  const created = await control.createJob({ request: next, jobId });
  return { jobId, created: created.snapshot };
}
function launch(jobId: string, serviceToken = token.value, endpoint = connection.endpoint) {
  const p = "PROOFSTACK_POLICY_WORKER_";
  const environment: NodeJS.ProcessEnv = {
    PROOFSTACK_ENV: "test",
    AWS_EC2_METADATA_DISABLED: "true",
    [p + "SERVICE_TOKEN"]: serviceToken,
    [p + "CREDENTIALS_FILE"]: credentialFile,
    [p + "DATABASE_URL"]: roleUrl(roles.policyEvaluator!),
    [p + "DATABASE_ROLE"]: roles.policyEvaluator!.name,
    [p + "S3_BUCKET"]: bucket,
    [p + "S3_REGION"]: connection.region,
    [p + "S3_ENDPOINT"]: endpoint,
    [p + "S3_FORCE_PATH_STYLE"]: "true",
    [p + "S3_ACCESS_KEY_ID"]: connection.credentials.accessKeyId,
    [p + "S3_SECRET_ACCESS_KEY"]: connection.credentials.secretAccessKey,
    [p + "KEYRING_ACTIVE_KEY_ID"]: "key_policy_runtime",
    [p + "KEYRING_KEYS"]: JSON.stringify({
      key_policy_runtime: Buffer.alloc(32, 73).toString("base64url"),
    }),
  };
  let commandProcess!: ReturnType<typeof execFile>;
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    commandProcess = execFile(
      process.execPath,
      [
        fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
        "execute",
        scope.projectId,
        scope.environmentId,
        jobId,
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: environment,
        timeout: 20000,
        maxBuffer: 65536,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number" && !error.signal) {
          reject(new Error("Owned policy worker process failed to run"));
          return;
        }
        const output = stdout + stderr;
        const secrets = [
          token.value,
          serviceToken,
          connection.credentials.secretAccessKey,
          Buffer.alloc(32, 73).toString("base64url"),
          environment[p + "KEYRING_KEYS"]!,
        ];
        if (secrets.some((secret) => output.includes(secret))) {
          reject(new Error("Owned policy worker output exposed private fixture data"));
          return;
        }
        resolve({
          code: typeof error?.code === "number" ? error.code : error ? null : 0,
          signal: error?.signal ?? null,
          stdout,
          stderr,
        });
      },
    );
  });
  void completion.catch(() => {});
  return { commandProcess, completion };
}
function child(jobId: string, serviceToken = token.value) {
  return launch(jobId, serviceToken).completion;
}
async function stopOwned(running: ReturnType<typeof launch>) {
  if (
    running.commandProcess &&
    running.commandProcess.exitCode === null &&
    running.commandProcess.signalCode === null
  )
    running.commandProcess.kill("SIGKILL");
  await running.completion.catch(() => {});
}
async function expiredAtDatabase(expiresAt: string) {
  await expect
    .poll(
      async () => {
        const result = await admin.query<{ elapsed: boolean }>(
          "SELECT clock_timestamp() >= $1::timestamptz AS elapsed",
          [expiresAt],
        );
        return result.rows[0]!.elapsed;
      },
      { timeout: 11000, interval: 25 },
    )
    .toBe(true);
}
async function objectBarrier() {
  const target = new URL(connection.endpoint);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname))
    throw new Error("Disposable object proxy requires loopback HTTP S3");
  let startedResolve!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const upstreams = new Set<ReturnType<typeof httpRequest>>();
  const forward = async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    startedResolve();
    await gate;
    if (incoming.destroyed || outgoing.destroyed) return;
    const upstream = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstreams.add(upstream);
    upstream.on("close", () => upstreams.delete(upstream));
    upstream.on("error", () => outgoing.destroy());
    incoming.on("aborted", () => upstream.destroy());
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  };
  const server = createServer((incoming, outgoing) => {
    void forward(incoming, outgoing).catch(() => outgoing.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing private proxy address");
  return {
    started,
    release,
    endpoint: `http://127.0.0.1:${address.port}`,
    async close() {
      release();
      for (const upstream of upstreams) upstream.destroy();
      const closing = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await closing;
    },
  };
}
async function originalMaterial(jobId: string) {
  const graph = (await control.findJob(scope, jobId))!;
  const material = await readCompletePolicyEvaluationSnapshot(
    new PostgresPolicySnapshotRepository(controlPool),
    {
      scope,
      job: { jobId, definitionSha256: graph.job.definitionSha256 },
      request: graph.job.request,
      snapshot: graph.job.snapshot!,
    },
  );
  return { graph, material };
}
describe("real native policy worker composition with encrypted S3", () => {
  it("captures actual bytes outside SQL, seals and completes atomically, then reobserves the immutable result", async () => {
    const jobId = `job_runtime_${tag}`;
    await control.createJob({ request, jobId });
    const first = await execute(jobId);
    expect(first.disposition).toBe("completed");
    expect(first.job.job.status).toBe("completed");
    expect(first.evaluation).not.toBeNull();
    expect(first.evaluation!.rules.some((rule) => rule.outcome === "indeterminate")).toBe(true);
    expect(objectReads.length).toBeGreaterThan(0);
    expect(objectReads.every((bytes) => bytes === encryptedBytes)).toBe(true);
    expect(first.job.usage.artifactReadBytes).toBe(objectReads.length * encryptedBytes);
    expect(first.job.usage.ruleEvaluations).toBe(first.evaluation!.rules.length);
    expect(first.job.acquisitionAllowance).toBeNull();
    expect(first.job.attempts).toHaveLength(1);
    const readCount = objectReads.length;
    const retry = await execute(jobId);
    expect(retry.disposition).toBe("observed_terminal");
    expect(retry.job).toEqual(first.job);
    expect(retry.evaluation).toEqual(first.evaluation);
    expect(objectReads).toHaveLength(readCount);
    expect(resourcesClosed).toBe(2);
    expect(await control.findJob(scope, jobId)).toEqual(first.job);
  });
  it("does not turn control-role credentials into native worker authority", async () => {
    const jobId = `job_control_denied_${tag}`;
    const denied = { ...request, evaluationRequestId: `request_control_denied_${tag}` };
    const {
      definitionSha256: _sha,
      scope: _scope,
      schemaVersion: _version,
      createdAt: _at,
      createdByPrincipalId: _actor,
      ...definition
    } = denied;
    denied.definitionSha256 = digestPolicyEvaluationRequestDefinition(scope, definition);
    const created = await control.createJob({ request: denied, jobId });
    const reads = objectReads.length;
    await expect(
      execute(jobId, roleUrl(roles.policyEvaluationControl!), roles.policyEvaluationControl!.name),
    ).rejects.toThrow();
    expect(await control.findJob(scope, jobId)).toEqual(created.snapshot);
    expect(objectReads).toHaveLength(reads);
  });
  it("runs the actual executable with private file authentication and retains original result on process restart", async () => {
    const { jobId } = await queued("process");
    const first = await child(jobId);
    expect(first.code).toBe(0);
    expect(first.stderr).toBe("");
    const receipt = JSON.parse(first.stdout);
    expect(receipt).toMatchObject({
      schemaVersion: "0.1",
      disposition: "completed",
      scope,
      job: { jobId, status: "completed" },
    });
    const original = (await control.findJob(scope, jobId))!;
    expect(original.attempts).toHaveLength(1);
    const material = await readCompletePolicyEvaluationSnapshot(
      new PostgresPolicySnapshotRepository(controlPool),
      {
        scope,
        job: { jobId, definitionSha256: original.job.definitionSha256 },
        request: original.job.request,
        snapshot: original.job.snapshot!,
      },
    );
    expect(material).not.toBeNull();
    const evaluation = await new PostgresPolicyEvaluationResultRepository(controlPool).findResult(
      scope,
      jobId,
      material!.pageSet,
    );
    expect(evaluation).not.toBeNull();
    expect(receipt.result).toEqual(original.job.result);
    expect(receipt.snapshot).toEqual(original.job.snapshot);
    expect(receipt.ruleOutcomes).toEqual(
      Object.fromEntries(
        ["satisfied", "violated", "indeterminate", "not_applicable"].map((outcome) => [
          outcome,
          evaluation!.rules.filter((rule) => rule.outcome === outcome).length,
        ]),
      ),
    );
    expect(receipt.ruleOutcomes.indeterminate).toBeGreaterThan(0);
    expect(original.usage.artifactReadBytes).toBeGreaterThanOrEqual(encryptedBytes);
    expect(original.usage.ruleEvaluations).toBe(evaluation!.rules.length);
    const second = await child(jobId);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({
      disposition: "observed_terminal",
      result: original.job.result,
      snapshot: original.job.snapshot,
    });
    expect(await control.findJob(scope, jobId)).toEqual(original);
  });
  it("refuses a wrong process token without writing any job state or fees", async () => {
    const { jobId, created } = await queued("bad_token");
    const denied = await child(jobId, `pss_v1_${token.prefix}_${generateServiceToken().secret}`);
    expect(denied.code).toBe(1);
    expect(denied.stdout).toBe("");
    expect(denied.stderr).toContain("Policy worker command failed");
    expect(await control.findJob(scope, jobId)).toEqual(created);
  });
  it("refuses insecure credential file permissions in a separate process before job writes", async () => {
    const { jobId, created } = await queued("bad_permissions");
    await chmod(credentialFile, 0o644);
    try {
      const denied = await child(jobId);
      expect(denied.code).toBe(1);
      expect(denied.stdout).toBe("");
      expect(await control.findJob(scope, jobId)).toEqual(created);
    } finally {
      await chmod(credentialFile, 0o600);
    }
  });
  it("retains committed acquisition costs after process death before sealing and reclaims only at DB expiry", async () => {
    const { jobId, created } = await queued("crash_content", true),
      barrier = await objectBarrier();
    const running = launch(jobId, token.value, barrier.endpoint);
    try {
      await Promise.race([
        barrier.started,
        running.completion.then(() => {
          throw new Error("Worker exited before actual object barrier");
        }),
      ]);
      const observed = (await control.findJob(scope, jobId))!;
      expect(observed.job.status).toBe("acquiring");
      expect(observed.job.snapshot).toBeNull();
      expect(observed.acquisitionAllowance).not.toBeNull();
      expect(observed.usage.artifactReadBytes).toBeGreaterThan(0);
      running.commandProcess.kill("SIGKILL");
      expect((await running.completion).signal).toBe("SIGKILL");
      await expiredAtDatabase(observed.job.currentLease!.expiresAt);
      const reclaimed = await worker.reclaimJob({ scope, jobId });
      expect(reclaimed.job.status).toBe("budget_exhausted");
      expect(reclaimed.job.snapshot).toBeNull();
      expect(reclaimed.job.result).toBeNull();
      expect(reclaimed.request).toEqual(created.request);
      expect(reclaimed.acquisitionAllowance).toBeNull();
      expect(reclaimed.usage.reads).toBe(request.limits.maxAcquisitionRecords);
      expect(reclaimed.usage.artifactReadBytes).toBe(observed.usage.artifactReadBytes);
      expect(reclaimed.attempts[0]!.closure).toMatchObject({
        status: "interrupted",
        reason: "lease_expired",
      });
      const restarted = await child(jobId);
      expect(restarted.code).toBe(2);
      expect(JSON.parse(restarted.stdout).job.status).toBe("budget_exhausted");
      expect(await control.findJob(scope, jobId)).toEqual(reclaimed);
    } finally {
      await stopOwned(running);
      await barrier.close();
    }
  });
  it("cancels while an actual object read is blocked and prevents later snapshot/result publication", async () => {
    const { jobId } = await queued("cancel_content"),
      barrier = await objectBarrier();
    const running = launch(jobId, token.value, barrier.endpoint);
    try {
      await Promise.race([
        barrier.started,
        running.completion.then(() => {
          throw new Error("Worker exited before actual object barrier");
        }),
      ]);
      const before = (await control.findJob(scope, jobId))!;
      expect(before.job.status).toBe("acquiring");
      const cancelled = await control.cancelJob({
        scope,
        jobId,
        cancellationId: `cancel_content_${tag}`,
        principalId: "controller_native",
        reason: "operator_requested",
      });
      expect(cancelled.job.status).toBe("cancelled");
      expect(cancelled.job.snapshot).toBeNull();
      expect(cancelled.job.result).toBeNull();
      barrier.release();
      const outcome = await running.completion;
      expect(outcome.code).toBe(1);
      expect(outcome.stdout).toBe("");
      expect(await control.findJob(scope, jobId)).toEqual(cancelled);
      expect(cancelled.usage.artifactReadBytes).toBe(before.usage.artifactReadBytes);
      expect(cancelled.usage.reads).toBe(request.limits.maxAcquisitionRecords);
      const restarted = await child(jobId);
      expect(restarted.code).toBe(2);
      expect(JSON.parse(restarted.stdout)).toMatchObject({
        job: { status: "cancelled" },
        snapshot: null,
        result: null,
        ruleOutcomes: null,
      });
      expect(await control.findJob(scope, jobId)).toEqual(cancelled);
    } finally {
      await stopOwned(running);
      await barrier.close();
    }
  });
  it("restarts after a committed seal with the same original pages and a new deciding fence after process death", async () => {
    const { jobId } = await queued("crash_sealed", true),
      gateClient = await admin.connect();
    const key = BigInt(`0x${tag}`).toString(),
      functionName = `proofstack_test_seal_barrier_${tag}`,
      triggerName = `proofstack_test_seal_barrier_${tag}`;
    let started: ReturnType<typeof launch> | undefined;
    try {
      // Every interpolated identifier/value is a fixed prefix plus the fixture's canonical hex tag.
      await admin.query(
        `CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $barrier$ BEGIN IF NEW.tenant_id='${scope.tenantId}' AND NEW.project_id='${scope.projectId}' AND NEW.environment_id='${scope.environmentId}' AND NEW.job_id='${jobId}' AND NEW.operation='start_computation' THEN PERFORM pg_catalog.pg_advisory_xact_lock(${key}::bigint); END IF; RETURN NEW; END; $barrier$`,
      );
      await admin.query(`REVOKE ALL ON FUNCTION public.${functionName}() FROM PUBLIC`);
      await admin.query(
        `CREATE TRIGGER ${triggerName} BEFORE INSERT ON public.proofstack_policy_evaluation_job_history FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`,
      );
      const gatePid = (await gateClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]!.pid;
      await gateClient.query("SELECT pg_advisory_lock($1::bigint)", [key]);
      const running = launch(jobId);
      started = running;
      await Promise.race([
        expect
          .poll(
            async () => {
              const observed = await admin.query<{ waiting: boolean }>(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='proofstack-policy-worker' AND $1::int=ANY(pg_blocking_pids(pid)) AND wait_event='advisory') AS waiting",
                [gatePid],
              );
              return observed.rows[0]!.waiting;
            },
            { timeout: 4000, interval: 5 },
          )
          .toBe(true),
        running.completion.then(() => {
          throw new Error("Worker exited before native post-seal barrier");
        }),
      ]);
      // Kill immediately while the real bounded mutation is blocked; do not relax native timeouts.
      running.commandProcess.kill("SIGKILL");
      expect((await running.completion).signal).toBe("SIGKILL");
      await gateClient.query("SELECT pg_advisory_unlock($1::bigint)", [key]);
      const before = await originalMaterial(jobId);
      expect(before.graph.job.status).toBe("sealed");
      expect(before.material).not.toBeNull();
      expect(before.graph.usage.ruleEvaluations).toBe(0);
      const oldFence = before.graph.job.currentLease!.mutationFence;
      await expiredAtDatabase(before.graph.job.currentLease!.expiresAt);
      const restarted = await child(jobId);
      expect(restarted.code).toBe(0);
      const after = await originalMaterial(jobId);
      expect(after.graph.job.status).toBe("completed");
      expect(after.graph.attempts).toHaveLength(2);
      expect(after.graph.job.snapshot).toEqual(before.graph.job.snapshot);
      expect(after.material).toEqual(before.material);
      expect(after.graph.request).toEqual(before.graph.request);
      expect(after.graph.attempts[0]!.closure).toMatchObject({
        status: "interrupted",
        reason: "lease_expired",
      });
      expect(after.graph.attempts[1]!.mutationFence.fencingToken).toBeGreaterThan(
        oldFence.fencingToken,
      );
      const receipt = JSON.parse(restarted.stdout);
      const paidRules = Object.values(receipt.ruleOutcomes as Record<string, number>).reduce(
        (sum, count) => sum + count,
        0,
      );
      expect(after.graph.usage).toEqual({ ...before.graph.usage, ruleEvaluations: paidRules });
      await expect(worker.startComputation({ scope, fence: oldFence })).rejects.toThrow();
    } finally {
      try {
        if (started) await stopOwned(started);
      } finally {
        try {
          await gateClient.query("SELECT pg_advisory_unlock_all()");
        } finally {
          gateClient.release();
        }
        await admin.query(
          `DROP TRIGGER IF EXISTS ${triggerName} ON public.proofstack_policy_evaluation_job_history`,
        );
        await admin.query(`DROP FUNCTION IF EXISTS public.${functionName}()`);
      }
    }
  });
});
