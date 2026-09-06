import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  type CreateReplayJobResponse,
  EVIDENCE_SCHEMA_VERSION,
  InteractionCaptureManifestSchema,
  type PublishComparisonRecordResponse,
  type PublishRegressionDatasetVersionResponse,
  type PublishRegressionFixtureVersionResponse,
  PublishReleaseCandidateRequestSchema,
  type PublishReleaseCandidateResponse,
  type PublishReplayPlanResponse,
  type PublishTargetReleaseResponse,
  type RecordedInteractionFixtureVersionDefinition,
  RecordedInteractionFixtureVersionDefinitionSchema,
  type ReleaseCandidate,
  ReplayPlanDefinitionSchema,
  TargetReleaseDefinitionSchema,
} from "@proofstack/contracts";
import { releaseCandidateFixture } from "@proofstack/core/testing";
import { decodeOtlpJson, encodeOtlpProtobufRequest } from "@proofstack/otlp";
import {
  bootstrapApiKey,
  createPostgresPool,
  inspectIdentityCredentials,
  migrateDatabase,
  PostgresApiKeyCredentialRepository,
  PostgresReplayJobWorkerRepository,
  provisionRuntimeRoles,
} from "@proofstack/postgres";
import { digestRecordedBoundaryReplayInvocationDefinition } from "@proofstack/replay";
import { createS3Client, type S3ClientConnectionOptions } from "@proofstack/s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const { PROOFSTACK_TEST_DATABASE_URL: databaseUrl } = process.env;
if (!databaseUrl) {
  throw new Error("PROOFSTACK_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for PostgreSQL integration tests`);
  return value;
}

function environmentValue(name: string): string | undefined {
  return process.env[name];
}

const testS3AccessKeyId = requiredEnvironment("PROOFSTACK_TEST_S3_ACCESS_KEY_ID");
const testS3SecretAccessKey = requiredEnvironment("PROOFSTACK_TEST_S3_SECRET_ACCESS_KEY");
const testS3Endpoint = requiredEnvironment("PROOFSTACK_TEST_S3_ENDPOINT");
const testS3Region = requiredEnvironment("PROOFSTACK_TEST_S3_REGION");
const s3Connection: S3ClientConnectionOptions = {
  allowInsecureLoopback: true,
  credentials: {
    accessKeyId: testS3AccessKeyId,
    secretAccessKey: testS3SecretAccessKey,
  },
  endpoint: testS3Endpoint,
  forcePathStyle: true,
  region: testS3Region,
};
const artifactBucket = `proofstack-api-${randomUUID()}`;
const artifactAdministrationClient = createS3Client(s3Connection);
const artifactKeyId = "key_integration_primary";
const artifactKey = Buffer.alloc(32, 29).toString("base64url");
const originalAwsCredentials = {
  accessKeyId: environmentValue("AWS_ACCESS_KEY_ID"),
  secretAccessKey: environmentValue("AWS_SECRET_ACCESS_KEY"),
};
let artifactBucketCreated = false;

const interactionVector = RecordedInteractionFixtureVersionDefinitionSchema.parse(
  (
    JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/datasets/vectors/interaction-fixture-definition-v2.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      readonly vectors: readonly {
        readonly input: RecordedInteractionFixtureVersionDefinition;
      }[];
    }
  ).vectors[0]?.input,
);

const replayDefinitionVectors = (
  JSON.parse(
    readFileSync(
      new URL("../../../packages/replay/vectors/replay-definition-v1.json", import.meta.url),
      "utf8",
    ),
  ) as {
    readonly vectors: readonly {
      readonly input: unknown;
      readonly kind: "replay_plan" | "target_release";
    }[];
  }
).vectors;
const targetReleaseVector = replayDefinitionVectors.find(({ kind }) => kind === "target_release");
const replayPlanVector = replayDefinitionVectors.find(({ kind }) => kind === "replay_plan");
if (!targetReleaseVector || !replayPlanVector) {
  throw new Error("Replay definition vectors are incomplete");
}
const targetReleaseTemplate = TargetReleaseDefinitionSchema.parse(targetReleaseVector.input);
const replayPlanTemplate = ReplayPlanDefinitionSchema.parse(replayPlanVector.input);

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function persistentInteractionCapture() {
  const content = new Map(
    interactionVector.interactionCapture.artifacts.map((binding) => {
      const value = Buffer.from(
        JSON.stringify({ artifactId: binding.contentReference.artifactId, persistent: true }),
        "utf8",
      );
      return [binding.contentReference.artifactId, value] as const;
    }),
  );
  const digests = new Map([...content].map(([artifactId, value]) => [artifactId, sha256(value)]));
  const artifacts = interactionVector.interactionCapture.artifacts.map((binding) => {
    const value = content.get(binding.contentReference.artifactId);
    if (!value) throw new Error("Missing persistent interaction artifact content");
    return {
      ...binding,
      contentReference: {
        ...binding.contentReference,
        sha256: sha256(value),
        sizeBytes: value.byteLength,
      },
    };
  });
  const interactions = interactionVector.interactionCapture.interactions.map((interaction) => {
    if (interaction.kind !== "model") return interaction;
    const attempts = interaction.attempts.map((attempt) => {
      const normalizedSha256 = digests.get(attempt.normalizedRequest.artifactId);
      if (!normalizedSha256) throw new Error("Missing normalized request digest");
      return {
        ...attempt,
        normalizedRequest: { ...attempt.normalizedRequest, sha256: normalizedSha256 },
      };
    });
    const promptSha256 = digests.get(interaction.prompt.artifactId);
    if (!promptSha256) throw new Error("Missing prompt digest");
    return {
      ...interaction,
      attempts,
      prompt: { ...interaction.prompt, definitionSha256: promptSha256 },
    };
  });
  return {
    content,
    manifest: InteractionCaptureManifestSchema.parse({
      ...interactionVector.interactionCapture,
      artifacts,
      interactions,
    }),
  };
}

async function emptyArtifactBucket(): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const page = await artifactAdministrationClient.send(
      new ListObjectsV2Command({
        Bucket: artifactBucket,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }),
    );
    const objects = (page.Contents ?? []).flatMap(({ Key }) => (Key ? [{ Key }] : []));
    if (objects.length > 0) {
      await artifactAdministrationClient.send(
        new DeleteObjectsCommand({ Bucket: artifactBucket, Delete: { Objects: objects } }),
      );
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
}

