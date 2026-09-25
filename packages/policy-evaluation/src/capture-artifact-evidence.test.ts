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
  EvidenceEnvelopeSchema,
  POLICY_EVALUATION_REQUEST_SCHEMA_VERSION,
  type PolicyEvaluationRequest,
  type PolicyEvaluationRequestDefinition,
  policyEvaluationSourceReferenceKey,
  PrincipalContextSchema,
  type RecordedInteractionFixtureVersionDefinition,
  type RegressionDatasetVersionDefinition,
  type RegressionFixtureVersionDefinition,
} from "@proofstack/contracts";
import {
  digestPolicyEvaluationRequestDefinition,
  digestReleaseCandidateDefinition,
  releaseCandidateReference,
  releasePolicyReference,
} from "@proofstack/core";
import {
  comparisonFixtureScope,
  MemoryEvidenceRepository,
  MemoryReleaseCandidateRepository,
  MemoryReleasePolicyRepository,
  releaseCandidateFixture,
  releasePolicyRepositoryFixture,
} from "@proofstack/core/testing";
import {
  digestRecordedInteractionFixtureVersionDefinition,
  digestRegressionDatasetVersionDefinition,
  digestRegressionFixtureVersionDefinition,
} from "@proofstack/datasets";
import { MemoryRegressionVersionRepository } from "@proofstack/datasets/testing";
import { describe, expect, it, vi } from "vitest";
import { capturePolicyArtifactEvidence } from "./capture-artifact-evidence.js";
import { inspectCapturedFixtureBindings } from "./capture-fixture-bindings.js";
import * as publicApi from "./index.js";
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

async function harness(recorded = false) {
  const datasets = new MemoryRegressionVersionRepository();
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
      eventIds: ["event_artifact"],
      observedEventCount: 1,
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
  const candidates = new MemoryReleaseCandidateRepository();
  const policies = new MemoryReleasePolicyRepository();
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
  } as unknown as PolicyRecordGraphRepositories;
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
  await evidence.append([event]);
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
    recordedPublication,
    fixtureContents,
    fixture,
    fixtureDefinition,
  };
}

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
    expect(h.exact).toHaveBeenCalledTimes(1);
    expect(h.get).toHaveBeenCalledTimes(3);
    expect(output.usage.reads).toBe(output.traceCapture.usage.reads + h.find.mock.calls.length);
    expect(output.usage.records).toBe(output.traceCapture.usage.records + h.find.mock.calls.length);
    expect(output.usage.references).toBe(output.traceCapture.usage.references);
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
    expect(output.usage.artifacts).toEqual({
      reads: 0,
      reservedBytes: 0,
      receivedBytes: 0,
      chargedBytes: 0,
    });
    expect(h.find).not.toHaveBeenCalled();
  });

  it("uses remaining record and raw JSON byte budgets rather than resetting after traces", async () => {
    const h = await harness();
    // Each available occurrence needs two catalog reads. Make that dimension dominate the
    // separately enforced reference count so this test specifically reaches record admission.
    h.event.evidence.contentReferences = Array.from({ length: 20 }, () => reference);
    h.exact.mockResolvedValue([h.event]);
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
