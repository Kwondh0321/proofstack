import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ArtifactCipher, LocalArtifactKeyring } from "@proofstack/artifacts";
import { MemoryArtifactObjectStore } from "@proofstack/artifacts/testing";
import {
  type ArtifactMetadata,
  type ContentReference,
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationRequestDefinition,
  PrincipalContextSchema,
  type RegressionDatasetVersionDefinition,
  type RegressionFixtureVersionDefinition,
} from "@proofstack/contracts";
import {
  digestEvaluationRecordDefinition,
  digestPolicyEvaluationRequestDefinition,
  digestReleaseCandidateDefinition,
  evaluationRecordDescriptors,
  releaseCandidateReference,
  releasePolicyReference,
} from "@proofstack/core";
import {
  createEvaluationRepositoryTestHarness,
  criterionStatusHistoryFixture,
  MemoryEvidenceRepository,
  MemoryReleaseCandidateRepository,
  publishEvaluationFixture,
  releaseCandidateFixture,
  releasePolicyFixtureScope,
  releasePolicyLifecycleFixture,
  releasePolicyRepositoryFixture,
} from "@proofstack/core/testing";
import {
  digestRegressionDatasetVersionDefinition,
  digestRegressionFixtureVersionDefinition,
} from "@proofstack/datasets";
import {
  capturePolicyArtifactEvidence,
  type PolicyArtifactEvidenceRepositories,
  type PolicyEvaluationMetadataTransactions,
  type PolicyEvaluationSourceRecheckPorts,
  type PolicyEvaluationSourceTransactions,
} from "@proofstack/policy-evaluation";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migration-runner.js";
import { PostgresArtifactCatalogRepository } from "./postgres-artifact-catalog-repository.js";
import { PostgresComparisonRepository } from "./postgres-comparison-repository.js";
import { PostgresEvaluationRepository } from "./postgres-evaluation-repository.js";
import { PostgresEvidenceRepository } from "./postgres-evidence-repository.js";
import { PostgresModelAssuranceRepository } from "./postgres-model-assurance-repository.js";
import { PostgresPolicySourceTransactions } from "./postgres-policy-source-transactions.js";
import { PostgresRegressionVersionRepository } from "./postgres-regression-version-repository.js";
import { PostgresReleaseCandidateRepository } from "./postgres-release-candidate-repository.js";
import { PostgresReleasePolicyRepository } from "./postgres-release-policy-repository.js";
import { PostgresReplayDefinitionRepository } from "./postgres-replay-definition-repository.js";
import { PostgresReplayJobControlRepository } from "./postgres-replay-job-control-repository.js";
import { provisionRuntimeRoles, type RuntimeRoleProvisioningOptions } from "./runtime-roles.js";
import { withExactScopeTransaction } from "./tenant-transaction.js";

const databaseUrl = process.env["PROOFSTACK_TEST_DATABASE_URL"];
if (!databaseUrl) throw new Error("PROOFSTACK_TEST_DATABASE_URL is required");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const credentials = Object.fromEntries(
  [
    "api",
    "artifact",
    "consumer",
    "evaluationWorker",
    "humanReviewer",
    "identity",
    "modelEvaluationWorker",
    "policyAuthor",
    "publisher",
    "replayWorker",
  ].map((kind) => [
    kind,
    {
      name: `ps_recheck_${kind.toLowerCase()}_${runKey}`,
      password: `source-recheck-${kind}-${runKey}`,
    },
  ]),
) as unknown as RuntimeRoleProvisioningOptions;
const admin = new Pool({ connectionString: databaseUrl, max: 8 });
function runtime(kind: keyof RuntimeRoleProvisioningOptions) {
  const url = new URL(databaseUrl as string);
  url.username = credentials[kind].name;
  url.password = credentials[kind].password;
  return new Pool({ connectionString: url.toString(), max: 4 });
}
const api = runtime("api");
const maintainer = runtime("artifact");
const author = runtime("policyAuthor");
const catalog = new PostgresArtifactCatalogRepository(api);
const maintenance = new PostgresArtifactCatalogRepository(maintainer);
const policies = new PostgresReleasePolicyRepository(author);
const observedPools: Pool[] = [];
beforeAll(async () => {
  await migrateDatabase(admin);
  await provisionRuntimeRoles(admin, credentials);
});
afterAll(async () => {
  await Promise.all([
    api.end(),
    maintainer.end(),
    author.end(),
    ...observedPools.map((pool) => pool.end()),
  ]);
  for (const { name } of Object.values(credentials)) {
    await admin.query(`DROP OWNED BY "${name}"`);
    await admin.query(`DROP ROLE "${name}"`);
  }
  await admin.end();
});