function setEnvironment(name: "AWS_ACCESS_KEY_ID" | "AWS_SECRET_ACCESS_KEY", value?: string) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const runtimeRoles = {
  api: { name: "proofstack_test_api_runtime", password: "proofstack-test-api-runtime" },
  artifact: {
    name: "proofstack_test_artifact_runtime",
    password: "proofstack-test-artifact-runtime",
  },
  consumer: {
    name: "proofstack_test_consumer_runtime",
    password: "proofstack-test-consumer-runtime",
  },
  evaluationWorker: {
    name: "proofstack_test_evaluation_runtime",
    password: "proofstack-test-evaluation-runtime",
  },
  humanReviewer: {
    name: "proofstack_test_human_runtime",
    password: "proofstack-test-human-runtime",
  },
  identity: {
    name: "proofstack_test_identity_runtime",
    password: "proofstack-test-identity-runtime",
  },
  modelEvaluationWorker: {
    name: "proofstack_test_model_runtime",
    password: "proofstack-test-model-runtime",
  },
  policyAuthor: {
    name: "proofstack_test_policy_author_runtime",
    password: "proofstack-test-policy-author-runtime",
  },
  publisher: {
    name: "proofstack_test_publisher_runtime",
    password: "proofstack-test-publisher-runtime",
  },
  replayWorker: {
    name: "proofstack_test_replay_worker_runtime",
    password: "proofstack-test-replay-worker-runtime",
  },
} as const;
const adminPool = createPostgresPool({
  applicationName: "proofstack-api-integration-setup",
  connectionString: databaseUrl,
  maxConnections: 1,
  onIdleError: (error) => {
    throw error;
  },
});
const runtimeDatabaseUrl = new URL(databaseUrl);
runtimeDatabaseUrl.username = runtimeRoles.api.name;
runtimeDatabaseUrl.password = runtimeRoles.api.password;
const identityDatabaseUrl = new URL(databaseUrl);
identityDatabaseUrl.username = runtimeRoles.identity.name;
identityDatabaseUrl.password = runtimeRoles.identity.password;
const policyAuthorDatabaseUrl = new URL(databaseUrl);
policyAuthorDatabaseUrl.username = runtimeRoles.policyAuthor.name;
policyAuthorDatabaseUrl.password = runtimeRoles.policyAuthor.password;
const replayWorkerDatabaseUrl = new URL(databaseUrl);
replayWorkerDatabaseUrl.username = runtimeRoles.replayWorker.name;
replayWorkerDatabaseUrl.password = runtimeRoles.replayWorker.password;
let issuedApiKey: Awaited<ReturnType<typeof bootstrapApiKey>>;
let otlpApiKey: Awaited<ReturnType<typeof bootstrapApiKey>>;

beforeAll(async () => {
  setEnvironment("AWS_ACCESS_KEY_ID", testS3AccessKeyId);
  setEnvironment("AWS_SECRET_ACCESS_KEY", testS3SecretAccessKey);
  await migrateDatabase(adminPool);
  await provisionRuntimeRoles(adminPool, runtimeRoles);
  await artifactAdministrationClient.send(new CreateBucketCommand({ Bucket: artifactBucket }));
  artifactBucketCreated = true;
  issuedApiKey = await bootstrapApiKey(adminPool, {
    actorPrincipalId: "usr_integration_operator",
    capabilities: ["evidence:ingest", "evidence:read"],
    name: "api-integration",
    resourceScope: { mode: "tenant" },
    tenantId: "ten_local",
  });
  otlpApiKey = await bootstrapApiKey(adminPool, {
    actorPrincipalId: "usr_integration_operator",
    capabilities: ["evidence:ingest", "evidence:read"],
    name: "otlp-api-integration",
    resourceScope: { mode: "tenant" },
    tenantId: "ten_local",
  });
});

afterAll(async () => {
  try {
    if (artifactBucketCreated) {
      await emptyArtifactBucket();
      await artifactAdministrationClient.send(new DeleteBucketCommand({ Bucket: artifactBucket }));
    }
  } finally {
    artifactAdministrationClient.destroy();
    setEnvironment("AWS_ACCESS_KEY_ID", originalAwsCredentials.accessKeyId);
    setEnvironment("AWS_SECRET_ACCESS_KEY", originalAwsCredentials.secretAccessKey);
    await adminPool.end();
  }
});

function postgresConfig() {
  return loadConfig({
    PROOFSTACK_AUTH_MODE: "development",
    PROOFSTACK_DATABASE_URL: runtimeDatabaseUrl.toString(),
    PROOFSTACK_ENV: "test",
    PROOFSTACK_LOG_LEVEL: "silent",
    PROOFSTACK_POLICY_AUTHOR_DATABASE_URL: policyAuthorDatabaseUrl.toString(),
    PROOFSTACK_STORAGE_MODE: "postgres",
  });
}

function persistentArtifactConfig() {
  return loadConfig({
    PROOFSTACK_ARTIFACT_ACTIVE_KEY_ID: artifactKeyId,
    PROOFSTACK_ARTIFACT_KEYS: JSON.stringify({ [artifactKeyId]: artifactKey }),
    PROOFSTACK_ARTIFACT_S3_BUCKET: artifactBucket,
    PROOFSTACK_ARTIFACT_S3_ENDPOINT: testS3Endpoint,
    PROOFSTACK_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
    PROOFSTACK_ARTIFACT_S3_REGION: testS3Region,
    PROOFSTACK_ARTIFACT_STORAGE_MODE: "s3_local_keyring",
    PROOFSTACK_AUTH_MODE: "development",
    PROOFSTACK_DATABASE_URL: runtimeDatabaseUrl.toString(),
    PROOFSTACK_ENV: "test",
    PROOFSTACK_LOG_LEVEL: "silent",
    PROOFSTACK_POLICY_AUTHOR_DATABASE_URL: policyAuthorDatabaseUrl.toString(),
    PROOFSTACK_STORAGE_MODE: "postgres",
  });
}

function apiKeyConfig() {
  return loadConfig({
    PROOFSTACK_AUTH_MODE: "api_key",
    PROOFSTACK_DATABASE_URL: runtimeDatabaseUrl.toString(),
    PROOFSTACK_ENV: "test",
    PROOFSTACK_IDENTITY_DATABASE_URL: identityDatabaseUrl.toString(),
    PROOFSTACK_LOG_LEVEL: "silent",
    PROOFSTACK_POLICY_AUTHOR_DATABASE_URL: policyAuthorDatabaseUrl.toString(),
    PROOFSTACK_STORAGE_MODE: "postgres",
  });
}

