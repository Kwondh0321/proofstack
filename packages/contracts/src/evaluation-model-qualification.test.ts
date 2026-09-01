import { describe, expect, it } from "vitest";
import {
  MODEL_QUALIFICATION_SUITE_SCHEMA_VERSION,
  MODEL_QUALIFICATION_REPORT_SCHEMA_VERSION,
  type ModelQualificationReport,
  type ModelQualificationReportDefinition,
  ModelQualificationReportDefinitionSchema,
  ModelQualificationReportSchema,
  type ModelQualificationSuite,
  type ModelQualificationSuiteDefinition,
  ModelQualificationScenarioSchema,
  ModelQualificationSuiteDefinitionSchema,
  ModelQualificationSuiteSchema,
} from "./evaluation-model-qualification.js";

const sha = (character: string) => character.repeat(64);
const scope = {
  environmentId: "env_assurance",
  projectId: "prj_assurance",
  tenantId: "ten_assurance",
} as const;
const artifact = (artifactId: string, character: string, mediaType = "application/json") => ({
  artifactId,
  classification: "restricted" as const,
  mediaType,
  sha256: sha(character),
  sizeBytes: 1_024,
});

export function modelQualificationSuiteDefinition(): ModelQualificationSuiteDefinition {
  return {
    baseQualificationFixtureSet: {
      definitionSha256: sha("1"),
      fixtureSetId: "qfs_model_safety_base",
      fixtureSetVersionId: "qfv_model_safety_base_v1",
    },
    blindedPlan: {
      blindedPlanId: "blp_safety",
      blindedPlanVersionId: "blv_safety_v1",
      definitionSha256: sha("2"),
    },
    caseCount: 48,
    caseManifest: artifact("art_model_qualification_cases", "3"),
    caseManifestSchema: artifact(
      "art_model_qualification_case_schema",
      "4",
      "application/schema+json",
    ),
    changeRationale:
      "Initial adversarial, bias, variance, provider-failure, and disagreement qualification suite.",
    criteria: [
      {
        criterionId: "crt_no_unsafe_tool_request",
        criterionSetId: "crs_agent_safety",
        criterionSetVersionId: "csv_agent_safety_v1",
      },
    ],
    dataset: {
      datasetId: "dts_model_qualification",
      datasetVersionId: "dtv_model_qualification_v1",
      definitionSha256: sha("5"),
    },
    evaluator: {
      definitionSha256: sha("6"),
      evaluatorId: "evl_model_safety",
      evaluatorVersionId: "evv_model_safety_v1",
    },
    executionPolicy: {
      defaultAttemptsPerCase: 2,
      fixedSeeds: artifact("art_model_qualification_seeds", "7"),
      orderBiasAttemptsPerCase: 4,
      retryUntilPass: false,
      stochasticVarianceAttemptsPerCase: 8,
    },
    knownLimitations: [
      "Synthetic adversarial cases do not prove production resistance",
      "Unseen provider behavior remains out of scope",
    ],
    manifestValidationEvidence: artifact("art_model_qualification_validation", "8"),
    modelProfile: {
      definitionSha256: sha("9"),
      modelProfileId: "mep_safety",
      modelProfileVersionId: "mpv_safety_v1",
    },
    scenarioCoverage: [...ModelQualificationScenarioSchema.options],
    suiteId: "mqs_model_safety",
    suiteVersionId: "mqv_model_safety_v1",
    validFrom: "2026-09-02T04:00:00.000Z",
    validUntil: "2026-12-01T04:00:00.000Z",
  };
}

function modelQualificationSuite(): ModelQualificationSuite {
  return {
    ...modelQualificationSuiteDefinition(),
    definitionSha256: sha("a"),
    publishedAt: "2026-09-02T04:00:00.000Z",
    publishedByPrincipalId: "usr_model_qualification_publisher",
    schemaVersion: MODEL_QUALIFICATION_SUITE_SCHEMA_VERSION,
    scope,
  };
}

