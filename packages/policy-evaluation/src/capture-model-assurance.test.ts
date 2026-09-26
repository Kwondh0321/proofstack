import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationRequestDefinition,
  policyEvaluationSourceReferenceKey,
  type ReleaseCandidate,
  type ReleaseCandidateDefinition,
} from "@proofstack/contracts";
import {
  CreateModelAssuranceAssessment,
  digestApplicabilityContext,
  digestEvaluationRecordDefinition,
  digestModelAssuranceRecordDefinition,
  digestPolicyEvaluationRequestDefinition,
  digestReleaseCandidateDefinition,
  evaluationRecordDescriptors,
} from "@proofstack/core";
import {
  createModelAssuranceRepositoryTestHarness,
  type EvaluationRepositoryFixtureRecord,
  FixedClock,
  MemoryEvaluationRepository,
  MemoryModelAssuranceRepository,
  MemoryReleaseCandidateRepository,
  type ModelAssuranceRepositoryFixtureRecord,
  publishEvaluationFixture,
  releaseCandidateFixture,
} from "@proofstack/core/testing";
import { describe, expect, it, vi } from "vitest";
import { inspectCapturedModelAssurance } from "./capture-model-assurance.js";
import { capturePolicyRecordGraph } from "./capture-record-graph.js";
import type { PolicyRecordGraphRepositories } from "./record-routing.js";

type Fields = Record<string, unknown>;
type Fixture =
  | { family: "evaluation"; fixture: EvaluationRepositoryFixtureRecord }
  | { family: "model"; fixture: ModelAssuranceRepositoryFixtureRecord };
