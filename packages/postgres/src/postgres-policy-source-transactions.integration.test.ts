import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ArtifactCipher, LocalArtifactKeyring } from "@proofstack/artifacts";
import { MemoryArtifactObjectStore } from "@proofstack/artifacts/testing";
import {
  POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE,
  encodePolicyEvaluationJobHistoryEntry,
  encodePolicyEvaluationDefinition,
  type ArtifactMetadata,
  type ContentReference,
  type EndpointProfileDefinition,
  type EndpointProfileRecord,
  type EvaluationImplementationRegistrationDefinition,
  type EvaluationImplementationRegistrationRecord,
  encodeEvaluationCanonicalJson,
  policyEvaluationSourceReferenceKey,
  type PolicyEvaluationRequestDefinition,
  PolicyEvaluationSnapshotRuleInputsSchema,
  PolicyEvaluationSnapshotPageSchema,
  PrincipalContextSchema,
  type ProtocolDefinition,
  type ProtocolDefinitionRecord,
  ProtocolDefinitionSchema,
  ProtocolDefinitionSelectorSchema,
  type QualificationPolicyDefinition,
  type QualificationPolicyRecord,
  type RecordedInteractionFixtureVersionDefinition,
  type RegressionDatasetVersionDefinition,
  type RegressionFixtureVersionDefinition,
  type RuntimeDefinition,
  type RuntimeDefinitionRecord,
} from "@proofstack/contracts";
import {
  digestEndpointProfile,
  digestEvaluationImplementationRegistration,
  digestEvaluationRecordDefinition,
  digestPolicyEvaluationRequestDefinition,
  digestProtocolDefinition,
  digestQualificationPolicy,
  digestReleaseCandidateDefinition,
  digestRuntimeDefinition,
  enumeratePolicyEvaluationProtocolReferences,
  evaluationRecordDescriptors,
  readPolicyEvaluationEndpointProfileRecord,
  readPolicyEvaluationImplementationRecord,
  readPolicyEvaluationProtocolRecord,
  readPolicyEvaluationQualificationPolicyRecord,
  readPolicyEvaluationRuntimeRecord,
  releaseCandidateReference,
  releasePolicyReference,
  StaticEndpointProfileCatalogue,
  StaticProtocolDefinitionCatalogue,
  validatePolicyEvaluationSnapshot,
  validatePolicyEvaluationSnapshotRecord,
  computeSealedPolicyEvaluation,
  digestPolicyEvaluationDefinition,
  createPolicyEvaluationJobHistoryEntry,
  encodePolicyEvaluationJobGraph,
  buildPolicyEvaluationJobOutboxIntents,
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
  digestRecordedInteractionFixtureVersionDefinition,
  digestRegressionDatasetVersionDefinition,
  digestRegressionFixtureVersionDefinition,
} from "@proofstack/datasets";
import {
  capturePolicyArtifactEvidence,
  capturePolicySnapshotInputs,
  capturePolicySnapshotDefinition,
  capturePolicyInputRecordSources,
  sealPolicyEvaluationSnapshot,
  publishPolicyEvaluationWithReservedRules,
  inspectParentProtocolResolution,
  type PolicyArtifactEvidenceRepositories,
  type PolicyCandidateAuthorities,
  type PolicyEvaluationMetadataTransactions,
  type PolicyEvaluationSnapshotSealingTransactions,
  type PolicyArtifactByteAdmission,
  type PolicyAcquisitionAdmission,
  PolicyArtifactByteAdmissionError,
  type PolicyEvaluationSourceRecheckPorts,
  type PolicyEvaluationSourceTransactions,
  readParentProtocolResolution,
} from "@proofstack/policy-evaluation";
import { Pool } from "pg";
import { createPolicyPostgresPool } from "./database.js";
import { withBoundedPolicyTransaction } from "./bounded-policy-transaction.js";
import { PostgresPolicyEvaluationJobControlRepository } from "./postgres-policy-evaluation-job-control-repository.js";
import { PostgresPolicyEvaluationJobWorkerRepository } from "./postgres-policy-evaluation-job-worker-repository.js";
import { PostgresPolicyEvaluationResultRepository } from "./postgres-policy-evaluation-result-repository.js";
import { PostgresPolicySnapshotTransactions } from "./postgres-policy-snapshot-transactions.js";
import { PostgresPolicyAcquisitionRepository } from "./postgres-policy-acquisition-repository.js";
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
    "policyEvaluationControl",
    "policyEvaluator",
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
function runtime(
  kind: Exclude<
    keyof RuntimeRoleProvisioningOptions,
    "policyEvaluationControl" | "policyEvaluator"
  >,
) {
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

async function fixture(
  withCriteria = false,
  metadataMode = false,
  withModelEndpoint = false,
  withProtocols = false,
  withStoredCatalog = false,
  withSnapshotInputs = false,
  withSnapshotDefinition = false,
  withNativeSeal = false,
) {
  if (withStoredCatalog && !withProtocols)
    throw new Error("Stored catalog fixture requires protocols");
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
  const modelArtifactContents = new Map<string, Buffer>();
  // Independent installation data is defined before publishing a new capture that names it.
  const endpointProfile: EndpointProfileRecord | undefined = withModelEndpoint
    ? (() => {
        const vector = JSON.parse(
          readFileSync(
            new URL("../../contracts/vectors/endpoint-profile-v1.json", import.meta.url),
            "utf8",
          ),
        ) as { vectors: { input: { definition: EndpointProfileDefinition } }[] };
        const definition = vector.vectors[0]?.input.definition;
        if (!definition) throw new Error("Missing independent endpoint definition");
        const bytes = Buffer.from('{"provider":"reference","secret":"[REDACTED]"}');
        definition.configuration = {
          ...definition.configuration,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sizeBytes: bytes.byteLength,
        };
        modelArtifactContents.set(definition.configuration.artifactId, bytes);
        return {
          ...definition,
          scope,
          schemaVersion: "0.1",
          definitionSha256: digestEndpointProfile(scope, definition),
          registeredAt: "2026-09-01T00:00:00.000Z",
          registeredByPrincipalId: "operator_model_endpoint",
        };
      })()
    : undefined;
  const applicationName = `proofstack_${namespace}`;
  const observer = new Pool({
    connectionString: databaseUrl,
    max: 1,
    application_name: applicationName,
  });
  observedPools.push(observer);
  // Prove that the adapter overrides the pool's isolation default without changing that default.
  await observer.query("SET default_transaction_isolation = 'repeatable read'");
  const contents = Buffer.from("actual guarded policy source bytes");
  const reference: ContentReference = {
    artifactId: "artifact_recheck",
    mediaType: "text/plain",
    classification: "confidential",
    sizeBytes: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
  const protocolRecords: ProtocolDefinitionRecord[] = [];
  const storedReference = { ...reference, artifactId: "artifact_stored_catalog" };
  if (withProtocols) {
    if (!withModelEndpoint) throw new Error("Protocol graph fixture requires original capture");
    const captured = JSON.parse(
      readFileSync(
        new URL("../../datasets/vectors/interaction-fixture-definition-v2.json", import.meta.url),
        "utf8",
      ),
    ) as {
      vectors: { input: RecordedInteractionFixtureVersionDefinition }[];
    };
    const capture = captured.vectors[0]?.input.interactionCapture;
    const model = capture?.interactions[0];
    const attempt = model?.kind === "model" ? model.attempts[0] : undefined;
    if (!capture || !attempt) throw new Error("Missing original capture descriptors");
    const selectors = [
      { family: "capture_adapter", descriptor: capture.source.captureAdapter },
      { family: "source_format", descriptor: capture.source.sourceFormat },
      {
        family: "request_normalizer",
        descriptor: {
          name: attempt.normalizedRequest.adapterName,
          version: attempt.normalizedRequest.adapterVersion,
        },
      },
    ] as const;
    const vectors = JSON.parse(
      readFileSync(
        new URL("../../contracts/vectors/protocol-definition-v1.json", import.meta.url),
        "utf8",
      ),
    ) as {
      vectors: { input: { definition: ProtocolDefinition } }[];
    };
    for (const [index, selector] of selectors.entries()) {
      const template = vectors.vectors.find((v) => v.input.definition.family === selector.family)
        ?.input.definition;
      if (!template) throw new Error("Missing independent protocol template");
      const definition = ProtocolDefinitionSchema.parse({
        ...template,
        ...selector,
        protocolDefinitionId: `protocol_${namespace}_${index}`,
        specification: reference,
        ...("implementation" in template
          ? { implementation: reference, configuration: reference }
          : {}),
      });
      protocolRecords.push({
        ...definition,
        scope,
        schemaVersion: "0.1",
        definitionSha256: digestProtocolDefinition(scope, definition),
        registeredAt: "2026-09-01T00:00:00.000Z",
        registeredByPrincipalId: "operator_protocol_graph",
      });
    }
    const first = protocolRecords[0];
    if (!first) throw new Error("Missing independent protocol");
    const {
      scope: _scope,
      definitionSha256: _sha,
      schemaVersion: _schema,
      registeredAt: _at,
      registeredByPrincipalId: _by,
      ...body
    } = first;
    const alias = {
      ...body,
      protocolDefinitionId: `protocol_${namespace}_future`,
      ...(withStoredCatalog
        ? {
            specification: storedReference,
            ...("implementation" in body
              ? { implementation: storedReference, configuration: storedReference }
              : {}),
          }
        : {}),
    };
    protocolRecords.push({
      ...alias,
      scope,
      schemaVersion: "0.1",
      definitionSha256: digestProtocolDefinition(scope, alias),
      registeredAt: "2099-01-01T00:00:00.000Z",
      registeredByPrincipalId: "operator_future",
    });
  }
  const transactions = new PostgresPolicySourceTransactions(observer, {
    endpointProfiles: endpointProfile ? [endpointProfile] : [],
    protocolDefinitions: protocolRecords,
  });
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
  const storedObjectKey = `objects/${scope.tenantId}/stored-only`;
  let storedCatalog: Awaited<ReturnType<PostgresArtifactCatalogRepository["activate"]>> | undefined;
  if (withStoredCatalog) {
    const storedMetadata = { ...metadata, contentReference: storedReference };
    const storedPlan = await encryption.createPlan(storedMetadata);
    await catalog.reserve({
      metadata: storedMetadata,
      encryption: storedPlan,
      objectKey: storedObjectKey,
      createdByPrincipalId: "principal_stored_writer",
    });
    const encrypted = await encryption.encrypt(storedMetadata, storedPlan, contents);
    // No object is installed: a catalog readiness report must not become byte verification.
    storedCatalog = await catalog.activate(
      scope,
      storedReference.artifactId,
      encrypted.receipt,
      "2026-09-04T00:01:00.000001Z",
    );
  }
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
  const modelFixture = endpointProfile
    ? (() => {
        const vector = JSON.parse(
          readFileSync(
            new URL(
              "../../datasets/vectors/interaction-fixture-definition-v2.json",
              import.meta.url,
            ),
            "utf8",
          ),
        ) as { vectors: { input: RecordedInteractionFixtureVersionDefinition }[] };
        const capture = structuredClone(vector.vectors[0]?.input.interactionCapture);
        const model = capture?.interactions[0];
        const attempt = model?.kind === "model" ? model.attempts[0] : undefined;
        if (!capture || model?.kind !== "model" || !attempt)
          throw new Error("Missing recorded model attempt");
        const configuration = capture.artifacts.find(
          (binding) =>
            binding.contentReference.artifactId ===
            attempt.artifacts.providerConfigurationArtifactId,
        );
        if (!configuration) throw new Error("Missing captured provider configuration");
        configuration.contentReference = structuredClone(endpointProfile.configuration);
        configuration.redaction = {
          status: "applied",
          records: [
            {
              stage: "source",
              rulesetId: "rule_private",
              rulesetVersion: "1",
              changedPaths: ["/secret"],
              matchCount: 1,
            },
          ],
        };
        for (const binding of capture.artifacts) {
          if (binding === configuration) continue;
          const bytes = Buffer.from(JSON.stringify({ syntheticCaptureRole: binding.role }));
          binding.contentReference.sha256 = createHash("sha256").update(bytes).digest("hex");
          binding.contentReference.sizeBytes = bytes.byteLength;
          modelArtifactContents.set(binding.contentReference.artifactId, bytes);
        }
        const normalized = capture.artifacts.find(
          (binding) => binding.contentReference.artifactId === attempt.normalizedRequest.artifactId,
        );
        const prompt = capture.artifacts.find(
          (binding) => binding.contentReference.artifactId === model.prompt.artifactId,
        );
        if (!normalized || !prompt) throw new Error("Missing original capture bindings");
        attempt.normalizedRequest.sha256 = normalized.contentReference.sha256;
        model.prompt.definitionSha256 = prompt.contentReference.sha256;
        capture.artifacts.sort((a, b) =>
          a.contentReference.artifactId < b.contentReference.artifactId ? -1 : 1,
        );
        attempt.artifacts.providerConfigurationArtifactId =
          endpointProfile.configuration.artifactId;
        attempt.provider = {
          ...attempt.provider,
          name: endpointProfile.provider,
          endpointProfileId: endpointProfile.endpointProfileId,
          endpointProfileVersion: endpointProfile.endpointProfileVersion,
        };
        model.attempts.push({
          ...structuredClone(attempt),
          attemptId: "attempt_repeated",
          sequence: 1,
        });
        const definition: RecordedInteractionFixtureVersionDefinition = {
          ...fixtureDefinition,
          fixtureVersionId: `${fixtureVersion.fixtureVersionId}_model`,
          schemaVersion: "0.2",
          replayability: "recorded_interactions",
          interactionCapture: capture,
          predecessor: {
            fixtureVersionId: fixtureVersion.fixtureVersionId,
            definitionSha256: fixtureVersion.definitionSha256,
          },
        };
        return {
          ...definition,
          source: { ...definition.source, capturedAt: "2026-09-01T00:00:00.000Z" },
          createdAt: "2026-09-01T00:00:00.001Z",
          createdByPrincipalId: "principal_model_fixture",
          definitionSha256: digestRecordedInteractionFixtureVersionDefinition(definition),
        };
      })()
    : undefined;
  const datasetFixture = modelFixture ?? fixtureVersion;
  const datasetDefinition: RegressionDatasetVersionDefinition = {
    schemaVersion: "0.1",
    scope,
    name: "Initially missing exact dataset",
    datasetId: `dataset_${namespace}`,
    datasetVersionId: `dtv_${namespace}`,
    fixtureVersions: [
      {
        fixtureId: datasetFixture.fixtureId,
        fixtureVersionId: datasetFixture.fixtureVersionId,
        definitionSha256: datasetFixture.definitionSha256,
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
    if (modelFixture) {
      // Real authenticated encrypted bytes and eligible catalog rows precede exclusive ownership.
      // The synthetic payloads test retained-byte integrity, not actual model execution.
      for (const binding of modelFixture.interactionCapture.artifacts) {
        const bytes = modelArtifactContents.get(binding.contentReference.artifactId);
        if (!bytes) throw new Error("Missing original artifact bytes");
        const metadata: ArtifactMetadata = {
          schemaVersion: "0.1",
          scope,
          contentReference: binding.contentReference,
          createdAt: "2026-08-29T00:00:00.000Z",
          state: "reserved",
          retention: binding.retention,
          redaction: binding.redaction,
        };
        const plan = await encryption.createPlan(metadata);
        const objectKey = `objects/${scope.tenantId}/${binding.contentReference.artifactId}`;
        await catalog.reserve({
          metadata,
          encryption: plan,
          objectKey,
          createdByPrincipalId: "principal_model_artifacts",
        });
        const encrypted = await encryption.encrypt(metadata, plan, bytes);
        await objects.putIfAbsent(objectKey, encrypted.bytes);
        await catalog.activate(
          scope,
          binding.contentReference.artifactId,
          encrypted.receipt,
          "2026-08-29T00:00:00.001Z",
        );
      }
      await versions.publishRecordedInteractionFixtureVersion(modelFixture);
      await versions.publishDatasetVersion(futureDataset);
    }
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
    ...(endpointProfile
      ? { endpointProfiles: new StaticEndpointProfileCatalogue([endpointProfile]) }
      : {}),
    ...(withProtocols
      ? { protocolDefinitions: new StaticProtocolDefinitionCatalogue(protocolRecords) }
      : {}),
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
    // A distinct request declares the extra original-source/output inspection work up front.
    // Existing fixtures retain 10,000; no running job receives a budget increase or refund.
    limits: withNativeSeal
      ? { ...base.limits, maxAcquisitionRecords: 50000, leaseDurationMilliseconds: 20000 }
      : withSnapshotDefinition
        ? { ...base.limits, maxAcquisitionRecords: 50000 }
        : withSnapshotInputs
          ? { ...base.limits, maxAcquisitionRecords: 20000 }
          : base.limits,
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
  const objectKeysRead: string[] = [];
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
  const captureArguments = (candidateAuthorities?: PolicyCandidateAuthorities) =>
    [
      request,
      actor,
      repositories,
      metadataMode ? new PostgresEvidenceRepository(api) : new MemoryEvidenceRepository(),
      {
        catalog,
        objects: {
          get: async (key: string) => {
            objectReads++;
            objectKeysRead.push(key);
            await hooks.readContent?.();
            return objects.get(key);
          },
        },
        encryption,
        clock: { now: () => new Date() },
        ...(candidateAuthorities ? { candidateAuthorities } : {}),
        ...(metadataMode ? { metadataTransactions } : { sourceTransactions }),
      },
    ] as const;
  const run = (candidateAuthorities?: PolicyCandidateAuthorities) =>
    capturePolicyArtifactEvidence(...captureArguments(candidateAuthorities));
  const runSnapshot = () =>
    capturePolicySnapshotInputs(...captureArguments(), {
      manifestId: `manifest_${namespace}`,
    });
  const runDefinition = () =>
    capturePolicySnapshotDefinition(...captureArguments(), {
      manifestId: `manifest_definition_${namespace}`,
      snapshotId: `snapshot_${namespace}`,
    });
  const tombstone = () =>
    maintenance.tombstone(scope, {
      artifactId: reference.artifactId,
      tombstoneId: `tombstone_${namespace}`,
      actorPrincipalId: "principal_maintenance",
      trigger: "manual",
      reason: "Exercise source recheck serialization",
      occurredAt: "2026-10-01T02:00:00.000Z",
    });
  const tombstoneStored = () =>
    maintenance.tombstone(scope, {
      artifactId: storedReference.artifactId,
      tombstoneId: `tombstone_stored_${namespace}`,
      actorPrincipalId: "principal_maintenance",
      trigger: "manual",
      reason: "Exercise future-only catalog guards",
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
    request,
    captureArguments,
    evaluation,
    evaluationRepository,
    scope,
    policy,
    reference,
    metadata,
    encryption,
    hooks,
    run,
    runSnapshot,
    runDefinition,
    observer,
    transactions,
    versions,
    futureDataset,
    endpointProfile,
    modelFixture,
    protocolRecords,
    storedReference,
    storedCatalog,
    storedObjectKey,
    objectKeysRead,
    tombstoneStored,
    tombstone,
    cleanContext,
    waitForWriter,
    objectReads: () => objectReads,
  };
}

async function nativeSealingHarness(leaseMilliseconds = 20000) {
  const f = await fixture(true, true, true, true, false, false, true, true);
  // Separate least-privilege control/evaluator pools prove the actual native grants.
  const idleErrors: Error[] = [];
  const evaluatorCredentials = credentials.policyEvaluator;
  const controlCredentials = credentials.policyEvaluationControl;
  if (!evaluatorCredentials || !controlCredentials)
    throw new Error("Expected separate policy role credentials");
  const evaluatorUrl = new URL(databaseUrl as string);
  evaluatorUrl.username = evaluatorCredentials.name;
  evaluatorUrl.password = evaluatorCredentials.password;
  const controlUrl = new URL(databaseUrl as string);
  controlUrl.username = controlCredentials.name;
  controlUrl.password = controlCredentials.password;
  const pool = createPolicyPostgresPool({
    connectionString: evaluatorUrl.toString(),
    maxConnections: 4,
    onIdleError: (error) => idleErrors.push(error),
  });
  const controlPool = createPolicyPostgresPool({
    connectionString: controlUrl.toString(),
    maxConnections: 4,
    onIdleError: (error) => idleErrors.push(error),
  });
  observedPools.push(pool, controlPool);
  const control = new PostgresPolicyEvaluationJobControlRepository(controlPool);
  const worker = new PostgresPolicyEvaluationJobWorkerRepository(pool);
  const jobId = `job_${f.namespace}`;
  f.request.limits.leaseDurationMilliseconds = leaseMilliseconds;
  f.request.limits.heartbeatIntervalMilliseconds = Math.min(
    1000,
    Math.floor(leaseMilliseconds / 3),
  );
  const {
    scope: _scope,
    schemaVersion: _schema,
    createdAt: _at,
    createdByPrincipalId: _principal,
    definitionSha256: _digest,
    ...requestDefinition
  } = f.request;
  f.request.definitionSha256 = digestPolicyEvaluationRequestDefinition(f.scope, requestDefinition);
  const created = await control.createJob({ request: f.request, jobId });
  const actor = PrincipalContextSchema.parse({
    ...f.captureArguments()[1],
    principalId: `worker_${f.namespace}`,
    capabilities: ["artifact:read", "artifact:read:restricted", "policy:evaluation:execute"],
    authentication: {
      method: "service_token",
      credentialId: `credential_${f.namespace}`,
      authenticatedAt: new Date().toISOString(),
    },
  });
  const claimed = await worker.claimJob({
    scope: f.scope,
    jobId,
    workerId: actor.principalId,
    attemptId: `attempt_${f.namespace}`,
    leaseId: `lease_${f.namespace}`,
  });
  const fence = claimed.job.currentLease!.mutationFence;
  const [_request, _actor, repositories, evidence, dependencies] = f.captureArguments();
  const contentDependencies = {
    catalog: dependencies.catalog,
    objects: dependencies.objects,
    encryption: dependencies.encryption,
    clock: dependencies.clock,
  };
  const nativeRepositories = {
    ...repositories,
    logicalRoots: {
      evaluation: f.evaluationRepository,
      comparison: new PostgresComparisonRepository(api),
      releaseCandidate: new PostgresReleaseCandidateRepository(api),
      releasePolicy: policies,
      datasets: f.versions,
    },
  };
  const transactions = new PostgresPolicySnapshotTransactions(pool, {
    endpointProfiles: f.endpointProfile ? [f.endpointProfile] : [],
    protocolDefinitions: f.protocolRecords,
  });
  const seal = (
    sealTransactions: PolicyEvaluationSnapshotSealingTransactions = transactions,
    artifactByteAdmission?: PolicyArtifactByteAdmission,
    acquisitionAdmission?: PolicyAcquisitionAdmission,
  ) =>
    sealPolicyEvaluationSnapshot(
      created.snapshot.request,
      actor,
      nativeRepositories,
      evidence,
      contentDependencies,
      {
        manifestId: `manifest_seal_${f.namespace}`,
        snapshotId: `snapshot_seal_${f.namespace}`,
        fence,
        transactions: sealTransactions,
        ...(artifactByteAdmission ? { artifactByteAdmission } : {}),
        ...(acquisitionAdmission ? { acquisitionAdmission } : {}),
      },
    );
  return {
    f,
    pool,
    controlPool,
    control,
    worker,
    jobId,
    actor,
    created,
    claimed,
    fence,
    transactions,
    seal,
    idleErrors,
  };
}

async function nativeResultHarness(paidRules = 7, leaseMilliseconds = 20000) {
  const h = await nativeSealingHarness(leaseMilliseconds);
  const sealed = await h.seal();
  await h.worker.startComputation({ scope: h.f.scope, fence: h.fence });
  if (paidRules > 0)
    await h.worker.reserveWork({
      scope: h.f.scope,
      fence: h.fence,
      reservationId: `rules_${h.f.namespace}`,
      delta: {
        reads: 0,
        records: 0,
        recordBytes: 0,
        references: 0,
        referenceBytes: 0,
        artifactReadBytes: 0,
        ruleEvaluations: paidRules,
      },
    });
  const pageSet = await withBoundedPolicyTransaction(
    h.pool,
    async (client) => {
      const pages = [];
      for (const descriptor of sealed.snapshot.pages) {
        const value = await client.query(
          "SELECT public.proofstack_read_policy_snapshot_page($1,$2,$3) AS value",
          [sealed.snapshot.snapshotId, sealed.snapshot.definitionSha256, descriptor.pageIndex],
        );
        pages.push(PolicyEvaluationSnapshotPageSchema.parse(value.rows[0]?.value));
      }
      const {
        scope: _scope,
        schemaVersion: _version,
        definitionSha256: _digest,
        sealedAt: _sealed,
        sealedByPrincipalId: _principal,
        jobId: _job,
        attemptId: _attempt,
        workerId: _worker,
        leaseId: _lease,
        fencingToken: _fence,
        recoveryEpoch: _epoch,
        recordedAt: _at,
        ...definition
      } = sealed.snapshot;
      return {
        scope: h.f.scope,
        definition,
        definitionSha256: sealed.snapshot.definitionSha256,
        pages,
      };
    },
    { scope: h.f.scope },
  );
  return {
    ...h,
    sealed,
    pageSet,
    results: new PostgresPolicyEvaluationResultRepository(h.pool),
    command: {
      scope: h.f.scope,
      fence: h.fence,
      evaluationId: `evaluation_${h.f.namespace}`,
      pageSet,
    },
  };
}

describe("request-owned source recheck on actual PostgreSQL", () => {
  it("unawaited held acquisition failure rolls back and cannot consume or close original credit", async () => {
    const h = await nativeSealingHarness();
    const acquisition = new PostgresPolicyAcquisitionRepository(h.pool);
    const before = (
      await acquisition.reserveAcquisition({
        scope: h.f.scope,
        fence: h.fence,
        allowanceId: `allowance_${h.f.namespace}`,
      })
    ).snapshot;
    const head = await h.worker.findHistoryHead(h.f.scope, h.jobId);
    await expect(
      h.transactions.runSealing({ scope: h.f.scope, fence: h.fence }, async (ports) => {
        if (!ports.settleAcquisition) throw new Error("Missing fixed port");
        void ports.settleAcquisition("allowance_wrong", {
          reads: 0,
          records: 0,
          references: 0,
          recordBytes: 0,
          referenceBytes: 0,
        });
        return "ignored-failure";
      }),
    ).rejects.toThrow();
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(before);
    expect(await h.worker.findHistoryHead(h.f.scope, h.jobId)).toEqual(head);
    expect(h.idleErrors).toEqual([]);
  });
  it("expired held acquisition ports cannot settle retained credit after their transaction", async () => {
    const h = await nativeSealingHarness();
    const acquisition = new PostgresPolicyAcquisitionRepository(h.pool);
    const before = (
      await acquisition.reserveAcquisition({
        scope: h.f.scope,
        fence: h.fence,
        allowanceId: `allowance_${h.f.namespace}`,
      })
    ).snapshot;
    const ports = await h.transactions.runSealing(
      { scope: h.f.scope, fence: h.fence },
      async (ports) => ports,
    );
    if (!ports.settleAcquisition) throw new Error("Missing fixed port");
    await expect(
      ports.settleAcquisition(`allowance_${h.f.namespace}`, {
        reads: 0,
        records: 0,
        references: 0,
        recordBytes: 0,
        referenceBytes: 0,
      }),
    ).rejects.toThrow("expired");
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(before);
    expect(h.idleErrors).toEqual([]);
  });
  it("settles owning acquisition credit on the guarded sealing client before snapshot publication", async () => {
    const h = await nativeSealingHarness();
    const admission: PolicyAcquisitionAdmission = {
      repository: new PostgresPolicyAcquisitionRepository(h.pool),
      allowanceId: `allowance_${h.f.namespace}`,
    };
    const sealed = await h.seal(undefined, undefined, admission);
    expect(sealed.job.job.status).toBe("sealed");
    expect(sealed.job.acquisitionAllowance).toBeNull();
    expect(sealed.job.usage.reads).toBeGreaterThan(0);
    const retained = await admin.query(
      "SELECT state,observed_usage FROM public.proofstack_policy_acquisition_allowances WHERE job_id=$1",
      [h.jobId],
    );
    expect(retained.rows).toEqual([
      {
        state: "observed",
        observed_usage: {
          reads: sealed.job.usage.reads,
          records: sealed.job.usage.records,
          references: sealed.job.usage.references,
          recordBytes: sealed.job.usage.recordBytes,
          referenceBytes: sealed.job.usage.referenceBytes,
        },
      },
    ]);
    expect(h.idleErrors).toEqual([]);
  });
  it("retains exact drained acquisition charges after whole native snapshot publication rollback", async () => {
    const h = await nativeSealingHarness();
    const admission: PolicyAcquisitionAdmission = {
      repository: new PostgresPolicyAcquisitionRepository(h.pool),
      allowanceId: `allowance_${h.f.namespace}`,
    };
    const failing: PolicyEvaluationSnapshotSealingTransactions = {
      runSealing: (command, operation) =>
        h.transactions.runSealing(command, (ports) =>
          operation({
            ...ports,
            publishSnapshot: async (definition, principal) => {
              await ports.publishSnapshot(definition, principal);
              throw new Error("after-native-seal");
            },
          }),
        ),
    };
    await expect(h.seal(failing, undefined, admission)).rejects.toThrow("after-native-seal");
    const current = await h.worker.findJob(h.f.scope, h.jobId);
    expect(current?.job.status).toBe("acquiring");
    expect(current?.job.snapshot).toBeNull();
    expect(current?.acquisitionAllowance).toBeNull();
    expect(current?.usage.reads).toBeGreaterThan(0);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM public.proofstack_policy_evaluation_snapshots WHERE job_id=$1",
          [h.jobId],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(h.idleErrors).toEqual([]);
  });
  it("caught held settlement failure taints the transaction and preserves independently settled costs", async () => {
    const h = await nativeSealingHarness();
    const admission: PolicyAcquisitionAdmission = {
      repository: new PostgresPolicyAcquisitionRepository(h.pool),
      allowanceId: `allowance_${h.f.namespace}`,
    };
    const failing: PolicyEvaluationSnapshotSealingTransactions = {
      runSealing: (command, operation) =>
        h.transactions.runSealing(command, (ports) =>
          operation({
            ...ports,
            settleAcquisition: async (id, usage) => {
              if (!ports.settleAcquisition) throw new Error("Missing fixed port");
              try {
                await ports.settleAcquisition("allowance_wrong", usage);
              } catch {
                /* Caught failures must still prohibit commit. */
              }
              return ports.settleAcquisition(id, usage);
            },
          }),
        ),
    };
    await expect(h.seal(failing, undefined, admission)).rejects.toThrow();
    const current = await h.worker.findJob(h.f.scope, h.jobId);
    expect(current?.job.snapshot).toBeNull();
    expect(current?.acquisitionAllowance).toBeNull();
    expect(current?.usage.reads).toBeGreaterThan(0);
    expect(h.idleErrors).toEqual([]);
  });
  it("commits every policy rule invocation before native result publication", async () => {
    const h = await nativeResultHarness(0);
    const result = await publishPolicyEvaluationWithReservedRules(
      {
        ...h.command,
        principal: h.actor,
      },
      {
        repository: h.worker,
        publisher: h.results,
        snapshotRecord: h.sealed.snapshot,
        pageSet: h.pageSet,
        nextReservationId: () => `rule_invocation_${h.f.namespace}`,
      },
    );
    expect(result.created).toBe(true);
    expect(result.snapshot.usage.ruleEvaluations).toBe(7);
    expect(result.evaluation.ruleCount).toBe(7);
    expect(result.snapshot.attempts.at(-1)?.usageAtClose?.ruleEvaluations).toBe(7);
    expect(await h.results.findResult(h.f.scope, h.jobId, h.pageSet)).toEqual(result.evaluation);
    expect(h.idleErrors).toEqual([]);
  });
  it("retains each policy rule invocation fee after native rollback and refuses duplicate payment reuse", async () => {
    const h = await nativeResultHarness(0);
    await admin.query(
      "INSERT INTO public.proofstack_outbox (tenant_id,aggregate_type,aggregate_id,event_type,payload,schema_version,created_at) SELECT tenant_id,aggregate_type,aggregate_id,'policy.evaluation.job.terminal','{}'::jsonb,schema_version,created_at FROM public.proofstack_outbox WHERE tenant_id=$1 AND event_type='policy.evaluation.job.created'",
      [h.f.scope.tenantId],
    );
    const command = { ...h.command, principal: h.actor };
    const dependencies = {
      repository: h.worker,
      publisher: h.results,
      snapshotRecord: h.sealed.snapshot,
      pageSet: h.pageSet,
      nextReservationId: () => `rule_invocation_${h.f.namespace}`,
    };
    await expect(publishPolicyEvaluationWithReservedRules(command, dependencies)).rejects.toThrow();
    expect((await h.worker.findJob(h.f.scope, h.jobId))?.usage.ruleEvaluations).toBe(7);
    expect(await h.results.findResult(h.f.scope, h.jobId, h.pageSet)).toBeNull();
    // The injected conflict and the already committed fee both remain immutable.
    await expect(publishPolicyEvaluationWithReservedRules(command, dependencies)).rejects.toThrow(
      "fresh reservation occurrence",
    );
    expect((await h.worker.findJob(h.f.scope, h.jobId))?.usage.ruleEvaluations).toBe(7);
    await expect(
      publishPolicyEvaluationWithReservedRules(command, {
        ...dependencies,
        nextReservationId: () => `rule_invocation_retry_${h.f.namespace}`,
      }),
    ).rejects.toThrow();
    const retained = await h.worker.findJob(h.f.scope, h.jobId);
    expect(retained?.usage.ruleEvaluations).toBe(14);
    expect(retained?.job.status).toBe("running");
    expect(retained?.attempts.at(-1)?.closure).toBeNull();
    expect(await h.results.findResult(h.f.scope, h.jobId, h.pageSet)).toBeNull();
    expect(h.idleErrors).toEqual([]);
  });
  it("retains paid policy rule invocation work when cancellation commits before publication", async () => {
    const h = await nativeResultHarness(0);
    const publisher = {
      publishResult: async (command: Parameters<typeof h.results.publishResult>[0]) => {
        await h.control.cancelJob({
          scope: h.f.scope,
          jobId: h.jobId,
          cancellationId: `cancel_paid_${h.f.namespace}`,
          principalId: "operator_native",
          reason: "operator_requested",
        });
        return h.results.publishResult(command);
      },
    };
    await expect(
      publishPolicyEvaluationWithReservedRules(
        { ...h.command, principal: h.actor },
        {
          repository: h.worker,
          publisher,
          snapshotRecord: h.sealed.snapshot,
          pageSet: h.pageSet,
          nextReservationId: () => `rule_invocation_${h.f.namespace}`,
        },
      ),
    ).rejects.toThrow();
    const retained = await h.worker.findJob(h.f.scope, h.jobId);
    expect(retained?.usage.ruleEvaluations).toBe(7);
    expect(retained?.cancellation?.cancellationId).toBe(`cancel_paid_${h.f.namespace}`);
    expect(await h.results.findResult(h.f.scope, h.jobId, h.pageSet)).toBeNull();
    expect(h.idleErrors).toEqual([]);
  });
  it("publishes a native policy result, closed attempt, terminal job, history and canonical outbox atomically", async () => {
    const h = await nativeResultHarness();
    const before = await h.worker.findJob(h.f.scope, h.jobId);
    const result = await h.results.publishResult(h.command);
    expect(result.created).toBe(true);
    expect(result.snapshot.job.status).toBe("completed");
    expect(result.snapshot.job.currentLease).toBeNull();
    expect(result.snapshot.job.snapshot).toEqual(h.sealed.job.job.snapshot);
    expect(result.snapshot.usage).toEqual(before?.usage);
    expect(result.snapshot.attempts.at(-1)?.closure).toEqual({
      status: "completed",
      committedAt: result.evaluation.recordedAt,
    });
    expect(result.snapshot.job.terminal).toMatchObject({
      status: "completed",
      code: "evaluation_completed",
      committedAt: result.evaluation.recordedAt,
    });
    expect(result.evaluation.rules[0]).toMatchObject({
      outcome: "indeterminate",
      evidence: { reason: "approval_not_evaluated" },
    });
    expect(await h.results.findResult(h.f.scope, h.jobId, h.pageSet)).toEqual(result.evaluation);
    const head = await h.worker.findHistoryHead(h.f.scope, h.jobId);
    if (!head) throw new Error("Missing completed owning history");
    const page = await h.worker.readHistoryPage(
      head,
      Math.floor(head.sequence / POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE),
    );
    expect(page.entries.at(-1)?.definition.operation).toEqual({
      kind: "complete",
      fence: h.fence,
      result: result.snapshot.job.result,
      ruleCount: 7,
    });
    const canonical = await admin.query(
      "SELECT count(*)::integer AS count FROM public.proofstack_outbox WHERE tenant_id=$1 AND event_type='policy.evaluation.job.terminal'",
      [h.f.scope.tenantId],
    );
    expect(canonical.rows[0]?.count).toBe(1);
    const repeated = await h.results.publishResult(h.command);
    expect(repeated).toEqual({ ...result, created: false });
    expect(await h.worker.findHistoryHead(h.f.scope, h.jobId)).toEqual(head);
    expect(h.idleErrors).toEqual([]);
  });
  it.each([0, 6])(
    "refuses native policy result publication after paying only %s rules",
    async (paid) => {
      const h = await nativeResultHarness(paid);
      const before = await h.worker.findJob(h.f.scope, h.jobId);
      await expect(h.results.publishResult(h.command)).rejects.toThrow("prepaid whole rule work");
      expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(before);
      const retained = await admin.query(
        "SELECT count(*)::integer AS count FROM public.proofstack_policy_evaluation_results WHERE tenant_id=$1",
        [h.f.scope.tenantId],
      );
      expect(retained.rows[0]?.count).toBe(0);
    },
  );
  it("rejects another native policy result identity after an immutable completion", async () => {
    const h = await nativeResultHarness();
    const original = await h.results.publishResult(h.command);
    await expect(
      h.results.publishResult({ ...h.command, evaluationId: "evaluation_other" }),
    ).rejects.toThrow();
    expect(await h.results.findResult(h.f.scope, h.jobId, h.pageSet)).toEqual(original.evaluation);
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(original.snapshot);
  });
  it("rolls back native policy result, attempt and history when canonical outbox insertion conflicts", async () => {
    const h = await nativeResultHarness();
    const before = await h.worker.findJob(h.f.scope, h.jobId);
    const head = await h.worker.findHistoryHead(h.f.scope, h.jobId);
    await admin.query(
      "INSERT INTO public.proofstack_outbox (tenant_id,aggregate_type,aggregate_id,event_type,payload,schema_version,created_at) SELECT tenant_id,aggregate_type,aggregate_id,'policy.evaluation.job.terminal','{}'::jsonb,schema_version,created_at FROM public.proofstack_outbox WHERE tenant_id=$1 AND event_type='policy.evaluation.job.created'",
      [h.f.scope.tenantId],
    );
    await expect(h.results.publishResult(h.command)).rejects.toThrow();
    // The unrelated conflicting fixture remains; only the attempted publication rolls back.
    const graph = await admin.query(
      "SELECT snapshot AS value FROM public.proofstack_policy_evaluation_jobs WHERE tenant_id=$1 AND job_id=$2",
      [h.f.scope.tenantId, h.jobId],
    );
    expect(graph.rows[0]?.value).toEqual(before);
    expect(await h.worker.findHistoryHead(h.f.scope, h.jobId)).toEqual(head);
    const retained = await admin.query(
      "SELECT count(*)::integer AS count FROM public.proofstack_policy_evaluation_results WHERE tenant_id=$1",
      [h.f.scope.tenantId],
    );
    expect(retained.rows[0]?.count).toBe(0);
  });
  it("rejects native policy result publication when cancellation wins the job lock", async () => {
    const h = await nativeResultHarness();
    const cancelled = await h.control.cancelJob({
      scope: h.f.scope,
      jobId: h.jobId,
      cancellationId: `cancel_${h.f.namespace}`,
      principalId: "operator_native",
      reason: "operator_requested",
    });
    await expect(h.results.publishResult(h.command)).rejects.toThrow();
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(cancelled);
    expect(await h.results.findResult(h.f.scope, h.jobId, h.pageSet)).toBeNull();
  });
  it("rolls back native policy result publication without its atomic history and intent", async () => {
    const h = await nativeResultHarness();
    const before = await h.worker.findJob(h.f.scope, h.jobId);
    const head = await h.worker.findHistoryHead(h.f.scope, h.jobId);
    const definition = computeSealedPolicyEvaluation({
      evaluationId: h.command.evaluationId,
      expected: {
        scope: h.f.scope,
        jobId: h.jobId,
        request: h.sealed.job.job.request,
        snapshot: h.sealed.job.job.snapshot!,
      },
      record: h.sealed.snapshot,
      pageSet: h.pageSet,
    });
    await expect(
      withBoundedPolicyTransaction(
        h.pool,
        (client) =>
          client.query(
            "SELECT public.proofstack_publish_policy_evaluation_result($1::jsonb,$2,$3)",
            [
              JSON.stringify(h.fence),
              Buffer.from(
                encodePolicyEvaluationDefinition({ scope: h.f.scope, definition }),
              ).toString("utf8"),
              digestPolicyEvaluationDefinition(h.f.scope, definition),
            ],
          ),
        { scope: h.f.scope },
      ),
    ).rejects.toThrow();
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(before);
    expect(await h.worker.findHistoryHead(h.f.scope, h.jobId)).toEqual(head);
    expect(await h.results.findResult(h.f.scope, h.jobId, h.pageSet)).toBeNull();
  });
  it("rejects altered original pages before native policy result insertion", async () => {
    const h = await nativeResultHarness();
    const before = await h.worker.findJob(h.f.scope, h.jobId);
    const pageSet = structuredClone(h.pageSet);
    pageSet.pages.pop();
    await expect(h.results.publishResult({ ...h.command, pageSet })).rejects.toThrow();
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(before);
    expect(await h.results.findResult(h.f.scope, h.jobId, h.pageSet)).toBeNull();
  });
  it("preserves native policy result receipts on an exact retry after the original lease expires", async () => {
    const h = await nativeResultHarness(7, 10000);
    const original = await h.results.publishResult(h.command);
    const head = await h.worker.findHistoryHead(h.f.scope, h.jobId);
    await admin.query(
      "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05)",
      [h.claimed.job.currentLease?.expiresAt],
    );
    expect(await h.results.publishResult(h.command)).toEqual({ ...original, created: false });
    expect(await h.results.findResult(h.f.scope, h.jobId, h.pageSet)).toEqual(original.evaluation);
    expect(await h.worker.findHistoryHead(h.f.scope, h.jobId)).toEqual(head);
    expect(h.idleErrors).toEqual([]);
  });
  it("rolls back native policy result completion when its original lease expires before deferred commit", async () => {
    const h = await nativeResultHarness(7, 10000);
    const before = await h.worker.findJob(h.f.scope, h.jobId);
    const head = await h.worker.findHistoryHead(h.f.scope, h.jobId);
    if (!before || !head) throw new Error("Missing owning running job");
    const page = await h.worker.readHistoryPage(
      head,
      Math.floor(head.sequence / POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE),
    );
    const previousEntry = page.entries.at(-1);
    if (!previousEntry) throw new Error("Missing owning running history");
    const definition = computeSealedPolicyEvaluation({
      evaluationId: h.command.evaluationId,
      expected: {
        scope: h.f.scope,
        jobId: h.jobId,
        request: h.sealed.job.job.request,
        snapshot: h.sealed.job.job.snapshot!,
      },
      record: h.sealed.snapshot,
      pageSet: h.pageSet,
    });
    const client = await admin.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query(
        "SELECT set_config('proofstack.tenant_id',$1,true),set_config('proofstack.project_id',$2,true),set_config('proofstack.environment_id',$3,true)",
        [h.f.scope.tenantId, h.f.scope.projectId, h.f.scope.environmentId],
      );
      const receipt = await client.query(
        "SELECT public.proofstack_publish_policy_evaluation_result($1::jsonb,$2,$3) AS value",
        [
          JSON.stringify(h.fence),
          Buffer.from(encodePolicyEvaluationDefinition({ scope: h.f.scope, definition })).toString(
            "utf8",
          ),
          digestPolicyEvaluationDefinition(h.f.scope, definition),
        ],
      );
      const next = receipt.rows[0]?.value.job;
      const entry = createPolicyEvaluationJobHistoryEntry({
        previous: before,
        previousEntry,
        next,
        operation: {
          kind: "complete",
          fence: h.fence,
          result: next.job.result,
          ruleCount: definition.ruleCount,
        },
      });
      await client.query(
        "SELECT public.proofstack_append_policy_evaluation_job_history($1::jsonb,$2,$3,$4::jsonb)",
        [
          JSON.stringify(entry),
          Buffer.from(encodePolicyEvaluationJobHistoryEntry(entry.definition)).toString("utf8"),
          Buffer.from(encodePolicyEvaluationJobGraph(next)).toString("utf8"),
          JSON.stringify(buildPolicyEvaluationJobOutboxIntents(before, next)),
        ],
      );
      await client.query(
        "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05)",
        [h.claimed.job.currentLease?.expiresAt],
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "55000" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(before);
    expect(await h.worker.findHistoryHead(h.f.scope, h.jobId)).toEqual(head);
    expect(await h.results.findResult(h.f.scope, h.jobId, h.pageSet)).toBeNull();
    expect(h.idleErrors).toEqual([]);
  });
  it("limits native policy result mutation to evaluator and denies direct result DML", async () => {
    const h = await nativeResultHarness();
    for (const [kind, role] of Object.entries(credentials)) {
      if (!role) throw new Error("Missing provisioned role");
      const value = await admin.query(
        "SELECT has_function_privilege($1,'public.proofstack_publish_policy_evaluation_result(jsonb,text,text)','EXECUTE') AS allowed,has_table_privilege($1,'public.proofstack_policy_evaluation_results','INSERT') AS direct",
        [role.name],
      );
      expect(value.rows[0]?.allowed).toBe(kind === "policyEvaluator");
      expect(value.rows[0]?.direct).toBe(false);
    }
    const definition = computeSealedPolicyEvaluation({
      evaluationId: h.command.evaluationId,
      expected: {
        scope: h.f.scope,
        jobId: h.jobId,
        request: h.sealed.job.job.request,
        snapshot: h.sealed.job.job.snapshot!,
      },
      record: h.sealed.snapshot,
      pageSet: h.pageSet,
    });
    await expect(
      withBoundedPolicyTransaction(
        h.controlPool,
        (client) =>
          client.query(
            "SELECT public.proofstack_publish_policy_evaluation_result($1::jsonb,$2,$3)",
            [
              JSON.stringify(h.fence),
              Buffer.from(
                encodePolicyEvaluationDefinition({ scope: h.f.scope, definition }),
              ).toString("utf8"),
              digestPolicyEvaluationDefinition(h.f.scope, definition),
            ],
          ),
        { scope: h.f.scope },
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const protection = await admin.query(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.proofstack_policy_evaluation_results'::regclass",
    );
    expect(protection.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });
  it("rejects every substituted native policy result fence and hides completed results from foreign scopes", async () => {
    const h = await nativeResultHarness();
    const before = await h.worker.findJob(h.f.scope, h.jobId);
    for (const replacement of [
      { workerId: "worker_other" },
      { leaseId: "lease_other" },
      { attemptId: "attempt_other" },
      { fencingToken: h.fence.fencingToken + 1 },
      { recoveryEpoch: h.fence.recoveryEpoch + 1 },
    ])
      await expect(
        h.results.publishResult({ ...h.command, fence: { ...h.fence, ...replacement } }),
      ).rejects.toThrow();
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(before);
    const result = await h.results.publishResult(h.command);
    for (const key of ["tenantId", "projectId", "environmentId"] as const) {
      const foreign = { ...h.f.scope, [key]: "scope_foreign" };
      expect(await h.results.findResult(foreign, h.jobId, h.pageSet)).toBeNull();
      await withBoundedPolicyTransaction(
        h.controlPool,
        async (client) => {
          const value = await client.query(
            "SELECT public.proofstack_read_policy_evaluation_result($1,$2) AS value",
            [result.evaluation.evaluationId, result.evaluation.definitionSha256],
          );
          expect(value.rows).toEqual([{ value: null }]);
        },
        { scope: foreign },
      );
    }
    expect(h.idleErrors).toEqual([]);
  });
  it("starts one sealed native computation without recapture and evaluates the original retained pages", async () => {
    const h = await nativeSealingHarness();
    const sealed = await h.seal();
    const readsBefore = h.f.objectReads();
    const headBefore = await h.worker.findHistoryHead(h.f.scope, h.jobId);
    const started = await h.worker.startComputation({ scope: h.f.scope, fence: h.fence });
    expect(started.job.status).toBe("running");
    expect(started.job.snapshot).toEqual(sealed.job.job.snapshot);
    expect(started.job.currentLease).toEqual(sealed.job.job.currentLease);
    expect(started.attempts).toEqual(sealed.job.attempts);
    expect(started.usage).toEqual(sealed.job.usage);
    expect(started.job.stateVersion).toBe(sealed.job.job.stateVersion + 1);
    expect(h.f.objectReads()).toBe(readsBefore);
    const head = await h.worker.findHistoryHead(h.f.scope, h.jobId);
    if (!head || !headBefore) throw new Error("Missing owning computation history");
    expect(head.sequence).toBe(headBefore.sequence + 1);
    const history = await h.worker.readHistoryPage(
      head,
      Math.floor(head.sequence / POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE),
    );
    expect(history.entries.at(-1)?.definition.operation).toEqual({
      kind: "start_computation",
      fence: h.fence,
    });
    await withBoundedPolicyTransaction(
      h.pool,
      async (client) => {
        const pages = [];
        for (const descriptor of sealed.snapshot.pages) {
          const value = await client.query(
            "SELECT public.proofstack_read_policy_snapshot_page($1,$2,$3) AS value",
            [sealed.snapshot.snapshotId, sealed.snapshot.definitionSha256, descriptor.pageIndex],
          );
          pages.push(PolicyEvaluationSnapshotPageSchema.parse(value.rows[0]?.value));
        }
        const {
          scope: _scope,
          schemaVersion: _version,
          definitionSha256: _sha,
          sealedAt: _sealed,
          sealedByPrincipalId: _by,
          jobId: _job,
          attemptId: _attempt,
          workerId: _worker,
          leaseId: _lease,
          fencingToken: _fence,
          recoveryEpoch: _epoch,
          recordedAt: _receipt,
          ...definition
        } = sealed.snapshot;
        const reference = started.job.snapshot;
        if (!reference) throw new Error("Missing original sealed reference");
        const result = computeSealedPolicyEvaluation({
          evaluationId: `result_${h.f.namespace}`,
          expected: {
            scope: h.f.scope,
            jobId: h.jobId,
            request: started.job.request,
            snapshot: reference,
          },
          record: sealed.snapshot,
          pageSet: {
            scope: h.f.scope,
            definition,
            definitionSha256: sealed.snapshot.definitionSha256,
            pages,
          },
        });
        expect(result.snapshot).toEqual(reference);
        expect(result.request).toEqual(started.job.request);
        expect(result.rules.map((rule) => rule.ruleIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
        expect(result.rules[0]).toMatchObject({
          outcome: "indeterminate",
          evidence: { reason: "approval_not_evaluated" },
        });
      },
      { scope: h.f.scope },
    );
    await expect(
      h.worker.startComputation({ scope: h.f.scope, fence: h.fence }),
    ).rejects.toMatchObject({
      name: "PolicyEvaluationSchedulerTransitionError",
      reason: "state_conflict",
    });
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(started);
    expect(h.idleErrors).toEqual([]);
  });
  it("refuses native computation admission before an original snapshot is sealed", async () => {
    const h = await nativeSealingHarness();
    await expect(
      h.worker.startComputation({ scope: h.f.scope, fence: h.fence }),
    ).rejects.toMatchObject({
      name: "PolicyEvaluationSchedulerTransitionError",
      reason: "state_conflict",
    });
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(h.claimed);
  });
  it.each(["workerId", "attemptId", "leaseId", "fencingToken", "recoveryEpoch"] as const)(
    "rejects a substituted native computation %s without changing the sealed graph",
    async (field) => {
      const h = await nativeSealingHarness();
      const sealed = await h.seal();
      const fence = {
        ...h.fence,
        [field]:
          typeof h.fence[field] === "number" ? Number(h.fence[field]) + 1 : "foreign_computation",
      };
      await expect(h.worker.startComputation({ scope: h.f.scope, fence })).rejects.toThrow();
      expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(sealed.job);
      expect(h.idleErrors).toEqual([]);
    },
  );
  it("keeps a cancelled seal terminal instead of starting native computation", async () => {
    const h = await nativeSealingHarness();
    await h.seal();
    const cancelled = await h.control.cancelJob({
      scope: h.f.scope,
      jobId: h.jobId,
      cancellationId: `cancel_${h.f.namespace}`,
      principalId: "operator_computation",
      reason: "operator_requested",
    });
    await expect(
      h.worker.startComputation({ scope: h.f.scope, fence: h.fence }),
    ).rejects.toMatchObject({
      name: "PolicyEvaluationSchedulerTransitionError",
      reason: "state_conflict",
    });
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(cancelled);
  });
  it("hides a sealed job in another exact environment from native computation admission", async () => {
    const h = await nativeSealingHarness();
    const sealed = await h.seal();
    await expect(
      h.worker.startComputation({
        scope: { ...h.f.scope, environmentId: "env_foreign" },
        fence: h.fence,
      }),
    ).rejects.toThrow();
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(sealed.job);
  });
  it("admits exactly one of two concurrent native computation starts", async () => {
    const h = await nativeSealingHarness();
    const sealed = await h.seal();
    const results = await Promise.allSettled([
      h.worker.startComputation({ scope: h.f.scope, fence: h.fence }),
      h.worker.startComputation({ scope: h.f.scope, fence: h.fence }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const current = await h.worker.findJob(h.f.scope, h.jobId);
    expect(current?.job.status).toBe("running");
    expect(current?.job.stateVersion).toBe(sealed.job.job.stateVersion + 1);
    expect(h.idleErrors).toEqual([]);
  });
  it("rolls back native computation and history when the lease expires before deferred commit", async () => {
    // Complete real sealing first; expiry is tested at deferred COMMIT, not during acquisition.
    // Keep the existing 15s test timeout and native I/O limits; wait for this actual DB lease cut.
    const h = await nativeSealingHarness(10000);
    const sealed = await h.seal();
    const head = await h.worker.findHistoryHead(h.f.scope, h.jobId);
    if (!head) throw new Error("Missing owning sealed history");
    const page = await h.worker.readHistoryPage(
      head,
      Math.floor(head.sequence / POLICY_EVALUATION_JOB_HISTORY_PAGE_SIZE),
    );
    const previousEntry = page.entries.at(-1);
    if (!previousEntry) throw new Error("Missing owning previous entry");
    const client = await admin.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query(
        "SELECT set_config('proofstack.tenant_id',$1,true),set_config('proofstack.project_id',$2,true),set_config('proofstack.environment_id',$3,true)",
        [h.f.scope.tenantId, h.f.scope.projectId, h.f.scope.environmentId],
      );
      const changed = await client.query(
        "SELECT public.proofstack_start_policy_evaluation_computation($1::jsonb) AS value",
        [JSON.stringify(h.fence)],
      );
      const next = changed.rows[0]?.value;
      const entry = createPolicyEvaluationJobHistoryEntry({
        previous: sealed.job,
        previousEntry,
        next,
        operation: { kind: "start_computation", fence: h.fence },
      });
      await client.query(
        "SELECT public.proofstack_append_policy_evaluation_job_history($1::jsonb,$2,$3,$4::jsonb)",
        [
          JSON.stringify(entry),
          Buffer.from(encodePolicyEvaluationJobHistoryEntry(entry.definition)).toString("utf8"),
          Buffer.from(encodePolicyEvaluationJobGraph(next)).toString("utf8"),
          JSON.stringify(buildPolicyEvaluationJobOutboxIntents(sealed.job, next)),
        ],
      );
      await client.query(
        "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05)",
        [sealed.job.job.currentLease?.expiresAt],
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "55000" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(sealed.job);
    expect(await h.worker.findHistoryHead(h.f.scope, h.jobId)).toEqual(head);
    expect(h.idleErrors).toEqual([]);
  });
  it("limits native computation execution to the separate policy evaluator role", async () => {
    const h = await nativeSealingHarness();
    const sealed = await h.seal();
    await expect(
      withBoundedPolicyTransaction(
        h.controlPool,
        (client) =>
          client.query("SELECT public.proofstack_start_policy_evaluation_computation($1::jsonb)", [
            JSON.stringify(h.fence),
          ]),
        { scope: h.f.scope },
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(sealed.job);
    for (const [kind, role] of Object.entries(credentials)) {
      if (!role) throw new Error("Missing provisioned role");
      const checked = await admin.query(
        "SELECT has_function_privilege($1,'public.proofstack_start_policy_evaluation_computation(jsonb)','EXECUTE') AS allowed",
        [role.name],
      );
      expect(checked.rows[0]?.allowed).toBe(kind === "policyEvaluator");
    }
  });
  it("native bounded artifact admission does not begin I/O after a delayed acknowledgement expires", async () => {
    const h = await nativeSealingHarness(3000);
    let entered = false;
    const admission: PolicyArtifactByteAdmission = {
      repository: {
        reserveWork: async (command) => {
          const result = await h.worker.reserveWork(command);
          await new Promise((resolve) => setTimeout(resolve, 3100));
          return result;
        },
      },
      nextReservationId: () => `bounded_${randomUUID().replaceAll("-", "")}`,
      objectReader: {
        get: async () => {
          entered = true;
          return null;
        },
      },
    };
    await expect(h.seal(h.transactions, admission)).rejects.toBeInstanceOf(
      PolicyArtifactByteAdmissionError,
    );
    expect(entered).toBe(false);
    expect(h.f.objectReads()).toBe(0);
    const current = await h.worker.findJob(h.f.scope, h.jobId);
    expect(current!.job.status).toBe("acquiring");
    expect(current!.job.snapshot).toBeNull();
    expect(current!.usage.artifactReadBytes).toBeGreaterThan(0);
    expect(current!.request).toEqual(h.created.snapshot.request);
  });
  it("native bounded artifact reads abort at their remaining lease without refund or publication", async () => {
    const h = await nativeSealingHarness(3000);
    let signal: AbortSignal | undefined;
    const admission: PolicyArtifactByteAdmission = {
      repository: h.worker,
      nextReservationId: () => `bounded_${randomUUID().replaceAll("-", "")}`,
      objectReader: {
        get: (_key, options) =>
          new Promise((_resolve, reject) => {
            signal = options.signal;
            signal.addEventListener("abort", () => reject(signal!.reason), { once: true });
          }),
      },
    };
    await expect(h.seal(h.transactions, admission)).rejects.toBeInstanceOf(
      PolicyArtifactByteAdmissionError,
    );
    expect(signal!.aborted).toBe(true);
    const current = await h.worker.findJob(h.f.scope, h.jobId);
    expect(current!.usage.artifactReadBytes).toBeGreaterThan(0);
    expect(current!.job.status).toBe("acquiring");
    expect(current!.job.snapshot).toBeNull();
    const { rows } = await admin.query(
      "SELECT count(*)::integer AS count FROM public.proofstack_policy_evaluation_snapshots WHERE tenant_id=$1",
      [h.f.scope.tenantId],
    );
    expect(rows[0]?.count).toBe(0);
  });
  it("native artifact budget refusal does not start content I/O or a snapshot", async () => {
    const h = await nativeSealingHarness();
    await h.worker.reserveWork({
      scope: h.f.scope,
      fence: h.fence,
      reservationId: `spent_${h.f.namespace}`,
      delta: {
        reads: 0,
        records: 0,
        recordBytes: 0,
        references: 0,
        referenceBytes: 0,
        artifactReadBytes: h.f.request.limits.maxArtifactReadBytes,
        ruleEvaluations: 0,
      },
    });
    const admission: PolicyArtifactByteAdmission = {
      repository: h.worker,
      nextReservationId: () => `artifact_read_${randomUUID().replaceAll("-", "")}`,
    };
    await expect(h.seal(h.transactions, admission)).rejects.toMatchObject({
      reason: "budget_exhausted",
    });
    expect(h.f.objectReads()).toBe(0);
    const current = await h.worker.findJob(h.f.scope, h.jobId);
    expect(current!.usage.artifactReadBytes).toBe(h.f.request.limits.maxArtifactReadBytes);
    expect(current!.job.snapshot).toBeNull();
  });
  it("native artifact reservations commit before get and survive later publication rollback", async () => {
    const h = await nativeSealingHarness();
    const commands: Parameters<typeof h.worker.reserveWork>[0][] = [];
    const admission: PolicyArtifactByteAdmission = {
      repository: {
        reserveWork: async (command) => {
          const result = await h.worker.reserveWork(command);
          commands.push(command);
          return result;
        },
      },
      nextReservationId: () => `artifact_read_${randomUUID().replaceAll("-", "")}`,
    };
    h.f.hooks.readContent = async () => {
      const current = await h.worker.findJob(h.f.scope, h.jobId);
      expect(current!.usage.artifactReadBytes).toBe(
        commands.reduce((sum, command) => sum + command.delta.artifactReadBytes, 0),
      );
      expect(current!.usage.artifactReadBytes).toBeGreaterThan(0);
    };
    const failure = new Error("Fail after paid content and native publication");
    const transactions: PolicyEvaluationSnapshotSealingTransactions = {
      runSealing: (command, operation) =>
        h.transactions.runSealing(command, (ports) =>
          operation({
            ...ports,
            publishSnapshot: async (...args) => {
              await ports.publishSnapshot(...args);
              throw failure;
            },
          }),
        ),
    };
    await expect(h.seal(transactions, admission)).rejects.toBe(failure);
    const current = await h.worker.findJob(h.f.scope, h.jobId);
    expect(current!.usage.artifactReadBytes).toBe(
      commands.reduce((sum, command) => sum + command.delta.artifactReadBytes, 0),
    );
    expect(current!.job.status).toBe("acquiring");
    expect(current!.job.snapshot).toBeNull();
    expect(current!.attempts[0]!.phase).toBe("acquiring");
    expect(new Set(commands.map((command) => command.reservationId)).size).toBe(h.f.objectReads());
    for (const table of [
      "proofstack_policy_evaluation_snapshots",
      "proofstack_policy_evaluation_snapshot_pages",
    ]) {
      const { rows } = await admin.query(
        `SELECT count(*)::integer AS count FROM public.${table} WHERE tenant_id=$1`,
        [h.f.scope.tenantId],
      );
      expect(rows[0]?.count).toBe(0);
    }
  });
  it("native artifact reservations remain included in the atomically sealed job", async () => {
    const h = await nativeSealingHarness();
    const admission: PolicyArtifactByteAdmission = {
      repository: h.worker,
      nextReservationId: () => `artifact_read_${randomUUID().replaceAll("-", "")}`,
    };
    const sealed = await h.seal(h.transactions, admission);
    expect(sealed.job.usage.artifactReadBytes).toBeGreaterThan(0);
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(sealed.job);
    const head = await h.worker.findHistoryHead(h.f.scope, h.jobId);
    expect(head!.sequence).toBe(sealed.job.job.stateVersion - 1);
    expect(sealed.job.attempts[0]!.mutationFence).toEqual(h.fence);
  });
  it("native sealing evaluator has no direct snapshot or job DML", async () => {
    const h = await nativeSealingHarness();
    for (const statement of [
      "INSERT INTO public.proofstack_policy_evaluation_snapshots (tenant_id) VALUES ($1)",
      "UPDATE public.proofstack_policy_evaluation_jobs SET status='sealed' WHERE tenant_id=$1",
    ])
      await expect(h.pool.query(statement, [h.f.scope.tenantId])).rejects.toMatchObject({
        code: "42501",
      });
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(h.claimed);
  });
  it.each(["caught", "unawaited"] as const)(
    "native sealing taints %s source-port failure and expires retained ports",
    async (mode) => {
      const h = await nativeSealingHarness();
      let retained:
        | Parameters<Parameters<PolicyEvaluationSnapshotSealingTransactions["runSealing"]>[1]>[0]
        | undefined;
      await expect(
        h.transactions.runSealing({ scope: h.f.scope, fence: h.fence }, async (ports) => {
          retained = ports;
          const failed = ports.sources.tryGuard("artifact", "INVALID_ID");
          if (mode === "caught") await failed.catch(() => undefined);
          else void failed.catch(() => undefined);
          return "handled";
        }),
      ).rejects.toMatchObject({ name: "ZodError" });
      await expect(retained!.sources.observationTime()).rejects.toThrow("port has expired");
      expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(h.claimed);
      expect(h.idleErrors).toEqual([]);
    },
  );
  it("native sealing cannot bind an existing job in another exact environment", async () => {
    const h = await nativeSealingHarness();
    let entered = false;
    await expect(
      h.transactions.runSealing(
        { scope: { ...h.f.scope, environmentId: "env_other" }, fence: h.fence },
        async () => {
          entered = true;
        },
      ),
    ).rejects.toMatchObject({ code: "P0002" });
    expect(entered).toBe(false);
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(h.claimed);
  });
  it("native sealing refuses a lease expiring during content I/O before database guards", async () => {
    const h = await nativeSealingHarness(3000);
    let paused = false;
    h.f.hooks.readContent = async () => {
      if (!paused) {
        paused = true;
        await new Promise((resolve) => setTimeout(resolve, 3100));
      }
    };
    await expect(h.seal()).rejects.toMatchObject({ code: "55000" });
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(h.claimed);
    const { rows } = await admin.query(
      "SELECT count(*)::integer AS count FROM public.proofstack_policy_evaluation_snapshots WHERE tenant_id=$1",
      [h.f.scope.tenantId],
    );
    expect(rows[0]?.count).toBe(0);
  });
  it.each(["missing_page", "substituted_frame"] as const)(
    "native sealing rolls back %s before page insertion",
    async (kind) => {
      const h = await nativeSealingHarness();
      const transactions: PolicyEvaluationSnapshotSealingTransactions = {
        runSealing: (command, operation) =>
          h.transactions.runSealing(command, (ports) =>
            operation({
              ...ports,
              publishSnapshot: (definition, principalId) => {
                const changed = structuredClone(definition);
                if (kind === "missing_page") changed.pages.pop();
                else changed.pages[0]!.frames[0]!.dataBase64url = "AAAA";
                return ports.publishSnapshot(changed, principalId);
              },
            }),
          ),
      };
      await expect(h.seal(transactions)).rejects.toMatchObject({
        name: "PolicyEvaluationSnapshotIntegrityError",
      });
      expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(h.claimed);
      for (const relation of [
        "proofstack_policy_evaluation_snapshots",
        "proofstack_policy_evaluation_snapshot_pages",
      ]) {
        const { rows } = await admin.query(
          `SELECT count(*)::integer AS count FROM public.${relation} WHERE tenant_id=$1`,
          [h.f.scope.tenantId],
        );
        expect(rows[0]?.count).toBe(0);
      }
    },
  );
  it.each(["api", "policyAuthor", "evaluationWorker", "humanReviewer", "control"] as const)(
    "native sealing denies %s publication and direct snapshot writes",
    async (kind) => {
      const h = await nativeSealingHarness();
      const denied = kind === "control" ? h.controlPool : runtime(kind);
      if (kind !== "control") observedPools.push(denied);
      await expect(
        denied.query("SELECT public.proofstack_publish_policy_snapshot($1::jsonb,$2,$3)", [
          JSON.stringify(h.fence),
          "{}",
          "0".repeat(64),
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        denied.query(
          "INSERT INTO public.proofstack_policy_evaluation_snapshots (tenant_id) VALUES ($1)",
          [h.f.scope.tenantId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(h.claimed);
    },
  );
  it("native sealing rejects an unfenced metadata cut before executing publication ports", async () => {
    const h = await nativeSealingHarness();
    await expect(
      withBoundedPolicyTransaction(
        h.pool,
        (client) =>
          client.query("SELECT public.proofstack_publish_policy_snapshot($1::jsonb,$2,$3)", [
            JSON.stringify(h.fence),
            "{}",
            "0".repeat(64),
          ]),
        { scope: h.f.scope },
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(h.claimed);
  });
  it("native sealing rejects a stale recovery fence before exposing source ports", async () => {
    const h = await nativeSealingHarness();
    let entered = false;
    await expect(
      h.transactions.runSealing(
        { scope: h.f.scope, fence: { ...h.fence, recoveryEpoch: h.fence.recoveryEpoch + 1 } },
        async () => {
          entered = true;
        },
      ),
    ).rejects.toMatchObject({ code: "40001" });
    expect(entered).toBe(false);
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(h.claimed);
  });
  it("native sealing preserves cancellation winning before guarded publication", async () => {
    const h = await nativeSealingHarness();
    h.f.hooks.readContent = async () => {
      await h.control.cancelJob({
        scope: h.f.scope,
        jobId: h.jobId,
        cancellationId: `cancel_${h.f.namespace}`,
        principalId: "principal_cancel",
        reason: "operator_requested",
      });
    };
    await expect(h.seal()).rejects.toMatchObject({ code: "40001" });
    const current = await h.worker.findJob(h.f.scope, h.jobId);
    expect(current?.job.status).toBe("cancelled");
    expect(current?.job.snapshot).toBeNull();
    const { rows } = await admin.query(
      "SELECT count(*)::integer AS count FROM public.proofstack_policy_evaluation_snapshots WHERE tenant_id=$1",
      [h.f.scope.tenantId],
    );
    expect(rows[0]?.count).toBe(0);
  });
  it("native sealing rolls back pages, binding and history when work fails after native publication", async () => {
    const h = await nativeSealingHarness();
    const original = new Error("Failure after native page/root publication");
    const transactions: PolicyEvaluationSnapshotSealingTransactions = {
      runSealing: (command, operation) =>
        h.transactions.runSealing(command, (ports) =>
          operation({
            ...ports,
            publishSnapshot: async (...args) => {
              await ports.publishSnapshot(...args);
              throw original;
            },
          }),
        ),
    };
    await expect(h.seal(transactions)).rejects.toBe(original);
    expect(await h.worker.findJob(h.f.scope, h.jobId)).toEqual(h.claimed);
    for (const relation of [
      "proofstack_policy_evaluation_snapshots",
      "proofstack_policy_evaluation_snapshot_pages",
    ]) {
      const { rows } = await admin.query(
        `SELECT count(*)::integer AS count FROM public.${relation} WHERE tenant_id=$1`,
        [h.f.scope.tenantId],
      );
      expect(rows[0]?.count).toBe(0);
    }
    expect(h.idleErrors).toEqual([]);
  });
  it("atomically stores a native rechecked snapshot and binds the same live acquiring attempt", async () => {
    const { f, pool, worker, jobId, claimed, fence, seal, idleErrors } =
      await nativeSealingHarness();
    const sealed = await seal();
    expect(sealed.job.job.status).toBe("sealed");
    expect(sealed.job.attempts).toEqual([
      { ...claimed.attempts[0], phase: "computing", snapshot: sealed.job.job.snapshot },
    ]);
    expect(sealed.job.job.currentLease).toEqual(claimed.job.currentLease);
    expect(sealed.snapshot).toMatchObject({
      jobId,
      attemptId: fence.attemptId,
      workerId: fence.workerId,
      leaseId: fence.leaseId,
      fencingToken: fence.fencingToken,
      recoveryEpoch: fence.recoveryEpoch,
      sealedAt: sealed.job.job.updatedAt,
    });
    expect(await worker.findJob(f.scope, jobId)).toEqual(sealed.job);
    await withBoundedPolicyTransaction(
      pool,
      async (client) => {
        const { rows } = await client.query(
          "SELECT public.proofstack_read_policy_snapshot($1,$2) AS value",
          [sealed.snapshot.snapshotId, sealed.snapshot.definitionSha256],
        );
        expect(rows[0]?.value).toEqual(sealed.snapshot);
        const pages = [];
        for (const descriptor of sealed.snapshot.pages) {
          const page = await client.query(
            "SELECT public.proofstack_read_policy_snapshot_page($1,$2,$3) AS value",
            [sealed.snapshot.snapshotId, sealed.snapshot.definitionSha256, descriptor.pageIndex],
          );
          expect(page.rows[0]?.value.definitionSha256).toBe(descriptor.definitionSha256);
          pages.push(PolicyEvaluationSnapshotPageSchema.parse(page.rows[0]?.value));
        }
        const {
          scope: _scope,
          schemaVersion: _schema,
          definitionSha256: _digest,
          sealedAt: _sealed,
          sealedByPrincipalId: _principal,
          jobId: _job,
          attemptId: _attempt,
          workerId: _worker,
          leaseId: _lease,
          fencingToken: _fence,
          recoveryEpoch: _epoch,
          recordedAt: _recorded,
          ...definition
        } = sealed.snapshot;
        const checked = validatePolicyEvaluationSnapshotRecord({
          expected: {
            scope: f.scope,
            jobId,
            snapshot: sealed.job.job.snapshot!,
            request: sealed.job.job.request,
          },
          record: rows[0]?.value,
          pageSet: {
            scope: f.scope,
            definition,
            definitionSha256: sealed.snapshot.definitionSha256,
            pages,
          },
        });
        expect(checked.inputs.schemaVersion).toBe("0.2");
        expect(checked.inputs.request).toEqual(sealed.job.request);
      },
      { scope: f.scope },
    );
    expect(f.objectReads()).toBeGreaterThan(0);
    expect(idleErrors).toEqual([]);
  });
  it("captures complete typed snapshot definition pages through native metadata recheck without publication authority", async () => {
    const f = await fixture(true, true, true, true, false, false, true);
    const result = await f.runDefinition();
    if (result.status !== "artifacts_captured")
      throw new Error("Missing native snapshot definition");
    const inputs = validatePolicyEvaluationSnapshot({
      expected: {
        snapshot: {
          snapshotId: result.snapshotDefinition.definition.snapshotId,
          definitionSha256: result.snapshotDefinition.definitionSha256,
        },
        request: result.snapshotInputs.sources.records.request,
        scope: f.scope,
      },
      pageSet: result.snapshotDefinition,
    });
    expect(inputs.request).toEqual(f.request);
    expect(inputs.criterionAuthority.underGuards?.status).toBe("observed");
    expect(result.sourceRecheck?.status).toBe("observations_rechecked");
    expect(result.snapshotDefinition).not.toHaveProperty("sealedAt");
    expect(result.usage.references).toBeLessThanOrEqual(f.request.limits.maxAcquisitionRecords);
    await f.cleanContext();
  });
  it("joins one native artifact capture to exact record/rule/manifest inputs before readonly recheck", async () => {
    const f = await fixture(true, true, true, true, false, true);
    const result = await f.runSnapshot();
    if (result.status !== "artifacts_captured") throw new Error("Missing composed native inputs");
    expect(result.snapshotInputs.sources.records.scope).toEqual(f.scope);
    expect(result.snapshotInputs.sources.records.request).toEqual(
      result.snapshotRules.inputs.request,
    );
    expect(result.snapshotInputs.manifest.pages.flatMap(({ entries }) => entries)).toEqual(
      result.snapshotInputs.sources.records.records.map(({ entry }) => entry),
    );
    expect(result.sourceRecheck?.status).toBe("observations_rechecked");
    expect(result.snapshotInputs.sources.records.records.length).toBeGreaterThan(2);
    expect(result.snapshotInputs.inspectionUsage.references).toBeGreaterThan(0);
    expect(result.snapshotInputs.inspectionUsage.referenceBytes).toBeGreaterThan(0);
    expect(f.request.limits.maxAcquisitionRecords).toBe(20000);
    expect(result.usage.references).toBeGreaterThan(10000);
    expect(result.usage.references).toBeLessThanOrEqual(20000);
    expect(result.snapshotInputs).not.toHaveProperty("sealed");
    await f.cleanContext();
  });
  it("rolls back and cleans the native scope when composed work exhausts the original request budget", async () => {
    const f = await fixture(true, true, true, true);
    expect(f.request.limits.maxAcquisitionRecords).toBe(10000);
    await expect(f.runSnapshot()).rejects.toMatchObject({ reason: "reference_limit" });
    await f.cleanContext();
  });
  it("derives the complete input record manifest from one held native metadata scope", async () => {
    const f = await fixture(true, true, true, true);
    const captured = await f.transactions.runMetadata(f.scope, async (ports) => {
      const acquired = await withExactScopeTransaction(
        admin,
        f.scope,
        async (client) =>
          (
            await client.query<{ acquired: boolean }>(
              "SELECT public.proofstack_try_lock_policy_evaluation_metadata() AS acquired",
            )
          ).rows[0]?.acquired,
      );
      expect(acquired).toBe(false);
      return capturePolicyInputRecordSources(f.request, ports.records);
    });
    expect(captured.status).toBe("record_sources_captured");
    expect(captured.sources.authorityBoundary).toBe("record_sources_only");
    expect(captured.sources.scope).toEqual(f.scope);
    expect(captured.sources.records.length).toBeGreaterThan(2);
    for (const { entry, storage, origins } of captured.sources.records) {
      const node = captured.graph.storageInventory.nodes.find(
        ({ capture }) =>
          policyEvaluationSourceReferenceKey(capture.read.source) ===
          policyEvaluationSourceReferenceKey(entry.source),
      );
      expect(node).toBeDefined();
      expect(entry.source).toEqual(node?.capture.read.source);
      expect(entry.observation).toEqual(node?.capture.read.observation);
      expect(storage).toEqual(
        node?.capture.storage
          ? {
              recordSha256: node.capture.storage.recordSha256,
              receiptTime: node.capture.storage.receiptTime,
            }
          : null,
      );
      expect(origins.some(({ kind }) => kind === "stored_node")).toBe(true);
    }
    expect(captured.usage.references).toBeGreaterThan(captured.sources.inspectionUsage.references);
    expect(captured.usage.records).toBeGreaterThan(0);
    expect(f.objectReads()).toBe(0);
  });
  it("retains three future-only catalog aliases under actual guards without reading stored-only objects", async () => {
    const f = await fixture(false, true, true, true, true);
    const result = await f.run();
    if (result.status !== "artifacts_captured")
      throw new Error("Expected guarded stored artifacts");
    const captures = result.storedArtifacts.filter(
      ({ read }) => read.reference.artifactId === f.storedReference.artifactId,
    );
    expect(captures).toHaveLength(3);
    for (const { read, origin } of captures) {
      expect(read.observation).toEqual({ status: "content_pending" });
      expect(read.catalog?.metadata).toEqual(f.storedCatalog?.metadata);
      expect(origin.parent.kind).toBe("protocol_definition");
    }
    expect(
      result.artifacts.some(
        ({ read }) => read.reference.artifactId === f.storedReference.artifactId,
      ),
    ).toBe(false);
    expect(f.objectKeysRead).not.toContain(f.storedObjectKey);
    const origins = result.sourceGuards.find(
      ({ kind, id }) => kind === "artifact" && id === f.storedReference.artifactId,
    )?.origins;
    expect(origins).toEqual(
      result.storedArtifacts.flatMap(({ read }, captureIndex) =>
        read.reference.artifactId === f.storedReference.artifactId
          ? [{ kind: "stored_artifact_capture", captureIndex }]
          : [],
      ),
    );
    expect(result.sourceRecheck?.metadata?.storageRecordObservations).toBe(
      result.traceCapture.comparisonCapture.graph.storageInventory.nodes.length,
    );
    expect(result.sourceRecheck?.metadata?.storageEdgeObservations).toBe(
      result.traceCapture.comparisonCapture.graph.storageInventory.edges.length,
    );
    expect(result.sourceRecheck?.observedAt).toMatch(/\.\d{6}Z$/u);
    await f.cleanContext();
  });

  it("rejects an intervening actual future-only catalog tombstone and restores the held pool context", async () => {
    const f = await fixture(false, true, true, true, true);
    let changed = false;
    f.hooks.readContent = async () => {
      if (!changed) {
        changed = true;
        await f.tombstoneStored();
      }
    };
    await expect(f.run()).rejects.toMatchObject({ reason: "source_revision_changed" });
    expect(changed).toBe(true);
    expect(f.objectKeysRead).not.toContain(f.storedObjectKey);
    expect((await catalog.find(f.scope, f.storedReference.artifactId))?.metadata.state).toBe(
      "tombstoned",
    );
    await f.cleanContext();
  });

  it("blocks an actual future-only catalog writer until the complete metadata observation transaction ends", async () => {
    const f = await fixture(false, true, true, true, true);
    let pending: Promise<{ value: unknown } | { error: unknown }> | undefined;
    f.hooks.underGuards = async (ports) => {
      pending = f.tombstoneStored().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await f.waitForWriter();
      expect(await ports.findArtifact(f.storedReference.artifactId)).toMatchObject({
        metadata: { state: "available" },
      });
    };
    try {
      const result = await f.run();
      expect(result.status).toBe("artifacts_captured");
      if (!pending) throw new Error("Writer did not reach the source guard");
      const outcome = await pending;
      if ("error" in outcome) throw outcome.error;
      expect((await catalog.find(f.scope, f.storedReference.artifactId))?.metadata.state).toBe(
        "tombstoned",
      );
      expect(f.objectKeysRead).not.toContain(f.storedObjectKey);
      await f.cleanContext();
    } finally {
      await pending;
    }
  });

  it("reads retained candidate and policy originals through fixed held-client root ports", async () => {
    const f = await fixture(false, true);
    const result = await f.run();
    if (result.status !== "artifacts_captured") throw new Error("Expected retained graph");
    const graph = result.traceCapture.comparisonCapture.graph;
    const candidate = graph.nodes.find(
      ({ read }) => read.source.kind === "release_candidate",
    )?.read;
    if (
      candidate?.source.kind !== "release_candidate" ||
      candidate.observation.status !== "verified"
    )
      throw new Error("Missing exact candidate");
    const candidateVersionId = candidate.source.reference.candidateVersionId;
    const retained = await f.transactions.runMetadata(f.scope, async ({ records }) => {
      const roots = records.logicalRoots;
      if (!roots) throw new Error("Missing held-client root ports");
      const first = await roots.releaseCandidate.findReleaseCandidateLogicalRoot(
        f.scope,
        candidateVersionId,
      );
      expect(first).toEqual(candidate.record);
      if (!first) throw new Error("Missing stored candidate root");
      first.createdByPrincipalId = "mutated_returned_receipt";
      expect(
        await roots.releaseCandidate.findReleaseCandidateLogicalRoot(f.scope, candidateVersionId),
      ).toEqual(candidate.record);
      expect(
        await roots.releasePolicy.findReleasePolicyLogicalRoot(f.scope, f.policy.policyVersionId),
      ).toEqual(f.policy);
      expect(
        await roots.releaseCandidate.findReleaseCandidateLogicalRoot(f.scope, "missing_root_child"),
      ).toBeNull();
      return roots;
    });
    await expect(
      retained.releaseCandidate.findReleaseCandidateLogicalRoot(f.scope, candidateVersionId),
    ).rejects.toThrow("expired");
    for (const field of ["tenantId", "projectId", "environmentId"] as const) {
      await expect(
        f.transactions.runMetadata(f.scope, async ({ records }) => {
          const roots = records.logicalRoots;
          if (!roots) throw new Error("Missing held-client root ports");
          await expect(
            roots.releasePolicy.findReleasePolicyLogicalRoot(
              { ...f.scope, [field]: "foreign_root_scope" },
              f.policy.policyVersionId,
            ),
          ).rejects.toThrow("scope differs");
          return "caught scope violation cannot commit";
        }),
      ).rejects.toThrow("scope differs");
    }
    await f.cleanContext();
  });

  it("reinspects complete protocol candidates and encrypted occurrences under the same native metadata guard", async () => {
    const f = await fixture(false, true, true, true);
    let cuts = 0;
    let authorityReads = 0;
    const available = async (queryScope: typeof f.scope) => {
      expect(queryScope).toEqual(f.scope);
      expect(cuts).toBe(0);
      const unlocked = await withExactScopeTransaction(
        admin,
        f.scope,
        async (client) =>
          (
            await client.query<{ acquired: boolean }>(
              "SELECT public.proofstack_try_lock_policy_evaluation_metadata() AS acquired",
            )
          ).rows[0]?.acquired,
      );
      expect(unlocked).toBe(true);
      authorityReads++;
      return true;
    };
    f.hooks.underGuards = async () => {
      cuts++;
      const locked = await withExactScopeTransaction(
        admin,
        f.scope,
        async (client) =>
          (
            await client.query<{ acquired: boolean }>(
              "SELECT public.proofstack_try_lock_policy_evaluation_metadata() AS acquired",
            )
          ).rows[0]?.acquired,
      );
      expect(locked).toBe(false);
    };
    const result = await f.run({
      revision: { isAvailable: available },
      runtime: { isAvailable: available },
    });
    if (result.status !== "artifacts_captured")
      throw new Error("Expected complete protocol graph report");
    const graph = result.traceCapture.comparisonCapture.graph;
    const beforeAuthority = result.candidateAuthority.beforeArtifacts;
    const afterAuthority = result.candidateAuthority.afterArtifacts;
    if (beforeAuthority.status !== "observed" || afterAuthority.status !== "observed")
      throw new Error("Expected native candidate authority observations");
    expect(afterAuthority.occurrences).toEqual(beforeAuthority.occurrences);
    expect(authorityReads).toBe(
      beforeAuthority.occurrences.length + afterAuthority.occurrences.length,
    );
    expect(authorityReads).toBeGreaterThan(0);
    const edges = graph.edges.filter((e) => e.protocolResolution);
    expect(edges).toHaveLength(4);
    expect(
      edges.map((e) => ({ path: e.reference.path, status: e.protocolResolution?.status })),
    ).toEqual([
      { path: "/interactionCapture/interactions/0/attempts/0/normalizedRequest", status: "unique" },
      { path: "/interactionCapture/interactions/0/attempts/1/normalizedRequest", status: "unique" },
      { path: "/interactionCapture/source/captureAdapter", status: "multiple" },
      { path: "/interactionCapture/source/sourceFormat", status: "unique" },
    ]);
    expect(edges.every((e) => e.target === null)).toBe(true);
    for (const edge of edges)
      expect(graph.recordClosure.frontier).toContainEqual({
        edgeIndex: graph.edges.indexOf(edge),
        kind: "retained_declaration",
      });
    const nodes = graph.nodes.filter((n) => n.read.source.kind === "protocol_definition");
    expect(nodes).toHaveLength(4);
    expect(nodes.filter((n) => n.read.observation.status === "verified")).toHaveLength(3);
    const future = nodes.find((n) => n.read.observation.status === "unavailable");
    expect(future).toMatchObject({
      references: null,
      read: { record: null, observation: { status: "unavailable", reason: "not_yet_available" } },
    });
    expect(result.sourceRecheck).toMatchObject({
      status: "observations_rechecked",
      metadataGuard: true,
    });
    expect(result.sourceRecheck?.observedAt).toMatch(/\.\d{6}Z$/u);
    expect(cuts).toBe(1);
    expect(result.applicability).toMatchObject({
      scope: f.scope,
      authorityBoundary: "retained_prerequisites_only",
      candidate: { source: graph.roots.find((root) => root.kind === "release_candidate") },
      policy: {
        source: graph.roots.find((root) => root.kind === "release_policy"),
        recordSha256: result.policyAuthority.recordSha256,
      },
      lifecycle: result.policyLifecycle.afterArtifacts,
    });
    expect(result.applicability.dimensions.map(({ field }) => field)).toEqual([
      "jurisdiction",
      "locale",
      "maximumDataClassification",
      "populationTags",
      "purpose",
      "riskTier",
      "taskKind",
    ]);
    // This fixture's unavailable installation/source authority cannot be masked by a mismatch.
    expect(result.policyAuthority.requirements.status).toBe("invalid");
    expect(result.applicability.conjunction).toBe("not_evaluated");
    expect(result.applicability.dimensions.every(({ status }) => status === "not_evaluated")).toBe(
      true,
    );
    expect(result.applicability).not.toHaveProperty("outcome");
    expect(result.comparisonRules.candidate).toEqual(result.applicability.candidate);
    expect(result.comparisonRules.policy).toEqual(result.applicability.policy);
    const capturedComparisons = result.traceCapture.comparisonCapture;
    if (capturedComparisons.status !== "inventory_captured")
      throw new Error("Expected complete candidate comparison inventory");
    expect(result.comparisonRules.inventory).toEqual(capturedComparisons.inventory);
    for (const rule of result.comparisonRules.rules) {
      expect(graph.edges[rule.policyEdgeIndex]?.reference.path).toBe(
        `/rules/${rule.ruleIndex}/predicate/comparison`,
      );
      expect(rule.binding.status).toBe("comparison_unusable");
    }
    expect(result.comparisonRules.rules.length).toBeGreaterThan(0);
    expect(result.comparisonRules).not.toHaveProperty("outcome");
    expect(result.assessmentRules.authorityBoundary).toBe("retained_inputs_only");
    expect(result.assessmentRules.candidate).toEqual(result.applicability.candidate);
    expect(result.assessmentRules.policy).toEqual(result.applicability.policy);
    if (graph.policyAssessments.status !== "inspected")
      throw new Error("Expected candidate-owned assessment inventory");
    expect(result.assessmentRules.members).toEqual(graph.policyAssessments.members);
    for (const rule of result.assessmentRules.rules) {
      expect(graph.edges[rule.policyEdgeIndex]?.reference.path).toBe(
        `/rules/${rule.ruleIndex}/predicate/assessment`,
      );
      expect(rule.binding).not.toHaveProperty("outcome");
    }
    expect(result.assessmentRules.rules.length).toBeGreaterThan(0);
    expect(result.assessmentRules).not.toHaveProperty("outcome");
    expect(result.ruleInputs.authorityBoundary).toBe("retained_inputs_only");
    expect(result.ruleInputs.request).toEqual(graph.request);
    expect(result.ruleInputs.scope).toEqual(graph.scope);
    expect(result.ruleInputs.evaluationTime).toBe(graph.evaluationTime);
    expect(result.ruleInputs.candidate).toEqual(result.artifactRules.candidate);
    expect(result.ruleInputs.policy).toEqual(result.artifactRules.policy);
    expect(result.ruleInputs.ruleCount).toBe(result.ruleInputs.rules.length);
    expect(result.ruleInputs.rules.map(({ ruleIndex }) => ruleIndex)).toEqual(
      result.ruleInputs.rules.map((_, index) => index),
    );
    for (const frame of result.ruleInputs.rules) {
      expect(frame).not.toHaveProperty("outcome");
      if (frame.binding.kind === "approval")
        expect(frame.binding).toMatchObject({
          status: "not_evaluated",
          reason: "approval_not_evaluated",
        });
    }
    expect(result.ruleInputs).not.toHaveProperty("outcome");
    expect(PolicyEvaluationSnapshotRuleInputsSchema.parse(result.snapshotRules.inputs)).toEqual(
      result.snapshotRules.inputs,
    );
    expect(result.snapshotRules.inputs.rules.map(({ rule }) => rule)).toEqual(
      result.ruleInputs.rules.map(({ rule }) => rule),
    );
    expect(result.snapshotRules.inputs.request).toEqual(graph.request);
    expect(result.snapshotRules.inputs.scope).toEqual(graph.scope);
    expect(result.snapshotRules.inputs.evaluationTime).toBe(graph.evaluationTime);
    expect(result.snapshotRules.inputs).not.toHaveProperty("sealed");
    expect(result.ruleDependencies).toMatchObject({
      authorityBoundary: "captured_dependencies_only",
      request: graph.request,
      scope: graph.scope,
      evaluationTime: graph.evaluationTime,
      sources: graph.entries,
      frontier: graph.recordClosure.frontier,
    });
    expect(
      result.ruleDependencies.rules.map(({ ruleIndex, ruleId }) => ({ ruleIndex, ruleId })),
    ).toEqual(
      result.ruleInputs.rules.map(({ ruleIndex, rule }) => ({ ruleIndex, ruleId: rule.ruleId })),
    );
    for (const frame of result.ruleDependencies.rules) {
      for (const index of frame.frontierIndexes)
        expect(frame.edgeIndexes).toContain(result.ruleDependencies.frontier[index]?.edgeIndex);
      expect(frame).not.toHaveProperty("outcome");
    }
    expect(result.ruleDependencies).not.toHaveProperty("sealed");
    expect(result.artifactRules.candidate.source).toEqual(
      graph.roots.find((root) => root.kind === "release_candidate"),
    );
    const bundle = result.artifactRules.members[0];
    if (bundle?.status !== "artifact_declared") throw new Error("Missing candidate bundle binding");
    expect(bundle).toMatchObject({
      componentKind: "build_artifact",
      role: "agent_bundle",
      candidatePath: "/buildArtifacts/0/artifact",
      reference: f.reference,
    });
    expect(result.artifacts[bundle.artifactCaptureIndex]).toMatchObject({
      origin: { kind: "record", edgeIndex: bundle.candidateEdgeIndex },
      read: {
        scope: f.scope,
        reference: f.reference,
        observation: {
          status: "verified",
          sha256: f.reference.sha256,
          sizeBytes: f.reference.sizeBytes,
        },
      },
    });
    expect(
      result.artifactRules.rules.find(
        (rule) =>
          rule.predicate.componentKind === "build_artifact" &&
          rule.predicate.role === "agent_bundle",
      )?.binding,
    ).toEqual({ status: "component_present", memberIndex: 0 });
    const verified = result.artifacts.filter((a) => a.read.observation.status === "verified");
    expect(f.objectReads()).toBe(verified.length);
    expect(
      verified.filter((a) => a.read.reference.artifactId === f.reference.artifactId).length,
    ).toBeGreaterThan(5);
    expect(result).not.toHaveProperty("sealed");
    expect(result).not.toHaveProperty("authority");
    await f.cleanContext();
  });

  it("reinspects original model endpoint mappings and configuration on one held metadata client without sealing", async () => {
    const f = await fixture(false, true, true);
    if (!f.endpointProfile || !f.modelFixture) throw new Error("Missing independent model fixture");
    let heldCuts = 0;
    const tryMetadataGuard = () =>
      withExactScopeTransaction(
        admin,
        f.scope,
        async (client) =>
          (
            await client.query<{ acquired: boolean }>(
              "SELECT public.proofstack_try_lock_policy_evaluation_metadata() AS acquired",
            )
          ).rows[0]?.acquired,
      );
    f.hooks.readContent = async () => {
      expect(await tryMetadataGuard()).toBe(true);
    };
    f.hooks.underGuards = async () => {
      heldCuts++;
      expect(await tryMetadataGuard()).toBe(false);
    };
    const result = await f.run();
    if (result.status !== "artifacts_captured") throw new Error("Expected model metadata report");
    const graph = result.traceCapture.comparisonCapture.graph;
    const edges = graph.edges.filter(
      ({ reference }) => reference.kind === "endpoint_profile_selector",
    );
    expect(edges.map(({ reference }) => reference.path)).toEqual([
      "/interactionCapture/interactions/0/attempts/0/provider",
      "/interactionCapture/interactions/0/attempts/1/provider",
    ]);
    const expectedSource = {
      kind: "endpoint_profile",
      reference: {
        endpointProfileId: f.endpointProfile.endpointProfileId,
        endpointProfileVersion: f.endpointProfile.endpointProfileVersion,
        definitionSha256: f.endpointProfile.definitionSha256,
      },
    };
    for (const edge of edges) {
      expect(edge.target).toEqual(expectedSource);
      expect(edge.endpointChecks).toEqual(
        ["provider_name", "operation", "boundary_kind", "configuration"].map((kind) => ({
          kind,
          observation: { status: "matched" },
        })),
      );
      expect(edge.endpointFailure).toBeUndefined();
      expect(graph.recordClosure.frontier).toContainEqual({
        edgeIndex: graph.edges.indexOf(edge),
        kind: "retained_declaration",
      });
    }
    const nodes = graph.nodes.filter(({ read }) => read.source.kind === "endpoint_profile");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.read).toEqual({
      source: expectedSource,
      record: f.endpointProfile,
      observation: {
        status: "verified",
        recordSha256: createHash("sha256")
          .update(encodeEvaluationCanonicalJson(f.endpointProfile))
          .digest("hex"),
      },
    });
    expect(result.sourceRecheck).toMatchObject({
      status: "observations_rechecked",
      metadataGuard: true,
    });
    expect(result.sourceRecheck?.observedAt).toMatch(/\.\d{6}Z$/u);
    expect(heldCuts).toBe(1);
    const retainedArtifacts = result.artifacts.filter(
      ({ read }) => read.observation.status === "verified",
    );
    expect(retainedArtifacts.length).toBeGreaterThan(
      f.modelFixture.interactionCapture.artifacts.length,
    );
    expect(f.objectReads()).toBe(retainedArtifacts.length);
    expect(await tryMetadataGuard()).toBe(true);
    expect(result).not.toHaveProperty("sealed");
    expect(result).not.toHaveProperty("authority");
    await f.cleanContext();
  });

  it("retains independent endpoint profiles across three tenant collisions with exact case-sensitive versions and expiring native ports", async () => {
    const document = JSON.parse(
      readFileSync(
        new URL("../../contracts/vectors/endpoint-profile-v1.json", import.meta.url),
        "utf8",
      ),
    ) as { vectors: { input: { definition: EndpointProfileDefinition } }[] };
    const definition = document.vectors[0]?.input.definition;
    if (!definition) throw new Error("Missing independent endpoint profile vector");
    const records: EndpointProfileRecord[] = [0, 1, 2].map((index) => {
      const scope = {
        tenantId: `tenant_endpoint_${runKey}_${index}`,
        projectId: "project_endpoint",
        environmentId: "environment_endpoint",
      };
      return {
        ...structuredClone(definition),
        scope,
        definitionSha256: digestEndpointProfile(scope, definition),
        schemaVersion: "0.1",
        registeredAt: "2026-09-01T00:00:00.001Z",
        registeredByPrincipalId: "operator_endpoint",
      };
    });
    const originals = structuredClone(records);
    const adapter = new PostgresPolicySourceTransactions(admin, { endpointProfiles: records });
    const first = records[0];
    if (!first) throw new Error("Missing independent endpoint fixture");
    await expect(
      new PostgresPolicySourceTransactions(api, { endpointProfiles: records }).runMetadata(
        first.scope,
        async () => "must not expose guarded ports",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    for (const record of records) {
      record.destination.hostname = "mutated.reference.example";
      record.configuration.sha256 = "0".repeat(64);
      record.operations.length = 0;
    }
    records.length = 0;
    for (const record of originals) {
      let retained: Parameters<Parameters<typeof adapter.runMetadata>[1]>[0] | undefined;
      await adapter.runMetadata(record.scope, async (ports) => {
        retained = ports;
        const reader = ports.records.endpointProfiles;
        if (!reader) throw new Error("Missing guarded endpoint profile port");
        const cut = await ports.sources.observationTime();
        expect(cut).toMatch(/\.\d{6}Z$/u);
        const input = {
          scope: record.scope,
          evaluationTime: cut,
          source: {
            kind: "endpoint_profile" as const,
            reference: {
              endpointProfileId: record.endpointProfileId,
              endpointProfileVersion: record.endpointProfileVersion,
              definitionSha256: record.definitionSha256,
            },
          },
        };
        const read = await readPolicyEvaluationEndpointProfileRecord(input, reader);
        expect(read.observation.status).toBe("verified");
        expect(read.record).toEqual(record);
        if (!read.record) throw new Error("Missing receipt-bearing endpoint");
        read.record.destination.hostname = "output_changed.reference.example";
        read.record.configuration.sha256 = "0".repeat(64);
        await expect(
          reader.findEndpointProfile(
            record.scope,
            record.endpointProfileId,
            record.endpointProfileVersion,
          ),
        ).resolves.toEqual(record);
        await expect(
          reader.findEndpointProfile(
            record.scope,
            record.endpointProfileId,
            record.endpointProfileVersion.toLowerCase(),
          ),
        ).resolves.toBeNull();
        expect(
          (
            await readPolicyEvaluationEndpointProfileRecord(
              { ...input, evaluationTime: "2026-09-01T00:00:00.000999Z" },
              reader,
            )
          ).observation,
        ).toEqual({ status: "unavailable", reason: "not_yet_available" });
      });
      if (!retained?.records.endpointProfiles) throw new Error("Missing retained endpoint port");
      await expect(
        retained.records.endpointProfiles.findEndpointProfile(
          record.scope,
          record.endpointProfileId,
          record.endpointProfileVersion,
        ),
      ).rejects.toThrow("expired");
      await expect(
        adapter.runMetadata(record.scope, async (ports) => {
          const reader = ports.records.endpointProfiles;
          if (!reader) throw new Error("Missing guarded endpoint port");
          await expect(
            reader.findEndpointProfile(
              { ...record.scope, tenantId: "outside_scope" },
              record.endpointProfileId,
              record.endpointProfileVersion,
            ),
          ).rejects.toThrow("scope");
          return "caught scope escape cannot commit";
        }),
      ).rejects.toThrow("scope");
    }
  });

  it("retains exact and ambiguous protocol declarations across three native tenant scopes with expiring guarded ports", async () => {
    const document = JSON.parse(
      readFileSync(
        new URL("../../contracts/vectors/protocol-definition-v1.json", import.meta.url),
        "utf8",
      ),
    ) as {
      vectors: { input: { definition: ProtocolDefinition } }[];
    };
    const definitions = document.vectors.slice(0, 7).map(({ input }) => input.definition);
    expect(definitions).toHaveLength(7);
    const rows: ProtocolDefinitionRecord[] = [0, 1, 2].flatMap((index) => {
      const scope = {
        tenantId: `tenant_protocol_${runKey}_${index}`,
        projectId: "project_protocol",
        environmentId: "environment_protocol",
      };
      return definitions.map((definition) => ({
        ...structuredClone(definition),
        scope,
        definitionSha256: digestProtocolDefinition(scope, definition),
        schemaVersion: "0.1" as const,
        registeredAt: "2026-09-01T00:00:00.001Z",
        registeredByPrincipalId: "operator_protocol",
      }));
    });
    const original = rows[0];
    const firstDefinition = definitions[0];
    if (!original || !firstDefinition) throw new Error("Missing protocol fixture");
    const aliasDefinition = { ...firstDefinition, protocolDefinitionId: "protocol_alias" };
    const alias: ProtocolDefinitionRecord = {
      ...aliasDefinition,
      scope: original.scope,
      definitionSha256: digestProtocolDefinition(original.scope, aliasDefinition),
      schemaVersion: "0.1",
      registeredAt: "2099-01-01T00:00:00.000Z",
      registeredByPrincipalId: "operator_protocol",
    };
    rows.push(alias);
    const retainedRows = structuredClone(rows);
    const adapter = new PostgresPolicySourceTransactions(admin, { protocolDefinitions: rows });
    await expect(
      new PostgresPolicySourceTransactions(api, { protocolDefinitions: rows }).runMetadata(
        original.scope,
        async () => "guard must deny API",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    for (const record of rows) {
      record.specification.sha256 = "0".repeat(64);
      record.descriptor.version = "mutated_input";
    }
    rows.length = 0;
    for (const record of retainedRows) {
      let retained: Parameters<Parameters<typeof adapter.runMetadata>[1]>[0] | undefined;
      const selector = ProtocolDefinitionSelectorSchema.parse({
        family: record.family,
        descriptor: record.descriptor,
      });
      await adapter.runMetadata(record.scope, async (ports) => {
        retained = ports;
        const reader = ports.records.protocolDefinitions;
        if (!reader) throw new Error("Missing native protocol ports");
        const cut = await ports.sources.observationTime();
        expect(cut).toMatch(/\.\d{6}Z$/u);
        const input = {
          scope: record.scope,
          evaluationTime: cut,
          source: {
            kind: "protocol_definition" as const,
            reference: {
              protocolDefinitionId: record.protocolDefinitionId,
              definitionSha256: record.definitionSha256,
            },
          },
        };
        const result = await readPolicyEvaluationProtocolRecord(input, reader);
        if (record.registeredAt.startsWith("2099")) {
          expect(result.observation).toEqual({
            status: "unavailable",
            reason: "not_yet_available",
          });
        } else {
          expect(result.observation.status).toBe("verified");
          expect(result.record).toEqual(record);
          const references = enumeratePolicyEvaluationProtocolReferences(input, result, {
            maxReferences: 3,
            maxReferenceBytes: 10_000,
          }).references;
          expect(references.map(({ path }) => path)).toEqual(
            "implementation" in record
              ? ["/specification", "/implementation", "/configuration"]
              : ["/specification"],
          );
          expect(
            (
              await readPolicyEvaluationProtocolRecord(
                { ...input, evaluationTime: "2026-09-01T00:00:00.000999Z" },
                reader,
              )
            ).observation,
          ).toEqual({ status: "unavailable", reason: "not_yet_available" });
        }
        const matches = (await reader.listProtocolDefinitions(
          record.scope,
          selector,
        )) as ProtocolDefinitionRecord[];
        const expected = retainedRows
          .filter(
            (r) =>
              r.scope.tenantId === record.scope.tenantId &&
              r.family === record.family &&
              JSON.stringify(r.descriptor) === JSON.stringify(record.descriptor),
          )
          .sort((a, b) => (a.protocolDefinitionId < b.protocolDefinitionId ? -1 : 1));
        expect(matches).toEqual(expected);
        const first = matches[0];
        if (!first) throw new Error("Missing retained matches");
        first.specification.sha256 = "f".repeat(64);
        matches.length = 0;
        await expect(reader.listProtocolDefinitions(record.scope, selector)).resolves.toEqual(
          expected,
        );
        await expect(
          reader.findProtocolDefinition(record.scope, "protocol_missing"),
        ).resolves.toBeNull();
        await expect(
          reader.listProtocolDefinitions(
            record.scope,
            ProtocolDefinitionSelectorSchema.parse({
              family: record.family,
              descriptor: {
                ...record.descriptor,
                version: record.descriptor.version.toLowerCase(),
              },
            }),
          ),
        ).resolves.toEqual([]);
      });
      if (!retained?.records.protocolDefinitions) throw new Error("Missing expired protocol ports");
      await expect(
        retained.records.protocolDefinitions.findProtocolDefinition(
          record.scope,
          record.protocolDefinitionId,
        ),
      ).rejects.toThrow("expired");
      await expect(
        retained.records.protocolDefinitions.listProtocolDefinitions(record.scope, selector),
      ).rejects.toThrow("expired");
    }
    const retainedOriginal = retainedRows[0];
    if (!retainedOriginal) throw new Error("Missing original protocol");
    for (const kind of ["scope", "selector"])
      await expect(
        adapter.runMetadata(retainedOriginal.scope, async ({ records }) => {
          const reader = records.protocolDefinitions;
          if (!reader) throw new Error("Missing guarded protocol ports");
          const scope =
            kind === "scope"
              ? { ...retainedOriginal.scope, tenantId: "tenant_outside" }
              : retainedOriginal.scope;
          const selector =
            kind === "selector"
              ? {
                  family: "worker_protocol",
                  descriptor: { name: "wire", version: "v1", extra: true },
                }
              : { family: "worker_protocol", descriptor: { name: "wire", version: "v1" } };
          await reader.listProtocolDefinitions(scope, selector as never).catch(() => undefined);
          return "caught protocol read must still roll back";
        }),
      ).rejects.toThrow();
  });

  it("joins whole runtime parents to missing, unique and ambiguous original protocols on held native metadata ports", async () => {
    const runtimeDocument = JSON.parse(
      readFileSync(
        new URL("../../contracts/vectors/runtime-definition-v1.json", import.meta.url),
        "utf8",
      ),
    ) as {
      vectors: { input: { definition: RuntimeDefinition } }[];
    };
    const runtimeBody = runtimeDocument.vectors
      .map(({ input }) => input.definition)
      .find((d) => d.recordKind === "runtime_adapter");
    const protocolDocument = JSON.parse(
      readFileSync(
        new URL("../../contracts/vectors/protocol-definition-v1.json", import.meta.url),
        "utf8",
      ),
    ) as {
      vectors: { input: { definition: ProtocolDefinition } }[];
    };
    const protocolBody = protocolDocument.vectors
      .map(({ input }) => input.definition)
      .find((d) => d.family === "runtime_protocol");
    if (!runtimeBody || !protocolBody)
      throw new Error("Missing independent runtime/protocol vectors");
    const parents: RuntimeDefinitionRecord[] = [0, 1, 2].map((index) => {
      const scope = {
        tenantId: `tenant_parent_protocol_${runKey}_${index}`,
        projectId: "project_protocol",
        environmentId: "environment_protocol",
      };
      return {
        ...structuredClone(runtimeBody),
        scope,
        definitionSha256: digestRuntimeDefinition(scope, runtimeBody),
        schemaVersion: "0.1",
        registeredAt: "2026-09-01T00:00:00.000Z",
        registeredByPrincipalId: "operator_parent",
      };
    });
    const protocols: ProtocolDefinitionRecord[] = parents.slice(0, 2).map((parent) => {
      const definition = { ...structuredClone(protocolBody), descriptor: runtimeBody.protocol };
      return {
        ...definition,
        scope: parent.scope,
        definitionSha256: digestProtocolDefinition(parent.scope, definition),
        schemaVersion: "0.1",
        registeredAt: "2026-09-01T00:00:00.001Z",
        registeredByPrincipalId: "operator_protocol",
      };
    });
    const first = protocols[0];
    if (!first) throw new Error("Missing retained protocol");
    const {
      scope,
      definitionSha256: _sha,
      schemaVersion: _schema,
      registeredAt: _at,
      registeredByPrincipalId: _by,
      ...firstBody
    } = first;
    const aliasBody = { ...firstBody, protocolDefinitionId: "protocol_future_alias" };
    protocols.push({
      ...aliasBody,
      scope,
      definitionSha256: digestProtocolDefinition(scope, aliasBody),
      schemaVersion: "0.1",
      registeredAt: "2099-01-01T00:00:00.000Z",
      registeredByPrincipalId: "operator_protocol",
    });
    const adapter = new PostgresPolicySourceTransactions(admin, {
      runtimeDefinitions: parents,
      protocolDefinitions: protocols,
    });
    for (const [index, parent] of parents.entries()) {
      if (parent.recordKind !== "runtime_adapter")
        throw new Error("Missing actual runtime adapter");
      const source = {
        kind: "runtime_adapter" as const,
        reference: {
          adapterId: parent.adapterId,
          adapterVersionId: parent.adapterVersionId,
          definitionSha256: parent.definitionSha256,
        },
      };
      let retained: Parameters<Parameters<typeof adapter.runMetadata>[1]>[0] | undefined;
      const captured = await adapter.runMetadata(parent.scope, async (ports) => {
        retained = ports;
        const evaluationTime = await ports.sources.observationTime();
        expect(evaluationTime).toMatch(/\.\d{6}Z$/u);
        const evidence = await readPolicyEvaluationRuntimeRecord(
          { scope: parent.scope, source, evaluationTime },
          ports.records.runtimeDefinitions,
        );
        const input = {
          scope: parent.scope,
          source,
          evaluationTime,
          path: "/protocol",
          limits: { maxReferences: 4, maxReferenceBytes: 10000 },
          replayLimits: { maximumRecords: 2, maximumRecordBytes: 10000 },
        };
        const reader = ports.records.protocolDefinitions;
        if (!reader) throw new Error("Missing protocol ports");
        const result = await readParentProtocolResolution(input, evidence, reader);
        expect(result.status).toBe(["multiple", "unique", "missing"][index]);
        expect(result.parent.source).toEqual(source);
        expect(result.reference.path).toBe("/protocol");
        const expected = protocols
          .filter((p) => p.scope.tenantId === parent.scope.tenantId)
          .sort((a, b) => (a.protocolDefinitionId < b.protocolDefinitionId ? -1 : 1));
        expect(result).toEqual(inspectParentProtocolResolution(input, evidence, expected));
        expect(result.matches).toHaveLength(expected.length);
        for (const member of result.matches) {
          if (member.status !== "retained")
            throw new Error("Expected complete original protocol member");
          expect(member.recordSha256).toBe(
            createHash("sha256").update(encodeEvaluationCanonicalJson(member.record)).digest("hex"),
          );
          expect(member.read.observation.status).toBe(
            member.record.registeredAt.startsWith("2099") ? "unavailable" : "verified",
          );
        }
        return { input, evidence };
      });
      const reader = retained?.records.protocolDefinitions;
      if (!reader) throw new Error("Missing expired protocol ports");
      await expect(
        readParentProtocolResolution(captured.input, captured.evidence, reader),
      ).rejects.toThrow("expired");
    }
  });

  it("retains independent qualification policies across three tenant collisions with original receipts and expiring native ports", async () => {
    const document = JSON.parse(
      readFileSync(
        new URL("../../contracts/vectors/qualification-policy-v1.json", import.meta.url),
        "utf8",
      ),
    ) as { vectors: { input: { definition: QualificationPolicyDefinition } }[] };
    const definition = document.vectors[0]?.input.definition;
    if (!definition) throw new Error("Missing independent qualification policy vector");
    const records: QualificationPolicyRecord[] = [0, 1, 2].map((index) => {
      const scope = {
        tenantId: `tenant_qualification_${runKey}_${index}`,
        projectId: "project_qualification",
        environmentId: "environment_qualification",
      };
      return {
        ...structuredClone(definition),
        scope,
        definitionSha256: digestQualificationPolicy(scope, definition),
        schemaVersion: "0.1",
        publishedAt: "2026-09-01T00:00:00.000Z",
        publishedByPrincipalId: "operator_retained",
      };
    });
    const originals = structuredClone(records);
    const adapter = new PostgresPolicySourceTransactions(admin, { qualificationPolicies: records });
    const first = records[0];
    if (!first) throw new Error("Missing independent operator fixture");
    await expect(
      new PostgresPolicySourceTransactions(api, { qualificationPolicies: records }).runMetadata(
        first.scope,
        async () => "must not expose ports",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    for (const record of records) record.requiredCaseKinds.reverse();
    records.length = 0;
    for (const record of originals) {
      let retained: Parameters<Parameters<typeof adapter.runMetadata>[1]>[0] | undefined;
      await adapter.runMetadata(record.scope, async (ports) => {
        retained = ports;
        const reader = ports.records.qualificationPolicies;
        if (!reader) throw new Error("Missing guarded qualification policy port");
        const cut = await ports.sources.observationTime();
        expect(cut).toMatch(/\.\d{6}Z$/u);
        const read = await readPolicyEvaluationQualificationPolicyRecord(
          {
            scope: record.scope,
            evaluationTime: cut,
            source: {
              kind: "qualification_policy",
              reference: {
                policyId: record.policyId,
                policyVersionId: record.policyVersionId,
                definitionSha256: record.definitionSha256,
              },
            },
          },
          reader,
        );
        expect(read.observation.status).toBe("verified");
        expect(read.record).toEqual(record);
        if (!read.record) throw new Error("Missing original receipt-bearing policy");
        read.record.requiredCaseKinds.reverse();
        await expect(
          reader.findQualificationPolicy(record.scope, record.policyId, record.policyVersionId),
        ).resolves.toEqual(record);
        await expect(
          reader.findQualificationPolicy(record.scope, record.policyId, "missing_version"),
        ).resolves.toBeNull();
      });
      if (!retained?.records.qualificationPolicies) throw new Error("Missing retained policy port");
      await expect(
        retained.records.qualificationPolicies.findQualificationPolicy(
          record.scope,
          record.policyId,
          record.policyVersionId,
        ),
      ).rejects.toThrow("expired");
      await expect(
        adapter.runMetadata(record.scope, async (ports) => {
          const reader = ports.records.qualificationPolicies;
          if (!reader) throw new Error("Missing guarded qualification policy port");
          await expect(
            reader.findQualificationPolicy(
              { ...record.scope, tenantId: "outside_scope" },
              record.policyId,
              record.policyVersionId,
            ),
          ).rejects.toThrow("scope");
          return "caught scope escape cannot commit";
        }),
      ).rejects.toThrow("scope");
    }
  });

  it("retains independent registrations across three tenant collisions and expires every native scoped port", async () => {
    const document = JSON.parse(
      readFileSync(
        new URL(
          "../../contracts/vectors/evaluation-implementation-registration-v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      vectors: { input: { definition: EvaluationImplementationRegistrationDefinition } }[];
    };
    const definition = document.vectors[0]?.input.definition;
    if (!definition) throw new Error("Missing independent registration vector");
    const records: EvaluationImplementationRegistrationRecord[] = [0, 1, 2].map((index) => {
      const scope = {
        tenantId: `tenant_registration_${runKey}_${index}`,
        projectId: "project_registration",
        environmentId: "environment_registration",
      };
      return {
        ...structuredClone(definition),
        scope,
        definitionSha256: digestEvaluationImplementationRegistration(scope, definition),
        schemaVersion: "0.1",
        registeredAt: "2026-09-01T00:00:00.000Z",
        registeredByPrincipalId: "operator_retained",
      };
    });
    const originals = structuredClone(records);
    const adapter = new PostgresPolicySourceTransactions(admin, {
      implementationRegistrations: records,
    });
    const first = records[0];
    if (!first) throw new Error("Missing operator fixture");
    // The private metadata reader guard remains unavailable to runtime API credentials.
    await expect(
      new PostgresPolicySourceTransactions(api, {
        implementationRegistrations: records,
      }).runMetadata(first.scope, async () => "must not expose ports"),
    ).rejects.toMatchObject({ code: "42501" });
    for (const record of records) record.implementation.runtime.version = "input_mutation";
    for (const record of originals) {
      let retained: Parameters<Parameters<typeof adapter.runMetadata>[1]>[0] | undefined;
      await adapter.runMetadata(record.scope, async (ports) => {
        retained = ports;
        const reader = ports.records.implementationRegistrations;
        if (!reader) throw new Error("Missing guarded registration port");
        const cut = await ports.sources.observationTime();
        const read = await readPolicyEvaluationImplementationRecord(
          {
            scope: record.scope,
            evaluationTime: cut,
            source: {
              kind: "evaluation_implementation_registration",
              reference: {
                implementationId: record.implementation.implementationId,
                implementationVersionId: record.implementation.implementationVersionId,
                definitionSha256: record.definitionSha256,
              },
            },
          },
          reader,
        );
        expect(read.observation.status).toBe("verified");
        expect(read.record).toEqual(record);
      });
      if (!retained?.records.implementationRegistrations) throw new Error("Missing retained port");
      await expect(
        retained.records.implementationRegistrations.findEvaluationImplementationRegistration(
          record.scope,
          record.implementation.implementationId,
          record.implementation.implementationVersionId,
        ),
      ).rejects.toThrow("expired");
      await expect(
        adapter.runMetadata(record.scope, async (ports) => {
          const reader = ports.records.implementationRegistrations;
          if (!reader) throw new Error("Missing guarded registration port");
          await expect(
            reader.findEvaluationImplementationRegistration(
              { ...record.scope, projectId: "outside_scope" },
              record.implementation.implementationId,
              record.implementation.implementationVersionId,
            ),
          ).rejects.toThrow("scope");
          return "caught scope escape cannot commit";
        }),
      ).rejects.toThrow("scope");
    }
  });

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
    const stored = result.traceCapture.comparisonCapture.graph.storedRelationships;
    expect(stored.authorityBoundary).toBe("stored_relationships_only");
    expect(stored.datasets).toMatchObject({
      scope: f.scope,
      evaluationTime: result.traceCapture.comparisonCapture.graph.evaluationTime,
    });
    expect(stored.replayPlans).toMatchObject({
      scope: f.scope,
      evaluationTime: result.traceCapture.comparisonCapture.graph.evaluationTime,
    });
    expect(stored.inspectionUsage.references).toBeGreaterThan(0);
    expect(stored).not.toHaveProperty("sealed");
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
    const graph = result.traceCapture.comparisonCapture.graph;
    const stored = graph.storedRelationships;
    expect(stored.evaluationSnapshots.parents.some((p) => p.source.kind === "assessment")).toBe(
      true,
    );
    expect(stored.evaluationReplays.parents.length).toBeGreaterThan(0);
    for (const [part, origins] of [
      [stored.evaluationSnapshots, stored.evaluationSnapshotOrigins],
      [stored.evaluationReplays, stored.evaluationReplayOrigins],
    ] as const) {
      expect(origins).toHaveLength(part.parents.length);
      part.parents.forEach((parent, index) => {
        const origin = origins[index]!;
        const capture = graph.storageInventory.nodes[origin.nodeIndex]!.capture;
        expect(parent).toMatchObject({
          source: capture.read.source,
          recordSha256: capture.storage?.recordSha256,
          receiptTime: capture.storage?.receiptTime,
          recordObservation: capture.read.observation,
        });
        expect(origin.dependencyEdgeIndexes).toEqual(parent.dependencyEdgeIndexes);
      });
    }
    expect(stored).not.toHaveProperty("sealed");
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