describe("model qualification suite contracts", () => {
  it("accepts exact base, blind, dataset, model, case-manifest, and scenario lineage", () => {
    expect(
      ModelQualificationSuiteDefinitionSchema.parse(modelQualificationSuiteDefinition()),
    ).toEqual(modelQualificationSuiteDefinition());
    expect(ModelQualificationSuiteSchema.parse(modelQualificationSuite())).toEqual(
      modelQualificationSuite(),
    );
  });

  it("requires every registered injection, bias, variance, failure, and disagreement scenario", () => {
    const missing = modelQualificationSuiteDefinition();
    missing.scenarioCoverage = missing.scenarioCoverage.slice(1) as never;
    expect(() => ModelQualificationSuiteDefinitionSchema.parse(missing)).toThrow();

    const substituted = modelQualificationSuiteDefinition();
    substituted.scenarioCoverage[1] = substituted.scenarioCoverage[0] as never;
    expect(() => ModelQualificationSuiteDefinitionSchema.parse(substituted)).toThrow(
      "complete, unique, and ordered",
    );

    expect(ModelQualificationScenarioSchema.options).toContain("direct_prompt_injection");
    expect(ModelQualificationScenarioSchema.options).toContain("retrieved_prompt_injection");
    expect(ModelQualificationScenarioSchema.options).toContain("self_provider_correlation");
    expect(ModelQualificationScenarioSchema.options).toContain("judge_disagreement");
  });

  it("requires bounded predeclared repetitions and forbids retry-until-pass", () => {
    const variance = modelQualificationSuiteDefinition();
    variance.executionPolicy.stochasticVarianceAttemptsPerCase = 3;
    expect(() => ModelQualificationSuiteDefinitionSchema.parse(variance)).toThrow();

    const order = modelQualificationSuiteDefinition();
    order.executionPolicy.orderBiasAttemptsPerCase = 1;
    expect(() => ModelQualificationSuiteDefinitionSchema.parse(order)).toThrow();

    expect(() =>
      ModelQualificationSuiteDefinitionSchema.parse({
        ...modelQualificationSuiteDefinition(),
        executionPolicy: {
          ...modelQualificationSuiteDefinition().executionPolicy,
          retryUntilPass: true,
        },
      }),
    ).toThrow();
  });

  it("requires positive validity and immutable predecessor lineage", () => {
    const invalidWindow = modelQualificationSuiteDefinition();
    invalidWindow.validUntil = invalidWindow.validFrom;
    expect(() => ModelQualificationSuiteDefinitionSchema.parse(invalidWindow)).toThrow(
      "positive interval",
    );

    const self = modelQualificationSuiteDefinition();
    self.predecessor = {
      definitionSha256: sha("b"),
      suiteId: self.suiteId,
      suiteVersionId: self.suiteVersionId,
    };
    expect(() => ModelQualificationSuiteDefinitionSchema.parse(self)).toThrow("name itself");
  });

  it("rejects credentials, provider endpoints, release authority, and hidden case dropping", () => {
    for (const forbidden of [
      { apiKey: "secret" },
      { providerEndpoint: "https://example.invalid" },
      { releaseAuthority: "allow" },
      { silentlyDropFailedCases: true },
    ]) {
      expect(() =>
        ModelQualificationSuiteDefinitionSchema.parse({
          ...modelQualificationSuiteDefinition(),
          ...forbidden,
        }),
      ).toThrow();
    }
  });
});

export function modelQualificationReportDefinition(): ModelQualificationReportDefinition {
  return {
    baseQualificationReport: {
      definitionSha256: sha("1"),
      qualificationReportId: "qlr_model_safety_base_v1",
    },
    calibrationReport: {
      calibrationReportId: "cal_model_safety_v1",
      definitionSha256: sha("2"),
    },
    completedAt: "2026-09-02T05:30:00.000Z",
    criticalScenarioFailures: [],
    environmentEvidence: [artifact("art_model_qualification_environment", "3")],
    evaluator: {
      definitionSha256: sha("4"),
      evaluatorId: "evl_model_safety",
      evaluatorVersionId: "evv_model_safety_v1",
    },
    executedByPrincipalId: "wrk_model_qualification_runner",
    failureReasons: [],
    independenceDeclaration: {
      definitionSha256: sha("5"),
      independenceDeclarationId: "ind_model_safety_v1",
    },
    knownLimitations: [
      "Qualification evidence is bounded to the declared suite and provider revision",
    ],
    modelProfile: {
      definitionSha256: sha("6"),
      modelProfileId: "mep_safety",
      modelProfileVersionId: "mpv_safety_v1",
    },
    reportId: "mqr_model_safety_v1",
    resultManifest: artifact("art_model_qualification_results", "7"),
    resultManifestSchema: artifact(
      "art_model_qualification_result_schema",
      "8",
      "application/schema+json",
    ),
    scenarioCoverage: [...ModelQualificationScenarioSchema.options],
    startedAt: "2026-09-02T05:00:00.000Z",
    status: "qualified",
    statusSummary: {
      abstentionAttemptCount: 2,
      attemptCount: 96,
      caseCount: 48,
      disagreementAttemptCount: 4,
      errorAttemptCount: 10,
      matchedCaseCount: 48,
      mismatchedCaseCount: 0,
      refusalAttemptCount: 2,
      timeoutAttemptCount: 2,
      unresolvedDisagreementAttemptCount: 0,
    },
    suite: {
      definitionSha256: sha("9"),
      suiteId: "mqs_model_safety",
      suiteVersionId: "mqv_model_safety_v1",
    },
    validationEvidence: [artifact("art_model_qualification_result_validation", "a")],
    validFrom: "2026-09-02T05:30:00.000Z",
    validUntil: "2026-10-02T05:30:00.000Z",
  };
}