const limits = { maxReferences: 10000, maxReferenceBytes: 4 * 1024 * 1024 };
const vector = JSON.parse(
  readFileSync(
    new URL(
      "../../contracts/vectors/policy-evaluation-request-definition-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  vectors: { input: { definition: PolicyEvaluationRequestDefinition } }[];
};

async function harness(
  mutate?: (value: Fixture) => void,
  options: { reviewHistory?: boolean; copies?: number } = {},
) {
  const source = await createModelAssuranceRepositoryTestHarness("model_graph");
  const created = await new CreateModelAssuranceAssessment({
    clock: new FixedClock(new Date("2026-09-02T06:00:00.000Z")),
    evaluationRepository: source.evaluation.repository,
    modelAssuranceRepository: source.repository,
  }).execute(source.command);
  const scope = source.evaluation.scope;
  const evaluation = new MemoryEvaluationRepository();
  const model = new MemoryModelAssuranceRepository();
  const hashes = new Map<string, string>();
  const bind = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    const object = value as Fields;
    // Standalone examples reuse artifact labels. Give distinct descriptors distinct IDs BEFORE
    // hashing/publication, and preserve genuine shared descriptors. Production checks stay strict.
    if (typeof object["artifactId"] === "string" && typeof object["sha256"] === "string")
      object["artifactId"] =
        `joined_${object["artifactId"].slice(0, 38)}_${createHash("sha256").update(encodeEvaluationCanonicalJson(object)).digest("hex").slice(0, 16)}`;
    if (object["datasetVersionId"] === "dtv_regression_v1")
      object["definitionSha256"] = "7".repeat(64);
    if (object["fixtureVersionId"] === "fxv_boundary") object["definitionSha256"] = "2".repeat(64);
    const digest = object["definitionSha256"];
    if (typeof digest === "string" && hashes.has(digest))
      object["definitionSha256"] = hashes.get(digest);
    for (const child of Object.values(object)) bind(child);
  };
  const raw = source.evaluation.records.find(
    (f) => f.kind === "raw_observation" && f.record.verdict === "pass",
  );
  const corpus = source.evaluation.records.find((f) => f.kind === "qualification_fixture_set");
  const base = source.evaluation.records.find((f) => f.kind === "assessment");
  const run = source.evaluation.records.find(
    (f) =>
      f.kind === "evaluation_run" &&
      raw?.kind === "raw_observation" &&
      f.record.evaluationRunId === raw.record.run.evaluationRunId,
  );
  if (
    raw?.kind !== "raw_observation" ||
    corpus?.kind !== "qualification_fixture_set" ||
    base?.kind !== "assessment" ||
    run?.kind !== "evaluation_run"
  )
    throw new Error("Missing graph fixtures");
  const originalCorpus = {
    fixtureSetId: corpus.record.fixtureSetId,
    fixtureSetVersionId: corpus.record.fixtureSetVersionId,
    definitionSha256: corpus.record.definitionSha256,
  };
  const blindObservations = [0, 1].map((i) => ({
    ...structuredClone(raw.record),
    observationId: `obs_model_${i}`,
    startedAt: "2026-09-02T00:40:00.000Z",
    completedAt: "2026-09-02T00:40:01.000Z",
    recordedAt: "2026-09-02T00:40:01.000Z",
  }));
  const evaluationRecords: EvaluationRepositoryFixtureRecord[] = [
    ...structuredClone(source.evaluation.records),
    ...[0, 1].map((i) => ({
      kind: "evaluation_run" as const,
      record: { ...structuredClone(run.record), evaluationRunId: `evr_model_${i}` },
    })),
    ...blindObservations.map((record) => ({ kind: "raw_observation" as const, record })),
  ];
  for (const fixture of evaluationRecords) {
    const { kind, record } = fixture;
    const oldHash = record.definitionSha256;
    if (fixture.kind === "criterion_set")
      for (const criterion of fixture.record.criteria) {
        const expression = criterion.applicability;
        if (expression.operator !== "allOf" || expression.operands[0]?.operator !== "equals")
          throw new Error("Missing environment clause");
        expression.operands[0].value = scope.environmentId;
      }
    if (fixture.kind === "qualification_report") {
      fixture.record.startedAt =
        fixture.record.completedAt =
        fixture.record.validFrom =
          "2026-09-02T00:00:00.000Z";
    }
    if (fixture.kind === "evaluation_run") {
      fixture.record.applicability.evaluatedAt = "2026-09-02T00:00:00.000Z";
      fixture.record.applicability.context.environmentId = scope.environmentId;
      fixture.record.applicability.context.populationTags = ["adult users"];
      fixture.record.applicability.contextSha256 = digestApplicabilityContext(
        fixture.record.applicability.context,
      );
      if (fixture.record.evaluationRunId === "evr_1")
        fixture.record.fixture.fixtureVersionId = "fxv_schema_v2";
    }
    if (
      fixture.kind === "raw_observation" &&
      !fixture.record.observationId.startsWith("obs_model_")
    ) {
      fixture.record.startedAt = "2026-09-02T00:00:01.000Z";
      fixture.record.completedAt = fixture.record.recordedAt = "2026-09-02T00:00:02.000Z";
    }
    if (fixture.kind === "evaluation_run_result")
      fixture.record.completedAt = fixture.record.recordedAt = "2026-09-02T00:00:03.000Z";
    if (fixture.kind === "evaluation_aggregate")
      fixture.record.createdAt = "2026-09-02T00:00:04.000Z";
    if (fixture.kind === "assessment") fixture.record.createdAt = "2026-09-02T00:00:05.000Z";
    if (
      fixture.kind === "raw_observation" &&
      fixture.record.observationId.startsWith("obs_model_")
    ) {
      const runId = fixture.record.observationId.replace("obs_model_", "evr_model_");
      const linkedRun = evaluationRecords.find(
        (f) => f.kind === "evaluation_run" && f.record.evaluationRunId === runId,
      );
      if (linkedRun?.kind !== "evaluation_run") throw new Error("Missing blind run");
      fixture.record.run = {
        evaluationRunId: runId,
        definitionSha256: linkedRun.record.definitionSha256,
      };
    }
    mutate?.({ family: "evaluation", fixture });
    bind(record);
    const definition = structuredClone(record) as unknown as Fields;
    for (const key of evaluationRecordDescriptors[kind].receiptKeys) delete definition[key];
    record.definitionSha256 = digestEvaluationRecordDefinition(kind, scope, definition);
    // Additional blind observations must not replace the canonical base observation hash.
    if (
      !(
        fixture.kind === "raw_observation" && fixture.record.observationId.startsWith("obs_model_")
      ) &&
      !(
        fixture.kind === "evaluation_run" && fixture.record.evaluationRunId.startsWith("evr_model_")
      )
    )
      hashes.set(oldHash, record.definitionSha256);
    await publishEvaluationFixture(evaluation, fixture);
  }
  const receiptKeys = [
    "definitionSha256",
    "schemaVersion",
    "scope",
    "recordedAt",
    "recordedByPrincipalId",
    "publishedAt",
    "publishedByPrincipalId",
  ];
  const modelRecords = [
    ...structuredClone(source.records),
    { kind: "model_assurance_assessment" as const, record: structuredClone(created.record) },
  ];
  let priorReview:
    | Extract<ModelAssuranceRepositoryFixtureRecord, { kind: "human_review_record" }>
    | undefined;
  if (options.reviewHistory) {
    const index = modelRecords.findIndex((f) => f.kind === "human_review_record");
    const current = modelRecords[index];
    if (current?.kind !== "human_review_record") throw new Error("Missing review");
    priorReview = structuredClone(current);
    priorReview.record.reviewId = "hrr_earlier_opposition";
    priorReview.record.action = "oppose";
    modelRecords.splice(index, 0, priorReview);
    // Its hash is computed before the successor is published below.
    current.record.supersedes = {
      reviewId: priorReview.record.reviewId,
      definitionSha256: priorReview.record.definitionSha256,
    };
  }
  for (const fixture of modelRecords) {
    const oldHash = fixture.record.definitionSha256;
    if (fixture.kind === "model_assisted_evaluator") {
      fixture.record.qualificationFixtureSet = structuredClone(originalCorpus);
      fixture.record.supportedCriteria = [
        {
          criterionId: base.record.criterion.criterionId,
          criterionSetId: base.record.criterion.criterionSet.criterionSetId,
          criterionSetVersionId: base.record.criterion.criterionSet.criterionSetVersionId,
        },
      ];
    }
    if (fixture.kind === "model_qualification_suite")
      fixture.record.baseQualificationFixtureSet = structuredClone(originalCorpus);
    if (fixture.kind === "blinded_evaluation_result")
      fixture.record.attempts.forEach((attempt, i) => {
        const observation = evaluationRecords.find(
          (f) => f.kind === "raw_observation" && f.record.observationId === `obs_model_${i}`,
        );
        if (attempt.status !== "completed" || observation?.kind !== "raw_observation")
          throw new Error("Missing blind observation");
        attempt.observation = {
          observationId: observation.record.observationId,
          definitionSha256: observation.record.definitionSha256,
        };
      });
    if (fixture.kind === "human_review_record" && fixture.record.supersedes && priorReview)
      fixture.record.supersedes.definitionSha256 = priorReview.record.definitionSha256;
    if (fixture.kind === "model_assurance_assessment" && priorReview)
      fixture.record.humanReviews.unshift({
        reviewId: priorReview.record.reviewId,
        definitionSha256: priorReview.record.definitionSha256,
      });
    mutate?.({ family: "model", fixture });
    bind(fixture.record);
    const definition = structuredClone(fixture.record) as unknown as Fields;
    for (const key of receiptKeys) delete definition[key];
    fixture.record.definitionSha256 = digestModelAssuranceRecordDefinition(
      fixture.kind,
      scope,
      definition,
    );
    if (fixture !== priorReview) hashes.set(oldHash, fixture.record.definitionSha256);
    await model.publish(fixture.kind, fixture.record);
  }
  const last = modelRecords.at(-1);
  if (last?.kind !== "model_assurance_assessment") throw new Error("Missing assessment");
  const candidateDraft = releaseCandidateFixture("model_graph", scope);
  candidateDraft.assessments = [last.record.baseAssessment];
  candidateDraft.modelAssuranceAssessments = [
    {
      assessmentExtensionId: last.record.assessmentExtensionId,
      definitionSha256: last.record.definitionSha256,
    },
  ];
  for (let i = 1; i < (options.copies ?? 1); i++) {
    const record = structuredClone(last.record);
    record.assessmentExtensionId = `${record.assessmentExtensionId}_${i}`;
    const definition = structuredClone(record) as unknown as Fields;
    for (const key of receiptKeys) delete definition[key];
    record.definitionSha256 = digestModelAssuranceRecordDefinition(
      "model_assurance_assessment",
      scope,
      definition,
    );
    await model.publish("model_assurance_assessment", record);
    candidateDraft.modelAssuranceAssessments.push({
      assessmentExtensionId: record.assessmentExtensionId,
      definitionSha256: record.definitionSha256,
    });
  }
  bind(candidateDraft);
  const {
    createdAt: _at,
    createdByPrincipalId: _by,
    schemaVersion: _version,
    definitionSha256: _hash,
    scope: _scope,
    ...definition
  } = candidateDraft;
  const candidate: ReleaseCandidate = {
    ...candidateDraft,
    definitionSha256: digestReleaseCandidateDefinition(
      scope,
      definition as ReleaseCandidateDefinition,
    ),
  };
  const candidates = new MemoryReleaseCandidateRepository();
  await candidates.publishReleaseCandidate(candidate);
  const missing = () => new Proxy({}, { get: () => async () => null });
  const repositories = {
    control: {
      comparison: missing(),
      installationBinding: missing(),
      releasePolicy: missing(),
      releaseCandidate: candidates,
    },
    evidence: { evaluation, modelAssurance: model },
    datasets: missing(),
    replayDefinitions: missing(),
    replayResults: missing(),
    runtimeDefinitions: missing(),
  } as unknown as PolicyRecordGraphRepositories;
  const defaults = vector.vectors[0]?.input.definition;
  if (!defaults) throw new Error("Missing request vector");
  const requestDefinition = {
    ...defaults,
    evaluationTime: "2026-10-01T00:00:00.000Z",
    candidate: {
      candidateId: candidate.candidateId,
      candidateVersionId: candidate.candidateVersionId,
      definitionSha256: candidate.definitionSha256,
    },
  };
  const input = {
    ...requestDefinition,
    schemaVersion: "0.1",
    scope,
    createdAt: requestDefinition.evaluationTime,
    createdByPrincipalId: "usr_graph",
    definitionSha256: digestPolicyEvaluationRequestDefinition(scope, requestDefinition),
  };
  return { repositories, input, model, evaluation, assessment: last.record };
}

describe("captured model and human assurance bindings", () => {
  it.each([
    ["calibration_locale", "calibration"],
    ["calibration_unavailable", "calibration"],
    ["model_unqualified", "qualification"],
    ["unsupported_criterion", "qualification_evaluator"],
    ["qualification_case_count", "qualification"],
    ["base_unqualified", "qualification_sources"],
    ["blind_seed", "blinded_result"],
    ["blind_verdict", "blind_observations"],
    ["blind_failed", "blinded_result"],
    ["human_oppose", "human_quorum"],
    ["human_expired", "human_quorum"],
    ["human_observations", "human_review_lineage"],
    ["human_critiques", "human_review_lineage"],
    ["human_assessment", "human_review_lineage"],
    ["independence_conflict", "human_quorum"],
    ["review_future_receipt", "dependency_receipts"],
    ["critique_opposes", "independent_critique"],
    ["critique_observation", "critique_lineage"],
    ["base_risk", "base_assessment"],
    ["protocol_risk", "assurance_lineage"],
    ["missing_oracle", "non_model_lineage"],
    ["empty_observations", "non_model_lineage"],
    ["empty_critiques", "independent_critique"],
    ["empty_reviews", "human_quorum"],
    ["declared_ineligible", "declared_eligibility"],
    ["excess_validity", "validity_bound"],
    ["evaluation_after_receipt", "dependency_receipts"],
  ])("preserves a record-level-valid contradiction in %s", async (mutation, expected) => {
    const h = await harness(({ family, fixture }) => {
      if (family === "evaluation") {
        if (fixture.kind === "qualification_report" && mutation === "base_unqualified")
          fixture.record.status = "unqualified";
        return;
      }
      if (fixture.kind === "calibration_report") {
        if (mutation === "calibration_locale") fixture.record.population.locale = "ko-kr";
        if (mutation === "calibration_unavailable") {
          fixture.record.status = "unavailable";
          fixture.record.statusReasons = ["calibration unavailable"];
        }
      }
      if (fixture.kind === "model_qualification_report") {
        if (mutation === "model_unqualified") {
          fixture.record.status = "unqualified";
          fixture.record.failureReasons = ["bounded qualification failure"];
        }
        if (mutation === "qualification_case_count") {
          fixture.record.statusSummary.caseCount++;
          fixture.record.statusSummary.matchedCaseCount++;
        }
      }
      if (fixture.kind === "model_assisted_evaluator" && mutation === "unsupported_criterion") {
        const criterion = fixture.record.supportedCriteria[0];
        if (!criterion) throw new Error("Missing criterion");
        criterion.criterionId = "crt_other";
      }
      if (fixture.kind === "blinded_evaluation_result") {
        const attempt = fixture.record.attempts[0];
        if (!attempt) throw new Error("Missing blind attempt");
        if (mutation === "blind_seed") attempt.seed++;
        if (mutation === "blind_verdict")
          for (const value of fixture.record.attempts)
            if (value.status === "completed") value.verdict = "fail";
        if (mutation === "blind_failed") {
          fixture.record.attempts[0] = {
            attemptId: attempt.attemptId,
            presentationId: attempt.presentationId,
            seed: attempt.seed,
            status: "failed",
            errorCode: "provider_unavailable",
            errorEvidence: [fixture.record.orderComparison],
          };
          fixture.record.status = "invalid";
          fixture.record.disagreementReasons = ["attempt_missing"];
          fixture.record.disagreementEvidence = [fixture.record.orderComparison];
        }
      }
      if (fixture.kind === "human_review_record") {
        if (mutation === "human_oppose") fixture.record.action = "oppose";
        if (mutation === "human_expired") fixture.record.expiresAt = "2026-09-02T06:00:00.000Z";
        if (mutation === "human_observations") {
          const observation = fixture.record.observations[0];
          if (!observation) throw new Error("Missing reviewed observation");
          observation.observationId = "obs_other";
        }
        if (mutation === "human_critiques") fixture.record.critiques = [];
        if (mutation === "human_assessment") fixture.record.assessment.assessmentId = "asm_other";
        if (mutation === "review_future_receipt")
          fixture.record.recordedAt = "2026-09-02T06:00:00.001Z";
      }
      if (fixture.kind === "human_reviewer_independence" && mutation === "independence_conflict") {
        fixture.record.conflicts = ["conflicted reviewer"];
        fixture.record.status = "rejected";
        fixture.record.statusReasons = ["reviewer conflict"];
      }
      if (fixture.kind === "independent_critique") {
        if (mutation === "critique_opposes" && fixture.record.outcome.status === "produced")
          for (const finding of fixture.record.outcome.findings) finding.impact = "opposes";
        if (mutation === "critique_observation")
          fixture.record.observation.observationId = "obs_other";
      }
      if (fixture.kind === "human_review_protocol" && mutation === "protocol_risk")
        fixture.record.claim.riskTier = "high";
      if (fixture.kind === "model_assurance_assessment") {
        if (mutation === "base_risk") fixture.record.riskTier = "high";
        if (mutation === "missing_oracle") {
          const oracle = fixture.record.nonModelEvidence.oracles[0];
          if (!oracle) throw new Error("Missing oracle");
          oracle.oracleVersionId = "orv_other";
        }
        if (mutation.startsWith("empty_") || mutation === "declared_ineligible") {
          fixture.record.eligibility = "ineligible";
          fixture.record.reasons = ["unresolved_disagreement"];
        }
        if (mutation === "empty_observations") fixture.record.nonModelEvidence.observations = [];
        if (mutation === "empty_critiques") fixture.record.critiques = [];
        if (mutation === "empty_reviews") fixture.record.humanReviews = [];
        if (mutation === "excess_validity") fixture.record.validUntil = "2027-01-01T00:00:00.000Z";
        if (mutation === "evaluation_after_receipt")
          fixture.record.evaluatedAt = "2026-09-02T06:00:00.001Z";
      }
    });
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    expect(graph.modelAssurance.parents).toHaveLength(1);
    expect(
      graph.modelAssurance.parents[0]?.checks.some(
        (c) => c.kind === expected && c.observation.status === "mismatch",
      ),
    ).toBe(true);
  });

  it.each([
    "model_assurance_assessment",
    "model_qualification_report",
    "model_qualification_suite",
    "model_evaluator_profile",
    "model_assisted_evaluator",
    "independence_declaration",
    "calibration_report",
    "blinded_evaluation_plan",
    "blinded_evaluation_result",
    "human_review_protocol",
    "human_review_record",
    "human_reviewer_independence",
    "independent_critique",
  ] as const)("retains missing %s records without a fabricated success", async (missingKind) => {
    const h = await harness();
    const find = h.model.find.bind(h.model);
    vi.spyOn(h.model, "find").mockImplementation((scope, kind, id) =>
      kind === missingKind ? Promise.resolve(null) : find(scope, kind, id),
    );
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    if (missingKind === "model_assurance_assessment") {
      expect(graph.modelAssurance.parents).toEqual([]);
      expect(graph.modelAssurance.unavailableParents).toHaveLength(1);
      expect(graph.modelAssurance.unavailableParents[0]?.observation.status).toBe("missing");
    } else {
      const checks = graph.modelAssurance.parents[0]?.checks;
      expect(checks?.some((c) => c.observation.status === "unavailable")).toBe(true);
      expect(checks?.filter((c) => c.observation.status === "mismatch")).toEqual([]);
    }
  });

  it("preserves an unqualified report and an opposing review alongside missing evidence", async () => {
    const h = await harness(({ family, fixture }) => {
      if (family !== "model") return;
      if (fixture.kind === "model_qualification_report") {
        fixture.record.status = "unqualified";
        fixture.record.failureReasons = ["qualification failure"];
      }
      if (fixture.kind === "human_review_record") fixture.record.action = "oppose";
    });
    const find = h.model.find.bind(h.model);
    vi.spyOn(h.model, "find").mockImplementation((scope, kind, id) =>
      ["model_qualification_suite", "human_reviewer_independence"].includes(kind)
        ? Promise.resolve(null)
        : find(scope, kind, id),
    );
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const checks = graph.modelAssurance.parents[0]?.checks;
    for (const kind of ["qualification", "human_quorum"])
      expect(checks?.some((c) => c.kind === kind && c.observation.status === "mismatch")).toBe(
        true,
      );
    expect(checks?.some((c) => c.observation.status === "unavailable")).toBe(true);
  });

  it("keeps a known protocol risk mismatch when the base assessment is unavailable", async () => {
    const h = await harness(({ family, fixture }) => {
      if (family === "model" && fixture.kind === "human_review_protocol")
        fixture.record.claim.riskTier = "high";
    });
    vi.spyOn(h.evaluation, "findAssessment").mockResolvedValue(null);
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const checks = graph.modelAssurance.parents[0]?.checks;
    expect(checks?.find((c) => c.kind === "base_assessment")?.observation.status).toBe(
      "unavailable",
    );
    expect(checks?.find((c) => c.kind === "assurance_lineage")?.observation.status).toBe(
      "mismatch",
    );
  });

  it("admits exact cumulative inspection limits, rejects one less and keeps original provenance", async () => {
    const h = await harness();
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const usage = graph.modelAssurance.inspectionUsage;
    expect(
      inspectCapturedModelAssurance(graph, graph.evaluationSnapshots, {
        maxReferences: usage.references,
        maxReferenceBytes: usage.referenceBytes,
      }),
    ).toEqual(graph.modelAssurance);
    for (const limit of [
      { maxReferences: usage.references - 1, maxReferenceBytes: usage.referenceBytes },
      { maxReferences: usage.references, maxReferenceBytes: usage.referenceBytes - 1 },
    ])
      expect(() =>
        inspectCapturedModelAssurance(graph, graph.evaluationSnapshots, limit),
      ).toThrow();
    const before = structuredClone(graph);
    const detached = inspectCapturedModelAssurance(graph, graph.evaluationSnapshots, limits);
    const first = detached.parents[0];
    if (!first) throw new Error("Missing report");
    first.source.reference.assessmentExtensionId = "maa_mutated";
    expect(graph).toEqual(before);
  });

  it.each([false, true])(
    "respects superseded opposition with missing independence = %s",
    async (missing) => {
      const h = await harness(undefined, { reviewHistory: true });
      if (missing) {
        const find = h.model.find.bind(h.model);
        vi.spyOn(h.model, "find").mockImplementation((scope, kind, id) =>
          kind === "human_reviewer_independence" ? Promise.resolve(null) : find(scope, kind, id),
        );
      }
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      const check = graph.modelAssurance.parents[0]?.checks.find((c) => c.kind === "human_quorum");
      expect(check?.observation.status).toBe(missing ? "unavailable" : "matched");
      expect(check?.observation.reasons).not.toContain("opposing_review");
      expect(
        graph.nodes.some(
          ({ read }) =>
            read.source.kind === "human_review_record" &&
            read.source.reference.reviewId === "hrr_earlier_opposition",
        ),
      ).toBe(true);
    },
  );

  it.each([
    "findAssessment",
    "findAggregationPolicy",
    "findRawObservation",
    "findEvaluationRun",
    "findOracleSpec",
    "findQualificationReport",
  ] as const)("retains unavailable non-model prerequisites from %s", async (method) => {
    const h = await harness();
    vi.spyOn(h.evaluation, method).mockResolvedValue(null);
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const checks = graph.modelAssurance.parents[0]?.checks;
    expect(checks?.some((c) => c.observation.status === "unavailable")).toBe(true);
    expect(checks?.filter((c) => c.observation.status === "mismatch")).toEqual([]);
  });

  it.each(["human_review_record", "model_qualification_report"] as const)(
    "uses half-open validity at the stored assessment time for %s",
    async (kind) => {
      for (const [until, expected] of [
        ["2026-09-02T05:59:59.999Z", "mismatch"],
        ["2026-09-02T06:00:00.000Z", "mismatch"],
        ["2026-09-02T06:00:00.001Z", "matched"],
      ] as const) {
        const h = await harness(({ family, fixture }) => {
          if (family !== "model") return;
          if (fixture.kind === kind) {
            if (fixture.kind === "human_review_record") fixture.record.expiresAt = until;
            else fixture.record.validUntil = until;
          }
          if (fixture.kind === "model_assurance_assessment")
            fixture.record.validUntil = "2026-09-02T06:00:00.001Z";
        });
        const graph = await capturePolicyRecordGraph(h.input, h.repositories);
        const checkKind = kind === "human_review_record" ? "human_quorum" : "qualification";
        const checks = graph.modelAssurance.parents[0]?.checks.filter((c) => c.kind === checkKind);
        expect(checks?.length).toBeGreaterThan(0);
        expect(checks?.every((c) => c.observation.status === expected)).toBe(true);
      }
    },
  );

  it.each(["human_review_record", "model_assurance_assessment"] as const)(
    "keeps the reader's receipt-cut observation for %s",
    async (kind) => {
      const h = await harness(({ family, fixture }) => {
        if (family === "model" && fixture.kind === kind)
          fixture.record.recordedAt = "2026-10-02T00:00:00.000Z";
      });
      const graph = await capturePolicyRecordGraph(h.input, h.repositories);
      const unavailable = graph.nodes.filter(({ read }) => read.source.kind === kind);
      expect(unavailable.length).toBeGreaterThan(0);
      expect(unavailable.every(({ read }) => read.observation.status === "unavailable")).toBe(true);
      if (kind === "model_assurance_assessment") {
        expect(graph.modelAssurance.parents).toEqual([]);
        expect(graph.modelAssurance.unavailableParents[0]?.observation).toEqual(
          unavailable[0]?.read.observation,
        );
      } else {
        expect(
          graph.modelAssurance.parents[0]?.checks.find((c) => c.kind === "human_quorum")
            ?.observation.status,
        ).toBe("unavailable");
      }
    },
  );

  it("charges shared dependencies once per use across distinct assessment parents", async () => {
    const one = await harness();
    const single = await capturePolicyRecordGraph(one.input, one.repositories);
    const two = await harness(undefined, { copies: 2 });
    const graph = await capturePolicyRecordGraph(two.input, two.repositories);
    expect(graph.modelAssurance.parents).toHaveLength(2);
    expect(graph.modelAssurance.inspectionUsage).toEqual({
      references: single.modelAssurance.inspectionUsage.references * 2,
      referenceBytes: single.modelAssurance.inspectionUsage.referenceBytes * 2,
    });
    const first = graph.modelAssurance.parents[0];
    const second = graph.modelAssurance.parents[1];
    if (!first || !second) throw new Error("Missing assessments");
    expect(first.dependencyEdgeIndexes.some((i) => second.dependencyEdgeIndexes.includes(i))).toBe(
      true,
    );
    expect(() =>
      inspectCapturedModelAssurance(graph, graph.evaluationSnapshots, {
        maxReferences: single.modelAssurance.inspectionUsage.references,
        maxReferenceBytes: limits.maxReferenceBytes,
      }),
    ).toThrow();
    expect(
      inspectCapturedModelAssurance(
        { nodes: [...graph.nodes].reverse(), edges: graph.edges },
        graph.evaluationSnapshots,
        limits,
      ),
    ).toEqual(graph.modelAssurance);
  });

  it.each([
    "duplicate_edge",
    "missing_edge",
    "wrong_parent_hash",
    "missing_target",
    "wrong_kind",
    "missing_child",
    "missing_receipt",
  ])("aborts broken internal graph provenance: %s", async (mutation) => {
    const h = await harness();
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    const nodes = structuredClone([...graph.nodes]);
    const edges = structuredClone([...graph.edges]);
    const index = edges.findIndex(
      (edge) =>
        edge.parent.kind === "model_assurance_assessment" &&
        edge.reference.path === "/baseAssessment",
    );
    const edge = edges[index];
    if (!edge?.target) throw new Error("Missing base edge");
    const targetKey = policyEvaluationSourceReferenceKey(edge.target);
    const root = graph.roots[0];
    if (!root) throw new Error("Missing root");
    const childIndex = nodes.findIndex(
      ({ read }) => policyEvaluationSourceReferenceKey(read.source) === targetKey,
    );
    if (mutation === "duplicate_edge") edges.push(structuredClone(edge));
    if (mutation === "missing_edge") edges.splice(index, 1);
    if (mutation === "wrong_parent_hash")
      edges[index] = { ...edge, parentRecordSha256: "f".repeat(64) };
    if (mutation === "missing_target") edges[index] = { ...edge, target: null };
    if (mutation === "wrong_kind") edges[index] = { ...edge, target: root };
    if (mutation === "missing_child") nodes.splice(childIndex, 1);
    if (mutation === "missing_receipt") {
      const child = nodes[childIndex];
      if (child?.read.observation.status !== "verified") throw new Error("Missing verified child");
      delete (child.read.record as unknown as Fields)["createdAt"];
    }
    expect(() =>
      inspectCapturedModelAssurance({ nodes, edges }, graph.evaluationSnapshots, limits),
    ).toThrow("reference_conflict");
  });

  it("propagates storage failures without manufacturing unavailable records", async () => {
    const h = await harness();
    const failure = new Error("qualification storage unavailable");
    const find = h.model.find.bind(h.model);
    vi.spyOn(h.model, "find").mockImplementation((scope, kind, id) => {
      if (kind === "model_qualification_report") throw failure;
      return find(scope, kind, id);
    });
    await expect(capturePolicyRecordGraph(h.input, h.repositories)).rejects.toBe(failure);
  });

  it("checks the real published graph at the recorded assessment time, not worker or capture time", async () => {
    const h = await harness();
    const publish = vi.spyOn(h.model, "publish");
    const graph = await capturePolicyRecordGraph(h.input, h.repositories);
    expect(publish).not.toHaveBeenCalled();
    const report = graph.modelAssurance;
    expect(report.parents).toHaveLength(1);
    expect(report.unavailableParents).toEqual([]);
    expect(report.parents[0]?.checks.filter((c) => c.observation.status !== "matched")).toEqual([]);
    expect(report.inspectionUsage.references).toBeGreaterThan(30);
    expect(report).not.toHaveProperty("eligible");
    expect(report).not.toHaveProperty("sealed");
    expect(
      inspectCapturedModelAssurance(
        { nodes: [...graph.nodes].reverse(), edges: graph.edges },
        graph.evaluationSnapshots,
        limits,
      ),
    ).toEqual(report);
    for (const parent of report.parents) {
      expect(graph.entries).toContainEqual({
        source: parent.source,
        observation: { status: "verified", recordSha256: parent.recordSha256 },
      });
      expect(
        parent.dependencyEdgeIndexes.some(
          (i) => graph.edges[i]?.parent.kind === "model_qualification_report",
        ),
      ).toBe(true);
      expect(
        parent.dependencyEdgeIndexes.some(
          (i) => graph.edges[i]?.parent.kind === "human_review_record",
        ),
      ).toBe(true);
    }
  });
});
