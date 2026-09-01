import { describe, expect, it } from "vitest";
import {
  ASSESSMENT_SCHEMA_VERSION,
  type Assessment,
  AssessmentDefinitionSchema,
  AssessmentSchema,
  AssessmentSnapshotSchema,
  EVALUATION_AGGREGATE_SCHEMA_VERSION,
  EVALUATION_AGGREGATION_POLICY_SCHEMA_VERSION,
  type EvaluationAggregate,
  EvaluationAggregateDefinitionSchema,
  EvaluationAggregateCountsSchema,
  EvaluationAggregateSnapshotSchema,
  type EvaluationAggregationPolicy,
  EvaluationAggregationPolicyDefinitionSchema,
  EvaluationAggregationPolicySchema,
  ExactCountRatioSchema,
  WILSON_INTERVAL_METHOD_VERSION,
  WilsonIntervalSchema,
} from "./evaluation-assessment.js";
import {
  EVALUATION_RUN_RESULT_SCHEMA_VERSION,
  EVALUATION_RUN_SCHEMA_VERSION,
  type EvaluationRun,
  type EvaluationRunResult,
} from "./evaluation-run.js";

const sha = (character: string) => character.repeat(64);
const clone = <Value>(value: Value): Value => structuredClone(value);

function requireAt<Value>(values: readonly Value[], index: number, label: string): Value {
  const value = values[index];
  if (!value) throw new Error(`Expected ${label} at index ${index}`);
  return value;
}

const scope = {
  environmentId: "env_local",
  projectId: "prj_local",
  tenantId: "ten_local",
} as const;

const artifact = (artifactId: string, character: string) => ({
  artifactId,
  classification: "internal" as const,
  mediaType: "application/json",
  sha256: sha(character),
  sizeBytes: 1_024,
});

const criterion = {
  criterionId: "crt_schema",
  criterionSet: {
    criterionSetId: "crs_response",
    criterionSetVersionId: "csv_response_v1",
    definitionSha256: sha("1"),
  },
} as const;

const policyReference = {
  definitionSha256: sha("2"),
  policyId: "agp_schema",
  policyVersionId: "agv_schema_v1",
} as const;

const datasetReference = {
  datasetId: "dts_regression",
  datasetVersionId: "dtv_regression_v1",
  definitionSha256: sha("3"),
} as const;

const implementation = {
  dependencySnapshotSha256: sha("4"),
  entryPointId: "ent_applicability_v1",
  implementationId: "imp_applicability",
  implementationSha256: sha("5"),
  implementationVersionId: "imv_applicability_v1",
  runtime: {
    architecture: "arm64" as const,
    family: "node" as const,
    platform: "darwin" as const,
    version: "24.0.0",
  },
  sourceRevision: "a".repeat(40),
};

const verdicts = ["pass", "fail", "abstain", "not_applicable", "error"] as const;

function policy(
  method: "descriptive_counts" | "wilson_score_interval" = "wilson_score_interval",
): EvaluationAggregationPolicy {
  return {
    changeRationale: "Initial fixed aggregation policy for the bounded regression dataset.",
    dataset: clone(datasetReference),
    definitionSha256: policyReference.definitionSha256,
    knownLimitations: ["The selected dataset is not evidence of the production population"],
    maximumAbstentionRateBasisPoints: 2_500,
    maximumErrorRateBasisPoints: 2_500,
    method:
      method === "descriptive_counts"
        ? { method }
        : {
            confidenceLevelBasisPoints: 9_500,
            method,
            methodVersion: WILSON_INTERVAL_METHOD_VERSION,
          },
    minimumApplicableCount: 4,
    minimumCoverageBasisPoints: 5_000,
    minimumDecidedCount: 2,
    policyId: policyReference.policyId,
    policyVersionId: policyReference.policyVersionId,
    publishedAt: "2026-09-01T00:00:00.000Z",
    publishedByPrincipalId: "usr_publisher",
    schemaVersion: EVALUATION_AGGREGATION_POLICY_SCHEMA_VERSION,
    scope: clone(scope),
    selectionSha256: sha("6"),
  };
}

