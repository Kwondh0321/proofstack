import {
  type ContentReference,
  type EvidenceEnvelope,
  EvidenceEnvelopeSchema,
  POLICY_EVALUATION_REQUEST_SCHEMA_VERSION,
  type PolicyEvaluationRequest,
  type PolicyEvaluationRequestDefinition,
  REGRESSION_DATASET_VERSION_SCHEMA_VERSION,
  REGRESSION_FIXTURE_VERSION_SCHEMA_VERSION,
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
  digestRegressionDatasetVersionDefinition,
  digestRegressionFixtureVersionDefinition,
} from "@proofstack/datasets";
import { MemoryRegressionVersionRepository } from "@proofstack/datasets/testing";
import { describe, expect, it, vi } from "vitest";
import { capturePolicyRecordGraph } from "./capture-record-graph.js";
import { capturePolicyTraceEvidence } from "./capture-trace-evidence.js";
import * as publicApi from "./index.js";
import type { PolicyRecordGraphRepositories } from "./record-routing.js";

const scope = comparisonFixtureScope("trace_graph");
const traceId = "0123456789abcdef0123456789abcdef";
const capturedAt = "2026-09-05T00:00:00.000Z";
const artifact: ContentReference = {
  artifactId: "artifact_trace",
  classification: "internal",
  mediaType: "text/plain",
  sha256: "d".repeat(64),
  sizeBytes: 10,
};
const limits: PolicyEvaluationRequestDefinition["limits"] = {
  heartbeatIntervalMilliseconds: 1000,
  leaseDurationMilliseconds: 5000,
  maxAcquisitionRecordBytes: 8_388_608,
  maxAcquisitionRecords: 10000,
  maxArtifactReadBytes: 0,
  maxAttempts: 2,
  maxRuleEvaluations: 256,
  perAttemptTimeoutMilliseconds: 20000,
  retryBackoffMilliseconds: 100,
  retryableErrors: ["source_revision_changed"],
  totalDeadlineMilliseconds: 60000,
};

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing trace test fixture");
  return value;
}

function event(id: string, contentReferences = [artifact, artifact]): EvidenceEnvelope {
  return EvidenceEnvelopeSchema.parse({
    schemaVersion: "0.1",
    scope,
    receivedAt: "2026-09-04T00:00:00.000Z",
    evidence: {
      eventId: id,
      traceId,
      spanId: "0123456789abcdef",
      startedAt: "2026-09-04T00:00:00.000Z",
      kind: "agent.run",
      name: id,
      contentReferences,
      source: { sdkName: "fixture", sdkVersion: "1.0.0", serviceName: "trace_test" },
    },
  });
}

function withLimits(
  request: PolicyEvaluationRequest,
  next: Partial<typeof limits>,
): PolicyEvaluationRequest {
  const {
    createdAt,
    createdByPrincipalId,
    definitionSha256: _hash,
    schemaVersion,
    scope,
    ...definition
  } = request;
  const body = { ...definition, limits: { ...definition.limits, ...next } };
  return {
    ...body,
    createdAt,
    createdByPrincipalId,
    schemaVersion,
    scope,
    definitionSha256: digestPolicyEvaluationRequestDefinition(scope, body),
  };
}

