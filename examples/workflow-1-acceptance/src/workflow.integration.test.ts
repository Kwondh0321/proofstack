import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
  ArtifactContentReferenceSchema,
  type PolicyInstallationBindingDefinition,
  type PrincipalContext,
  type PublishReleasePolicyLifecycleRequest,
  PublishReleasePolicyLifecycleRequestSchema,
  type PublishReleasePolicyRequest,
  PublishReleasePolicyRequestSchema,
  type ReleaseCandidateSource,
  ReleaseCandidateSourceSchema,
  type ReleasePolicy,
  type ReleasePolicyDefinition,
  type ReleasePolicyLifecycleEvent,
  type SourceReviewDefinition,
  SourceReviewDefinitionSchema,
  type SourceReviewerQualificationDefinition,
  SourceReviewerQualificationDefinitionSchema,
  type SourceSnapshotDefinition,
  SourceSnapshotDefinitionSchema,
  TraceResponseSchema,
} from "@proofstack/contracts";
import {
  AuthoritySplitModelAssuranceRepository,
  StaticPolicyInstallationBindingResolver,
  SystemClock,
} from "@proofstack/core";
import { type PolicyAuthorityFixture, policyAuthorityFixture } from "@proofstack/core/testing";
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
  runWorkflow2ReleasePolicy,
  type Workflow2ReleasePolicySummary,
} from "@proofstack/example-workflow-2-release-policy/workflow";
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
  ProofStackReleasePolicyClient,
  ProofStackReplayClient,
} from "@proofstack/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  completeWorkflow1Acceptance,
  prepareWorkflow1Acceptance,
  type Workflow1AcceptanceSummary,
} from "./workflow.js";

type ArtifactContentReference = ReturnType<typeof ArtifactContentReferenceSchema.parse>;

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
const acceptReleasePolicy = process.env["PROOFSTACK_ACCEPT_RELEASE_POLICY"] === "true";
const acceptReleaseCandidate =
  acceptReleasePolicy || process.env["PROOFSTACK_ACCEPT_RELEASE_CANDIDATE"] === "true";
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
    "policy:read",
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

interface RetainedPolicyArtifact {
  readonly bytes: Uint8Array;
  readonly reference: ArtifactContentReference;
}

interface ReleasePolicyAcceptanceScenario {
  readonly artifacts: ReadonlyMap<string, RetainedPolicyArtifact>;
  readonly fixture: PolicyAuthorityFixture;
  readonly lifecycleRequest: PublishReleasePolicyLifecycleRequest;
  readonly principals: {
    readonly artifactCustodian: PrincipalContext;
    readonly credentialAuthority: PrincipalContext;
    readonly policyIssuer: PrincipalContext;
    readonly sourcePublisher: PrincipalContext;
    readonly sourceReviewer: PrincipalContext;
  };
  readonly request: PublishReleasePolicyRequest;
}

interface PolicyAuthorityRecordReference {
  readonly definitionSha256: string;
  readonly kind: "source_review" | "source_reviewer_qualification" | "source_snapshot";
  readonly recordId: string;
}

function scopedPrincipal(
  principalId: string,
  capabilities: PrincipalContext["capabilities"],
): PrincipalContext {
  return {
    ...structuredClone(controlPrincipal),
    authentication: { authenticatedAt: clock.now().toISOString(), method: "development" },
    capabilities: [...capabilities],
    principalId,
    requestId: `req_${principalId}`,
    roles: ["member"],
  };
}

function offsetTimestamp(from: Date, milliseconds: number): string {
  return new Date(from.getTime() + milliseconds).toISOString();
}

