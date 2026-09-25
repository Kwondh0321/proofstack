import {
  COMPARISON_RESULT_SCHEMA_VERSION,
  EvidenceEnvelopeSchema,
  POLICY_EVALUATION_REQUEST_SCHEMA_VERSION,
  REGRESSION_DATASET_VERSION_SCHEMA_VERSION,
  REGRESSION_FIXTURE_VERSION_SCHEMA_VERSION,
  type ComparisonEvidenceSnapshot,
  type ComparisonResult,
  type PolicyEvaluationRequestDefinition,
  type RegressionDatasetVersionDefinition,
  type RegressionFixtureVersionDefinition,
  type ReleaseCandidate,
  type ReleasePolicy,
} from "@proofstack/contracts";
import {
  deriveComparisonResultDefinition,
  digestComparisonRecordDefinition,
  digestPolicyEvaluationRequestDefinition,
  digestReleaseCandidateDefinition,
  digestReleasePolicyDefinition,
  releaseCandidateReference,
  releasePolicyReference,
} from "@proofstack/core";
import {
  comparisonDefinitionFixture,
  comparisonFixtureScope,
  comparisonSnapshotFixture,
  MemoryComparisonRepository,
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
import { capturePolicyComparisonEvidence } from "./capture-comparison-evidence.js";
import { capturePolicyTraceEvidence } from "./capture-trace-evidence.js";
import type { PolicyRecordGraphRepositories } from "./record-routing.js";

type ReceiptKey =
  | "createdAt"
  | "createdByPrincipalId"
  | "publishedAt"
  | "publishedByPrincipalId"
  | "scope"
  | "schemaVersion"
  | "definitionSha256";

function definition<T extends object>(record: T): Omit<T, ReceiptKey> {
  const body = structuredClone(record) as Record<string, unknown>;
  for (const key of [
    "createdAt",
    "createdByPrincipalId",
    "publishedAt",
    "publishedByPrincipalId",
    "scope",
    "schemaVersion",
    "definitionSha256",
  ])
    delete body[key];
  return body as Omit<T, ReceiptKey>;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Missing comparison test fixture member");
  return value;
}

function resultReference(result: ComparisonResult) {
  return { resultId: result.resultId, definitionSha256: result.definitionSha256 };
}

function fixture(count = 1) {
  const scope = comparisonFixtureScope("capture_comparison");
  const comparison = comparisonDefinitionFixture("capture_comparison", scope);
  const comparisonRef = {
    comparisonId: comparison.comparisonId,
    comparisonVersionId: comparison.comparisonVersionId,
    definitionSha256: comparison.definitionSha256,
  };
  function snapshot(role: "baseline" | "candidate"): ComparisonEvidenceSnapshot {
    const value = comparisonSnapshotFixture("capture_comparison", scope, comparison, role);
    const template = required(value.fixtures[0]);
    value.dataset = structuredClone(comparison[role].dataset);
    value.fixtures = comparison[role].fixtures.map((subject) => ({
      ...structuredClone(template),
      fixture: structuredClone(subject.fixture),
      replay: structuredClone(subject.replay),
      assurance: [
        ...subject.assessments.map((reference) => ({
          eligibility: "eligible" as const,
          kind: "assessment" as const,
          reasons: [],
          reference,
        })),
        ...subject.modelAssuranceAssessments.map((reference) => ({
          eligibility: "eligible" as const,
          kind: "model_assurance" as const,
          reasons: [],
          reference,
        })),
      ],
      evaluationOutcomes: subject.assessments.map((assessment) => ({
        ...structuredClone(required(template.evaluationOutcomes[0])),
        assessment,
      })),
    }));
    value.sourceCutoff =
      role === "baseline" ? "2026-09-02T01:00:01.000Z" : "2026-09-02T01:05:01.000Z";
    value.definitionSha256 = digestComparisonRecordDefinition(
      "comparison_evidence_snapshot",
      scope,
      definition(value),
    );
    return value;
  }
  const baseline = snapshot("baseline");
  const current = snapshot("candidate");
  const results = Array.from({ length: count }, (_, index): ComparisonResult => {
    const body = deriveComparisonResultDefinition({
      comparison,
      baseline,
      candidate: current,
      resultId: `result_capture_${index}`,
    });
    return {
      ...body,
      schemaVersion: COMPARISON_RESULT_SCHEMA_VERSION,
      scope,
      createdAt: "2026-09-02T04:00:00.000Z",
      createdByPrincipalId: "principal_capture",
      definitionSha256: digestComparisonRecordDefinition("comparison_result", scope, body),
    };
  });
  const candidate = releaseCandidateFixture("capture_comparison", scope);
  candidate.datasets = [structuredClone(comparison.candidate.dataset)];
  candidate.targetRelease = structuredClone(
    required(comparison.candidate.fixtures[0]).replay.targetRelease,
  );
  candidate.assessments = structuredClone(
    comparison.candidate.fixtures.flatMap(({ assessments }) => assessments),
  );
  candidate.modelAssuranceAssessments = structuredClone(
    comparison.candidate.fixtures.flatMap(
      ({ modelAssuranceAssessments }) => modelAssuranceAssessments,
    ),
  );
  const policy = releasePolicyRepositoryFixture("capture_comparison", scope);
  for (const rule of policy.rules) {
    if ("comparison" in rule.predicate) rule.predicate.comparison = structuredClone(comparisonRef);
  }
  return { scope, comparison, baseline, current, results, candidate, policy };
}

function request(candidate: ReleaseCandidate, policy: ReleasePolicy) {
  const body: PolicyEvaluationRequestDefinition = {
    algorithm: { id: "proofstack.deterministic-policy", version: "1.0.0" },
    candidate: releaseCandidateReference(candidate),
    policy: releasePolicyReference(policy),
    evaluationRequestId: "request_capture_comparison",
    evaluationTime: "2026-09-07T12:00:00.000Z",
    limits: {
      heartbeatIntervalMilliseconds: 1_000,
      leaseDurationMilliseconds: 5_000,
      maxAcquisitionRecordBytes: 8_388_608,
      maxAcquisitionRecords: 10_000,
      maxArtifactReadBytes: 16_777_216,
      maxAttempts: 2,
      maxRuleEvaluations: 256,
      perAttemptTimeoutMilliseconds: 20_000,
      retryBackoffMilliseconds: 100,
      retryableErrors: ["source_revision_changed"],
      totalDeadlineMilliseconds: 60_000,
    },
  };
  return {
    ...body,
    schemaVersion: POLICY_EVALUATION_REQUEST_SCHEMA_VERSION,
    scope: candidate.scope,
    createdAt: "2026-09-07T13:00:00.000Z",
    createdByPrincipalId: "principal_requester",
    definitionSha256: digestPolicyEvaluationRequestDefinition(candidate.scope, body),
  };
}

async function harness(value = fixture()) {
  const comparison = new MemoryComparisonRepository();
  const candidate = new MemoryReleaseCandidateRepository();
  const policy = new MemoryReleasePolicyRepository();
  for (const result of value.results)
    result.definitionSha256 = digestComparisonRecordDefinition(
      "comparison_result",
      value.scope,
      definition(result),
    );
  value.candidate.comparisons = value.results.map(resultReference);
  value.candidate.definitionSha256 = digestReleaseCandidateDefinition(
    value.scope,
    definition(value.candidate),
  );
  value.policy.definitionSha256 = digestReleasePolicyDefinition(
    value.scope,
    definition(value.policy),
  );
  await comparison.publishComparisonDefinition(value.comparison);
  await comparison.publishComparisonEvidenceSnapshot(value.baseline);
  await comparison.publishComparisonEvidenceSnapshot(value.current);
  for (const result of value.results) await comparison.publishComparisonResult(result);
  await candidate.publishReleaseCandidate(value.candidate);
  await policy.publishReleasePolicy(value.policy);
  const reads: string[] = [];
  const absent = new Proxy(
    {},
    {
      get: (_object, key) => async () => {
        reads.push(String(key));
        return null;
      },
    },
  );
  const repositories = {
    control: {
      comparison: {
        findComparisonDefinition: vi.fn(comparison.findComparisonDefinition.bind(comparison)),
        findComparisonEvidenceSnapshot: vi.fn(
          comparison.findComparisonEvidenceSnapshot.bind(comparison),
        ),
        findComparisonResult: vi.fn(comparison.findComparisonResult.bind(comparison)),
      },
      releaseCandidate: {
        findReleaseCandidate: vi.fn(candidate.findReleaseCandidate.bind(candidate)),
      },
      releasePolicy: { findReleasePolicy: vi.fn(policy.findReleasePolicy.bind(policy)) },
      installationBinding: absent,
    },
    datasets: absent,
    replayDefinitions: absent,
    replayResults: absent,
    runtimeDefinitions: absent,
    evidence: { evaluation: absent, modelAssurance: absent },
  } as unknown as PolicyRecordGraphRepositories;
  return { value, repositories, request: request(value.candidate, value.policy), reads };
}

describe("request-rooted comparison evidence capture", () => {
  it("preserves verified direct comparison lineage while acquiring retained trace events in the same graph", async () => {
    const value = fixture();
    const traceId = "0123456789abcdef0123456789abcdef";
    const fixtureDefinition: RegressionFixtureVersionDefinition = {
      fixtureId: "fixture_captured_trace",
      fixtureVersionId: "fixture_captured_trace_v1",
      name: "Additional retained candidate evidence",
      replayability: "evidence_only",
      schemaVersion: REGRESSION_FIXTURE_VERSION_SCHEMA_VERSION,
      scope: value.scope,
      source: {
        kind: "trace_snapshot",
        traceId,
        eventIds: ["event_captured_trace"],
        observedEventCount: 1,
        sourceCompleteness: "observed_snapshot",
      },
    };
    const retainedFixture = {
      ...fixtureDefinition,
      source: { ...fixtureDefinition.source, capturedAt: "2026-09-01T00:00:00.000Z" },
      createdAt: "2026-09-01T00:00:00.000Z",
      createdByPrincipalId: "principal_capture",
      definitionSha256: digestRegressionFixtureVersionDefinition(fixtureDefinition),
    };
    const datasetDefinition: RegressionDatasetVersionDefinition = {
      datasetId: "dataset_captured_trace",
      datasetVersionId: "dataset_captured_trace_v1",
      name: "Additional retained candidate dataset",
      scope: value.scope,
      schemaVersion: REGRESSION_DATASET_VERSION_SCHEMA_VERSION,
      fixtureVersions: [
        {
          fixtureId: retainedFixture.fixtureId,
          fixtureVersionId: retainedFixture.fixtureVersionId,
          definitionSha256: retainedFixture.definitionSha256,
        },
      ],
    };
    const dataset = {
      ...datasetDefinition,
      createdAt: "2026-09-01T00:00:00.000Z",
      createdByPrincipalId: "principal_capture",
      definitionSha256: digestRegressionDatasetVersionDefinition(datasetDefinition),
    };
    value.candidate.datasets.push({
      datasetId: dataset.datasetId,
      datasetVersionId: dataset.datasetVersionId,
      definitionSha256: dataset.definitionSha256,
    });
    value.candidate.datasets.sort((left, right) => {
      const a = `${left.datasetId}:${left.datasetVersionId}`;
      const b = `${right.datasetId}:${right.datasetVersionId}`;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const h = await harness(value);
    const datasets = new MemoryRegressionVersionRepository();
    await datasets.publishFixtureVersion(retainedFixture);
    await datasets.publishDatasetVersion(dataset);
    const evidence = new MemoryEvidenceRepository();
    const envelope = EvidenceEnvelopeSchema.parse({
      schemaVersion: "0.1",
      scope: value.scope,
      receivedAt: "2026-09-01T00:00:00.000Z",
      evidence: {
        eventId: "event_captured_trace",
        traceId,
        spanId: "0123456789abcdef",
        kind: "agent.run",
        name: "Retained event",
        startedAt: "2026-09-01T00:00:00.000Z",
        source: { sdkName: "fixture", sdkVersion: "1.0.0", serviceName: "capture" },
      },
    });
    await evidence.append([envelope]);
    const exact = vi.spyOn(evidence, "resolveExactEvents");
    const output = await capturePolicyTraceEvidence(
      h.request,
      { ...h.repositories, datasets },
      evidence,
    );
    if (
      output.status !== "traces_captured" ||
      output.comparisonCapture.status !== "inventory_captured"
    )
      throw new Error("Expected composed comparison and trace capture");
    expect(output.comparisonCapture.comparisons[0]?.status).toBe("lineage_verified");
    expect(output.traces).toHaveLength(1);
    expect(output.traces[0]?.read.events).toEqual([envelope]);
    expect(output.traces[0]?.read.observation.status).toBe("verified");
    expect(h.repositories.control.comparison.findComparisonResult).toHaveBeenCalledTimes(1);
    expect(exact).toHaveBeenCalledExactlyOnceWith(value.scope, traceId, ["event_captured_trace"]);
    expect(output.usage.records).toBe(output.comparisonCapture.graph.usage.records + 2);
    // Unrelated missing descendants remain visible; direct lineage is not complete closure.
    expect(output.comparisonCapture.graph.unresolved.records).toBeGreaterThan(0);
  });

  it("selects and rederives exact retained comparisons without rereading or promoting missing descendants", async () => {
    const h = await harness();
    const output = await capturePolicyComparisonEvidence(h.request, h.repositories);
    expect(output.status).toBe("inventory_captured");
    if (output.status !== "inventory_captured") throw new Error("Expected inventory");
    expect(output.comparisons).toHaveLength(1);
    const first = required(output.comparisons[0]);
    expect(first.status).toBe("lineage_verified");
    if (first.status !== "lineage_verified") throw new Error("Expected lineage");
    expect(first.lineage.result).toEqual(h.value.results[0]);
    expect(first.lineage.inventory).toEqual(output.inventory);
    expect(first.lineage.directSources.some(({ kind }) => kind === "replay_result")).toBe(true);
    expect(output.graph.unresolved.records).toBeGreaterThan(0);
    expect(output.graph.unresolved.references).toBeGreaterThan(0);
    expect(output).not.toHaveProperty("verdict");
    expect(output).not.toHaveProperty("sealed");
    expect(h.repositories.control.comparison.findComparisonResult).toHaveBeenCalledTimes(1);
    expect(h.repositories.control.comparison.findComparisonDefinition).toHaveBeenCalledTimes(1);
    expect(h.repositories.control.comparison.findComparisonEvidenceSnapshot).toHaveBeenCalledTimes(
      2,
    );
    expect(h.repositories.control.releaseCandidate.findReleaseCandidate).toHaveBeenCalledTimes(1);
    expect(h.repositories.control.releasePolicy.findReleasePolicy).toHaveBeenCalledTimes(1);
  });

  it.each(["candidate", "policy"] as const)(
    "retains an unavailable %s root without producing a partial inventory",
    async (root) => {
      const h = await harness();
      const port =
        root === "candidate"
          ? h.repositories.control.releaseCandidate.findReleaseCandidate
          : h.repositories.control.releasePolicy.findReleasePolicy;
      vi.mocked(port).mockResolvedValue(null);
      const output = await capturePolicyComparisonEvidence(h.request, h.repositories);
      expect(output.status).toBe("roots_unavailable");
      if (output.status !== "roots_unavailable") throw new Error("Expected unavailable roots");
      expect(output.unavailableRoots).toEqual([
        {
          source: {
            kind: root === "candidate" ? "release_candidate" : "release_policy",
            reference: h.request[root],
          },
          observation: { status: "missing" },
        },
      ]);
      expect(output).not.toHaveProperty("inventory");
    },
  );

  it.each(["missing", "record_invalid", "reference_mismatch", "not_yet_available"] as const)(
    "preserves %s for an unreadable candidate result",
    async (reason) => {
      const h = await harness(fixture(2));
      const raw = structuredClone(required(h.value.results[1]));
      if (reason === "record_invalid") raw.definitionSha256 = "f".repeat(64);
      if (reason === "reference_mismatch") raw.scope.environmentId = "env_foreign";
      if (reason === "reference_mismatch")
        raw.definitionSha256 = digestComparisonRecordDefinition(
          "comparison_result",
          raw.scope,
          definition(raw),
        );
      if (reason === "not_yet_available") raw.createdAt = "2026-09-08T00:00:00.000Z";
      vi.mocked(h.repositories.control.comparison.findComparisonResult).mockImplementation(
        async (_scope, id) =>
          id === raw.resultId ? (reason === "missing" ? null : raw) : required(h.value.results[0]),
      );
      const output = await capturePolicyComparisonEvidence(h.request, h.repositories);
      if (output.status !== "inventory_captured") throw new Error("Expected inventory");
      expect(output.inventory.members[1]?.observation).toEqual(
        reason === "missing" ? { status: "missing" } : { status: "unavailable", reason },
      );
      expect(output.comparisons[0]).toMatchObject({
        status: "selection_unresolved",
        selection: {
          status: "unresolved",
          knownMatches: [resultReference(required(h.value.results[0]))],
        },
      });
    },
  );

  it("retains multiple matching results as ambiguous", async () => {
    const h = await harness(fixture(2));
    const output = await capturePolicyComparisonEvidence(h.request, h.repositories);
    if (output.status !== "inventory_captured") throw new Error("Expected inventory");
    expect(output.comparisons[0]).toMatchObject({
      status: "selection_unresolved",
      selection: { status: "ambiguous", matches: h.value.results.map(resultReference) },
    });
  });

  it("retains zero matches only after verifying the complete candidate inventory", async () => {
    const value = fixture();
    for (const { predicate } of value.policy.rules) {
      if ("comparison" in predicate)
        predicate.comparison.comparisonVersionId = "comparison_other_v1";
    }
    const h = await harness(value);
    const output = await capturePolicyComparisonEvidence(h.request, h.repositories);
    if (output.status !== "inventory_captured") throw new Error("Expected inventory");
    expect(
      output.inventory.members.every(({ observation }) => observation.status === "verified"),
    ).toBe(true);
    expect(output.comparisons[0]).toMatchObject({
      status: "selection_unresolved",
      selection: { status: "missing" },
    });
  });

  it("retains an impossible source cutoff as invalid even when its semantic hash is recomputed", async () => {
    const h = await harness();
    const result = structuredClone(required(h.value.results[0]));
    result.latestSourceCutoff = "2026-09-08T00:00:00.000Z";
    result.definitionSha256 = digestComparisonRecordDefinition(
      "comparison_result",
      result.scope,
      definition(result),
    );
    vi.mocked(h.repositories.control.comparison.findComparisonResult).mockResolvedValue(result);
    const output = await capturePolicyComparisonEvidence(h.request, h.repositories);
    if (output.status !== "inventory_captured") throw new Error("Expected inventory");
    expect(
      output.graph.nodes.find(({ read }) => read.source.kind === "comparison_result")?.read
        .observation.status,
    ).toBe("unavailable");
    expect(output.inventory.members[0]?.observation).toEqual({
      status: "unavailable",
      reason: "record_invalid",
    });
    expect(output.comparisons[0]).toMatchObject({
      status: "selection_unresolved",
      selection: { status: "unresolved" },
    });
  });

  it("preserves corrupted and future prerequisite observations separately from absence", async () => {
    const h = await harness();
    vi.mocked(h.repositories.control.comparison.findComparisonEvidenceSnapshot).mockImplementation(
      async (_scope, id) =>
        id === h.value.baseline.snapshotId
          ? { ...h.value.baseline, definitionSha256: "f".repeat(64) }
          : { ...h.value.current, createdAt: "2026-09-08T00:00:00.000Z" },
    );
    const output = await capturePolicyComparisonEvidence(h.request, h.repositories);
    if (output.status !== "inventory_captured") throw new Error("Expected inventory");
    expect(output.comparisons[0]).toMatchObject({
      status: "records_unavailable",
      unavailableRecords: [
        {
          source: { reference: { role: "baseline" } },
          observation: { status: "unavailable", reason: "record_invalid" },
        },
        {
          source: { reference: { role: "candidate" } },
          observation: { status: "unavailable", reason: "not_yet_available" },
        },
      ],
    });
  });

  it("reports a corrupt root without pretending its dependent comparison list is empty", async () => {
    const h = await harness();
    vi.mocked(h.repositories.control.releaseCandidate.findReleaseCandidate).mockResolvedValue({
      ...h.value.candidate,
      definitionSha256: "f".repeat(64),
    });
    const output = await capturePolicyComparisonEvidence(h.request, h.repositories);
    expect(output).toMatchObject({
      status: "roots_unavailable",
      unavailableRoots: [
        {
          source: { kind: "release_candidate" },
          observation: { status: "unavailable", reason: "record_invalid" },
        },
      ],
    });
    expect(output).not.toHaveProperty("comparisons");
  });

  it("enforces acquisition limits without returning a partial successful comparison", async () => {
    const h = await harness();
    h.request.limits.maxAcquisitionRecords = 2;
    h.request.definitionSha256 = digestPolicyEvaluationRequestDefinition(
      h.request.scope,
      definition(h.request),
    );
    await expect(capturePolicyComparisonEvidence(h.request, h.repositories)).rejects.toMatchObject({
      code: "policy_evaluation_evidence_references_invalid",
      reason: "reference_limit_exceeded",
    });
    expect(h.repositories.control.releasePolicy.findReleasePolicy).not.toHaveBeenCalled();
  });

  it.each(["definition", "baseline", "candidate"] as const)(
    "retains a missing %s comparison prerequisite",
    async (missing) => {
      const h = await harness();
      if (missing === "definition")
        vi.mocked(h.repositories.control.comparison.findComparisonDefinition).mockResolvedValue(
          null,
        );
      else
        vi.mocked(
          h.repositories.control.comparison.findComparisonEvidenceSnapshot,
        ).mockImplementation(async (_scope, id) =>
          id === (missing === "baseline" ? h.value.baseline : h.value.current).snapshotId
            ? null
            : missing === "baseline"
              ? h.value.current
              : h.value.baseline,
        );
      const output = await capturePolicyComparisonEvidence(h.request, h.repositories);
      if (output.status !== "inventory_captured") throw new Error("Expected inventory");
      expect(output.comparisons[0]).toMatchObject({
        status: "records_unavailable",
        unavailableRecords: [{ observation: { status: "missing" } }],
      });
    },
  );

  it("rejects a validly rehashed result that cannot be rederived from its retained inputs", async () => {
    const value = fixture();
    required(value.results[0]).knownLimitations.push("Unjustified retained result claim");
    const h = await harness(value);
    const output = await capturePolicyComparisonEvidence(h.request, h.repositories);
    if (output.status !== "inventory_captured") throw new Error("Expected inventory");
    expect(output.comparisons[0]).toMatchObject({
      status: "lineage_invalid",
      reason: "result_derivation_mismatch",
    });
  });

  it("preserves invalid receipt chronology despite individually verified records", async () => {
    const value = fixture();
    required(value.results[0]).createdAt = "2026-09-02T02:00:00.000Z";
    const h = await harness(value);
    const output = await capturePolicyComparisonEvidence(h.request, h.repositories);
    if (output.status !== "inventory_captured") throw new Error("Expected inventory");
    expect(output.comparisons[0]).toMatchObject({
      status: "lineage_invalid",
      reason: "lineage_chronology_invalid",
    });
  });

  it("rejects malformed requests before any repository access", async () => {
    const h = await harness();
    await expect(
      capturePolicyComparisonEvidence(
        { ...h.request, definitionSha256: "f".repeat(64) },
        h.repositories,
      ),
    ).rejects.toMatchObject({ code: "policy_evaluation_request_record_invalid" });
    expect(h.repositories.control.releaseCandidate.findReleaseCandidate).not.toHaveBeenCalled();
    expect(h.reads).toEqual([]);
  });

  it("propagates storage failures rather than inventing a missing observation", async () => {
    const h = await harness();
    const failure = new Error("Storage unavailable");
    vi.mocked(h.repositories.control.comparison.findComparisonResult).mockRejectedValue(failure);
    await expect(capturePolicyComparisonEvidence(h.request, h.repositories)).rejects.toBe(failure);
  });

  it("owns the request before asynchronous acquisition can mutate the caller's roots", async () => {
    const h = await harness();
    const expected = structuredClone(h.request.candidate);
    vi.mocked(h.repositories.control.releaseCandidate.findReleaseCandidate).mockImplementation(
      async () => {
        h.request.candidate.definitionSha256 = "f".repeat(64);
        return h.value.candidate;
      },
    );
    const output = await capturePolicyComparisonEvidence(h.request, h.repositories);
    if (output.status !== "inventory_captured") throw new Error("Expected inventory");
    expect(output.inventory.candidate).toEqual(expected);
    expect(output.comparisons[0]?.status).toBe("lineage_verified");
  });
});
