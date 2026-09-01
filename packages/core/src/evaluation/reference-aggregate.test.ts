import {
  EVALUATION_AGGREGATION_POLICY_SCHEMA_VERSION,
  type EvaluationAggregateDefinition,
  type EvaluationAggregationPolicy,
  WILSON_INTERVAL_METHOD_VERSION,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  buildReferenceAggregate,
  computeWilsonScoreInterval,
  ReferenceAggregateError,
} from "./reference-aggregate.js";

const sha = (character: string): string => character.repeat(64);

function policy(
  method: "descriptive_counts" | "wilson_score_interval" = "wilson_score_interval",
  confidenceLevelBasisPoints = 9_500,
): EvaluationAggregationPolicy {
  return {
    changeRationale: "A fixed policy for bounded reference aggregation tests.",
    dataset: {
      datasetId: "dts_reference",
      datasetVersionId: "dtv_reference_v1",
      definitionSha256: sha("3"),
    },
    definitionSha256: sha("2"),
    knownLimitations: ["The fixture population is not a production population"],
    maximumAbstentionRateBasisPoints: 2_500,
    maximumErrorRateBasisPoints: 2_500,
    method:
      method === "descriptive_counts"
        ? { method }
        : {
            confidenceLevelBasisPoints,
            method,
            methodVersion: WILSON_INTERVAL_METHOD_VERSION,
          },
    minimumApplicableCount: 1,
    minimumCoverageBasisPoints: 5_000,
    minimumDecidedCount: 1,
    policyId: "agp_reference",
    policyVersionId: "agv_reference_v1",
    publishedAt: "2026-09-02T00:00:00.000Z",
    publishedByPrincipalId: "svc_aggregator",
    schemaVersion: EVALUATION_AGGREGATION_POLICY_SCHEMA_VERSION,
    scope: {
      environmentId: "env_test",
      projectId: "prj_test",
      tenantId: "ten_test",
    },
    selectionSha256: sha("4"),
  };
}

type Verdict = EvaluationAggregateDefinition["members"][number]["verdict"];

function member(index: number, verdict: Verdict) {
  return {
    independenceGroupId: "ind_reference",
    result: {
      definitionSha256: String((index + 5) % 10).repeat(64),
      evaluationRunId: `evr_${String(index).padStart(3, "0")}`,
      resultId: `evs_${String(index).padStart(3, "0")}`,
    },
    run: {
      definitionSha256: String(index % 10).repeat(64),
      evaluationRunId: `evr_${String(index).padStart(3, "0")}`,
    },
    verdict,
  } satisfies EvaluationAggregateDefinition["members"][number];
}

const supportedSampling = {
  evidence: [
    {
      artifactId: "art_independence_review",
      classification: "internal" as const,
      mediaType: "application/json",
      sha256: sha("a"),
      sizeBytes: 128,
    },
  ],
  status: "supported" as const,
};

function request(
  verdicts: readonly Verdict[],
  overrides: Partial<Parameters<typeof buildReferenceAggregate>[0]> = {},
): Parameters<typeof buildReferenceAggregate>[0] {
  return {
    aggregateId: "eva_reference",
    criterion: {
      criterionId: "crt_reference",
      criterionSet: {
        criterionSetId: "crs_reference",
        criterionSetVersionId: "csv_reference_v1",
        definitionSha256: sha("1"),
      },
    },
    knownLimitations: ["The bounded cases do not prove production behavior"],
    members: verdicts.map((verdict, index) => member(index, verdict)),
    policy: policy(),
    samplingAssumption: supportedSampling,
    ...overrides,
  };
}

function numericBounds(interval: ReturnType<typeof computeWilsonScoreInterval>) {
  return [Number(interval.lowerBound), Number(interval.upperBound)] as const;
}

function requiredMember(
  members: readonly EvaluationAggregateDefinition["members"][number][],
  index: number,
) {
  const value = members[index];
  if (!value) throw new Error(`Missing test aggregate member at index ${index}`);
  return value;
}