function run(index: number, verdict: (typeof verdicts)[number]): EvaluationRun {
  const suffix = String(index);
  const notApplicable = verdict === "not_applicable";
  return {
    aggregationPolicy: clone(policyReference),
    applicability: {
      context: {
        environmentId: "env_local",
        locale: "en",
        populationTags: [],
        riskTier: "moderate",
        taskKind: "tsk_support",
      },
      contextSha256: sha("7"),
      evaluatedAt: "2026-09-01T00:00:00Z",
      interpreter: clone(implementation),
      result: notApplicable ? "not_applicable" : "applicable",
      runtimePolicy: {
        clock: { mode: "not_available" },
        dataEgress: "denied",
        locale: "en",
        network: "denied",
        seed: { mode: "not_used" },
        sideEffects: "denied",
      },
    },
    attempts: notApplicable
      ? []
      : [
          {
            attemptId: `att_${suffix}`,
            attemptSequence: 0,
            budgets: {
              elapsedMilliseconds: 5_000,
              inputBytes: 1_048_576,
              memoryBytes: 268_435_456,
              outputBytes: 1_048_576,
            },
            seed: { mode: "fixed", value: index },
          },
        ],
    createdAt: "2026-09-01T00:00:01.000Z",
    createdByPrincipalId: "usr_operator",
    criterion: clone(criterion),
    criterionStatus: { definitionSha256: sha("8"), statusRecordId: "csr_approved" },
    dataset: clone(datasetReference),
    definitionSha256: sha(suffix),
    environmentEvidence: [artifact(`art_environment_${suffix}`, "9")],
    evaluationRunId: `evr_${suffix}`,
    evaluator: {
      definitionSha256: sha("a"),
      evaluatorId: "evl_schema",
      evaluatorVersionId: "evv_schema_v1",
    },
    evaluatorQualification: {
      definitionSha256: sha("b"),
      qualificationReportId: "qlr_evaluator",
    },
    fixture: {
      definitionSha256: sha("c"),
      fixtureId: `fix_${suffix}`,
      fixtureVersionId: `fxv_${suffix}`,
    },
    inputEvidence: [artifact(`art_input_${suffix}`, "d")],
    oracle: {
      definitionSha256: sha("e"),
      oracleId: "orc_schema",
      oracleVersionId: "orv_schema_v1",
    },
    oracleQualification: {
      definitionSha256: sha("f"),
      qualificationReportId: "qlr_oracle",
    },
    replay: {
      attemptId: `rat_${suffix}`,
      completedAt: "2026-09-01T00:00:00Z",
      jobId: `rjb_${suffix}`,
      plan: {
        definitionSha256: sha("1"),
        planId: "rpl_schema",
        planVersionId: "rpv_schema_v1",
      },
      result: artifact(`art_replay_${suffix}`, "2"),
      targetRelease: {
        definitionSha256: sha("3"),
        targetAdapter: {
          name: "proofstack.node",
          protocolVersion: "2.0.0",
          version: "1.0.0",
        },
        targetId: "tgt_agent",
        targetReleaseId: "trl_agent_v1",
        workerProtocol: { name: "proofstack.worker", version: "2.0.0" },
      },
      terminalCode: "completed",
      terminalStatus: "succeeded",
    },
    retryableErrors: [],
    schemaVersion: EVALUATION_RUN_SCHEMA_VERSION,
    scope: clone(scope),
    sourceReviews: [
      { definitionSha256: sha("4"), sourceReviewId: "srv_primary" },
      { definitionSha256: sha("5"), sourceReviewId: "srv_secondary" },
    ],
  };
}

function result(index: number, verdict: (typeof verdicts)[number]): EvaluationRunResult {
  const suffix = String(index);
  return {
    completedAt: "2026-09-01T00:00:05Z",
    definitionSha256: sha((index + 5).toString(16)),
    evaluationRunId: `evr_${suffix}`,
    observations:
      verdict === "not_applicable"
        ? []
        : [
            {
              definitionSha256: sha((index + 6).toString(16)),
              observationId: `obs_${suffix}`,
            },
          ],
    recordedAt: "2026-09-01T00:00:05.000Z",
    recordedByPrincipalId: "svc_evaluator",
    resultId: `evs_${suffix}`,
    schemaVersion: EVALUATION_RUN_RESULT_SCHEMA_VERSION,
    scope: clone(scope),
    terminalReason:
      verdict === "not_applicable"
        ? "not_applicable"
        : verdict === "error"
          ? "non_retryable_error"
          : "completed",
    verdict,
  };
}