function retainedPolicyDefinition<Definition>(
  input: Definition,
  artifacts: Map<string, RetainedPolicyArtifact>,
): Definition {
  const definition = structuredClone(input);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const candidate = value as Record<string, unknown>;
    const parsed = ArtifactContentReferenceSchema.safeParse(candidate);
    if (parsed.success) {
      const artifactId = `${parsed.data.artifactId}_${runKey}`;
      const bytes = Buffer.from(
        JSON.stringify({ artifactId, evidence: "retained Workflow 2 policy authority bytes" }),
        "utf8",
      );
      Object.assign(candidate, {
        artifactId,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength,
      });
      const reference = ArtifactContentReferenceSchema.parse(candidate);
      const existing = artifacts.get(reference.artifactId);
      if (
        existing &&
        (existing.reference.sha256 !== reference.sha256 ||
          existing.reference.sizeBytes !== reference.sizeBytes)
      ) {
        throw new TypeError(`Artifact ${reference.artifactId} has contradictory content bindings`);
      }
      artifacts.set(reference.artifactId, { bytes, reference: structuredClone(reference) });
    }
    for (const child of Object.values(candidate)) visit(child);
  };
  visit(definition);
  return definition;
}

function releasePolicyRequest(fixture: PolicyAuthorityFixture): PublishReleasePolicyRequest {
  const {
    definitionSha256: _definitionSha256,
    issuerPrincipalId: _issuerPrincipalId,
    policyId: _policyId,
    predecessor,
    publishedAt: _publishedAt,
    publishedByPrincipalId: _publishedByPrincipalId,
    schemaVersion: _schemaVersion,
    scope: _scope,
    ...definition
  } = structuredClone(fixture.policy);
  return PublishReleasePolicyRequestSchema.parse({
    ...definition,
    ...(predecessor ? { predecessorVersionId: predecessor.policyVersionId } : {}),
  });
}

function buildReleasePolicyAcceptanceScenario(
  workflow1: Workflow1AcceptanceSummary,
): ReleasePolicyAcceptanceScenario {
  const now = clock.now();
  const day = 24 * 60 * 60 * 1_000;
  const authorityFrom = offsetTimestamp(now, -2 * day);
  const policyFrom = offsetTimestamp(now, -day);
  const policyUntil = offsetTimestamp(now, 30 * day);
  const authorityUntil = offsetTimestamp(now, 31 * day);
  const artifacts = new Map<string, RetainedPolicyArtifact>();
  const ids = {
    credentialAuthority: `usr_policy_credential_authority_${runKey}`,
    identityVerifier: `usr_policy_identity_verifier_${runKey}`,
    issuer: `usr_policy_issuer_${runKey}`,
    sourcePublisher: `usr_policy_source_publisher_${runKey}`,
    sourceReviewer: `usr_policy_source_reviewer_${runKey}`,
  } as const;
  const fixture = policyAuthorityFixture({
    mutateBinding: (definition: PolicyInstallationBindingDefinition) => {
      definition.authorizedIssuerPrincipalIds = [ids.issuer];
      definition.bindingVersionId = `binding_${runKey}_v1`;
      definition.effectiveAt = authorityFrom;
      definition.expiresAt = authorityUntil;
      definition.installationId = `installation_${runKey}`;
      Object.assign(definition, retainedPolicyDefinition(definition, artifacts));
    },
    mutatePolicy: (definition: ReleasePolicyDefinition) => {
      definition.effectiveAt = policyFrom;
      definition.expiresAt = policyUntil;
      definition.issuerPrincipalId = ids.issuer;
      definition.policyId = `policy_${runKey}_staging`;
      definition.policyVersionId = `policy_${runKey}_staging_v1`;
      const assessment = {
        assessmentId: workflow1.modelAssurance.assessment.baseAssessmentId,
        definitionSha256: workflow1.modelAssurance.assessment.baseAssessmentSha256,
      };
      for (const rule of definition.rules) {
        if ("comparison" in rule.predicate) {
          rule.predicate.comparison = structuredClone(workflow1.comparison);
        } else if ("assessment" in rule.predicate) {
          rule.predicate.assessment = structuredClone(assessment);
        }
      }
    },
    mutateReview: (definition: SourceReviewDefinition) => {
      definition.sourceReviewId = `review_${runKey}_release_standard`;
      definition.validFrom = authorityFrom;
      definition.validUntil = authorityUntil;
      Object.assign(definition, retainedPolicyDefinition(definition, artifacts));
    },
    mutateReviewer: (definition: SourceReviewerQualificationDefinition) => {
      definition.qualificationId = `qualification_${runKey}_release_reviewer`;
      definition.reviewerPrincipalId = ids.sourceReviewer;
      definition.validFrom = authorityFrom;
      definition.validUntil = authorityUntil;
      Object.assign(definition, retainedPolicyDefinition(definition, artifacts));
    },
    mutateSource: (definition: SourceSnapshotDefinition) => {
      definition.effectiveAt = authorityFrom;
      definition.expiresAt = authorityUntil;
      definition.sourceSnapshotId = `source_${runKey}_release_standard`;
      if (definition.identityVerification.status !== "verified") {
        throw new TypeError("Policy acceptance source identity must be independently verified");
      }
      definition.identityVerification = {
        ...definition.identityVerification,
        verifiedAt: authorityFrom,
        verifierPrincipalId: ids.identityVerifier,
      };
      Object.assign(definition, retainedPolicyDefinition(definition, artifacts));
    },
    scope,
  });

  return {
    artifacts,
    fixture,
    lifecycleRequest: PublishReleasePolicyLifecycleRequestSchema.parse({
      eventId: `policy_event_${runKey}_withdrawal`,
      kind: "withdrawn",
      reason: "This disposable policy version completed its immutable publication exercise.",
    }),
    principals: {
      artifactCustodian: scopedPrincipal(`usr_policy_artifact_custodian_${runKey}`, [
        "artifact:write",
      ]),
      credentialAuthority: scopedPrincipal(ids.credentialAuthority, ["evaluation:manage"]),
      policyIssuer: scopedPrincipal(ids.issuer, ["policy:author", "policy:read"]),
      sourcePublisher: scopedPrincipal(ids.sourcePublisher, ["evaluation:manage"]),
      sourceReviewer: scopedPrincipal(ids.sourceReviewer, ["evaluation:manage"]),
    },
    request: releasePolicyRequest(fixture),
  };
}

