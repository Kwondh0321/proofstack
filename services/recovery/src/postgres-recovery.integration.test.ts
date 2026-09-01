import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { CreateBucketCommand, DeleteBucketCommand } from "@aws-sdk/client-s3";
import {
  ArtifactCipher,
  ArtifactConflictError,
  ArtifactNotFoundError,
  ArtifactObjectMissingError,
  ArtifactProtectionError,
  ArtifactUnavailableError,
  LocalArtifactKeyring,
  PurgeArtifact,
  ReadArtifact,
  ReserveArtifact,
  SecureArtifactIdentityGenerator,
  StrictArtifactContentInspector,
  TombstoneArtifact,
  UploadArtifact,
} from "@proofstack/artifacts";
import type {
  EvidenceEnvelope,
  EvidenceScope,
  InteractionCaptureManifest,
  PrincipalContext,
  RecordedInteractionFixtureVersion,
  RecordedInteractionFixtureVersionDefinition,
  RegressionDatasetVersion,
  RegressionFixtureVersion,
  ReplayPlanDefinition,
  TargetReleaseDefinition,
} from "@proofstack/contracts";
import {
  InteractionCaptureManifestSchema,
  RecordedInteractionFixtureVersionDefinitionSchema,
  ReplayJobSchema,
  ReplayPlanSchema,
  ReplayWorkerMutationFenceSchema,
  TargetReleaseSchema,
} from "@proofstack/contracts";
import {
  createEvaluationRepositoryTestHarness,
  publishEvaluationFixture,
} from "@proofstack/core/testing";
import {
  buildRecordedInteractionFixtureVersionPublishedOutboxIntent,
  buildRegressionDatasetVersionPublishedOutboxIntent,
  buildRegressionFixtureVersionPublishedOutboxIntent,
  PublishRecordedInteractionFixtureVersion,
  PublishRegressionDatasetVersion,
  PublishRegressionFixtureVersion,
  type RegressionVersionPublishedOutboxIntent,
  RevokeRecordedInteractionFixtureContent,
  SecureInteractionFixtureRevocationIdentityGenerator,
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
  PostgresEvaluationRepository,
  PostgresEvidenceRepository,
  PostgresOidcIdentityRepository,
  PostgresProjectionCursorRepository,
  PostgresRegressionVersionRepository,
  provisionRuntimeRoles,
  type RuntimeRoleProvisioningOptions,
} from "@proofstack/postgres";
import { encodeRecoveryObjectInventory, verifyRecoverySet } from "@proofstack/recovery";
import { createS3ArtifactObjectStore, createS3Client } from "@proofstack/s3";
import { Pool, type PoolClient } from "pg";
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
  "proofstack_evaluation_aggregates",
  "proofstack_evaluation_aggregation_policies",
  "proofstack_evaluation_assessments",
  "proofstack_evaluation_criterion_set_statuses",
  "proofstack_evaluation_criterion_sets",
  "proofstack_evaluation_discovery_records",
  "proofstack_evaluation_evaluator_specs",
  "proofstack_evaluation_lineage",
  "proofstack_evaluation_oracle_specs",
  "proofstack_evaluation_qualification_fixture_sets",
  "proofstack_evaluation_qualification_reports",
  "proofstack_evaluation_raw_observations",
  "proofstack_evaluation_record_registry",
  "proofstack_evaluation_records",
  "proofstack_evaluation_resource_bindings",
  "proofstack_evaluation_run_rejections",
  "proofstack_evaluation_run_results",
  "proofstack_evaluation_runs",
  "proofstack_evaluation_source_reviews",
  "proofstack_evaluation_source_snapshots",
  "proofstack_evaluation_unique_bindings",
  "proofstack_identity_audit_events",
  "proofstack_interaction_fixture_artifact_ownerships",
  "proofstack_interaction_fixture_content_revocations",
  "proofstack_oidc_bindings",
  "proofstack_oidc_login_transactions",
  "proofstack_outbox",
  "proofstack_projection_cursors",
  "proofstack_recorded_interaction_fixture_versions",
  "proofstack_recovery_state",
  "proofstack_regression_dataset_members",
  "proofstack_regression_dataset_versions",
  "proofstack_regression_datasets",
  "proofstack_regression_fixture_events",
  "proofstack_regression_fixture_versions",
  "proofstack_regression_fixtures",
  "proofstack_replay_attempt_events",
  "proofstack_replay_attempts",
  "proofstack_replay_budget_entries",
  "proofstack_replay_budget_entry_dimensions",
  "proofstack_replay_cancellation_acknowledgements",
  "proofstack_replay_cancellation_requests",
  "proofstack_replay_jobs",
  "proofstack_replay_observations",
  "proofstack_replay_plan_boundaries",
  "proofstack_replay_plan_budgets",
  "proofstack_replay_plan_resources",
  "proofstack_replay_plans",
  "proofstack_replay_recovery_events",
  "proofstack_replay_targets",
  "proofstack_replay_usage_measurements",
  "proofstack_schema_migrations",
  "proofstack_target_releases",
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
const artifactKeyId = "key_recovery_primary";
const rotatedArtifactKeyId = "key_recovery_rotated";
const artifactKeyMaterial = Buffer.alloc(32, 29);
const rotatedArtifactKeyMaterial = Buffer.alloc(32, 37);
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
let recordedRecoveryState:
  | {
      readonly afterRestoreContent: ReadonlyMap<string, Uint8Array>;
      readonly afterRestoreManifest: InteractionCaptureManifest;
      readonly availableContent: ReadonlyMap<string, Uint8Array>;
      readonly availableVersion: RecordedInteractionFixtureVersion;
      readonly revokedVersion: RecordedInteractionFixtureVersion;
    }
  | undefined;