function aggregate(): EvaluationAggregate {
  const members = verdicts.map((verdict, index) => ({
    independenceGroupId: "ind_schema",
    result: {
      definitionSha256: result(index, verdict).definitionSha256,
      evaluationRunId: `evr_${index}`,
      resultId: `evs_${index}`,
    },
    run: {
      definitionSha256: run(index, verdict).definitionSha256,
      evaluationRunId: `evr_${index}`,
    },
    verdict,
  }));
  return {
    abstentionRate: { denominator: 4, numerator: 1, status: "available" },
    aggregateId: "eva_schema",
    aggregationPolicy: clone(policyReference),
    counts: {
      abstainCount: 1,
      applicableCount: 4,
      attemptedCount: 5,
      decidedCount: 2,
      errorCount: 1,
      failCount: 1,
      notApplicableCount: 1,
      passCount: 1,
      selectedCount: 5,
    },
    coverage: { denominator: 4, numerator: 2, status: "available" },
    createdAt: "2026-09-01T00:01:00.000Z",
    createdByPrincipalId: "svc_aggregator",
    criterion: clone(criterion),
    definitionSha256: sha("a"),
    errorRate: { denominator: 4, numerator: 1, status: "available" },
    knownLimitations: ["The five exact fixtures do not prove production representativeness"],
    members,
    passInterval: {
      interval: {
        confidenceLevelBasisPoints: 9_500,
        lowerBound: "0.0945286548008661",
        method: "wilson_score_interval",
        methodVersion: WILSON_INTERVAL_METHOD_VERSION,
        successCount: 1,
        trialCount: 2,
        upperBound: "0.9054713451991339",
      },
      status: "reported",
    },
    passProportion: { denominator: 2, numerator: 1, status: "available" },
    samplingAssumption: {
      evidence: [artifact("art_sampling_assumption", "b")],
      status: "supported",
    },
    schemaVersion: EVALUATION_AGGREGATE_SCHEMA_VERSION,
    scope: clone(scope),
  };
}

function aggregateSnapshot() {
  return {
    aggregate: aggregate(),
    policy: policy(),
    results: verdicts.map((verdict, index) => result(index, verdict)),
    runs: verdicts.map((verdict, index) => run(index, verdict)),
  };
}

function allNotApplicableAggregateSnapshot() {
  const snapshot = aggregateSnapshot();
  snapshot.aggregate.members = snapshot.aggregate.members.map((member) => ({
    ...member,
    verdict: "not_applicable",
  }));
  snapshot.results = snapshot.results.map((entry) => ({
    ...entry,
    observations: [],
    terminalReason: "not_applicable",
    verdict: "not_applicable",
  }));
  snapshot.runs = snapshot.runs.map((entry) => ({
    ...entry,
    applicability: { ...entry.applicability, result: "not_applicable" },
    attempts: [],
  }));
  snapshot.aggregate.counts = {
    abstainCount: 0,
    applicableCount: 0,
    attemptedCount: 5,
    decidedCount: 0,
    errorCount: 0,
    failCount: 0,
    notApplicableCount: 5,
    passCount: 0,
    selectedCount: 5,
  };
  snapshot.aggregate.coverage = { reason: "zero_denominator", status: "unavailable" };
  snapshot.aggregate.abstentionRate = { reason: "zero_denominator", status: "unavailable" };
  snapshot.aggregate.errorRate = { reason: "zero_denominator", status: "unavailable" };
  snapshot.aggregate.passProportion = { reason: "zero_denominator", status: "unavailable" };
  snapshot.aggregate.passInterval = {
    reason: "no_decided_cases",
    status: "not_reported",
  };
  return snapshot;
}