describe("PostgreSQL-backed API", () => {
  it("retains an ingested trace after the API and its pool are restarted", async () => {
    const traceId = "6bf92f3577b34da6a3ce929d0e0e4736";
    const evidence = {
      eventId: "evt_api_restart_001",
      kind: "agent.run",
      name: "api-restart-test",
      source: {
        sdkName: "@proofstack/sdk",
        sdkVersion: "0.0.0",
        serviceName: "api-restart-test",
      },
      spanId: "50f067aa0ba902b7",
      startedAt: "2026-08-28T03:59:59.000Z",
      traceId,
    };

    const firstApp = await createApp(postgresConfig());
    try {
      const ingest = await firstApp.inject({
        body: { events: [evidence], schemaVersion: EVIDENCE_SCHEMA_VERSION },
        method: "POST",
        url: "/v1/projects/prj_local/environments/env_local/evidence",
      });
      expect(ingest.statusCode).toBe(202);
    } finally {
      await firstApp.close();
    }

    const restartedApp = await createApp(postgresConfig());
    try {
      const readiness = await restartedApp.inject({ method: "GET", url: "/health/ready" });
      const trace = await restartedApp.inject({
        method: "GET",
        url: `/v1/projects/prj_local/environments/env_local/traces/${traceId}`,
      });

      expect(readiness.statusCode).toBe(200);
      expect(trace.statusCode).toBe(200);
      expect(trace.json()).toMatchObject({
        events: [{ evidence: { eventId: evidence.eventId }, scope: { tenantId: "ten_local" } }],
        traceId,
      });
    } finally {
      await restartedApp.close();
    }
  });

  it("retains an exact release candidate and idempotency across an API restart", async () => {
    const scope = {
      environmentId: "env_release_restart",
      projectId: "prj_release_restart",
      tenantId: "ten_local",
    } as const;
    const candidate = releaseCandidateFixture("api_restart", scope);
    const {
      candidateId: _candidateId,
      createdAt: _createdAt,
      createdByPrincipalId: _createdByPrincipalId,
      definitionSha256: _definitionSha256,
      predecessor,
      schemaVersion: _schemaVersion,
      scope: _scope,
      ...definition
    } = candidate;
    const request = PublishReleaseCandidateRequestSchema.parse({
      ...definition,
      ...(predecessor ? { predecessorVersionId: predecessor.candidateVersionId } : {}),
    });
    const url =
      `/v1/projects/${scope.projectId}/environments/${scope.environmentId}` +
      `/release-candidates/${candidate.candidateId}/versions/${candidate.candidateVersionId}`;
    let published: PublishReleaseCandidateResponse;

    const firstApp = await createApp(postgresConfig(), {
      clock: { now: () => new Date(candidate.createdAt) },
      releaseCandidateSourceResolver: { isAvailable: () => Promise.resolve(true) },
    });
    try {
      const publication = await firstApp.inject({ body: request, method: "POST", url });
      expect(publication.statusCode).toBe(201);
      published = publication.json<PublishReleaseCandidateResponse>();
      expect(published).toMatchObject({
        candidate: {
          candidateId: candidate.candidateId,
          candidateVersionId: candidate.candidateVersionId,
          definitionSha256: candidate.definitionSha256,
        },
        created: true,
      });
    } finally {
      await firstApp.close();
    }

    const restartedApp = await createApp(postgresConfig());
    try {
      const read = await restartedApp.inject({ method: "GET", url });
      const retry = await restartedApp.inject({ body: request, method: "POST", url });
      const wrongLogicalIdentity = await restartedApp.inject({
        method: "GET",
        url:
          `/v1/projects/${scope.projectId}/environments/${scope.environmentId}` +
          `/release-candidates/candidate_wrong/versions/${candidate.candidateVersionId}`,
      });

      expect(read.statusCode).toBe(200);
      expect(read.headers["cache-control"]).toBe("no-store");
      expect(read.json<{ candidate: ReleaseCandidate }>().candidate).toEqual(published.candidate);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({ candidate: published.candidate, created: false });
      expect(wrongLogicalIdentity.statusCode).toBe(404);
    } finally {
      await restartedApp.close();
    }
  });

  it("persists authenticated gzip Protobuf OTLP traces across an API restart", async () => {
    const traceId = "8bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "70f067aa0ba902b7";
    const authorization = `Bearer ${otlpApiKey.value}`;
    const protobuf = encodeOtlpProtobufRequest(
      decodeOtlpJson(
        JSON.stringify({
          resourceSpans: [
            {
              resource: {
                attributes: [
                  {
                    key: "service.name",
                    value: { stringValue: "otlp-postgres-integration" },
                  },
                ],
              },
              scopeSpans: [
                {
                  scope: { name: "integration-otel", version: "1.0" },
                  spans: [
                    {
                      endTimeUnixNano: "1787930001000000000",
                      name: "persist OTLP trace",
                      spanId,
                      startTimeUnixNano: "1787930000000000000",
                      status: { code: 1 },
                      traceId,
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    );

    const firstApp = await createApp(apiKeyConfig());
    try {
      const ingest = await firstApp.inject({
        body: gzipSync(protobuf),
        headers: {
          authorization,
          "content-encoding": "gzip",
          "content-type": "application/x-protobuf",
          "x-proofstack-environment-id": "env_local",
          "x-proofstack-project-id": "prj_local",
        },
        method: "POST",
        url: "/v1/traces",
      });

      expect(ingest.statusCode).toBe(200);
      expect(ingest.headers["content-type"]).toContain("application/x-protobuf");
      expect(ingest.rawPayload.byteLength).toBe(0);
    } finally {
      await firstApp.close();
    }

    const restartedApp = await createApp(apiKeyConfig());
    try {
      const trace = await restartedApp.inject({
        headers: { authorization },
        method: "GET",
        url: `/v1/projects/prj_local/environments/env_local/traces/${traceId}`,
      });

      expect(trace.statusCode).toBe(200);
      expect(trace.json()).toMatchObject({
        events: [
          {
            evidence: {
              kind: "custom",
              source: {
                sdkName: "integration-otel",
                serviceName: "otlp-postgres-integration",
              },
              spanId,
            },
            scope: {
              environmentId: "env_local",
              projectId: "prj_local",
              tenantId: "ten_local",
            },
          },
        ],
        traceId,
      });
    } finally {
      await restartedApp.close();
    }
  });

  it("retains exact development-authenticated regression versions across an API restart", async () => {
    const traceId = "9bf92f3577b34da6a3ce929d0e0e4736";
    const fixtureId = "fix_api_restart_001";
    const fixtureVersionId = "fixv_api_restart_001";
    const datasetId = "dat_api_restart_001";
    const datasetVersionId = "datv_api_restart_001";
    let publishedFixture: PublishRegressionFixtureVersionResponse;
    let publishedDataset: PublishRegressionDatasetVersionResponse;

    const firstApp = await createApp(postgresConfig());
    try {
      const ingest = await firstApp.inject({
        body: {
          events: [
            {
              eventId: "evt_regression_api_restart_001",
              kind: "agent.run",
              name: "regression-api-restart-test",
              source: {
                sdkName: "@proofstack/sdk",
                sdkVersion: "0.0.0",
                serviceName: "regression-api-restart-test",
              },
              spanId: "80f067aa0ba902b7",
              startedAt: "2026-08-28T04:59:59.000Z",
              status: "error",
              traceId,
            },
          ],
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
        },
        method: "POST",
        url: "/v1/projects/prj_local/environments/env_local/evidence",
      });
      expect(ingest.statusCode).toBe(202);

      const fixtureRequest = {
        fixtureVersionId,
        name: "Authenticated restart incident",
        source: { kind: "trace_snapshot", traceId },
      } as const;
      const fixtureUrl = `/v1/projects/prj_local/environments/env_local/regression-fixtures/${fixtureId}/versions`;
      const fixture = await firstApp.inject({
        body: fixtureRequest,
        method: "POST",
        url: fixtureUrl,
      });
      const fixtureRetry = await firstApp.inject({
        body: fixtureRequest,
        method: "POST",
        url: fixtureUrl,
      });
      expect(fixture.statusCode).toBe(201);
      expect(fixtureRetry.statusCode).toBe(200);
      expect(fixtureRetry.json()).toMatchObject({
        created: false,
        version: fixture.json<PublishRegressionFixtureVersionResponse>().version,
      });
      publishedFixture = fixture.json<PublishRegressionFixtureVersionResponse>();

      const dataset = await firstApp.inject({
        body: {
          datasetVersionId,
          fixtureVersions: [{ fixtureId, fixtureVersionId }],
          name: "Authenticated restart regressions",
        },
        method: "POST",
        url: `/v1/projects/prj_local/environments/env_local/regression-datasets/${datasetId}/versions`,
      });
      expect(dataset.statusCode).toBe(201);
      publishedDataset = dataset.json<PublishRegressionDatasetVersionResponse>();
    } finally {
      await firstApp.close();
    }

    const restartedApp = await createApp(postgresConfig());
    try {
      const fixture = await restartedApp.inject({
        method: "GET",
        url:
          `/v1/projects/prj_local/environments/env_local/regression-fixtures/${fixtureId}` +
          `/versions/${fixtureVersionId}`,
      });
      const dataset = await restartedApp.inject({
        method: "GET",
        url:
          `/v1/projects/prj_local/environments/env_local/regression-datasets/${datasetId}` +
          `/versions/${datasetVersionId}`,
      });

      expect(fixture.statusCode).toBe(200);
      expect(dataset.statusCode).toBe(200);
      expect(fixture.json()).toMatchObject({
        version: publishedFixture.version,
      });
      expect(fixture.json()).toMatchObject({
        version: {
          replayability: "evidence_only",
          source: {
            eventIds: ["evt_regression_api_restart_001"],
            observedEventCount: 1,
            sourceCompleteness: "observed_snapshot",
          },
        },
      });
      expect(dataset.json()).toMatchObject({
        version: publishedDataset.version,
      });
    } finally {
      await restartedApp.close();
    }
  });

  it("retains encrypted interaction captures across coordinated PostgreSQL and S3 restarts", async () => {
    const scope = { environmentId: "env_persistent", projectId: "prj_persistent" } as const;
    const fixtureId = "fix_persistent_capture";
    const predecessorVersionId = "fixv_persistent_capture_001";
    const recordedVersionId = "fixv_persistent_capture_002";
    const traceId = "abf92f3577b34da6a3ce929d0e0e4736";
    const artifactCollectionUrl = `/v1/projects/${scope.projectId}/environments/${scope.environmentId}/artifacts`;
    const fixtureCollectionUrl =
      `/v1/projects/${scope.projectId}/environments/${scope.environmentId}` +
      `/regression-fixtures/${fixtureId}`;
    const publicationUrl = `${fixtureCollectionUrl}/interaction-versions`;
    const capture = persistentInteractionCapture();
    const publicationBody = {
      fixtureVersionId: recordedVersionId,
      interactionCapture: capture.manifest,
      name: "Persistent encrypted interaction capture",
      predecessorVersionId,
    } as const;

    const firstApp = await createApp(persistentArtifactConfig());
    try {
      const ingest = await firstApp.inject({
        body: {
          events: [
            {
              eventId: "evt_persistent_capture_001",
              kind: "agent.run",
              name: "persistent-interaction-capture",
              source: {
                sdkName: "@proofstack/sdk",
                sdkVersion: "0.0.0",
                serviceName: "persistent-interaction-capture",
              },
              spanId: "a0f067aa0ba902b7",
              startedAt: "2026-08-29T05:00:00.000Z",
              traceId,
            },
          ],
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
        },
        method: "POST",
        url: `/v1/projects/${scope.projectId}/environments/${scope.environmentId}/evidence`,
      });
      expect(ingest.statusCode).toBe(202);

      const predecessor = await firstApp.inject({
        body: {
          fixtureVersionId: predecessorVersionId,
          name: "Persistent capture predecessor",
          source: { kind: "trace_snapshot", traceId },
        },
        method: "POST",
        url: `${fixtureCollectionUrl}/versions`,
      });
      expect(predecessor.statusCode).toBe(201);

      for (const binding of capture.manifest.artifacts) {
        const content = capture.content.get(binding.contentReference.artifactId);
        if (!content) throw new Error("Missing persistent interaction artifact content");
        const reserve = await firstApp.inject({
          body: {
            artifactId: binding.contentReference.artifactId,
            classification: binding.contentReference.classification,
            mediaType: binding.contentReference.mediaType,
            redaction: binding.redaction,
            retention: binding.retention,
            sha256: binding.contentReference.sha256,
            sizeBytes: binding.contentReference.sizeBytes,
          },
          method: "POST",
          url: artifactCollectionUrl,
        });
        const upload = await firstApp.inject({
          body: content,
          headers: { "content-type": "application/octet-stream" },
          method: "PUT",
          url: `${artifactCollectionUrl}/${binding.contentReference.artifactId}/content`,
        });
        expect(reserve.statusCode, reserve.body).toBe(201);
        expect(upload.statusCode, upload.body).toBe(200);
      }

      const publish = await firstApp.inject({
        body: publicationBody,
        method: "POST",
        url: publicationUrl,
      });
      expect(publish.statusCode, publish.body).toBe(201);
      expect(publish.json()).toMatchObject({
        created: true,
        ownerships: { length: capture.manifest.artifacts.length },
        version: { fixtureVersionId: recordedVersionId },
      });
    } finally {
      await firstApp.close();
    }

    const restartedApp = await createApp(persistentArtifactConfig());
    try {
      const versionUrl = `${publicationUrl}/${recordedVersionId}`;
      const metadata = await restartedApp.inject({ method: "GET", url: versionUrl });
      const retry = await restartedApp.inject({
        body: publicationBody,
        method: "POST",
        url: publicationUrl,
      });
      const firstBinding = capture.manifest.artifacts[0];
      if (!firstBinding) throw new Error("Expected at least one persistent artifact");
      const artifactUrl = `${artifactCollectionUrl}/${firstBinding.contentReference.artifactId}`;
      const artifactMetadata = await restartedApp.inject({ method: "GET", url: artifactUrl });
      const plaintext = await restartedApp.inject({
        method: "GET",
        url: `${artifactUrl}/content`,
      });

      expect(metadata.statusCode, metadata.body).toBe(200);
      expect(metadata.json()).toMatchObject({ contentAvailability: "available" });
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toMatchObject({ created: false });
      expect(artifactMetadata.statusCode, artifactMetadata.body).toBe(200);
      expect(artifactMetadata.json()).toMatchObject({
        metadata: {
          contentReference: { sha256: firstBinding.contentReference.sha256 },
          state: "available",
        },
        ownership: { owner: { fixtureId, fixtureVersionId: recordedVersionId } },
      });
      expect(plaintext.statusCode, plaintext.body).toBe(200);
      expect(plaintext.headers["x-proofstack-artifact-sha256"]).toBe(
        firstBinding.contentReference.sha256,
      );
      expect(plaintext.rawPayload).toEqual(
        capture.content.get(firstBinding.contentReference.artifactId),
      );

      const revocation = await restartedApp.inject({
        body: { reason: "Verify durable fixture-owned content revocation" },
        method: "POST",
        url: `${versionUrl}/revocation`,
      });
      expect(revocation.statusCode, revocation.body).toBe(201);
      expect(revocation.json()).toMatchObject({
        contentAvailability: "revoked",
        tombstones: { length: capture.manifest.artifacts.length },
      });
    } finally {
      await restartedApp.close();
    }

    const finalApp = await createApp(persistentArtifactConfig());
    try {
      const versionUrl = `${publicationUrl}/${recordedVersionId}`;
      const revokedMetadata = await finalApp.inject({ method: "GET", url: versionUrl });
      expect(revokedMetadata.statusCode, revokedMetadata.body).toBe(200);
      expect(revokedMetadata.json()).toMatchObject({ contentAvailability: "revoked" });

      for (const binding of capture.manifest.artifacts) {
        const artifactUrl = `${artifactCollectionUrl}/${binding.contentReference.artifactId}`;
        const unavailable = await finalApp.inject({
          method: "GET",
          url: `${artifactUrl}/content`,
        });
        const purge = await finalApp.inject({ method: "POST", url: `${artifactUrl}/purge` });
        expect(unavailable.statusCode, unavailable.body).toBe(409);
        expect(unavailable.json()).toMatchObject({ code: "artifact_unavailable" });
        expect(purge.statusCode, purge.body).toBe(200);
        expect(purge.json()).toMatchObject({ metadata: { state: "purged" } });
      }
    } finally {
      await finalApp.close();
    }

    const remainingObjects = await artifactAdministrationClient.send(
      new ListObjectsV2Command({ Bucket: artifactBucket }),
    );
    expect(remainingObjects.KeyCount).toBe(0);
  }, 30_000);

  it("derives an authenticated source-backed comparison after a PostgreSQL restart", async () => {
    const runKey = randomUUID().replaceAll("-", "").slice(0, 8);
    const scope = {
      environmentId: `env_compare_${runKey}`,
      projectId: `prj_compare_${runKey}`,
      tenantId: "ten_local",
    } as const;
    const scopeUrl = `/v1/projects/${scope.projectId}/environments/${scope.environmentId}`;
    const artifactUrl = `${scopeUrl}/artifacts`;
    const traceId = randomUUID().replaceAll("-", "");
    const fixtureId = `fix_compare_${runKey}`;
    const fixtureVersionId = `fixv_compare_${runKey}`;
    const datasetId = `dat_compare_${runKey}`;
    const datasetVersionId = `datv_compare_${runKey}`;
    const targetId = `target_compare_${runKey}`;
    const targetReleaseId = `trg_compare_${runKey}`;
    const planId = `plan_compare_${runKey}`;
    const planVersionId = `plv_compare_${runKey}`;
    const comparisonId = `comparison_${runKey}`;
    const comparisonVersionId = `cmpv_${runKey}`;
    const targetProvenanceContent = Buffer.from(
      JSON.stringify({ build: runKey, kind: "integration_provenance" }),
      "utf8",
    );
    const baselineResultContent = Buffer.from(JSON.stringify({ role: "baseline", runKey }), "utf8");
    const candidateResultContent = Buffer.from(
      JSON.stringify({ role: "candidate", runKey }),
      "utf8",
    );
    const artifacts = [
      {
        content: targetProvenanceContent,
        reference: {
          artifactId: `art_provenance_${runKey}`,
          classification: "internal" as const,
          mediaType: "application/json",
          sha256: sha256(targetProvenanceContent),
          sizeBytes: targetProvenanceContent.byteLength,
        },
      },
      {
        content: baselineResultContent,
        reference: {
          artifactId: `art_baseline_${runKey}`,
          classification: "internal" as const,
          mediaType: "application/json",
          sha256: sha256(baselineResultContent),
          sizeBytes: baselineResultContent.byteLength,
        },
      },
      {
        content: candidateResultContent,
        reference: {
          artifactId: `art_candidate_${runKey}`,
          classification: "internal" as const,
          mediaType: "application/json",
          sha256: sha256(candidateResultContent),
          sizeBytes: candidateResultContent.byteLength,
        },
      },
    ];
    let comparisonReference:
      | {
          readonly comparisonId: string;
          readonly comparisonVersionId: string;
          readonly definitionSha256: string;
        }
      | undefined;

    const firstApp = await createApp(persistentArtifactConfig());
    try {
      const ingest = await firstApp.inject({
        body: {
          events: [
            {
              attributes: { "proofstack.integration.run": runKey },
              endedAt: "2026-09-05T23:00:00.100Z",
              eventId: `evt_compare_${runKey}`,
              kind: "agent.run",
              name: "source-backed-comparison-failure",
              source: {
                sdkName: "@proofstack/sdk",
                sdkVersion: "0.0.0",
                serviceName: "comparison-integration",
              },
              spanId: traceId.slice(0, 16),
              startedAt: "2026-09-05T23:00:00.000Z",
              status: "error",
              traceId,
            },
          ],
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
        },
        method: "POST",
        url: `${scopeUrl}/evidence`,
      });
      expect(ingest.statusCode, ingest.body).toBe(202);

      const fixtureResponse = await firstApp.inject({
        body: {
          fixtureVersionId,
          name: "Retained comparison failure",
          source: { kind: "trace_snapshot", traceId },
        },
        method: "POST",
        url: `${scopeUrl}/regression-fixtures/${fixtureId}/versions`,
      });
      expect(fixtureResponse.statusCode, fixtureResponse.body).toBe(201);
      const publishedFixture = fixtureResponse.json<PublishRegressionFixtureVersionResponse>();

      const datasetResponse = await firstApp.inject({
        body: {
          datasetVersionId,
          fixtureVersions: [{ fixtureId, fixtureVersionId }],
          name: "Retained comparison dataset",
        },
        method: "POST",
        url: `${scopeUrl}/regression-datasets/${datasetId}/versions`,
      });
      expect(datasetResponse.statusCode, datasetResponse.body).toBe(201);
      const publishedDataset = datasetResponse.json<PublishRegressionDatasetVersionResponse>();

      for (const artifact of artifacts) {
        const reserve = await firstApp.inject({
          body: {
            ...artifact.reference,
            redaction: { status: "not_required" },
            retention: { mode: "retain" },
          },
          method: "POST",
          url: artifactUrl,
        });
        const upload = await firstApp.inject({
          body: artifact.content,
          headers: { "content-type": "application/octet-stream" },
          method: "PUT",
          url: `${artifactUrl}/${artifact.reference.artifactId}/content`,
        });
        expect(reserve.statusCode, reserve.body).toBe(201);
        expect(upload.statusCode, upload.body).toBe(200);
      }

      const targetDefinition = TargetReleaseDefinitionSchema.parse({
        ...structuredClone(targetReleaseTemplate),
        build: {
          ...structuredClone(targetReleaseTemplate.build),
          provenance: artifacts[0]?.reference,
        },
        scope,
        targetId,
        targetReleaseId,
      });
      const targetResponse = await firstApp.inject({
        body: targetDefinition,
        method: "POST",
        url: `${scopeUrl}/replay-targets/${targetId}/releases/${targetReleaseId}`,
      });
      expect(targetResponse.statusCode, targetResponse.body).toBe(201);
      const publishedTarget = targetResponse.json<PublishTargetReleaseResponse>().release;

      const recordedBoundary = replayPlanTemplate.boundaries[0];
      if (recordedBoundary?.mode !== "recorded_stub") {
        throw new Error("Expected the replay definition vector to contain a recorded boundary");
      }
      const invocation = {
        ...structuredClone(recordedBoundary.invocation),
        fixture: {
          definitionSha256: publishedFixture.version.definitionSha256,
          fixtureId,
          fixtureVersionId,
        },
      };
      const planDefinition = ReplayPlanDefinitionSchema.parse({
        ...structuredClone(replayPlanTemplate),
        boundaries: [
          {
            ...structuredClone(recordedBoundary),
            invocation,
            invocationDefinitionSha256:
              digestRecordedBoundaryReplayInvocationDefinition(invocation),
          },
        ],
        dataset: {
          datasetId,
          datasetVersionId,
          definitionSha256: publishedDataset.version.definitionSha256,
        },
        planId,
        planVersionId,
        scope,
        targetRelease: {
          definitionSha256: publishedTarget.definitionSha256,
          targetAdapter: publishedTarget.targetAdapter,
          targetId,
          targetReleaseId,
          workerProtocol: publishedTarget.workerProtocol,
        },
        workerProtocol: publishedTarget.workerProtocol,
      });
      const planResponse = await firstApp.inject({
        body: planDefinition,
        method: "POST",
        url: `${scopeUrl}/replay-plans/${planId}/versions/${planVersionId}`,
      });
      expect(planResponse.statusCode, planResponse.body).toBe(201);
      const publishedPlan = planResponse.json<PublishReplayPlanResponse>().plan;
      const planReference = {
        definitionSha256: publishedPlan.definitionSha256,
        planId,
        planVersionId,
      };
      const jobs = [
        { jobId: `job_baseline_${runKey}`, result: artifacts[1]?.reference, usage: 125 },
        { jobId: `job_candidate_${runKey}`, result: artifacts[2]?.reference, usage: 100 },
      ];
      for (const job of jobs) {
        const response = await firstApp.inject({
          body: { jobId: job.jobId, plan: planReference },
          method: "POST",
          url: `${scopeUrl}/replay-jobs/${job.jobId}`,
        });
        expect(response.statusCode, response.body).toBe(201);
        expect(response.json<CreateReplayJobResponse>()).toMatchObject({
          created: true,
          snapshot: { job: { jobId: job.jobId, status: "queued" } },
        });
      }

      const workerPool = createPostgresPool({
        applicationName: `proofstack-api-comparison-${runKey}`,
        connectionString: replayWorkerDatabaseUrl.toString(),
        maxConnections: 1,
        onIdleError: (error) => {
          throw error;
        },
      });
      const worker = new PostgresReplayJobWorkerRepository(workerPool);
      const replayReferences = [];
      try {
        for (const [index, job] of jobs.entries()) {
          if (!job.result) throw new Error("Expected one exact result artifact per replay job");
          const claimed = await worker.claimJob({
            attemptId: `att_compare_${index}_${runKey}`,
            jobId: job.jobId,
            leaseDurationMilliseconds: 1_500,
            leaseId: `lease_compare_${index}_${runKey}`,
            scope,
            workerBuildSha256: "d".repeat(64),
            workerId: `worker_compare_${runKey}`,
            workerProtocol: publishedPlan.workerProtocol,
          });
          expect(claimed.claimed).toBe(true);
          if (!claimed.claimed) throw new Error("Expected the comparison replay job to be claimed");
          await worker.appendUsageObservation({
            measurements: [
              {
                dimension: "elapsedMilliseconds",
                usage: { amount: job.usage, source: "measured", status: "observed" },
              },
            ],
            observationId: `obs_usage_${index}_${runKey}`,
            scope,
            sourceEventSha256: sha256(Buffer.from(`${job.jobId}:elapsed`, "utf8")),
            workerFence: claimed.workerFence,
          });
          const completed = await worker.completeJob({
            code: "completed",
            result: job.result,
            scope,
            status: "succeeded",
            workerFence: claimed.workerFence,
          });
          const attempt = completed.attempts.at(-1);
          if (!attempt?.endedAt || !attempt.result || attempt.status !== "succeeded") {
            throw new Error("Expected an exact successful replay attempt");
          }
          replayReferences.push({
            attemptId: attempt.attemptId,
            completedAt: attempt.endedAt,
            jobId: job.jobId,
            plan: attempt.plan,
            result: attempt.result,
            targetRelease: attempt.targetRelease,
            terminalCode: "completed" as const,
            terminalStatus: "succeeded" as const,
          });
        }
      } finally {
        await workerPool.end();
      }

      const datasetReference = {
        datasetId,
        datasetVersionId,
        definitionSha256: publishedDataset.version.definitionSha256,
      };
      const fixtureReference = {
        definitionSha256: publishedFixture.version.definitionSha256,
        fixtureId,
        fixtureVersionId,
      };
      const baselineReplay = replayReferences[0];
      const candidateReplay = replayReferences[1];
      if (!baselineReplay || !candidateReplay) {
        throw new Error("Expected exact baseline and candidate replay references");
      }
      const comparisonResponse = await firstApp.inject({
        body: {
          baseline: {
            dataset: datasetReference,
            fixtures: [
              {
                assessments: [],
                fixture: fixtureReference,
                modelAssuranceAssessments: [],
                replay: baselineReplay,
              },
            ],
          },
          calculationPolicy: {
            confidenceIntervals: "source_only",
            decimalArithmetic: "exact_decimal_v1",
            denominators: "role_fixture_membership_and_paired_observations",
            fixturePairing: "logical_fixture_id",
            invalidCases: "preserve_and_exclude_from_aggregation",
            mean: "exact_rational_v1",
            minimumPairedCoverageBasisPoints: 10_000,
            missingness: "preserve_all",
            numericObservationMultiplicity: "at_most_one_per_fixture",
            quantile: "nearest_rank_v1",
          },
          candidate: {
            dataset: datasetReference,
            fixtures: [
              {
                assessments: [],
                fixture: fixtureReference,
                modelAssuranceAssessments: [],
                replay: candidateReplay,
              },
            ],
          },
          classifiedContentProjection: "metadata_only",
          comparisonVersionId,
          description: "Exact retained failure, replay, usage, and artifact evidence",
          metrics: [
            {
              aggregation: { method: "median", methodVersion: "1.0.0" },
              dimension: "elapsedMilliseconds",
              kind: "replay_usage",
              label: "Median elapsed milliseconds",
              metricId: `metric_elapsed_${runKey}`,
              stratumId: `stratum_all_${runKey}`,
              unit: "milliseconds",
            },
            {
              eventKind: "agent.run",
              eventStatus: "error",
              kind: "trace_event_count",
              label: "Failed agent runs",
              metricId: `metric_trace_${runKey}`,
              stratumId: `stratum_all_${runKey}`,
              unit: "events",
            },
          ],
          name: "Source-backed comparison restart proof",
          strata: [
            {
              fixtureIds: [fixtureId],
              label: "Exact retained failure fixture",
              stratumId: `stratum_all_${runKey}`,
            },
          ],
        },
        method: "POST",
        url: `${scopeUrl}/comparisons/${comparisonId}/definitions/${comparisonVersionId}`,
      });
      expect(comparisonResponse.statusCode, comparisonResponse.body).toBe(201);
      const comparisonResult = comparisonResponse.json<PublishComparisonRecordResponse>().result;
      if (comparisonResult.kind !== "comparison_definition") {
        throw new Error("Expected an immutable comparison definition");
      }
      comparisonReference = {
        comparisonId,
        comparisonVersionId,
        definitionSha256: comparisonResult.record.definitionSha256,
      };
    } finally {
      await firstApp.close();
    }

    if (!comparisonReference) throw new Error("Expected an exact comparison reference");
    const snapshotRecords = [];
    let resultDefinitionSha256: string | undefined;
    const restartedApp = await createApp(persistentArtifactConfig());
    try {
      for (const role of ["baseline", "candidate"] as const) {
        const snapshotId = `snapshot_${role}_${runKey}`;
        const response = await restartedApp.inject({
          body: { comparison: comparisonReference, role, snapshotId },
          method: "POST",
          url: `${scopeUrl}/comparisons/evidence-snapshots/${snapshotId}`,
        });
        expect(response.statusCode, response.body).toBe(201);
        const result = response.json<PublishComparisonRecordResponse>().result;
        if (result.kind !== "comparison_evidence_snapshot") {
          throw new Error("Expected an immutable comparison evidence snapshot");
        }
        expect(result.record).toMatchObject({
          fixtures: [
            {
              artifacts: [{ availability: "available" }],
              assurance: [],
              evaluationOutcomes: [],
              fixture: { fixtureId, fixtureVersionId },
              trace: {
                eventCount: 1,
                eventKindStatuses: [{ count: 1, kind: "agent.run", status: "error" }],
              },
            },
          ],
          integrity: "verified",
          omissions: [
            {
              fixtureId,
              projectionKey: "classified_content",
              reason: "classified_content_excluded",
              sourceKind: "classified_content",
            },
          ],
          role,
          snapshotId,
        });
        expect(result.record.fixtures[0]?.usage).toEqual(
          expect.arrayContaining([
            {
              dimension: "elapsedMilliseconds",
              value: {
                amount: role === "baseline" ? 125 : 100,
                observedCount: 1,
                sources: ["measured"],
                status: "available",
                unavailableCount: 0,
              },
            },
          ]),
        );
        snapshotRecords.push(result.record);
      }
      const [baselineSnapshot, candidateSnapshot] = snapshotRecords;
      if (!baselineSnapshot || !candidateSnapshot) {
        throw new Error("Expected both immutable evidence snapshots");
      }
      const resultId = `result_${runKey}`;
      const resultResponse = await restartedApp.inject({
        body: {
          baselineSnapshot: {
            definitionSha256: baselineSnapshot.definitionSha256,
            role: "baseline",
            snapshotId: baselineSnapshot.snapshotId,
          },
          candidateSnapshot: {
            definitionSha256: candidateSnapshot.definitionSha256,
            role: "candidate",
            snapshotId: candidateSnapshot.snapshotId,
          },
          comparison: comparisonReference,
          resultId,
        },
        method: "POST",
        url: `${scopeUrl}/comparisons/results/${resultId}`,
      });
      expect(resultResponse.statusCode, resultResponse.body).toBe(201);
      const result = resultResponse.json<PublishComparisonRecordResponse>().result;
      if (result.kind !== "comparison_result") {
        throw new Error("Expected an immutable comparison result");
      }
      expect(result.record.metricResults).toEqual([
        expect.objectContaining({
          metricId: `metric_elapsed_${runKey}`,
          value: expect.objectContaining({
            delta: expect.objectContaining({
              denominator: "1",
              numerator: "-25",
              unit: "milliseconds",
            }),
            direction: "decreased",
            status: "available",
          }),
        }),
        expect.objectContaining({ metricId: `metric_trace_${runKey}` }),
      ]);
      resultDefinitionSha256 = result.record.definitionSha256;
    } finally {
      await restartedApp.close();
    }

    if (!resultDefinitionSha256) throw new Error("Expected a retained comparison result digest");
    const finalApp = await createApp(persistentArtifactConfig());
    try {
      const records = await Promise.all([
        finalApp.inject({
          method: "GET",
          url: `${scopeUrl}/comparisons/records/comparison_definition/${comparisonVersionId}`,
        }),
        ...snapshotRecords.map((snapshot) =>
          finalApp.inject({
            method: "GET",
            url: `${scopeUrl}/comparisons/records/comparison_evidence_snapshot/${snapshot.snapshotId}`,
          }),
        ),
        finalApp.inject({
          method: "GET",
          url: `${scopeUrl}/comparisons/records/comparison_result/result_${runKey}`,
        }),
      ]);
      expect(records.map(({ statusCode }) => statusCode)).toEqual([200, 200, 200, 200]);
      expect(records[0]?.json()).toMatchObject({
        result: {
          kind: "comparison_definition",
          record: { definitionSha256: comparisonReference.definitionSha256 },
        },
      });
      expect(records[1]?.json()).toMatchObject({
        result: {
          kind: "comparison_evidence_snapshot",
          record: { definitionSha256: snapshotRecords[0]?.definitionSha256 },
        },
      });
      expect(records[2]?.json()).toMatchObject({
        result: {
          kind: "comparison_evidence_snapshot",
          record: { definitionSha256: snapshotRecords[1]?.definitionSha256 },
        },
      });
      expect(records[3]?.json()).toMatchObject({
        result: {
          kind: "comparison_result",
          record: { definitionSha256: resultDefinitionSha256 },
        },
      });
    } finally {
      await finalApp.close();
    }
  }, 30_000);

  it("authenticates a bootstrapped key and observes authoritative revocation", async () => {
    const traceId = "7bf92f3577b34da6a3ce929d0e0e4736";
    const authorization = `Bearer ${issuedApiKey.value}`;
    const app = await createApp(apiKeyConfig());
    try {
      const ingest = await app.inject({
        body: {
          events: [
            {
              eventId: "evt_api_key_integration_001",
              kind: "agent.run",
              name: "api-key-integration",
              source: {
                sdkName: "@proofstack/sdk",
                sdkVersion: "0.0.0",
                serviceName: "api-key-integration",
              },
              spanId: "60f067aa0ba902b7",
              startedAt: "2026-08-28T03:59:59.000Z",
              traceId,
            },
          ],
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
        },
        headers: { authorization },
        method: "POST",
        url: "/v1/projects/prj_local/environments/env_local/evidence",
      });
      const trace = await app.inject({
        headers: { authorization },
        method: "GET",
        url: `/v1/projects/prj_local/environments/env_local/traces/${traceId}`,
      });
      const wrongLastCharacter = issuedApiKey.value.endsWith("A") ? "B" : "A";
      const wrongKey = `${issuedApiKey.value.slice(0, -1)}${wrongLastCharacter}`;
      const rejected = await app.inject({
        headers: { authorization: `Bearer ${wrongKey}` },
        method: "GET",
        url: `/v1/projects/prj_local/environments/env_local/traces/${traceId}`,
      });

      expect(ingest.statusCode).toBe(202);
      expect(trace.statusCode).toBe(200);
      expect(rejected.statusCode).toBe(401);
      expect(rejected.body).not.toContain(issuedApiKey.credential.prefix);

      const beforeRevocation = await inspectIdentityCredentials(adminPool, "ten_local");
      expect(beforeRevocation.active).toBeGreaterThanOrEqual(1);
      const administrator = new PostgresApiKeyCredentialRepository(adminPool);
      await expect(
        administrator.revoke(
          "ten_local",
          issuedApiKey.credential.credentialId,
          "usr_integration_operator",
          "integration verification complete",
        ),
      ).resolves.toBe(true);

      const revoked = await app.inject({
        headers: { authorization },
        method: "GET",
        url: `/v1/projects/prj_local/environments/env_local/traces/${traceId}`,
      });
      expect(revoked.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
