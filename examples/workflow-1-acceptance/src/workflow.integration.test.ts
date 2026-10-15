import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
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
  POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE,
  type PolicyEvaluationJobHistoryEntry,
  type PolicyEvaluationJobReference,
  type PolicyInstallationBindingDefinition,
  type PrincipalContext,
  type PublishReleasePolicyLifecycleRequest,
  PublishReleasePolicyLifecycleRequestSchema,
  type PublishReleasePolicyRequest,
  PublishReleaseCandidateRequestSchema,
  PublishComparisonDefinitionRequestSchema,
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
import { generateServiceToken, hashServiceTokenSecret } from "@proofstack/identity";
import {
  bootstrapApiKey,
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
  ProofStackPolicyEvaluationClient,
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
import { createPolicyContributorDefinitions } from "./policy-evaluation-definitions.js";

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
const acceptPolicyEvaluation = process.env["PROOFSTACK_ACCEPT_POLICY_EVALUATION"] === "true";
const prepareCanonicalPolicyInputs =
  acceptPolicyEvaluation || process.env["PROOFSTACK_ACCEPT_CANONICAL_POLICY_INPUTS"] === "true";
const acceptReleasePolicy =
  acceptPolicyEvaluation || process.env["PROOFSTACK_ACCEPT_RELEASE_POLICY"] === "true";
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
  policyEvaluationControl: credentials("policy_control"),
  policyEvaluator: credentials("policy_evaluator"),
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
    policyEvaluationControlDatabaseUrl: roleDatabaseUrl(runtimeRoles.policyEvaluationControl!),
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
  const discoveries = workflow1.evaluation.readBack.records.filter(
    (reference) => reference.kind === "discovery_record",
  );
  if (discoveries.length !== 1)
    throw new TypeError("Policy source requires one exact retained discovery record");
  const discovery = discoveries[0]!;
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
      definition.discovery = {
        discoveryId: discovery.recordId,
        definitionSha256: discovery.definitionSha256,
        candidateRank: 1,
      };
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
let contributorDefinitions: ReturnType<typeof createPolicyContributorDefinitions> | undefined;

type ProfilePreparation = NonNullable<
  Parameters<typeof prepareWorkflow1Acceptance>[0]["durableReplay"]["prepareRuntimeProfiles"]
>;
async function prepareContributorProfiles(input: Parameters<ProfilePreparation>[0]) {
  selectedPrincipal = controlPrincipal;
  const upload = async (kind: string, bytes: Buffer): Promise<ArtifactContentReference> => {
    const reference = ArtifactContentReferenceSchema.parse({
      artifactId: `artifact_${runKey}_policy_${kind}`,
      classification: "internal",
      mediaType: "application/json",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
    });
    const client = regressionClient();
    const reservation = await client.reserveArtifact({
      request: {
        ...reference,
        redaction: { status: "not_required" },
        retention: { mode: "retain" },
      },
    });
    expect(reservation.created).toBe(true);
    const uploaded = await client.uploadArtifactContent({
      artifactId: reference.artifactId,
      content: bytes,
    });
    expect(uploaded.metadata.contentReference).toEqual(reference);
    return reference;
  };
  // Fixed original public source files, never classified normalized requests or caller-selected paths.
  const implementationPaths = [
    "examples/interaction-capture/src/capture.ts",
    "examples/interaction-capture/src/reference-recorded-target.ts",
    "examples/durable-replay/src/target-source.ts",
    "examples/workflow-2-release-candidate/src/workflow.ts",
  ];
  const specificationPaths = [
    "packages/contracts/src/interaction.ts",
    "packages/contracts/src/replay-plan.ts",
    "packages/contracts/src/runtime-definition.ts",
    "packages/contracts/src/protocol-definition.ts",
  ];
  const bundle = async (paths: readonly string[]) =>
    Buffer.from(
      JSON.stringify({
        sourceRevision: releaseCandidateSource().commit.value,
        files: await Promise.all(
          paths.map(async (path) => {
            const bytes = await readFile(join(repositoryRoot, path));
            return {
              path,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              source: bytes.toString("utf8"),
            };
          }),
        ),
      }),
    );
  const implementation = await upload("implementation", await bundle(implementationPaths));
  const specification = await upload("specification", await bundle(specificationPaths));
  const configuration = await upload(
    "configuration",
    Buffer.from(
      JSON.stringify({
        scope: input.scope,
        runtime: input.targetRelease.runtime,
        limitation:
          "Reference source declarations only; no loaded-code or provider-identity attestation.",
      }),
    ),
  );
  contributorDefinitions = createPolicyContributorDefinitions({
    namespace: `run_${runKey}`,
    scope: input.scope,
    registeredAt: clock.now().toISOString(),
    registeredByPrincipalId: controlPrincipal.principalId,
    runtime: input.targetRelease.runtime,
    implementation,
    configuration,
    specification,
  });
  return {
    runtimeProfile: contributorDefinitions.runtimeProfileReference,
    isolationProfile: contributorDefinitions.isolationProfileReference,
  };
}

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

/** Public SDK -> stock API-key authentication -> separate executable -> durable exact reads. */
async function policyObjectBarrier() {
  const target = new URL(s3Endpoint);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname))
    throw new Error("Owned object barrier requires loopback test S3");
  let startedResolve!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const gate = new Promise<void>((resolve) => {
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
  if (!address || typeof address === "string")
    throw new Error("Missing owned object barrier address");
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

type PolicyAcceptanceCase = "active" | "mismatch" | "budget" | "cancellation";
const policyAcceptanceCases: readonly PolicyAcceptanceCase[] = [
  "active",
  "mismatch",
  "budget",
  "cancellation",
];
interface PolicyEvaluationAcceptance {
  verifyCase(label: PolicyAcceptanceCase): Promise<void>;
}
let policyAcceptance: PolicyEvaluationAcceptance | undefined;
let workflowCompletion:
  | {
      workflow1: boolean;
      releaseCandidate: boolean;
      releasePolicy: boolean;
      canonicalPolicyInputs: boolean;
    }
  | undefined;
const completedPolicyCases = new Set<string>();
async function writeWorkflowCompletionReceipt(): Promise<void> {
  if (!workflowCompletion) throw new Error("Missing original workflow completion");
  const receiptFile = process.env["PROOFSTACK_ACCEPTANCE_RECEIPT_FILE"];
  if (receiptFile !== undefined)
    await writeFile(
      receiptFile,
      JSON.stringify({
        schemaVersion: "0.2",
        ...workflowCompletion,
        policyEvaluation: acceptPolicyEvaluation,
      }),
      { mode: 0o600, flag: "wx" },
    );
}

async function preparePolicyEvaluationAcceptance(
  workflow1: Workflow1AcceptanceSummary,
  originalCandidate: Workflow2ReleaseCandidateSummary,
): Promise<PolicyEvaluationAcceptance> {
  const definitions = contributorDefinitions;
  const scenario = releasePolicyScenario;
  if (!definitions || !scenario || !outputRoot) throw new Error("Missing owning policy inputs");
  selectedPrincipal = controlPrincipal;
  const withdrawnBefore = (
    await releasePolicyClient().readPolicy({
      policyId: scenario.fixture.policy.policyId,
      policyVersionId: scenario.fixture.policy.policyVersionId,
    })
  ).policy;
  // A distinct descriptive comparison measures exact retained trace counts. It makes no
  // assurance claim; the original contested comparison and all its declarations stay retained.
  const originalComparison = (
    await comparisonClient().readRecord({
      kind: "comparison_definition",
      recordId: workflow1.comparison.comparisonVersionId,
    })
  ).result;
  if (originalComparison.kind !== "comparison_definition")
    throw new Error("Missing original comparison definition");
  const {
    comparisonId: _comparisonId,
    createdAt: _comparisonAt,
    createdByPrincipalId: _comparisonBy,
    definitionSha256: _comparisonSha,
    schemaVersion: _comparisonVersion,
    scope: _comparisonScope,
    predecessor: _comparisonPredecessor,
    ...countDefinition
  } = structuredClone(originalComparison.record);
  countDefinition.comparisonVersionId = `cmpv_${runKey}_trace_counts`;
  countDefinition.name = "Exact retained trace counts without an assurance conclusion";
  countDefinition.description =
    "An independently declared descriptive comparison; no assessment, model qualification or human assurance is asserted.";
  countDefinition.metrics = countDefinition.metrics.filter(
    (metric) => metric.kind === "trace_event_count",
  );
  for (const subject of [countDefinition.baseline, countDefinition.candidate])
    for (const fixture of subject.fixtures) {
      fixture.assessments = [];
      fixture.modelAssuranceAssessments = [];
    }
  const policyReplay = workflow1.durableReplay.jobs.policyComparison;
  if (
    !policyReplay ||
    policyReplay.status !== "succeeded" ||
    policyReplay.attemptStatuses.length !== 1
  )
    throw new Error("Descriptive comparison requires its independently executed normal replay");
  for (const fixture of countDefinition.candidate.fixtures)
    fixture.replay = structuredClone(policyReplay.evidenceReference);
  const publishedCount = (
    await comparisonClient().publishDefinition({
      comparisonId: `cmp_${runKey}_trace_counts`,
      request: PublishComparisonDefinitionRequestSchema.parse(countDefinition),
    })
  ).result;
  if (publishedCount.kind !== "comparison_definition")
    throw new Error("Count comparison publication changed kind");
  const countComparison = {
    comparisonId: publishedCount.record.comparisonId,
    comparisonVersionId: publishedCount.record.comparisonVersionId,
    definitionSha256: publishedCount.record.definitionSha256,
  };
  const counted = await completeWorkflow1Acceptance(comparisonClient(), {
    ...workflow1,
    comparison: countComparison,
    comparisonRecordId: countComparison.comparisonVersionId,
    snapshotIds: {
      baseline: `cmps_${runKey}_counts_baseline`,
      candidate: `cmps_${runKey}_counts_candidate`,
    },
    resultId: `cmpr_${runKey}_trace_counts`,
  });
  expect(counted.result.comparability.status).toBe("comparable");
  const {
    candidateId: _candidateId,
    createdAt: _candidateAt,
    createdByPrincipalId: _candidateBy,
    definitionSha256: _candidateSha,
    schemaVersion: _candidateVersion,
    scope: _candidateScope,
    ...candidateDefinition
  } = structuredClone(originalCandidate.candidate);
  candidateDefinition.candidateVersionId = `candidate_${runKey}_evaluation_v1`;
  candidateDefinition.comparisons = [
    {
      resultId: counted.result.resultId,
      definitionSha256: counted.result.definitionSha256,
    },
  ];
  candidateDefinition.name = "Descriptive trace-count policy evaluation candidate";
  candidateDefinition.knownLimitations.push(
    "This distinct candidate names only the descriptive trace-count comparison; the original contested candidate and its complete comparison remain retained separately.",
  );
  candidateDefinition.knownLimitations.sort();
  candidateDefinition.comparisons.sort((left, right) =>
    left.resultId < right.resultId ? -1 : left.resultId > right.resultId ? 1 : 0,
  );
  for (const component of candidateDefinition.runtimeComponents)
    if (component.kind === "model")
      component.adapter = structuredClone(definitions.modelAdapterReference);
  const candidate = (
    await releaseCandidateClient().publishCandidate({
      candidateId: `candidate_${runKey}_evaluation`,
      request: PublishReleaseCandidateRequestSchema.parse(candidateDefinition),
    })
  ).candidate;

  selectedPrincipal = scenario.principals.policyIssuer;
  const activeRequest = structuredClone(scenario.request);
  activeRequest.policyVersionId = `policy_${runKey}_evaluation_v1`;
  activeRequest.name = "Retained contested reference graph: exact policy evaluation acceptance";
  activeRequest.applicability = {
    jurisdiction:
      candidate.target.jurisdiction === undefined
        ? { operator: "absent" }
        : { operator: "equals", value: candidate.target.jurisdiction },
    locale:
      candidate.target.locale === undefined
        ? { operator: "absent" }
        : { operator: "equals", value: candidate.target.locale },
    maximumDataClassification: {
      operator: "equals",
      value: candidate.target.maximumDataClassification,
    },
    populationTags: { operator: "exactly", values: [...candidate.target.populationTags] },
    purpose: { operator: "equals", value: candidate.target.purpose },
    riskTier: { operator: "equals", value: candidate.target.riskTier },
    taskKind: { operator: "equals", value: candidate.target.taskKind },
  };
  for (const rule of activeRequest.rules) {
    const predicate = rule.predicate;
    if ("comparison" in predicate) predicate.comparison = structuredClone(countComparison);
    if (predicate.kind === "comparison_threshold") {
      predicate.threshold = "3";
      rule.rationale =
        "The complete retained trace has three envelopes, so its matching agent.run count is at most three; this is a descriptive bound, not a correctness or safety verdict.";
    }
    if (predicate.kind === "artifact_required") {
      predicate.role = "build_provenance";
      predicate.allowedMediaTypes = ["application/json"];
    }
    if ("metricId" in predicate) predicate.metricId = `met_trace_${runKey}`;
  }
  const artifactRule = activeRequest.rules.find(
    (rule) => rule.predicate.kind === "artifact_required",
  );
  if (!artifactRule || artifactRule.predicate.kind !== "artifact_required")
    throw new Error("Missing artifact rule");
  activeRequest.rules.push({
    ...structuredClone(artifactRule),
    ruleId: "artifact_wrong_media",
    predicate: {
      ...structuredClone(artifactRule.predicate),
      allowedMediaTypes: ["application/zip"],
    },
    rationale:
      "The actual JSON provenance must not satisfy an independently declared ZIP requirement.",
  });
  activeRequest.rules.sort((left, right) => left.ruleId.localeCompare(right.ruleId, "en"));
  const policyClient = releasePolicyClient();
  const active = (
    await policyClient.publishPolicy({
      policyId: `policy_${runKey}_evaluation`,
      request: PublishReleasePolicyRequestSchema.parse(activeRequest),
    })
  ).policy;
  const mismatchRequest = structuredClone(activeRequest);
  mismatchRequest.policyVersionId = `policy_${runKey}_other_task_v1`;
  mismatchRequest.applicability.taskKind = { operator: "equals", value: "different_task" };
  const mismatch = (
    await policyClient.publishPolicy({
      policyId: `policy_${runKey}_other_task`,
      request: PublishReleasePolicyRequestSchema.parse(mismatchRequest),
    })
  ).policy;
  expect(active.policyId).not.toBe(scenario.fixture.policy.policyId);
  expect(
    (
      await policyClient.readPolicy({
        policyId: scenario.fixture.policy.policyId,
        policyVersionId: scenario.fixture.policy.policyVersionId,
      })
    ).policy,
  ).toEqual(withdrawnBefore);

  const key = await bootstrapApiKey(adminPool, {
    actorPrincipalId: `usr_policy_sdk_${runKey}`,
    name: "disposable-policy-evaluation-contributor",
    tenantId: scope.tenantId,
    capabilities: ["policy:evaluate", "policy:read", "policy:evaluation:cancel"],
    resourceScope: {
      mode: "restricted",
      projects: [{ projectId: scope.projectId, environmentIds: [scope.environmentId] }],
    },
  });
  const token = generateServiceToken();
  const prefix = "PROOFSTACK_POLICY_WORKER_";
  const privateFile = async (name: string, value: unknown) => {
    const filename = join(outputRoot!, name);
    await writeFile(filename, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    return filename;
  };
  const credentialsFile = await privateFile("policy-worker-credentials.json", {
    schemaVersion: "0.1",
    revision: `catalogue_${runKey}`,
    credentials: [
      {
        kind: "service_token",
        prefix: token.prefix,
        passwordHash: await hashServiceTokenSecret(token.secret),
        credentialId: `credential_${runKey}`,
        principalId: `worker_${runKey}`,
        tenantId: scope.tenantId,
        capabilities: ["policy:evaluation:execute", "artifact:read", "artifact:read:restricted"],
        resourceScope: {
          mode: "restricted",
          projects: [{ projectId: scope.projectId, environmentIds: [scope.environmentId] }],
        },
        status: "active",
        notBefore: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      },
    ],
  });
  const cataloguesFile = await privateFile("policy-worker-catalogues.json", {
    installationBindings: [scenario.fixture.binding],
    runtimeDefinitions: definitions.runtimeDefinitions,
    protocolDefinitions: definitions.protocolDefinitions,
  });
  const authoritiesFile = await privateFile("policy-worker-authorities.json", {
    repositories: [{ checkoutPath: repositoryRoot, repositoryUrl, scope }],
    modelDeclarations: [{ declaration: WORKFLOW_2_REFERENCE_MODEL_DECLARATION, scope }],
    runtimeAdapters: [{ adapter: definitions.modelAdapterReference, scope }],
  });
  const environment: NodeJS.ProcessEnv = {
    PROOFSTACK_ENV: "test",
    AWS_EC2_METADATA_DISABLED: "true",
    [prefix + "SERVICE_TOKEN"]: token.value,
    [prefix + "CREDENTIALS_FILE"]: credentialsFile,
    [prefix + "CATALOGUES_FILE"]: cataloguesFile,
    [prefix + "AUTHORITIES_FILE"]: authoritiesFile,
    [prefix + "DATABASE_URL"]: roleDatabaseUrl(runtimeRoles.policyEvaluator!),
    [prefix + "DATABASE_ROLE"]: runtimeRoles.policyEvaluator!.name,
    [prefix + "S3_BUCKET"]: artifactBucket,
    [prefix + "S3_REGION"]: s3Region,
    [prefix + "S3_ENDPOINT"]: s3Endpoint,
    [prefix + "S3_FORCE_PATH_STYLE"]: "true",
    [prefix + "S3_ACCESS_KEY_ID"]: s3AccessKeyId,
    [prefix + "S3_SECRET_ACCESS_KEY"]: s3SecretAccessKey,
    [prefix + "KEYRING_ACTIVE_KEY_ID"]: artifactKeyId,
    [prefix + "KEYRING_KEYS"]: JSON.stringify({ [artifactKeyId]: artifactKey }),
  };
  const launch = (job: PolicyEvaluationJobReference, endpoint = s3Endpoint) => {
    let child!: ReturnType<typeof execFile>;
    const completion = new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve, reject) => {
        child = execFile(
          process.execPath,
          [
            fileURLToPath(new URL("cli.js", import.meta.resolve("@proofstack/policy-worker"))),
            "execute",
            scope.projectId,
            scope.environmentId,
            job.jobId,
          ],
          {
            cwd: repositoryRoot,
            env: { ...environment, [prefix + "S3_ENDPOINT"]: endpoint },
            timeout: 60000,
            maxBuffer: 65536,
          },
          (error, stdout, stderr) => {
            const output = stdout + stderr;
            if (
              [
                token.value,
                key.value,
                artifactKey,
                s3SecretAccessKey,
                environment[prefix + "DATABASE_URL"]!,
              ].some((secret) => output.includes(secret))
            ) {
              reject(new Error("Policy contributor worker output exposed private fixture data"));
              return;
            }
            const code = error ? error.code : 0;
            if (typeof code !== "number") {
              reject(
                new Error(
                  "Owned policy worker process failed to complete within its bounded invocation",
                ),
              );
              return;
            }
            resolve({ code, stdout, stderr });
          },
        );
      },
    );
    return { child, completion };
  };
  const execute = async (job: PolicyEvaluationJobReference, expectedCode = 0): Promise<unknown> => {
    const result = await launch(job).completion;
    expect(result.code, "Owned stock policy worker exit code").toBe(expectedCode);
    if (expectedCode === 1) {
      expect(result.stdout).toBe("");
      return undefined;
    }
    const receipt = JSON.parse(result.stdout) as unknown;
    expect(receipt).toMatchObject({ schemaVersion: "0.1", scope, job: { ...job } });
    return receipt;
  };
  await app?.close();
  await startApi(true);
  const client = () =>
    new ProofStackPolicyEvaluationClient({
      endpoint: apiUrl,
      scope,
      authentication: { mode: "workload", apiKey: key.value },
      timeoutMs: 60000,
    });
  // Select one native DB cut after all publications, before observing any policy outcome.
  const cut = (
    await adminPool.query<{ evaluation_time: string }>(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS evaluation_time",
    )
  ).rows[0]!.evaluation_time;
  const limits = {
    heartbeatIntervalMilliseconds: 5000,
    leaseDurationMilliseconds: 60000,
    maxAcquisitionRecordBytes: 67108864,
    maxAcquisitionRecords: 100000,
    maxArtifactReadBytes: 67108864,
    maxAttempts: 3,
    maxRuleEvaluations: 384,
    perAttemptTimeoutMilliseconds: 120000,
    retryBackoffMilliseconds: 1000,
    retryableErrors: [
      "lease_expired",
      "source_revision_changed",
      "source_temporarily_unavailable",
      "worker_interrupted",
    ] as const,
    totalDeadlineMilliseconds: 600000,
  };
  const reference = {
    candidateId: candidate.candidateId,
    candidateVersionId: candidate.candidateVersionId,
    definitionSha256: candidate.definitionSha256,
  };
  const requestFor = (label: PolicyAcceptanceCase) => {
    const policy = label === "mismatch" ? mismatch : active;
    return {
      algorithm: { id: "proofstack.deterministic-policy" as const, version: "1.0.0" as const },
      candidate: reference,
      policy: {
        policyId: policy.policyId,
        policyVersionId: policy.policyVersionId,
        definitionSha256: policy.definitionSha256,
      },
      evaluationRequestId: `request_${runKey}_${label}`,
      evaluationTime: cut,
      limits: { ...limits, retryableErrors: [...limits.retryableErrors] },
    };
  };
  const verifyCase = async (label: PolicyAcceptanceCase): Promise<void> => {
    const policy = label === "mismatch" ? mismatch : active;
    const request = requestFor(label);
    if (label === "budget") {
      request.limits.maxAcquisitionRecords = 2;
      request.limits.maxAttempts = 1;
      request.limits.maxRuleEvaluations = 128;
      request.limits.retryBackoffMilliseconds = 0;
      request.limits.retryableErrors = [];
      const original = (await client().enqueue({ request })).snapshot;
      const job = { jobId: original.job.jobId, definitionSha256: original.job.definitionSha256 };
      await execute(job, 1);
      const failed = (await client().readJob({ job })).snapshot;
      expect(["failed", "budget_exhausted"]).toContain(failed.job.status);
      expect(failed.job.terminal).not.toBeNull();
      expect(failed.request).toEqual(original.request);
      expect(failed.request.limits).toEqual(request.limits);
      expect(failed.attempts).toHaveLength(1);
      expect(failed.job.snapshot).toBeNull();
      expect(failed.job.result).toBeNull();
      expect(failed.usage.ruleEvaluations).toBe(0);
      expect(failed.usage.artifactReadBytes).toBe(0);
      expect((await client().enqueue({ request })).created).toBe(false);
      expect((await client().readJob({ job })).snapshot).toEqual(failed);
      return;
    }
    if (label === "cancellation") {
      const original = (await client().enqueue({ request })).snapshot;
      const job = { jobId: original.job.jobId, definitionSha256: original.job.definitionSha256 };
      const barrier = await policyObjectBarrier();
      const running = launch(job, barrier.endpoint);
      try {
        await Promise.race([
          barrier.started,
          running.completion.then(() => {
            throw new Error("Worker exited before its owned object barrier");
          }),
        ]);
        const before = (await client().readJob({ job })).snapshot;
        expect(before.job.status).toBe("acquiring");
        const cancelled = (
          await client().cancel({ job, request: { reason: "operator_requested" } })
        ).snapshot;
        expect(cancelled.job.status).toBe("cancelled");
        expect(cancelled.request).toEqual(original.request);
        expect(cancelled.job.snapshot).toBeNull();
        expect(cancelled.job.result).toBeNull();
        expect(cancelled.usage.artifactReadBytes).toBe(before.usage.artifactReadBytes);
        expect(cancelled.usage.reads).toBe(request.limits.maxAcquisitionRecords);
        const head = (await client().readHistoryHead({ job })).head;
        barrier.release();
        const stopped = await running.completion;
        expect(stopped.code).toBe(1);
        expect(stopped.stdout).toBe("");
        expect((await client().readJob({ job })).snapshot).toEqual(cancelled);
        expect(await execute(job, 2)).toMatchObject({
          job: { status: "cancelled" },
          snapshot: null,
          result: null,
          ruleOutcomes: null,
        });
        expect((await client().readJob({ job })).snapshot).toEqual(cancelled);
        expect((await client().readHistoryHead({ job })).head).toEqual(head);
      } finally {
        if (running.child.exitCode === null && running.child.signalCode === null)
          running.child.kill("SIGKILL");
        await running.completion.catch(() => undefined);
        await barrier.close();
      }
      return;
    }
    const enqueued = await client().enqueue({ request });
    expect(enqueued.created).toBe(true);
    const job = {
      jobId: enqueued.snapshot.job.jobId,
      definitionSha256: enqueued.snapshot.job.definitionSha256,
    };
    expect((await client().readRequest({ job })).request).toEqual(enqueued.snapshot.request);
    await execute(job);
    const finished = (await client().readJob({ job })).snapshot;
    expect(finished.job.status).toBe("completed");
    const material = await client().readCompleteSnapshot({ job });
    const sealedInputs = material.inputs;
    if (sealedInputs.schemaVersion !== "0.2")
      throw new Error("Native contributor requires complete current snapshot inputs");
    const result = (await client().readResult({ job })).evaluation;
    expect(result.rules.map((rule) => rule.ruleId)).toEqual(
      policy.rules.map((rule) => rule.ruleId),
    );
    expect(new Set(result.rules.map((rule) => rule.predicateKind)).size).toBe(7);
    expect(result.evaluationTime).toBe(cut);
    expect(result.rules.find((rule) => rule.predicateKind === "approval_required")).toMatchObject({
      outcome: "indeterminate",
      evidence: { reason: "approval_not_evaluated" },
    });
    if (label === "active") {
      const ruleDiagnostics = result.rules.map(({ ruleId, ruleIndex, outcome, evidence }) => {
        const coordinates = sealedInputs.closure.rules[ruleIndex]!;
        const checks = [
          ...sealedInputs.closure.rootContext.checkIndexes,
          ...coordinates.checkIndexes,
        ]
          .map((index) => sealedInputs.closure.checks[index]!)
          .filter((check) => check.status !== "matched")
          .slice(0, 8)
          .map(({ domain, kind, status, context, path, reasons }) => ({
            domain,
            kind,
            status,
            context,
            path,
            reasons: reasons.filter((reason) => /^[a-z0-9_:-]{1,128}$/.test(reason)),
          }));
        return {
          ruleId,
          outcome,
          evidenceKind: evidence.kind,
          reason: evidence.kind === "not_evaluated" ? evidence.reason : undefined,
          checks,
        };
      });
      expect(
        result.rules.map(({ ruleId, outcome }) => ({ ruleId, outcome })),
        JSON.stringify(ruleDiagnostics),
      ).toEqual([
        { ruleId: "approval_gate", outcome: "indeterminate" },
        { ruleId: "artifact_bundle", outcome: "satisfied" },
        { ruleId: "artifact_wrong_media", outcome: "violated" },
        { ruleId: "comparison_regression", outcome: "satisfied" },
        { ruleId: "coverage_floor", outcome: "satisfied" },
        { ruleId: "eligibility_base", outcome: "indeterminate" },
        { ruleId: "safety_ceiling", outcome: "indeterminate" },
        { ruleId: "uncertainty_floor", outcome: "indeterminate" },
      ]);
      expect(
        result.rules.find(({ ruleId }) => ruleId === "coverage_floor")?.evidence,
      ).toMatchObject({
        kind: "ratio_floor",
        numerator: 1,
        denominator: 1,
        minimumBasisPoints: 9500,
      });
      expect(result.rules.find(({ ruleId }) => ruleId === "eligibility_base")?.evidence).toEqual({
        kind: "not_evaluated",
        reason: "evidence_unqualified",
      });
    } else {
      expect(result.outcomeCounts).toEqual({
        satisfied: 0,
        violated: 0,
        indeterminate: 1,
        not_applicable: 7,
      });
    }
    const head = (await client().readHistoryHead({ job })).head;
    let predecessor: PolicyEvaluationJobHistoryEntry | undefined;
    const entries: PolicyEvaluationJobHistoryEntry[] = [];
    for (
      let pageIndex = 0;
      pageIndex <= Math.floor(head.sequence / POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE);
      pageIndex++
    ) {
      const page = (
        await client().readHistoryPage({
          job,
          head,
          pageIndex,
          ...(predecessor ? { predecessor } : {}),
        })
      ).page;
      entries.push(...page.entries);
      predecessor = page.entries.at(-1);
    }
    expect(entries).toHaveLength(head.sequence + 1);
    expect(predecessor?.definition.status).toBe("completed");
    await app?.close();
    await startApi(true);
    expect((await client().enqueue({ request })).created).toBe(false);
    expect((await client().readJob({ job })).snapshot).toEqual(finished);
    expect(await client().readCompleteSnapshot({ job })).toEqual(material);
    expect((await client().readResult({ job })).evaluation).toEqual(result);
    expect((await client().readHistoryHead({ job })).head).toEqual(head);
    await execute(job);
    expect((await client().readJob({ job })).snapshot).toEqual(finished);
    expect((await client().readHistoryHead({ job })).head).toEqual(head);
  };
  expect(workflow1.result.comparability.status).toBe("incomparable");
  return { verifyCase };
}

async function startApi(workload = false): Promise<void> {
  selectedPrincipal = controlPrincipal;
  app = await createApp(
    {
      ...apiConfig,
      ...(workload
        ? {
            authMode: "api_key" as const,
            identityDatabaseUrl: roleDatabaseUrl(runtimeRoles.identity),
          }
        : {}),
    },
    {
      ...(workload ? {} : { authenticator }),
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
        runtimeAdapters: [
          { adapter: WORKFLOW_2_REFERENCE_MODEL_ADAPTER, scope },
          ...(contributorDefinitions
            ? [{ adapter: contributorDefinitions.modelAdapterReference, scope }]
            : []),
        ],
      }),
    },
  );
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
  selectedPrincipal = controlPrincipal;
  if (!sourceDefinition.discovery) throw new Error("Expected exact source discovery binding");
  const discovery = await evaluation.readRecord({
    kind: "discovery_record",
    recordId: sourceDefinition.discovery.discoveryId,
  });
  if (discovery.result.kind !== "discovery_record")
    throw new Error("Source discovery changed record kind");
  expect(discovery.result.record.definitionSha256).toBe(
    sourceDefinition.discovery.definitionSha256,
  );
  const candidates = discovery.result.record.candidates.filter(
    (candidate) => candidate.rank === sourceDefinition.discovery!.candidateRank,
  );
  expect(candidates).toHaveLength(1);
  expect(candidates[0]?.canonicalUri).toBe(sourceDefinition.canonicalUri);
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
        preparePolicyEvaluationReplay: acceptPolicyEvaluation,
        ...(prepareCanonicalPolicyInputs
          ? { prepareRuntimeProfiles: prepareContributorProfiles }
          : {}),
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
    if (acceptPolicyEvaluation) {
      if (!releaseCandidate || !releasePolicyScenario || !contributorDefinitions || !outputRoot)
        throw new Error("Policy evaluation acceptance requires the complete retained workflow");
      policyAcceptance = await preparePolicyEvaluationAcceptance(summary, releaseCandidate);
    }
    workflowCompletion = {
      workflow1: true,
      releaseCandidate: releaseCandidate !== undefined,
      releasePolicy: releasePolicy !== undefined,
      canonicalPolicyInputs: contributorDefinitions !== undefined,
    };
    if (!acceptPolicyEvaluation) await writeWorkflowCompletionReceipt();
  });
  for (const label of policyAcceptanceCases)
    it.runIf(acceptPolicyEvaluation)(
      `evaluates the ${label} policy through the authenticated SDK and separate worker`,
      async () => {
        if (!policyAcceptance) throw new Error("Original workflow preparation did not complete");
        await policyAcceptance.verifyCase(label);
        completedPolicyCases.add(label);
        if (policyAcceptanceCases.every((required) => completedPolicyCases.has(required)))
          await writeWorkflowCompletionReceipt();
      },
    );
});
