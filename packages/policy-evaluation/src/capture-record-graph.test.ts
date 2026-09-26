import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  type PolicyEvaluationRequest,
  type PolicyEvaluationRequestDefinition,
  type ReleaseCandidate,
  type ReleaseCandidateDefinition,
  type ReleasePolicy,
  type ReleasePolicyDefinition,
  type ReplayPlanDefinition,
  type EvaluationRun,
  type TargetReleaseDefinition,
  PolicyEvaluationSourceReferenceSchema,
  policyEvaluationSourceReferenceKey,
  encodeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import {
  digestPolicyEvaluationRequestDefinition,
  digestReleaseCandidateDefinition,
  digestReleasePolicyDefinition,
  digestEvaluationRecordDefinition,
  evaluationRecordDescriptors,
  CreateModelAssuranceAssessment,
} from "@proofstack/core";
import {
  createEvaluationRepositoryTestHarness,
  publishEvaluationFixture,
  MemoryReleaseCandidateRepository,
  MemoryReleasePolicyRepository,
  releaseCandidateFixture,
  releasePolicyRepositoryFixture,
  comparisonDefinitionFixture,
  MemoryComparisonRepository,
  createModelAssuranceRepositoryTestHarness,
  FixedClock,
  type EvaluationRepositoryFixtureRecord,
} from "@proofstack/core/testing";
import { digestReplayPlanDefinition, digestTargetReleaseDefinition } from "@proofstack/replay";
import {
  MemoryReplayDefinitionRepository,
  MemoryReplayJobRepository,
} from "@proofstack/replay/testing";
import { describe, expect, it, vi } from "vitest";
import { capturePolicyRecordGraph } from "./capture-record-graph.js";
import { inspectCapturedEvaluationSnapshots } from "./capture-evaluation-snapshots.js";
import { type PolicyRecordGraphRepositories, readAndExpandPolicyRecord } from "./record-routing.js";

