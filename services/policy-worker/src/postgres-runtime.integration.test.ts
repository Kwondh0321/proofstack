import { createHash, randomUUID } from "node:crypto";
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
});
afterAll(async () => {
  objects.destroy();
  bucketClient.destroy();
  await Promise.all([api.end(), author.end(), controlPool.end(), admin.end()]);
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
});
