import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ArtifactCipher, LocalArtifactKeyring } from "@proofstack/artifacts";
import { MemoryArtifactObjectStore } from "@proofstack/artifacts/testing";
import {
  type ArtifactMetadata,
  type ContentReference,
  type EndpointProfileDefinition,
  type EndpointProfileRecord,
  type ProtocolDefinition,
  type ProtocolDefinitionRecord,
  ProtocolDefinitionSelectorSchema,
  ProtocolDefinitionSchema,
  type EvaluationImplementationRegistrationDefinition,
  type EvaluationImplementationRegistrationRecord,
  type QualificationPolicyDefinition,
  type QualificationPolicyRecord,
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationRequestDefinition,
  PrincipalContextSchema,
  type RegressionDatasetVersionDefinition,
  type RegressionFixtureVersionDefinition,
  type RecordedInteractionFixtureVersionDefinition,
  type RuntimeDefinition,
  type RuntimeDefinitionRecord,
} from "@proofstack/contracts";
import {
  digestEvaluationRecordDefinition,
  digestEndpointProfile,
  digestProtocolDefinition,
  readPolicyEvaluationProtocolRecord,
  enumeratePolicyEvaluationProtocolReferences,
  readPolicyEvaluationEndpointProfileRecord,
  digestEvaluationImplementationRegistration,
  readPolicyEvaluationImplementationRecord,
  digestQualificationPolicy,
  readPolicyEvaluationQualificationPolicyRecord,
  digestPolicyEvaluationRequestDefinition,
  digestReleaseCandidateDefinition,
  evaluationRecordDescriptors,
  releaseCandidateReference,
  releasePolicyReference,
  StaticEndpointProfileCatalogue,
  digestRuntimeDefinition,
  readPolicyEvaluationRuntimeRecord,
  StaticProtocolDefinitionCatalogue,
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
  digestRecordedInteractionFixtureVersionDefinition,
} from "@proofstack/datasets";
import {
  capturePolicyArtifactEvidence,
  type PolicyArtifactEvidenceRepositories,
  type PolicyCandidateAuthorities,
  type PolicyEvaluationMetadataTransactions,
  type PolicyEvaluationSourceRecheckPorts,
  type PolicyEvaluationSourceTransactions,
  readParentProtocolResolution,
  inspectParentProtocolResolution,
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

async function fixture(
  withCriteria = false,
  metadataMode = false,
  withModelEndpoint = false,
  withProtocols = false,
) {
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
    const alias = { ...body, protocolDefinitionId: `protocol_${namespace}_future` };
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
  const run = (candidateAuthorities?: PolicyCandidateAuthorities) =>
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
        ...(candidateAuthorities ? { candidateAuthorities } : {}),
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
    endpointProfile,
    modelFixture,
    protocolRecords,
    tombstone,
    cleanContext,
    waitForWriter,
    objectReads: () => objectReads,
  };
}

describe("request-owned source recheck on actual PostgreSQL", () => {
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
