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
  EVIDENCE_SCHEMA_VERSION,
  InteractionCaptureManifestSchema,
  type PublishRegressionDatasetVersionResponse,
  type PublishRegressionFixtureVersionResponse,
  type RecordedInteractionFixtureVersionDefinition,
  RecordedInteractionFixtureVersionDefinitionSchema,
} from "@proofstack/contracts";
import { decodeOtlpJson, encodeOtlpProtobufRequest } from "@proofstack/otlp";
import {
  bootstrapApiKey,
  createPostgresPool,
  inspectIdentityCredentials,
  migrateDatabase,
  PostgresApiKeyCredentialRepository,
  provisionRuntimeRoles,
} from "@proofstack/postgres";
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
