import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  type ApiConfig,
  createApp,
  LocalGitReleaseCandidateRevisionAuthority,
  StaticReleaseCandidateRuntimeAuthority,
} from "@proofstack/api/composition";
import {
  type PrincipalContext,
  type ReleaseCandidateSource,
  ReleaseCandidateSourceSchema,
  TraceResponseSchema,
} from "@proofstack/contracts";
import { AuthoritySplitModelAssuranceRepository, SystemClock } from "@proofstack/core";
import {
  createPostgresEvaluationWorker,
  type PostgresEvaluationWorkerRuntime,
} from "@proofstack/evaluation-worker";
import {
  runWorkflow2ReleaseCandidate,
  WORKFLOW_2_REFERENCE_MODEL_ADAPTER,
  WORKFLOW_2_REFERENCE_MODEL_DECLARATION,
  type Workflow2ReleaseCandidateSummary,
} from "@proofstack/example-workflow-2-release-candidate/workflow";
import {
  createPostgresModelEvaluationWorker,
  type PostgresModelEvaluationWorkerRuntime,
} from "@proofstack/model-evaluation-worker";
import {
  createPostgresPool,
  migrateDatabase,
  PostgresModelAssuranceRepository,
  provisionRuntimeRoles,
  type RuntimeRoleProvisioningOptions,
} from "@proofstack/postgres";
import { createS3Client } from "@proofstack/s3";
import {
  ProofStackComparisonClient,
  ProofStackEvaluationClient,
  ProofStackModelAssuranceClient,
  ProofStackRegressionClient,
  ProofStackReleaseCandidateClient,
  ProofStackReplayClient,
} from "@proofstack/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  completeWorkflow1Acceptance,
  prepareWorkflow1Acceptance,
  type Workflow1AcceptanceSummary,
} from "./workflow.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for Workflow 1 acceptance integration tests`);
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
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const repositoryUrl = "https://github.com/Kwondh0321/proofstack";
const acceptReleaseCandidate = process.env["PROOFSTACK_ACCEPT_RELEASE_CANDIDATE"] === "true";
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const scope = {
  environmentId: `env_${runKey}_primary`,
  projectId: `prj_${runKey}_primary`,
  tenantId: `ten_${runKey}`,
} as const;
const artifactBucket = `proofstack-acceptance-${runKey}`;
const artifactKeyId = `key_acceptance_${runKey}`;
const artifactKey = Buffer.alloc(32, 47).toString("base64url");
const originalAwsEnvironment = new Map(
  ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"].map((name) => [
    name,
    process.env[name],
  ]),
);

function credentials(kind: string) {
  return { name: `proofstack_accept_${runKey}_${kind}`, password: randomUUID() };
}

const runtimeRoles: RuntimeRoleProvisioningOptions = {
  api: credentials("api"),
  artifact: credentials("artifact"),
  consumer: credentials("consumer"),
  evaluationWorker: credentials("evaluation"),
  humanReviewer: credentials("human"),
  identity: credentials("identity"),
  modelEvaluationWorker: credentials("model"),
  policyAuthor: credentials("policy"),
  publisher: credentials("publisher"),
  replayWorker: credentials("replay"),
};

function roleDatabaseUrl(role: { readonly name: string; readonly password: string }): string {
  const value = new URL(databaseUrl);
  value.username = role.name;
  value.password = role.password;
  return value.toString();
}

const adminPool = createPostgresPool({
  applicationName: "proofstack-workflow-1-acceptance-setup",
  connectionString: databaseUrl,
  maxConnections: 1,
  onIdleError: (error) => {
    throw error;
  },
});
const assuranceControlPool = createPostgresPool({
  applicationName: "proofstack-workflow-1-assurance-control",
  connectionString: roleDatabaseUrl(runtimeRoles.api),
  maxConnections: 2,
  onIdleError: (error) => {
    throw error;
  },
});
const assuranceExecutionPool = createPostgresPool({
  applicationName: "proofstack-workflow-1-assurance-execution",
  connectionString: roleDatabaseUrl(runtimeRoles.modelEvaluationWorker),
  maxConnections: 2,
  onIdleError: (error) => {
    throw error;
  },
});
const assuranceHumanPool = createPostgresPool({
  applicationName: "proofstack-workflow-1-assurance-human",
  connectionString: roleDatabaseUrl(runtimeRoles.humanReviewer),
  maxConnections: 2,
  onIdleError: (error) => {
    throw error;
  },
});
const assuranceRepository = new AuthoritySplitModelAssuranceRepository({
  control: new PostgresModelAssuranceRepository(assuranceControlPool),
  execution: new PostgresModelAssuranceRepository(assuranceExecutionPool),
  humanReview: new PostgresModelAssuranceRepository(assuranceHumanPool),
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
    policyAuthorDatabaseUrl: roleDatabaseUrl(runtimeRoles.policyAuthor),
  },
};