async function fixture(withCriteria = false, metadataMode = false) {
  const namespace = `recheck_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const evaluation = withCriteria ? createEvaluationRepositoryTestHarness(namespace) : undefined;
  const evaluationRepository = new PostgresEvaluationRepository(api);
  if (evaluation) {
    const hashes = new Map<string, string>();
    const normalize = (input: unknown): void => {
      if (!input || typeof input !== "object") return;
      const value = input as Record<string, unknown> & {
        artifactId?: unknown;
        sha256?: unknown;
        datasetVersionId?: unknown;
        fixtureVersionId?: unknown;
        definitionSha256?: unknown;
      };
      if (typeof value.artifactId === "string" && typeof value.sha256 === "string") {
        // Synthetic upstream descriptors remain unavailable. Distinct sample content must not
        // reuse an artifact ID; this is not an additional retained-byte acceptance fixture.
        const bytes = encodeEvaluationCanonicalJson(value);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        Object.assign(value, {
          artifactId: `criterion_${sha256.slice(0, 24)}`,
          sha256,
          sizeBytes: bytes.byteLength,
        });
        return;
      }
      if (value.datasetVersionId === "dtv_regression_v1") value.definitionSha256 = "7".repeat(64);
      if (value.fixtureVersionId === "fxv_boundary") value.definitionSha256 = "2".repeat(64);
      if (typeof value.definitionSha256 === "string" && hashes.has(value.definitionSha256))
        value.definitionSha256 = hashes.get(value.definitionSha256);
      for (const child of Object.values(value)) normalize(child);
    };
    for (const record of evaluation.records) {
      const original = record.record.definitionSha256;
      normalize(record.record);
      const definition = structuredClone(record.record) as unknown as Record<string, unknown>;
      for (const key of evaluationRecordDescriptors[record.kind].receiptKeys)
        delete definition[key];
      record.record.definitionSha256 = digestEvaluationRecordDefinition(
        record.kind,
        evaluation.scope,
        definition,
      );
      hashes.set(original, record.record.definitionSha256);
      // Disposable admin fixtures seed control and execution records without widening API grants.
      await publishEvaluationFixture(new PostgresEvaluationRepository(admin), record);
    }
  }
  const scope = evaluation?.scope ?? releasePolicyFixtureScope(namespace);
  const applicationName = `proofstack_${namespace}`;
  const observer = new Pool({
    connectionString: databaseUrl,
    max: 1,
    application_name: applicationName,
  });
  observedPools.push(observer);
  // Prove that the adapter overrides the pool's isolation default without changing that default.
  await observer.query("SET default_transaction_isolation = 'repeatable read'");
  const transactions = new PostgresPolicySourceTransactions(observer);
  const contents = Buffer.from("actual guarded policy source bytes");
  const reference: ContentReference = {
    artifactId: "artifact_recheck",
    mediaType: "text/plain",
    classification: "confidential",
    sizeBytes: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
  const metadata: ArtifactMetadata = {
    schemaVersion: "0.1",
    scope,
    contentReference: reference,
    createdAt: "2026-09-04T00:00:00.000Z",
    state: "reserved",
    retention: { mode: "retain" },
    redaction: { status: "not_required" },
  };
  const encryption = new ArtifactCipher(
    new LocalArtifactKeyring({
      activeKeyId: "key_database_capture",
      keys: { key_database_capture: new Uint8Array(32).fill(5) },
    }),
  );
  const objects = new MemoryArtifactObjectStore();
  const objectKey = `objects/${scope.tenantId}/source`;
  const plan = await encryption.createPlan(metadata);
  await catalog.reserve({
    metadata,
    encryption: plan,
    objectKey,
    createdByPrincipalId: "principal_writer",
  });
  const encrypted = await encryption.encrypt(metadata, plan, contents);
  await objects.putIfAbsent(objectKey, encrypted.bytes);
  await catalog.activate(
    scope,
    reference.artifactId,
    encrypted.receipt,
    "2026-09-04T00:01:00.000001Z",
  );
  const policy = releasePolicyRepositoryFixture(namespace, scope);
  await policies.publishReleasePolicy(policy);
  const candidate = releaseCandidateFixture(namespace, scope);
  const versions = new PostgresRegressionVersionRepository(api);
  const fixtureDefinition: RegressionFixtureVersionDefinition = {
    schemaVersion: "0.1",
    scope,
    fixtureId: `fixture_${namespace}`,
    fixtureVersionId: `fxv_${namespace}`,
    name: "Missing dataset metadata member",
    replayability: "evidence_only",
    source: {
      kind: "trace_snapshot",
      traceId: "0123456789abcdef0123456789abcdef",
      eventIds: ["event_metadata_member"],
      observedEventCount: 1,
      sourceCompleteness: "observed_snapshot",
    },
  };
  const fixtureVersion = {
    ...fixtureDefinition,
    source: { ...fixtureDefinition.source, capturedAt: "2026-09-01T00:00:00.000Z" },
    definitionSha256: digestRegressionFixtureVersionDefinition(fixtureDefinition),
    createdAt: "2026-09-01T00:00:00.000Z",
    createdByPrincipalId: "principal_writer",
  };
  const datasetDefinition: RegressionDatasetVersionDefinition = {
    schemaVersion: "0.1",
    scope,
    name: "Initially missing exact dataset",
    datasetId: `dataset_${namespace}`,
    datasetVersionId: `dtv_${namespace}`,
    fixtureVersions: [
      {
        fixtureId: fixtureVersion.fixtureId,
        fixtureVersionId: fixtureVersion.fixtureVersionId,
        definitionSha256: fixtureVersion.definitionSha256,
      },
    ],
  };
  const futureDataset = {
    ...datasetDefinition,
    definitionSha256: digestRegressionDatasetVersionDefinition(datasetDefinition),
    createdAt: "2026-09-02T00:00:00.000Z",
    createdByPrincipalId: "principal_writer",
  };
  if (evaluation) {
    const assessment = evaluation.records.find(({ kind }) => kind === "assessment");
    const run = evaluation.records.find(({ kind }) => kind === "evaluation_run");
    if (assessment?.kind !== "assessment" || run?.kind !== "evaluation_run")
      throw new Error("Missing criterion graph fixture");
    candidate.assessments = [
      {
        assessmentId: assessment.record.assessmentId,
        definitionSha256: assessment.record.definitionSha256,
      },
    ];
    candidate.datasets = [run.record.dataset];
    candidate.targetRelease = run.record.replay.targetRelease;
    candidate.modelAssuranceAssessments = [];
  }
  if (metadataMode) {
    await versions.publishFixtureVersion(fixtureVersion);
    candidate.datasets = [
      {
        datasetId: futureDataset.datasetId,
        datasetVersionId: futureDataset.datasetVersionId,
        definitionSha256: futureDataset.definitionSha256,
      },
    ];
  }
  const build = candidate.buildArtifacts[0];
  if (!build) throw new Error("Expected build artifact fixture");
  build.artifact = reference;
  const {
    createdAt: _at,
    createdByPrincipalId: _by,
    schemaVersion: _version,
    scope: _scope,
    definitionSha256: _hash,
    ...body
  } = candidate;
  candidate.definitionSha256 = digestReleaseCandidateDefinition(scope, body);
  const candidates = metadataMode
    ? new PostgresReleaseCandidateRepository(api)
    : new MemoryReleaseCandidateRepository();
  await candidates.publishReleaseCandidate(candidate);
  // Legacy source-only scenarios retain their explicit memory candidate/upstream fixtures.
  // Metadata mode uses owning PostgreSQL reads and stored candidate/policy roots with missing
  // subordinate evidence; this observational test graph is not an eligible sealed snapshot.
  const absent = new Proxy({}, { get: () => async () => null });
  const repositories = {
    control: {
      comparison: metadataMode ? new PostgresComparisonRepository(api) : absent,
      installationBinding: absent,
      releaseCandidate: candidates,
      releasePolicy: policies,
    },
    evidence: {
      evaluation: evaluation || metadataMode ? evaluationRepository : absent,
      modelAssurance: metadataMode ? new PostgresModelAssuranceRepository(api) : absent,
    },
    datasets: metadataMode ? versions : absent,
    replayDefinitions: metadataMode ? new PostgresReplayDefinitionRepository(api) : absent,
    replayResults: metadataMode ? new PostgresReplayJobControlRepository(api) : absent,
    runtimeDefinitions: absent,
  } as unknown as PolicyArtifactEvidenceRepositories;
  const vector = JSON.parse(
    readFileSync(
      new URL(
        "../../contracts/vectors/policy-evaluation-request-definition-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { vectors: { input: { definition: PolicyEvaluationRequestDefinition } }[] };
  const base = vector.vectors[0]?.input.definition;
  if (!base) throw new Error("Expected immutable request vector");
  const definition = {
    ...base,
    evaluationRequestId: `request_${namespace}`,
    evaluationTime: "2026-10-01T00:00:00.000Z",
    candidate: releaseCandidateReference(candidate),
    policy: releasePolicyReference(policy),
  };
  const request = {
    ...definition,
    scope,
    schemaVersion: "0.1" as const,
    createdAt: "2026-10-01T01:00:00.000Z",
    createdByPrincipalId: "principal_request",
    definitionSha256: digestPolicyEvaluationRequestDefinition(scope, definition),
  };
  const actor = PrincipalContextSchema.parse({
    authentication: { method: "development", authenticatedAt: "2026-09-01T00:00:00.000Z" },
    capabilities: withCriteria ? ["artifact:read", "artifact:read:restricted"] : ["artifact:read"],
    principalId: "principal_capture",
    principalType: "service",
    requestId: "request_capture",
    resourceScope: { mode: "tenant" },
    roles: ["viewer"],
    tenantId: scope.tenantId,
  });
  const hooks: {
    beforeRun?: () => Promise<void>;
    underGuards?: (ports: PolicyEvaluationSourceRecheckPorts) => Promise<void>;
    readContent?: () => Promise<void>;
  } = {};
  const sourceTransactions: PolicyEvaluationSourceTransactions = {
    run: async (exact, operation) => {
      await hooks.beforeRun?.();
      return transactions.run(exact, (ports) =>
        operation({
          ...ports,
          observationTime: async () => {
            await hooks.underGuards?.(ports);
            return ports.observationTime();
          },
        }),
      );
    },
  };
  let objectReads = 0;
  const metadataTransactions: PolicyEvaluationMetadataTransactions = {
    runMetadata: async (exact, operation) => {
      await hooks.beforeRun?.();
      return transactions.runMetadata(exact, (ports) =>
        operation({
          ...ports,
          sources: {
            ...ports.sources,
            observationTime: async () => {
              await hooks.underGuards?.(ports.sources);
              return ports.sources.observationTime();
            },
          },
        }),
      );
    },
  };
  const run = () =>
    capturePolicyArtifactEvidence(
      request,
      actor,
      repositories,
      metadataMode ? new PostgresEvidenceRepository(api) : new MemoryEvidenceRepository(),
      {
        catalog,
        objects: {
          get: async (key) => {
            objectReads++;
            await hooks.readContent?.();
            return objects.get(key);
          },
        },
        encryption,
        clock: { now: () => new Date() },
        ...(metadataMode ? { metadataTransactions } : { sourceTransactions }),
      },
    );
  const tombstone = () =>
    maintenance.tombstone(scope, {
      artifactId: reference.artifactId,
      tombstoneId: `tombstone_${namespace}`,
      actorPrincipalId: "principal_maintenance",
      trigger: "manual",
      reason: "Exercise source recheck serialization",
      occurredAt: "2026-10-01T02:00:00.000Z",
    });
  const cleanContext = async () => {
    const result = await observer.query(
      "SELECT NULLIF(current_setting('proofstack.tenant_id', true), '') AS tenant, NULLIF(current_setting('proofstack.project_id', true), '') AS project, NULLIF(current_setting('proofstack.environment_id', true), '') AS environment, current_setting('transaction_isolation') AS isolation",
    );
    expect(result.rows).toEqual([
      { tenant: null, project: null, environment: null, isolation: "repeatable read" },
    ]);
  };
  const waitForWriter = () =>
    expect
      .poll(
        async () => {
          const result = await admin.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM pg_stat_activity AS writer JOIN pg_stat_activity AS observer ON observer.pid = ANY(pg_blocking_pids(writer.pid)) WHERE observer.application_name = $1 AND writer.wait_event = 'advisory'",
            [applicationName],
          );
          return result.rows[0]?.count;
        },
        { timeout: 5_000, interval: 20 },
      )
      .toBeGreaterThan(0);
  return {
    namespace,
    evaluation,
    evaluationRepository,
    scope,
    policy,
    reference,
    metadata,
    encryption,
    hooks,
    run,
    observer,
    transactions,
    versions,
    futureDataset,
    tombstone,
    cleanContext,
    waitForWriter,
    objectReads: () => objectReads,
  };
}

describe("request-owned source recheck on actual PostgreSQL", () => {
  it("rechecks real candidate/policy roots and explicit missing sources on one held metadata client", async () => {
    const f = await fixture(false, true);
    f.hooks.readContent = () =>
      withExactScopeTransaction(admin, f.scope, async (client) => {
        expect(
          (
            await client.query<{ acquired: boolean }>(
              "SELECT public.proofstack_try_lock_policy_evaluation_metadata() AS acquired",
            )
          ).rows[0]?.acquired,
        ).toBe(true);
      });
    const result = await f.run();
    if (result.status !== "artifacts_captured") throw new Error("Expected metadata recheck");
    expect(result.sourceRecheck).toMatchObject({
      metadataGuard: true,
      metadata: {
        recordObservations: result.traceCapture.comparisonCapture.graph.nodes.length,
        traceObservations: 0,
        traceReads: 0,
      },
    });
    expect(result.traceCapture.comparisonCapture.graph.unresolved.records).toBeGreaterThan(0);
    expect(result.sourceRecheck?.metadata?.recordReads).toBeGreaterThan(2);
    expect(result.sourceRecheck?.observedAt).toMatch(/\.\d{6}Z$/u);
    expect(f.objectReads()).toBe(1);
    expect(result).not.toHaveProperty("sealed");
    await f.cleanContext();
  });

  it("combines the complete graph reinspection with guarded criterion history on the same client", async () => {
    const f = await fixture(true, true);
    const result = await f.run();
    if (result.status !== "artifacts_captured")
      throw new Error("Expected metadata/criterion recheck");
    expect(result.sourceRecheck).toMatchObject({
      metadataGuard: true,
      criterionReads: 1,
      criterionHistoryReads: 1,
      criterionHistoryRows: 2,
    });
    expect(result.sourceRecheck?.metadata?.recordObservations).toBe(
      result.traceCapture.comparisonCapture.graph.nodes.length,
    );
    const under = result.criterionAuthority.underGuards;
    if (under?.status !== "observed") throw new Error("Expected guarded criterion authority");
    expect(under.completedAt).toBe(result.sourceRecheck?.observedAt);
    expect(f.objectReads()).toBe(1);
    await f.cleanContext();
  });

  it("rolls back when a valid missing dataset is created during content I/O", async () => {
    const f = await fixture(false, true);
    f.hooks.readContent = async () => {
      await f.versions.publishDatasetVersion(f.futureDataset);
    };
    await expect(f.run()).rejects.toMatchObject({
      reason: "source_revision_changed",
      identity: `dataset_version:${f.futureDataset.datasetVersionId}`,
    });
    expect(await f.versions.findDatasetVersion(f.scope, f.futureDataset.datasetVersionId)).toEqual(
      f.futureDataset,
    );
    expect(f.objectReads()).toBe(1);
    await f.transactions.runMetadata(f.scope, async (ports) => {
      expect(await ports.sources.findPolicy(f.policy.policyVersionId)).toEqual(f.policy);
    });
    await f.cleanContext();
  });

  it("retains the missing-source report while a competing metadata publisher waits for transaction release", async () => {
    const f = await fixture(false, true);
    let pending: Promise<unknown> | undefined;
    f.hooks.underGuards = async () => {
      pending = f.versions.publishDatasetVersion(f.futureDataset);
      // Install a rejection handler immediately; final cleanup still observes the original outcome.
      void pending.catch(() => {});
      await f.waitForWriter();
    };
    try {
      const result = await f.run();
      if (result.status !== "artifacts_captured") throw new Error("Expected held metadata report");
      expect(
        result.traceCapture.comparisonCapture.graph.nodes.find(
          ({ read }) =>
            read.source.kind === "dataset_version" &&
            read.source.reference.datasetVersionId === f.futureDataset.datasetVersionId,
        )?.read.observation.status,
      ).toBe("missing");
      if (!pending) throw new Error("Missing competing publisher");
      await pending;
      expect(
        await f.versions.findDatasetVersion(f.scope, f.futureDataset.datasetVersionId),
      ).toEqual(f.futureDataset);
      expect(f.objectReads()).toBe(1);
      expect(result.sourceRecheck?.metadataGuard).toBe(true);
      await f.cleanContext();
    } finally {
      await pending;
    }
  });

  it("fails wholly when another transaction owns the metadata barrier and cleans the held pool", async () => {
    const f = await fixture(false, true);
    const writer = await admin.connect();
    try {
      await writer.query("BEGIN");
      await writer.query(
        "SELECT set_config('proofstack.tenant_id', $1, true), set_config('proofstack.project_id', $2, true), set_config('proofstack.environment_id', $3, true)",
        [f.scope.tenantId, f.scope.projectId, f.scope.environmentId],
      );
      expect(
        (
          await writer.query<{ acquired: boolean }>(
            "SELECT public.proofstack_try_lock_policy_evaluation_metadata() AS acquired",
          )
        ).rows[0]?.acquired,
      ).toBe(true);
      await expect(f.run()).rejects.toMatchObject({
        reason: "guard_unavailable",
        identity: "metadata",
      });
      expect(f.objectReads()).toBe(1);
      await f.cleanContext();
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
    }
    await f.transactions.runMetadata(f.scope, async (ports) => {
      expect(await ports.sources.findPolicy(f.policy.policyVersionId)).toEqual(f.policy);
    });
    await f.cleanContext();
  });

  it("reinspects complete criterion authority on the held client with no metadata guard during object I/O", async () => {
    const f = await fixture(true);
    f.hooks.readContent = () =>
      withExactScopeTransaction(admin, f.scope, async (client) => {
        expect(
          (
            await client.query<{ acquired: boolean }>(
              "SELECT public.proofstack_try_lock_policy_evaluation_metadata() AS acquired",
            )
          ).rows[0]?.acquired,
        ).toBe(true);
      });
    const result = await f.run();
    if (result.status !== "artifacts_captured") throw new Error("Expected acquired criteria");
    expect(result.sourceRecheck).toMatchObject({
      metadataGuard: true,
      criterionReads: 1,
      criterionHistoryReads: 1,
      criterionHistoryRows: 2,
    });
    const under = result.criterionAuthority.underGuards;
    if (under?.status !== "observed") throw new Error("Missing guarded authority");
    expect(under.scope).toEqual(f.scope);
    expect(under.history).toHaveLength(2);
    expect(under.completedAt).toBe(result.sourceRecheck?.observedAt);
    expect(under.completedAt).toMatch(/\.\d{6}Z$/);
    expect(f.objectReads()).toBe(1);
    expect(result).not.toHaveProperty("sealed");
    await f.cleanContext();
  });

  for (const intervening of [false, true])
    it(`${intervening ? "rejects a committed" : "blocks a new"} criterion withdrawal at guarded reinspection`, async () => {
      const f = await fixture(true);
      const approved = f.evaluation?.records.find(
        (entry) => entry.kind === "criterion_set_status" && entry.record.status === "approved",
      );
      if (approved?.kind !== "criterion_set_status") throw new Error("Missing approved criterion");
      const withdrawal = criterionStatusHistoryFixture(approved.record, {
        statusRecordId: "csr_after_content",
        status: "withdrawn",
        expiresAt: undefined,
        previousStatus: {
          statusRecordId: approved.record.statusRecordId,
          definitionSha256: approved.record.definitionSha256,
        },
        recordedAt: "2026-10-08T00:00:00.000Z",
        effectiveAt: "2026-10-08T00:00:00Z",
      });
      const write = () => f.evaluationRepository.publishCriterionSetStatus(withdrawal);
      let pending: Promise<{ value: unknown } | { error: unknown }> | undefined;
      if (intervening)
        f.hooks.beforeRun = async () => {
          await write();
        };
      else
        f.hooks.underGuards = async (ports) => {
          pending = write().then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          await f.waitForWriter();
          expect(
            await ports.listCriterionSetStatuses({ maxRecords: 10, maxRecordBytes: 100_000 }),
          ).toHaveLength(2);
        };
      try {
        if (intervening) {
          await expect(f.run()).rejects.toMatchObject({ reason: "source_revision_changed" });
          await f.transactions.run(f.scope, (ports) => ports.tryMetadataGuard());
        } else {
          const result = await f.run();
          if (result.status !== "artifacts_captured") throw new Error("Expected guarded criteria");
          expect(result.sourceRecheck?.criterionHistoryRows).toBe(2);
          expect(
            result.criterionAuthority.underGuards?.status === "observed"
              ? result.criterionAuthority.underGuards.history.length
              : 0,
          ).toBe(2);
          if (!pending) throw new Error("Writer did not reach barrier");
          const outcome = await pending;
          if ("error" in outcome) throw outcome.error;
        }
        expect(
          await f.evaluationRepository.listCriterionSetStatuses(f.scope, {
            maxRecords: 10,
            maxRecordBytes: 100_000,
          }),
        ).toHaveLength(3);
        await f.cleanContext();
      } finally {
        await pending;
      }
    });
  it("rechecks real normalized sources under one READ COMMITTED connection with no guard during content I/O", async () => {
    const f = await fixture();
    f.hooks.readContent = () =>
      withExactScopeTransaction(admin, f.scope, async (client) => {
        await client.query("SET LOCAL statement_timeout = '1000ms'");
        // The matching exclusive lock would time out if the capture held a source guard here.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.policy-evaluation-source.v1', $1::text, 'artifact', $2::text)::text, 0))",
          [f.scope.tenantId, f.reference.artifactId],
        );
      });
    const output = await f.run();
    if (output.status !== "artifacts_captured") throw new Error("Expected acquired observations");
    expect(output.sourceRecheck).toMatchObject({
      status: "observations_rechecked",
      guards: output.sourceGuards.length,
      policyReads: 1,
    });
    expect(output.sourceRecheck?.observedAt).toMatch(/\.\d{6}Z$/);
    expect(
      output.artifacts.find(({ read }) => read.reference.artifactId === f.reference.artifactId)
        ?.read.observation.status,
    ).toBe("verified");
    expect(f.objectReads()).toBe(1);
    expect(output).not.toHaveProperty("sealed");
    await f.cleanContext();
  });

  for (const kind of ["artifact", "policy"] as const)
    it(`blocks actual ${kind} writes through reinspection, then releases the observation guards`, async () => {
      const f = await fixture();
      let pending: Promise<{ value: unknown } | { error: unknown }> | undefined;
      const event = releasePolicyLifecycleFixture(f.namespace, f.policy, {
        occurredAt: "2026-10-01T02:00:00.000Z",
      });
      f.hooks.underGuards = async (ports) => {
        pending = (
          kind === "artifact" ? f.tombstone() : policies.publishReleasePolicyLifecycleEvent(event)
        ).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await f.waitForWriter();
        if (kind === "artifact")
          expect(await ports.findArtifact(f.reference.artifactId)).toMatchObject({
            metadata: { state: "available" },
          });
        else expect(await ports.listPolicyHistory(f.policy.policyVersionId)).toEqual([]);
      };
      try {
        const output = await f.run();
        expect(output.status).toBe("artifacts_captured");
        const result = await pending;
        if (result && "error" in result) throw result.error;
        if (kind === "artifact")
          expect((await catalog.find(f.scope, f.reference.artifactId))?.metadata.state).toBe(
            "tombstoned",
          );
        else
          expect(
            await policies.listReleasePolicyLifecycleEvents(f.scope, f.policy.policyVersionId),
          ).toEqual([event]);
        await f.cleanContext();
      } finally {
        await pending;
      }
    });

  it.each(["artifact", "policy"])(
    "rejects a %s change between capture and guard acquisition",
    async (kind) => {
      const f = await fixture();
      f.hooks.beforeRun = async () => {
        if (kind === "artifact") await f.tombstone();
        else
          await policies.publishReleasePolicyLifecycleEvent(
            releasePolicyLifecycleFixture(f.namespace, f.policy),
          );
      };
      await expect(f.run()).rejects.toMatchObject({ reason: "source_revision_changed" });
      await f.cleanContext();
    },
  );

  it("includes known absent coordinates and rejects their creation before final reinspection", async () => {
    const f = await fixture();
    const baseline = await f.run();
    if (baseline.status !== "artifacts_captured") throw new Error("Expected artifact observations");
    const absent = baseline.artifacts.find(({ read }) => read.observation.status === "missing")
      ?.read.reference;
    if (!absent) throw new Error("Expected known missing artifact");
    expect(
      baseline.sourceGuards.some(({ kind, id }) => kind === "artifact" && id === absent.artifactId),
    ).toBe(true);
    f.hooks.beforeRun = async () => {
      const metadata = { ...f.metadata, contentReference: absent };
      await catalog.reserve({
        metadata,
        encryption: await f.encryption.createPlan(metadata),
        objectKey: `objects/${f.scope.tenantId}/missing`,
        createdByPrincipalId: "principal_writer",
      });
    };
    await expect(f.run()).rejects.toMatchObject({ reason: "source_revision_changed" });
    await f.cleanContext();
  });

  it("rolls back a real later guard conflict and releases earlier guards without authoritative reads", async () => {
    const f = await fixture();
    const baseline = await f.run();
    if (baseline.status !== "artifacts_captured") throw new Error("Expected guard plan");
    const first = baseline.sourceGuards[0];
    if (!first || first.kind !== "artifact") throw new Error("Expected first artifact coordinate");
    const writer = await admin.connect();
    try {
      await writer.query("BEGIN");
      await writer.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.policy-evaluation-source.v1', $1::text, 'release_policy', $2::text)::text, 0))",
        [f.scope.tenantId, f.policy.policyVersionId],
      );
      await expect(f.run()).rejects.toMatchObject({ reason: "guard_unavailable" });
      await withExactScopeTransaction(admin, f.scope, async (client) => {
        // Earlier shared guards must have rolled back, even though the later writer still owns its lock.
        expect(
          (
            await client.query<{ acquired: boolean }>(
              "SELECT pg_try_advisory_xact_lock(hashtextextended(jsonb_build_array('proofstack.policy-evaluation-source.v1', $1::text, 'artifact', $2::text)::text, 0)) AS acquired",
              [f.scope.tenantId, first.id],
            )
          ).rows[0]?.acquired,
        ).toBe(true);
      });
      await f.cleanContext();
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
    }
  });

  it("denies existing API runtime credentials instead of granting a new seal or guard authority", async () => {
    const f = await fixture();
    await expect(
      new PostgresPolicySourceTransactions(api).run(f.scope, (ports) =>
        ports.tryGuard("artifact", f.reference.artifactId),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      new PostgresPolicySourceTransactions(api).run(f.scope, (ports) => ports.tryMetadataGuard()),
    ).rejects.toMatchObject({ code: "42501" });
    const context = await api.query(
      "SELECT NULLIF(current_setting('proofstack.tenant_id', true), '') AS tenant",
    );
    expect(context.rows).toEqual([{ tenant: null }]);
  });
});
