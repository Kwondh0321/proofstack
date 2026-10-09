import {
  COMPARISON_RESULT_SCHEMA_VERSION,
  EvidenceEnvelopeSchema,
  POLICY_EVALUATION_REQUEST_SCHEMA_VERSION,
  REGRESSION_DATASET_VERSION_SCHEMA_VERSION,
  REGRESSION_FIXTURE_VERSION_SCHEMA_VERSION,
  type ComparisonEvidenceSnapshot,
  type ComparisonDefinition,
  type ComparisonResult,
  encodeEvaluationCanonicalJson,
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
import { inspectCapturedComparisonRules } from "./capture-comparison-rules.js";
import { capturePolicyTraceEvidence } from "./capture-trace-evidence.js";
import * as publicApi from "./index.js";
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

function fixture(count = 1, configure?: (comparison: ComparisonDefinition) => void) {
  const scope = comparisonFixtureScope("capture_comparison");
  const comparison = comparisonDefinitionFixture("capture_comparison", scope);
  configure?.(comparison);
  comparison.definitionSha256 = digestComparisonRecordDefinition(
    "comparison_definition",
    scope,
    definition(comparison),
  );
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

describe("candidate-owned comparison rule input bindings", () => {
  const limits = { maxReferences: 10000, maxReferenceBytes: 8_388_608 };
  const project = (
    h: Awaited<ReturnType<typeof harness>>,
    capture: Awaited<ReturnType<typeof capturePolicyComparisonEvidence>>,
    admission = limits,
  ) => inspectCapturedComparisonRules(h.request, capture, admission);
  function inputs(count = 1) {
    const value = fixture(count, (comparison) => {
      comparison.metrics.push({
        kind: "safety_event_count",
        eventKind: "guardrail_check",
        metricId: "metric_safety",
        label: "Exact safety events",
        stratumId: "stratum_all",
        unit: "events",
      });
      comparison.metrics.sort((a, b) => (a.metricId < b.metricId ? -1 : 1));
    });
    const reference = {
      comparisonId: value.comparison.comparisonId,
      comparisonVersionId: value.comparison.comparisonVersionId,
      definitionSha256: value.comparison.definitionSha256,
    };
    const ruleTemplate = required(value.policy.rules[0]);
    value.policy.rules = value.policy.rules.filter(({ predicate }) => !("comparison" in predicate));
    const predicates: ReleasePolicy["rules"][number]["predicate"][] = [
      {
        kind: "comparison_threshold",
        comparison: reference,
        metricId: "metric_elapsed",
        metricKind: "replay_usage",
        operand: "delta",
        comparator: "less_than_or_equal",
        threshold: "0",
        unit: "milliseconds",
      },
      {
        kind: "coverage_floor",
        sourceKind: "comparison_metric_samples",
        comparison: reference,
        metricId: "metric_elapsed",
        sampleClass: "candidate_observed",
        minimumCount: 1,
        unit: "cases",
      },
      {
        kind: "coverage_floor",
        sourceKind: "comparison_metric_ratio",
        comparison: reference,
        metricId: "metric_elapsed",
        numerator: "candidate_observed",
        denominator: "candidate_total",
        minimumBasisPoints: 10000,
        unit: "basis_points",
      },
      {
        kind: "safety_event_ceiling",
        comparison: reference,
        metricId: "metric_safety",
        eventClass: "guardrail_check",
        maximumCount: 0,
        unit: "events",
      },
      {
        kind: "comparison_threshold",
        comparison: reference,
        metricId: "metric_elapsed",
        metricKind: "replay_usage",
        operand: "candidate",
        comparator: "less_than",
        threshold: "1000",
        unit: "milliseconds",
      },
      {
        kind: "comparison_threshold",
        comparison: reference,
        metricId: "metric_unknown",
        metricKind: "trace_event_count",
        operand: "candidate",
        comparator: "equal",
        threshold: "0",
        unit: "events",
      },
    ];
    predicates.forEach((predicate, index) => {
      value.policy.rules.push({
        ...structuredClone(ruleTemplate),
        ruleId: `bound_comparison_${index}`,
        predicate,
      });
    });
    value.policy.rules.sort((a, b) => (a.ruleId < b.ruleId ? -1 : 1));
    return value;
  }

  it("binds original repeated rules to exact metric/stratum/sample/value provenance without evaluating", async () => {
    const h = await harness(inputs());
    const capture = await capturePolicyComparisonEvidence(h.request, h.repositories);
    const report = project(h, capture);
    expect(report.inventory).toEqual(
      capture.status === "inventory_captured" ? capture.inventory : null,
    );
    expect(report.rules).toHaveLength(6);
    for (const rule of report.rules) {
      expect(h.value.policy.rules[rule.ruleIndex]?.predicate).toEqual(rule.predicate);
      expect(capture.graph.edges[rule.policyEdgeIndex]?.reference.path).toBe(
        `/rules/${rule.ruleIndex}/predicate/comparison`,
      );
      expect(rule.comparisonIndex).toBe(0);
      if (rule.binding.status !== "metric_bound") continue;
      const metric = rule.binding.metric;
      const result = required(h.value.results[0]);
      expect(metric.definition).toEqual(h.value.comparison.metrics[metric.definitionIndex]);
      expect(metric.result).toEqual(result.metricResults[metric.resultIndex]);
      expect(metric.stratum).toEqual(h.value.comparison.strata[metric.stratumIndex]);
      expect(Object.keys(metric.result.samples)).toHaveLength(15);
      expect(metric.provenance).toEqual({
        calculationPolicy: h.value.comparison.calculationPolicy,
        comparability: result.comparability,
        pairing: result.pairing,
        latestSourceCutoff: result.latestSourceCutoff,
      });
      expect(metric.compatibility).toEqual({ status: "compatible", reasons: [] });
      for (const hash of Object.values(metric.recordHashes))
        expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(report.rules.filter(({ binding }) => binding.status === "metric_bound")).toHaveLength(5);
    expect(report.rules[5]?.binding).toEqual({ status: "metric_missing" });
    expect(report.rules[0]?.binding).toEqual(report.rules[4]?.binding);
    expect(report).not.toHaveProperty("outcome");
    expect(publicApi).not.toHaveProperty("inspectCapturedComparisonRules");
    expect(h.repositories.control.comparison.findComparisonResult).toHaveBeenCalledTimes(1);
    expect(h.repositories.control.comparison.findComparisonEvidenceSnapshot).toHaveBeenCalledTimes(
      2,
    );
  });

  it.each([
    "ambiguous",
    "missing",
    "unresolved",
    "definition_unavailable",
    "snapshot_unavailable",
    "invalid_lineage",
  ] as const)("retains %s without fabricating usable metric inputs", async (fault) => {
    const value = inputs(fault === "ambiguous" || fault === "unresolved" ? 2 : 1);
    if (fault === "missing")
      for (const { predicate } of value.policy.rules)
        if ("comparison" in predicate)
          predicate.comparison.comparisonVersionId = "other_comparison";
    if (fault === "invalid_lineage") {
      const limitations = required(value.results[0]).knownLimitations;
      limitations.push("Not derived from the original source records.");
      limitations.sort();
    }
    const h = await harness(value);
    if (fault === "unresolved")
      vi.mocked(h.repositories.control.comparison.findComparisonResult).mockImplementation(
        async (_scope, id) =>
          id === required(h.value.results[0]).resultId ? required(h.value.results[0]) : null,
      );
    if (fault === "definition_unavailable")
      vi.mocked(h.repositories.control.comparison.findComparisonDefinition).mockResolvedValue(null);
    if (fault === "snapshot_unavailable")
      vi.mocked(h.repositories.control.comparison.findComparisonEvidenceSnapshot).mockResolvedValue(
        null,
      );
    const capture = await capturePolicyComparisonEvidence(h.request, h.repositories);
    const report = project(h, capture);
    expect(report.rules).toHaveLength(6);
    const reason =
      fault === "invalid_lineage"
        ? "lineage_invalid"
        : fault.endsWith("unavailable")
          ? "records_unavailable"
          : "selection_unresolved";
    for (const { binding } of report.rules)
      expect(binding).toEqual({ status: "comparison_unusable", reason });
    expect(report.inventory.members).toHaveLength(h.value.results.length);
    if (capture.status !== "inventory_captured") throw new Error("Missing complete selection");
    if (fault === "ambiguous" || fault === "missing" || fault === "unresolved")
      expect(capture.comparisons[0]?.selection.status).toBe(fault);
  });

  it.each([
    "threshold_kind",
    "threshold_unit",
    "safety_kind",
    "safety_unit",
    "safety_event",
  ] as const)("retains original operands and explicit incompatible %s input", async (fault) => {
    const value = inputs();
    const threshold = required(
      value.policy.rules.find(({ ruleId }) => ruleId === "bound_comparison_0"),
    ).predicate;
    const safety = required(
      value.policy.rules.find(({ ruleId }) => ruleId === "bound_comparison_3"),
    ).predicate;
    if (threshold.kind !== "comparison_threshold" || safety.kind !== "safety_event_ceiling")
      throw new Error("Missing original rules");
    if (fault === "threshold_kind") {
      threshold.metricId = "metric_trace_events";
      threshold.unit = "milliseconds";
    }
    if (fault === "threshold_unit") threshold.unit = "tokens";
    if (fault === "safety_kind") safety.metricId = "metric_trace_events";
    if (fault === "safety_unit") safety.metricId = "metric_elapsed";
    if (fault === "safety_event") safety.eventClass = "uncertain_side_effect";
    const h = await harness(value);
    const report = project(h, await capturePolicyComparisonEvidence(h.request, h.repositories));
    const binding = required(
      report.rules.find(
        ({ ruleId }) =>
          ruleId === (fault.startsWith("threshold") ? "bound_comparison_0" : "bound_comparison_3"),
      ),
    ).binding;
    if (binding.status !== "metric_bound") throw new Error("Missing exact original metric");
    const reasons =
      fault === "threshold_kind" || fault === "safety_unit"
        ? ["metric_kind", "unit"]
        : fault === "threshold_unit"
          ? ["unit"]
          : fault === "safety_kind"
            ? ["metric_kind"]
            : ["event_class"];
    expect(binding.metric.compatibility).toEqual({ status: "incompatible", reasons });
    expect(binding.metric.result).toEqual(
      h.value.results[0]?.metricResults[binding.metric.resultIndex],
    );
    expect(binding.metric).not.toHaveProperty("outcome");
  });

  it.each([
    "request",
    "scope",
    "time",
    "roots",
    "duplicate_node",
    "missing_node",
    "candidate_body",
    "policy_receipt",
    "result_hash",
    "snapshot_receipt",
    "definition_body",
    "parent_references",
    "edge_hash",
    "edge_reference",
    "edge_target",
    "missing_edge",
    "extra_edge",
    "inventory",
    "selection",
    "lineage",
  ] as const)("rejects substituted %s provenance before binding operands", async (fault) => {
    const h = await harness(inputs());
    const capture = await capturePolicyComparisonEvidence(h.request, h.repositories);
    if (capture.status !== "inventory_captured") throw new Error("Missing captured inventory");
    const graph = capture.graph;
    const node = (kind: string) =>
      required(graph.nodes.find(({ read }) => read.source.kind === kind));
    const candidateEdge = required(
      graph.edges.find(
        ({ parent, reference }) =>
          parent.kind === "release_candidate" && reference.path === "/comparisons/0",
      ),
    );
    const comparison = required(capture.comparisons[0]);
    if (fault === "request") Reflect.set(graph.request, "evaluationRequestId", "other_request");
    if (fault === "scope") Reflect.set(graph.scope, "tenantId", "other_tenant");
    if (fault === "time") Reflect.set(graph, "evaluationTime", "2026-09-07T12:00:00.001Z");
    if (fault === "roots") Reflect.set(graph, "roots", [...graph.roots].reverse());
    if (fault === "duplicate_node")
      Reflect.set(graph, "nodes", [...graph.nodes, node("release_candidate")]);
    if (fault === "missing_node")
      Reflect.set(
        graph,
        "nodes",
        graph.nodes.filter(({ read }) => read.source.kind !== "comparison_snapshot"),
      );
    if (fault === "candidate_body")
      Reflect.set(required(node("release_candidate").read.record), "name", "Substituted name");
    if (fault === "policy_receipt")
      Reflect.set(
        required(node("release_policy").read.record),
        "publishedAt",
        "2026-09-01T00:00:00.001Z",
      );
    if (fault === "result_hash")
      Reflect.set(node("comparison_result").read.observation, "recordSha256", "0".repeat(64));
    if (fault === "snapshot_receipt")
      Reflect.set(
        required(node("comparison_snapshot").read.record),
        "createdAt",
        "2026-09-01T00:00:00.001Z",
      );
    if (fault === "definition_body")
      Reflect.set(
        required(node("comparison_definition").read.record),
        "name",
        "Substituted comparison",
      );
    if (fault === "parent_references") Reflect.set(node("release_candidate"), "references", []);
    if (fault === "edge_hash") Reflect.set(candidateEdge, "parentRecordSha256", "0".repeat(64));
    if (fault === "edge_reference")
      Reflect.set(candidateEdge, "reference", {
        ...candidateEdge.reference,
        path: "/comparisons/100",
      });
    if (fault === "edge_target") Reflect.set(candidateEdge, "target", graph.roots[1]);
    if (fault === "missing_edge")
      Reflect.set(
        graph,
        "edges",
        graph.edges.filter((edge) => edge !== candidateEdge),
      );
    if (fault === "extra_edge")
      Reflect.set(graph, "edges", [
        ...graph.edges,
        { ...candidateEdge, reference: { ...candidateEdge.reference, path: "/fabricated" } },
      ]);
    if (fault === "inventory") Reflect.set(capture.inventory, "members", []);
    if (fault === "selection") Reflect.set(comparison.selection, "status", "missing");
    if (fault === "lineage") {
      if (comparison.status !== "lineage_verified") throw new Error("Missing original lineage");
      Reflect.set(comparison.lineage.result, "latestSourceCutoff", "2026-09-02T00:00:00.000Z");
    }
    expect(() => project(h, capture)).toThrow();
  });

  it("charges all original inspected references, one complete inventory and every repeated rule at exact byte/count boundaries", async () => {
    const h = await harness(inputs());
    const capture = await capturePolicyComparisonEvidence(h.request, h.repositories);
    const report = project(h, capture);
    const originals = capture.graph.nodes.flatMap(({ read, references }) =>
      [
        "release_candidate",
        "release_policy",
        "comparison_result",
        "comparison_definition",
        "comparison_snapshot",
      ].includes(read.source.kind)
        ? (references ?? [])
        : [],
    );
    const frames = [
      ...originals,
      {
        candidate: report.candidate,
        policy: report.policy,
        inventory: report.inventory,
      },
      ...report.rules,
    ];
    const expected = {
      maxReferences: frames.length,
      maxReferenceBytes: frames.reduce(
        (sum, frame) => sum + encodeEvaluationCanonicalJson(frame).byteLength,
        0,
      ),
    };
    expect(report.inspectionUsage).toEqual({
      references: expected.maxReferences,
      referenceBytes: expected.maxReferenceBytes,
    });
    expect(project(h, capture, expected)).toEqual(report);
    expect(() =>
      project(h, capture, { ...expected, maxReferences: expected.maxReferences - 1 }),
    ).toThrow("reference_limit_exceeded");
    expect(() =>
      project(h, capture, { ...expected, maxReferenceBytes: expected.maxReferenceBytes - 1 }),
    ).toThrow("reference_bytes_exceeded");
  });

  it("owns returned inventory, predicates, metrics and strata without mutating captured evidence", async () => {
    const h = await harness(inputs());
    const capture = await capturePolicyComparisonEvidence(h.request, h.repositories);
    const original = structuredClone(capture);
    const report = project(h, capture);
    const binding = required(report.rules[0]).binding;
    if (binding.status !== "metric_bound") throw new Error("Missing exact metric binding");
    Reflect.set(report.inventory, "members", []);
    Reflect.set(required(report.rules[0]).predicate, "metricId", "substituted_metric");
    Reflect.set(binding.metric.definition, "label", "Substituted label");
    Reflect.set(binding.metric.result.samples, "candidateTotal", 999);
    Reflect.set(binding.metric.stratum, "fixtureIds", []);
    expect(capture).toEqual(original);
    expect(project(h, capture)).not.toEqual(report);
  });

  it.each(["body", "references", "observation", "edge"] as const)(
    "rejects fabricated %s on an explicitly missing comparison definition",
    async (fault) => {
      const h = await harness(inputs());
      vi.mocked(h.repositories.control.comparison.findComparisonDefinition).mockResolvedValue(null);
      const capture = await capturePolicyComparisonEvidence(h.request, h.repositories);
      const missing = required(
        capture.graph.nodes.find(({ read }) => read.source.kind === "comparison_definition"),
      );
      expect(missing.read.observation.status).toBe("missing");
      if (fault === "body") Reflect.set(missing.read, "record", h.value.comparison);
      if (fault === "references") Reflect.set(missing, "references", []);
      if (fault === "observation") Reflect.set(missing.read.observation, "reason", "fabricated");
      if (fault === "edge") {
        const original = required(capture.graph.edges[0]);
        Reflect.set(capture.graph, "edges", [
          ...capture.graph.edges,
          { ...original, parent: missing.read.source },
        ]);
      }
      expect(() => project(h, capture)).toThrow("observation_conflict");
    },
  );

  it.each(["available", "unavailable"] as const)(
    "preserves rederived %s usage values and role-specific unavailability without zero substitution",
    async (status) => {
      const value = inputs();
      const currentFixture = required(value.current.fixtures[0]);
      const usage = required(
        currentFixture.usage.find(({ dimension }) => dimension === "elapsedMilliseconds"),
      );
      usage.value =
        status === "available"
          ? {
              status: "available",
              amount: 127,
              observedCount: 1,
              unavailableCount: 0,
              sources: ["measured"],
            }
          : {
              status: "unavailable",
              observedCount: 0,
              unavailableCount: 1,
              unavailableReasons: ["provider_did_not_report"],
            };
      value.current.definitionSha256 = digestComparisonRecordDefinition(
        "comparison_evidence_snapshot",
        value.scope,
        definition(value.current),
      );
      for (const result of value.results)
        Object.assign(
          result,
          deriveComparisonResultDefinition({
            comparison: value.comparison,
            baseline: value.baseline,
            candidate: value.current,
            resultId: result.resultId,
          }),
        );
      const h = await harness(value);
      const report = project(h, await capturePolicyComparisonEvidence(h.request, h.repositories));
      const binding = required(report.rules[0]).binding;
      if (binding.status !== "metric_bound") throw new Error("Missing original usage binding");
      expect(binding.metric.result.value.status).toBe(status);
      expect(binding.metric.result).toEqual(
        required(h.value.results[0]).metricResults.find(
          ({ metricId }) => metricId === "metric_elapsed",
        ),
      );
      expect(binding.metric.result.samples.baselineObservedCount).toBe(1);
      expect(binding.metric.result.samples.candidateObservedCount).toBe(
        status === "available" ? 1 : 0,
      );
      expect(binding.metric.result.samples.candidateUnavailableCount).toBe(
        status === "available" ? 0 : 1,
      );
      if (status === "unavailable") {
        expect(binding.metric.result.value).not.toHaveProperty("candidate");
        expect(binding.metric.result.usageProvenance?.candidate.unavailableReasons).toEqual([
          "provider_did_not_report",
        ]);
      }
      expect(report).not.toHaveProperty("outcome");
    },
  );
});

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