const controlPrincipal: PrincipalContext = {
  authentication: { authenticatedAt: new Date().toISOString(), method: "development" },
  capabilities: [
    "project:read",
    "project:manage",
    "evidence:ingest",
    "evidence:read",
    "artifact:write",
    "artifact:read",
    "artifact:read:restricted",
    "artifact:delete",
    "dataset:read",
    "dataset:manage",
    "replay:read",
    "replay:run",
    "replay:cancel",
    "replay:manage",
    "evaluation:read",
    "evaluation:run",
    "evaluation:model:run",
    "evaluation:human:review",
    "evaluation:manage",
    "comparison:read",
    "comparison:manage",
    "release:read",
    "release:manage",
  ],
  principalId: `usr_acceptance_${runKey}`,
  principalType: "user",
  requestId: `req_acceptance_${runKey}`,
  resourceScope: {
    mode: "restricted",
    projects: [{ environmentIds: [scope.environmentId], projectId: scope.projectId }],
  },
  roles: ["owner"],
  tenantId: scope.tenantId,
};
let selectedPrincipal = controlPrincipal;
const authenticator = { authenticate: async () => structuredClone(selectedPrincipal) };
const clock = new SystemClock();

let apiUrl: string;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let evaluationWorker: PostgresEvaluationWorkerRuntime | undefined;
let modelWorker: PostgresModelEvaluationWorkerRuntime | undefined;
let outputRoot: string | undefined;
let bucketCreated = false;
let rolesCreated = false;

function comparisonClient(): ProofStackComparisonClient {
  return new ProofStackComparisonClient({
    authentication: { mode: "development" },
    endpoint: apiUrl,
    environmentId: scope.environmentId,
    projectId: scope.projectId,
    timeoutMs: 20_000,
  });
}

function evaluationClient(): ProofStackEvaluationClient {
  return new ProofStackEvaluationClient({
    authentication: { mode: "development" },
    endpoint: apiUrl,
    environmentId: scope.environmentId,
    projectId: scope.projectId,
    timeoutMs: 20_000,
  });
}

function modelClient(): ProofStackModelAssuranceClient {
  return new ProofStackModelAssuranceClient({
    authentication: { mode: "development" },
    endpoint: apiUrl,
    environmentId: scope.environmentId,
    projectId: scope.projectId,
    timeoutMs: 20_000,
  });
}

function regressionClient(): ProofStackRegressionClient {
  return new ProofStackRegressionClient({
    authentication: { mode: "development" },
    endpoint: apiUrl,
    environmentId: scope.environmentId,
    projectId: scope.projectId,
    timeoutMs: 20_000,
  });
}

function replayClient(): ProofStackReplayClient {
  return new ProofStackReplayClient({
    authentication: { mode: "development" },
    endpoint: apiUrl,
    environmentId: scope.environmentId,
    projectId: scope.projectId,
    timeoutMs: 20_000,
  });
}

function releaseCandidateClient(): ProofStackReleaseCandidateClient {
  return new ProofStackReleaseCandidateClient({
    authentication: { mode: "development" },
    endpoint: apiUrl,
    environmentId: scope.environmentId,
    projectId: scope.projectId,
    timeoutMs: 20_000,
  });
}