let replayRecoveryState:
  | {
      readonly queuedJobId: string;
      readonly runningJobId: string;
      readonly sourceFence: ReturnType<typeof ReplayWorkerMutationFenceSchema.parse>;
      readonly sourceJob: ReturnType<typeof ReplayJobSchema.parse>;
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
    capabilities: [
      "artifact:delete",
      "artifact:read",
      "artifact:read:restricted",
      "artifact:write",
    ],
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
    capabilities: ["artifact:delete", "dataset:manage", "evidence:read"],
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
): Promise<{
  readonly afterRestore: {
    readonly content: ReadonlyMap<string, Uint8Array>;
    readonly manifest: InteractionCaptureManifest;
  };
  readonly available: {
    readonly content: ReadonlyMap<string, Uint8Array>;
    readonly manifest: InteractionCaptureManifest;
    readonly rotatedArtifactId: string;
  };
  readonly revoked: {
    readonly content: ReadonlyMap<string, Uint8Array>;
    readonly manifest: InteractionCaptureManifest;
  };
}> {
  const identities = new SecureArtifactIdentityGenerator();
  const principal = artifactPrincipal();
  const keys = {
    [artifactKeyId]: artifactKeyMaterial,
    [rotatedArtifactKeyId]: rotatedArtifactKeyMaterial,
  };
  const store = async (input: {
    readonly artifactId: string;
    readonly classification: "confidential" | "internal" | "restricted";
    readonly content: Uint8Array;
    readonly keyId: string;
    readonly mediaType: string;
  }): Promise<void> => {
    const cipher = new ArtifactCipher(new LocalArtifactKeyring({ activeKeyId: input.keyId, keys }));
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
      inspection: new StrictArtifactContentInspector(),
      objects: sourceObjects,
    });
    await reserve.execute({
      environmentId: scope.environmentId,
      principal,
      projectId: scope.projectId,
      request: {
        artifactId: input.artifactId,
        classification: input.classification,
        mediaType: input.mediaType,
        redaction: { status: "not_required" },
        retention: { mode: "retain" },
        sha256: sha256(input.content),
        sizeBytes: input.content.byteLength,
      },
    });
    await upload.execute({
      artifactId: input.artifactId,
      content: input.content,
      environmentId: scope.environmentId,
      principal,
      projectId: scope.projectId,
    });
    const entry = await artifactRepository.find(scope, input.artifactId);
    if (!entry) throw new Error(`Recovery artifact ${input.artifactId} is missing after upload`);
    trackedObjectKeys.add(entry.objectKey);
  };

  await store({
    artifactId: availableArtifactId,
    classification: "internal",
    content: availableArtifactContent,
    keyId: artifactKeyId,
    mediaType: "application/json",
  });
  await store({
    artifactId: purgedArtifactId,
    classification: "confidential",
    content: Buffer.from(
      JSON.stringify({ evidence: "must remain deleted", status: "purged" }),
      "utf8",
    ),
    keyId: artifactKeyId,
    mediaType: "application/json",
  });
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

  const vectorDocument = JSON.parse(
    await readFile(
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
  };
  const vectorDefinition = RecordedInteractionFixtureVersionDefinitionSchema.parse(
    vectorDocument.vectors[0]?.input,
  );
  const buildCapture = (
    variant: "after_restore" | "available" | "revoked",
  ): {
    readonly content: ReadonlyMap<string, Uint8Array>;
    readonly manifest: InteractionCaptureManifest;
  } => {
    const remappedIds = new Map(
      vectorDefinition.interactionCapture.artifacts.map((binding) => [
        binding.contentReference.artifactId,
        `${binding.contentReference.artifactId}_${variant}`,
      ]),
    );
    const remap = (artifactId: string): string => {
      const remapped = remappedIds.get(artifactId);
      if (!remapped) throw new Error(`Recovery capture artifact ${artifactId} is not declared`);
      return remapped;
    };
    const content = new Map(
      vectorDefinition.interactionCapture.artifacts.map((binding) => {
        const artifactId = remap(binding.contentReference.artifactId);
        return [
          artifactId,
          Buffer.from(JSON.stringify({ artifactId, recovery: true, variant }), "utf8"),
        ] as const;
      }),
    );
    const digests = new Map(
      [...content].map(([artifactId, value]) => [artifactId, sha256(value)] as const),
    );
    const artifacts = vectorDefinition.interactionCapture.artifacts.map((binding, index) => {
      const artifactId = remap(binding.contentReference.artifactId);
      const value = content.get(artifactId);
      if (!value) throw new Error(`Recovery capture content ${artifactId} is missing`);
      const classification =
        variant === "revoked"
          ? ("confidential" as const)
          : (["internal", "confidential", "restricted"] as const)[index % 3];
      if (!classification) throw new Error("Recovery capture classification is missing");
      return {
        ...binding,
        contentReference: {
          ...binding.contentReference,
          artifactId,
          classification,
          sha256: sha256(value),
          sizeBytes: value.byteLength,
        },
      };
    });
    const interactions = vectorDefinition.interactionCapture.interactions.map((interaction) => {
      if (interaction.kind === "model") {
        return {
          ...interaction,
          attempts: interaction.attempts.map((attempt) => ({
            ...attempt,
            artifacts: {
              inputMessagesArtifactId: remap(attempt.artifacts.inputMessagesArtifactId),
              ...(attempt.artifacts.outputMessagesArtifactId
                ? {
                    outputMessagesArtifactId: remap(attempt.artifacts.outputMessagesArtifactId),
                  }
                : {}),
              ...(attempt.artifacts.promptVariablesArtifactId
                ? {
                    promptVariablesArtifactId: remap(attempt.artifacts.promptVariablesArtifactId),
                  }
                : {}),
              providerConfigurationArtifactId: remap(
                attempt.artifacts.providerConfigurationArtifactId,
              ),
              providerRequestArtifactId: remap(attempt.artifacts.providerRequestArtifactId),
              ...(attempt.artifacts.providerResponseArtifactId
                ? {
                    providerResponseArtifactId: remap(attempt.artifacts.providerResponseArtifactId),
                  }
                : {}),
              ...(attempt.artifacts.streamingFramesArtifactId
                ? {
                    streamingFramesArtifactId: remap(attempt.artifacts.streamingFramesArtifactId),
                  }
                : {}),
              ...(attempt.artifacts.systemInstructionsArtifactId
                ? {
                    systemInstructionsArtifactId: remap(
                      attempt.artifacts.systemInstructionsArtifactId,
                    ),
                  }
                : {}),
            },
            normalizedRequest: {
              ...attempt.normalizedRequest,
              artifactId: remap(attempt.normalizedRequest.artifactId),
              sha256: digests.get(remap(attempt.normalizedRequest.artifactId)),
            },
          })),
          prompt: {
            ...interaction.prompt,
            artifactId: remap(interaction.prompt.artifactId),
            definitionSha256: digests.get(remap(interaction.prompt.artifactId)),
          },
          toolContracts: interaction.toolContracts.map((tool) => ({
            ...tool,
            artifactId: remap(tool.artifactId),
            definitionSha256: digests.get(remap(tool.artifactId)),
          })),
        };
      }
      return {
        ...interaction,
        attempts: interaction.attempts.map((attempt) => ({
          ...attempt,
          artifacts: {
            argumentsArtifactId: remap(attempt.artifacts.argumentsArtifactId),
            ...(attempt.artifacts.resultArtifactId
              ? { resultArtifactId: remap(attempt.artifacts.resultArtifactId) }
              : {}),
          },
          normalizedRequest: {
            ...attempt.normalizedRequest,
            artifactId: remap(attempt.normalizedRequest.artifactId),
            sha256: digests.get(remap(attempt.normalizedRequest.artifactId)),
          },
        })),
        tool: {
          ...interaction.tool,
          artifactId: remap(interaction.tool.artifactId),
          definitionSha256: digests.get(remap(interaction.tool.artifactId)),
        },
      };
    });
    return {
      content,
      manifest: InteractionCaptureManifestSchema.parse({
        ...vectorDefinition.interactionCapture,
        artifacts,
        interactions,
      }),
    };
  };

  const afterRestore = buildCapture("after_restore");
  const available = buildCapture("available");
  const revoked = buildCapture("revoked");
  for (const capture of [available, revoked]) {
    for (const [index, binding] of capture.manifest.artifacts.entries()) {
      const content = capture.content.get(binding.contentReference.artifactId);
      if (!content) throw new Error("Recovery capture content is missing before storage");
      const classification = binding.contentReference.classification;
      if (classification === "metadata") {
        throw new Error("Recovery interaction content cannot use metadata classification");
      }
      await store({
        artifactId: binding.contentReference.artifactId,
        classification,
        content,
        keyId: index % 2 === 0 ? artifactKeyId : rotatedArtifactKeyId,
        mediaType: binding.contentReference.mediaType,
      });
    }
  }
  const rotatedArtifactId = available.manifest.artifacts[1]?.contentReference.artifactId;
  if (!rotatedArtifactId) throw new Error("Recovery capture rotated artifact is missing");
  return { afterRestore, available: { ...available, rotatedArtifactId }, revoked };
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

async function seedRecoverableRecordedFixtures(
  captures: Awaited<ReturnType<typeof seedRecoverableArtifacts>>,
): Promise<void> {
  const catalog = requiredRegressionCatalogState();
  const versionRepository = new PostgresRegressionVersionRepository(sourcePool);
  const principal = regressionPrincipal();
  const publishAt = (instant: string) =>
    new PublishRecordedInteractionFixtureVersion({
      clock: regressionClock(instant),
      versionRepository,
    });
  const available = await publishAt("2026-08-28T03:09:00.000Z").execute({
    environmentId: scope.environmentId,
    fixtureId: catalog.secondFixtureRoot.fixtureId,
    principal,
    projectId: scope.projectId,
    request: {
      fixtureVersionId: "fixv_recovery_secondary_recorded",
      interactionCapture: captures.available.manifest,
      name: "Recovery available interaction fixture",
      predecessorVersionId: catalog.secondFixtureRoot.fixtureVersionId,
    },
  });
  const revoked = await publishAt("2026-08-28T03:10:00.000Z").execute({
    environmentId: scope.environmentId,
    fixtureId: catalog.fixtureChild.fixtureId,
    principal,
    projectId: scope.projectId,
    request: {
      fixtureVersionId: "fixv_recovery_primary_recorded",
      interactionCapture: captures.revoked.manifest,
      name: "Recovery revoked interaction fixture",
      predecessorVersionId: catalog.fixtureChild.fixtureVersionId,
    },
  });
  const revocation = await new RevokeRecordedInteractionFixtureContent({
    clock: regressionClock("2026-08-28T03:11:00.000Z"),
    identities: new SecureInteractionFixtureRevocationIdentityGenerator(),
    versionRepository,
  }).execute({
    environmentId: scope.environmentId,
    fixtureId: revoked.version.fixtureId,
    fixtureVersionId: revoked.version.fixtureVersionId,
    principal,
    projectId: scope.projectId,
    request: { reason: "Recovery rehearsal recorded content revocation" },
  });
  expect(revocation.contentAvailability).toBe("revoked");

  const artifactRepository = new PostgresArtifactCatalogRepository(sourcePool);
  const purge = new PurgeArtifact({
    catalog: artifactRepository,
    clock: { now: () => new Date("2026-08-28T03:12:00.000Z") },
    identities: new SecureArtifactIdentityGenerator(),
    objects: sourceObjects,
  });
  for (const [index, binding] of captures.revoked.manifest.artifacts.entries()) {
    if (index % 2 === 0) {
      await purge.execute({
        artifactId: binding.contentReference.artifactId,
        environmentId: scope.environmentId,
        principal: artifactPrincipal(),
        projectId: scope.projectId,
      });
    }
  }

  recordedRecoveryState = {
    afterRestoreContent: captures.afterRestore.content,
    afterRestoreManifest: captures.afterRestore.manifest,
    availableContent: captures.available.content,
    availableVersion: available.version,
    revokedVersion: revoked.version,
  };
}

async function withRecoveryTenantTransactionOn<Result>(
  database: Pool,
  work: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('proofstack.tenant_id', $1, true)", [scope.tenantId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function withRecoveryTenantTransaction<Result>(
  work: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  return withRecoveryTenantTransactionOn(sourcePool, work);
}

async function seedRecoverableReplayState(): Promise<void> {
  const dataset = requiredRegressionCatalogState().datasetRoot;
  const workerProtocol = { name: "proofstack.replay-worker", version: "1.0.0" } as const;
  const targetAdapter = {
    name: "proofstack.recovery_target",
    protocolVersion: "1.0.0",
    version: "1.0.0",
  } as const;
  const targetDefinition = {
    build: {
      builderId: "proofstack.recovery_builder",
      dependencySnapshotSha256: "1".repeat(64),
      executableSha256: "2".repeat(64),
      invocationSha256: "3".repeat(64),
      provenance: {
        artifactId: availableArtifactId,
        classification: "internal",
        mediaType: "application/json",
        sha256: sha256(availableArtifactContent),
        sizeBytes: availableArtifactContent.byteLength,
      },
    },
    environmentVariableNames: [],
    execution: {
      implementationId: "impl_recovery_target",
      implementationSha256: "4".repeat(64),
      kind: "preinstalled",
    },
    mounts: [],
    outputLimits: {
      emittedArtifactBytes: 1_048_576,
      stderrBytes: 65_536,
      stdoutBytes: 65_536,
    },
    runtime: {
      architecture: "x64",
      entryPoint: "dist/recovery-target.js",
      family: "node",
      platform: "linux",
      version: "24.13.1",
    },
    schemaVersion: "0.1",
    scope,
    source: {
      repositoryUrl: "https://github.com/Kwondh0321/proofstack",
      revision: proofstackRevision(),
    },
    subprocessPolicy: { mode: "denied" },
    supportedBoundaryKinds: ["model"],
    supportedBoundaryModes: ["live_provider"],
    targetAdapter,
    targetId: "target_recovery",
    targetReleaseId: "trg_recovery_001",
    workerProtocol,
  } as const satisfies TargetReleaseDefinition;
  const targetRelease = TargetReleaseSchema.parse({
    ...targetDefinition,
    createdAt: "2026-08-28T03:10:00.000Z",
    createdByPrincipalId: "usr_recovery",
    definitionSha256: "b".repeat(64),
  });
  const boundary = {
    boundaryId: "bnd_recovery_model",
    credential: {
      credentialId: "cred_recovery_model",
      credentialVersionId: "crv_recovery_model_001",
    },
    destination: {
      hostname: "api.recovery.example",
      port: 443,
      scheme: "https",
    },
    endpointProfile: {
      definitionSha256: "5".repeat(64),
      endpointProfileId: "end_recovery_model",
      endpointProfileVersion: "1.0.0",
    },
    kind: "model",
    mode: "live_provider",
    operation: "generate",
    requestLimits: { requestBytes: 4_096, responseBytes: 65_536 },
    sideEffect: { kind: "read_only" },
    usageSource: "provider_reported",
  } as const;
  const planDefinition = {
    boundaries: [boundary],
    budget: {
      concurrentInteractions: { limit: 1, measurement: "measured" },
      elapsedMilliseconds: { limit: 1_200_000, measurement: "measured" },
      emittedArtifactBytes: { limit: 1_048_576, measurement: "measured" },
      inputTokens: { limit: 4_096, measurement: "provider_reported" },
      jobAttempts: { limit: 2, measurement: "measured" },
      modelRequests: { limit: 4, measurement: "measured" },
      outputTokens: { limit: 4_096, measurement: "provider_reported" },
      providerCostMicrounits: { limit: 1_000_000, measurement: "unavailable" },
      retrievedBytes: { limit: 1_048_576, measurement: "measured" },
      toolCalls: { limit: 4, measurement: "measured" },
    },
    dataset: {
      datasetId: dataset.datasetId,
      datasetVersionId: dataset.datasetVersionId,
      definitionSha256: dataset.definitionSha256,
    },
    isolationProfile: {
      definitionSha256: "6".repeat(64),
      id: "iso_recovery_local",
      kind: "local_child_process",
      version: "1.0.0",
    },
    planId: "plan_recovery",
    planVersionId: "plv_recovery_001",
    retryPolicy: {
      automatic: true,
      backoff: { kind: "none" },
      idempotencyRequirement: "read_only",
      maxAttempts: 2,
      perAttemptTimeoutMilliseconds: 600_000,
      retryableErrors: ["target_process_interrupted"],
      totalDeadlineMilliseconds: 1_200_000,
    },
    runtimeProfile: {
      definitionSha256: "7".repeat(64),
      family: "node",
      id: "run_recovery_node",
      version: "1.0.0",
    },
    schemaVersion: "0.1",
    scope,
    targetRelease: {
      definitionSha256: targetRelease.definitionSha256,
      targetAdapter,
      targetId: targetRelease.targetId,
      targetReleaseId: targetRelease.targetReleaseId,
      workerProtocol,
    },
    workerProtocol,
  } as const satisfies ReplayPlanDefinition;
  const replayPlan = ReplayPlanSchema.parse({
    ...planDefinition,
    createdAt: "2026-08-28T03:11:00.000Z",
    createdByPrincipalId: "usr_recovery",
    definitionSha256: "c".repeat(64),
  });

  await withRecoveryTenantTransaction(async (client) => {
    await client.query(
      `INSERT INTO public.proofstack_replay_targets (
        tenant_id, project_id, environment_id, target_id
      ) VALUES ($1, $2, $3, $4)`,
      [scope.tenantId, scope.projectId, scope.environmentId, targetRelease.targetId],
    );
    await client.query(
      `INSERT INTO public.proofstack_target_releases (
        tenant_id, project_id, environment_id, target_id, target_release_id,
        schema_version, definition_sha256, target_adapter_name, target_adapter_version,
        target_adapter_protocol_version, worker_protocol_name, worker_protocol_version,
        execution_kind, provenance_artifact_id, execution_artifact_id,
        emitted_artifact_bytes, stderr_bytes, stdout_bytes, created_at, created_at_lexical,
        created_by_principal_id, release
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NULL,
        $15, $16, $17, $18::timestamptz, $19, $20, $21::jsonb
      )`,
      [
        scope.tenantId,
        scope.projectId,
        scope.environmentId,
        targetRelease.targetId,
        targetRelease.targetReleaseId,
        targetRelease.schemaVersion,
        targetRelease.definitionSha256,
        targetRelease.targetAdapter.name,
        targetRelease.targetAdapter.version,
        targetRelease.targetAdapter.protocolVersion,
        targetRelease.workerProtocol.name,
        targetRelease.workerProtocol.version,
        targetRelease.execution.kind,
        targetRelease.build.provenance.artifactId,
        targetRelease.outputLimits.emittedArtifactBytes,
        targetRelease.outputLimits.stderrBytes,
        targetRelease.outputLimits.stdoutBytes,
        targetRelease.createdAt,
        targetRelease.createdAt,
        targetRelease.createdByPrincipalId,
        JSON.stringify(targetRelease),
      ],
    );
    await client.query(
      `INSERT INTO public.proofstack_replay_plan_resources (
        tenant_id, project_id, environment_id, plan_id
      ) VALUES ($1, $2, $3, $4)`,
      [scope.tenantId, scope.projectId, scope.environmentId, replayPlan.planId],
    );
    await client.query(
      `INSERT INTO public.proofstack_replay_plans (
        tenant_id, project_id, environment_id, plan_id, plan_version_id, schema_version,
        definition_sha256, target_id, target_release_id, target_definition_sha256,
        target_adapter_name, target_adapter_version, target_adapter_protocol_version,
        worker_protocol_name, worker_protocol_version, dataset_id, dataset_version_id,
        dataset_definition_sha256, runtime_profile_id, runtime_profile_version,
        runtime_profile_definition_sha256, isolation_profile_id, isolation_profile_version,
        isolation_profile_definition_sha256, boundary_count, retry_automatic,
        retry_max_attempts, retry_per_attempt_timeout_milliseconds,
        retry_total_deadline_milliseconds, created_at, created_at_lexical,
        created_by_principal_id, plan
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29,
        $30::timestamptz, $31, $32, $33::jsonb
      )`,
      [
        scope.tenantId,
        scope.projectId,
        scope.environmentId,
        replayPlan.planId,
        replayPlan.planVersionId,
        replayPlan.schemaVersion,
        replayPlan.definitionSha256,
        replayPlan.targetRelease.targetId,
        replayPlan.targetRelease.targetReleaseId,
        replayPlan.targetRelease.definitionSha256,
        replayPlan.targetRelease.targetAdapter.name,
        replayPlan.targetRelease.targetAdapter.version,
        replayPlan.targetRelease.targetAdapter.protocolVersion,
        replayPlan.workerProtocol.name,
        replayPlan.workerProtocol.version,
        replayPlan.dataset.datasetId,
        replayPlan.dataset.datasetVersionId,
        replayPlan.dataset.definitionSha256,
        replayPlan.runtimeProfile.id,
        replayPlan.runtimeProfile.version,
        replayPlan.runtimeProfile.definitionSha256,
        replayPlan.isolationProfile.id,
        replayPlan.isolationProfile.version,
        replayPlan.isolationProfile.definitionSha256,
        replayPlan.boundaries.length,
        replayPlan.retryPolicy.automatic,
        replayPlan.retryPolicy.maxAttempts,
        replayPlan.retryPolicy.perAttemptTimeoutMilliseconds,
        replayPlan.retryPolicy.totalDeadlineMilliseconds,
        replayPlan.createdAt,
        replayPlan.createdAt,
        replayPlan.createdByPrincipalId,
        JSON.stringify(replayPlan),
      ],
    );
    await client.query(
      `INSERT INTO public.proofstack_replay_plan_budgets (
        tenant_id, project_id, environment_id, plan_id, plan_version_id,
        dimension, limit_value, measurement
      )
      SELECT $1, $2, $3, $4, $5, budget.key,
        (budget.value ->> 'limit')::bigint,
        budget.value ->> 'measurement'
      FROM jsonb_each($6::jsonb) AS budget(key, value)`,
      [
        scope.tenantId,
        scope.projectId,
        scope.environmentId,
        replayPlan.planId,
        replayPlan.planVersionId,
        JSON.stringify(replayPlan.budget),
      ],
    );
    await client.query(
      `INSERT INTO public.proofstack_replay_plan_boundaries (
        tenant_id, project_id, environment_id, plan_id, plan_version_id,
        boundary_position, boundary_id, boundary_kind, boundary_mode,
        recorded_fixture_id, recorded_fixture_version_id, recorded_fixture_definition_sha256,
        recorded_invocation_definition_sha256, simulator_target_id,
        simulator_target_release_id, simulator_definition_sha256,
        simulator_target_adapter_name, simulator_target_adapter_version,
        simulator_target_adapter_protocol_version, simulator_worker_protocol_name,
        simulator_worker_protocol_version, qualification_artifact_id, credential_id,
        credential_version_id, endpoint_profile_id, endpoint_profile_version,
        endpoint_profile_definition_sha256, destination_hostname, destination_port,
        destination_scheme, operation, request_bytes, response_bytes, side_effect_kind,
        risk_acceptance_artifact_id, declaration
      ) VALUES (
        $1, $2, $3, $4, $5, 0, $6, $7, $8,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, NULL, $21::jsonb
      )`,
      [
        scope.tenantId,
        scope.projectId,
        scope.environmentId,
        replayPlan.planId,
        replayPlan.planVersionId,
        boundary.boundaryId,
        boundary.kind,
        boundary.mode,
        boundary.credential.credentialId,
        boundary.credential.credentialVersionId,
        boundary.endpointProfile.endpointProfileId,
        boundary.endpointProfile.endpointProfileVersion,
        boundary.endpointProfile.definitionSha256,
        boundary.destination.hostname,
        boundary.destination.port,
        boundary.destination.scheme,
        boundary.operation,
        boundary.requestLimits.requestBytes,
        boundary.requestLimits.responseBytes,
        boundary.sideEffect.kind,
        JSON.stringify(boundary),
      ],
    );
    const jobId = "job_recovery_001";
    await client.query(
      "SELECT * FROM public.proofstack_create_replay_job($1, $2, $3, $4, $5, $6, $7)",
      [
        scope.projectId,
        scope.environmentId,
        jobId,
        replayPlan.planId,
        replayPlan.planVersionId,
        replayPlan.definitionSha256,
        "usr_recovery",
      ],
    );
    const claim = await client.query<{ readonly worker_fence: unknown }>(
      `SELECT * FROM public.proofstack_claim_replay_job(
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
      )`,
      [
        scope.projectId,
        scope.environmentId,
        jobId,
        "att_recovery_001",
        "lease_recovery_001",
        "worker_recovery_001",
        workerProtocol.name,
        workerProtocol.version,
        "8".repeat(64),
        30_000,
      ],
    );
    const fence = ReplayWorkerMutationFenceSchema.parse(claim.rows[0]?.worker_fence);
    const requested = {
      concurrentInteractions: 0,
      elapsedMilliseconds: 0,
      emittedArtifactBytes: 0,
      inputTokens: 12,
      jobAttempts: 1,
      modelRequests: 1,
      outputTokens: 0,
      providerCostMicrounits: 0,
      retrievedBytes: 0,
      toolCalls: 0,
    };
    await client.query(
      `SELECT * FROM public.proofstack_reserve_replay_budget(
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb
      )`,
      [
        scope.projectId,
        scope.environmentId,
        jobId,
        fence.attemptId,
        fence.leaseId,
        fence.workerId,
        fence.fencingToken,
        fence.recoveryEpoch,
        "res_recovery_001",
        JSON.stringify({ kind: "attempt_start" }),
        JSON.stringify(requested),
      ],
    );
    const measured = (amount: number) => ({ amount, source: "measured", status: "observed" });
    const usage = {
      concurrentInteractions: measured(0),
      elapsedMilliseconds: measured(0),
      emittedArtifactBytes: measured(0),
      inputTokens: { amount: 12, source: "provider_reported", status: "observed" },
      jobAttempts: measured(1),
      modelRequests: measured(1),
      outputTokens: { amount: 0, source: "provider_reported", status: "observed" },
      providerCostMicrounits: { reason: "source_unavailable", status: "unavailable" },
      retrievedBytes: measured(0),
      toolCalls: measured(0),
    };
    await client.query(
      `SELECT * FROM public.proofstack_reconcile_replay_budget(
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
      )`,
      [
        scope.projectId,
        scope.environmentId,
        jobId,
        fence.attemptId,
        fence.leaseId,
        fence.workerId,
        fence.fencingToken,
        fence.recoveryEpoch,
        "rec_recovery_001",
        "res_recovery_001",
        JSON.stringify(usage),
      ],
    );
    await client.query(
      `SELECT * FROM public.proofstack_append_replay_execution_observation(
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb
      )`,
      [
        scope.projectId,
        scope.environmentId,
        jobId,
        fence.attemptId,
        fence.leaseId,
        fence.workerId,
        fence.fencingToken,
        fence.recoveryEpoch,
        "obs_recovery_execution_001",
        JSON.stringify({
          control: "process_boundary",
          evidenceSha256: "9".repeat(64),
          kind: "isolation",
          verdict: "verified",
        }),
      ],
    );
    const observationClock = await client.query<{ readonly observed_at: string }>(`
      SELECT to_char(
        transaction_timestamp() AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) AS observed_at
    `);
    const observedAt = observationClock.rows[0]?.observed_at;
    if (!observedAt) throw new Error("Recovery replay observation clock is unavailable");
    const usageObservation = {
      boundaryId: boundary.boundaryId,
      measurements: [
        {
          dimension: "inputTokens",
          usage: { amount: 12, source: "provider_reported", status: "observed" },
        },
      ],
      mutationFence: fence,
      observationId: "obs_recovery_usage_001",
      observationSequence: 1,
      observedAt,
      schemaVersion: "0.1",
      scope,
      sourceEventSha256: "a".repeat(64),
    };
    await client.query(
      `INSERT INTO public.proofstack_replay_observations (
        tenant_id, project_id, environment_id, job_id, observation_id,
        observation_sequence, schema_version, observation_kind, payload_kind,
        boundary_id, source_event_sha256, attempt_id, lease_id, worker_id,
        fencing_token, recovery_epoch, observed_at, observed_at_lexical, observation
      ) VALUES (
        $1, $2, $3, $4, $5, 1, '0.1', 'usage', NULL, $6, $7,
        $8, $9, $10, $11, $12, $13::timestamptz, $14, $15::jsonb
      )`,
      [
        scope.tenantId,
        scope.projectId,
        scope.environmentId,
        jobId,
        usageObservation.observationId,
        boundary.boundaryId,
        usageObservation.sourceEventSha256,
        fence.attemptId,
        fence.leaseId,
        fence.workerId,
        fence.fencingToken,
        fence.recoveryEpoch,
        observedAt,
        observedAt,
        JSON.stringify(usageObservation),
      ],
    );
    await client.query(
      `INSERT INTO public.proofstack_replay_usage_measurements (
        tenant_id, observation_id, observation_kind, dimension,
        usage_status, amount, source, unavailable_reason
      ) VALUES ($1, $2, 'usage', 'inputTokens', 'observed', 12, 'provider_reported', NULL)`,
      [scope.tenantId, usageObservation.observationId],
    );
    await client.query(
      `SELECT * FROM public.proofstack_request_replay_cancellation(
        $1, $2, $3, $4, 'operator_request', $5, $6
      )`,
      [
        scope.projectId,
        scope.environmentId,
        jobId,
        "can_recovery_001",
        "Stop the representative replay after its recoverable evidence is durable.",
        "usr_recovery",
      ],
    );
    await client.query(
      `SELECT * FROM public.proofstack_acknowledge_replay_cancellation(
        $1, $2, $3, $4, $5, $6, $7, $8, $9, 'stopped_before_target_start'
      )`,
      [
        scope.projectId,
        scope.environmentId,
        jobId,
        fence.attemptId,
        fence.leaseId,
        fence.workerId,
        fence.fencingToken,
        fence.recoveryEpoch,
        "ack_recovery_001",
      ],
    );
    await client.query(
      `SELECT * FROM public.proofstack_complete_replay_job(
        $1, $2, $3, $4, $5, $6, $7, $8,
        'cancelled', 'cancellation_committed', $9::jsonb, NULL
      )`,
      [
        scope.projectId,
        scope.environmentId,
        jobId,
        fence.attemptId,
        fence.leaseId,
        fence.workerId,
        fence.fencingToken,
        fence.recoveryEpoch,
        JSON.stringify({
          code: "cancelled",
          effectCertainty: "none",
          message: "Recovery rehearsal stopped the bounded replay.",
        }),
      ],
    );

    const runningJobId = "job_recovery_active";
    const queuedJobId = "job_recovery_queued";
    await client.query(
      "SELECT * FROM public.proofstack_create_replay_job($1, $2, $3, $4, $5, $6, $7)",
      [
        scope.projectId,
        scope.environmentId,
        runningJobId,
        replayPlan.planId,
        replayPlan.planVersionId,
        replayPlan.definitionSha256,
        "usr_recovery",
      ],
    );
    const activeClaim = await client.query<{
      readonly job: unknown;
      readonly worker_fence: unknown;
    }>(
      `SELECT * FROM public.proofstack_claim_replay_job(
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
      )`,
      [
        scope.projectId,
        scope.environmentId,
        runningJobId,
        "att_recovery_active_source",
        "lease_recovery_active_source",
        "worker_recovery_source",
        workerProtocol.name,
        workerProtocol.version,
        "d".repeat(64),
        600_000,
      ],
    );
    await client.query(
      "SELECT * FROM public.proofstack_create_replay_job($1, $2, $3, $4, $5, $6, $7)",
      [
        scope.projectId,
        scope.environmentId,
        queuedJobId,
        replayPlan.planId,
        replayPlan.planVersionId,
        replayPlan.definitionSha256,
        "usr_recovery",
      ],
    );
    replayRecoveryState = {
      queuedJobId,
      runningJobId,
      sourceFence: ReplayWorkerMutationFenceSchema.parse(activeClaim.rows[0]?.worker_fence),
      sourceJob: ReplayJobSchema.parse(activeClaim.rows[0]?.job),
    };
  });
}

async function seedRecoverableEvaluationGraph(): Promise<void> {
  const harness = createEvaluationRepositoryTestHarness("recovery");
  const repository = new PostgresEvaluationRepository(sourcePool);
  for (const fixture of harness.records) await publishEvaluationFixture(repository, fixture);
}

async function seedAuthoritativeState(): Promise<void> {
  await migrateDatabase(sourcePool);

  const artifactRepository = new PostgresArtifactCatalogRepository(sourcePool);
  const interactionCaptures = await seedRecoverableArtifacts(artifactRepository);

  await seedRecoverableRegressionCatalog();
  await seedRecoverableRecordedFixtures(interactionCaptures);
  await seedRecoverableReplayState();
  await seedRecoverableEvaluationGraph();
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

interface AuthoritativeSnapshot {
  readonly sequences: readonly SequenceSnapshotRow[];
  readonly tables: Readonly<Record<string, readonly unknown[]>>;
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

function requiredRecordedRecoveryState(): NonNullable<typeof recordedRecoveryState> {
  if (!recordedRecoveryState) throw new Error("Recorded recovery fixtures were not seeded");
  return recordedRecoveryState;
}

function requiredReplayRecoveryState(): NonNullable<typeof replayRecoveryState> {
  if (!replayRecoveryState) throw new Error("Replay recovery authority was not seeded");
  return replayRecoveryState;
}

function intentOrderKey(intent: RegressionVersionPublishedOutboxIntent): Buffer {
  return Buffer.from(`${intent.eventType}\0${intent.aggregateType}\0${intent.aggregateId}`, "utf8");
}

function expectedRegressionPublicationIntents(): readonly RegressionVersionPublishedOutboxIntent[] {
  const state = requiredRegressionCatalogState();
  const recorded = requiredRecordedRecoveryState();
  return [
    buildRegressionFixtureVersionPublishedOutboxIntent(state.fixtureRoot),
    buildRegressionFixtureVersionPublishedOutboxIntent(state.secondFixtureRoot),
    buildRegressionFixtureVersionPublishedOutboxIntent(state.fixtureChild),
    buildRegressionDatasetVersionPublishedOutboxIntent(state.datasetRoot),
    buildRegressionDatasetVersionPublishedOutboxIntent(state.datasetChild),
    buildRecordedInteractionFixtureVersionPublishedOutboxIntent(recorded.availableVersion),
    buildRecordedInteractionFixtureVersionPublishedOutboxIntent(recorded.revokedVersion),
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

async function authoritativeSnapshot(pool: Pool): Promise<AuthoritativeSnapshot> {
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
    if (tableName !== "proofstack_replay_recovery_events") {
      expect(
        rows.length,
        `${tableName} must contain representative recovery state`,
      ).toBeGreaterThan(0);
    }
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

function snapshotWithoutRecoveryTransitions(
  snapshot: AuthoritativeSnapshot,
): AuthoritativeSnapshot {
  const recovery = requiredReplayRecoveryState();
  const transitionalJobIds = new Set([recovery.queuedJobId, recovery.runningJobId]);
  const tables: Record<string, readonly unknown[]> & {
    proofstack_recovery_state?: readonly unknown[];
    proofstack_replay_jobs?: readonly unknown[];
    proofstack_replay_recovery_events?: readonly unknown[];
  } = { ...snapshot.tables };
  delete tables.proofstack_recovery_state;
  delete tables.proofstack_replay_recovery_events;
  tables.proofstack_replay_jobs = (tables.proofstack_replay_jobs ?? []).filter((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row) || !("job_id" in row)) {
      return true;
    }
    return !transitionalJobIds.has(String(row.job_id));
  });
  return { sequences: snapshot.sequences, tables };
}

function runtimeRoleOptions(): RuntimeRoleProvisioningOptions {
  const role = (purpose: string) => `proofstack_rr_${purpose}_${runKey}`;
  const options = {
    api: { name: role("api"), password: `recovery-api-${runKey}` },
    artifact: { name: role("artifact"), password: `recovery-artifact-${runKey}` },
    consumer: { name: role("consumer"), password: `recovery-consumer-${runKey}` },
    evaluationWorker: {
      name: role("evaluation"),
      password: `recovery-evaluation-${runKey}`,
    },
    identity: { name: role("identity"), password: `recovery-identity-${runKey}` },
    publisher: { name: role("publisher"), password: `recovery-publisher-${runKey}` },
    replayWorker: { name: role("worker"), password: `recovery-replay-worker-${runKey}` },
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
    const availableObjectRows = await sourcePool.query<{ readonly object_key: string }>(`
      SELECT object_key
      FROM public.proofstack_artifact_catalog
      WHERE tenant_id = 'ten_recovery' AND state = 'available'
      ORDER BY object_key COLLATE "C"
    `);
    const sourceCiphertexts = new Map<string, Uint8Array>();
    const inventory = [];
    for (const { object_key: objectKey } of availableObjectRows.rows) {
      const ciphertext = await sourceObjects.get(objectKey);
      if (!ciphertext) throw new Error(`Available recovery ciphertext ${objectKey} is missing`);
      sourceCiphertexts.set(objectKey, ciphertext);
      inventory.push({
        ciphertextSha256: sha256(ciphertext),
        objectKey,
        sizeBytes: ciphertext.byteLength,
      });
    }
    expect(inventory.length).toBeGreaterThan(1);
    const encodedInventory = encodeRecoveryObjectInventory(inventory);
    for (const entry of inventory) {
      const ciphertext = sourceCiphertexts.get(entry.objectKey);
      if (!ciphertext) throw new Error(`Inventory ciphertext ${entry.objectKey} is missing`);
      await expect(backupObjects.putIfAbsent(entry.objectKey, ciphertext)).resolves.toMatchObject({
        created: true,
        receipt: {
          sha256: entry.ciphertextSha256,
          sizeBytes: entry.sizeBytes,
        },
      });
    }
    await expect(sourceObjects.get(sourcePurged.objectKey)).resolves.toBeNull();
    await expect(backupObjects.get(sourcePurged.objectKey)).resolves.toBeNull();

    const keySnapshot = {
      [artifactKeyId]: Uint8Array.from(artifactKeyMaterial),
      [rotatedArtifactKeyId]: Uint8Array.from(rotatedArtifactKeyMaterial),
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
        referencedKeyIds: [artifactKeyId, rotatedArtifactKeyId].sort(),
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
    const restoredSnapshot = await authoritativeSnapshot(restoredPool);
    expect(snapshotWithoutRecoveryTransitions(restoredSnapshot)).toEqual(
      snapshotWithoutRecoveryTransitions(sourceSnapshot),
    );
    const replayRecovery = requiredReplayRecoveryState();
    const restoredRecoveryEpoch = await restoredPool.query<{
      readonly advanced_at_lexical: string;
      readonly recovery_epoch: string;
    }>(`
      SELECT recovery_epoch::text, advanced_at_lexical
      FROM public.proofstack_recovery_state
      WHERE singleton = true
    `);
    expect(restoredRecoveryEpoch.rows).toEqual([
      {
        advanced_at_lexical: expect.stringMatching(/Z$/u),
        recovery_epoch: String(replayRecovery.sourceFence.recoveryEpoch + 1),
      },
    ]);
    const restoredRecoveryEvents = await restoredPool.query<{
      readonly event: unknown;
      readonly invalidated_at_lexical: string;
      readonly job_id: string;
      readonly previous_lease: unknown;
      readonly previous_recovery_epoch: string;
      readonly previous_state_version: string;
      readonly previous_status: string;
      readonly recovery_epoch: string;
    }>(
      `SELECT job_id, recovery_epoch::text, previous_recovery_epoch::text,
         previous_state_version::text, previous_status, previous_lease,
         invalidated_at_lexical, event
       FROM public.proofstack_replay_recovery_events
       WHERE tenant_id = $1 AND job_id = ANY($2::text[])
       ORDER BY job_id COLLATE "C"`,
      [scope.tenantId, [replayRecovery.runningJobId, replayRecovery.queuedJobId]],
    );
    expect(restoredRecoveryEvents.rows).toHaveLength(2);
    const runningRecoveryEvent = restoredRecoveryEvents.rows.find(
      ({ job_id: jobId }) => jobId === replayRecovery.runningJobId,
    );
    const queuedRecoveryEvent = restoredRecoveryEvents.rows.find(
      ({ job_id: jobId }) => jobId === replayRecovery.queuedJobId,
    );
    expect(runningRecoveryEvent).toMatchObject({
      job_id: replayRecovery.runningJobId,
      previous_lease: replayRecovery.sourceJob.currentLease,
      previous_recovery_epoch: String(replayRecovery.sourceFence.recoveryEpoch),
      previous_state_version: String(replayRecovery.sourceJob.stateVersion),
      previous_status: "running",
      recovery_epoch: String(replayRecovery.sourceFence.recoveryEpoch + 1),
    });
    expect(queuedRecoveryEvent).toMatchObject({
      job_id: replayRecovery.queuedJobId,
      previous_lease: null,
      previous_recovery_epoch: String(replayRecovery.sourceFence.recoveryEpoch),
      previous_state_version: "1",
      previous_status: "queued",
      recovery_epoch: String(replayRecovery.sourceFence.recoveryEpoch + 1),
    });
    const sourceLease = replayRecovery.sourceJob.currentLease;
    if (!sourceLease || !runningRecoveryEvent) {
      throw new Error("Restored replay recovery event is incomplete");
    }
    expect(Date.parse(sourceLease.expiresAt)).toBeGreaterThan(
      Date.parse(runningRecoveryEvent.invalidated_at_lexical),
    );
    expect(runningRecoveryEvent.event).toMatchObject({
      invalidatedAt: runningRecoveryEvent.invalidated_at_lexical,
      jobId: replayRecovery.runningJobId,
      previousLease: sourceLease,
      previousRecoveryEpoch: replayRecovery.sourceFence.recoveryEpoch,
      previousStateVersion: replayRecovery.sourceJob.stateVersion,
      previousStatus: "running",
      recoveryEpoch: replayRecovery.sourceFence.recoveryEpoch + 1,
      scope,
    });
    const restoredRecoveryJobs = await restoredPool.query<{ readonly job: unknown }>(
      `SELECT job
       FROM public.proofstack_replay_jobs
       WHERE tenant_id = $1 AND job_id = ANY($2::text[])
       ORDER BY job_id COLLATE "C"`,
      [scope.tenantId, [replayRecovery.runningJobId, replayRecovery.queuedJobId]],
    );
    const restoredRunningJob = ReplayJobSchema.parse(restoredRecoveryJobs.rows[0]?.job);
    const restoredQueuedJob = ReplayJobSchema.parse(restoredRecoveryJobs.rows[1]?.job);
    expect(restoredRunningJob).toMatchObject({
      jobId: replayRecovery.runningJobId,
      recoveryEpoch: replayRecovery.sourceFence.recoveryEpoch,
      stateVersion: replayRecovery.sourceJob.stateVersion + 1,
      status: "running",
    });
    expect(restoredRunningJob.currentLease?.expiresAt).toBe(
      runningRecoveryEvent.invalidated_at_lexical,
    );
    expect(restoredQueuedJob).toMatchObject({
      jobId: replayRecovery.queuedJobId,
      recoveryEpoch: replayRecovery.sourceFence.recoveryEpoch + 1,
      stateVersion: 2,
      status: "queued",
    });
    await expect(
      withRecoveryTenantTransactionOn(restoredPool, (client) =>
        client.query(
          `SELECT public.proofstack_heartbeat_replay_job(
            $1, $2, $3, $4, $5, $6, $7, $8, $9
          )`,
          [
            scope.projectId,
            scope.environmentId,
            replayRecovery.sourceFence.jobId,
            replayRecovery.sourceFence.attemptId,
            replayRecovery.sourceFence.leaseId,
            replayRecovery.sourceFence.workerId,
            replayRecovery.sourceFence.fencingToken,
            replayRecovery.sourceFence.recoveryEpoch,
            1_000,
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "55000" });
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
      keyCount: 2,
      migrationCount: sourceLedger.length,
      objectCount: inventory.length,
      recoverySetId: "rec_foundation_two_rehearsal",
      totalCiphertextBytes: encodedInventory.summary.totalCiphertextBytes,
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
    const replayWorkerUrl = new URL(restoredDatabaseUrl);
    replayWorkerUrl.username = roles.replayWorker.name;
    replayWorkerUrl.password = roles.replayWorker.password;
    const replayWorkerPool = new Pool({ connectionString: replayWorkerUrl.toString(), max: 2 });
    runtimePools.push(replayWorkerPool);
    const reclaimedReplay = await withRecoveryTenantTransactionOn(replayWorkerPool, (client) =>
      client.query<{
        readonly attempt: unknown;
        readonly claimed: boolean;
        readonly job: unknown;
        readonly reason: string | null;
        readonly worker_fence: unknown;
      }>(
        `SELECT * FROM public.proofstack_claim_replay_job(
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
          )`,
        [
          scope.projectId,
          scope.environmentId,
          replayRecovery.runningJobId,
          "att_recovery_active_restored",
          "lease_recovery_active_restored",
          "worker_recovery_restored",
          "proofstack.replay-worker",
          "1.0.0",
          "e".repeat(64),
          1_000,
        ],
      ),
    );
    expect(reclaimedReplay.rows[0]).toMatchObject({ claimed: true, reason: null });
    const reclaimedReplayJob = ReplayJobSchema.parse(reclaimedReplay.rows[0]?.job);
    const reclaimedReplayFence = ReplayWorkerMutationFenceSchema.parse(
      reclaimedReplay.rows[0]?.worker_fence,
    );
    expect(reclaimedReplayJob).toMatchObject({
      jobId: replayRecovery.runningJobId,
      lastFencingToken: replayRecovery.sourceFence.fencingToken + 1,
      recoveryEpoch: replayRecovery.sourceFence.recoveryEpoch + 1,
      stateVersion: replayRecovery.sourceJob.stateVersion + 2,
      status: "running",
    });
    expect(reclaimedReplayFence).toMatchObject({
      fencingToken: replayRecovery.sourceFence.fencingToken + 1,
      recoveryEpoch: replayRecovery.sourceFence.recoveryEpoch + 1,
    });
    await expect(
      withRecoveryTenantTransactionOn(replayWorkerPool, (client) =>
        client.query(
          `SELECT public.proofstack_heartbeat_replay_job(
            $1, $2, $3, $4, $5, $6, $7, $8, $9
          )`,
          [
            scope.projectId,
            scope.environmentId,
            replayRecovery.sourceFence.jobId,
            replayRecovery.sourceFence.attemptId,
            replayRecovery.sourceFence.leaseId,
            replayRecovery.sourceFence.workerId,
            replayRecovery.sourceFence.fencingToken,
            replayRecovery.sourceFence.recoveryEpoch,
            1_000,
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    const expiredSourceAttempt = await restoredPool.query<{
      readonly attempt: unknown;
      readonly event_types: string[];
    }>(
      `SELECT attempt.attempt,
         array_agg(event.event_type ORDER BY event.transition_sequence) AS event_types
       FROM public.proofstack_replay_attempts AS attempt
       JOIN public.proofstack_replay_attempt_events AS event
         ON event.tenant_id = attempt.tenant_id AND event.attempt_id = attempt.attempt_id
       WHERE attempt.tenant_id = $1 AND attempt.attempt_id = $2
       GROUP BY attempt.attempt`,
      [scope.tenantId, replayRecovery.sourceFence.attemptId],
    );
    expect(expiredSourceAttempt.rows).toEqual([
      {
        attempt: expect.objectContaining({
          error: expect.objectContaining({ code: "lease_expired" }),
          retryDisposition: "retry_scheduled",
          status: "lease_expired",
        }),
        event_types: ["attempt_claimed", "attempt_closed"],
      },
    ]);
    const runtimeUrl = new URL(restoredDatabaseUrl);
    runtimeUrl.username = roles.api.name;
    runtimeUrl.password = roles.api.password;
    const runtimePool = new Pool({ connectionString: runtimeUrl.toString(), max: 2 });
    runtimePools.push(runtimePool);
    const restoredArtifactWriterCatalog = new PostgresArtifactCatalogRepository(runtimePool);
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
    const expectedRecorded = requiredRecordedRecoveryState();
    const restoredAvailableCapture = await restoredRegression.findRecordedInteractionFixtureContent(
      scope,
      expectedRecorded.availableVersion.fixtureVersionId,
    );
    expect(restoredAvailableCapture).toMatchObject({
      contentAvailability: "available",
      revocation: null,
      version: expectedRecorded.availableVersion,
    });
    expect(
      new Set(
        expectedRecorded.availableVersion.interactionCapture.artifacts.map(
          ({ contentReference }) => contentReference.classification,
        ),
      ),
    ).toEqual(new Set(["internal", "confidential", "restricted"]));
    for (const binding of expectedRecorded.availableVersion.interactionCapture.artifacts) {
      const restored = await restoredArtifactReader.execute({
        artifactId: binding.contentReference.artifactId,
        environmentId: scope.environmentId,
        principal: artifactPrincipal(),
        projectId: scope.projectId,
      });
      expect(Buffer.from(restored.content)).toEqual(
        expectedRecorded.availableContent.get(binding.contentReference.artifactId),
      );
    }

    const restoredRevokedCapture = await restoredRegression.findRecordedInteractionFixtureContent(
      scope,
      expectedRecorded.revokedVersion.fixtureVersionId,
    );
    expect(restoredRevokedCapture).toMatchObject({
      contentAvailability: "revoked",
      tombstones: {
        length: expectedRecorded.revokedVersion.interactionCapture.artifacts.length,
      },
      version: expectedRecorded.revokedVersion,
    });
    const restoredRevokedStates: string[] = [];
    const restoredPurger = new PurgeArtifact({
      catalog: restoredArtifactCatalog,
      clock: { now: () => new Date("2026-08-28T03:13:00.000Z") },
      identities: new SecureArtifactIdentityGenerator(),
      objects: restoredObjects,
    });
    for (const binding of expectedRecorded.revokedVersion.interactionCapture.artifacts) {
      const entry = await restoredArtifactCatalog.find(scope, binding.contentReference.artifactId);
      if (!entry) throw new Error("Restored revoked artifact catalog entry is missing");
      restoredRevokedStates.push(entry.metadata.state);
      await expect(
        restoredArtifactReader.execute({
          artifactId: binding.contentReference.artifactId,
          environmentId: scope.environmentId,
          principal: artifactPrincipal(),
          projectId: scope.projectId,
        }),
      ).rejects.toBeInstanceOf(ArtifactUnavailableError);
      if (entry.metadata.state === "tombstoned") {
        await restoredPurger.execute({
          artifactId: binding.contentReference.artifactId,
          environmentId: scope.environmentId,
          principal: artifactPrincipal(),
          projectId: scope.projectId,
        });
      }
      await expect(
        restoredArtifactCatalog.findPurgeReceipt(scope, binding.contentReference.artifactId),
      ).resolves.toMatchObject({ artifactId: binding.contentReference.artifactId });
    }
    expect(new Set(restoredRevokedStates)).toEqual(new Set(["purged", "tombstoned"]));
    await expect(
      restoredRegression.findRecordedInteractionFixtureContent(
        scope,
        expectedRecorded.revokedVersion.fixtureVersionId,
      ),
    ).resolves.toMatchObject({ contentAvailability: "revoked" });

    const readerMissingRotatedKey = new ReadArtifact({
      catalog: restoredArtifactCatalog,
      encryption: new ArtifactCipher(
        new LocalArtifactKeyring({
          activeKeyId: artifactKeyId,
          keys: { [artifactKeyId]: artifactKeyMaterial },
        }),
      ),
      objects: restoredObjects,
    });
    const rotatedKeyBinding = expectedRecorded.availableVersion.interactionCapture.artifacts[1];
    if (!rotatedKeyBinding) throw new Error("Available recovery fixture has no rotated-key entry");
    await expect(
      readerMissingRotatedKey.execute({
        artifactId: rotatedKeyBinding.contentReference.artifactId,
        environmentId: scope.environmentId,
        principal: artifactPrincipal(),
        projectId: scope.projectId,
      }),
    ).rejects.toBeInstanceOf(ArtifactProtectionError);

    const missingObjectBinding = expectedRecorded.availableVersion.interactionCapture.artifacts[0];
    if (!missingObjectBinding) throw new Error("Available recovery fixture is empty");
    const missingObjectEntry = await restoredArtifactCatalog.find(
      scope,
      missingObjectBinding.contentReference.artifactId,
    );
    if (!missingObjectEntry) throw new Error("Available recovery artifact entry is missing");
    await restoredObjects.delete(missingObjectEntry.objectKey);
    await expect(
      restoredArtifactReader.execute({
        artifactId: missingObjectBinding.contentReference.artifactId,
        environmentId: scope.environmentId,
        principal: artifactPrincipal(),
        projectId: scope.projectId,
      }),
    ).rejects.toBeInstanceOf(ArtifactObjectMissingError);

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

    const restoredArtifactCipher = new ArtifactCipher(
      new LocalArtifactKeyring({
        activeKeyId: artifactKeyId,
        keys: keySnapshot,
      }),
    );
    const restoredArtifactReserve = new ReserveArtifact({
      catalog: restoredArtifactWriterCatalog,
      clock: { now: () => new Date("2026-08-28T03:10:00.000Z") },
      encryption: restoredArtifactCipher,
      identities: new SecureArtifactIdentityGenerator(),
    });
    const restoredArtifactUpload = new UploadArtifact({
      catalog: restoredArtifactWriterCatalog,
      clock: { now: () => new Date("2026-08-28T03:10:01.000Z") },
      encryption: restoredArtifactCipher,
      inspection: new StrictArtifactContentInspector(),
      objects: restoredObjects,
    });
    for (const binding of expectedRecorded.afterRestoreManifest.artifacts) {
      const content = expectedRecorded.afterRestoreContent.get(binding.contentReference.artifactId);
      if (!content) throw new Error("Post-restore capture content is missing");
      await expect(
        restoredArtifactReserve.execute({
          environmentId: scope.environmentId,
          principal: artifactPrincipal(),
          projectId: scope.projectId,
          request: {
            artifactId: binding.contentReference.artifactId,
            classification: binding.contentReference.classification,
            mediaType: binding.contentReference.mediaType,
            redaction: binding.redaction,
            retention: binding.retention,
            sha256: binding.contentReference.sha256,
            sizeBytes: binding.contentReference.sizeBytes,
          },
        }),
      ).resolves.toMatchObject({ created: true });
      const entry = await restoredArtifactWriterCatalog.find(
        scope,
        binding.contentReference.artifactId,
      );
      if (!entry) throw new Error("Post-restore artifact reservation is missing");
      trackedObjectKeys.add(entry.objectKey);
      await restoredArtifactUpload.execute({
        artifactId: binding.contentReference.artifactId,
        content,
        environmentId: scope.environmentId,
        principal: artifactPrincipal(),
        projectId: scope.projectId,
      });
      const restoredContent = await restoredArtifactReader.execute({
        artifactId: binding.contentReference.artifactId,
        environmentId: scope.environmentId,
        principal: artifactPrincipal(),
        projectId: scope.projectId,
      });
      expect(Buffer.from(restoredContent.content)).toEqual(Buffer.from(content));
      expect(restoredContent.metadata.state).toBe("available");
    }
    const postRestoreCollisionBinding = expectedRecorded.afterRestoreManifest.artifacts[0];
    if (!postRestoreCollisionBinding) throw new Error("Post-restore capture is empty");
    await expect(
      restoredArtifactReserve.execute({
        environmentId: scope.environmentId,
        principal: artifactPrincipal(),
        projectId: scope.projectId,
        request: {
          artifactId: postRestoreCollisionBinding.contentReference.artifactId,
          classification: postRestoreCollisionBinding.contentReference.classification,
          mediaType: postRestoreCollisionBinding.contentReference.mediaType,
          redaction: postRestoreCollisionBinding.redaction,
          retention: postRestoreCollisionBinding.retention,
          sha256: "f".repeat(64),
          sizeBytes: postRestoreCollisionBinding.contentReference.sizeBytes,
        },
      }),
    ).rejects.toBeInstanceOf(ArtifactConflictError);

    const restoredRecordedAfterWrite = await new PublishRecordedInteractionFixtureVersion({
      clock: regressionClock("2026-08-28T03:11:00.000Z"),
      versionRepository: restoredRegression,
    }).execute({
      environmentId: scope.environmentId,
      fixtureId: restoredFixtureAfterWrite.version.fixtureId,
      principal: regressionPrincipal(),
      projectId: scope.projectId,
      request: {
        fixtureVersionId: "fixv_recovery_primary_recorded_after_restore",
        interactionCapture: expectedRecorded.afterRestoreManifest,
        name: "Recovery recorded fixture after restore",
        predecessorVersionId: restoredFixtureAfterWrite.version.fixtureVersionId,
      },
    });
    await expect(
      restoredRegression.findRecordedInteractionFixtureContent(
        scope,
        restoredRecordedAfterWrite.version.fixtureVersionId,
      ),
    ).resolves.toMatchObject({
      contentAvailability: "available",
      version: restoredRecordedAfterWrite.version,
    });

    const restoredDatasetAfterWrite = await new PublishRegressionDatasetVersion({
      clock: regressionClock("2026-08-28T03:12:00.000Z"),
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
      buildRecordedInteractionFixtureVersionPublishedOutboxIntent(
        restoredRecordedAfterWrite.version,
      ),
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
    await expect(
      sourceRegression.findRecordedInteractionFixtureVersion(
        scope,
        restoredRecordedAfterWrite.version.fixtureVersionId,
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