type Fields = Record<string, unknown>;
const requestVector = JSON.parse(
  readFileSync(
    new URL(
      "../../contracts/vectors/policy-evaluation-request-definition-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { vectors: { input: { definition: PolicyEvaluationRequestDefinition } }[] };
const defaults = requestVector.vectors[0]?.input.definition;
if (!defaults) throw new Error("Missing request vector");
const time = "2026-10-01T00:00:00.000Z";

function request(
  candidate: ReleaseCandidate,
  policy: ReleasePolicy,
  limits = defaults?.limits,
): PolicyEvaluationRequest {
  const definition: PolicyEvaluationRequestDefinition = {
    ...(defaults as PolicyEvaluationRequestDefinition),
    evaluationTime: time,
    limits: limits as PolicyEvaluationRequestDefinition["limits"],
    candidate: {
      candidateId: candidate.candidateId,
      candidateVersionId: candidate.candidateVersionId,
      definitionSha256: candidate.definitionSha256,
    },
    policy: {
      policyId: policy.policyId,
      policyVersionId: policy.policyVersionId,
      definitionSha256: policy.definitionSha256,
    },
  };
  return {
    ...definition,
    createdAt: time,
    createdByPrincipalId: "principal_graph",
    definitionSha256: digestPolicyEvaluationRequestDefinition(candidate.scope, definition),
    schemaVersion: "0.1",
    scope: structuredClone(candidate.scope),
  };
}

function candidateDigest(candidate: ReleaseCandidate): ReleaseCandidate {
  const {
    createdAt: _at,
    createdByPrincipalId: _by,
    schemaVersion: _version,
    definitionSha256: _hash,
    scope,
    ...definition
  } = candidate;
  return {
    ...candidate,
    definitionSha256: digestReleaseCandidateDefinition(
      scope,
      definition as ReleaseCandidateDefinition,
    ),
  };
}

function policyDigest(policy: ReleasePolicy): ReleasePolicy {
  const {
    publishedAt: _at,
    publishedByPrincipalId: _by,
    schemaVersion: _version,
    definitionSha256: _hash,
    scope,
    ...definition
  } = policy;
  return {
    ...policy,
    definitionSha256: digestReleasePolicyDefinition(scope, definition as ReleasePolicyDefinition),
  };
}

function missingRepositories() {
  const calls: { domain: string; method: string; args: unknown[] }[] = [];
  const port = (domain: string) =>
    new Proxy(
      {},
      {
        get:
          (_target, method) =>
          async (...args: unknown[]) => {
            calls.push({ domain, method: String(method), args: structuredClone(args) });
            return null;
          },
      },
    );
  const repositories = {
    control: {
      comparison: port("comparison"),
      releaseCandidate: port("candidate"),
      releasePolicy: port("policy"),
      installationBinding: port("binding"),
    },
    evidence: { evaluation: port("evaluation"), modelAssurance: port("model") },
    datasets: port("dataset"),
    replayDefinitions: port("replay"),
    replayResults: port("job"),
    runtimeDefinitions: port("runtime"),
  } as PolicyRecordGraphRepositories;
  return { repositories, calls };
}

async function harness(
  replayCase?: "valid" | "invalid_digest" | "unsupported_kind" | "history",
  snapshots?: { mutate?: (fixture: EvaluationRepositoryFixtureRecord) => void },
) {
  const evaluation = createEvaluationRepositoryTestHarness("graph");
  const replayRepository = new MemoryReplayDefinitionRepository();
  const replay = replayCase
    ? (() => {
        const document = JSON.parse(
          readFileSync(
            new URL("../../replay/vectors/replay-definition-v1.json", import.meta.url),
            "utf8",
          ),
        ) as {
          vectors: { kind: string; input: ReplayPlanDefinition | TargetReleaseDefinition }[];
        };
        const targetDefinition = document.vectors.find((v) => v.kind === "target_release")
          ?.input as TargetReleaseDefinition;
        targetDefinition.scope = evaluation.scope;
        if (replayCase === "unsupported_kind") targetDefinition.supportedBoundaryKinds = ["tool"];
        const receipt = {
          createdAt:
            replayCase === "history" ? "2026-09-01T00:00:00.000Z" : "2026-09-08T00:00:00.000Z",
          createdByPrincipalId: "principal_replay_graph",
        };
        const target = {
          ...targetDefinition,
          ...receipt,
          definitionSha256: digestTargetReleaseDefinition(targetDefinition),
        };
        const targetReference = {
          targetId: target.targetId,
          targetReleaseId: target.targetReleaseId,
          definitionSha256: target.definitionSha256,
          targetAdapter: target.targetAdapter,
          workerProtocol: target.workerProtocol,
        };
        const planDefinition = document.vectors.find((v) => v.kind === "replay_plan")
          ?.input as ReplayPlanDefinition;
        planDefinition.scope = evaluation.scope;
        planDefinition.targetRelease = targetReference;
        if (replayCase === "invalid_digest") {
          const boundary = planDefinition.boundaries[0];
          if (boundary?.mode !== "recorded_stub") throw new Error("Expected recorded fixture");
          boundary.invocationDefinitionSha256 = "f".repeat(64);
        }
        const plan = {
          ...planDefinition,
          ...receipt,
          definitionSha256: digestReplayPlanDefinition(planDefinition),
        };
        return {
          target,
          targetReference,
          plan,
          planReference: {
            planId: plan.planId,
            planVersionId: plan.planVersionId,
            definitionSha256: plan.definitionSha256,
          },
        };
      })()
    : undefined;
  if (replay) {
    await replayRepository.publishTargetRelease(replay.target);
    await replayRepository.publishReplayPlan(replay.plan);
  }
  // The upstream evaluation fixtures were created on September 2; their source must precede them.
  let historyTime = "2026-09-01T00:00:00.000Z";
  const replayJobs = new MemoryReplayJobRepository({
    definitions: replayRepository,
    now: () => historyTime,
  });
  let replayResultReference: EvaluationRun["replay"] | undefined;
  if (replay && replayCase === "history") {
    await replayJobs.createJob({
      scope: evaluation.scope,
      jobId: "job_graph_history",
      createdByPrincipalId: "principal_graph",
      plan: replay.planReference,
    });
    historyTime = "2026-09-01T00:00:00.100Z";
    const claim = await replayJobs.claimJob({
      scope: evaluation.scope,
      jobId: "job_graph_history",
      attemptId: "attempt_graph_history",
      leaseId: "lease_graph_history",
      leaseDurationMilliseconds: 1000,
      workerId: "worker_graph_history",
      workerBuildSha256: "b".repeat(64),
      workerProtocol: replay.plan.workerProtocol,
    });
    if (!claim.claimed) throw new Error("Expected claimed graph history");
    historyTime = "2026-09-01T00:00:00.200Z";
    const completed = await replayJobs.completeJob({
      scope: evaluation.scope,
      workerFence: claim.workerFence,
      status: "succeeded",
      code: "completed",
      result: {
        artifactId: "artifact_graph_history",
        sha256: "a".repeat(64),
        sizeBytes: 1,
        mediaType: "application/json",
        classification: "internal",
      },
    });
    const latest = completed.attempts.at(-1);
    if (!latest?.result || !latest.endedAt) throw new Error("Expected completed graph history");
    replayResultReference = {
      jobId: completed.job.jobId,
      attemptId: latest.attemptId,
      completedAt: latest.endedAt,
      plan: replay.planReference,
      targetRelease: replay.targetReference,
      result: latest.result,
      terminalCode: "completed",
      terminalStatus: "succeeded",
    };
  }
  const rewrittenHashes = new Map<string, string>();
  const bind = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    const object = value as Fields;
    if (
      replayResultReference &&
      object["terminalStatus"] === "succeeded" &&
      typeof object["jobId"] === "string"
    )
      Object.assign(object, structuredClone(replayResultReference));
    if (replay && typeof object["planVersionId"] === "string")
      Object.assign(object, replay.planReference);
    if (replay && typeof object["targetReleaseId"] === "string")
      Object.assign(object, replay.targetReference);
    // Independent vectors reuse artifact names for different bytes. Give different descriptors
    // distinct fixture identities, while keeping genuinely identical occurrences shared.
    if (
      typeof object["artifactId"] === "string" &&
      typeof object["sha256"] === "string" &&
      object["artifactId"] !== replayResultReference?.result.artifactId
    ) {
      const suffix = createHash("sha256")
        .update(encodeEvaluationCanonicalJson(object))
        .digest("hex")
        .slice(0, 16);
      object["artifactId"] = `graph_${object["artifactId"]}_${suffix}`;
    }
    if (object["datasetVersionId"] === "dtv_regression_v1")
      object["definitionSha256"] = "7".repeat(64);
    if (object["fixtureVersionId"] === "fxv_boundary") object["definitionSha256"] = "2".repeat(64);
    const hash = object["definitionSha256"];
    if (typeof hash === "string" && rewrittenHashes.has(hash))
      object["definitionSha256"] = rewrittenHashes.get(hash);
    for (const child of Object.values(object)) bind(child);
  };
  for (const fixture of evaluation.records) {
    const oldHash = fixture.record.definitionSha256;
    bind(fixture.record);
    if (snapshots) {
      // Repository vectors exercise local records, not cross-record chronology or distinct cases.
      // Join them into an actual coherent retained snapshot before testing semantic substitutions.
      if (fixture.kind === "evaluation_run" && fixture.record.evaluationRunId === "evr_1")
        fixture.record.fixture.fixtureVersionId = "fxv_schema_v2";
      if (fixture.kind === "raw_observation") {
        fixture.record.startedAt = "2026-09-02T00:00:01.000Z";
        fixture.record.completedAt = "2026-09-02T00:00:02.000Z";
        fixture.record.recordedAt = "2026-09-02T00:00:02.000Z";
      }
      if (fixture.kind === "evaluation_run_result") {
        fixture.record.completedAt = "2026-09-02T00:00:03.000Z";
        fixture.record.recordedAt = "2026-09-02T00:00:03.000Z";
      }
      if (fixture.kind === "evaluation_aggregate")
        fixture.record.createdAt = "2026-09-02T00:00:04.000Z";
      if (fixture.kind === "assessment") fixture.record.createdAt = "2026-09-02T00:00:05.000Z";
      snapshots.mutate?.(fixture);
    }
    const body = structuredClone(fixture.record) as unknown as Fields;
    for (const key of evaluationRecordDescriptors[fixture.kind].receiptKeys) delete body[key];
    fixture.record.definitionSha256 = digestEvaluationRecordDefinition(
      fixture.kind,
      evaluation.scope,
      body,
    );
    rewrittenHashes.set(oldHash, fixture.record.definitionSha256);
    await publishEvaluationFixture(evaluation.repository, fixture);
  }
  const assessment = evaluation.records.find((fixture) => fixture.kind === "assessment");
  const run = evaluation.records.find((fixture) => fixture.kind === "evaluation_run");
  if (assessment?.kind !== "assessment" || run?.kind !== "evaluation_run")
    throw new Error("Missing evaluation graph roots");
  const candidate = candidateDigest({
    ...releaseCandidateFixture("graph", evaluation.scope),
    assessments: [
      {
        assessmentId: assessment.record.assessmentId,
        definitionSha256: assessment.record.definitionSha256,
      },
    ],
    datasets: [run.record.dataset],
    targetRelease: run.record.replay.targetRelease,
    modelAssuranceAssessments: [],
  });
  // The standalone candidate/policy vectors contain placeholder hashes. Bind shared references to
  // the actual evaluation records before publishing this joined fixture; never rewrite the store.
  const policyDraft = releasePolicyRepositoryFixture("graph", evaluation.scope);
  for (const rule of policyDraft.rules) {
    if ("assessment" in rule.predicate && "assessmentId" in rule.predicate.assessment) {
      rule.predicate.assessment.definitionSha256 = assessment.record.definitionSha256;
      rule.predicate.assessment.assessmentId = assessment.record.assessmentId;
    }
  }
  const policy = policyDigest(policyDraft);
  const candidateRepository = new MemoryReleaseCandidateRepository();
  const policyRepository = new MemoryReleasePolicyRepository();
  await candidateRepository.publishReleaseCandidate(candidate);
  await policyRepository.publishReleasePolicy(policy);
  const missing = missingRepositories();
  const { calls } = missing;
  const repositories: PolicyRecordGraphRepositories = {
    ...missing.repositories,
    control: {
      ...missing.repositories.control,
      releaseCandidate: candidateRepository,
      releasePolicy: policyRepository,
    },
    evidence: { ...missing.repositories.evidence, evaluation: evaluation.repository },
    ...(replay ? { replayDefinitions: replayRepository } : {}),
    ...(replayResultReference ? { replayResults: replayJobs } : {}),
  };
  return {
    candidate,
    policy,
    repositories,
    calls,
    evaluation,
    replay,
    replayResultReference,
    input: request(candidate, policy),
  };
}

describe("retained evaluation snapshots in the acquired graph", () => {
  const limits = { maxReferences: 10000, maxReferenceBytes: 4 * 1024 * 1024 };
  it("joins actual published runs, results, aggregates and assessments without extra reads", async () => {
    const h = await harness(undefined, {});
    const repository = h.repositories.evidence.evaluation;
    const observations = vi.spyOn(repository, "findRawObservation");
    const aggregate = vi.spyOn(repository, "findEvaluationAggregate");
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const reports = graph.evaluationSnapshots;
    expect(reports.parents).toHaveLength(4);
    expect(reports.unavailableParents).toEqual([]);
    expect(
      reports.parents.flatMap((p) => p.checks).every((c) => c.observation.status === "matched"),
    ).toBe(true);
    expect(observations).toHaveBeenCalledTimes(2);
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(reports.inspectionUsage.references).toBe(15);
    for (const report of reports.parents) {
      expect(graph.entries).toContainEqual({
        source: report.source,
        observation: { status: "verified", recordSha256: report.recordSha256 },
      });
      expect(report.dependencyEdgeIndexes.length).toBeGreaterThan(0);
      for (const index of report.dependencyEdgeIndexes) expect(graph.edges[index]).toBeDefined();
    }
    const reordered = inspectCapturedEvaluationSnapshots(
      { nodes: [...graph.nodes].reverse(), edges: graph.edges },
      limits,
    );
    expect(reordered).toEqual(reports);
    const before = structuredClone(graph);
    const first = reordered.parents[0];
    if (!first || first.source.kind !== "evaluation_run_result")
      throw new Error("Missing result report");
    first.source.reference.resultId = "result_detached";
    expect(graph).toEqual(before);
    expect(reports).not.toHaveProperty("eligible");
    expect(reports).not.toHaveProperty("sealed");
  });

  it.each([
    "observation_attempt",
    "observation_budget",
    "observation_time",
    "observation_verdict",
    "omitted_observation",
    "result_terminal",
    "duplicate_fixture",
    "dataset_mismatch",
    "aggregate_confidence",
    "aggregate_time",
    "assessment_run",
    "assessment_observation",
    "assessment_coverage",
    "assessment_time",
  ])("detects cross-record inconsistency despite valid individual digests: %s", async (kind) => {
    const h = await harness(undefined, {
      mutate: ({ kind: recordKind, record }: EvaluationRepositoryFixtureRecord) => {
        if (recordKind === "raw_observation" && record.observationId === "obs_0") {
          if (kind === "observation_attempt") record.attemptId = "attempt_other";
          if (kind === "observation_budget") record.budgetUsage.elapsedMilliseconds = 5001;
          if (kind === "observation_time") record.startedAt = "2026-09-01T23:59:59.999Z";
          if (kind === "observation_verdict") {
            record.verdict = "fail";
            record.measurement = { kind: "boolean", metricName: "schema_valid", value: false };
          }
        }
        if (recordKind === "evaluation_run_result" && record.resultId === "evs_0") {
          if (kind === "omitted_observation") record.observations = [];
          if (kind === "result_terminal") record.terminalReason = "attempts_exhausted";
        }
        if (recordKind === "evaluation_run" && record.evaluationRunId === "evr_1") {
          if (kind === "duplicate_fixture") record.fixture.fixtureVersionId = "fxv_schema_v1";
          if (kind === "dataset_mismatch") record.dataset.datasetVersionId = "dtv_other";
        }
        if (recordKind === "evaluation_aggregate") {
          if (kind === "aggregate_confidence" && record.passInterval.status === "reported")
            record.passInterval.interval.confidenceLevelBasisPoints = 9000;
          if (kind === "aggregate_time") record.createdAt = "2026-09-02T00:00:02.999Z";
        }
        if (recordKind === "aggregation_policy" && kind === "assessment_coverage")
          record.minimumApplicableCount = 3;
        if (recordKind === "assessment") {
          if (kind === "assessment_run") record.runs.pop();
          if (kind === "assessment_observation") record.observations.pop();
          if (kind === "assessment_time") record.createdAt = "2026-09-02T00:00:03.999Z";
        }
      },
    });
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const { parents, unavailableParents } = graph.evaluationSnapshots;
    expect(unavailableParents).toEqual([]);
    expect(parents.flatMap((p) => p.checks).some((c) => c.observation.status === "mismatch")).toBe(
      true,
    );
    expect(
      parents.flatMap((p) => p.checks).some((c) => c.observation.status === "unavailable"),
    ).toBe(false);
    const assessment = parents.find((p) => p.source.kind === "assessment");
    const affected = kind.startsWith("assessment_") ? "assessment_snapshot" : "aggregate_history";
    expect(assessment?.checks.find((c) => c.kind === affected)?.observation.status).toBe(
      "mismatch",
    );
  });

  it.each([
    "findEvaluationRun",
    "findRawObservation",
    "findEvaluationRunResult",
    "findAggregationPolicy",
    "findEvaluationAggregate",
    "findAssessment",
  ] as const)(
    "preserves unavailable evidence and does not shrink a favorable snapshot: %s",
    async (method) => {
      const h = await harness(undefined, {});
      vi.spyOn(h.repositories.evidence.evaluation, method).mockResolvedValue(null);
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      const reports = graph.evaluationSnapshots;
      const checks = reports.parents.flatMap((p) => p.checks);
      expect(checks.some((c) => c.observation.status === "mismatch")).toBe(false);
      if (method === "findAssessment") {
        expect(reports.parents).toEqual([]);
        expect(reports.unavailableParents[0]?.source.kind).toBe("assessment");
      } else {
        expect(checks.some((c) => c.observation.status === "unavailable")).toBe(true);
        expect(
          reports.parents
            .find((p) => p.source.kind === "assessment")
            ?.checks.find((c) => c.kind === "aggregate_history")?.observation.status,
        ).toBe("unavailable");
      }
      if (method === "findEvaluationRun")
        expect(
          graph.edges.some(
            (e) =>
              e.reference.kind === "evaluation_run_identity" &&
              e.target === null &&
              e.selectorFailure?.status === "missing",
          ),
        ).toBe(true);
    },
  );

  it("preserves an established bad history alongside another unavailable observation", async () => {
    const h = await harness(undefined, {
      mutate: (fixture) => {
        if (fixture.kind === "raw_observation" && fixture.record.observationId === "obs_0")
          fixture.record.attemptId = "attempt_other";
      },
    });
    const find = h.repositories.evidence.evaluation.findRawObservation.bind(
      h.repositories.evidence.evaluation,
    );
    vi.spyOn(h.repositories.evidence.evaluation, "findRawObservation").mockImplementation(
      (scope, id) => (id === "obs_1" ? Promise.resolve(null) : find(scope, id)),
    );
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const aggregate = graph.evaluationSnapshots.parents.find(
      (p) => p.source.kind === "evaluation_aggregate",
    );
    expect(aggregate?.checks.map((c) => c.observation.status)).toEqual([
      "matched",
      "mismatch",
      "unavailable",
    ]);
    expect(
      graph.evaluationSnapshots.parents
        .find((p) => p.source.kind === "assessment")
        ?.checks.find((c) => c.kind === "aggregate_history")?.observation.status,
    ).toBe("mismatch");
  });

  it("charges nested repeated inputs cumulatively and accepts exact admission boundaries", async () => {
    const h = await harness(undefined, {});
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const usage = graph.evaluationSnapshots.inspectionUsage;
    const exact = { maxReferences: usage.references, maxReferenceBytes: usage.referenceBytes };
    expect(inspectCapturedEvaluationSnapshots(graph, exact)).toEqual(graph.evaluationSnapshots);
    expect(() =>
      inspectCapturedEvaluationSnapshots(graph, { ...exact, maxReferences: usage.references - 1 }),
    ).toThrow("reference_limit_exceeded");
    expect(() =>
      inspectCapturedEvaluationSnapshots(graph, {
        ...exact,
        maxReferenceBytes: usage.referenceBytes - 1,
      }),
    ).toThrow("reference_bytes_exceeded");
    expect(() =>
      inspectCapturedEvaluationSnapshots(graph, { ...exact, maxReferences: -1 }),
    ).toThrow("input_invalid");
  });

  it.each(["record_invalid", "not_yet_available"] as const)(
    "retains the original unavailable observation reason: %s",
    async (reason) => {
      const h = await harness(undefined, {});
      const original = h.repositories.evidence.evaluation.findRawObservation.bind(
        h.repositories.evidence.evaluation,
      );
      vi.spyOn(h.repositories.evidence.evaluation, "findRawObservation").mockImplementation(
        async (scope, id) => {
          const record = await original(scope, id);
          if (record && id === "obs_0") {
            if (reason === "record_invalid") record.definitionSha256 = "f".repeat(64);
            else record.recordedAt = "2026-11-01T00:00:00.000Z";
          }
          return record;
        },
      );
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      const entry = graph.entries.find(
        (e) => e.source.kind === "raw_observation" && e.source.reference.observationId === "obs_0",
      );
      expect(entry?.observation).toEqual({ status: "unavailable", reason });
      const result = graph.evaluationSnapshots.parents.find(
        (p) => p.source.kind === "evaluation_run_result" && p.source.reference.resultId === "evs_0",
      );
      expect(result?.checks[0]?.observation.status).toBe("unavailable");
      expect(
        result?.dependencyEdgeIndexes.some(
          (i) => graph.edges[i]?.target?.kind === "raw_observation",
        ),
      ).toBe(true);
    },
  );

  it("propagates an observation-store failure without a partial successful report", async () => {
    const h = await harness(undefined, {});
    const failure = new Error("Evaluation observation store failed");
    vi.spyOn(h.repositories.evidence.evaluation, "findRawObservation").mockRejectedValue(failure);
    await expect(capturePolicyRecordGraph(h.input, h.repositories)).rejects.toBe(failure);
  });

  it("keeps an empty internal graph empty rather than manufacturing successful checks", () => {
    expect(
      inspectCapturedEvaluationSnapshots(
        { nodes: [], edges: [] },
        { maxReferences: 0, maxReferenceBytes: 0 },
      ),
    ).toEqual({
      parents: [],
      unavailableParents: [],
      inspectionUsage: { references: 0, referenceBytes: 0 },
    });
  });

  it.each([
    "edge_missing",
    "edge_duplicate",
    "parent_hash",
    "node_missing",
    "target_kind",
    "selector_failure_missing",
  ])(
    "rejects a broken internal provenance invariant instead of reporting absent evidence: %s",
    async (kind) => {
      const h = await harness(undefined, {});
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      const edges = structuredClone([...graph.edges]);
      const nodes = structuredClone([...graph.nodes]);
      const index = edges.findIndex(
        (e) => e.parent.kind === "evaluation_run_result" && e.reference.path === "/evaluationRunId",
      );
      const edge = edges[index];
      if (!edge?.target) throw new Error("Missing result edge");
      if (kind === "edge_missing") edges.splice(index, 1);
      if (kind === "edge_duplicate") edges.push(structuredClone(edge));
      if (kind === "parent_hash") Object.assign(edge, { parentRecordSha256: "f".repeat(64) });
      if (kind === "node_missing")
        nodes.splice(
          nodes.findIndex(
            (n) =>
              policyEvaluationSourceReferenceKey(n.read.source) ===
              policyEvaluationSourceReferenceKey(edge.target as NonNullable<typeof edge.target>),
          ),
          1,
        );
      if (kind === "target_kind") Object.assign(edge, { target: graph.roots[0] });
      if (kind === "selector_failure_missing") Object.assign(edge, { target: null });
      expect(() => inspectCapturedEvaluationSnapshots({ nodes, edges }, limits)).toThrow(
        "reference_conflict",
      );
    },
  );
});

describe("request-rooted recursive record graph", () => {
  it.each(["valid", "profile_mismatch", "missing_plan", "missing_result"])(
    "retains replay result binding observations through actual graph acquisition: %s",
    async (kind) => {
      const h = await harness("history");
      const originalFind = h.repositories.replayResults.findJob.bind(h.repositories.replayResults);
      const read = vi.spyOn(h.repositories.replayResults, "findJob");
      if (kind === "profile_mismatch")
        read.mockImplementation(async (scope, id) => {
          const value = await originalFind(scope, id);
          if (value?.attempts[0]) value.attempts[0].runtimeProfile.id = "runtime_other";
          return value;
        });
      if (kind === "missing_plan")
        vi.spyOn(h.repositories.replayDefinitions, "findReplayPlan").mockResolvedValue(null);
      if (kind === "missing_result") read.mockResolvedValue(null);
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      expect(read).toHaveBeenCalledTimes(1);
      if (kind === "missing_result") {
        expect(graph.replayResults.results).toEqual([]);
        expect(graph.replayResults.unavailableResults).toEqual([
          {
            source: { kind: "replay_result", reference: h.replayResultReference },
            observation: { status: "missing" },
          },
        ]);
        return;
      }
      expect(graph.replayResults.results).toHaveLength(1);
      expect(graph.replayResults.unavailableResults).toEqual([]);
      const report = graph.replayResults.results[0];
      expect(report?.source).toEqual({ kind: "replay_result", reference: h.replayResultReference });
      const node = graph.entries.find((e) => e.source.kind === "replay_result");
      expect(node?.observation).toEqual({ status: "verified", recordSha256: report?.recordSha256 });
      expect(
        report?.checks.filter((c) => c.observation.status === "mismatch").map((c) => c.kind),
      ).toEqual(kind === "profile_mismatch" ? ["runtime_profile"] : []);
      if (kind === "missing_plan") {
        expect(report?.plan.recordObservation).toEqual({ status: "missing" });
        expect(report?.checks.find((c) => c.kind === "runtime_profile")?.observation).toEqual({
          status: "unavailable",
          reason: "plan_unavailable",
        });
      } else expect(report?.checks.every((c) => c.observation.status !== "unavailable")).toBe(true);
      expect(graph.edges).toContainEqual({
        parent: report?.source,
        parentRecordSha256: report?.recordSha256,
        reference: { kind: "record", path: "/job/plan", source: report?.plan.source },
        target: report?.plan.source,
      });
      expect(graph).not.toHaveProperty("sealed");
    },
  );

  it("propagates a replay history repository failure without returning partial checks", async () => {
    const h = await harness("history");
    const failure = new Error("History unavailable");
    vi.spyOn(h.repositories.replayResults, "findJob").mockRejectedValue(failure);
    await expect(capturePolicyRecordGraph(h.input, h.repositories)).rejects.toBe(failure);
  });

  it.each(["valid", "invalid_digest", "unsupported_kind"] as const)(
    "retains published replay plan semantics in the actual acquired graph: %s",
    async (kind) => {
      const h = await harness(kind);
      const readPlan = vi.spyOn(h.repositories.replayDefinitions, "findReplayPlan");
      const readTarget = vi.spyOn(h.repositories.replayDefinitions, "findTargetRelease");
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      const report = graph.replayPlans.plans[0];
      expect(graph.replayPlans.plans).toHaveLength(1);
      expect(graph.replayPlans.unavailablePlans).toEqual([]);
      expect(report?.source).toEqual({ kind: "replay_plan", reference: h.replay?.planReference });
      expect(
        report?.checks.filter((c) => c.observation.status === "mismatch").map((c) => c.kind),
      ).toEqual(
        kind === "invalid_digest"
          ? ["invocation_digest"]
          : kind === "unsupported_kind"
            ? ["boundary_kind"]
            : [],
      );
      expect(report?.checks.find((c) => c.kind === "fixture_membership")?.observation).toEqual({
        status: "unavailable",
      });
      expect(readPlan).toHaveBeenCalledTimes(1);
      expect(readTarget).toHaveBeenCalledTimes(1);
      for (const dependency of report?.dependencies ?? []) {
        expect(graph.edges).toContainEqual({
          parent: report?.source,
          parentRecordSha256: report?.recordSha256,
          reference: { kind: "record", path: dependency.path, source: dependency.source },
          target: dependency.source,
        });
        expect(dependency.recordObservation).toEqual(
          graph.entries.find(
            (e) =>
              policyEvaluationSourceReferenceKey(e.source) ===
              policyEvaluationSourceReferenceKey(dependency.source),
          )?.observation,
        );
      }
      expect(graph).not.toHaveProperty("sealed");
      expect(graph).not.toHaveProperty("verdict");
    },
  );

  it.each(["plan", "target"])(
    "preserves missing %s observations, not successful empty replay bindings",
    async (kind) => {
      const h = await harness("valid");
      if (kind === "plan")
        vi.spyOn(h.repositories.replayDefinitions, "findReplayPlan").mockResolvedValue(null);
      else vi.spyOn(h.repositories.replayDefinitions, "findTargetRelease").mockResolvedValue(null);
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      if (kind === "plan")
        expect(graph.replayPlans).toEqual({
          plans: [],
          unavailablePlans: [
            {
              source: { kind: "replay_plan", reference: h.replay?.planReference },
              observation: { status: "missing" },
            },
          ],
        });
      else {
        const plan = graph.replayPlans.plans[0];
        expect(
          plan?.dependencies.find((d) => d.path === "/targetRelease")?.recordObservation,
        ).toEqual({ status: "missing" });
        expect(
          plan?.checks.filter((c) => c.observation.status === "matched").map((c) => c.kind),
        ).toEqual(["invocation_digest"]);
      }
    },
  );

  it("propagates replay storage errors without returning a partial semantic capture", async () => {
    const h = await harness("valid");
    const failure = new Error("Replay storage failure");
    vi.spyOn(h.repositories.replayDefinitions, "findReplayPlan").mockRejectedValue(failure);
    await expect(capturePolicyRecordGraph(h.input, h.repositories)).rejects.toBe(failure);
  });

  it("traverses real immutable evaluation records, terminates backreferences, and retains open frontiers", async () => {
    const setup = await harness();
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    expect(graph.nodes.length).toBeGreaterThan(20);
    expect(graph.edges.length).toBeGreaterThan(graph.nodes.length);
    expect(graph.roots).toEqual([
      { kind: "release_candidate", reference: setup.input.candidate },
      { kind: "release_policy", reference: setup.input.policy },
    ]);
    expect(graph.nodes.filter(({ read }) => read.source.kind === "criterion_set")).toHaveLength(1);
    expect(
      graph.edges.filter(({ reference }) => reference.kind === "criterion_selector").length,
    ).toBeGreaterThan(5);
    expect(
      graph.edges.filter(
        ({ reference, target }) =>
          reference.kind === "criterion_selector" && target?.kind === "criterion_set",
      ).length,
    ).toBeGreaterThan(5);
    expect(graph.unresolved.records).toBeGreaterThan(0);
    expect(graph.unresolved.references).toBeGreaterThan(0);
    expect(
      graph.nodes
        .filter(({ read }) => read.observation.status !== "verified")
        .every(({ references }) => references === null),
    ).toBe(true);
    expect(
      graph.edges.some(({ reference, target }) => reference.kind === "artifact" && target === null),
    ).toBe(true);
    const keys = graph.entries.map(({ source }) => policyEvaluationSourceReferenceKey(source));
    expect(keys).toEqual([...new Set(keys)].sort());
    expect(graph.edges[0]?.parent.kind).toBe("release_candidate");
    expect(graph.usage.references).toBe(graph.edges.length);
    expect(graph.usage.referenceBytes).toBe(
      graph.edges.reduce(
        (sum, edge) => sum + encodeEvaluationCanonicalJson(edge.reference).byteLength,
        0,
      ),
    );
    expect(graph).not.toHaveProperty("sealed");
    expect(graph).not.toHaveProperty("verdict");
  });

  it("produces identical graphs on repeated reads without changing caller or repository state", async () => {
    const setup = await harness();
    const original = structuredClone(setup.input);
    const first = await capturePolicyRecordGraph(setup.input, setup.repositories);
    const second = await capturePolicyRecordGraph(setup.input, setup.repositories);
    expect(first).toEqual(second);
    expect(setup.input).toEqual(original);
    (first.roots[0]?.reference as { definitionSha256: string }).definitionSha256 = "f".repeat(64);
    const stored = await setup.repositories.control.releaseCandidate.findReleaseCandidate(
      setup.input.scope,
      setup.candidate.candidateVersionId,
    );
    expect(stored).toEqual(setup.candidate);
    expect(setup.input).toEqual(original);
  });

  it("retains both missing roots without inventing child records or accepting an empty graph", async () => {
    const setup = await harness();
    const missing = missingRepositories();
    const graph = await capturePolicyRecordGraph(setup.input, missing.repositories);
    expect(graph.entries).toHaveLength(2);
    expect(graph.entries.every(({ observation }) => observation.status === "missing")).toBe(true);
    expect(graph.unresolved).toEqual({ records: 2, references: 0 });
    expect(graph.usage).toMatchObject({ reads: 2, records: 2, bytes: 8, references: 0 });
    expect(missing.calls.map(({ domain }) => domain)).toEqual(["candidate", "policy"]);
  });

  it("rejects forged request digests and caller-added roots before storage access", async () => {
    const setup = await harness();
    const missing = missingRepositories();
    for (const input of [
      { ...setup.input, definitionSha256: "f".repeat(64) },
      { ...setup.input, roots: [] },
    ])
      await expect(capturePolicyRecordGraph(input, missing.repositories)).rejects.toMatchObject({
        code: "policy_evaluation_request_record_invalid",
      });
    expect(missing.calls).toHaveLength(0);
  });

  it("preserves unavailable roots and does not turn them into verified leaves", async () => {
    const setup = await harness();
    setup.repositories = {
      ...setup.repositories,
      control: {
        ...setup.repositories.control,
        releaseCandidate: {
          findReleaseCandidate: async () =>
            ({ ...setup.candidate, extra: true }) as ReleaseCandidate,
        },
      },
    };
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    const node = graph.nodes.find(({ read }) => read.source.kind === "release_candidate");
    expect(node).toMatchObject({
      read: { record: null, observation: { status: "unavailable", reason: "record_invalid" } },
      references: null,
    });
  });

  it("returns no partial graph when cumulative records, bytes, or references exceed limits", async () => {
    const setup = await harness();
    for (const [dimension, limit] of [
      ["maxAcquisitionRecords", 2],
      ["maxAcquisitionRecordBytes", 1],
    ] as const) {
      const input = request(setup.candidate, setup.policy, {
        ...setup.input.limits,
        [dimension]: limit,
      });
      await expect(capturePolicyRecordGraph(input, setup.repositories)).rejects.toMatchObject({
        code:
          dimension === "maxAcquisitionRecords"
            ? "policy_evaluation_evidence_references_invalid"
            : "policy_record_graph_failed",
      });
    }
    const missing = missingRepositories();
    const exact = request(setup.candidate, setup.policy, {
      ...setup.input.limits,
      maxAcquisitionRecords: 2,
      maxAcquisitionRecordBytes: 8,
    });
    expect((await capturePolicyRecordGraph(exact, missing.repositories)).usage.bytes).toBe(8);
    await expect(
      capturePolicyRecordGraph(
        request(setup.candidate, setup.policy, { ...exact.limits, maxAcquisitionRecordBytes: 7 }),
        missing.repositories,
      ),
    ).rejects.toMatchObject({ reason: "byte_limit" });
  });

  it("propagates repository failures instead of fabricating missing graph nodes", async () => {
    const setup = await harness();
    const failure = new Error("database offline");
    setup.repositories = {
      ...setup.repositories,
      control: {
        ...setup.repositories.control,
        releasePolicy: {
          findReleasePolicy: async () => {
            throw failure;
          },
        },
      },
    };
    await expect(capturePolicyRecordGraph(setup.input, setup.repositories)).rejects.toBe(failure);
  });

  it("keeps failed selector occurrences as explicit unresolved edges", async () => {
    const setup = await harness();
    const original = setup.repositories.evidence.evaluation;
    setup.repositories = {
      ...setup.repositories,
      evidence: {
        ...setup.repositories.evidence,
        evaluation: new Proxy(original, {
          get(target, key) {
            if (key === "findCriterionSet") return async () => null;
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      },
    };
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    expect(
      graph.edges
        .filter(({ reference }) => reference.kind === "criterion_selector")
        .every(
          ({ target, selectorFailure }) => target === null && selectorFailure?.status === "missing",
        ),
    ).toBe(true);
    expect(graph.edges.some(({ selectorFailure }) => selectorFailure?.status === "missing")).toBe(
      true,
    );
  });

  it("rejects conflicting exact references from different parents", async () => {
    const setup = await harness();
    const draft = structuredClone(setup.policy);
    for (const rule of draft.rules)
      if ("assessment" in rule.predicate && "assessmentId" in rule.predicate.assessment)
        rule.predicate.assessment.definitionSha256 = "f".repeat(64);
    const policy = policyDigest(draft);
    await expect(
      capturePolicyRecordGraph(request(setup.candidate, policy), {
        ...setup.repositories,
        control: {
          ...setup.repositories.control,
          releasePolicy: { findReleasePolicy: async () => policy },
        },
      }),
    ).rejects.toMatchObject({
      reason: "reference_conflict",
      identity: `assessment:${setup.candidate.assessments[0]?.assessmentId}`,
    });
  });

  it("rejects conflicting artifact descriptors even when each parent is internally consistent", async () => {
    const setup = await harness();
    const previous = structuredClone(setup.candidate);
    previous.candidateVersionId = "candidate_graph_prior";
    const build = previous.buildArtifacts[0];
    if (!build) throw new Error("Missing build artifact");
    build.artifact.sizeBytes++;
    const retained = candidateDigest(previous);
    const candidate = candidateDigest({
      ...setup.candidate,
      predecessor: {
        candidateId: retained.candidateId,
        candidateVersionId: retained.candidateVersionId,
        definitionSha256: retained.definitionSha256,
      },
    });
    await expect(
      capturePolicyRecordGraph(request(candidate, setup.policy), {
        ...setup.repositories,
        control: {
          ...setup.repositories.control,
          releaseCandidate: {
            findReleaseCandidate: async (_scope, id) =>
              id === candidate.candidateVersionId ? candidate : retained,
          },
        },
      }),
    ).rejects.toMatchObject({
      reason: "reference_conflict",
      identity: `artifact:${build.artifact.artifactId}`,
    });
  });

  it("rejects changed full-record receipts across repeated exact selector reads", async () => {
    const setup = await harness();
    const original = setup.repositories.evidence.evaluation;
    let reads = 0;
    const repositories = {
      ...setup.repositories,
      evidence: {
        ...setup.repositories.evidence,
        evaluation: new Proxy(original, {
          get(target, key) {
            if (key === "findCriterionSet")
              return async (...args: Parameters<typeof original.findCriterionSet>) => {
                const value = await original.findCriterionSet(...args);
                reads++;
                return value && reads > 1
                  ? { ...value, publishedAt: "2026-09-03T00:00:00.000Z" }
                  : value;
              };
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      },
    };
    await expect(capturePolicyRecordGraph(setup.input, repositories)).rejects.toMatchObject({
      reason: "observation_conflict",
    });
    expect(reads).toBeGreaterThan(1);
  });

  it("keeps unavailable selectors distinct from missing and does not manufacture their hashes", async () => {
    const setup = await harness();
    const original = setup.repositories.evidence.evaluation;
    const repositories = {
      ...setup.repositories,
      evidence: {
        ...setup.repositories.evidence,
        evaluation: new Proxy(original, {
          get(target, key) {
            if (key === "findCriterionSet")
              return async (...args: Parameters<typeof original.findCriterionSet>) => {
                const value = await original.findCriterionSet(...args);
                return value && { ...value, publishedAt: "2027-01-01T00:00:00.000Z" };
              };
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      },
    };
    const graph = await capturePolicyRecordGraph(setup.input, repositories);
    const edges = graph.edges.filter(({ reference }) => reference.kind === "criterion_selector");
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges)
      expect(edge).toMatchObject({
        target: null,
        selectorFailure: { status: "unavailable", reason: "not_yet_available" },
      });
  });

  it("admits exact aggregate budgets and rejects one byte or occurrence less", async () => {
    const setup = await harness();
    const graph = await capturePolicyRecordGraph(setup.input, setup.repositories);
    const limits = {
      ...setup.input.limits,
      maxAcquisitionRecords: graph.usage.references,
      maxAcquisitionRecordBytes: graph.usage.bytes + graph.usage.referenceBytes,
    };
    expect(graph.usage.references).toBeGreaterThan(graph.usage.records);
    const exact = await capturePolicyRecordGraph(
      request(setup.candidate, setup.policy, limits),
      setup.repositories,
    );
    expect(exact.usage).toEqual(graph.usage);
    for (const [key, reason] of [
      ["maxAcquisitionRecords", "reference_limit"],
      ["maxAcquisitionRecordBytes", "byte_limit"],
    ] as const)
      await expect(
        capturePolicyRecordGraph(
          request(setup.candidate, setup.policy, { ...limits, [key]: limits[key] - 1 }),
          setup.repositories,
        ),
      ).rejects.toMatchObject({ code: "policy_record_graph_failed", reason });
  });

  it("retains a comparison predecessor edge and expands the prefetched definition without rereading it", async () => {
    const setup = await harness();
    const repository = new MemoryComparisonRepository();
    const prior = comparisonDefinitionFixture("graph", setup.input.scope);
    const successor = comparisonDefinitionFixture("graph", setup.input.scope, {
      predecessor: {
        comparisonVersionId: prior.comparisonVersionId,
        definitionSha256: prior.definitionSha256,
      },
      version: "v2",
    });
    await repository.publishComparisonDefinition(prior);
    await repository.publishComparisonDefinition(successor);
    const rule = structuredClone(
      setup.policy.rules.find(({ predicate }) => predicate.kind === "comparison_threshold"),
    );
    if (rule?.predicate.kind !== "comparison_threshold") throw new Error("Missing comparison rule");
    rule.predicate.comparison = {
      comparisonId: successor.comparisonId,
      comparisonVersionId: successor.comparisonVersionId,
      definitionSha256: successor.definitionSha256,
    };
    const policy = policyDigest({
      ...setup.policy,
      rules: [
        rule,
        ...setup.policy.rules.filter(({ predicate }) => predicate.kind === "approval_required"),
      ].sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0)),
    });
    const read = vi.spyOn(repository, "findComparisonDefinition");
    const missing = missingRepositories();
    const graph = await capturePolicyRecordGraph(request(setup.candidate, policy), {
      ...missing.repositories,
      control: {
        ...missing.repositories.control,
        comparison: repository,
        releasePolicy: { findReleasePolicy: async () => policy },
      },
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(
      graph.nodes.filter(({ read }) => read.source.kind === "comparison_definition"),
    ).toHaveLength(2);
    expect(graph.edges.find(({ reference }) => reference.path === "/predecessor")).toMatchObject({
      target: {
        kind: "comparison_definition",
        reference: { comparisonVersionId: prior.comparisonVersionId },
      },
    });
  });

  it("waits for an already-started fixture sibling read before exposing a storage failure", async () => {
    const setup = await harness();
    const failure = new Error("fixture store offline");
    let release!: (value: null) => void;
    let started!: () => void;
    const pending = new Promise<null>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finished = false;
    const capture = capturePolicyRecordGraph(setup.input, {
      ...setup.repositories,
      datasets: {
        findDatasetVersion: async () => null,
        findFixtureVersion: async () => {
          throw failure;
        },
        findRecordedInteractionFixtureVersion: async () => {
          started();
          return pending;
        },
      },
    }).catch((error: unknown) => {
      finished = true;
      return error;
    });
    await entered;
    await Promise.resolve();
    expect(finished).toBe(false);
    release(null);
    expect(await capture).toBe(failure);
    expect(finished).toBe(true);
  });

  it("retains the normal model-profile/evaluator cycle while expanding each exact node only once", async () => {
    const setup = await harness();
    const model = await createModelAssuranceRepositoryTestHarness("graph");
    const assessment = await new CreateModelAssuranceAssessment({
      clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
      evaluationRepository: model.evaluation.repository,
      modelAssuranceRepository: model.repository,
    }).execute(model.command);
    const candidate = candidateDigest({
      ...setup.candidate,
      assessments: [assessment.record.baseAssessment],
      modelAssuranceAssessments: [
        {
          assessmentExtensionId: assessment.record.assessmentExtensionId,
          definitionSha256: assessment.record.definitionSha256,
        },
      ],
    });
    const missing = missingRepositories();
    const allowed = new Set([
      "model_assurance_assessment",
      "model_qualification_report",
      "model_evaluator_profile",
      "model_assisted_evaluator",
    ]);
    const graph = await capturePolicyRecordGraph(request(candidate, setup.policy), {
      ...missing.repositories,
      control: {
        ...missing.repositories.control,
        releaseCandidate: { findReleaseCandidate: async () => candidate },
      },
      evidence: {
        ...missing.repositories.evidence,
        modelAssurance: {
          find: async (scope, kind, id) =>
            allowed.has(kind) ? model.repository.find(scope, kind, id) : null,
        },
      },
    });
    for (const kind of ["model_evaluator_profile", "model_assisted_evaluator_spec"])
      expect(graph.nodes.filter(({ read }) => read.source.kind === kind)).toHaveLength(1);
    expect(
      graph.edges.find(({ reference }) => reference.kind === "model_evaluator_selector"),
    ).toMatchObject({ target: { kind: "model_assisted_evaluator_spec" } });
    expect(
      graph.edges.some(
        ({ parent, target }) =>
          parent.kind === "model_assisted_evaluator_spec" &&
          target?.kind === "model_evaluator_profile",
      ),
    ).toBe(true);
    expect(graph.usage.reads).toBeLessThan(50);
  });

  it("owns the validated request before a repository can mutate the caller's context", async () => {
    const setup = await harness();
    const original = structuredClone(setup.input);
    const missing = missingRepositories();
    const graph = await capturePolicyRecordGraph(setup.input, {
      ...missing.repositories,
      control: {
        ...missing.repositories.control,
        releaseCandidate: {
          findReleaseCandidate: async () => {
            setup.input.scope.tenantId = "tenant_mutated";
            setup.input.policy.definitionSha256 = "f".repeat(64);
            setup.input.limits.maxAcquisitionRecordBytes = 1;
            return null;
          },
        },
      },
    });
    expect(graph.scope).toEqual(original.scope);
    expect(graph.roots[1]).toEqual({ kind: "release_policy", reference: original.policy });
    expect(graph.usage.bytes).toBe(8);
    expect(missing.calls[0]?.args[0]).toEqual(original.scope);
  });
});

describe("fixed cross-domain routing", () => {
  it("routes every declared source kind without a plugin validator or latest lookup", async () => {
    const setup = await harness();
    const run = setup.evaluation.records.find(({ kind }) => kind === "evaluation_run");
    if (run?.kind !== "evaluation_run") throw new Error("Missing replay reference");
    const runtimeVectors = JSON.parse(
      readFileSync(
        new URL("../../contracts/vectors/runtime-definition-v1.json", import.meta.url),
        "utf8",
      ),
    ) as { vectors: { input: { definition: Fields } }[] };
    const readLimits = { maxReferences: 1000, maxReferenceBytes: 1000000 };
    expect(PolicyEvaluationSourceReferenceSchema.options).toHaveLength(44);
    for (const option of PolicyEvaluationSourceReferenceSchema.options) {
      const kind = option.shape.kind.value;
      const runtime = runtimeVectors.vectors.find(
        ({ input }) => input.definition["recordKind"] === kind,
      )?.input.definition;
      const reference =
        kind === "replay_result"
          ? run.record.replay
          : kind === "target_release"
            ? run.record.replay.targetRelease
            : Object.fromEntries(
                Object.keys(option.shape.reference.shape).map((key) => [
                  key,
                  key === "definitionSha256"
                    ? "a".repeat(64)
                    : key === "role"
                      ? "candidate"
                      : (runtime?.[key] ?? "record_one"),
                ]),
              );
      const source = PolicyEvaluationSourceReferenceSchema.parse({ kind, reference });
      const missing = missingRepositories();
      const expansion = await readAndExpandPolicyRecord(
        { scope: setup.input.scope, evaluationTime: time, source },
        missing.repositories,
        readLimits,
        { maximumRecords: 1000, maximumRecordBytes: 1000000 },
      );
      expect(expansion, kind).toEqual({
        read: { source, observation: { status: "missing" }, record: null },
        references: null,
      });
      expect(missing.calls.length, kind).toBe(kind === "regression_fixture_version" ? 2 : 1);
      const domain = kind.startsWith("comparison_")
        ? "comparison"
        : kind === "release_candidate"
          ? "candidate"
          : kind === "release_policy"
            ? "policy"
            : kind === "policy_installation_binding"
              ? "binding"
              : ["dataset_version", "regression_fixture_version"].includes(kind)
                ? "dataset"
                : ["replay_plan", "target_release"].includes(kind)
                  ? "replay"
                  : kind === "replay_result"
                    ? "job"
                    : runtime
                      ? "runtime"
                      : [
                            "blinded_plan",
                            "blinded_result",
                            "calibration_report",
                            "human_review_protocol",
                            "human_review_record",
                            "human_reviewer_independence",
                            "independence_declaration",
                            "independent_critique",
                            "model_assisted_evaluator_spec",
                            "model_assurance_assessment",
                            "model_evaluator_profile",
                            "model_qualification_report",
                            "model_qualification_suite",
                          ].includes(kind)
                        ? "model"
                        : "evaluation";
      expect(
        missing.calls.every((call) => call.domain === domain),
        kind,
      ).toBe(true);
    }
  });
});
