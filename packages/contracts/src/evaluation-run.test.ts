import { describe, expect, it } from "vitest";
import {
  EVALUATION_RUN_REJECTION_SCHEMA_VERSION,
  EVALUATION_RUN_RESULT_SCHEMA_VERSION,
  EVALUATION_RUN_SCHEMA_VERSION,
  type EvaluationRun,
  EvaluationRunDefinitionSchema,
  EvaluationRunRejectionSchema,
  type EvaluationRunResult,
  EvaluationRunResultSchema,
  EvaluationRunSchema,
  EvaluationRunSnapshotSchema,
  RAW_OBSERVATION_SCHEMA_VERSION,
  type RawObservation,
  RawObservationSchema,
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

const implementation = {
  dependencySnapshotSha256: sha("1"),
  entryPointId: "ent_applicability_v1",
  implementationId: "imp_applicability",
  implementationSha256: sha("2"),
  implementationVersionId: "imv_applicability_v1",
  runtime: {
    architecture: "arm64" as const,
    family: "node" as const,
    platform: "darwin" as const,
    version: "24.0.0",
  },
  sourceRevision: "a".repeat(40),
};

const criterion = {
  criterionId: "crt_schema",
  criterionSet: {
    criterionSetId: "crs_response",
    criterionSetVersionId: "csv_response_v1",
    definitionSha256: sha("3"),
  },
} as const;

const attemptBudgets = {
  elapsedMilliseconds: 5_000,
  inputBytes: 1_048_576,
  memoryBytes: 268_435_456,
  outputBytes: 1_048_576,
} as const;

function evaluationRun(): EvaluationRun {
  return {
    aggregationPolicy: {
      definitionSha256: sha("4"),
      policyId: "agp_boolean",
      policyVersionId: "agv_boolean_v1",
    },
    applicability: {
      context: {
        environmentId: "env_local",
        locale: "en",
        populationTags: [],
        riskTier: "moderate",
        taskKind: "tsk_support",
      },
      contextSha256: sha("5"),
      evaluatedAt: "2026-09-01T00:00:00Z",
      interpreter: implementation,
      result: "applicable",
      runtimePolicy: {
        clock: { mode: "not_available" },
        dataEgress: "denied",
        locale: "en",
        network: "denied",
        seed: { mode: "not_used" },
        sideEffects: "denied",
      },
    },
    attempts: [
      {
        attemptId: "att_0",
        attemptSequence: 0,
        budgets: attemptBudgets,
        seed: { mode: "fixed", value: 41 },
      },
      {
        attemptId: "att_1",
        attemptSequence: 1,
        budgets: attemptBudgets,
        seed: { mode: "fixed", value: 42 },
      },
    ],
    createdAt: "2026-09-01T00:00:01.000Z",
    createdByPrincipalId: "usr_operator",
    criterion,
    criterionStatus: {
      definitionSha256: sha("6"),
      statusRecordId: "csr_approved",
    },
    dataset: {
      datasetId: "dts_regression",
      datasetVersionId: "dtv_regression_v1",
      definitionSha256: sha("7"),
    },
    definitionSha256: sha("8"),
    environmentEvidence: [artifact("art_environment", "9")],
    evaluationRunId: "evr_schema",
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
      fixtureId: "fix_schema",
      fixtureVersionId: "fxv_schema_v1",
    },
    inputEvidence: [artifact("art_input", "d")],
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
      attemptId: "rat_success",
      completedAt: "2026-09-01T00:00:00Z",
      jobId: "rjb_schema",
      plan: {
        definitionSha256: sha("0"),
        planId: "rpl_schema",
        planVersionId: "rpv_schema_v1",
      },
      result: artifact("art_replay_result", "1"),
      targetRelease: {
        definitionSha256: sha("2"),
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
    retryableErrors: ["evaluator_temporarily_unavailable", "executor_interrupted"],
    schemaVersion: EVALUATION_RUN_SCHEMA_VERSION,
    scope,
    sourceReviews: [
      {
        definitionSha256: sha("3"),
        sourceReviewId: "srv_primary",
      },
    ],
  };
}

function observation(attemptSequence: 0 | 1, verdict: "error" | "pass" = "pass"): RawObservation {
  const startedAt = attemptSequence === 0 ? "2026-09-01T00:00:02Z" : "2026-09-01T00:00:04Z";
  const completedAt = attemptSequence === 0 ? "2026-09-01T00:00:03Z" : "2026-09-01T00:00:05Z";
  const common = {
    attemptId: `att_${attemptSequence}`,
    attemptSequence,
    budgetUsage: {
      elapsedMilliseconds: 1_000,
      inputBytes: 1_024,
      outputBytes: verdict === "error" ? 0 : 128,
      peakMemoryBytes: 33_554_432,
    },
    completedAt,
    counterevidence: [],
    definitionSha256: sha(attemptSequence === 0 ? "4" : "5"),
    evidence: [
      {
        artifact: artifact(`art_observation_${attemptSequence}`, attemptSequence === 0 ? "6" : "7"),
        kind: "artifact" as const,
      },
    ],
    executedByPrincipalId: "svc_evaluator",
    inputSha256: sha("8"),
    observationId: `obs_${attemptSequence}`,
    outOfDistribution: "not_assessed" as const,
    recordedAt: `${completedAt.slice(0, -1)}.000Z`,
    run: {
      definitionSha256: sha("8"),
      evaluationRunId: "evr_schema",
    },
    schemaVersion: RAW_OBSERVATION_SCHEMA_VERSION,
    scope,
    startedAt,
  };

  return verdict === "error"
    ? {
        ...common,
        error: {
          code: "evaluator_temporarily_unavailable",
          message: "The registered evaluator reported a retryable local availability failure.",
        },
        output: { produced: false },
        verdict,
      }
    : {
        ...common,
        measurement: { kind: "boolean", metricName: "schema_valid", value: true },
        output: { produced: true, sha256: sha("9") },
        verdict,
      };
}

function runResult(
  observations: readonly RawObservation[],
  verdict: EvaluationRunResult["verdict"] = "pass",
): EvaluationRunResult {
  return {
    completedAt: "2026-09-01T00:00:06Z",
    definitionSha256: sha("a"),
    evaluationRunId: "evr_schema",
    observations: observations.map(({ definitionSha256, observationId }) => ({
      definitionSha256,
      observationId,
    })),
    recordedAt: "2026-09-01T00:00:06.000Z",
    recordedByPrincipalId: "svc_evaluator",
    resultId: "evs_schema",
    schemaVersion: EVALUATION_RUN_RESULT_SCHEMA_VERSION,
    scope,
    terminalReason: verdict === "error" ? "attempts_exhausted" : "completed",
    verdict,
  };
}

describe("evaluation run contracts", () => {
  it("binds exact criteria, reviews, qualification, replay, target, inputs, and attempts", () => {
    const run = evaluationRun();
    expect(EvaluationRunSchema.parse(run)).toEqual(run);
    const {
      createdAt: _createdAt,
      createdByPrincipalId: _createdBy,
      definitionSha256: _definitionSha256,
      schemaVersion: _schemaVersion,
      scope: _scope,
      ...definition
    } = run;
    expect(EvaluationRunDefinitionSchema.parse(definition)).toEqual(definition);
  });

  it("closes not-applicable criteria without fabricating an execution attempt", () => {
    const run = evaluationRun();
    run.applicability.result = "not_applicable";
    run.attempts = [];
    expect(EvaluationRunSchema.safeParse(run).success).toBe(true);

    run.attempts = evaluationRun().attempts;
    expect(EvaluationRunSchema.safeParse(run).success).toBe(false);
  });

  it("rejects empty, duplicate, unordered, or non-contiguous applicable attempts", () => {
    const empty = evaluationRun();
    empty.attempts = [];
    expect(EvaluationRunSchema.safeParse(empty).success).toBe(false);

    const duplicate = evaluationRun();
    duplicate.attempts[1] = {
      ...requireAt(duplicate.attempts, 1, "predeclared attempt"),
      attemptId: "att_0",
    };
    expect(EvaluationRunSchema.safeParse(duplicate).success).toBe(false);

    const unordered = evaluationRun();
    unordered.attempts.reverse();
    expect(EvaluationRunSchema.safeParse(unordered).success).toBe(false);

    const gap = evaluationRun();
    gap.attempts[1] = {
      ...requireAt(gap.attempts, 1, "predeclared attempt"),
      attemptSequence: 2,
    };
    expect(EvaluationRunSchema.safeParse(gap).success).toBe(false);
  });

  it("rejects hidden policy, command, model, credential, and release-decision authority", () => {
    for (const forbidden of [
      { command: "run arbitrary evaluator" },
      { credentialId: "cred_provider" },
      { model: "judge-model" },
      { releaseDecision: "approved" },
      { shell: "/bin/sh" },
    ]) {
      expect(EvaluationRunSchema.safeParse({ ...evaluationRun(), ...forbidden }).success).toBe(
        false,
      );
    }
  });

  it("records undetermined applicability as a rejection instead of a run verdict", () => {
    const run = evaluationRun();
    expect(
      EvaluationRunSchema.safeParse({
        ...run,
        applicability: { ...run.applicability, result: "undetermined" },
      }).success,
    ).toBe(false);

    const rejection = {
      applicability: { ...run.applicability, result: "undetermined" as const },
      criterion: run.criterion,
      criterionStatus: run.criterionStatus,
      definitionSha256: sha("b"),
      reasons: ["Required jurisdiction is missing from the authenticated context"],
      recordedAt: "2026-09-01T00:00:01.000Z",
      rejectionId: "evj_schema",
      requestedByPrincipalId: "usr_operator",
      resolution: "require_approval" as const,
      schemaVersion: EVALUATION_RUN_REJECTION_SCHEMA_VERSION,
      scope,
      sourceReviews: run.sourceReviews,
    };
    expect(EvaluationRunRejectionSchema.parse(rejection)).toEqual(rejection);

    expect(
      EvaluationRunRejectionSchema.safeParse({
        ...rejection,
        recordedAt: "2026-08-31T23:59:59.000Z",
      }).success,
    ).toBe(false);
  });

  it("requires a pure applicability interpreter and monotonic prerequisite time", () => {
    const clocked = evaluationRun();
    clocked.applicability.runtimePolicy.clock = {
      instant: "2026-09-01T00:00:00Z",
      mode: "fixed",
    };
    expect(EvaluationRunSchema.safeParse(clocked).success).toBe(false);

    const random = evaluationRun();
    random.applicability.runtimePolicy.seed = { mode: "fixed", value: 42 };
    expect(EvaluationRunSchema.safeParse(random).success).toBe(false);

    const premature = evaluationRun();
    premature.createdAt = "2026-08-31T23:59:59.000Z";
    expect(EvaluationRunSchema.safeParse(premature).success).toBe(false);
  });
});

describe("raw observation contracts", () => {
  it("preserves a decided measurement and a typed retryable error as different outcomes", () => {
    expect(RawObservationSchema.parse(observation(0, "pass"))).toEqual(observation(0, "pass"));
    expect(RawObservationSchema.parse(observation(0, "error"))).toEqual(observation(0, "error"));
  });

  it("supports explicit abstention without converting it to failure", () => {
    const abstention = {
      ...observation(0, "pass"),
      abstention: {
        code: "insufficient_evidence" as const,
        rationale: "The exact input does not contain the field required by this criterion.",
      },
      measurement: undefined,
      outOfDistribution: "out_of_distribution" as const,
      verdict: "abstain" as const,
    };
    expect(RawObservationSchema.safeParse(abstention).success).toBe(true);
  });

  it("rejects forged verdict payloads, not-applicable observations, and disguised OOD decisions", () => {
    const passWithoutMeasurement = clone(observation(0, "pass"));
    delete passWithoutMeasurement.measurement;
    expect(RawObservationSchema.safeParse(passWithoutMeasurement).success).toBe(false);

    expect(
      RawObservationSchema.safeParse({
        ...observation(0, "pass"),
        error: {
          code: "contract_mismatch",
          message: "Unexpected error attached to a pass.",
        },
      }).success,
    ).toBe(false);
    expect(
      RawObservationSchema.safeParse({ ...observation(0, "pass"), verdict: "not_applicable" })
        .success,
    ).toBe(false);
    expect(
      RawObservationSchema.safeParse({
        ...observation(0, "pass"),
        outOfDistribution: "out_of_distribution",
      }).success,
    ).toBe(false);

    const errorWithMeasurement = {
      ...observation(0, "error"),
      measurement: { kind: "boolean" as const, metricName: "schema_valid", value: false },
    };
    expect(RawObservationSchema.safeParse(errorWithMeasurement).success).toBe(false);

    const abstentionWithoutReason = clone(observation(0, "pass"));
    delete abstentionWithoutReason.measurement;
    abstentionWithoutReason.verdict = "abstain";
    expect(RawObservationSchema.safeParse(abstentionWithoutReason).success).toBe(false);
  });

  it("rejects invalid output lineage, duplicate evidence, and backward time", () => {
    const wrongDigest = clone(observation(0, "pass"));
    wrongDigest.output = {
      artifact: artifact("art_output", "1"),
      produced: true,
      sha256: sha("2"),
    };
    expect(RawObservationSchema.safeParse(wrongDigest).success).toBe(false);

    const duplicateEvidence = clone(observation(0, "pass"));
    duplicateEvidence.evidence.push(
      requireAt(duplicateEvidence.evidence, 0, "observation evidence"),
    );
    expect(RawObservationSchema.safeParse(duplicateEvidence).success).toBe(false);

    expect(
      RawObservationSchema.safeParse({
        ...observation(0, "pass"),
        completedAt: "2026-09-01T00:00:01Z",
      }).success,
    ).toBe(false);
    expect(
      RawObservationSchema.safeParse({
        ...observation(0, "pass"),
        recordedAt: "2026-09-01T00:00:02.000Z",
      }).success,
    ).toBe(false);
  });

  it("retains ordered artifact, replay-result, and source-snapshot evidence", () => {
    const run = evaluationRun();
    const value = observation(0, "pass");
    value.evidence = [
      { artifact: artifact("art_evidence", "1"), kind: "artifact" },
      { kind: "replay_result", replay: run.replay },
      {
        kind: "source_snapshot",
        source: { definitionSha256: sha("2"), sourceSnapshotId: "src_primary" },
      },
    ];
    expect(RawObservationSchema.safeParse(value).success).toBe(true);
    value.evidence.reverse();
    expect(RawObservationSchema.safeParse(value).success).toBe(false);
  });
});

describe("evaluation run history contracts", () => {
  it("allows one predeclared retryable error followed by one terminal decision", () => {
    const observations = [observation(0, "error"), observation(1, "pass")];
    const snapshot = {
      observations,
      result: runResult(observations),
      run: evaluationRun(),
    };
    expect(EvaluationRunSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("forbids retry-until-pass and retries after unlisted failures", () => {
    const afterPass = [observation(0, "pass"), observation(1, "pass")];
    expect(
      EvaluationRunSnapshotSchema.safeParse({
        observations: afterPass,
        result: runResult(afterPass),
        run: evaluationRun(),
      }).success,
    ).toBe(false);

    const unlisted = observation(0, "error");
    unlisted.error = {
      code: "evaluator_internal_error",
      message: "The evaluator failed internally.",
    };
    const afterUnlisted = [unlisted, observation(1, "pass")];
    expect(
      EvaluationRunSnapshotSchema.safeParse({
        observations: afterUnlisted,
        result: runResult(afterUnlisted),
        run: evaluationRun(),
      }).success,
    ).toBe(false);
  });

  it("rejects unplanned identities, budget overruns, overlapping attempts, and forged references", () => {
    const observations = [observation(0, "error"), observation(1, "pass")];

    const wrongAttempt = clone(observations);
    requireAt(wrongAttempt, 1, "raw observation").attemptId = "att_other";
    expect(
      EvaluationRunSnapshotSchema.safeParse({
        observations: wrongAttempt,
        result: runResult(wrongAttempt),
        run: evaluationRun(),
      }).success,
    ).toBe(false);

    const overBudget = clone(observations);
    requireAt(overBudget, 0, "raw observation").budgetUsage.elapsedMilliseconds = 5_001;
    expect(
      EvaluationRunSnapshotSchema.safeParse({
        observations: overBudget,
        result: runResult(overBudget),
        run: evaluationRun(),
      }).success,
    ).toBe(false);

    const overlapping = clone(observations);
    requireAt(overlapping, 1, "raw observation").startedAt = "2026-09-01T00:00:02Z";
    expect(
      EvaluationRunSnapshotSchema.safeParse({
        observations: overlapping,
        result: runResult(overlapping),
        run: evaluationRun(),
      }).success,
    ).toBe(false);

    const forgedResult = runResult(observations);
    requireAt(forgedResult.observations, 1, "observation reference").definitionSha256 = sha("f");
    expect(
      EvaluationRunSnapshotSchema.safeParse({
        observations,
        result: forgedResult,
        run: evaluationRun(),
      }).success,
    ).toBe(false);
  });

  it("rejects unordered histories, scope drift, premature completion, and wrong terminal reasons", () => {
    const observations = [observation(0, "error"), observation(1, "pass")];

    const unordered = clone(observations);
    unordered.reverse();
    expect(
      EvaluationRunSnapshotSchema.safeParse({
        observations: unordered,
        result: runResult(unordered),
        run: evaluationRun(),
      }).success,
    ).toBe(false);

    const wrongScope = clone(observations);
    requireAt(wrongScope, 0, "raw observation").scope.projectId = "prj_other";
    expect(
      EvaluationRunSnapshotSchema.safeParse({
        observations: wrongScope,
        result: runResult(wrongScope),
        run: evaluationRun(),
      }).success,
    ).toBe(false);

    const premature = runResult(observations);
    premature.completedAt = "2026-09-01T00:00:04Z";
    expect(
      EvaluationRunSnapshotSchema.safeParse({
        observations,
        result: premature,
        run: evaluationRun(),
      }).success,
    ).toBe(false);

    const wrongReason = runResult(observations);
    wrongReason.terminalReason = "not_applicable";
    expect(
      EvaluationRunSnapshotSchema.safeParse({
        observations,
        result: wrongReason,
        run: evaluationRun(),
      }).success,
    ).toBe(false);
  });

  it("allows an in-progress snapshot and rejects a terminal result without an applicable observation", () => {
    expect(
      EvaluationRunSnapshotSchema.safeParse({
        observations: [observation(0, "error")],
        run: evaluationRun(),
      }).success,
    ).toBe(true);

    expect(
      EvaluationRunSnapshotSchema.safeParse({
        observations: [],
        result: runResult([], "pass"),
        run: evaluationRun(),
      }).success,
    ).toBe(false);
  });

  it("rejects observations and terminal records that predate run creation", () => {
    const earlyObservation = observation(0, "pass");
    earlyObservation.startedAt = "2026-09-01T00:00:00Z";
    expect(
      EvaluationRunSnapshotSchema.safeParse({
        observations: [earlyObservation],
        run: evaluationRun(),
      }).success,
    ).toBe(false);

    const earlyResult = runResult([], "pass");
    earlyResult.completedAt = "2026-09-01T00:00:00Z";
    earlyResult.recordedAt = "2026-09-01T00:00:00.000Z";
    expect(
      EvaluationRunSnapshotSchema.safeParse({
        observations: [],
        result: earlyResult,
        run: evaluationRun(),
      }).success,
    ).toBe(false);

    const unrecorded = runResult([observation(0, "pass")]);
    unrecorded.recordedAt = "2026-09-01T00:00:05.000Z";
    expect(EvaluationRunResultSchema.safeParse(unrecorded).success).toBe(false);
  });

  it("distinguishes exhausted retryable errors from an immediate non-retryable error", () => {
    const firstRetryable = [observation(0, "error")];
    expect(
      EvaluationRunSnapshotSchema.safeParse({
        observations: firstRetryable,
        result: runResult(firstRetryable, "error"),
        run: evaluationRun(),
      }).success,
    ).toBe(false);

    const exhausted = [observation(0, "error"), observation(1, "error")];
    expect(
      EvaluationRunSnapshotSchema.safeParse({
        observations: exhausted,
        result: runResult(exhausted, "error"),
        run: evaluationRun(),
      }).success,
    ).toBe(true);

    const nonRetryable = observation(0, "error");
    nonRetryable.error = {
      code: "contract_mismatch",
      message: "The output violates the fixed evaluator contract.",
    };
    const immediate = runResult([nonRetryable], "error");
    immediate.terminalReason = "non_retryable_error";
    expect(
      EvaluationRunSnapshotSchema.safeParse({
        observations: [nonRetryable],
        result: immediate,
        run: evaluationRun(),
      }).success,
    ).toBe(true);
  });

  it("closes not-applicable runs with zero observations and no synthetic score", () => {
    const run = evaluationRun();
    run.applicability.result = "not_applicable";
    run.attempts = [];
    const result = runResult([], "not_applicable");
    result.terminalReason = "not_applicable";
    expect(EvaluationRunResultSchema.safeParse(result).success).toBe(true);
    expect(EvaluationRunSnapshotSchema.safeParse({ observations: [], result, run }).success).toBe(
      true,
    );

    const forged = clone(result);
    forged.verdict = "pass";
    forged.terminalReason = "completed";
    expect(
      EvaluationRunSnapshotSchema.safeParse({ observations: [], result: forged, run }).success,
    ).toBe(false);
  });
});