let apiUrl: string;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let evaluationWorker: PostgresEvaluationWorkerRuntime | undefined;
let modelWorker: PostgresModelEvaluationWorkerRuntime | undefined;
let outputRoot: string | undefined;
let bucketCreated = false;
let rolesCreated = false;
let releasePolicyScenario: ReleasePolicyAcceptanceScenario | undefined;

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

function releasePolicyClient(): ProofStackReleasePolicyClient {
  return new ProofStackReleasePolicyClient({
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
    policyInstallationBindingResolver: new StaticPolicyInstallationBindingResolver(
      releasePolicyScenario ? [releasePolicyScenario.fixture.binding] : [],
    ),
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

async function publishPolicyAuthorityInputs(
  scenario: ReleasePolicyAcceptanceScenario,
): Promise<readonly PolicyAuthorityRecordReference[]> {
  const regression = regressionClient();
  selectedPrincipal = scenario.principals.artifactCustodian;
  for (const { bytes, reference } of scenario.artifacts.values()) {
    const reservation = await regression.reserveArtifact({
      request: {
        artifactId: reference.artifactId,
        classification: reference.classification,
        mediaType: reference.mediaType,
        redaction: { status: "not_required" },
        retention: { mode: "retain" },
        sha256: reference.sha256,
        sizeBytes: reference.sizeBytes,
      },
    });
    expect(reservation.created).toBe(true);
    const upload = await regression.uploadArtifactContent({
      artifactId: reference.artifactId,
      content: bytes,
    });
    expect(upload.metadata.state).toBe("available");
    expect(upload.metadata.contentReference).toEqual(reference);
  }

  const evaluation = evaluationClient();
  const {
    definitionSha256: _sourceDigest,
    publishedByPrincipalId: _sourcePublisher,
    recordedAt: _sourceRecordedAt,
    schemaVersion: _sourceSchemaVersion,
    scope: _sourceScope,
    ...sourceDefinition
  } = structuredClone(scenario.fixture.source);
  selectedPrincipal = scenario.principals.sourcePublisher;
  const source = await evaluation.publishDefinition({
    recordId: scenario.fixture.source.sourceSnapshotId,
    request: {
      definition: SourceSnapshotDefinitionSchema.parse(sourceDefinition),
      kind: "source_snapshot",
    },
  });
  if (source.result.kind !== "source_snapshot") {
    throw new TypeError("Policy source publication changed record kind");
  }
  expect(source.created).toBe(true);
  expect(source.result.record.definitionSha256).toBe(scenario.fixture.source.definitionSha256);

  const {
    definitionSha256: _qualificationDigest,
    recordedAt: _qualificationRecordedAt,
    schemaVersion: _qualificationSchemaVersion,
    scope: _qualificationScope,
    verifiedByPrincipalId: _qualificationVerifier,
    ...qualificationDefinition
  } = structuredClone(scenario.fixture.reviewer);
  selectedPrincipal = scenario.principals.credentialAuthority;
  const qualification = await evaluation.publishDefinition({
    recordId: scenario.fixture.reviewer.qualificationId,
    request: {
      definition: SourceReviewerQualificationDefinitionSchema.parse(qualificationDefinition),
      kind: "source_reviewer_qualification",
    },
  });
  if (qualification.result.kind !== "source_reviewer_qualification") {
    throw new TypeError("Policy reviewer qualification publication changed record kind");
  }
  expect(qualification.created).toBe(true);
  expect(qualification.result.record.definitionSha256).toBe(
    scenario.fixture.reviewer.definitionSha256,
  );

  const {
    definitionSha256: _reviewDigest,
    reviewedAt: _reviewedAt,
    reviewedByPrincipalId: _reviewerPrincipalId,
    reviewerRole: _reviewerRole,
    schemaVersion: _reviewSchemaVersion,
    scope: _reviewScope,
    ...reviewDefinition
  } = structuredClone(scenario.fixture.review);
  selectedPrincipal = scenario.principals.sourceReviewer;
  const review = await evaluation.publishDefinition({
    recordId: scenario.fixture.review.sourceReviewId,
    request: {
      definition: SourceReviewDefinitionSchema.parse(reviewDefinition),
      kind: "source_review",
    },
  });
  if (review.result.kind !== "source_review") {
    throw new TypeError("Policy source review publication changed record kind");
  }
  expect(review.created).toBe(true);
  expect(review.result.record.definitionSha256).toBe(scenario.fixture.review.definitionSha256);

  return [
    {
      definitionSha256: source.result.record.definitionSha256,
      kind: "source_snapshot",
      recordId: source.result.record.sourceSnapshotId,
    },
    {
      definitionSha256: qualification.result.record.definitionSha256,
      kind: "source_reviewer_qualification",
      recordId: qualification.result.record.qualificationId,
    },
    {
      definitionSha256: review.result.record.definitionSha256,
      kind: "source_review",
      recordId: review.result.record.sourceReviewId,
    },
  ];
}

async function verifyPolicyAuthorityReadBack(
  references: readonly PolicyAuthorityRecordReference[],
): Promise<void> {
  selectedPrincipal = controlPrincipal;
  const evaluation = evaluationClient();
  for (const reference of references) {
    const persisted = await evaluation.readRecord(reference);
    expect(persisted.result.kind).toBe(reference.kind);
    expect(persisted.result.record.definitionSha256).toBe(reference.definitionSha256);
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
    let releasePolicy: Workflow2ReleasePolicySummary | undefined;
    let releasePolicyBeforeRestart: ReleasePolicy | undefined;
    let releasePolicyLifecycleBeforeRestart: ReleasePolicyLifecycleEvent | undefined;
    let policyAuthorityReferences: readonly PolicyAuthorityRecordReference[] = [];
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

    if (acceptReleasePolicy) {
      if (!releaseCandidate) {
        throw new Error("Workflow 2 policy acceptance requires a retained release candidate");
      }
      releasePolicyScenario = buildReleasePolicyAcceptanceScenario(summary);
      policyAuthorityReferences = await publishPolicyAuthorityInputs(releasePolicyScenario);

      // Recompose the API from durable authority records and the operator-owned installation
      // binding before policy publication. This proves that publication does not depend on the
      // in-process objects used to write the source, reviewer qualification, or review.
      await restartApi();
      selectedPrincipal = releasePolicyScenario.principals.policyIssuer;
      releasePolicy = await runWorkflow2ReleasePolicy({
        client: releasePolicyClient(),
        lifecycleRequest: releasePolicyScenario.lifecycleRequest,
        policyId: releasePolicyScenario.fixture.policy.policyId,
        request: releasePolicyScenario.request,
      });
      expect(releasePolicy.immutableHistoryVerified).toBe(true);
      expect(releasePolicy.policy).toMatchObject({
        definitionSha256: releasePolicyScenario.fixture.policy.definitionSha256,
        policyId: releasePolicyScenario.fixture.policy.policyId,
        policyVersionId: releasePolicyScenario.fixture.policy.policyVersionId,
        retryCreated: false,
      });
      expect(releasePolicy.lifecycle).toEqual({
        eventId: releasePolicyScenario.lifecycleRequest.eventId,
        kind: "withdrawn",
        retryCreated: false,
      });

      const policyClient = releasePolicyClient();
      releasePolicyBeforeRestart = (
        await policyClient.readPolicy({
          policyId: releasePolicy.policy.policyId,
          policyVersionId: releasePolicy.policy.policyVersionId,
        })
      ).policy;
      releasePolicyLifecycleBeforeRestart = (
        await policyClient.readLifecycleEvent({
          eventId: releasePolicy.lifecycle.eventId,
          policyId: releasePolicy.policy.policyId,
          policyVersionId: releasePolicy.policy.policyVersionId,
        })
      ).event;
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
    if (
      releasePolicy &&
      releasePolicyScenario &&
      releasePolicyBeforeRestart &&
      releasePolicyLifecycleBeforeRestart
    ) {
      await verifyPolicyAuthorityReadBack(policyAuthorityReferences);
      selectedPrincipal = controlPrincipal;
      const policyClient = releasePolicyClient();
      const restoredPolicy = await policyClient.readPolicy({
        policyId: releasePolicy.policy.policyId,
        policyVersionId: releasePolicy.policy.policyVersionId,
      });
      const restoredLifecycle = await policyClient.readLifecycleEvent({
        eventId: releasePolicy.lifecycle.eventId,
        policyId: releasePolicy.policy.policyId,
        policyVersionId: releasePolicy.policy.policyVersionId,
      });
      expect(restoredPolicy.policy).toEqual(releasePolicyBeforeRestart);
      expect(restoredLifecycle.event).toEqual(releasePolicyLifecycleBeforeRestart);
      expect(restoredPolicy.policy.rules).toEqual(releasePolicyScenario.fixture.policy.rules);
      expect(restoredPolicy.policy.sources).toEqual(releasePolicyScenario.fixture.policy.sources);
      expect(restoredPolicy.policy.installationBinding).toEqual(
        releasePolicyScenario.fixture.policy.installationBinding,
      );
      expect(restoredLifecycle.event.policy).toEqual({
        definitionSha256: restoredPolicy.policy.definitionSha256,
        policyId: restoredPolicy.policy.policyId,
        policyVersionId: restoredPolicy.policy.policyVersionId,
      });
    }
  });
});
