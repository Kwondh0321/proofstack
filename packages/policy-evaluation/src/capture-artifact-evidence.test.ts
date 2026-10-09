import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ArtifactCipher,
  ArtifactProtectionError,
  LocalArtifactKeyring,
} from "@proofstack/artifacts";
import {
  MemoryArtifactCatalogRepository,
  MemoryArtifactObjectStore,
} from "@proofstack/artifacts/testing";
import {
  type ArtifactMetadata,
  type ContentReference,
  encodeEvaluationCanonicalJson,
  EvidenceEnvelopeSchema,
  POLICY_EVALUATION_REQUEST_SCHEMA_VERSION,
  type PolicyEvaluationRequest,
  type PolicyEvaluationRequestDefinition,
  PrincipalContextSchema,
  policyEvaluationSourceReferenceKey,
  type ReleaseCandidate,
  type ReleasePolicy,
  type RecordedInteractionFixtureVersionDefinition,
  type RegressionDatasetVersionDefinition,
  type RegressionFixtureVersionDefinition,
} from "@proofstack/contracts";
import {
  digestPolicyEvaluationRequestDefinition,
  digestReleaseCandidateDefinition,
  digestReleasePolicyDefinition,
  type ReleaseCandidateRevisionReference,
  type ReleaseCandidateRuntimeReference,
  releaseCandidateReference,
  releasePolicyReference,
} from "@proofstack/core";
import {
  comparisonFixtureScope,
  MemoryEvidenceRepository,
  MemoryReleaseCandidateRepository,
  MemoryReleasePolicyRepository,
  releaseCandidateFixture,
  releasePolicyLifecycleFixture,
  releasePolicyRepositoryFixture,
} from "@proofstack/core/testing";
import {
  digestRecordedInteractionFixtureVersionDefinition,
  digestRegressionDatasetVersionDefinition,
  digestRegressionFixtureVersionDefinition,
} from "@proofstack/datasets";
import { MemoryRegressionVersionRepository } from "@proofstack/datasets/testing";
import { describe, expect, it, vi } from "vitest";
import {
  capturePolicyArtifactEvidence,
  type PolicyArtifactEvidenceRepositories,
} from "./capture-artifact-evidence.js";
import { inspectCapturedFixtureBindings } from "./capture-fixture-bindings.js";
import { inspectCapturedArtifactRules } from "./capture-artifact-rules.js";
import {
  observeCapturedCandidateAuthority,
  type PolicyCandidateAuthorities,
} from "./capture-candidate-authority.js";
import { AcquisitionBudget } from "./acquisition-budget.js";
import * as publicApi from "./index.js";
import type { PolicyEvaluationMetadataTransactions } from "./metadata-transactions.js";
import type {
  PolicyEvaluationSourceRecheckPorts,
  PolicyEvaluationSourceTransactions,
} from "./recheck-captured-sources.js";
import type { PolicyRecordGraphRepositories } from "./record-routing.js";

const scope = comparisonFixtureScope("artifact_graph");
const traceId = "0123456789abcdef0123456789abcdef";
const createdAt = "2026-09-04T00:00:00.000Z";
const observedAt = "2026-10-01T02:00:00.000Z";
const content = Buffer.from("exact graph and trace artifact");
const reference: ContentReference = {
  artifactId: "artifact_shared",
  classification: "confidential",
  mediaType: "text/plain",
  sha256: createHash("sha256").update(content).digest("hex"),
  sizeBytes: content.byteLength,
};

function withLimits(
  request: PolicyEvaluationRequest,
  changes: Partial<PolicyEvaluationRequest["limits"]>,
) {
  const {
    createdAt,
    createdByPrincipalId,
    definitionSha256: _hash,
    schemaVersion,
    scope,
    ...definition
  } = request;
  const body = { ...definition, limits: { ...definition.limits, ...changes } };
  return {
    ...body,
    createdAt,
    createdByPrincipalId,
    schemaVersion,
    scope,
    definitionSha256: digestPolicyEvaluationRequestDefinition(scope, body),
  };
}

async function harness(
  recorded = false,
  eventCount = 1,
  changes: {
    mutateCandidate?(candidate: ReleaseCandidate): void;
    mutatePolicy?(policy: ReleasePolicy): void;
    predecessor?: ReleaseCandidate;
  } = {},
) {
  const datasets = new MemoryRegressionVersionRepository();
  const eventIds = Array.from({ length: eventCount }, (_, i) =>
    i === 0 ? "event_artifact" : `event_artifact_${i}`,
  );
  const fixtureDefinition: RegressionFixtureVersionDefinition = {
    fixtureId: "fixture_artifact",
    fixtureVersionId: "fixture_artifact_v1",
    name: "Artifact trace",
    replayability: "evidence_only",
    schemaVersion: "0.1",
    scope,
    source: {
      kind: "trace_snapshot",
      traceId,
      eventIds,
      observedEventCount: eventIds.length,
      sourceCompleteness: "observed_snapshot",
    },
  };
  const fixture = {
    ...fixtureDefinition,
    source: { ...fixtureDefinition.source, capturedAt: "2026-09-05T00:00:00.000Z" },
    createdAt: "2026-09-05T00:00:00.000Z",
    createdByPrincipalId: "principal_fixture",
    definitionSha256: digestRegressionFixtureVersionDefinition(fixtureDefinition),
  };
  await datasets.publishFixtureVersion(fixture);
  let selectedFixture = {
    fixtureId: fixture.fixtureId,
    fixtureVersionId: fixture.fixtureVersionId,
    definitionSha256: fixture.definitionSha256,
  };
  const fixtureContents = new Map<string, Buffer>();
  const fixtureMetadata: ArtifactMetadata[] = [];
  let recordedPublication:
    | Awaited<ReturnType<typeof datasets.publishRecordedInteractionFixtureVersion>>
    | undefined;
  if (recorded) {
    const vector = JSON.parse(
      readFileSync(
        new URL("../../datasets/vectors/interaction-fixture-definition-v2.json", import.meta.url),
        "utf8",
      ),
    ) as { vectors: { input: RecordedInteractionFixtureVersionDefinition }[] };
    const definition = structuredClone(
      vector.vectors[0]?.input,
    ) as RecordedInteractionFixtureVersionDefinition;
    definition.scope = scope;
    definition.fixtureId = fixture.fixtureId;
    definition.fixtureVersionId = "fixture_artifact_v2";
    definition.predecessor = {
      fixtureVersionId: fixture.fixtureVersionId,
      definitionSha256: fixture.definitionSha256,
    };
    definition.source = structuredClone(fixtureDefinition.source);
    for (const binding of definition.interactionCapture.artifacts) {
      const bytes = Buffer.from(
        JSON.stringify({ artifactId: binding.contentReference.artifactId, captured: true }),
      );
      fixtureContents.set(binding.contentReference.artifactId, bytes);
      binding.contentReference.sha256 = createHash("sha256").update(bytes).digest("hex");
      binding.contentReference.sizeBytes = bytes.byteLength;
      const metadata: ArtifactMetadata = {
        schemaVersion: "0.1",
        scope,
        createdAt,
        availableAt: "2026-09-04T00:01:00.000Z",
        state: "available",
        contentReference: binding.contentReference,
        redaction: binding.redaction,
        retention: binding.retention,
      };
      fixtureMetadata.push(metadata);
      datasets.seedInteractionArtifact(metadata);
    }
    for (const interaction of definition.interactionCapture.interactions) {
      for (const attempt of interaction.attempts)
        attempt.normalizedRequest.sha256 = createHash("sha256")
          .update(fixtureContents.get(attempt.normalizedRequest.artifactId) as Buffer)
          .digest("hex");
      if (interaction.kind === "model")
        interaction.prompt.definitionSha256 = createHash("sha256")
          .update(fixtureContents.get(interaction.prompt.artifactId) as Buffer)
          .digest("hex");
    }
    recordedPublication = await datasets.publishRecordedInteractionFixtureVersion({
      ...definition,
      source: structuredClone(fixture.source),
      createdAt: "2026-09-06T00:00:00.000Z",
      createdByPrincipalId: "principal_fixture",
      definitionSha256: digestRecordedInteractionFixtureVersionDefinition(definition),
    });
    selectedFixture = {
      fixtureId: recordedPublication.version.fixtureId,
      fixtureVersionId: recordedPublication.version.fixtureVersionId,
      definitionSha256: recordedPublication.version.definitionSha256,
    };
  }
  const datasetDefinition: RegressionDatasetVersionDefinition = {
    datasetId: "dataset_artifact",
    datasetVersionId: "dataset_artifact_v1",
    name: "Artifact dataset",
    scope,
    schemaVersion: "0.1",
    fixtureVersions: [
      {
        fixtureId: selectedFixture.fixtureId,
        fixtureVersionId: selectedFixture.fixtureVersionId,
        definitionSha256: selectedFixture.definitionSha256,
      },
    ],
  };
  const dataset = {
    ...datasetDefinition,
    createdAt: "2026-09-07T00:00:00.000Z",
    createdByPrincipalId: "principal_dataset",
    definitionSha256: digestRegressionDatasetVersionDefinition(datasetDefinition),
  };
  await datasets.publishDatasetVersion(dataset);
  const candidate = releaseCandidateFixture("artifact_graph", scope);
  const build = candidate.buildArtifacts[0];
  if (!build) throw new Error("Expected candidate artifact fixture");
  build.artifact = structuredClone(reference);
  candidate.datasets = [
    {
      datasetId: dataset.datasetId,
      datasetVersionId: dataset.datasetVersionId,
      definitionSha256: dataset.definitionSha256,
    },
  ];
  changes.mutateCandidate?.(candidate);
  const {
    createdAt: _at,
    createdByPrincipalId: _by,
    schemaVersion: _version,
    scope: _scope,
    definitionSha256: _hash,
    ...candidateDefinition
  } = candidate;
  candidate.definitionSha256 = digestReleaseCandidateDefinition(scope, candidateDefinition);
  const policy = releasePolicyRepositoryFixture("artifact_graph", scope);
  changes.mutatePolicy?.(policy);
  const {
    publishedAt: _policyAt,
    publishedByPrincipalId: _policyBy,
    schemaVersion: _policyVersion,
    scope: _policyScope,
    definitionSha256: _policyHash,
    ...policyDefinition
  } = policy;
  policy.definitionSha256 = digestReleasePolicyDefinition(scope, policyDefinition);
  const candidates = new MemoryReleaseCandidateRepository();
  const policies = new MemoryReleasePolicyRepository();
  if (changes.predecessor) await candidates.publishReleaseCandidate(changes.predecessor);
  await candidates.publishReleaseCandidate(candidate);
  await policies.publishReleasePolicy(policy);
  const absent = new Proxy({}, { get: () => async () => null });
  const repositories = {
    control: {
      comparison: absent,
      installationBinding: absent,
      releaseCandidate: candidates,
      releasePolicy: policies,
    },
    evidence: { evaluation: absent, modelAssurance: absent },
    datasets,
    replayDefinitions: absent,
    replayResults: absent,
    runtimeDefinitions: absent,
  } as unknown as PolicyArtifactEvidenceRepositories;
  const definition: PolicyEvaluationRequestDefinition = {
    algorithm: { id: "proofstack.deterministic-policy", version: "1.0.0" },
    evaluationRequestId: "request_artifact",
    evaluationTime: "2026-10-01T00:00:00.000Z",
    candidate: releaseCandidateReference(candidate),
    policy: releasePolicyReference(policy),
    limits: {
      heartbeatIntervalMilliseconds: 1000,
      leaseDurationMilliseconds: 5000,
      maxAcquisitionRecordBytes: 8_388_608,
      maxAcquisitionRecords: 10000,
      maxArtifactReadBytes: 1_048_576,
      maxAttempts: 2,
      maxRuleEvaluations: 256,
      perAttemptTimeoutMilliseconds: 20000,
      retryBackoffMilliseconds: 100,
      retryableErrors: ["source_revision_changed"],
      totalDeadlineMilliseconds: 60000,
    },
  };
  const request: PolicyEvaluationRequest = {
    ...definition,
    schemaVersion: POLICY_EVALUATION_REQUEST_SCHEMA_VERSION,
    scope: structuredClone(scope),
    createdAt: "2026-10-01T01:00:00.000Z",
    createdByPrincipalId: "principal_request",
    definitionSha256: digestPolicyEvaluationRequestDefinition(scope, definition),
  };
  const actor = PrincipalContextSchema.parse({
    authentication: { authenticatedAt: createdAt, method: "development" },
    capabilities: ["artifact:read"],
    principalId: "principal_capture",
    principalType: "service",
    requestId: "request_capture",
    resourceScope: { mode: "tenant" },
    roles: ["viewer"],
    tenantId: scope.tenantId,
  });
  const evidence = new MemoryEvidenceRepository();
  const event = EvidenceEnvelopeSchema.parse({
    schemaVersion: "0.1",
    scope,
    receivedAt: createdAt,
    evidence: {
      eventId: "event_artifact",
      traceId,
      spanId: "0123456789abcdef",
      startedAt: createdAt,
      kind: "agent.run",
      name: "Artifact event",
      contentReferences: [reference, reference],
      source: { sdkName: "fixture", sdkVersion: "1.0.0", serviceName: "artifact_test" },
    },
  });
  const events = eventIds.map((eventId, i) =>
    i === 0
      ? event
      : EvidenceEnvelopeSchema.parse({
          ...event,
          evidence: { ...event.evidence, eventId, spanId: i.toString(16).padStart(16, "0") },
        }),
  );
  await evidence.append(events);
  const catalog = new MemoryArtifactCatalogRepository();
  const objects = new MemoryArtifactObjectStore();
  const keyring = new LocalArtifactKeyring({
    activeKeyId: "key_capture",
    keys: { key_capture: new Uint8Array(32).fill(7) },
  });
  const encryption = new ArtifactCipher(keyring);
  const metadata: ArtifactMetadata = {
    schemaVersion: "0.1",
    scope,
    createdAt,
    state: "reserved",
    contentReference: { ...reference },
    redaction: { status: "not_required" },
    retention: { mode: "expire", expiresAt: "2026-10-02T00:00:00.000Z" },
  };
  const reserved = {
    metadata,
    createdByPrincipalId: "principal_writer",
    objectKey: "objects/v1/shared",
    encryption: await encryption.createPlan(metadata),
  };
  await catalog.reserve(reserved);
  const encrypted = await encryption.encrypt(metadata, reserved.encryption, content);
  await objects.putIfAbsent(reserved.objectKey, encrypted.bytes);
  const active = await catalog.activate(
    scope,
    reference.artifactId,
    encrypted.receipt,
    "2026-09-04T00:01:00.000Z",
  );
  for (const published of fixtureMetadata) {
    const { availableAt: _available, ...reservedFields } = published;
    const metadata: ArtifactMetadata = { ...reservedFields, state: "reserved" };
    const plan = await encryption.createPlan(metadata);
    const objectKey = `objects/v1/${metadata.contentReference.artifactId}`;
    await catalog.reserve({
      metadata,
      encryption: plan,
      objectKey,
      createdByPrincipalId: "principal_writer",
    });
    const encrypted = await encryption.encrypt(
      metadata,
      plan,
      fixtureContents.get(metadata.contentReference.artifactId) as Buffer,
    );
    await objects.putIfAbsent(objectKey, encrypted.bytes);
    await catalog.activate(
      scope,
      metadata.contentReference.artifactId,
      encrypted.receipt,
      published.availableAt as string,
    );
  }
  // The separate memory adapters deliberately need this test-only coordinated-state bridge.
  // The production coordinated PostgreSQL transaction is not being simulated or claimed here.
  for (const ownership of recordedPublication?.ownerships ?? [])
    catalog.claimFixtureOwnershipForTesting(ownership);
  const find = vi.spyOn(catalog, "find");
  const get = vi.spyOn(objects, "get");
  const decrypt = vi.spyOn(encryption, "decrypt");
  const exact = vi.spyOn(evidence, "resolveExactEvents");
  const root = vi.spyOn(candidates, "findReleaseCandidate");
  const clock = { now: vi.fn(() => new Date(observedAt)) };
  const dependencies = { catalog, objects, encryption, clock };
  const execute = (input = request) =>
    capturePolicyArtifactEvidence(input, actor, repositories, evidence, dependencies);
  return {
    request,
    events,
    actor,
    repositories,
    evidence,
    dependencies,
    execute,
    find,
    get,
    decrypt,
    exact,
    root,
    clock,
    active,
    catalog,
    encrypted,
    keyring,
    event,
    candidate,
    policy,
    policies,
    recordedPublication,
    fixtureContents,
    fixture,
    fixtureDefinition,
  };
}