function gitOutput(arguments_: readonly string[]): string {
  return execFileSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function releaseCandidateSource(): ReleaseCandidateSource {
  const algorithm = gitOutput(["rev-parse", "--show-object-format"]);
  const revision = gitOutput(["rev-parse", "HEAD"]);
  const tree = gitOutput(["show", "--no-patch", "--format=%T", revision]);
  return ReleaseCandidateSourceSchema.parse({
    commit: { algorithm, value: revision },
    repositoryUrl,
    tree: { algorithm, value: tree },
  });
}

async function startApi(): Promise<void> {
  selectedPrincipal = controlPrincipal;
  app = await createApp(apiConfig, {
    authenticator,
    clock,
    modelAssuranceRepository: assuranceRepository,
    releaseCandidateRevisionAuthority: new LocalGitReleaseCandidateRevisionAuthority({
      repositories: [{ checkoutPath: repositoryRoot, repositoryUrl, scope }],
    }),
    releaseCandidateRuntimeAuthority: new StaticReleaseCandidateRuntimeAuthority({
      modelDeclarations: [{ declaration: WORKFLOW_2_REFERENCE_MODEL_DECLARATION, scope }],
      runtimeAdapters: [{ adapter: WORKFLOW_2_REFERENCE_MODEL_ADAPTER, scope }],
    }),
  });
  apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
}

async function restartApi(): Promise<void> {
  await app?.close();
  await startApi();
}

async function restartExecutionWorkers(): Promise<void> {
  await evaluationWorker?.close();
  await modelWorker?.close();
  evaluationWorker = await createPostgresEvaluationWorker({
    clock,
    databaseUrl: roleDatabaseUrl(runtimeRoles.evaluationWorker),
    onIdleError: (error) => {
      throw error;
    },
  });
  modelWorker = await createPostgresModelEvaluationWorker({
    clock,
    databaseUrl: roleDatabaseUrl(runtimeRoles.modelEvaluationWorker),
    onIdleError: (error) => {
      throw error;
    },
  });
  await Promise.all([evaluationWorker.checkReadiness(), modelWorker.checkReadiness()]);
}

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

async function verifyCompleteReadBack(summary: Workflow1AcceptanceSummary): Promise<void> {
  const regression = regressionClient();
  const predecessor = await regression.readFixtureVersion(summary.durableReplay.predecessor);
  expect(predecessor.version.definitionSha256).toBe(
    summary.durableReplay.predecessor.definitionSha256,
  );
  const fixture = await regression.readRecordedInteractionFixtureMetadata(
    summary.durableReplay.fixture,
  );
  expect(fixture.version.definitionSha256).toBe(summary.durableReplay.fixture.definitionSha256);
  const dataset = await regression.readDatasetVersion(summary.durableReplay.dataset);
  expect(dataset.version.definitionSha256).toBe(summary.durableReplay.dataset.definitionSha256);

  const replay = replayClient();
  for (const job of Object.values(summary.durableReplay.jobs)) {
    const persisted = await replay.readReplayJob({ jobId: job.jobId });
    expect(persisted.snapshot.job.status).toBe(job.status);
  }
  const plan = await replay.readReplayPlan(summary.durableReplay.replayPlan);
  expect(plan.plan.definitionSha256).toBe(summary.durableReplay.replayPlan.definitionSha256);
  const release = await replay.readTargetRelease(summary.durableReplay.targetRelease);
  expect(release.release.definitionSha256).toBe(
    summary.durableReplay.targetRelease.definitionSha256,
  );

  const evaluation = evaluationClient();
  for (const reference of summary.evaluation.readBack.records) {
    const persisted = await evaluation.readRecord(reference);
    expect(persisted.result.kind).toBe(reference.kind);
    expect(persisted.result.record.definitionSha256).toBe(reference.definitionSha256);
  }
  for (const reference of summary.modelAssurance.readBack.evaluationRecords) {
    const persisted = await evaluation.readRecord(reference);
    expect(persisted.result.kind).toBe(reference.kind);
    expect(persisted.result.record.definitionSha256).toBe(reference.definitionSha256);
  }
  const model = modelClient();
  for (const reference of summary.modelAssurance.readBack.modelRecords) {
    const persisted = await model.readRecord(reference);
    expect(persisted.result.kind).toBe(reference.kind);
    expect(persisted.result.record.definitionSha256).toBe(reference.definitionSha256);
  }
  const comparison = comparisonClient();
  for (const reference of summary.verifiedComparisonRecords) {
    const persisted = await comparison.readRecord(reference);
    expect(persisted.result.kind).toBe(reference.kind);
    expect(persisted.result.record.definitionSha256).toBe(reference.definitionSha256);
  }

  const traceResponse = await fetch(
    new URL(
      `/v1/projects/${scope.projectId}/environments/${scope.environmentId}/traces/${summary.durableReplay.traceId}`,
      apiUrl,
    ),
    { headers: { accept: "application/json" }, redirect: "manual" },
  );
  expect(traceResponse.status).toBe(200);
  const trace = TraceResponseSchema.parse(await traceResponse.json());
  expect(trace.events.map(({ evidence }) => evidence.kind).sort()).toEqual([
    "agent.run",
    "model.generate",
    "tool.execute",
  ]);
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
  outputRoot = await mkdtemp(join(tmpdir(), "proofstack-workflow-1-acceptance-"));
  await startApi();
  evaluationWorker = await createPostgresEvaluationWorker({
    clock,
    databaseUrl: roleDatabaseUrl(runtimeRoles.evaluationWorker),
    onIdleError: (error) => {
      throw error;
    },
  });
  modelWorker = await createPostgresModelEvaluationWorker({
    clock,
    databaseUrl: roleDatabaseUrl(runtimeRoles.modelEvaluationWorker),
    onIdleError: (error) => {
      throw error;
    },
  });
}, 60_000);