describe("computeWilsonScoreInterval", () => {
  it.each([
    [0, 1, 0, 0.7934506856],
    [1, 1, 0.2065493144, 1],
    [1, 2, 0.0945312057, 0.9054687943],
    [5, 10, 0.2365930904, 0.7634069096],
    [95, 100, 0.8882495307, 0.9784563209],
  ])(
    "matches a precomputed Wilson vector for successes=%i and trials=%i",
    (successes, trials, expectedLower, expectedUpper) => {
      const [lower, upper] = numericBounds(computeWilsonScoreInterval(successes, trials, 9_500));
      expect(lower).toBeCloseTo(expectedLower, 8);
      expect(upper).toBeCloseTo(expectedUpper, 8);
    },
  );

  it("keeps every bounded count combination finite, ordered, and symmetric", () => {
    const violations: string[] = [];
    for (let trials = 1; trials <= 100; trials += 1) {
      for (let successes = 0; successes <= trials; successes += 1) {
        const [lower, upper] = numericBounds(computeWilsonScoreInterval(successes, trials, 9_500));
        const [mirrorLower, mirrorUpper] = numericBounds(
          computeWilsonScoreInterval(trials - successes, trials, 9_500),
        );
        const finiteAndOrdered =
          Number.isFinite(lower) &&
          Number.isFinite(upper) &&
          lower >= 0 &&
          upper <= 1 &&
          lower <= upper;
        const symmetric =
          Math.abs(lower - (1 - mirrorUpper)) < 5e-13 &&
          Math.abs(upper - (1 - mirrorLower)) < 5e-13;
        if (!finiteAndOrdered || !symmetric) {
          violations.push(`${successes}/${trials}: [${lower}, ${upper}]`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("widens monotonically as the predeclared confidence increases", () => {
    const ninety = numericBounds(computeWilsonScoreInterval(50, 100, 9_000));
    const ninetyFive = numericBounds(computeWilsonScoreInterval(50, 100, 9_500));
    const ninetyNine = numericBounds(computeWilsonScoreInterval(50, 100, 9_900));
    expect(ninety[0]).toBeGreaterThan(ninetyFive[0]);
    expect(ninetyFive[0]).toBeGreaterThan(ninetyNine[0]);
    expect(ninety[1]).toBeLessThan(ninetyFive[1]);
    expect(ninetyFive[1]).toBeLessThan(ninetyNine[1]);
  });

  it("remains stable at the maximum aggregate size and confidence", () => {
    const interval = computeWilsonScoreInterval(9_999, 10_000, 9_999);
    const [lower, upper] = numericBounds(interval);
    expect(lower).toBeGreaterThan(0);
    expect(upper).toBeLessThanOrEqual(1);
    expect(interval.lowerBound).not.toMatch(/[eE]/);
    expect(interval.upperBound).not.toMatch(/[eE]/);
  });

  it.each([
    [-1, 1, 9_500],
    [2, 1, 9_500],
    [0, 0, 9_500],
    [10_001, 10_001, 9_500],
    [1.5, 2, 9_500],
    [1, 2, 4_999],
    [1, 2, 10_000],
  ])("rejects invalid numerical inputs", (successes, trials, confidence) => {
    expect(() => computeWilsonScoreInterval(successes, trials, confidence)).toThrow(
      ReferenceAggregateError,
    );
  });
});

describe("buildReferenceAggregate", () => {
  it("derives exact verdict counts and each policy-defined denominator", () => {
    const aggregate = buildReferenceAggregate(
      request(["pass", "fail", "abstain", "error", "not_applicable"]),
    );
    expect(aggregate.counts).toEqual({
      abstainCount: 1,
      applicableCount: 4,
      attemptedCount: 5,
      decidedCount: 2,
      errorCount: 1,
      failCount: 1,
      notApplicableCount: 1,
      passCount: 1,
      selectedCount: 5,
    });
    expect(aggregate.coverage).toEqual({ denominator: 4, numerator: 2, status: "available" });
    expect(aggregate.abstentionRate).toEqual({
      denominator: 4,
      numerator: 1,
      status: "available",
    });
    expect(aggregate.errorRate).toEqual({ denominator: 4, numerator: 1, status: "available" });
    expect(aggregate.passProportion).toEqual({
      denominator: 2,
      numerator: 1,
      status: "available",
    });
    expect(aggregate.passInterval.status).toBe("reported");
  });

  it("does not count abstentions or errors as Wilson trials", () => {
    const aggregate = buildReferenceAggregate(
      request(["pass", "fail", "abstain", "abstain", "error", "error"]),
    );
    expect(aggregate.counts.applicableCount).toBe(6);
    expect(aggregate.counts.decidedCount).toBe(2);
    expect(aggregate.passInterval).toMatchObject({
      interval: { successCount: 1, trialCount: 2 },
      status: "reported",
    });
  });

  it("keeps every undefined zero-denominator ratio absent", () => {
    const aggregate = buildReferenceAggregate(request(["not_applicable", "not_applicable"]));
    const unavailable = { reason: "zero_denominator", status: "unavailable" };
    expect(aggregate.coverage).toEqual(unavailable);
    expect(aggregate.abstentionRate).toEqual(unavailable);
    expect(aggregate.errorRate).toEqual(unavailable);
    expect(aggregate.passProportion).toEqual(unavailable);
    expect(aggregate.passInterval).toEqual({
      reason: "no_decided_cases",
      status: "not_reported",
    });
  });

  it("reports no interval when the independence assumption is unsupported", () => {
    const aggregate = buildReferenceAggregate(
      request(["pass", "fail"], {
        samplingAssumption: {
          limitations: ["The cases share one generator and are not independent"],
          status: "unsupported",
        },
      }),
    );
    expect(aggregate.passInterval).toEqual({
      reason: "unsupported_assumption",
      status: "not_reported",
    });
  });

  it("supports descriptive counts without manufacturing an interval", () => {
    const aggregate = buildReferenceAggregate(
      request(["pass", "fail"], {
        policy: policy("descriptive_counts"),
        samplingAssumption: { status: "not_required" },
      }),
    );
    expect(aggregate.passInterval).toEqual({
      reason: "method_not_requested",
      status: "not_reported",
    });
  });

  it("canonicalizes member and limitation order without changing the result", () => {
    const ascending = request(["pass", "fail", "abstain"]);
    const reversed = {
      ...ascending,
      knownLimitations: ["Z limitation", "A limitation"],
      members: [...ascending.members].reverse(),
    };
    const result = buildReferenceAggregate(reversed);
    expect(result.members.map(({ run }) => run.evaluationRunId)).toEqual([
      "evr_000",
      "evr_001",
      "evr_002",
    ]);
    expect(result.knownLimitations).toEqual(["A limitation", "Z limitation"]);
    expect(result.counts).toEqual(buildReferenceAggregate(ascending).counts);
  });

  it("rejects duplicate, cross-run, malformed-policy, and method-assumption inputs", () => {
    const duplicate = request(["pass", "fail"]);
    const first = requiredMember(duplicate.members, 0);
    expect(() =>
      buildReferenceAggregate({
        ...duplicate,
        members: [first, first],
      }),
    ).toThrow(ReferenceAggregateError);

    const crossRun = request(["pass"]);
    const mismatchedMember = structuredClone(requiredMember(crossRun.members, 0));
    mismatchedMember.result.evaluationRunId = "evr_other";
    expect(() => buildReferenceAggregate({ ...crossRun, members: [mismatchedMember] })).toThrow(
      /same exact evaluation run/,
    );

    const malformedPolicy = { ...policy(), definitionSha256: "bad" };
    expect(() =>
      buildReferenceAggregate(request(["pass"], { policy: malformedPolicy as never })),
    ).toThrow(/policy is invalid/);

    expect(() =>
      buildReferenceAggregate(
        request(["pass"], {
          policy: policy("descriptive_counts"),
          samplingAssumption: supportedSampling,
        }),
      ),
    ).toThrow(/not-required sampling assumption/);
  });
});