describe("candidate external-authority capture", () => {
  async function setup(changes: Parameters<typeof harness>[2] = {}) {
    const h = await harness(false, 1, changes);
    const revision = vi.fn(
      async (_scope: ReleaseCandidate["scope"], _subject: ReleaseCandidateRevisionReference) =>
        true,
    );
    const runtime = vi.fn(
      async (_scope: ReleaseCandidate["scope"], _subject: ReleaseCandidateRuntimeReference) => true,
    );
    const authorities: PolicyCandidateAuthorities = {
      revision: { isAvailable: revision },
      runtime: { isAvailable: runtime },
    };
    const run = (ports = authorities, input = h.request) =>
      capturePolicyArtifactEvidence(input, h.actor, h.repositories, h.evidence, {
        ...h.dependencies,
        candidateAuthorities: ports,
      });
    return { h, revision, runtime, authorities, run };
  }

  it("retains explicit unconfigured authority without adding reads or inspection costs", async () => {
    const { h, run, revision, runtime } = await setup();
    const ordinary = await h.execute();
    const empty = await run({});
    expect(empty.usage).toEqual(ordinary.usage);
    if (empty.status !== "artifacts_captured") throw new Error("Expected capture");
    expect(empty.candidateAuthority).toEqual({
      beforeArtifacts: { status: "not_configured" },
      afterArtifacts: { status: "not_configured" },
    });
    expect(revision).not.toHaveBeenCalled();
    expect(runtime).not.toHaveBeenCalled();
    expect(publicApi).not.toHaveProperty("observeCapturedCandidateAuthority");
  });

  it("preserves every candidate predecessor origin and bounds cumulative parent inspection before I/O", async () => {
    const previous = releaseCandidateFixture("artifact_graph", scope, {
      candidateVersionId: "candidate_artifact_graph_previous",
    });
    previous.createdAt = "2026-09-05T00:00:00.000Z";
    const { h, run, authorities, revision, runtime } = await setup({
      predecessor: previous,
      mutateCandidate(candidate) {
        candidate.predecessor = releaseCandidateReference(previous);
      },
    });
    const output = await run();
    if (output.status !== "artifacts_captured") throw new Error("Expected capture");
    const before = output.candidateAuthority.beforeArtifacts;
    if (before.status !== "observed") throw new Error("Expected observations");
    expect(
      new Set(before.occurrences.map((origin) => origin.parent.reference.candidateVersionId)),
    ).toEqual(new Set([h.candidate.candidateVersionId, previous.candidateVersionId]));
    expect(revision).toHaveBeenCalledTimes(4);
    const graph = output.traceCapture.comparisonCapture.graph;
    const parents = graph.nodes
      .filter((node) => node.read.source.kind === "release_candidate")
      .map((node) => node.references ?? []);
    expect(parents).toHaveLength(2);
    const count = parents.reduce((total, refs) => total + refs.length, 0);
    const bytes = parents
      .flat()
      .reduce((total, ref) => total + encodeEvaluationCanonicalJson(ref).byteLength, 0);
    for (const limits of [
      { maxReferences: count - 1, maxReferenceBytes: h.request.limits.maxAcquisitionRecordBytes },
      { maxReferences: h.request.limits.maxAcquisitionRecords, maxReferenceBytes: bytes - 1 },
    ]) {
      revision.mockClear();
      runtime.mockClear();
      await expect(
        observeCapturedCandidateAuthority(
          h.request,
          graph,
          authorities,
          h.clock,
          new AcquisitionBudget(h.request.limits),
          limits,
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(revision).not.toHaveBeenCalled();
      expect(runtime).not.toHaveBeenCalled();
    }
  });

  it("binds every original Git, model and adapter occurrence to the exact candidate and owned edge", async () => {
    const { h, run, revision, runtime } = await setup();
    const output = await run();
    if (output.status !== "artifacts_captured") throw new Error("Expected capture");
    const before = output.candidateAuthority.beforeArtifacts;
    const after = output.candidateAuthority.afterArtifacts;
    if (before.status !== "observed" || after.status !== "observed")
      throw new Error("Expected authority observations");
    const models = h.candidate.runtimeComponents.filter((component) => component.kind === "model");
    expect(models.length).toBeGreaterThan(0);
    expect(before.occurrences.map((origin) => origin.subject.kind)).toEqual([
      "source_revision",
      ...models.flatMap(() => ["model_declaration", "runtime_adapter"]),
    ]);
    expect(after.occurrences).toEqual(before.occurrences);
    expect(before.occurrences.every((origin) => origin.availability === "available")).toBe(true);
    for (const origin of before.occurrences) {
      const edge = output.traceCapture.comparisonCapture.graph.edges[origin.edgeIndex];
      expect(edge?.parent).toEqual(origin.parent);
      expect(edge?.parentRecordSha256).toBe(origin.parentRecordSha256);
      expect(edge?.reference.path).toBe(origin.path);
    }
    expect(revision).toHaveBeenCalledTimes(2);
    expect(revision).toHaveBeenCalledWith(h.request.scope, {
      kind: "source_revision",
      source: h.candidate.source,
    });
    expect(runtime).toHaveBeenCalledTimes(models.length * 4);
    expect(before).not.toHaveProperty("outcome");
  });

  it("preserves negative and partially configured authority without inventing absence", async () => {
    const { run, revision } = await setup();
    revision.mockResolvedValue(false);
    const output = await run({ revision: { isAvailable: revision } });
    if (output.status !== "artifacts_captured") throw new Error("Expected capture");
    const observation = output.candidateAuthority.beforeArtifacts;
    if (observation.status !== "observed") throw new Error("Expected observation");
    expect(observation.occurrences[0]?.availability).toBe("not_verified");
    expect(
      observation.occurrences.slice(1).every((origin) => origin.availability === "not_configured"),
    ).toBe(true);
    expect(revision).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, 1, "true", {}, []])(
    "rejects non-boolean authority: %s",
    async (value) => {
      const { h, run, revision } = await setup();
      revision.mockResolvedValue(value as never);
      await expect(run()).rejects.toBeInstanceOf(Error);
      expect(h.get).not.toHaveBeenCalled();
      expect(h.decrypt).not.toHaveBeenCalled();
    },
  );

  it("propagates authority storage failures before content I/O", async () => {
    const { h, run, revision } = await setup();
    const failure = new Error("Authority read failed");
    revision.mockRejectedValue(failure);
    await expect(run()).rejects.toBe(failure);
    expect(h.get).not.toHaveBeenCalled();
  });

  it.each([
    [true, false],
    [false, true],
  ])("rejects changed authority %s to %s across content", async (before, after) => {
    const { h, run, revision } = await setup();
    revision.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    await expect(run()).rejects.toMatchObject({ reason: "source_revision_changed" });
    expect(h.get).toHaveBeenCalled();
    expect(revision).toHaveBeenCalledTimes(2);
  });

  it("owns exact query copies despite authority-side mutation", async () => {
    const { h, run, revision, runtime } = await setup();
    const original = structuredClone(h.candidate);
    revision.mockImplementation(async (queryScope, subject) => {
      queryScope.tenantId = "substituted_scope";
      subject.source.commit.value = "f".repeat(subject.source.commit.value.length);
      return true;
    });
    runtime.mockImplementation(async (queryScope, subject) => {
      queryScope.projectId = "substituted_project";
      Reflect.set(subject, "role", "substituted_role");
      return true;
    });
    const output = await run();
    if (output.status !== "artifacts_captured") throw new Error("Expected capture");
    const before = output.candidateAuthority.beforeArtifacts;
    const after = output.candidateAuthority.afterArtifacts;
    if (before.status !== "observed" || after.status !== "observed")
      throw new Error("Expected observations");
    expect(before.occurrences[0]?.subject).toEqual({
      kind: "source_revision",
      source: original.source,
    });
    expect(after.occurrences).toEqual(before.occurrences);
    expect(h.candidate).toEqual(original);
  });

  it.each([
    "scope",
    "time",
    "roots",
    "body",
    "receipt",
    "node_duplicate",
    "references",
    "edge_missing",
    "edge_duplicate",
    "edge_hash",
    "edge_target",
    "edge_subject",
  ])("rejects authority provenance substitution before I/O: %s", async (fault) => {
    const { h, authorities, revision, runtime } = await setup();
    const captured = await h.execute();
    const graph = structuredClone(captured.traceCapture.comparisonCapture.graph);
    const node = graph.nodes.find((node) => node.read.source.kind === "release_candidate");
    const edge = graph.edges.find(
      (edge) => edge.parent.kind === "release_candidate" && edge.reference.path === "/source",
    );
    if (!node || !edge) throw new Error("Missing original candidate provenance");
    if (fault === "scope") graph.scope.projectId = "substituted_project";
    if (fault === "time") Reflect.set(graph, "evaluationTime", "2026-10-01T00:00:00.001Z");
    if (fault === "roots") Reflect.set(graph, "roots", []);
    if (fault === "body") (node.read.record as ReleaseCandidate).name += " changed";
    if (fault === "receipt")
      (node.read.record as ReleaseCandidate).createdByPrincipalId = "substituted_principal";
    if (fault === "node_duplicate")
      Reflect.set(graph, "nodes", [...graph.nodes, structuredClone(node)]);
    if (fault === "references") Reflect.set(node, "references", []);
    if (fault === "edge_missing")
      Reflect.set(
        graph,
        "edges",
        graph.edges.filter((item) => item !== edge),
      );
    if (fault === "edge_duplicate")
      Reflect.set(graph, "edges", [...graph.edges, structuredClone(edge)]);
    if (fault === "edge_hash") Reflect.set(edge, "parentRecordSha256", "f".repeat(64));
    if (fault === "edge_target") Reflect.set(edge, "target", node.read.source);
    if (
      fault === "edge_subject" &&
      edge.reference.kind === "control_declaration" &&
      edge.reference.declaration.kind === "candidate_source"
    )
      edge.reference.declaration.reference.commit.value = "f".repeat(40);
    await expect(
      observeCapturedCandidateAuthority(
        h.request,
        graph,
        authorities,
        h.clock,
        new AcquisitionBudget(h.request.limits),
        {
          maxReferences: h.request.limits.maxAcquisitionRecords,
          maxReferenceBytes: h.request.limits.maxAcquisitionRecordBytes,
        },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(revision).not.toHaveBeenCalled();
    expect(runtime).not.toHaveBeenCalled();
  });

  it("shares invocation limits across both authority phases and preserves exact/one-below admission", async () => {
    const first = await setup();
    const baseline = await first.run();
    const limits = {
      maxAcquisitionRecords: baseline.usage.references,
      maxAcquisitionRecordBytes: baseline.usage.bytes + baseline.usage.referenceBytes,
    };
    const exact = await setup();
    expect((await exact.run(exact.authorities, withLimits(exact.h.request, limits))).usage).toEqual(
      baseline.usage,
    );
    const fewer = await setup();
    await expect(
      fewer.run(
        fewer.authorities,
        withLimits(fewer.h.request, {
          ...limits,
          maxAcquisitionRecords: limits.maxAcquisitionRecords - 1,
        }),
      ),
    ).rejects.toMatchObject({ reason: "reference_limit" });
    const smaller = await setup();
    await expect(
      smaller.run(
        smaller.authorities,
        withLimits(smaller.h.request, {
          ...limits,
          maxAcquisitionRecordBytes: limits.maxAcquisitionRecordBytes - 1,
        }),
      ),
    ).rejects.toMatchObject({ reason: "byte_limit" });
  });

  it("retains unavailable candidate parents without fabricating external subjects", async () => {
    const { h, authorities, revision, runtime } = await setup();
    const captured = await h.execute();
    const graph = structuredClone(captured.traceCapture.comparisonCapture.graph);
    const node = graph.nodes.find((node) => node.read.source.kind === "release_candidate");
    if (!node) throw new Error("Missing candidate");
    Reflect.set(node.read, "observation", { status: "missing" });
    Reflect.set(node.read, "record", null);
    Reflect.set(node, "references", null);
    const observed = await observeCapturedCandidateAuthority(
      h.request,
      graph,
      authorities,
      h.clock,
      new AcquisitionBudget(h.request.limits),
      {
        maxReferences: h.request.limits.maxAcquisitionRecords,
        maxReferenceBytes: h.request.limits.maxAcquisitionRecordBytes,
      },
    );
    if (observed.status !== "observed") throw new Error("Expected explicit observation");
    expect(observed.occurrences).toEqual([]);
    expect(observed.unavailableParents).toEqual([
      { source: node.read.source, observation: { status: "missing" } },
    ]);
    expect(revision).not.toHaveBeenCalled();
    expect(runtime).not.toHaveBeenCalled();
  });

  it("does not call candidate authority for an unavailable request root", async () => {
    const { h, run, revision, runtime } = await setup();
    h.root.mockResolvedValue(null);
    expect((await run()).status).toBe("roots_unavailable");
    expect(revision).not.toHaveBeenCalled();
    expect(runtime).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
  });

  it("rejects absent candidate nodes rather than returning an empty authority report", async () => {
    const { h, authorities, revision } = await setup();
    const captured = await h.execute();
    const graph = structuredClone(captured.traceCapture.comparisonCapture.graph);
    Reflect.set(
      graph,
      "nodes",
      graph.nodes.filter((node) => node.read.source.kind !== "release_candidate"),
    );
    await expect(
      observeCapturedCandidateAuthority(
        h.request,
        graph,
        authorities,
        h.clock,
        new AcquisitionBudget(h.request.limits),
        {
          maxReferences: h.request.limits.maxAcquisitionRecords,
          maxReferenceBytes: h.request.limits.maxAcquisitionRecordBytes,
        },
      ),
    ).rejects.toMatchObject({ reason: "observation_conflict" });
    expect(revision).not.toHaveBeenCalled();
  });

  it("independently admits complete parent and original authority frames at exact and one-below limits", async () => {
    const { h, authorities, revision, runtime } = await setup();
    const captured = await h.execute();
    const graph = captured.traceCapture.comparisonCapture.graph;
    const parents = graph.nodes
      .filter((node) => node.read.source.kind === "release_candidate")
      .flatMap((node) => node.references ?? []);
    const external = graph.edges
      .filter(
        (edge) =>
          edge.parent.kind === "release_candidate" &&
          ((edge.reference.kind === "control_declaration" &&
            ["candidate_source", "model_declaration"].includes(edge.reference.declaration.kind)) ||
            (edge.reference.kind === "record" && edge.reference.source.kind === "runtime_adapter")),
      )
      .map((edge) => edge.reference);
    const byteSize = (frames: typeof parents) =>
      frames.reduce((total, frame) => total + encodeEvaluationCanonicalJson(frame).byteLength, 0);
    const limits = {
      maxReferences: parents.length + external.length,
      maxReferenceBytes: byteSize([...parents, ...external]),
    };
    const inspect = (bounded = limits) =>
      observeCapturedCandidateAuthority(
        h.request,
        graph,
        authorities,
        h.clock,
        new AcquisitionBudget(h.request.limits),
        bounded,
      );
    const exact = await inspect();
    if (exact.status !== "observed") throw new Error("Expected observation");
    expect(exact.inspectionUsage).toEqual({
      references: limits.maxReferences,
      referenceBytes: limits.maxReferenceBytes,
    });
    for (const [bounded, reason] of [
      [{ ...limits, maxReferences: limits.maxReferences - 1 }, "reference_limit_exceeded"],
      [{ ...limits, maxReferenceBytes: limits.maxReferenceBytes - 1 }, "reference_bytes_exceeded"],
      [{ ...limits, maxReferences: parents.length - 1 }, "reference_limit_exceeded"],
      [{ ...limits, maxReferenceBytes: byteSize(parents) - 1 }, "reference_bytes_exceeded"],
    ] as const) {
      revision.mockClear();
      runtime.mockClear();
      await expect(inspect(bounded)).rejects.toMatchObject({ reason });
      expect(revision).not.toHaveBeenCalled();
      expect(runtime).not.toHaveBeenCalled();
    }
  });

  it("performs every external-authority read before acquiring the metadata guards", async () => {
    const f = await metadataRecheckHarness();
    const available = vi.fn(
      async (
        queryScope: ReleaseCandidate["scope"],
        subject: ReleaseCandidateRevisionReference | ReleaseCandidateRuntimeReference,
      ) => {
        expect(f.state.phase).toBe("outside");
        expect(queryScope).toEqual(f.h.request.scope);
        f.calls.push(`authority:${subject.kind}`);
        return true;
      },
    );
    const output = await capturePolicyArtifactEvidence(
      f.h.request,
      f.h.actor,
      f.h.repositories,
      f.h.evidence,
      {
        ...f.h.dependencies,
        metadataTransactions: f.metadataTransactions,
        candidateAuthorities: {
          revision: { isAvailable: available },
          runtime: { isAvailable: available },
        },
      },
    );
    expect(available).toHaveBeenCalled();
    const begin = f.calls.indexOf("begin");
    expect(begin).toBeGreaterThan(0);
    expect(f.calls.every((call, index) => !call.startsWith("authority:") || index < begin)).toBe(
      true,
    );
    if (output.status !== "artifacts_captured") throw new Error("Expected capture");
    expect(output.sourceRecheck?.metadataGuard).toBe(true);
    expect(output.candidateAuthority.beforeArtifacts.status).toBe("observed");
    expect(output.candidateAuthority.afterArtifacts.status).toBe("observed");
  });

  it.each([undefined, null, 1, "true"])(
    "rejects a configured runtime port's non-boolean response: %s",
    async (value) => {
      const { h, run, runtime } = await setup();
      runtime.mockResolvedValue(value as never);
      await expect(run()).rejects.toBeInstanceOf(Error);
      expect(h.get).not.toHaveBeenCalled();
    },
  );
  it("preserves full-precision external observation receipts", async () => {
    const { h, authorities } = await setup();
    const captured = await h.execute();
    const startedAt = "2026-10-01T03:01:00.123456789Z";
    const completedAt = "2026-10-01T03:01:00.123456790Z";
    const times = [startedAt, completedAt];
    const observed = await observeCapturedCandidateAuthority(
      h.request,
      captured.traceCapture.comparisonCapture.graph,
      authorities,
      { now: () => times.shift() ?? completedAt },
      new AcquisitionBudget(h.request.limits),
      {
        maxReferences: h.request.limits.maxAcquisitionRecords,
        maxReferenceBytes: h.request.limits.maxAcquisitionRecordBytes,
      },
    );
    expect(observed).toMatchObject({ status: "observed", startedAt, completedAt });
  });

  it.each([
    ["2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z"],
    ["2026-10-01T03:01:00.123456789Z", "2026-10-01T03:01:00.123456788Z"],
  ])(
    "rejects observation clocks outside the request/capture order: %s / %s",
    async (startedAt, completedAt) => {
      const { h, authorities, revision } = await setup();
      const captured = await h.execute();
      const times = [startedAt, completedAt];
      await expect(
        observeCapturedCandidateAuthority(
          h.request,
          captured.traceCapture.comparisonCapture.graph,
          authorities,
          { now: () => times.shift() ?? completedAt },
          new AcquisitionBudget(h.request.limits),
          {
            maxReferences: h.request.limits.maxAcquisitionRecords,
            maxReferenceBytes: h.request.limits.maxAcquisitionRecordBytes,
          },
        ),
      ).rejects.toMatchObject({ reason: "observation_conflict" });
      if (startedAt.startsWith("2025")) expect(revision).not.toHaveBeenCalled();
      else expect(revision).toHaveBeenCalledTimes(1);
    },
  );
});

describe("request-rooted authorized artifact capture", () => {
  it("binds all graph and repeated trace occurrences under one metadata and object budget", async () => {
    const h = await harness();
    const output = await h.execute();
    if (output.status !== "artifacts_captured" || output.traceCapture.status !== "traces_captured")
      throw new Error("Expected captured observations");
    const graph = output.traceCapture.comparisonCapture.graph;
    const records = graph.edges.flatMap((edge, edgeIndex) =>
      edge.reference.kind === "artifact" ? [edgeIndex] : [],
    );
    expect(output.artifacts.map(({ origin }) => origin)).toEqual([
      ...records.map((edgeIndex) => ({ kind: "record", edgeIndex })),
      { kind: "trace", artifactReferenceIndex: 0 },
      { kind: "trace", artifactReferenceIndex: 1 },
    ]);
    for (const { origin, read } of output.artifacts) {
      const edge = origin.kind === "record" ? graph.edges[origin.edgeIndex] : undefined;
      const expected =
        origin.kind === "trace"
          ? output.traceCapture.artifactReferences[origin.artifactReferenceIndex]?.reference
          : edge?.reference.kind === "artifact"
            ? edge.reference.reference
            : undefined;
      expect(read.reference).toEqual(expected);
      expect(read.scope).toEqual(scope);
      expect(read.evaluationTime).toBe(h.request.evaluationTime);
    }
    expect(graph.unresolved.records).toBeGreaterThan(0);
    const shared = output.artifacts.filter(
      ({ read }) => read.reference.artifactId === reference.artifactId,
    );
    expect(shared).toHaveLength(3);
    expect(shared.every(({ read }) => read.observation.status === "verified")).toBe(true);
    expect(output.artifacts.some(({ read }) => read.observation.status === "missing")).toBe(true);
    const expectedCoordinates = new Set([
      ...graph.nodes.flatMap(({ read }) =>
        read.source.kind === "release_policy"
          ? [JSON.stringify(["release_policy", read.source.reference.policyVersionId])]
          : [],
      ),
      ...output.artifacts.map(({ read }) =>
        JSON.stringify(["artifact", read.reference.artifactId]),
      ),
    ]);
    expect(output.sourceGuards.map(({ kind, id }) => JSON.stringify([kind, id]))).toEqual(
      [...expectedCoordinates].sort(),
    );
    expect(
      output.sourceGuards.find(({ kind, id }) => kind === "artifact" && id === reference.artifactId)
        ?.origins,
    ).toEqual(
      output.artifacts.flatMap(({ read }, captureIndex) =>
        read.reference.artifactId === reference.artifactId
          ? [{ kind: "artifact_capture", captureIndex }]
          : [],
      ),
    );
    expect(output.usage.sourceGuards).toEqual({
      resources: expectedCoordinates.size,
      origins:
        graph.nodes.filter(({ read }) => read.source.kind === "release_policy").length +
        output.artifacts.length,
      canonicalBytes: Buffer.byteLength(JSON.stringify(output.sourceGuards)),
    });
    for (const [captureIndex, { read }] of output.artifacts.entries())
      expect(
        output.sourceGuards.find(
          ({ kind, id }) => kind === "artifact" && id === read.reference.artifactId,
        )?.origins,
      ).toContainEqual({ kind: "artifact_capture", captureIndex });
    expect(h.exact).toHaveBeenCalledTimes(1);
    expect(h.get).toHaveBeenCalledTimes(3);
    // Both complete lifecycle observations are admitted even when each returns an empty history.
    expect(output.usage.reads).toBe(output.traceCapture.usage.reads + h.find.mock.calls.length + 2);
    expect(output.usage.records).toBe(
      output.traceCapture.usage.records + h.find.mock.calls.length + 2,
    );
    expect(output.usage.references).toBe(
      output.traceCapture.usage.references +
        output.policyAuthority.inspectionUsage.references +
        output.applicability.inspectionUsage.references +
        output.comparisonRules.inspectionUsage.references +
        output.artifactRules.inspectionUsage.references,
    );
    expect(output.usage.artifacts).toEqual({
      reads: 3,
      reservedBytes: h.encrypted.bytes.byteLength * 3,
      receivedBytes: h.encrypted.bytes.byteLength * 3,
      chargedBytes: h.encrypted.bytes.byteLength * 3,
    });
    expect(output.startedAt).toBe(observedAt);
    expect(output.completedAt).toBe(observedAt);
    expect(JSON.stringify(output)).not.toContain(content.toString());
    expect(JSON.stringify(output)).not.toContain(h.active.objectKey);
    expect(JSON.stringify(output)).not.toContain(h.active.encryption.wrappedDataKey.ciphertext);
    expect(output).not.toHaveProperty("sealed");
    expect(output).not.toHaveProperty("verdict");
    expect(output.fixtureBindings).toEqual([]);
  });

  it.each([
    "capability",
    "tenant",
    "project",
    "environment",
    "principal",
    "request",
    "guard_subset",
    "evaluation_time",
    "receipt_time",
    "clock",
  ])("rejects invalid %s before repository I/O", async (kind) => {
    const h = await harness();
    if (kind === "capability") h.actor.capabilities = ["policy:evaluate"];
    if (kind === "tenant") h.actor.tenantId = "tenant_other";
    if (kind === "project")
      h.actor.resourceScope = { mode: "restricted", projects: [{ projectId: "project_other" }] };
    if (kind === "environment")
      h.actor.resourceScope = {
        mode: "restricted",
        projects: [{ projectId: scope.projectId, environmentIds: ["environment_other"] }],
      };
    if (kind === "principal") Object.assign(h.actor, { extra: true });
    if (kind === "request") h.request.definitionSha256 = "f".repeat(64);
    if (kind === "guard_subset") Object.assign(h.request, { sourceGuards: [] });
    if (kind === "evaluation_time")
      h.clock.now.mockReturnValue(new Date("2026-09-30T00:00:00.000Z"));
    if (kind === "receipt_time") h.clock.now.mockReturnValue(new Date("2026-10-01T00:30:00.000Z"));
    if (kind === "clock") h.clock.now.mockReturnValue(new Date(Number.NaN));
    await expect(h.execute()).rejects.toThrow();
    expect(h.root).not.toHaveBeenCalled();
    expect(h.exact).not.toHaveBeenCalled();
    expect(h.find).not.toHaveBeenCalled();
  });

  it("preserves unavailable roots without reporting an empty successful inventory", async () => {
    const h = await harness();
    h.root.mockResolvedValue(null);
    const output = await h.execute();
    expect(output.status).toBe("roots_unavailable");
    expect(output).not.toHaveProperty("artifacts");
    expect(output).not.toHaveProperty("fixtureBindings");
    expect(output).not.toHaveProperty("sourceGuards");
    expect(output.usage.sourceGuards).toEqual({ resources: 0, origins: 0, canonicalBytes: 0 });
    expect(output.usage.artifacts).toEqual({
      reads: 0,
      reservedBytes: 0,
      receivedBytes: 0,
      chargedBytes: 0,
    });
    expect(h.find).not.toHaveBeenCalled();
  });

  it("uses remaining record and raw JSON byte budgets rather than resetting after traces", async () => {
    const h = await harness(false, 124);
    // Four content-bearing events plus 120 metadata-only events keep record admission above all
    // parent/rule reference inspection. Each event stays below the owning 32-reference maximum.
    h.events.forEach((event, index) => {
      event.evidence.contentReferences =
        index < 4 ? Array.from({ length: 24 }, () => reference) : [];
    });
    h.exact.mockResolvedValue(h.events);
    const baseline = await h.execute();
    expect(baseline.usage.records).toBeGreaterThan(baseline.usage.references);
    const exact = withLimits(h.request, {
      maxAcquisitionRecords: Math.max(baseline.usage.records, baseline.usage.references),
      maxAcquisitionRecordBytes: baseline.usage.bytes + baseline.usage.referenceBytes,
    });
    expect((await h.execute(exact)).usage).toEqual(baseline.usage);
    await expect(
      h.execute(withLimits(exact, { maxAcquisitionRecords: baseline.usage.records - 1 })),
    ).rejects.toMatchObject({ reason: "record_limit" });
    await expect(
      h.execute(
        withLimits(exact, {
          maxAcquisitionRecordBytes: baseline.usage.bytes + baseline.usage.referenceBytes - 1,
        }),
      ),
    ).rejects.toMatchObject({ reason: "byte_limit" });
  });

  it("allows the exact repeated-byte budget and rejects the next read before object I/O", async () => {
    const h = await harness();
    const total = h.encrypted.bytes.byteLength * 3;
    expect(
      (await h.execute(withLimits(h.request, { maxArtifactReadBytes: total }))).usage.artifacts
        .chargedBytes,
    ).toBe(total);
    h.get.mockClear();
    await expect(
      h.execute(withLimits(h.request, { maxArtifactReadBytes: total - 1 })),
    ).rejects.toMatchObject({ reason: "artifact_byte_limit" });
    expect(h.get).toHaveBeenCalledTimes(2);
    h.get.mockClear();
    await expect(
      h.execute(withLimits(h.request, { maxArtifactReadBytes: 0 })),
    ).rejects.toMatchObject({ reason: "artifact_byte_limit" });
    expect(h.get).not.toHaveBeenCalled();
  });

  it("charges missing objects conservatively without inventing received bytes", async () => {
    const h = await harness();
    h.get.mockResolvedValue(null);
    const output = await h.execute();
    expect(output.usage.artifacts).toEqual({
      reads: 3,
      reservedBytes: h.encrypted.bytes.byteLength * 3,
      receivedBytes: 0,
      chargedBytes: h.encrypted.bytes.byteLength * 3,
    });
    if (output.status !== "artifacts_captured") throw new Error("Expected artifacts");
    expect(
      output.artifacts
        .filter(({ read }) => read.reference.artifactId === reference.artifactId)
        .every(
          ({ read }) =>
            read.observation.status === "unavailable" &&
            read.observation.reason === "object_missing",
        ),
    ).toBe(true);
  });

  it("preserves unsupported original trace descriptors without managed-store lookup", async () => {
    const h = await harness();
    const unmanaged = {
      ...reference,
      artifactId: "artifact_unmanaged",
      mediaType: "opaque",
      sizeBytes: 0,
    };
    h.event.evidence.contentReferences = [unmanaged];
    h.exact.mockResolvedValue([h.event]);
    const output = await h.execute();
    if (output.status !== "artifacts_captured") throw new Error("Expected captures");
    expect(output.artifacts.at(-1)).toMatchObject({
      origin: { kind: "trace", artifactReferenceIndex: 0 },
      read: {
        reference: unmanaged,
        observation: { status: "unavailable", reason: "reference_unsupported" },
      },
    });
    expect(h.find.mock.calls.every(([, id]) => id !== unmanaged.artifactId)).toBe(true);
    expect(
      output.sourceGuards.find(
        ({ kind, id }) => kind === "artifact" && id === unmanaged.artifactId,
      ),
    ).toEqual({
      kind: "artifact",
      id: unmanaged.artifactId,
      origins: [{ kind: "artifact_capture", captureIndex: output.artifacts.length - 1 }],
    });
  });

  it("retains a later lifecycle successor in the guard set without replacing the request root", async () => {
    const h = await harness();
    const successor = releasePolicyRepositoryFixture("artifact_successor", scope, {
      policyId: h.policy.policyId,
      predecessor: releasePolicyReference(h.policy),
      publishedAt: "2026-10-01T00:30:00.000Z",
      semanticVersion: "2.0.0",
    });
    await h.policies.publishReleasePolicy(successor);
    const event = releasePolicyLifecycleFixture("artifact_successor", h.policy, {
      kind: "superseded",
      successor,
      occurredAt: "2026-10-01T01:00:00.000Z",
    });
    await h.policies.publishReleasePolicyLifecycleEvent(event);
    const output = await h.execute();
    if (output.status !== "artifacts_captured") throw new Error("Expected artifacts");
    expect(
      output.sourceGuards.find(
        ({ kind, id }) => kind === "release_policy" && id === successor.policyVersionId,
      ),
    ).toEqual({
      kind: "release_policy",
      id: successor.policyVersionId,
      origins: [{ kind: "policy_successor", historyIndex: 0 }],
    });
    expect(output.policyLifecycle.afterArtifacts.policy).toEqual(h.request.policy);
    expect(output.policyLifecycle.afterArtifacts.state).toBe("no_terminal_event_at_evaluation");
    expect(
      output.sourceGuards.some(
        ({ kind, id }) => kind === "release_policy" && id === h.policy.policyVersionId,
      ),
    ).toBe(true);
  });

  it("keeps an unreadable predecessor policy coordinate instead of calling its closure empty", async () => {
    const h = await harness();
    const successor = releasePolicyRepositoryFixture("artifact_predecessor", scope, {
      policyId: h.policy.policyId,
      predecessor: releasePolicyReference(h.policy),
      publishedAt: "2026-09-30T23:00:00.000Z",
      semanticVersion: "2.0.0",
    });
    await h.policies.publishReleasePolicy(successor);
    const findPolicy = h.policies.findReleasePolicy.bind(h.policies);
    // Controlled absence at the read port, not a supported database publication without its FK.
    vi.spyOn(h.policies, "findReleasePolicy").mockImplementation((scope, id) =>
      id === h.policy.policyVersionId ? Promise.resolve(null) : findPolicy(scope, id),
    );
    const output = await h.execute(
      withLimits({ ...h.request, policy: releasePolicyReference(successor) }, {}),
    );
    if (output.status !== "artifacts_captured") throw new Error("Expected artifacts");
    const graph = output.traceCapture.comparisonCapture.graph;
    const nodeIndex = graph.nodes.findIndex(
      ({ read }) =>
        read.source.kind === "release_policy" &&
        read.source.reference.policyVersionId === h.policy.policyVersionId,
    );
    expect(graph.nodes[nodeIndex]).toMatchObject({
      read: { observation: { status: "missing" } },
      references: null,
    });
    expect(
      output.sourceGuards.find(
        ({ kind, id }) => kind === "release_policy" && id === h.policy.policyVersionId,
      )?.origins,
    ).toEqual([{ kind: "policy_node", nodeIndex }]);
  });

  it("preflights restricted references before any artifact lookup and permits explicit access", async () => {
    const h = await harness();
    h.event.evidence.contentReferences = [
      { ...reference, artifactId: "artifact_restricted", classification: "restricted" },
    ];
    h.exact.mockResolvedValue([h.event]);
    await expect(h.execute()).rejects.toMatchObject({ code: "forbidden" });
    expect(h.find).not.toHaveBeenCalled();
    h.actor.capabilities.push("artifact:read:restricted");
    expect((await h.execute()).status).toBe("artifacts_captured");
  });

  it("does not let an understated descriptor bypass the owning reader's stored classification", async () => {
    const h = await harness();
    const changed = structuredClone(h.active);
    changed.metadata.contentReference.classification = "restricted";
    h.find.mockResolvedValue(changed);
    await expect(h.execute()).rejects.toMatchObject({ code: "forbidden" });
    expect(h.get).not.toHaveBeenCalled();
  });

  it("admits catalog responses before domain inspection without invoking accessors", async () => {
    const h = await harness();
    const getter = vi.fn(() => h.active.metadata);
    const raw = Object.defineProperty(structuredClone(h.active), "metadata", {
      enumerable: true,
      get: getter,
    });
    h.find.mockResolvedValue(raw);
    await expect(h.execute()).rejects.toMatchObject({ reason: "unmeasurable_record" });
    expect(getter).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
  });

  it.each(["missing", "invalid", "lifecycle", "ownership"])(
    "rejects %s changes between repeated occurrences without a partial result",
    async (kind) => {
      const h = await harness();
      const changed = structuredClone(h.active);
      if (kind === "invalid") Object.assign(changed, { extra: true });
      if (kind === "lifecycle") {
        changed.metadata.state = "tombstoned";
        changed.metadata.tombstonedAt = "2026-09-30T00:00:00.000Z";
      }
      if (kind === "ownership")
        Object.assign(changed, {
          ownership: {
            schemaVersion: "0.1",
            scope,
            artifactId: reference.artifactId,
            boundAt: "2026-09-05T00:00:00.000Z",
            boundByPrincipalId: "principal_binder",
            owner: {
              kind: "regression_fixture_version",
              fixtureId: "fixture_owner",
              fixtureVersionId: "fixture_owner_v1",
            },
          },
        });
      let calls = 0;
      h.find.mockImplementation(async (_scope, id) => {
        if (id !== reference.artifactId) return null;
        if (++calls <= 2) return h.active;
        return kind === "missing" ? null : changed;
      });
      await expect(h.execute()).rejects.toMatchObject({
        reason: "observation_conflict",
        identity: "artifact:artifact_shared",
      });
    },
  );

  it("rejects changed content availability even when both catalog observations agree", async () => {
    const h = await harness();
    h.get.mockResolvedValueOnce(h.encrypted.bytes).mockResolvedValueOnce(null);
    await expect(h.execute()).rejects.toMatchObject({
      reason: "observation_conflict",
      identity: "artifact:artifact_shared",
    });
  });

  it("rejects a catalog revision that changes during an individual object read", async () => {
    const h = await harness();
    let calls = 0;
    h.find.mockImplementation(async (_scope, id) =>
      id === reference.artifactId && ++calls === 1 ? h.active : null,
    );
    await expect(h.execute()).rejects.toMatchObject({ reason: "source_revision_changed" });
  });

  it.each(["root", "catalog", "object", "crypto"])(
    "propagates %s operational errors without publishing indeterminate evidence",
    async (kind) => {
      const h = await harness();
      const failure =
        kind === "crypto" ? new ArtifactProtectionError() : new Error("capture port unavailable");
      if (kind === "root") h.root.mockRejectedValue(failure);
      if (kind === "catalog") h.find.mockRejectedValue(failure);
      if (kind === "object") h.get.mockRejectedValue(failure);
      if (kind === "crypto") h.decrypt.mockRejectedValue(failure);
      await expect(h.execute()).rejects.toBe(failure);
    },
  );

  it("retains real key-provider failure through both the crypto and composition layers", async () => {
    const h = await harness();
    const failure = new Error("key service unavailable");
    vi.spyOn(h.keyring, "unwrapDataKey").mockRejectedValue(failure);
    await expect(h.execute()).rejects.toMatchObject({
      code: "artifact_protection_failed",
      cause: failure,
    });
  });

  it("rejects excess returned bytes before decryption even if the catalog predicted less", async () => {
    const h = await harness();
    h.get.mockResolvedValue(new Uint8Array(h.encrypted.bytes.byteLength + 1));
    await expect(
      h.execute(withLimits(h.request, { maxArtifactReadBytes: h.encrypted.bytes.byteLength })),
    ).rejects.toMatchObject({ reason: "artifact_byte_limit" });
    expect(h.decrypt).not.toHaveBeenCalled();
  });

  it("permits advancing observation timestamps without treating them as catalog conflicts", async () => {
    const h = await harness();
    let calls = 0;
    h.clock.now.mockImplementation(() => new Date(Date.parse(observedAt) + ++calls));
    const output = await h.execute();
    expect(output.status).toBe("artifacts_captured");
    expect(output.completedAt > output.startedAt).toBe(true);
  });

  it("rejects a clock regression between individually monotone reads", async () => {
    const h = await harness();
    let calls = 0;
    h.clock.now.mockImplementation(
      () => new Date(Date.parse(observedAt) - (++calls === 5 ? 1 : 0)),
    );
    await expect(h.execute()).rejects.toMatchObject({ reason: "clock_invalid" });
  });

  it("rejects earlier verified content that expires at the final aggregate cut", async () => {
    const h = await harness();
    await h.execute();
    const lastCall = h.clock.now.mock.calls.length;
    let calls = 0;
    h.clock.now.mockImplementation(
      () => new Date(++calls === lastCall ? "2026-10-02T00:00:00.000Z" : observedAt),
    );
    await expect(h.execute()).rejects.toMatchObject({ reason: "source_revision_changed" });
  });

  it("owns the request and actor before any asynchronous repository mutation", async () => {
    const h = await harness();
    h.root.mockImplementation(async () => {
      h.actor.capabilities.length = 0;
      h.request.scope.tenantId = "tenant_changed";
      h.request.limits.maxArtifactReadBytes = 0;
      return h.candidate;
    });
    const output = await h.execute();
    expect(output.status).toBe("artifacts_captured");
    expect(output.usage.artifacts.reads).toBe(3);
    expect(h.find.mock.calls.every(([passed]) => passed.tenantId === scope.tenantId)).toBe(true);
  });

  it("does not expose caller-supplied graph or meter composition at the package entry point", () => {
    expect(publicApi.capturePolicyArtifactEvidence).toBe(capturePolicyArtifactEvidence);
    expect(publicApi).not.toHaveProperty("acquirePolicyTraceEvidence");
    expect(publicApi).not.toHaveProperty("acquirePolicyRecordGraph");
    expect(publicApi).not.toHaveProperty("AcquisitionBudget");
    expect(publicApi).not.toHaveProperty("inspectCapturedFixtureBindings");
    expect(publicApi).not.toHaveProperty("deriveCapturedPolicySourceGuards");
    expect(publicApi).not.toHaveProperty("deriveAndRecheckCapturedPolicySources");
  });
});

async function recheckHarness(eventCount = 1) {
  const h = await harness(false, eventCount);
  const calls: string[] = [];
  const state = { phase: "outside" };
  const ports = {
    tryMetadataGuard: vi.fn(async () => true),
    findCriterion: vi.fn(async () => null),
    listCriterionSetStatuses: vi.fn(async () => []),
    tryGuard: vi.fn(async (kind: "artifact" | "release_policy", id: string) => {
      calls.push(`guard:${kind}:${id}`);
      return true;
    }),
    findArtifact: vi.fn(async (id: string): Promise<unknown> => {
      calls.push(`artifact:${id}`);
      return h.catalog.find(scope, id);
    }),
    findPolicy: vi.fn(async (id: string): Promise<unknown> => {
      calls.push(`policy:${id}`);
      return h.policies.findReleasePolicy(scope, id);
    }),
    listPolicyHistory: vi.fn(async (id: string): Promise<unknown> => {
      calls.push(`history:${id}`);
      return h.policies.listReleasePolicyLifecycleEvents(scope, id);
    }),
    observationTime: vi.fn(async () => {
      calls.push("time");
      return observedAt;
    }),
  } satisfies PolicyEvaluationSourceRecheckPorts;
  const transactions: PolicyEvaluationSourceTransactions = {
    run: async (exact, operation) => {
      expect(exact).toEqual(scope);
      expect(state.phase).toBe("outside");
      state.phase = "inside";
      calls.push("begin");
      try {
        const result = await operation(ports);
        state.phase = "committed";
        calls.push("commit");
        return result;
      } catch (error) {
        state.phase = "rolled_back";
        calls.push("rollback");
        throw error;
      }
    },
  };
  const run = (request = h.request) =>
    capturePolicyArtifactEvidence(request, h.actor, h.repositories, h.evidence, {
      ...h.dependencies,
      sourceTransactions: transactions,
    });
  return { h, calls, ports, state, transactions, run };
}

async function metadataRecheckHarness() {
  const f = await recheckHarness();
  const track = <T extends object>(repository: T, domain: string): T =>
    new Proxy(repository, {
      get(target, property) {
        const method: unknown = Reflect.get(target, property);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => {
          expect(f.state.phase).toBe("inside");
          f.calls.push(`record:${domain}:${String(property)}`);
          return Reflect.apply(method, target, args);
        };
      },
    });
  const original = f.h.repositories;
  const records: PolicyRecordGraphRepositories = {
    control: {
      comparison: track(original.control.comparison, "comparison"),
      releaseCandidate: track(original.control.releaseCandidate, "candidate"),
      releasePolicy: track(original.control.releasePolicy, "policy"),
      installationBinding: track(original.control.installationBinding, "installation"),
    },
    evidence: {
      evaluation: track(original.evidence.evaluation, "evaluation"),
      modelAssurance: track(original.evidence.modelAssurance, "model"),
    },
    datasets: track(original.datasets, "datasets"),
    replayDefinitions: track(original.replayDefinitions, "replay"),
    replayResults: track(original.replayResults, "results"),
    runtimeDefinitions: track(original.runtimeDefinitions, "runtime"),
  };
  const evidence = {
    resolveExactEvents: async (...args: Parameters<typeof f.h.evidence.resolveExactEvents>) => {
      expect(f.state.phase).toBe("inside");
      f.calls.push("trace");
      return f.h.evidence.resolveExactEvents(...args);
    },
  };
  const metadataTransactions: PolicyEvaluationMetadataTransactions = {
    runMetadata: async (scope, operation) =>
      f.transactions.run(scope, async (sources) => {
        // Explicit memory-only adapter contract; actual PostgreSQL barrier/lifetime has separate tests.
        await sources.tryMetadataGuard();
        f.calls.push("metadata");
        return operation({
          sources,
          records,
          evidence,
          criterionStatusHistory: { listCriterionSetStatuses: async () => [] },
          fixtureContent: { findRecordedInteractionFixtureContent: async () => null },
        });
      }),
  };
  const run = (request = f.h.request) =>
    capturePolicyArtifactEvidence(request, f.h.actor, f.h.repositories, f.h.evidence, {
      ...f.h.dependencies,
      metadataTransactions,
    });
  return { ...f, records, metadataTransactions, run };
}

describe("request-owned metadata/artifact recheck composition", () => {
  it("holds all source guards before graph/trace reads, preserves repeated observations and returns only a historical report", async () => {
    const f = await metadataRecheckHarness();
    const objectGet = MemoryArtifactObjectStore.prototype.get;
    f.h.get.mockImplementation(async (key) => {
      expect(f.state.phase).toBe("outside");
      return objectGet.call(f.h.dependencies.objects, key);
    });
    const output = await f.run();
    if (output.status !== "artifacts_captured" || output.traceCapture.status !== "traces_captured")
      throw new Error("Expected artifact capture");
    expect(f.calls.slice(0, 2)).toEqual(["begin", "metadata"]);
    expect(f.calls.slice(2, 2 + output.sourceGuards.length)).toEqual(
      output.sourceGuards.map(({ kind, id }) => `guard:${kind}:${id}`),
    );
    expect(f.calls[2 + output.sourceGuards.length]).toMatch(/^record:/u);
    expect(f.calls.filter((call) => call === "begin")).toHaveLength(1);
    expect(f.calls.at(-1)).toBe("commit");
    expect(f.h.get).toHaveBeenCalledTimes(3);
    expect(f.h.decrypt).toHaveBeenCalledTimes(3);
    expect(f.h.exact).toHaveBeenCalledTimes(2);
    expect(output.sourceRecheck).toMatchObject({
      status: "observations_rechecked",
      metadataGuard: true,
      criterionHistoryReads: 0,
      criterionHistoryRows: 0,
      metadata: {
        recordObservations: output.traceCapture.comparisonCapture.graph.nodes.length,
        traceObservations: output.traceCapture.traces.length,
        recordReads: f.calls.filter((call) => call.startsWith("record:")).length,
        traceReads: 1,
      },
    });
    expect(output.usage.reads).toBeGreaterThan(output.traceCapture.usage.reads * 2);
    expect(output).not.toHaveProperty("sealed");
    expect(output).not.toHaveProperty("verdict");
  });

  it("rejects ambiguous trusted transaction configuration before any content I/O", async () => {
    const f = await metadataRecheckHarness();
    await expect(
      capturePolicyArtifactEvidence(f.h.request, f.h.actor, f.h.repositories, f.h.evidence, {
        ...f.h.dependencies,
        sourceTransactions: f.transactions,
        metadataTransactions: f.metadataTransactions,
      }),
    ).rejects.toThrow("Expected one policy recheck transaction mode");
    expect(f.h.get).not.toHaveBeenCalled();
    expect(f.h.root).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });

  it.each(["first", "last", "invalid"] as const)(
    "never starts graph reads after %s source guard failure",
    async (where) => {
      const f = await metadataRecheckHarness();
      const baseline = await f.h.execute();
      if (baseline.status !== "artifacts_captured") throw new Error("Expected artifacts");
      let index = 0;
      const failure = where === "last" ? baseline.sourceGuards.length - 1 : 0;
      f.ports.tryGuard.mockImplementation(async () =>
        index++ === failure ? (where === "invalid" ? (null as unknown as boolean) : false) : true,
      );
      await expect(f.run()).rejects.toMatchObject({
        reason: where === "invalid" ? "guard_invalid" : "guard_unavailable",
      });
      expect(f.calls.some((call) => call.startsWith("record:") || call === "trace")).toBe(false);
      expect(f.calls.at(-1)).toBe("rollback");
    },
  );

  it("rejects a changed candidate receipt under guards before any descendant reinspection", async () => {
    const f = await metadataRecheckHarness();
    f.h.root.mockImplementation(async (...args) => {
      const record = await MemoryReleaseCandidateRepository.prototype.findReleaseCandidate.call(
        f.h.repositories.control.releaseCandidate,
        ...args,
      );
      return f.state.phase === "inside" && record
        ? { ...record, createdByPrincipalId: "changed_candidate_receipt" }
        : record;
    });
    await expect(f.run()).rejects.toMatchObject({
      code: "policy_evaluation_source_recheck_failed",
      reason: "source_revision_changed",
      identity: expect.stringContaining("release_candidate"),
    });
    expect(f.calls.filter((call) => call.startsWith("record:"))).toEqual([
      "record:candidate:findReleaseCandidate",
    ]);
    expect(f.calls.at(-1)).toBe("rollback");
  });

  it("rejects changed exact trace evidence under guards without repeating content/key I/O", async () => {
    const f = await metadataRecheckHarness();
    f.h.exact.mockImplementation(async (...args) =>
      f.state.phase === "inside"
        ? null
        : MemoryEvidenceRepository.prototype.resolveExactEvents.call(f.h.evidence, ...args),
    );
    await expect(f.run()).rejects.toMatchObject({
      reason: "source_revision_changed",
      identity: "trace:0",
    });
    expect(f.h.get).toHaveBeenCalledTimes(3);
    expect(f.h.decrypt).toHaveBeenCalledTimes(3);
    expect(f.calls.at(-1)).toBe("rollback");
  });

  it.each(["record_and_reference", "bytes"] as const)(
    "uses exact cumulative %s admission and rolls back one below it",
    async (kind) => {
      const baseline = await (await metadataRecheckHarness()).run();
      const admitted =
        kind === "bytes"
          ? baseline.usage.bytes + baseline.usage.referenceBytes
          : Math.max(baseline.usage.records, baseline.usage.references);
      const exact = await metadataRecheckHarness();
      const exactInput = withLimits(
        exact.h.request,
        kind === "bytes"
          ? { maxAcquisitionRecordBytes: admitted }
          : { maxAcquisitionRecords: admitted },
      );
      const output = await exact.run(exactInput);
      expect(output.status).toBe("artifacts_captured");
      expect(exact.calls.at(-1)).toBe("commit");
      const below = await metadataRecheckHarness();
      const input = withLimits(
        below.h.request,
        kind === "bytes"
          ? { maxAcquisitionRecordBytes: admitted - 1 }
          : { maxAcquisitionRecords: admitted - 1 },
      );
      await expect(below.run(input)).rejects.toMatchObject({
        code: "policy_record_graph_failed",
        reason:
          kind === "bytes"
            ? "byte_limit"
            : baseline.usage.records >= baseline.usage.references
              ? "record_limit"
              : "reference_limit",
      });
      expect(below.calls.at(-1)).toBe("rollback");
    },
  );

  it("propagates metadata storage failures without disguising them as revision changes", async () => {
    const f = await metadataRecheckHarness();
    const failure = new Error("guarded candidate database offline");
    f.h.root.mockImplementation(async (...args) => {
      if (f.state.phase === "inside") throw failure;
      return MemoryReleaseCandidateRepository.prototype.findReleaseCandidate.call(
        f.h.repositories.control.releaseCandidate,
        ...args,
      );
    });
    await expect(f.run()).rejects.toBe(failure);
    expect(f.calls.at(-1)).toBe("rollback");
  });
});

describe("request-owned source recheck composition", () => {
  it("does not start a source transaction for unavailable roots or claim a successful empty recheck", async () => {
    const f = await recheckHarness();
    f.h.root.mockResolvedValue(null);
    const run = vi.spyOn(f.transactions, "run");
    const output = await f.run();
    expect(output.status).toBe("roots_unavailable");
    expect(output).not.toHaveProperty("sourceRecheck");
    expect(output).not.toHaveProperty("sourceGuards");
    expect(output.usage.sourceGuards).toEqual({ resources: 0, origins: 0, canonicalBytes: 0 });
    expect(run).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });

  it("guards every coordinate before authoritative reads, outside object/key I/O, on one transaction port", async () => {
    const f = await recheckHarness();
    f.h.get.mockImplementation(async () => {
      expect(f.state.phase).toBe("outside");
      return f.h.encrypted.bytes;
    });
    const output = await f.run();
    if (output.status !== "artifacts_captured") throw new Error("Expected artifacts");
    expect(f.calls.slice(1, 1 + output.sourceGuards.length)).toEqual(
      output.sourceGuards.map(({ kind, id }) => `guard:${kind}:${id}`),
    );
    expect(f.calls.at(-1)).toBe("commit");
    expect(f.h.get).toHaveBeenCalledTimes(3);
    expect(f.h.decrypt).toHaveBeenCalledTimes(3);
    expect(f.ports.findArtifact).toHaveBeenCalledTimes(
      output.sourceGuards.filter(({ kind }) => kind === "artifact").length,
    );
    expect(output.sourceRecheck).toEqual({
      status: "observations_rechecked",
      observedAt,
      guards: output.sourceGuards.length,
      artifactReads: f.ports.findArtifact.mock.calls.length,
      policyReads: f.ports.findPolicy.mock.calls.length,
      metadataGuard: false,
      criterionReads: 0,
      criterionHistoryReads: 0,
      criterionHistoryRows: 0,
    });
    expect(f.ports.tryMetadataGuard).not.toHaveBeenCalled();
    expect(f.ports.findCriterion).not.toHaveBeenCalled();
    expect(f.ports.listCriterionSetStatuses).not.toHaveBeenCalled();
    expect(JSON.stringify(output.sourceRecheck)).not.toContain(f.h.active.objectKey);
    expect(output).not.toHaveProperty("sealed");
    expect(output).not.toHaveProperty("verdict");
  });

  it.each(["first", "last", "invalid"])(
    "rolls back the whole observation on %s guard failure without any source reads",
    async (kind) => {
      const f = await recheckHarness();
      const baseline = await f.h.execute();
      if (baseline.status !== "artifacts_captured") throw new Error("Expected artifacts");
      const failedIndex = kind === "last" ? baseline.sourceGuards.length - 1 : 0;
      let index = 0;
      f.ports.tryGuard.mockImplementation(async () =>
        index++ === failedIndex
          ? kind === "invalid"
            ? (undefined as unknown as boolean)
            : false
          : true,
      );
      await expect(f.run()).rejects.toMatchObject({
        reason: kind === "invalid" ? "guard_invalid" : "guard_unavailable",
      });
      expect(f.state.phase).toBe("rolled_back");
      expect(f.ports.findArtifact).not.toHaveBeenCalled();
      expect(f.ports.findPolicy).not.toHaveBeenCalled();
      expect(f.ports.observationTime).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "undefined", "private_key", "ownership", "tombstone", "expiry"])(
    "rejects changed %s catalog observations with whole rollback",
    async (kind) => {
      const f = await recheckHarness();
      const changed = structuredClone(f.h.active);
      if (kind === "private_key")
        Object.assign(changed.encryption.wrappedDataKey, { keyId: "key_changed" });
      if (kind === "ownership")
        Object.assign(changed, {
          ownership: {
            schemaVersion: "0.1",
            scope,
            artifactId: reference.artifactId,
            boundAt: observedAt,
            boundByPrincipalId: "principal_owner",
            owner: {
              kind: "regression_fixture_version",
              fixtureId: "fixture_owner",
              fixtureVersionId: "fixture_owner_v1",
            },
          },
        });
      if (kind === "tombstone") {
        changed.metadata.state = "tombstoned";
        changed.metadata.tombstonedAt = "2026-09-30T00:00:00.000Z";
      }
      if (kind === "expiry") f.ports.observationTime.mockResolvedValue("2026-10-02T00:00:00.000Z");
      f.ports.findArtifact.mockImplementation(async (id) =>
        id !== reference.artifactId
          ? null
          : kind === "missing"
            ? null
            : kind === "undefined"
              ? undefined
              : changed,
      );
      await expect(f.run()).rejects.toMatchObject({ reason: "source_revision_changed" });
      expect(f.state.phase).toBe("rolled_back");
      expect(f.calls).not.toContain("commit");
    },
  );

  it.each(["missing", "receipt", "scope", "terminal"])(
    "rejects changed policy %s without selecting newer evidence",
    async (kind) => {
      const f = await recheckHarness();
      if (kind === "terminal")
        f.ports.listPolicyHistory.mockResolvedValue([
          releasePolicyLifecycleFixture("recheck_withdrawn", f.h.policy),
        ]);
      else {
        const changed = structuredClone(f.h.policy);
        if (kind === "receipt") changed.publishedAt = "2026-09-08T00:00:00.000Z";
        if (kind === "scope") changed.scope.projectId = "project_other";
        f.ports.findPolicy.mockResolvedValue(kind === "missing" ? null : changed);
      }
      await expect(f.run()).rejects.toMatchObject({ reason: "source_revision_changed" });
      expect(f.state.phase).toBe("rolled_back");
    },
  );

  it("retains a later guarded successor and detects a full receipt change without new unguarded reads", async () => {
    const f = await recheckHarness();
    const successor = releasePolicyRepositoryFixture("recheck_successor", scope, {
      policyId: f.h.policy.policyId,
      predecessor: releasePolicyReference(f.h.policy),
      publishedAt: "2026-10-01T00:30:00.000Z",
      semanticVersion: "2.0.0",
    });
    await f.h.policies.publishReleasePolicy(successor);
    await f.h.policies.publishReleasePolicyLifecycleEvent(
      releasePolicyLifecycleFixture("recheck_successor", f.h.policy, {
        kind: "superseded",
        successor,
        occurredAt: "2026-10-01T01:00:00.000Z",
      }),
    );
    const output = await f.run();
    expect(output.status).toBe("artifacts_captured");
    expect(f.ports.findPolicy).toHaveBeenCalledWith(successor.policyVersionId);
    const fresh = await recheckHarness();
    await fresh.h.policies.publishReleasePolicy(successor);
    await fresh.h.policies.publishReleasePolicyLifecycleEvent(
      releasePolicyLifecycleFixture("recheck_successor", fresh.h.policy, {
        kind: "superseded",
        successor,
        occurredAt: "2026-10-01T01:00:00.000Z",
      }),
    );
    fresh.ports.findPolicy.mockImplementation(async (id) =>
      id === successor.policyVersionId
        ? { ...successor, publishedAt: "2026-10-01T00:29:00.000Z" }
        : fresh.h.policies.findReleasePolicy(scope, id),
    );
    await expect(fresh.run()).rejects.toMatchObject({ reason: "source_revision_changed" });
    expect(fresh.state.phase).toBe("rolled_back");
  });

  it("rejects new supersession history without querying its unguarded successor", async () => {
    const f = await recheckHarness();
    const successor = releasePolicyRepositoryFixture("recheck_new", scope, {
      policyId: f.h.policy.policyId,
      predecessor: releasePolicyReference(f.h.policy),
      semanticVersion: "2.0.0",
    });
    f.ports.listPolicyHistory.mockResolvedValue([
      releasePolicyLifecycleFixture("recheck_new", f.h.policy, { kind: "superseded", successor }),
    ]);
    await expect(f.run()).rejects.toMatchObject({ reason: "source_revision_changed" });
    expect(f.ports.findPolicy).not.toHaveBeenCalledWith(successor.policyVersionId);
  });

  it.each([undefined, null, { events: [] }])(
    "rejects malformed history %j instead of treating it as unchanged absence",
    async (history) => {
      const f = await recheckHarness();
      f.ports.listPolicyHistory.mockResolvedValue(history);
      await expect(f.run()).rejects.toThrow();
      expect(f.state.phase).toBe("rolled_back");
      expect(f.calls).not.toContain("commit");
    },
  );

  it.each(["object_missing", "content_integrity_failed"])(
    "preserves captured %s instead of inventing a second content verification",
    async (reason) => {
      const f = await recheckHarness();
      f.h.get.mockResolvedValue(reason === "object_missing" ? null : new Uint8Array(1));
      const output = await f.run();
      if (output.status !== "artifacts_captured") throw new Error("Expected artifacts");
      expect(output.sourceRecheck?.status).toBe("observations_rechecked");
      expect(
        output.artifacts.find(({ read }) => read.reference.artifactId === reference.artifactId)
          ?.read.observation,
      ).toEqual({ status: "unavailable", reason });
      expect(f.h.get).toHaveBeenCalledTimes(3);
    },
  );

  it("keeps unsupported coordinates guarded without new catalog lookup", async () => {
    const f = await recheckHarness();
    f.h.event.evidence.contentReferences = [
      { ...reference, artifactId: "artifact_unmanaged", mediaType: "opaque", sizeBytes: 0 },
    ];
    f.h.exact.mockResolvedValue([f.h.event]);
    const output = await f.run();
    expect(output.status).toBe("artifacts_captured");
    expect(f.ports.tryGuard).toHaveBeenCalledWith("artifact", "artifact_unmanaged");
    expect(f.ports.findArtifact).not.toHaveBeenCalledWith("artifact_unmanaged");
  });

  it.each(["bad", "2026-10-01T01:59:59.999Z"])(
    "rejects invalid or pre-capture database cut %s",
    async (at) => {
      const f = await recheckHarness();
      f.ports.observationTime.mockResolvedValue(at);
      await expect(f.run()).rejects.toMatchObject({ reason: "clock_invalid" });
      expect(f.state.phase).toBe("rolled_back");
    },
  );

  it("retains native database cut precision without making aggregate completion precede it", async () => {
    const f = await recheckHarness();
    const at = "2026-10-01T02:00:00.000001Z";
    f.ports.observationTime.mockResolvedValue(at);
    const output = await f.run();
    if (output.status !== "artifacts_captured") throw new Error("Expected artifacts");
    expect(output.sourceRecheck?.observedAt).toBe(at);
    expect(output.completedAt).toBe(at);
  });

  it.each([
    "tryGuard",
    "findArtifact",
    "findPolicy",
    "listPolicyHistory",
    "observationTime",
  ] as const)("propagates %s storage errors unchanged and rolls back", async (method) => {
    const f = await recheckHarness();
    const failure = new Error("source storage offline");
    f.ports[method].mockRejectedValue(failure);
    await expect(f.run()).rejects.toBe(failure);
    expect(f.state.phase).toBe("rolled_back");
  });

  it("shares record and JSON admission with capture rather than resetting for the transaction", async () => {
    // Retain a real successor/history so record admission remains the limiting dimension
    // after candidate assessment and closure inspection also charge reference occurrences.
    const prepare = async () => {
      const fixture = await recheckHarness(100);
      fixture.h.events.forEach((event, index) => {
        event.evidence.contentReferences =
          index < 4 ? Array.from({ length: 24 }, () => reference) : [];
      });
      fixture.h.exact.mockResolvedValue(fixture.h.events);
      const successor = releasePolicyRepositoryFixture("recheck_budget", scope, {
        policyId: fixture.h.policy.policyId,
        predecessor: releasePolicyReference(fixture.h.policy),
        publishedAt: "2026-10-01T00:30:00.000Z",
        semanticVersion: "2.0.0",
      });
      await fixture.h.policies.publishReleasePolicy(successor);
      await fixture.h.policies.publishReleasePolicyLifecycleEvent(
        releasePolicyLifecycleFixture("recheck_budget", fixture.h.policy, {
          kind: "superseded",
          successor,
          occurredAt: "2026-10-01T01:00:00.000Z",
        }),
      );
      return fixture;
    };
    const f = await prepare();
    const baseline = await f.run();
    expect(baseline.usage.records).toBeGreaterThan(baseline.usage.references);
    const fresh = await prepare();
    const exact = withLimits(fresh.h.request, {
      maxAcquisitionRecords: Math.max(baseline.usage.records, baseline.usage.references),
      maxAcquisitionRecordBytes: baseline.usage.bytes + baseline.usage.referenceBytes,
    });
    expect((await fresh.run(exact)).usage).toEqual(baseline.usage);
    const short = await prepare();
    await expect(
      short.run(
        withLimits(exact, {
          maxAcquisitionRecordBytes: exact.limits.maxAcquisitionRecordBytes - 1,
        }),
      ),
    ).rejects.toMatchObject({ reason: "byte_limit" });
    expect(short.state.phase).toBe("rolled_back");
    const fewer = await prepare();
    await expect(
      fewer.run(withLimits(exact, { maxAcquisitionRecords: baseline.usage.records - 1 })),
    ).rejects.toMatchObject({ reason: "record_limit" });
    expect(fewer.state.phase).toBe("rolled_back");
  });

  it("charges each retained terminal-history row as well as its reread operation", async () => {
    const f = await recheckHarness(100);
    // Keep record admission, rather than reference admission, the limiting dimension.
    f.h.events.forEach((event, index) => {
      event.evidence.contentReferences =
        index < 4 ? Array.from({ length: 24 }, () => reference) : [];
    });
    f.h.exact.mockResolvedValue(f.h.events);
    await f.h.policies.publishReleasePolicyLifecycleEvent(
      releasePolicyLifecycleFixture("recheck_rows", f.h.policy, {
        occurredAt: "2026-09-30T00:00:00.000Z",
      }),
    );
    const before = await f.h.execute();
    const output = await f.run();
    if (output.status !== "artifacts_captured" || !output.sourceRecheck)
      throw new Error("Expected guarded observations");
    const recheck = output.sourceRecheck;
    // Every guard, unique read, history lookup and clock is an operation; the retained row
    // additionally consumes admission. A one-record history query cannot hide its members.
    expect(output.usage.records - before.usage.records).toBe(
      recheck.guards + recheck.artifactReads + recheck.policyReads + 2 + 1,
    );
    expect(output.usage.records).toBeGreaterThan(output.usage.references);
    const fresh = await recheckHarness(100);
    fresh.h.events.forEach((event, index) => {
      event.evidence.contentReferences =
        index < 4 ? Array.from({ length: 24 }, () => reference) : [];
    });
    fresh.h.exact.mockResolvedValue(fresh.h.events);
    await fresh.h.policies.publishReleasePolicyLifecycleEvent(
      releasePolicyLifecycleFixture("recheck_rows", fresh.h.policy, {
        occurredAt: "2026-09-30T00:00:00.000Z",
      }),
    );
    await expect(
      fresh.run(withLimits(fresh.h.request, { maxAcquisitionRecords: output.usage.records - 1 })),
    ).rejects.toMatchObject({ reason: "record_limit" });
    expect(fresh.state.phase).toBe("rolled_back");
  });
});

describe("fixture-bound artifact capture", () => {
  const id = "art_model_config";

  it.each(["missing_edge", "wrong_edge", "missing_occurrences", "missing_alias", "missing_body"])(
    "fails closed on internal capture composition regression: %s",
    async (kind) => {
      const h = await harness(true);
      const output = await h.execute();
      if (output.status !== "artifacts_captured") throw new Error("Expected capture");
      const graph = structuredClone(output.traceCapture.comparisonCapture.graph);
      let artifacts = [...output.artifacts];
      const node = graph.nodes.find(
        ({ read }) =>
          read.source.kind === "regression_fixture_version" &&
          read.record !== null &&
          "interactionCapture" in read.record,
      );
      if (kind === "missing_body") Object.assign(node?.read as object, { record: null });
      if (kind === "missing_occurrences") artifacts = [];
      if (kind === "missing_alias")
        artifacts = artifacts.filter(({ read }) => read.reference.artifactId !== id);
      if (kind === "missing_edge" || kind === "wrong_edge") {
        const capture = artifacts.find(({ origin }) => origin.kind === "record");
        Object.assign(capture as object, {
          origin: {
            kind: "record",
            edgeIndex:
              kind === "missing_edge"
                ? graph.edges.length
                : graph.edges.findIndex((edge) => edge.reference.kind !== "artifact"),
          },
        });
      }
      expect(() => inspectCapturedFixtureBindings(graph, artifacts)).toThrowError(
        expect.objectContaining({ reason: "observation_conflict" }),
      );
    },
  );

  it("binds actual encrypted content to the published owner, complete fixture and every alias occurrence", async () => {
    const h = await harness(true);
    const output = await h.execute();
    if (output.status !== "artifacts_captured") throw new Error("Expected artifact capture");
    const fixture = h.recordedPublication?.version;
    if (!fixture) throw new Error("Expected recorded fixture");
    expect(output.fixtureBindings).toHaveLength(1);
    const binding = output.fixtureBindings[0];
    expect(binding?.source).toEqual({
      kind: "regression_fixture_version",
      reference: {
        fixtureId: fixture.fixtureId,
        fixtureVersionId: fixture.fixtureVersionId,
        definitionSha256: fixture.definitionSha256,
      },
    });
    expect(binding?.artifacts).toHaveLength(fixture.interactionCapture.artifacts.length);
    const graph = output.traceCapture.comparisonCapture.graph;
    for (const artifact of binding?.artifacts ?? []) {
      expect(artifact.observation).toEqual({ status: "matched" });
      expect(artifact.artifactCaptureIndexes).toHaveLength(2);
      for (const index of artifact.artifactCaptureIndexes) {
        const captured = output.artifacts[index];
        expect(captured?.read.reference.artifactId).toBe(artifact.artifactId);
        expect(captured?.read.catalog?.recordSha256).toBe(artifact.catalogRecordSha256);
        expect(captured?.read.observation.status).toBe("verified");
        if (captured?.origin.kind !== "record")
          throw new Error("Expected fixture graph occurrence");
        expect(graph.edges[captured.origin.edgeIndex]?.parent).toEqual(binding?.source);
        expect(graph.edges[captured.origin.edgeIndex]?.parentRecordSha256).toBe(
          binding?.recordSha256,
        );
      }
    }
    // General candidate/trace artifacts do not inherit fixture ownership rules.
    expect(binding?.artifacts.some((item) => item.artifactId === reference.artifactId)).toBe(false);
    const general = output.artifacts.find(
      ({ read }) => read.reference.artifactId === reference.artifactId,
    );
    expect(general?.read.catalog?.ownership).toBeNull();
    expect(general?.read.observation.status).toBe("verified");
    expect(output.usage.artifacts.reads).toBe(19);
  });

  it.each([
    "missing_owner",
    "wrong_fixture",
    "wrong_version",
    "wrong_publisher",
    "late_binding",
    "early_binding",
    "late_activation",
    "catalog_missing",
    "catalog_invalid",
    "tombstoned",
  ])("retains %s separately from content verification", async (kind) => {
    const h = await harness(true);
    h.find.mockImplementation(async (scope, artifactId) => {
      const entry = await MemoryArtifactCatalogRepository.prototype.find.call(
        h.catalog,
        scope,
        artifactId,
      );
      if (artifactId !== id || !entry) return entry;
      if (kind === "catalog_missing") return null;
      if (kind === "catalog_invalid") Object.assign(entry, { extra: true });
      if (kind === "missing_owner") Reflect.deleteProperty(entry, "ownership");
      if (entry.ownership) {
        if (kind === "wrong_fixture") entry.ownership.owner.fixtureId = "fixture_other";
        if (kind === "wrong_version")
          entry.ownership.owner.fixtureVersionId = "fixture_other_version";
        if (kind === "wrong_publisher") entry.ownership.boundByPrincipalId = "principal_other";
        if (kind === "late_binding") entry.ownership.boundAt = "2026-09-07T00:00:00.000Z";
        if (kind === "early_binding") entry.ownership.boundAt = "2026-09-05T00:00:00.000Z";
      }
      if (kind === "late_activation")
        entry.metadata.availableAt = "2026-09-06T00:00:00.000000000000000000000000000001Z";
      if (kind === "tombstoned") {
        entry.metadata.state = "tombstoned";
        entry.metadata.tombstonedAt = "2026-09-07T00:00:00.000Z";
      }
      return entry;
    });
    const output = await h.execute();
    if (output.status !== "artifacts_captured") throw new Error("Expected observations");
    const binding = output.fixtureBindings[0]?.artifacts.find(
      (binding) => binding.artifactId === id,
    );
    const expected =
      kind === "tombstoned"
        ? { status: "matched" }
        : kind.startsWith("catalog_")
          ? { status: "unavailable", reason: "catalog_unavailable" }
          : {
              status: "mismatch",
              reason:
                kind === "missing_owner"
                  ? "ownership_missing"
                  : kind === "late_activation"
                    ? "publication_time_mismatch"
                    : "ownership_mismatch",
            };
    expect(binding?.observation).toEqual(expected);
    const reads = output.artifacts.filter(({ read }) => read.reference.artifactId === id);
    expect(reads).toHaveLength(2);
    for (const { read } of reads)
      expect(read.observation.status).toBe(
        kind === "catalog_missing"
          ? "missing"
          : kind === "catalog_invalid" || kind === "tombstoned"
            ? "unavailable"
            : "verified",
      );
    expect(output).not.toHaveProperty("verdict");
  });

  it.each(["retention", "redaction"])(
    "detects %s substitution even when the changed catalog has valid authenticated bytes",
    async (kind) => {
      const h = await harness(true);
      const changed = await h.catalog.find(scope, id);
      if (!changed) throw new Error("Expected catalog fixture");
      if (kind === "retention")
        changed.metadata.retention = { mode: "expire", expiresAt: "2027-01-01T00:00:00.000Z" };
      else changed.metadata.redaction = { status: "not_performed" };
      Object.assign(changed, {
        encryption: await h.dependencies.encryption.createPlan(changed.metadata),
      });
      const encrypted = await h.dependencies.encryption.encrypt(
        changed.metadata,
        changed.encryption,
        h.fixtureContents.get(id) as Buffer,
      );
      Object.assign(changed, { objectReceipt: encrypted.receipt });
      h.find.mockImplementation(async (scope, artifactId) =>
        artifactId === id
          ? changed
          : MemoryArtifactCatalogRepository.prototype.find.call(h.catalog, scope, artifactId),
      );
      h.get.mockImplementation(async (key) =>
        key === changed.objectKey
          ? encrypted.bytes
          : MemoryArtifactObjectStore.prototype.get.call(h.dependencies.objects, key),
      );
      const output = await h.execute();
      if (output.status !== "artifacts_captured") throw new Error("Expected observations");
      expect(
        output.fixtureBindings[0]?.artifacts.find((binding) => binding.artifactId === id)
          ?.observation,
      ).toEqual({ status: "mismatch", reason: `${kind}_mismatch` });
      expect(
        output.artifacts
          .filter(({ read }) => read.reference.artifactId === id)
          .every(({ read }) => read.observation.status === "verified"),
      ).toBe(true);
    },
  );

  it("does not promote matching ownership to retained content when objects are missing", async () => {
    const h = await harness(true);
    h.get.mockResolvedValue(null);
    const output = await h.execute();
    if (output.status !== "artifacts_captured") throw new Error("Expected observations");
    expect(
      output.fixtureBindings[0]?.artifacts.every(
        (binding) => binding.observation.status === "matched",
      ),
    ).toBe(true);
    expect(
      output.artifacts
        .filter(({ read }) => read.reference.artifactId === id)
        .every(
          ({ read }) =>
            read.observation.status === "unavailable" &&
            read.observation.reason === "object_missing",
        ),
    ).toBe(true);
  });

  it("retains an unreadable fixture as unresolved, never inventing its binding inventory", async () => {
    const h = await harness(true);
    vi.spyOn(h.repositories.datasets, "findRecordedInteractionFixtureVersion").mockResolvedValue(
      null,
    );
    const output = await h.execute();
    if (output.status !== "artifacts_captured") throw new Error("Expected observations");
    expect(output.fixtureBindings).toEqual([]);
    const relations = output.traceCapture.comparisonCapture.graph.datasetRelations;
    expect(relations.unavailableParents).toContainEqual({
      source: {
        kind: "regression_fixture_version",
        reference: {
          fixtureId: "fixture_artifact",
          fixtureVersionId: "fixture_artifact_v2",
          definitionSha256: h.recordedPublication?.version.definitionSha256,
        },
      },
      observation: { status: "missing" },
    });
    expect(relations.parents.flatMap((parent) => parent.relations)).toContainEqual({
      kind: "dataset_member",
      path: "/fixtureVersions/0",
      source: relations.unavailableParents.find(
        (parent) =>
          parent.source.kind === "regression_fixture_version" &&
          parent.source.reference.fixtureVersionId === "fixture_artifact_v2",
      )?.source,
      recordObservation: { status: "missing" },
      observation: { status: "unavailable" },
    });
    expect(
      output.traceCapture.comparisonCapture.graph.entries.some(
        (entry) =>
          entry.source.kind === "regression_fixture_version" &&
          entry.source.reference.fixtureVersionId === "fixture_artifact_v2" &&
          entry.observation.status === "missing",
      ),
    ).toBe(true);
  });
});

describe("dataset relationships retained through public capture", () => {
  it("joins published dataset and promotion records with their exact graph provenance and no extra reads", async () => {
    const h = await harness(true);
    const datasetRead = vi.spyOn(h.repositories.datasets, "findDatasetVersion");
    const fixtureRead = vi.spyOn(h.repositories.datasets, "findFixtureVersion");
    const recordedRead = vi.spyOn(h.repositories.datasets, "findRecordedInteractionFixtureVersion");
    const output = await h.execute();
    if (output.status !== "artifacts_captured") throw new Error("Expected captured evidence");
    const graph = output.traceCapture.comparisonCapture.graph;
    const report = graph.datasetRelations;
    expect(report.parents).toHaveLength(3);
    expect(report.parents.flatMap((parent) => parent.relations)).toHaveLength(2);
    for (const parent of report.parents) {
      const node = graph.nodes.find(
        ({ read }) =>
          policyEvaluationSourceReferenceKey(read.source) ===
          policyEvaluationSourceReferenceKey(parent.source),
      );
      expect(node?.read.observation).toEqual({
        status: "verified",
        recordSha256: parent.recordSha256,
      });
      for (const relation of parent.relations) {
        expect(relation.observation).toEqual({ status: "matched" });
        expect(graph.edges).toContainEqual({
          parent: parent.source,
          parentRecordSha256: parent.recordSha256,
          reference: { kind: "record", path: relation.path, source: relation.source },
          target: relation.source,
        });
        const target = graph.nodes.find(
          ({ read }) =>
            policyEvaluationSourceReferenceKey(read.source) ===
            policyEvaluationSourceReferenceKey(relation.source),
        );
        expect(relation.recordObservation).toEqual(target?.read.observation);
      }
    }
    const datasetNodes = graph.nodes.filter(({ read }) => read.source.kind === "dataset_version");
    const fixtureNodes = graph.nodes.filter(
      ({ read }) => read.source.kind === "regression_fixture_version",
    );
    expect(datasetRead).toHaveBeenCalledTimes(datasetNodes.length);
    expect(fixtureRead).toHaveBeenCalledTimes(fixtureNodes.length);
    expect(recordedRead).toHaveBeenCalledTimes(fixtureNodes.length);
    for (const read of [datasetRead, fixtureRead, recordedRead]) {
      expect(new Set(read.mock.calls.map(([, id]) => id)).size).toBe(read.mock.calls.length);
      for (const [actualScope] of read.mock.calls) expect(actualScope).toEqual(scope);
    }
    expect(output.usage.artifacts.reads).toBe(19);
    expect(output).not.toHaveProperty("verdict");
  });

  it("detects a substituted snapshot receipt even when definition hashes, bytes and artifact ownership still match", async () => {
    const h = await harness(true);
    const baseline = await publicApi.capturePolicyRecordGraph(h.request, h.repositories);
    const findRecorded = h.repositories.datasets.findRecordedInteractionFixtureVersion.bind(
      h.repositories.datasets,
    );
    vi.spyOn(h.repositories.datasets, "findRecordedInteractionFixtureVersion").mockImplementation(
      async (scope, id) => {
        const captured = await findRecorded(scope, id);
        // Controlled corrupt-adapter response, not a supported publication. The instant and
        // definition are unchanged, but the copied full snapshot receipt differs from its parent.
        if (captured) captured.version.source.capturedAt = "2026-09-05T00:00:00.0000Z";
        return captured;
      },
    );
    const output = await h.execute();
    if (output.status !== "artifacts_captured") throw new Error("Expected captured observations");
    const graph = output.traceCapture.comparisonCapture.graph;
    const parent = graph.datasetRelations.parents.find(
      ({ source }) =>
        source.kind === "regression_fixture_version" &&
        source.reference.fixtureVersionId === "fixture_artifact_v2",
    );
    const original = baseline.datasetRelations.parents.find(
      ({ source }) =>
        source.kind === "regression_fixture_version" &&
        source.reference.fixtureVersionId === "fixture_artifact_v2",
    );
    expect(parent?.source).toEqual(original?.source);
    expect(parent?.recordSha256).not.toBe(original?.recordSha256);
    expect(parent?.relations[0]?.observation).toEqual({
      status: "mismatch",
      reason: "trace_snapshot_mismatch",
    });
    expect(
      output.fixtureBindings[0]?.artifacts.every((item) => item.observation.status === "matched"),
    ).toBe(true);
    for (const artifact of output.artifacts.filter(({ read }) => read.catalog?.ownership))
      expect(artifact.read.observation.status).toBe("verified");
    // Exact dataset membership is a direct relation, not transitive fixture eligibility.
    expect(
      graph.datasetRelations.parents.find(({ source }) => source.kind === "dataset_version")
        ?.relations[0]?.observation,
    ).toEqual({ status: "matched" });
    expect(output).not.toHaveProperty("verdict");
  });

  it.each(["missing", "record_invalid", "reference_mismatch", "not_yet_available"])(
    "retains an unreadable predecessor (%s) separately from verified child bytes",
    async (reason) => {
      const h = await harness(true);
      const findFixture = h.repositories.datasets.findFixtureVersion.bind(h.repositories.datasets);
      vi.spyOn(h.repositories.datasets, "findFixtureVersion").mockImplementation(
        async (scope, id) => {
          const captured = await findFixture(scope, id);
          if (!captured) return null;
          if (reason === "missing") return null;
          if (reason === "record_invalid") Object.assign(captured, { unexpected: true });
          if (reason === "reference_mismatch") {
            captured.fixtureId = "fixture_other";
            captured.definitionSha256 = digestRegressionFixtureVersionDefinition({
              ...h.fixtureDefinition,
              fixtureId: captured.fixtureId,
            });
          }
          if (reason === "not_yet_available") captured.createdAt = "2027-01-01T00:00:00.000Z";
          return captured;
        },
      );
      const output = await h.execute();
      if (output.status !== "artifacts_captured") throw new Error("Expected capture");
      const report = output.traceCapture.comparisonCapture.graph.datasetRelations;
      const observation =
        reason === "missing" ? { status: "missing" } : { status: "unavailable", reason };
      const expectedSource = {
        kind: "regression_fixture_version",
        reference: {
          fixtureId: h.fixture.fixtureId,
          fixtureVersionId: h.fixture.fixtureVersionId,
          definitionSha256: h.fixture.definitionSha256,
        },
      };
      expect(report.unavailableParents).toContainEqual({ source: expectedSource, observation });
      const predecessor = report.parents
        .flatMap((parent) => parent.relations)
        .find((relation) => relation.kind === "fixture_predecessor");
      expect(predecessor).toEqual({
        kind: "fixture_predecessor",
        path: "/predecessor",
        source: expectedSource,
        recordObservation: observation,
        observation: { status: "unavailable" },
      });
      expect(
        output.fixtureBindings[0]?.artifacts.every((item) => item.observation.status === "matched"),
      ).toBe(true);
      expect(output).not.toHaveProperty("verdict");
    },
  );

  it("does not turn predecessor storage failure into an unavailable or successful report", async () => {
    const h = await harness(true);
    const failure = new Error("Dataset storage unavailable");
    vi.spyOn(h.repositories.datasets, "findFixtureVersion").mockRejectedValue(failure);
    await expect(h.execute()).rejects.toBe(failure);
    expect(h.find).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
  });
});

describe("candidate-owned artifact rule bindings", () => {
  async function setup(alias = false) {
    return harness(false, 1, {
      mutateCandidate(candidate) {
        for (const component of candidate.runtimeComponents) {
          if (component.kind !== "model") component.content = structuredClone(reference);
          else if (alias)
            component.resolution = {
              status: "provider_alias_only",
              declaredAlias: "provider-live-alias",
              limitation: "No independently retained model version is available.",
            };
          else if (component.resolution.status === "exact")
            component.resolution.resolutionEvidence = structuredClone(reference);
        }
      },
      mutatePolicy(policy) {
        const template = policy.rules[0];
        if (!template) throw new Error("Missing original policy rule");
        const declarations = [
          ["build_artifact", "agent_bundle"],
          ["model_resolution", "primary_model"],
          ["prompt", "system_prompt"],
          ["tool_contract", "payment_tool"],
          ["tool_contract", "refund_tool"],
          ["prompt", "absent_prompt"],
          ["build_artifact", "agent_bundle"],
        ] as const;
        declarations.forEach(([componentKind, role], index) => {
          policy.rules.push({
            ...structuredClone(template),
            ruleId: `bound_${index}`,
            predicate: {
              kind: "artifact_required",
              componentKind,
              role,
              requireDigest: true,
              allowedMediaTypes: ["text/plain"],
              maximumDataClassification: "confidential",
            },
          });
        });
        policy.rules.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
      },
    });
  }

  it("binds all four component kinds, unused members and repeated rules to original encrypted captures", async () => {
    const h = await setup();
    const output = await h.execute();
    if (output.status !== "artifacts_captured") throw new Error("Expected observations");
    const graph = output.traceCapture.comparisonCapture.graph;
    const bindings = output.artifactRules;
    expect(bindings.members.map((m) => [m.componentKind, m.role, m.candidatePath])).toEqual([
      ["build_artifact", "agent_bundle", "/buildArtifacts/0/artifact"],
      ["build_artifact", "sbom", "/buildArtifacts/1/artifact"],
      ["model_resolution", "primary_model", "/runtimeComponents/0/resolution/resolutionEvidence"],
      ["prompt", "system_prompt", "/runtimeComponents/1/content"],
      ["tool_contract", "payment_tool", "/runtimeComponents/2/content"],
    ]);
    for (const member of bindings.members) {
      const edge = graph.edges[member.candidateEdgeIndex];
      expect(edge?.reference.path).toBe(member.candidatePath);
      expect(edge?.parentRecordSha256).toBe(bindings.candidate.recordSha256);
      if (member.status !== "artifact_declared") throw new Error("Expected exact artifact");
      expect(output.artifacts[member.artifactCaptureIndex]?.origin).toEqual({
        kind: "record",
        edgeIndex: member.candidateEdgeIndex,
      });
      expect(output.artifacts[member.artifactCaptureIndex]?.read.observation).toEqual(
        member.role === "sbom"
          ? { status: "missing" }
          : {
              status: "verified",
              sha256: reference.sha256,
              sizeBytes: content.byteLength,
            },
      );
    }
    const rules = bindings.rules.filter((r) => r.ruleId.startsWith("bound_"));
    expect(rules.map((r) => r.binding)).toEqual([
      { status: "component_present", memberIndex: 0 },
      { status: "component_present", memberIndex: 2 },
      { status: "component_present", memberIndex: 3 },
      { status: "component_present", memberIndex: 4 },
      { status: "component_missing", omission: h.candidate.omissions[0] },
      { status: "component_missing", omission: null },
      { status: "component_present", memberIndex: 0 },
    ]);
    for (const rule of rules) {
      expect(h.policy.rules[rule.ruleIndex]?.predicate).toEqual(rule.predicate);
      expect(graph.edges[rule.policyEdgeIndex]?.parentRecordSha256).toBe(
        bindings.policy.recordSha256,
      );
    }
    expect(h.decrypt).toHaveBeenCalledTimes(6);
    expect(bindings).not.toHaveProperty("outcome");
    expect(publicApi).not.toHaveProperty("inspectCapturedArtifactRules");
  });

  it("retains alias-only models as present declarations without inventing resolution evidence", async () => {
    const h = await setup(true);
    const output = await h.execute();
    if (output.status !== "artifacts_captured") throw new Error("Expected observations");
    expect(output.artifactRules.members[2]).toMatchObject({
      status: "model_alias",
      componentKind: "model_resolution",
      role: "primary_model",
      candidatePath: "/runtimeComponents/0",
      declaration: {
        resolution: { status: "provider_alias_only", declaredAlias: "provider-live-alias" },
      },
    });
    expect(output.artifactRules.members[2]).not.toHaveProperty("artifactCaptureIndex");
    expect(output.artifactRules.rules.find((r) => r.ruleId === "bound_1")?.binding).toEqual({
      status: "component_present",
      memberIndex: 2,
    });
    expect(h.decrypt).toHaveBeenCalledTimes(5);
  });

  it("keeps present-but-unavailable bytes separate from a genuinely absent component", async () => {
    const h = await setup();
    h.get.mockResolvedValue(null);
    const output = await h.execute();
    if (output.status !== "artifacts_captured") throw new Error("Expected observations");
    const rule = output.artifactRules.rules.find((r) => r.ruleId === "bound_0");
    expect(rule?.binding).toEqual({ status: "component_present", memberIndex: 0 });
    const member = output.artifactRules.members[0];
    if (member?.status !== "artifact_declared") throw new Error("Expected declaration");
    expect(output.artifacts[member.artifactCaptureIndex]?.read).toMatchObject({
      catalog: { metadata: { contentReference: reference } },
      observation: { status: "unavailable", reason: "object_missing" },
    });
    expect(output.artifactRules.rules.find((r) => r.ruleId === "bound_5")?.binding).toEqual({
      status: "component_missing",
      omission: null,
    });
    expect(h.decrypt).not.toHaveBeenCalled();
  });

  it("retains incompatible declared media and classification bounds without turning verified bytes into a policy outcome", async () => {
    const h = await harness(false, 1, {
      mutatePolicy(policy) {
        const rule = policy.rules.find((r) => r.predicate.kind === "artifact_required");
        if (rule?.predicate.kind !== "artifact_required") throw new Error("Missing artifact rule");
        rule.predicate.allowedMediaTypes = ["application/json"];
        rule.predicate.maximumDataClassification = "metadata";
      },
    });
    const output = await h.execute();
    if (output.status !== "artifacts_captured") throw new Error("Expected observations");
    expect(output.artifactRules.rules[0]).toMatchObject({
      predicate: { allowedMediaTypes: ["application/json"], maximumDataClassification: "metadata" },
      binding: { status: "component_present", memberIndex: 0 },
    });
    expect(output.artifactRules.members[0]).toMatchObject({ reference });
    expect(output.artifactRules.rules[0]).not.toHaveProperty("outcome");
  });

  it.each([
    "candidate_body",
    "candidate_receipt",
    "missing_root",
    "duplicate_node",
    "graph_scope",
    "graph_time",
    "duplicate_edge",
    "edge_hash",
    "edge_target",
    "edge_reference",
    "rule_path",
    "missing_capture",
    "duplicate_capture",
    "capture_scope",
    "capture_time",
    "catalog_scope",
    "catalog_reference",
    "verified_without_catalog",
    "verified_digest",
    "verified_size",
  ])("rejects broken internal provenance: %s", async (fault) => {
    const h = await setup();
    const output = await h.execute();
    if (output.status !== "artifacts_captured") throw new Error("Expected observations");
    const graph = structuredClone(output.traceCapture.comparisonCapture.graph);
    const artifacts = output.artifacts.map((capture) => structuredClone(capture));
    const member = output.artifactRules.members[0];
    if (member?.status !== "artifact_declared") throw new Error("Missing exact component");
    const node = graph.nodes.find((n) => n.read.source.kind === "release_candidate");
    const edge = graph.edges[member.candidateEdgeIndex];
    const capture = artifacts[member.artifactCaptureIndex];
    if (!node || !edge || !capture) throw new Error("Missing original provenance");
    const candidate = node.read.record as ReleaseCandidate;
    if (fault === "candidate_body") candidate.name += " changed";
    if (fault === "candidate_receipt") candidate.createdByPrincipalId = "substituted_actor";
    if (fault === "missing_root")
      Reflect.set(
        graph,
        "nodes",
        graph.nodes.filter((n) => n !== node),
      );
    if (fault === "duplicate_node")
      Reflect.set(graph, "nodes", [...graph.nodes, structuredClone(node)]);
    if (fault === "graph_scope") graph.scope.environmentId = "other_environment";
    if (fault === "graph_time") Reflect.set(graph, "evaluationTime", "2026-10-01T00:00:00.001Z");
    if (fault === "duplicate_edge")
      Reflect.set(graph, "edges", [...graph.edges, structuredClone(edge)]);
    if (fault === "edge_hash") Reflect.set(edge, "parentRecordSha256", "f".repeat(64));
    if (fault === "edge_target") Reflect.set(edge, "target", output.artifactRules.candidate.source);
    if (fault === "edge_reference" && edge.reference.kind === "artifact")
      edge.reference.reference.sizeBytes++;
    if (fault === "rule_path") {
      const rule = output.artifactRules.rules.find((r) => r.ruleId === "bound_0");
      if (!rule) throw new Error("Missing original artifact rule");
      const ruleEdge = graph.edges[rule.policyEdgeIndex];
      if (!ruleEdge) throw new Error("Missing rule edge");
      Reflect.set(ruleEdge.reference, "path", "/rules/999/predicate");
    }
    if (fault === "missing_capture") artifacts.splice(member.artifactCaptureIndex, 1);
    if (fault === "duplicate_capture") artifacts.push(structuredClone(capture));
    if (fault === "capture_scope") capture.read.scope.environmentId = "other_environment";
    if (fault === "capture_time")
      Reflect.set(capture.read, "evaluationTime", "2026-10-01T00:00:00.001Z");
    if (fault === "catalog_scope" && capture.read.catalog)
      capture.read.catalog.metadata.scope.environmentId = "other_environment";
    if (fault === "catalog_reference" && capture.read.catalog)
      capture.read.catalog.metadata.contentReference.sizeBytes++;
    if (fault === "verified_without_catalog") Reflect.set(capture.read, "catalog", null);
    if (fault === "verified_digest" && capture.read.observation.status === "verified")
      Reflect.set(capture.read.observation, "sha256", "f".repeat(64));
    if (fault === "verified_size" && capture.read.observation.status === "verified")
      Reflect.set(capture.read.observation, "sizeBytes", capture.read.observation.sizeBytes + 1);
    expect(() =>
      inspectCapturedArtifactRules(h.request, graph, artifacts, {
        maxReferences: h.request.limits.maxAcquisitionRecords,
        maxReferenceBytes: h.request.limits.maxAcquisitionRecordBytes,
      }),
    ).toThrow();
  });

  it("charges complete parent and repeated rule inspection at exact and one-below boundaries", async () => {
    const h = await setup();
    const output = await h.execute();
    if (output.status !== "artifacts_captured") throw new Error("Expected observations");
    const graph = output.traceCapture.comparisonCapture.graph;
    const usage = output.artifactRules.inspectionUsage;
    const parentReferences = graph.nodes
      .filter(
        ({ read }) =>
          read.source.kind === "release_candidate" || read.source.kind === "release_policy",
      )
      .flatMap(({ references }) => references ?? []);
    const componentReferences = graph.edges
      .filter(
        (edge) =>
          edge.parent.kind === "release_candidate" &&
          edge.reference.kind === "artifact" &&
          (edge.reference.path.startsWith("/buildArtifacts/") ||
            edge.reference.path.startsWith("/runtimeComponents/")),
      )
      .map((edge) => edge.reference);
    const ruleReferences = graph.edges
      .filter(
        (edge) =>
          edge.parent.kind === "release_policy" &&
          edge.reference.kind === "control_declaration" &&
          edge.reference.declaration.kind === "artifact_requirement",
      )
      .map((edge) => edge.reference);
    // The independent fixture has six matching artifact rules: the original bundle rule and
    // bound_0/1/2/3/6. Both absent roles stay declarations without an invented artifact reference.
    const matchingReferences = ruleReferences.flatMap((rule) =>
      rule.kind === "control_declaration" &&
      rule.declaration.kind === "artifact_requirement" &&
      !["refund_tool", "absent_prompt"].includes(rule.declaration.reference.role)
        ? [{ kind: "artifact", path: rule.path, reference }]
        : [],
    );
    expect(componentReferences).toHaveLength(5);
    expect(matchingReferences).toHaveLength(6);
    const expected = [
      ...parentReferences,
      ...componentReferences,
      ...ruleReferences,
      ...matchingReferences,
    ];
    expect(usage).toEqual({
      references: expected.length,
      referenceBytes: expected.reduce(
        (sum, item) => sum + encodeEvaluationCanonicalJson(item).byteLength,
        0,
      ),
    });
    const exact = { maxReferences: usage.references, maxReferenceBytes: usage.referenceBytes };
    expect(inspectCapturedArtifactRules(h.request, graph, output.artifacts, exact)).toEqual(
      output.artifactRules,
    );
    expect(() =>
      inspectCapturedArtifactRules(h.request, graph, output.artifacts, {
        ...exact,
        maxReferences: exact.maxReferences - 1,
      }),
    ).toThrow(expect.objectContaining({ reason: "reference_limit_exceeded" }));
    expect(() =>
      inspectCapturedArtifactRules(h.request, graph, output.artifacts, {
        ...exact,
        maxReferenceBytes: exact.maxReferenceBytes - 1,
      }),
    ).toThrow(expect.objectContaining({ reason: "reference_bytes_exceeded" }));
    const cumulative = withLimits(h.request, {
      maxAcquisitionRecords: output.usage.references,
      maxAcquisitionRecordBytes: output.usage.bytes + output.usage.referenceBytes,
    });
    const fresh = await setup();
    expect((await fresh.execute(cumulative)).usage).toEqual(output.usage);
    const fewer = await setup();
    await expect(
      fewer.execute(
        withLimits(cumulative, {
          maxAcquisitionRecords: cumulative.limits.maxAcquisitionRecords - 1,
        }),
      ),
    ).rejects.toMatchObject({ code: "policy_record_graph_failed", reason: "reference_limit" });
    const fewerBytes = await setup();
    await expect(
      fewerBytes.execute(
        withLimits(cumulative, {
          maxAcquisitionRecordBytes: cumulative.limits.maxAcquisitionRecordBytes - 1,
        }),
      ),
    ).rejects.toMatchObject({ code: "policy_record_graph_failed", reason: "byte_limit" });
  });

  it("bounds complete parent inspection cumulatively before resolving component occurrences", async () => {
    const h = await setup();
    const output = await h.execute();
    if (output.status !== "artifacts_captured") throw new Error("Expected observations");
    const graph = output.traceCapture.comparisonCapture.graph;
    const parents = graph.nodes.filter(
      ({ read }) =>
        read.source.kind === "release_candidate" || read.source.kind === "release_policy",
    );
    const referenceCount = parents.reduce(
      (sum, parent) => sum + (parent.references?.length ?? 0),
      0,
    );
    const referenceBytes = parents
      .flatMap((parent) => parent.references ?? [])
      .reduce((sum, item) => sum + encodeEvaluationCanonicalJson(item).byteLength, 0);
    expect(() =>
      inspectCapturedArtifactRules(h.request, graph, output.artifacts, {
        maxReferences: referenceCount - 1,
        maxReferenceBytes: h.request.limits.maxAcquisitionRecordBytes,
      }),
    ).toThrow(expect.objectContaining({ reason: "reference_limit_exceeded" }));
    expect(() =>
      inspectCapturedArtifactRules(h.request, graph, output.artifacts, {
        maxReferences: h.request.limits.maxAcquisitionRecords,
        maxReferenceBytes: referenceBytes - 1,
      }),
    ).toThrow(expect.objectContaining({ reason: "reference_bytes_exceeded" }));
  });

  it("owns every returned declaration and index without mutating retained graph or artifact inputs", async () => {
    const h = await setup(true);
    const output = await h.execute();
    if (output.status !== "artifacts_captured") throw new Error("Expected observations");
    const graph = output.traceCapture.comparisonCapture.graph;
    const prior = structuredClone({ graph, artifacts: output.artifacts });
    const report = structuredClone(
      inspectCapturedArtifactRules(h.request, graph, output.artifacts, {
        maxReferences: h.request.limits.maxAcquisitionRecords,
        maxReferenceBytes: h.request.limits.maxAcquisitionRecordBytes,
      }),
    );
    report.candidate.source.reference.candidateId = "mutated_return";
    const firstMember = report.members[0];
    if (!firstMember) throw new Error("Missing first member");
    Reflect.set(firstMember, "role", "mutated_role");
    const alias = report.members[2];
    if (alias?.status !== "model_alias") throw new Error("Missing model alias");
    alias.declaration.providerId = "mutated_provider";
    const rule = report.rules.find((r) => r.ruleId === "bound_4");
    if (rule?.binding.status !== "component_missing" || !rule.binding.omission)
      throw new Error("Missing original omission");
    rule.binding.omission.rationale = "mutated omission";
    expect({ graph, artifacts: output.artifacts }).toEqual(prior);
    expect(output.artifactRules.candidate.source.reference.candidateId).toBe(
      h.candidate.candidateId,
    );
  });
});