function assessment(): Assessment {
  const snapshot = aggregateSnapshot();
  return {
    aggregate: {
      aggregateId: snapshot.aggregate.aggregateId,
      definitionSha256: snapshot.aggregate.definitionSha256,
    },
    aggregationPolicy: clone(policyReference),
    assessmentId: "asm_schema",
    assumptions: ["The selected fixtures are treated as the complete bounded evaluation set"],
    conflicts: [],
    counterevidence: [],
    createdAt: "2026-09-01T00:02:00.000Z",
    createdByPrincipalId: "svc_assessor",
    criterion: clone(criterion),
    criterionLifecycleStatus: "approved",
    criterionStatus: { definitionSha256: sha("8"), statusRecordId: "csr_approved" },
    definitionSha256: sha("c"),
    dimensions: {
      applicability: "applicable",
      coverage: "sufficient",
      independence: "sufficient",
      integrity: "verified",
      qualification: "current",
      sourceFreshness: "current",
      sourceIdentity: "verified",
      statisticalAssumptions: "supported",
    },
    disagreement: { status: "none" },
    eligibility: { status: "eligible" },
    exclusions: [],
    independenceGroups: [
      {
        groupId: "ind_schema",
        implementationAuthors: ["ProofStack maintainers"],
        labelSourceIds: ["lbl_schema"],
        organization: "ProofStack",
      },
    ],
    knownLimitations: ["Eligibility is evidence usability, not release approval"],
    minorityFindings: [],
    observations: snapshot.results.flatMap(({ observations }) => observations),
    observedEvidenceClasses: [
      "artifact",
      "deterministic_oracle",
      "replay_result",
      "source_snapshot",
      "statistical_aggregate",
    ],
    qualifications: [
      { definitionSha256: sha("b"), qualificationReportId: "qlr_evaluator" },
      { definitionSha256: sha("f"), qualificationReportId: "qlr_oracle" },
    ],
    requiredEvidenceClasses: [
      "deterministic_oracle",
      "replay_result",
      "source_snapshot",
      "statistical_aggregate",
    ],
    requiredIndependentGroups: 1,
    riskTier: "moderate",
    runs: snapshot.runs.map(({ definitionSha256, evaluationRunId }) => ({
      definitionSha256,
      evaluationRunId,
    })),
    schemaVersion: ASSESSMENT_SCHEMA_VERSION,
    scope: clone(scope),
    sourceReviews: [
      { definitionSha256: sha("4"), sourceReviewId: "srv_primary" },
      { definitionSha256: sha("5"), sourceReviewId: "srv_secondary" },
    ],
    supportRationale:
      "The bounded aggregate supports the criterion while preserving its explicit limitations.",
    supportStatus: "supported",
  };
}

describe("aggregation policy and count contracts", () => {
  it("publishes a bounded exact policy without release authority", () => {
    const record = policy();
    expect(EvaluationAggregationPolicySchema.parse(record)).toEqual(record);
    const {
      definitionSha256: _digest,
      publishedAt: _publishedAt,
      publishedByPrincipalId: _publishedBy,
      schemaVersion: _version,
      scope: _scope,
      ...definition
    } = record;
    expect(EvaluationAggregationPolicyDefinitionSchema.parse(definition)).toEqual(definition);
    expect(
      EvaluationAggregationPolicySchema.safeParse({ ...record, releaseDecision: "approved" })
        .success,
    ).toBe(false);
  });

  it("requires all five verdict counts and explicit applicable and decided denominators", () => {
    const counts = aggregate().counts;
    expect(EvaluationAggregateCountsSchema.parse(counts)).toEqual(counts);

    for (const mutation of [
      { selectedCount: 4 },
      { attemptedCount: 4 },
      { applicableCount: 3 },
      { decidedCount: 3 },
    ]) {
      expect(EvaluationAggregateCountsSchema.safeParse({ ...counts, ...mutation }).success).toBe(
        false,
      );
    }
  });

  it("keeps zero-denominator ratios unavailable and rejects impossible fractions", () => {
    expect(
      ExactCountRatioSchema.safeParse({ reason: "zero_denominator", status: "unavailable" })
        .success,
    ).toBe(true);
    expect(
      ExactCountRatioSchema.safeParse({ denominator: 2, numerator: 3, status: "available" })
        .success,
    ).toBe(false);
    expect(
      ExactCountRatioSchema.safeParse({ denominator: 0, numerator: 0, status: "available" })
        .success,
    ).toBe(false);
  });

  it("bounds and orders Wilson intervals with exact decimal strings", () => {
    const interval = requireAt([aggregate().passInterval], 0, "pass interval");
    if (interval.status !== "reported") throw new Error("Expected a reported interval");
    expect(WilsonIntervalSchema.safeParse(interval.interval).success).toBe(true);
    expect(WilsonIntervalSchema.safeParse({ ...interval.interval, successCount: 3 }).success).toBe(
      false,
    );
    expect(
      WilsonIntervalSchema.safeParse({
        ...interval.interval,
        lowerBound: "0.9",
        upperBound: "0.1",
      }).success,
    ).toBe(false);
    expect(
      WilsonIntervalSchema.safeParse({ ...interval.interval, upperBound: "1.0001" }).success,
    ).toBe(false);
    expect(
      WilsonIntervalSchema.safeParse({
        ...interval.interval,
        lowerBound: "0.5",
        upperBound: "0.5",
      }).success,
    ).toBe(true);
  });
});