function modelQualificationReport(): ModelQualificationReport {
  return {
    ...modelQualificationReportDefinition(),
    definitionSha256: sha("b"),
    recordedAt: "2026-09-02T05:30:01.000Z",
    schemaVersion: MODEL_QUALIFICATION_REPORT_SCHEMA_VERSION,
    scope,
  };
}

describe("model qualification report contracts", () => {
  it("accepts a complete exact report that preserves all attempts and scenario coverage", () => {
    expect(
      ModelQualificationReportDefinitionSchema.parse(modelQualificationReportDefinition()),
    ).toEqual(modelQualificationReportDefinition());
    expect(ModelQualificationReportSchema.parse(modelQualificationReport())).toEqual(
      modelQualificationReport(),
    );
  });

  it("reconstructs case counts and bounds every exceptional attempt count", () => {
    const totals = modelQualificationReportDefinition();
    totals.statusSummary.matchedCaseCount = 47;
    expect(() => ModelQualificationReportDefinitionSchema.parse(totals)).toThrow(
      "must equal caseCount",
    );

    const attempts = modelQualificationReportDefinition();
    attempts.statusSummary.attemptCount = 47;
    expect(() => ModelQualificationReportDefinitionSchema.parse(attempts)).toThrow(
      "cannot be smaller than caseCount",
    );

    const errors = modelQualificationReportDefinition();
    errors.statusSummary.errorAttemptCount = 97;
    expect(() => ModelQualificationReportDefinitionSchema.parse(errors)).toThrow(
      "cannot exceed model qualification attemptCount",
    );
  });

  it("fails qualified status closed on mismatch, critical failure, reason, or unresolved disagreement", () => {
    const mismatch = modelQualificationReportDefinition();
    mismatch.statusSummary.matchedCaseCount = 47;
    mismatch.statusSummary.mismatchedCaseCount = 1;
    expect(() => ModelQualificationReportDefinitionSchema.parse(mismatch)).toThrow(
      "requires no mismatches",
    );

    const critical = modelQualificationReportDefinition();
    critical.criticalScenarioFailures = ["direct_prompt_injection"];
    expect(() => ModelQualificationReportDefinitionSchema.parse(critical)).toThrow(
      "requires no mismatches",
    );

    const disagreement = modelQualificationReportDefinition();
    disagreement.statusSummary.unresolvedDisagreementAttemptCount = 1;
    expect(() => ModelQualificationReportDefinitionSchema.parse(disagreement)).toThrow(
      "requires no mismatches",
    );
  });

  it("accepts unqualified status only with an explicit preserved reason", () => {
    const failed = modelQualificationReportDefinition();
    failed.status = "unqualified";
    failed.failureReasons = ["Direct prompt injection was not detected"];
    failed.criticalScenarioFailures = ["direct_prompt_injection"];
    failed.statusSummary.matchedCaseCount = 47;
    failed.statusSummary.mismatchedCaseCount = 1;
    expect(ModelQualificationReportDefinitionSchema.parse(failed)).toEqual(failed);

    failed.failureReasons = [];
    expect(() => ModelQualificationReportDefinitionSchema.parse(failed)).toThrow(
      "requires at least one failure reason",
    );
  });

  it("enforces time and immutable report history", () => {
    const early = modelQualificationReportDefinition();
    early.completedAt = "2026-09-02T04:59:59.000Z";
    expect(() => ModelQualificationReportDefinitionSchema.parse(early)).toThrow(
      "cannot precede its start",
    );

    const validity = modelQualificationReportDefinition();
    validity.validFrom = "2026-09-02T05:29:59.000Z";
    expect(() => ModelQualificationReportDefinitionSchema.parse(validity)).toThrow(
      "cannot begin before completion",
    );

    const emptyWindow = modelQualificationReportDefinition();
    emptyWindow.validUntil = emptyWindow.validFrom;
    expect(() => ModelQualificationReportDefinitionSchema.parse(emptyWindow)).toThrow(
      "positive interval",
    );

    const self = modelQualificationReportDefinition();
    self.predecessor = { definitionSha256: sha("c"), reportId: self.reportId };
    expect(() => ModelQualificationReportDefinitionSchema.parse(self)).toThrow("name itself");
  });

  it("rejects correctness probability, dropped failures, release authority, and mutable results", () => {
    for (const forbidden of [
      { correctnessProbability: "0.99" },
      { dropFailedAttempts: true },
      { mutableResults: true },
      { releaseAuthority: "allow" },
    ]) {
      expect(() =>
        ModelQualificationReportDefinitionSchema.parse({
          ...modelQualificationReportDefinition(),
          ...forbidden,
        }),
      ).toThrow();
    }
  });
});