async function harness(selectors = [["event_one", "event_two"]]) {
  const datasets = new MemoryRegressionVersionRepository();
  const fixtures = selectors.map((eventIds, index) => {
    const definition: RegressionFixtureVersionDefinition = {
      fixtureId: `fixture_trace_${index}`,
      fixtureVersionId: `fixture_trace_${index}_v1`,
      name: "Exact trace fixture",
      replayability: "evidence_only",
      schemaVersion: REGRESSION_FIXTURE_VERSION_SCHEMA_VERSION,
      scope,
      source: {
        kind: "trace_snapshot",
        traceId,
        eventIds,
        observedEventCount: eventIds.length,
        sourceCompleteness: "observed_snapshot",
      },
    };
    return {
      ...definition,
      source: { ...definition.source, capturedAt },
      createdAt: capturedAt,
      createdByPrincipalId: "principal_fixture",
      definitionSha256: digestRegressionFixtureVersionDefinition(definition),
    };
  });
  for (const fixture of fixtures) await datasets.publishFixtureVersion(fixture);
  const datasetDefinition: RegressionDatasetVersionDefinition = {
    datasetId: "dataset_trace",
    datasetVersionId: "dataset_trace_v1",
    name: "Exact trace dataset",
    scope,
    schemaVersion: REGRESSION_DATASET_VERSION_SCHEMA_VERSION,
    fixtureVersions: fixtures.map(({ fixtureId, fixtureVersionId, definitionSha256 }) => ({
      fixtureId,
      fixtureVersionId,
      definitionSha256,
    })),
  };
  const dataset = {
    ...datasetDefinition,
    createdAt: capturedAt,
    createdByPrincipalId: "principal_dataset",
    definitionSha256: digestRegressionDatasetVersionDefinition(datasetDefinition),
  };
  await datasets.publishDatasetVersion(dataset);
  const candidate = releaseCandidateFixture("trace_graph", scope);
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
  const policy = releasePolicyRepositoryFixture("trace_graph", scope);
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
    evaluationRequestId: "request_trace",
    evaluationTime: "2026-10-01T00:00:00.000Z",
    candidate: releaseCandidateReference(candidate),
    policy: releasePolicyReference(policy),
    limits,
  };
  const request: PolicyEvaluationRequest = {
    ...definition,
    schemaVersion: POLICY_EVALUATION_REQUEST_SCHEMA_VERSION,
    scope,
    createdAt: "2026-10-01T01:00:00.000Z",
    createdByPrincipalId: "principal_request",
    definitionSha256: digestPolicyEvaluationRequestDefinition(scope, definition),
  };
  const evidence = new MemoryEvidenceRepository();
  const events = [...new Set(selectors.flat())].map((id) => event(id));
  await evidence.append([...events, event("event_not_requested")]);
  const exact = vi.spyOn(evidence, "resolveExactEvents");
  const pages = vi.spyOn(evidence, "listByTrace");
  return { request, repositories, evidence, exact, pages, events, fixtures, candidate };
}