afterAll(async () => {
  try {
    await app?.close();
    await evaluationWorker?.close();
    await modelWorker?.close();
    await Promise.all([
      assuranceControlPool.end(),
      assuranceExecutionPool.end(),
      assuranceHumanPool.end(),
    ]);
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

describe("Workflow 1 retained failure-to-comparison acceptance", () => {
  it("resolves one authenticated persisted graph after API and worker restarts without exposing classified content", async () => {
    if (!evaluationWorker || !modelWorker || !outputRoot) {
      throw new Error("Workflow 1 acceptance infrastructure is unavailable");
    }
    const source = releaseCandidateSource();
    const sourceRevision = source.commit.value;
    const assessmentValidUntil = new Date(
      clock.now().getTime() + 24 * 60 * 60 * 1_000,
    ).toISOString();
    const prepared = await prepareWorkflow1Acceptance({
      assessmentValidUntil,
      comparisonClient: comparisonClient(),
      controlPrincipal,
      durableReplay: {
        apiUrl,
        environmentId: scope.environmentId,
        outputRoot,
        projectId: scope.projectId,
        sourceRevision,
        tenantId: scope.tenantId,
        workerDatabaseUrl: roleDatabaseUrl(runtimeRoles.replayWorker),
        workerEntryPointPath: fileURLToPath(
          import.meta.resolve("@proofstack/example-durable-replay/worker"),
        ),
      },
      evaluationClient: evaluationClient(),
      evaluationWorker,
      modelClient: modelClient(),
      modelWorker,
      namespace: runKey,
      selectApiPrincipal: (principal) => {
        selectedPrincipal = principal;
      },
    });

    await Promise.all([restartApi(), restartExecutionWorkers()]);
    const summary = await completeWorkflow1Acceptance(comparisonClient(), prepared);
    expect(summary.snapshots.baseline.integrity).toBe("verified");
    expect(summary.snapshots.candidate.integrity).toBe("verified");
    expect(summary.snapshots.baseline.fixtures).toHaveLength(1);
    expect(summary.snapshots.candidate.fixtures).toHaveLength(1);
    expect(summary.snapshots.baseline.fixtures[0]?.trace.eventCount).toBe(3);
    expect(summary.snapshots.candidate.fixtures[0]?.trace.eventCount).toBe(3);
    expect(
      summary.snapshots.baseline.fixtures[0]?.assurance.map(({ kind }) => kind).sort(),
    ).toEqual(["assessment", "model_assurance"]);
    expect(
      summary.snapshots.candidate.fixtures[0]?.assurance.map(({ kind }) => kind).sort(),
    ).toEqual(["assessment", "model_assurance"]);
    expect(summary.snapshots.baseline.fixtures[0]?.evaluationOutcomes).toEqual([
      expect.objectContaining({
        counts: { abstain: 1, error: 0, fail: 1, notApplicable: 0, pass: 1, total: 3 },
      }),
    ]);
    expect(summary.snapshots.candidate.fixtures[0]?.evaluationOutcomes).toEqual([
      expect.objectContaining({
        counts: { abstain: 0, error: 1, fail: 0, notApplicable: 1, pass: 0, total: 2 },
      }),
    ]);
    expect(summary.snapshots.baseline.omissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectionKey: "classified_content",
          reason: "classified_content_excluded",
        }),
      ]),
    );
    expect(summary.snapshots.candidate.omissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectionKey: "classified_content",
          reason: "classified_content_excluded",
        }),
      ]),
    );
    const sensitiveMarker = `customer-sensitive-${summary.durableReplay.traceId.slice(0, 12)}`;
    expect(JSON.stringify(summary.snapshots)).not.toContain(sensitiveMarker);
    expect(summary.result.pairing).toMatchObject({
      invalidCount: 0,
      pairedCount: 1,
      requestedCount: 1,
    });
    expect(summary.result.comparability).toEqual({
      reasons: ["unresolved_critical_counterevidence"],
      status: "incomparable",
    });
    expect(summary.verifiedComparisonRecords).toHaveLength(4);

    let releaseCandidate: Workflow2ReleaseCandidateSummary | undefined;
    if (acceptReleaseCandidate) {
      releaseCandidate = await runWorkflow2ReleaseCandidate({
        candidateClient: releaseCandidateClient(),
        fixtureReader: regressionClient(),
        namespace: runKey,
        source,
        targetReleaseReader: replayClient(),
        workflow1: summary,
      });
      expect(releaseCandidate.idempotentRetryConfirmed).toBe(true);
      expect(releaseCandidate.candidate.source).toEqual(source);
      expect(releaseCandidate.exactReferences).toMatchObject({
        comparisonResultId: summary.result.resultId,
        datasetVersionId: summary.durableReplay.dataset.datasetVersionId,
        targetReleaseId: summary.durableReplay.targetRelease.targetReleaseId,
      });
    }

    await restartApi();
    await verifyCompleteReadBack(summary);
    if (releaseCandidate) {
      const restored = await releaseCandidateClient().readCandidate({
        candidateId: releaseCandidate.candidate.candidateId,
        candidateVersionId: releaseCandidate.candidate.candidateVersionId,
      });
      expect(restored.candidate).toEqual(releaseCandidate.candidate);
    }
  });
});
