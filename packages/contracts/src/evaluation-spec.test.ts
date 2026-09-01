import { describe, expect, it } from "vitest";
import type { EvaluatorReference, OracleReference } from "./evaluation-criteria.js";
import {
  EVALUATOR_SPEC_SCHEMA_VERSION,
  EvaluatorSpecDefinitionSchema,
  EvaluatorSpecSchema,
  ORACLE_SPEC_SCHEMA_VERSION,
  OracleSpecDefinitionSchema,
  OracleSpecSchema,
  QUALIFICATION_FIXTURE_SET_SCHEMA_VERSION,
  QUALIFICATION_REPORT_SCHEMA_VERSION,
  QualificationCaseSchema,
  type QualificationFixtureSet,
  QualificationFixtureSetDefinitionSchema,
  QualificationFixtureSetSchema,
  type QualificationReport,
  QualificationReportDefinitionSchema,
  QualificationReportSchema,
} from "./evaluation-spec.js";

const sha = (character: string) => character.repeat(64);

const scope = {
  environmentId: "env_local",
  projectId: "prj_local",
  tenantId: "ten_local",
} as const;

const artifact = (artifactId: string, character: string) => ({
  artifactId,
  classification: "internal" as const,
  mediaType: "application/schema+json",
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

const criterionSelector = {
  criterionId: criterion.criterionId,
  criterionSetId: criterion.criterionSet.criterionSetId,
  criterionSetVersionId: criterion.criterionSet.criterionSetVersionId,
} as const;

const fixtureSetReference = {
  definitionSha256: sha("2"),
  fixtureSetId: "qfs_schema",
  fixtureSetVersionId: "qfv_schema_v1",
} as const;

const implementation = () => ({
  dependencySnapshotSha256: sha("3"),
  entryPointId: "ent_schema",
  implementationId: "imp_schema",
  implementationSha256: sha("4"),
  implementationVersionId: "imv_schema_v1",
  runtime: {
    architecture: "arm64" as const,
    family: "node" as const,
    platform: "darwin" as const,
    version: "24.0.0",
  },
  sourceRevision: "a".repeat(40),
});

const budgets = {
  elapsedMilliseconds: 5_000,
  inputBytes: 1_048_576,
  memoryBytes: 268_435_456,
  outputBytes: 1_048_576,
} as const;

const runtimePolicy = {
  clock: { instant: "2026-09-01T00:00:00Z", mode: "fixed" as const },
  dataEgress: "denied" as const,
  locale: "en",
  network: "denied" as const,
  seed: { mode: "fixed" as const, value: 42 },
  sideEffects: "denied" as const,
};

function oracleDefinition() {
  return {
    budgets,
    configurationSha256: sha("5"),
    implementation: implementation(),
    inputSchema: artifact("art_oracle_input", "6"),
    kind: "schema" as const,
    knownLimitations: ["Valid structure does not imply factual correctness"],
    oracleId: "orc_schema",
    oracleVersionId: "orv_schema_v1",
    outputSchema: artifact("art_oracle_output", "7"),
    qualificationFixtureSet: fixtureSetReference,
    resultSemantics: "Emit an exact schema violation count and paths without assessment.",
    runtimePolicy,
    supportedCriteria: [criterionSelector],
  };
}

const oracleReference: OracleReference = {
  definitionSha256: sha("8"),
  oracleId: "orc_schema",
  oracleVersionId: "orv_schema_v1",
};

function evaluatorDefinition() {
  return {
    budgets,
    configurationSha256: sha("9"),
    evaluatorId: "evl_schema",
    evaluatorVersionId: "evv_schema_v1",
    implementation: implementation(),
    independenceGroup: {
      groupId: "ind_schema",
      implementationAuthors: ["ProofStack maintainers"],
      labelSourceIds: ["lbl_schema"],
      organization: "ProofStack",
    },
    inputSchema: artifact("art_evaluator_input", "a"),
    kindDeclaration: { kind: "deterministic" as const },
    knownLimitations: ["Evaluates only the declared schema criterion"],
    oracles: [oracleReference],
    outputSchema: artifact("art_evaluator_output", "b"),
    qualificationFixtureSet: fixtureSetReference,
    reproducibility: "exact" as const,
    runtimePolicy,
    supportedCriteria: [criterionSelector],
  };
}

const evaluatorReference: EvaluatorReference = {
  definitionSha256: sha("c"),
  evaluatorId: "evl_schema",
  evaluatorVersionId: "evv_schema_v1",
};

const caseDefinitions = [
  ["case_abstention", "abstention", "abstain"],
  ["case_boundary", "boundary", "pass"],
  ["case_budget", "budget", "error"],
  ["case_error", "error", "error"],
  ["case_malformed", "malformed", "error"],
  ["case_negative", "negative", "fail"],
  ["case_not_applicable", "not_applicable", "not_applicable"],
  ["case_positive", "positive", "pass"],
  ["case_timeout", "timeout", "error"],
] as const;

function qualificationFixtureSet(): QualificationFixtureSet {
  return {
    cases: caseDefinitions.map(([caseId, caseKind, expectedOutcome], index) => ({
      caseId,
      caseKind,
      criterion: criterionSelector,
      expectedOutcome,
      fixture: {
        definitionSha256: sha(String((index + 1) % 10)),
        fixtureId: `fix_${caseKind}`,
        fixtureVersionId: `fxv_${caseKind}`,
      },
    })),
    changeRationale: "Initial adversarial non-model qualification corpus",
    definitionSha256: sha("d"),
    fixtureSetId: "qfs_schema",
    fixtureSetVersionId: "qfv_schema_v1",
    publishedAt: "2026-09-01T00:00:00.000Z",
    publishedByPrincipalId: "usr_qualifier",
    schemaVersion: QUALIFICATION_FIXTURE_SET_SCHEMA_VERSION,
    scope,
  };
}

function qualificationReport(): QualificationReport {
  return {
    caseResults: caseDefinitions.map(([caseId, caseKind, expectedOutcome], index) => ({
      actualOutcome: expectedOutcome,
      caseId,
      caseKind,
      expectedOutcome,
      matched: true,
      rawEvidence: [artifact(`art_result_${caseKind}`, String((index + 1) % 10))],
    })),
    completedAt: "2026-09-01T00:01:00Z",
    definitionSha256: sha("e"),
    environmentEvidence: [artifact("art_environment", "f")],
    executedByPrincipalId: "svc_qualifier",
    fixtureSet: fixtureSetReference,
    knownLimitations: ["Qualification covers only the declared fixture set and environment"],
    policy: {
      definitionSha256: sha("1"),
      policyId: "qlp_strict",
      policyVersionId: "qlv_strict_v1",
    },
    qualificationReportId: "qlr_schema",
    recordedAt: "2026-09-01T00:01:01.000Z",
    schemaVersion: QUALIFICATION_REPORT_SCHEMA_VERSION,
    scope,
    startedAt: "2026-09-01T00:00:00Z",
    status: "qualified",
    subject: { evaluator: evaluatorReference, kind: "evaluator" },
    summary: {
      matchedCount: 9,
      mismatchedCount: 0,
      totalCount: 9,
      unexpectedErrorCount: 0,
    },
    validFrom: "2026-09-01T00:01:00Z",
    validUntil: "2026-12-01T00:00:00Z",
  };
}

describe("oracle specification contracts", () => {
  it("binds an exact registered non-model implementation to denied ambient authority", () => {
    const definition = oracleDefinition();
    expect(OracleSpecDefinitionSchema.parse(definition)).toEqual(definition);

    const record = {
      ...definition,
      definitionSha256: sha("8"),
      publishedAt: "2026-09-01T00:00:00.000Z",
      publishedByPrincipalId: "usr_publisher",
      schemaVersion: ORACLE_SPEC_SCHEMA_VERSION,
      scope,
    };
    expect(OracleSpecSchema.parse(record)).toEqual(record);
  });

  it.each([
    ["network access", { runtimePolicy: { ...runtimePolicy, network: "allowed" } }],
    ["side effects", { runtimePolicy: { ...runtimePolicy, sideEffects: "allowed" } }],
    ["caller command", { command: "node arbitrary.js" }],
    ["caller path", { executablePath: "/tmp/oracle" }],
  ])("rejects %s", (_label, override) => {
    expect(
      OracleSpecDefinitionSchema.safeParse({ ...oracleDefinition(), ...override }).success,
    ).toBe(false);
  });

  it("requires exact same-logical predecessor lineage", () => {
    expect(
      OracleSpecDefinitionSchema.safeParse({
        ...oracleDefinition(),
        predecessor: { ...oracleReference, oracleVersionId: "orv_schema_v0" },
      }).success,
    ).toBe(true);
    expect(
      OracleSpecDefinitionSchema.safeParse({
        ...oracleDefinition(),
        predecessor: oracleReference,
      }).success,
    ).toBe(false);
    expect(
      OracleSpecDefinitionSchema.safeParse({
        ...oracleDefinition(),
        predecessor: { ...oracleReference, oracleId: "orc_other" },
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate or unordered criteria and limitations", () => {
    expect(
      OracleSpecDefinitionSchema.safeParse({
        ...oracleDefinition(),
        supportedCriteria: [criterionSelector, criterionSelector],
      }).success,
    ).toBe(false);
    expect(
      OracleSpecDefinitionSchema.safeParse({
        ...oracleDefinition(),
        knownLimitations: ["zeta", "alpha"],
      }).success,
    ).toBe(false);
  });

  it("uses immutable version selectors instead of cyclic criterion digest references", () => {
    expect(
      OracleSpecDefinitionSchema.safeParse({
        ...oracleDefinition(),
        supportedCriteria: [criterion],
      }).success,
    ).toBe(false);
    const fixtureSet = qualificationFixtureSet();
    fixtureSet.cases[0] = { ...fixtureSet.cases[0], criterion } as never;
    expect(QualificationFixtureSetSchema.safeParse(fixtureSet).success).toBe(false);
  });
});

describe("evaluator specification contracts", () => {
  it("publishes a deterministic evaluator without model or release authority", () => {
    const definition = evaluatorDefinition();
    expect(EvaluatorSpecDefinitionSchema.parse(definition)).toEqual(definition);

    const record = {
      ...definition,
      definitionSha256: sha("c"),
      publishedAt: "2026-09-01T00:00:00.000Z",
      publishedByPrincipalId: "usr_publisher",
      schemaVersion: EVALUATOR_SPEC_SCHEMA_VERSION,
      scope,
    };
    expect(EvaluatorSpecSchema.parse(record)).toEqual(record);
  });

  it("supports only predeclared descriptive and Wilson statistical aggregation", () => {
    const descriptive = {
      ...evaluatorDefinition(),
      kindDeclaration: {
        aggregation: { method: "descriptive_counts" as const },
        kind: "statistical" as const,
      },
    };
    expect(EvaluatorSpecDefinitionSchema.safeParse(descriptive).success).toBe(true);

    const wilson = {
      ...evaluatorDefinition(),
      kindDeclaration: {
        aggregation: {
          confidenceLevelBasisPoints: 9_500,
          method: "wilson_score_interval" as const,
        },
        kind: "statistical" as const,
      },
    };
    expect(EvaluatorSpecDefinitionSchema.safeParse(wilson).success).toBe(true);
    expect(
      EvaluatorSpecDefinitionSchema.safeParse({
        ...wilson,
        kindDeclaration: {
          aggregation: { method: "accuracy" },
          kind: "statistical",
        },
      }).success,
    ).toBe(false);
  });

  it("requires distinct ordered composite components and rejects self-inclusion", () => {
    const other: EvaluatorReference = {
      definitionSha256: sha("d"),
      evaluatorId: "evl_secondary",
      evaluatorVersionId: "evv_secondary_v1",
    };
    const composite = {
      ...evaluatorDefinition(),
      kindDeclaration: {
        components: [evaluatorReference, other],
        kind: "composite" as const,
      },
    };
    expect(EvaluatorSpecDefinitionSchema.safeParse(composite).success).toBe(false);

    const valid = {
      ...composite,
      evaluatorId: "evl_composite",
      evaluatorVersionId: "evv_composite_v1",
    };
    expect(EvaluatorSpecDefinitionSchema.safeParse(valid).success).toBe(true);
    expect(
      EvaluatorSpecDefinitionSchema.safeParse({
        ...valid,
        kindDeclaration: { components: [other, other], kind: "composite" },
      }).success,
    ).toBe(false);
  });

  it("rejects model, provider, prompt, executable, and release-policy fields", () => {
    for (const forbidden of [
      { model: "judge-model" },
      { prompt: "Decide whether this is good" },
      { provider: "example-provider" },
      { releaseDecision: "approved" },
      { shell: "run-evaluator" },
    ]) {
      expect(
        EvaluatorSpecDefinitionSchema.safeParse({ ...evaluatorDefinition(), ...forbidden }).success,
      ).toBe(false);
    }
  });

  it("requires exact same-logical predecessor lineage", () => {
    expect(
      EvaluatorSpecDefinitionSchema.safeParse({
        ...evaluatorDefinition(),
        predecessor: { ...evaluatorReference, evaluatorVersionId: "evv_schema_v0" },
      }).success,
    ).toBe(true);
    expect(
      EvaluatorSpecDefinitionSchema.safeParse({
        ...evaluatorDefinition(),
        predecessor: evaluatorReference,
      }).success,
    ).toBe(false);
    expect(
      EvaluatorSpecDefinitionSchema.safeParse({
        ...evaluatorDefinition(),
        predecessor: { ...evaluatorReference, evaluatorId: "evl_other" },
      }).success,
    ).toBe(false);
  });
});

describe("qualification fixture contracts", () => {
  it("requires all positive, negative, boundary, not-applicable, and failure classes", () => {
    const record = qualificationFixtureSet();
    const {
      definitionSha256: _digest,
      publishedAt: _at,
      publishedByPrincipalId: _by,
      schemaVersion: _version,
      scope: _scope,
      ...definition
    } = record;
    expect(QualificationFixtureSetDefinitionSchema.parse(definition)).toEqual(definition);
    expect(QualificationFixtureSetSchema.parse(record)).toEqual(record);
  });

  it.each([
    ["positive", "fail"],
    ["negative", "pass"],
    ["not_applicable", "pass"],
    ["timeout", "pass"],
    ["budget", "pass"],
    ["abstention", "error"],
  ] as const)("rejects %s case with %s outcome", (caseKind, expectedOutcome) => {
    expect(
      QualificationCaseSchema.safeParse({
        caseId: `case_${caseKind}`,
        caseKind,
        criterion: criterionSelector,
        expectedOutcome,
        fixture: {
          definitionSha256: sha("1"),
          fixtureId: `fix_${caseKind}`,
          fixtureVersionId: `fxv_${caseKind}`,
        },
      }).success,
    ).toBe(false);
  });

  it("rejects missing classes, unordered identities, and reused fixtures", () => {
    const missing = qualificationFixtureSet();
    missing.cases = missing.cases.filter(({ caseKind }) => caseKind !== "timeout");
    expect(QualificationFixtureSetSchema.safeParse(missing).success).toBe(false);

    const unordered = qualificationFixtureSet();
    unordered.cases.reverse();
    expect(QualificationFixtureSetSchema.safeParse(unordered).success).toBe(false);

    const reused = qualificationFixtureSet();
    const first = reused.cases[0];
    const second = reused.cases[1];
    if (!first || !second) throw new Error("Expected qualification cases");
    reused.cases[1] = { ...second, fixture: first.fixture };
    expect(QualificationFixtureSetSchema.safeParse(reused).success).toBe(false);
  });

  it("requires same-logical non-self predecessor lineage", () => {
    const record = qualificationFixtureSet();
    record.predecessor = {
      ...fixtureSetReference,
      fixtureSetVersionId: "qfv_schema_v0",
    };
    expect(QualificationFixtureSetSchema.safeParse(record).success).toBe(true);
    record.predecessor = fixtureSetReference;
    expect(QualificationFixtureSetSchema.safeParse(record).success).toBe(false);
    record.predecessor = { ...fixtureSetReference, fixtureSetId: "qfs_other" };
    expect(QualificationFixtureSetSchema.safeParse(record).success).toBe(false);
  });
});

describe("qualification report contracts", () => {
  it("separates immutable report meaning from server-owned recording metadata", () => {
    const report = qualificationReport();
    const definition = structuredClone(report) as Record<string, unknown>;
    for (const key of [
      "definitionSha256",
      "executedByPrincipalId",
      "recordedAt",
      "schemaVersion",
      "scope",
    ]) {
      delete definition[key];
    }

    expect(QualificationReportDefinitionSchema.parse(definition)).toEqual(definition);
    expect(QualificationReportDefinitionSchema.safeParse(report).success).toBe(false);
  });

  it("binds every exact case result, raw observation, environment, policy, and validity window", () => {
    const report = qualificationReport();
    expect(QualificationReportSchema.parse(report)).toEqual(report);

    const oracleReport = {
      ...report,
      subject: { kind: "oracle" as const, oracle: oracleReference },
    };
    expect(QualificationReportSchema.safeParse(oracleReport).success).toBe(true);
  });

  it("preserves an unqualified error instead of hiding it", () => {
    const report = qualificationReport();
    const positiveIndex = report.caseResults.findIndex(({ caseKind }) => caseKind === "positive");
    const positive = report.caseResults[positiveIndex];
    if (!positive) throw new Error("Expected the positive qualification result");
    report.caseResults[positiveIndex] = {
      ...positive,
      actualOutcome: "error",
      matched: false,
    };
    report.status = "unqualified";
    report.summary = {
      matchedCount: 8,
      mismatchedCount: 1,
      totalCount: 9,
      unexpectedErrorCount: 1,
    };
    expect(QualificationReportSchema.safeParse(report).success).toBe(true);
    report.status = "qualified";
    expect(QualificationReportSchema.safeParse(report).success).toBe(false);
  });

  it("rejects forged matched flags and summaries", () => {
    const forgedMatch = qualificationReport();
    const first = forgedMatch.caseResults[0];
    if (!first) throw new Error("Expected qualification results");
    forgedMatch.caseResults[0] = { ...first, matched: false };
    expect(QualificationReportSchema.safeParse(forgedMatch).success).toBe(false);

    const forgedSummary = qualificationReport();
    forgedSummary.summary.matchedCount = 8;
    forgedSummary.summary.mismatchedCount = 1;
    expect(QualificationReportSchema.safeParse(forgedSummary).success).toBe(false);

    const inconsistentTotal = qualificationReport();
    inconsistentTotal.summary.matchedCount = 8;
    expect(QualificationReportSchema.safeParse(inconsistentTotal).success).toBe(false);

    const impossibleErrors = qualificationReport();
    impossibleErrors.summary.unexpectedErrorCount = 1;
    expect(QualificationReportSchema.safeParse(impossibleErrors).success).toBe(false);
  });

  it("rejects missing classes, unordered cases, duplicate evidence, and invalid time", () => {
    const missing = qualificationReport();
    missing.caseResults = missing.caseResults.filter(({ caseKind }) => caseKind !== "timeout");
    missing.summary = {
      matchedCount: 8,
      mismatchedCount: 0,
      totalCount: 8,
      unexpectedErrorCount: 0,
    };
    expect(QualificationReportSchema.safeParse(missing).success).toBe(false);

    const unordered = qualificationReport();
    unordered.caseResults.reverse();
    expect(QualificationReportSchema.safeParse(unordered).success).toBe(false);

    const duplicateEvidence = qualificationReport();
    duplicateEvidence.environmentEvidence.push(duplicateEvidence.environmentEvidence[0] as never);
    expect(QualificationReportSchema.safeParse(duplicateEvidence).success).toBe(false);

    expect(
      QualificationReportSchema.safeParse({
        ...qualificationReport(),
        completedAt: "2026-08-31T23:59:59Z",
      }).success,
    ).toBe(false);
    expect(
      QualificationReportSchema.safeParse({
        ...qualificationReport(),
        validFrom: "2026-09-01T00:00:59Z",
      }).success,
    ).toBe(false);
    expect(
      QualificationReportSchema.safeParse({
        ...qualificationReport(),
        validUntil: "2026-09-01T00:01:00Z",
      }).success,
    ).toBe(false);
  });
});