describe("request-rooted exact trace capture", () => {
  it("connects exact parent-bound events and repeated artifact occurrences under one acquisition budget", async () => {
    const h = await harness();
    const output = await capturePolicyTraceEvidence(h.request, h.repositories, h.evidence);
    if (output.status !== "traces_captured") throw new Error("Expected trace captures");
    expect(output.comparisonCapture.status).toBe("inventory_captured");
    expect(output.traces).toHaveLength(1);
    const capture = required(output.traces[0]);
    expect(capture.read.events).toEqual(h.events);
    expect(capture.read.observation.status).toBe("verified");
    const parent = output.comparisonCapture.graph.edges[capture.edgeIndex];
    expect(parent).toMatchObject({
      parent: { kind: "regression_fixture_version" },
      parentRecordSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      reference: {
        path: "/source",
        kind: "trace_snapshot_selector",
        selector: required(h.fixtures[0]).source,
      },
    });
    expect(output.artifactReferences).toHaveLength(4);
    expect(output.artifactReferences.map(({ path }) => path)).toEqual([
      "/events/0/evidence/contentReferences/0",
      "/events/0/evidence/contentReferences/1",
      "/events/1/evidence/contentReferences/0",
      "/events/1/evidence/contentReferences/1",
    ]);
    expect(h.exact).toHaveBeenCalledExactlyOnceWith(scope, traceId, ["event_one", "event_two"]);
    expect(h.pages).not.toHaveBeenCalled();
    expect(output.usage.reads).toBe(output.comparisonCapture.graph.usage.reads + 1);
    expect(output.usage.records).toBe(output.comparisonCapture.graph.usage.records + 3);
    expect(output.usage.references).toBe(output.comparisonCapture.graph.usage.references + 4);
    expect(output.usage.bytes).toBe(
      output.comparisonCapture.graph.usage.bytes + Buffer.byteLength(JSON.stringify(h.events)),
    );
    expect(output).not.toHaveProperty("sealed");
    expect(output).not.toHaveProperty("verdict");
  });

  it("retains identical trace selectors from distinct parents without erasing occurrences", async () => {
    const h = await harness([["event_one"], ["event_one"]]);
    const output = await capturePolicyTraceEvidence(h.request, h.repositories, h.evidence);
    if (output.status !== "traces_captured") throw new Error("Expected traces");
    expect(output.traces).toHaveLength(2);
    expect(output.traces[0]?.edgeIndex).not.toBe(output.traces[1]?.edgeIndex);
    expect(output.traces[0]?.read).toEqual(output.traces[1]?.read);
    expect(output.artifactReferences).toHaveLength(4);
    expect(h.exact).toHaveBeenCalledTimes(2);
  });

  it.each([
    "missing",
    "record_invalid",
    "reference_mismatch",
    "snapshot_cut_mismatch",
    "not_yet_available",
  ] as const)("preserves %s without hashing an empty successful trace", async (reason) => {
    const h = await harness([["event_one"]]);
    const record = event("event_one");
    if (reason === "record_invalid") Object.assign(record, { extra: true });
    if (reason === "reference_mismatch") record.scope.projectId = "project_other";
    if (reason === "snapshot_cut_mismatch") record.receivedAt = "2026-09-06T00:00:00.000Z";
    if (reason === "not_yet_available") record.receivedAt = "2026-10-02T00:00:00.000Z";
    h.exact.mockResolvedValue(reason === "missing" ? null : [record]);
    const output = await capturePolicyTraceEvidence(h.request, h.repositories, h.evidence);
    if (output.status !== "traces_captured") throw new Error("Expected traces");
    expect(output.traces[0]?.read).toMatchObject({
      events: null,
      observation: reason === "missing" ? { status: "missing" } : { status: "unavailable", reason },
    });
    expect(output.traces[0]?.read.observation).not.toHaveProperty("eventsSha256");
    expect(output.artifactReferences).toEqual([]);
  });

  it("does not turn a missing root into a successful empty trace inventory", async () => {
    const h = await harness();
    vi.spyOn(h.repositories.control.releaseCandidate, "findReleaseCandidate").mockResolvedValue(
      null,
    );
    const output = await capturePolicyTraceEvidence(h.request, h.repositories, h.evidence);
    expect(output.status).toBe("roots_unavailable");
    expect(output).not.toHaveProperty("traces");
    expect(h.exact).not.toHaveBeenCalled();
  });

  it("never follows a selector from an unavailable fixture", async () => {
    const h = await harness();
    vi.spyOn(h.repositories.datasets, "findFixtureVersion").mockResolvedValue(null);
    const output = await capturePolicyTraceEvidence(h.request, h.repositories, h.evidence);
    if (output.status !== "traces_captured") throw new Error("Expected partial graph");
    expect(output.traces).toEqual([]);
    expect(output.comparisonCapture.graph.unresolved.records).toBeGreaterThan(0);
    expect(h.exact).not.toHaveBeenCalled();
  });

  it("rejects contradictory observations of one exact selector", async () => {
    const h = await harness([["event_one"], ["event_one"]]);
    h.exact.mockResolvedValueOnce([event("event_one")]).mockResolvedValueOnce(null);
    await expect(
      capturePolicyTraceEvidence(h.request, h.repositories, h.evidence),
    ).rejects.toMatchObject({
      reason: "observation_conflict",
      identity: `trace_snapshot:${traceId}`,
    });
  });

  it.each(["body", "receipt"])(
    "rejects changed immutable event %s across different overlapping selectors",
    async (field) => {
      const h = await harness([["event_one"], ["event_one", "event_two"]]);
      const changed = event("event_one");
      if (field === "body") changed.evidence.name = "changed immutable body";
      else changed.receivedAt = "2026-09-04T01:00:00.000Z";
      h.exact
        .mockResolvedValueOnce([event("event_one")])
        .mockResolvedValueOnce([changed, event("event_two")]);
      await expect(
        capturePolicyTraceEvidence(h.request, h.repositories, h.evidence),
      ).rejects.toMatchObject({
        reason: "observation_conflict",
        identity: "trace_event:event_one",
      });
    },
  );

  it("rejects conflicting artifact descriptors between captured events", async () => {
    const h = await harness();
    h.exact.mockResolvedValue([
      event("event_one"),
      event("event_two", [{ ...artifact, sha256: "e".repeat(64) }]),
    ]);
    await expect(
      capturePolicyTraceEvidence(h.request, h.repositories, h.evidence),
    ).rejects.toMatchObject({ reason: "reference_conflict", identity: "artifact:artifact_trace" });
  });

  it("checks trace artifact identity against already captured metadata references", async () => {
    const h = await harness([["event_one"]]);
    const declared = required(h.candidate.buildArtifacts[0]).artifact;
    h.exact.mockResolvedValue([event("event_one", [{ ...declared, sha256: "e".repeat(64) }])]);
    await expect(
      capturePolicyTraceEvidence(h.request, h.repositories, h.evidence),
    ).rejects.toMatchObject({
      reason: "reference_conflict",
      identity: `artifact:${declared.artifactId}`,
    });
  });

  it("preserves unmanaged evidence content descriptors without claiming readable managed bytes", async () => {
    const h = await harness([["event_one"]]);
    const unmanaged = { ...artifact, mediaType: "opaque", sizeBytes: 0 };
    h.exact.mockResolvedValue([event("event_one", [unmanaged])]);
    const output = await capturePolicyTraceEvidence(h.request, h.repositories, h.evidence);
    if (output.status !== "traces_captured") throw new Error("Expected trace");
    expect(output.artifactReferences[0]?.reference).toEqual(unmanaged);
    expect(output.artifactReferences[0]).not.toHaveProperty("available");
  });

  it("reserves trace rows against the metadata phase's remaining budget before I/O", async () => {
    const h = await harness([Array.from({ length: 100 }, (_, index) => `event_${index}`)]);
    const graph = await capturePolicyRecordGraph(h.request, h.repositories);
    const limited = withLimits(h.request, {
      maxAcquisitionRecords: Math.max(graph.usage.records, graph.usage.references) + 1,
    });
    await expect(
      capturePolicyTraceEvidence(limited, h.repositories, h.evidence),
    ).rejects.toMatchObject({ reason: "record_limit" });
    expect(h.exact).not.toHaveBeenCalled();
  });

  it("shares the exact byte ceiling across metadata, trace envelopes and artifact occurrences", async () => {
    const h = await harness();
    const output = await capturePolicyTraceEvidence(h.request, h.repositories, h.evidence);
    const bytes = output.usage.bytes + output.usage.referenceBytes;
    const exact = withLimits(h.request, { maxAcquisitionRecordBytes: bytes });
    expect((await capturePolicyTraceEvidence(exact, h.repositories, h.evidence)).usage).toEqual(
      output.usage,
    );
    await expect(
      capturePolicyTraceEvidence(
        withLimits(h.request, { maxAcquisitionRecordBytes: bytes - 1 }),
        h.repositories,
        h.evidence,
      ),
    ).rejects.toMatchObject({ reason: "byte_limit" });
  });

  it("meters repeated trace artifact occurrences against the shared reference ceiling", async () => {
    const h = await harness([Array.from({ length: 4 }, (_, index) => `event_${index}`)]);
    h.exact.mockResolvedValue(
      h.events.map((record) => ({
        ...record,
        evidence: {
          ...record.evidence,
          contentReferences: Array.from({ length: 32 }, () => artifact),
        },
      })),
    );
    const graph = await capturePolicyRecordGraph(h.request, h.repositories);
    await expect(
      capturePolicyTraceEvidence(
        withLimits(h.request, { maxAcquisitionRecords: graph.usage.references + 127 }),
        h.repositories,
        h.evidence,
      ),
    ).rejects.toMatchObject({ reason: "reference_limit" });
  });

  it("propagates storage failures and rejects malformed requests before acquisition", async () => {
    const h = await harness();
    const failure = new Error("trace store unavailable");
    h.exact.mockRejectedValue(failure);
    await expect(capturePolicyTraceEvidence(h.request, h.repositories, h.evidence)).rejects.toBe(
      failure,
    );
    h.exact.mockClear();
    await expect(
      capturePolicyTraceEvidence(
        { ...h.request, definitionSha256: "f".repeat(64) },
        h.repositories,
        h.evidence,
      ),
    ).rejects.toMatchObject({ code: "policy_evaluation_request_record_invalid" });
    expect(h.exact).not.toHaveBeenCalled();
  });

  it("admits trace JSON before inspection without invoking malicious getters", async () => {
    const h = await harness([["event_one"]]);
    const getter = vi.fn(() => event("event_one").evidence);
    const body = Object.defineProperty(event("event_one"), "evidence", {
      enumerable: true,
      get: getter,
    });
    h.exact.mockResolvedValue([body]);
    await expect(
      capturePolicyTraceEvidence(h.request, h.repositories, h.evidence),
    ).rejects.toMatchObject({ reason: "unmeasurable_record" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("keeps untrusted graph and budget composition out of the package entry point", () => {
    expect(publicApi).not.toHaveProperty("acquirePolicyRecordGraph");
    expect(publicApi).not.toHaveProperty("resolveCapturedComparisonEvidence");
    expect(publicApi).not.toHaveProperty("AcquisitionBudget");
    expect(publicApi.capturePolicyTraceEvidence).toBe(capturePolicyTraceEvidence);
  });
});