describe("aggregate evidence contracts", () => {
  it("separates immutable aggregate meaning from publication metadata", () => {
    const record = aggregate();
    const definition = clone(record) as unknown as Record<string, unknown>;
    for (const key of [
      "createdAt",
      "createdByPrincipalId",
      "definitionSha256",
      "schemaVersion",
      "scope",
    ]) {
      delete definition[key];
    }

    expect(EvaluationAggregateDefinitionSchema.parse(definition)).toEqual(definition);
    expect(EvaluationAggregateDefinitionSchema.safeParse(record).success).toBe(false);
  });

  it("reconstructs counts, denominators, policy, runs, results, and Wilson evidence", () => {
    const snapshot = aggregateSnapshot();
    expect(EvaluationAggregateSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("rejects forged counts, ratios, duplicate members, and duplicate fixtures", () => {
    const forgedCounts = aggregate();
    forgedCounts.counts.passCount = 2;
    expect(
      EvaluationAggregateSnapshotSchema.safeParse({
        ...aggregateSnapshot(),
        aggregate: forgedCounts,
      }).success,
    ).toBe(false);

    const forgedRatio = aggregate();
    forgedRatio.coverage = { denominator: 4, numerator: 3, status: "available" };
    expect(
      EvaluationAggregateSnapshotSchema.safeParse({
        ...aggregateSnapshot(),
        aggregate: forgedRatio,
      }).success,
    ).toBe(false);

    const duplicateMember = aggregate();
    duplicateMember.members[1] = clone(requireAt(duplicateMember.members, 0, "aggregate member"));
    expect(
      EvaluationAggregateSnapshotSchema.safeParse({
        ...aggregateSnapshot(),
        aggregate: duplicateMember,
      }).success,
    ).toBe(false);

    const duplicateFixture = aggregateSnapshot();
    requireAt(duplicateFixture.runs, 1, "evaluation run").fixture.fixtureVersionId = requireAt(
      duplicateFixture.runs,
      0,
      "evaluation run",
    ).fixture.fixtureVersionId;
    expect(EvaluationAggregateSnapshotSchema.safeParse(duplicateFixture).success).toBe(false);
  });

  it("rejects crossed policy, dataset, criterion, scope, result, and applicability lineage", () => {
    const mutations: Array<(value: ReturnType<typeof aggregateSnapshot>) => void> = [
      (value) => {
        value.aggregate.aggregationPolicy.definitionSha256 = sha("f");
      },
      (value) => {
        requireAt(value.runs, 0, "evaluation run").dataset.datasetVersionId = "dtv_other";
      },
      (value) => {
        requireAt(value.runs, 0, "evaluation run").criterion.criterionId = "crt_other";
      },
      (value) => {
        requireAt(value.results, 0, "evaluation result").scope.projectId = "prj_other";
      },
      (value) => {
        requireAt(value.results, 0, "evaluation result").resultId = "evs_other";
      },
      (value) => {
        requireAt(value.results, 3, "evaluation result").verdict = "pass";
      },
    ];
    for (const mutate of mutations) {
      const value = aggregateSnapshot();
      mutate(value);
      expect(EvaluationAggregateSnapshotSchema.safeParse(value).success).toBe(false);
    }
  });

  it("requires complete member records and aggregate time after policy and results", () => {
    const missing = aggregateSnapshot();
    missing.results.pop();
    expect(EvaluationAggregateSnapshotSchema.safeParse(missing).success).toBe(false);

    const missingRun = aggregateSnapshot();
    missingRun.runs.pop();
    expect(EvaluationAggregateSnapshotSchema.safeParse(missingRun).success).toBe(false);

    const early = aggregateSnapshot();
    early.aggregate.createdAt = "2026-08-31T23:59:59.000Z";
    expect(EvaluationAggregateSnapshotSchema.safeParse(early).success).toBe(false);
  });

  it("does not report Wilson bounds without decisions or supported independence", () => {
    const unsupported = aggregateSnapshot();
    unsupported.aggregate.samplingAssumption = {
      limitations: ["Fixture labels share a material author lineage"],
      status: "unsupported",
    };
    unsupported.aggregate.passInterval = {
      reason: "unsupported_assumption",
      status: "not_reported",
    };
    expect(EvaluationAggregateSnapshotSchema.safeParse(unsupported).success).toBe(true);

    unsupported.aggregate.passInterval = aggregate().passInterval;
    expect(EvaluationAggregateSnapshotSchema.safeParse(unsupported).success).toBe(false);

    const noDecisions = aggregateSnapshot();
    noDecisions.aggregate.members = noDecisions.aggregate.members.map((member, index) => ({
      ...member,
      verdict: index === 3 ? "not_applicable" : "abstain",
    }));
    noDecisions.results = noDecisions.results.map((entry, index) => ({
      ...entry,
      observations: index === 3 ? [] : entry.observations,
      terminalReason: index === 3 ? "not_applicable" : "completed",
      verdict: index === 3 ? "not_applicable" : "abstain",
    }));
    noDecisions.runs = noDecisions.runs.map((entry, index) => ({
      ...entry,
      applicability: {
        ...entry.applicability,
        result: index === 3 ? "not_applicable" : "applicable",
      },
      attempts: index === 3 ? [] : entry.attempts,
    }));
    noDecisions.aggregate.counts = {
      abstainCount: 4,
      applicableCount: 4,
      attemptedCount: 5,
      decidedCount: 0,
      errorCount: 0,
      failCount: 0,
      notApplicableCount: 1,
      passCount: 0,
      selectedCount: 5,
    };
    noDecisions.aggregate.coverage = { denominator: 4, numerator: 0, status: "available" };
    noDecisions.aggregate.abstentionRate = { denominator: 4, numerator: 4, status: "available" };
    noDecisions.aggregate.errorRate = { denominator: 4, numerator: 0, status: "available" };
    noDecisions.aggregate.passProportion = {
      reason: "zero_denominator",
      status: "unavailable",
    };
    noDecisions.aggregate.passInterval = {
      reason: "no_decided_cases",
      status: "not_reported",
    };
    expect(EvaluationAggregateSnapshotSchema.safeParse(noDecisions).success).toBe(true);

    noDecisions.aggregate.passInterval = aggregate().passInterval;
    expect(EvaluationAggregateSnapshotSchema.safeParse(noDecisions).success).toBe(false);
  });

  it("keeps descriptive aggregation separate from statistical assumptions", () => {
    const snapshot = aggregateSnapshot();
    snapshot.policy = policy("descriptive_counts");
    snapshot.aggregate.samplingAssumption = { status: "not_required" };
    snapshot.aggregate.passInterval = {
      reason: "method_not_requested",
      status: "not_reported",
    };
    expect(EvaluationAggregateSnapshotSchema.safeParse(snapshot).success).toBe(true);

    snapshot.aggregate.passInterval = aggregate().passInterval;
    expect(EvaluationAggregateSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });
});

describe("assessment contracts", () => {
  it("separates immutable assessment meaning from publication metadata", () => {
    const record = assessment();
    const definition = clone(record) as unknown as Record<string, unknown>;
    for (const key of [
      "createdAt",
      "createdByPrincipalId",
      "definitionSha256",
      "schemaVersion",
      "scope",
    ]) {
      delete definition[key];
    }

    expect(AssessmentDefinitionSchema.parse(definition)).toEqual(definition);
    expect(AssessmentDefinitionSchema.safeParse(record).success).toBe(false);
  });

  it("keeps support, evidence eligibility, and release authority separate", () => {
    const value = assessment();
    expect(AssessmentSchema.parse(value)).toEqual(value);
    expect(AssessmentSchema.safeParse({ ...value, releaseDecision: "approved" }).success).toBe(
      false,
    );
    expect(AssessmentSchema.safeParse({ ...value, trustScore: 100 }).success).toBe(false);
  });

  it("makes high-impact evidence ineligible until independent human review exists", () => {
    const value = assessment();
    value.riskTier = "high";
    value.eligibility = {
      reasons: ["human_review_required"],
      status: "ineligible",
    };
    expect(AssessmentSchema.safeParse(value).success).toBe(true);
    value.eligibility = { status: "eligible" };
    expect(AssessmentSchema.safeParse(value).success).toBe(false);
  });

  it("reconstructs exact machine-readable reasons from every failed dimension", () => {
    const value = assessment();
    value.criterionLifecycleStatus = "contested";
    value.dimensions = {
      applicability: "undetermined",
      coverage: "insufficient",
      independence: "insufficient",
      integrity: "invalid",
      qualification: "not_current",
      sourceFreshness: "unknown",
      sourceIdentity: "disputed",
      statisticalAssumptions: "unsupported",
    };
    value.independenceGroups = [];
    value.observedEvidenceClasses = ["artifact"];
    value.supportStatus = "invalid";
    value.eligibility = {
      reasons: [
        "criterion_not_applicable",
        "criterion_not_approved",
        "digest_mismatch",
        "insufficient_coverage",
        "insufficient_evidence_classes",
        "insufficient_independent_quorum",
        "invalid_provenance",
        "missing_non_model_evidence",
        "qualification_not_current",
        "source_identity_not_verified",
        "source_review_not_current",
        "unsupported_statistical_assumptions",
      ],
      status: "ineligible",
    };
    expect(AssessmentSchema.safeParse(value).success).toBe(true);

    value.eligibility.reasons.pop();
    expect(AssessmentSchema.safeParse(value).success).toBe(false);
  });

  it("preserves unresolved critical counterevidence and disagreement as ineligibility", () => {
    const value = assessment();
    const runEvidence = {
      kind: "replay_result" as const,
      replay: run(0, "pass").replay,
    };
    const artifactEvidence = {
      artifact: artifact("art_counter", "d"),
      kind: "artifact" as const,
    };
    const sourceEvidence = {
      kind: "source_snapshot" as const,
      source: { definitionSha256: sha("e"), sourceSnapshotId: "src_counter" },
    };
    value.conflicts = [
      {
        conflictId: "cnf_primary",
        evidence: [artifactEvidence, runEvidence, sourceEvidence],
        severity: "critical",
        status: "unresolved",
        summary: "The executable observation conflicts with an applicable primary source.",
      },
    ];
    value.disagreement = {
      evidence: [sourceEvidence],
      rationale: "Independent evidence paths remain materially inconsistent.",
      status: "unresolved",
    };
    value.counterevidence = [artifactEvidence, sourceEvidence];
    value.eligibility = {
      reasons: ["critical_counterevidence", "unresolved_disagreement"],
      status: "ineligible",
    };
    expect(AssessmentSchema.safeParse(value).success).toBe(true);

    value.conflicts[0] = {
      ...requireAt(value.conflicts, 0, "assessment conflict"),
      evidence: [sourceEvidence, runEvidence],
    };
    expect(AssessmentSchema.safeParse(value).success).toBe(false);
  });

  it("rejects unordered, duplicate, or forged run and observation lineage", () => {
    const value = assessment();
    value.runs.reverse();
    expect(AssessmentSchema.safeParse(value).success).toBe(false);

    const duplicate = assessment();
    duplicate.observations.push(requireAt(duplicate.observations, 0, "observation reference"));
    expect(AssessmentSchema.safeParse(duplicate).success).toBe(false);
  });
});

describe("assessment snapshot contracts", () => {
  it("binds every exact aggregate member and raw observation with policy-derived coverage", () => {
    const snapshot = {
      aggregateSnapshot: aggregateSnapshot(),
      assessment: assessment(),
    };
    expect(AssessmentSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("rejects crossed aggregate, policy, criterion, scope, run, and observation references", () => {
    const mutations: Array<
      (value: {
        aggregateSnapshot: ReturnType<typeof aggregateSnapshot>;
        assessment: Assessment;
      }) => void
    > = [
      (value) => {
        value.assessment.aggregate.definitionSha256 = sha("f");
      },
      (value) => {
        value.assessment.aggregationPolicy.policyVersionId = "agv_other";
      },
      (value) => {
        value.assessment.criterion.criterionId = "crt_other";
      },
      (value) => {
        value.assessment.scope.environmentId = "env_other";
      },
      (value) => {
        requireAt(value.assessment.runs, 0, "run reference").definitionSha256 = sha("f");
      },
      (value) => {
        requireAt(value.assessment.observations, 0, "observation reference").observationId =
          "obs_other";
      },
      (value) => {
        requireAt(value.assessment.qualifications, 0, "qualification reference").definitionSha256 =
          sha("f");
      },
      (value) => {
        requireAt(value.assessment.sourceReviews, 0, "source review reference").sourceReviewId =
          "srv_other";
      },
      (value) => {
        requireAt(value.assessment.independenceGroups, 0, "independence group").groupId =
          "ind_other";
      },
      (value) => {
        value.assessment.criterionStatus.statusRecordId = "csr_other";
      },
      (value) => {
        value.assessment.riskTier = "low";
      },
      (value) => {
        value.assessment.observedEvidenceClasses = [
          "deterministic_oracle",
          "replay_result",
          "source_snapshot",
          "statistical_aggregate",
        ];
      },
    ];
    for (const mutate of mutations) {
      const value = { aggregateSnapshot: aggregateSnapshot(), assessment: assessment() };
      mutate(value);
      expect(AssessmentSnapshotSchema.safeParse(value).success).toBe(false);
    }
  });

  it("derives insufficient and unavailable coverage without inventing a usable score", () => {
    const insufficient = { aggregateSnapshot: aggregateSnapshot(), assessment: assessment() };
    insufficient.aggregateSnapshot.policy.minimumCoverageBasisPoints = 7_500;
    insufficient.assessment.dimensions.coverage = "insufficient";
    insufficient.assessment.eligibility = {
      reasons: ["insufficient_coverage"],
      status: "ineligible",
    };
    expect(AssessmentSnapshotSchema.safeParse(insufficient).success).toBe(true);

    insufficient.assessment.dimensions.coverage = "sufficient";
    expect(AssessmentSnapshotSchema.safeParse(insufficient).success).toBe(false);

    const unavailable = {
      aggregateSnapshot: allNotApplicableAggregateSnapshot(),
      assessment: assessment(),
    };
    unavailable.assessment.observations = [];
    unavailable.assessment.dimensions.applicability = "not_applicable";
    unavailable.assessment.dimensions.coverage = "unavailable";
    unavailable.assessment.eligibility = {
      reasons: ["criterion_not_applicable", "insufficient_coverage"],
      status: "ineligible",
    };
    unavailable.assessment.supportRationale =
      "No selected fixture was applicable, so the bounded criterion remains inconclusive.";
    unavailable.assessment.supportStatus = "inconclusive";
    expect(AssessmentSnapshotSchema.safeParse(unavailable).success).toBe(true);
  });

  it("derives independence from exact aggregate groups and the declared quorum", () => {
    const insufficient = { aggregateSnapshot: aggregateSnapshot(), assessment: assessment() };
    insufficient.assessment.requiredIndependentGroups = 2;
    insufficient.assessment.dimensions.independence = "insufficient";
    insufficient.assessment.eligibility = {
      reasons: ["insufficient_independent_quorum"],
      status: "ineligible",
    };
    expect(AssessmentSnapshotSchema.safeParse(insufficient).success).toBe(true);

    insufficient.assessment.dimensions.independence = "sufficient";
    expect(AssessmentSnapshotSchema.safeParse(insufficient).success).toBe(false);
  });

  it("derives descriptive statistical assumptions without fabricating an interval", () => {
    const descriptive = { aggregateSnapshot: aggregateSnapshot(), assessment: assessment() };
    descriptive.aggregateSnapshot.policy = policy("descriptive_counts");
    descriptive.aggregateSnapshot.aggregate.samplingAssumption = { status: "not_required" };
    descriptive.aggregateSnapshot.aggregate.passInterval = {
      reason: "method_not_requested",
      status: "not_reported",
    };
    descriptive.assessment.dimensions.statisticalAssumptions = "not_required";
    expect(AssessmentSnapshotSchema.safeParse(descriptive).success).toBe(true);

    descriptive.assessment.dimensions.statisticalAssumptions = "supported";
    expect(AssessmentSnapshotSchema.safeParse(descriptive).success).toBe(false);
  });

  it("preserves unsupported statistical assumptions and monotonic assessment time", () => {
    const unsupported = { aggregateSnapshot: aggregateSnapshot(), assessment: assessment() };
    unsupported.aggregateSnapshot.aggregate.samplingAssumption = {
      limitations: ["Independence has not been established"],
      status: "unsupported",
    };
    unsupported.aggregateSnapshot.aggregate.passInterval = {
      reason: "unsupported_assumption",
      status: "not_reported",
    };
    unsupported.assessment.dimensions.statisticalAssumptions = "unsupported";
    unsupported.assessment.eligibility = {
      reasons: ["unsupported_statistical_assumptions"],
      status: "ineligible",
    };
    expect(AssessmentSnapshotSchema.safeParse(unsupported).success).toBe(true);

    unsupported.assessment.createdAt = "2026-08-31T23:59:59.000Z";
    expect(AssessmentSnapshotSchema.safeParse(unsupported).success).toBe(false);
  });
});
