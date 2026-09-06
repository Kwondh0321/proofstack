import type {
  CriterionSet,
  CriterionSetStatusRecord,
  EvaluationRecordKind,
  EvaluatorSpec,
  OracleSpec,
  QualificationFixtureSet,
  QualificationReport,
  SourceReviewRecord,
  SourceReviewerQualification,
  SourceSnapshot,
} from "@proofstack/contracts";
import { CriterionSetDefinitionSchema } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { createEvaluationRepositoryTestHarness } from "../testing/evaluation-repository-fixtures.js";
import {
  type CriteriaTrustArtifactAvailability,
  type EvaluateCriteriaTrustInput,
  evaluateCriteriaTrust,
  InvalidCriteriaTrustInputError,
  sourceScopeCovers,
} from "./criteria-trust.js";
import { digestEvaluationRecordDefinition } from "./evaluation-record-validation.js";

type RecordByKind = {
  criterion_set: CriterionSet;
  criterion_set_status: CriterionSetStatusRecord;
  evaluator_spec: EvaluatorSpec;
  oracle_spec: OracleSpec;
  qualification_fixture_set: QualificationFixtureSet;
  qualification_report: QualificationReport;
  source_review: SourceReviewRecord;
  source_reviewer_qualification: SourceReviewerQualification;
  source_snapshot: SourceSnapshot;
};

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

type MutableCriteriaTrustInput = Mutable<EvaluateCriteriaTrustInput>;

const receiptKeys: Readonly<Record<keyof RecordByKind, readonly string[]>> = {
  criterion_set: [
    "definitionSha256",
    "publishedAt",
    "publishedByPrincipalId",
    "schemaVersion",
    "scope",
  ],
  criterion_set_status: [
    "definitionSha256",
    "recordedAt",
    "recordedByPrincipalId",
    "schemaVersion",
    "scope",
  ],
  evaluator_spec: [
    "definitionSha256",
    "publishedAt",
    "publishedByPrincipalId",
    "schemaVersion",
    "scope",
  ],
  oracle_spec: [
    "definitionSha256",
    "publishedAt",
    "publishedByPrincipalId",
    "schemaVersion",
    "scope",
  ],
  qualification_fixture_set: [
    "definitionSha256",
    "publishedAt",
    "publishedByPrincipalId",
    "schemaVersion",
    "scope",
  ],
  qualification_report: [
    "definitionSha256",
    "executedByPrincipalId",
    "recordedAt",
    "schemaVersion",
    "scope",
  ],
  source_review: [
    "definitionSha256",
    "reviewedAt",
    "reviewedByPrincipalId",
    "reviewerRole",
    "schemaVersion",
    "scope",
  ],
  source_reviewer_qualification: [
    "definitionSha256",
    "recordedAt",
    "schemaVersion",
    "scope",
    "verifiedByPrincipalId",
  ],
  source_snapshot: [
    "definitionSha256",
    "publishedByPrincipalId",
    "recordedAt",
    "schemaVersion",
    "scope",
  ],
};

function record<K extends keyof RecordByKind>(
  records: readonly { readonly kind: string; readonly record: unknown }[],
  kind: K,
  predicate?: (value: RecordByKind[K]) => boolean,
): RecordByKind[K] {
  const match = records.find(
    (value) => value.kind === kind && (!predicate || predicate(value.record as RecordByKind[K])),
  );
  if (!match) throw new Error(`Expected ${kind} fixture`);
  return structuredClone(match.record) as RecordByKind[K];
}

function redigest<K extends keyof RecordByKind>(kind: K, value: RecordByKind[K]): void {
  const definition = structuredClone(value) as unknown as Record<string, unknown>;
  for (const key of receiptKeys[kind]) delete definition[key];
  (value as unknown as { definitionSha256: string }).definitionSha256 =
    digestEvaluationRecordDefinition(kind as EvaluationRecordKind, value.scope, definition);
}

function availableArtifacts(input: {
  readonly reports: readonly QualificationReport[];
  readonly review: SourceReviewRecord;
  readonly reviewerQualifications: readonly SourceReviewerQualification[];
  readonly source: SourceSnapshot;
}): CriteriaTrustArtifactAvailability[] {
  const references = [
    input.source.content,
    ...(input.source.identityVerification.status === "verified"
      ? input.source.identityVerification.evidence
      : []),
    ...input.review.reviewBasis,
    ...input.reviewerQualifications.flatMap(({ credentialEvidence }) => credentialEvidence),
    ...input.reports.flatMap((report) => [
      ...report.environmentEvidence,
      ...report.caseResults.flatMap(({ rawEvidence }) => rawEvidence),
    ]),
  ];
  return [
    ...new Map(
      references.map((artifact) => [
        `${artifact.artifactId}:${artifact.sha256}`,
        { artifactId: artifact.artifactId, sha256: artifact.sha256, state: "available" as const },
      ]),
    ).values(),
  ];
}

function fixture(): EvaluateCriteriaTrustInput {
  const records = createEvaluationRepositoryTestHarness("criteria_trust").records;
  const criterionSet = record(records, "criterion_set");
  criterionSet.publishedByPrincipalId = "usr_criterion_author";
  const criterionStatus = record(
    records,
    "criterion_set_status",
    (value) => value.status === "approved",
  );
  const source = record(records, "source_snapshot");
  const reviewerQualification = record(records, "source_reviewer_qualification");
  reviewerQualification.reviewerPrincipalId = "usr_source_reviewer";
  redigest("source_reviewer_qualification", reviewerQualification);
  const review = record(records, "source_review");
  review.reviewedByPrincipalId = "usr_source_reviewer";
  review.reviewerQualification = {
    definitionSha256: reviewerQualification.definitionSha256,
    qualificationId: reviewerQualification.qualificationId,
  };
  review.declaredRelationships = [];
  redigest("source_review", review);
  const sourceReference = criterionSet.sources[0];
  if (!sourceReference) throw new Error("Expected criterion source reference");
  sourceReference.review.definitionSha256 = review.definitionSha256;
  redigest("criterion_set", criterionSet);
  criterionStatus.criterionSet.definitionSha256 = criterionSet.definitionSha256;
  redigest("criterion_set_status", criterionStatus);
  const fixtureSet = record(records, "qualification_fixture_set");
  const evaluator = record(records, "evaluator_spec");
  evaluator.publishedByPrincipalId = "usr_evaluator_author";
  const oracle = record(records, "oracle_spec");
  oracle.publishedByPrincipalId = "usr_oracle_author";
  const evaluatorReport = record(
    records,
    "qualification_report",
    (value) => value.subject.kind === "evaluator",
  );
  evaluatorReport.executedByPrincipalId = "wrk_evaluator_qualifier";
  const oracleReport = record(
    records,
    "qualification_report",
    (value) => value.subject.kind === "oracle",
  );
  oracleReport.executedByPrincipalId = "wrk_oracle_qualifier";
  const reports = [evaluatorReport, oracleReport];
  const artifacts = availableArtifacts({
    reports,
    review,
    reviewerQualifications: [reviewerQualification],
    source,
  });

  return {
    artifacts,
    at: "2026-09-02T00:01:00.000Z",
    criterionSet,
    criterionStatus,
    qualifications: [
      { fixtureSet, report: evaluatorReport, subject: evaluator },
      { fixtureSet, report: oracleReport, subject: oracle },
    ],
    request: {
      context: {
        environmentId: "env_local",
        jurisdiction: "kr",
        locale: "ko-kr",
        populationTags: ["adult users"],
        riskTier: "high",
        taskKind: "task_support",
      },
      requesterPrincipalId: "usr_task_requester",
      scope: structuredClone(criterionSet.scope),
    },
    reviewerQualifications: [reviewerQualification],
    sources: [{ review, source }],
  };
}

function replaceReview(
  input: EvaluateCriteriaTrustInput,
  mutate: (review: SourceReviewRecord) => void,
) {
  const value = structuredClone(input) as MutableCriteriaTrustInput & {
    criterionStatus: CriterionSetStatusRecord;
    sources: { review: SourceReviewRecord; source: SourceSnapshot }[];
  };
  const review = value.sources[0]?.review;
  const sourceReference = value.criterionSet.sources[0];
  if (!review || !sourceReference) throw new Error("Expected exact source review");
  mutate(review);
  redigest("source_review", review);
  sourceReference.review.definitionSha256 = review.definitionSha256;
  redigest("criterion_set", value.criterionSet);
  value.criterionStatus.criterionSet.definitionSha256 = value.criterionSet.definitionSha256;
  redigest("criterion_set_status", value.criterionStatus);
  return value;
}

function replaceSource(
  input: EvaluateCriteriaTrustInput,
  mutate: (source: SourceSnapshot) => void,
) {
  const value = structuredClone(input) as MutableCriteriaTrustInput & {
    criterionStatus: CriterionSetStatusRecord;
    sources: { review: SourceReviewRecord; source: SourceSnapshot }[];
  };
  const evidence = value.sources[0];
  const sourceReference = value.criterionSet.sources[0];
  if (!evidence || !sourceReference) throw new Error("Expected exact source evidence");
  mutate(evidence.source);
  redigest("source_snapshot", evidence.source);
  evidence.review.source.definitionSha256 = evidence.source.definitionSha256;
  redigest("source_review", evidence.review);
  sourceReference.source.definitionSha256 = evidence.source.definitionSha256;
  sourceReference.review.definitionSha256 = evidence.review.definitionSha256;
  redigest("criterion_set", value.criterionSet);
  value.criterionStatus.criterionSet.definitionSha256 = value.criterionSet.definitionSha256;
  redigest("criterion_set_status", value.criterionStatus);
  return value;
}

function replaceReviewerQualification(
  input: EvaluateCriteriaTrustInput,
  mutate: (qualification: SourceReviewerQualification) => void,
) {
  const value = structuredClone(input) as MutableCriteriaTrustInput & {
    criterionStatus: CriterionSetStatusRecord;
    reviewerQualifications: SourceReviewerQualification[];
    sources: { review: SourceReviewRecord; source: SourceSnapshot }[];
  };
  const qualification = value.reviewerQualifications[0];
  const review = value.sources[0]?.review;
  const sourceReference = value.criterionSet.sources[0];
  if (!qualification || !review || !sourceReference) {
    throw new Error("Expected exact reviewer qualification");
  }
  mutate(qualification);
  redigest("source_reviewer_qualification", qualification);
  review.reviewerQualification = {
    definitionSha256: qualification.definitionSha256,
    qualificationId: qualification.qualificationId,
  };
  redigest("source_review", review);
  sourceReference.review.definitionSha256 = review.definitionSha256;
  redigest("criterion_set", value.criterionSet);
  value.criterionStatus.criterionSet.definitionSha256 = value.criterionSet.definitionSha256;
  redigest("criterion_set_status", value.criterionStatus);
  return value;
}

describe("evaluateCriteriaTrust", () => {
  it("accepts only a complete, current, independently reviewed exact evidence graph", () => {
    const input = fixture();
    const original = structuredClone(input);

    expect(evaluateCriteriaTrust(input)).toEqual({
      evaluatedAt: input.at,
      reasons: [],
      status: "eligible",
    });
    expect(input).toEqual(original);
  });

  it.each([
    [
      "requester-authored review",
      (input: MutableCriteriaTrustInput) => {
        const review = input.sources[0]?.review;
        if (!review) throw new Error("Expected source review");
        input.request.requesterPrincipalId = review.reviewedByPrincipalId;
      },
      "requester_only_review",
      "require_approval",
    ],
    [
      "missing retained source",
      (input: MutableCriteriaTrustInput) => {
        input.sources = input.sources.map((value) => ({ ...value, source: null }));
      },
      "source_snapshot_unavailable",
      "unverifiable",
    ],
    [
      "missing retained source review",
      (input: MutableCriteriaTrustInput) => {
        input.sources = input.sources.map((value) => ({ ...value, review: null }));
      },
      "source_review_unavailable",
      "unverifiable",
    ],
    [
      "missing criterion status",
      (input: MutableCriteriaTrustInput) => {
        input.criterionStatus = null;
      },
      "criterion_status_unavailable",
      "unverifiable",
    ],
    [
      "unavailable retained bytes",
      (input: MutableCriteriaTrustInput) => {
        const source = input.sources[0]?.source;
        if (!source) throw new Error("Expected source snapshot");
        input.artifacts = input.artifacts.map((value) =>
          value.artifactId === source.content.artifactId && value.sha256 === source.content.sha256
            ? { ...value, state: "unavailable" }
            : value,
        );
      },
      "source_content_unavailable",
      "unverifiable",
    ],
    [
      "scope-mismatched request",
      (input: MutableCriteriaTrustInput) => {
        input.request.context.locale = "fr";
      },
      "source_scope_mismatch",
      "ineligible",
    ],
    [
      "unqualified reviewer",
      (input: MutableCriteriaTrustInput) => {
        input.reviewerQualifications = input.reviewerQualifications.map((value) => ({
          ...value,
          status: "unqualified",
          statusReasons: ["Required credentials were not demonstrated"],
        }));
      },
      "reviewer_unqualified",
      "ineligible",
    ],
    [
      "disclosed reviewer relationship",
      (input: MutableCriteriaTrustInput) => {
        return replaceReview(input, (review) => {
          review.declaredRelationships = ["member of criterion issuer"];
        });
      },
      "source_review_relationship_disclosed",
      "require_approval",
    ],
    [
      "missing evaluator qualification",
      (input: MutableCriteriaTrustInput) => {
        input.qualifications = input.qualifications.filter(
          ({ report }) => report?.subject.kind !== "evaluator",
        );
      },
      "qualification_report_unavailable",
      "unverifiable",
    ],
  ] as const)("fails closed for %s", (_name, mutate, reason, status) => {
    const input = structuredClone(fixture()) as MutableCriteriaTrustInput;
    const mutated = mutate(input) ?? input;
    const result = evaluateCriteriaTrust(mutated);
    expect(result.status).toBe(status);
    expect(result.reasons).toContain(reason);
  });

  it("distinguishes stale and conflicted authority", () => {
    const stale = replaceReview(fixture(), (review) => {
      review.freshnessConclusion = "expired";
      review.outcome = "unverifiable";
    });
    expect(evaluateCriteriaTrust(stale)).toMatchObject({
      reasons: expect.arrayContaining(["source_review_not_current", "source_review_unverifiable"]),
      status: "ineligible",
    });

    const conflicted = replaceReview(fixture(), (review) => {
      review.criticalConflictStatus = "unresolved";
      review.outcome = "require_approval";
      review.reviewedConflicts = [
        { definitionSha256: "c".repeat(64), sourceSnapshotId: "src_conflict" },
      ];
    });
    expect(evaluateCriteriaTrust(conflicted)).toMatchObject({
      reasons: expect.arrayContaining([
        "source_conflict_unresolved",
        "source_review_requires_approval",
      ]),
      status: "ineligible",
    });
  });

  it.each([
    [
      "wrong exact qualification digest",
      (input: EvaluateCriteriaTrustInput) =>
        replaceReview(input, (review) => {
          if (!review.reviewerQualification) throw new Error("Expected qualification reference");
          review.reviewerQualification.definitionSha256 = "f".repeat(64);
        }),
      "reviewer_qualification_reference_mismatch",
      "ineligible",
    ],
    [
      "different reviewer principal",
      (input: EvaluateCriteriaTrustInput) =>
        replaceReviewerQualification(input, (qualification) => {
          qualification.reviewerPrincipalId = "usr_other_reviewer";
        }),
      "reviewer_qualification_reference_mismatch",
      "ineligible",
    ],
    [
      "narrower qualification scope",
      (input: EvaluateCriteriaTrustInput) =>
        replaceReviewerQualification(input, (qualification) => {
          qualification.applicabilityScope.locales = { mode: "include", values: ["en"] };
        }),
      "reviewer_qualification_scope_mismatch",
      "ineligible",
    ],
    [
      "unsupported source kind",
      (input: EvaluateCriteriaTrustInput) =>
        replaceReviewerQualification(input, (qualification) => {
          qualification.sourceKinds = ["law_or_regulation"];
        }),
      "reviewer_qualification_source_kind_mismatch",
      "ineligible",
    ],
    [
      "unverifiable qualification",
      (input: EvaluateCriteriaTrustInput) =>
        replaceReviewerQualification(input, (qualification) => {
          qualification.status = "unverifiable";
          qualification.statusReasons = ["Credential issuer could not be reached"];
        }),
      "reviewer_qualification_unverifiable",
      "unverifiable",
    ],
    [
      "expired qualification",
      (input: EvaluateCriteriaTrustInput) =>
        replaceReviewerQualification(input, (qualification) => {
          qualification.validUntil = "2026-09-02T00:00:00.000Z";
        }),
      "reviewer_qualification_not_current",
      "unverifiable",
    ],
  ] as const)("fails closed for %s", (_name, mutate, reason, status) => {
    expect(evaluateCriteriaTrust(mutate(fixture()))).toMatchObject({
      reasons: expect.arrayContaining([reason]),
      status,
    });
  });

  it("requires every retained reviewer credential artifact", () => {
    const input = structuredClone(fixture()) as MutableCriteriaTrustInput;
    const credential = input.reviewerQualifications[0]?.credentialEvidence[0];
    if (!credential) throw new Error("Expected reviewer credential evidence");
    input.artifacts = input.artifacts.map((value) =>
      value.artifactId === credential.artifactId && value.sha256 === credential.sha256
        ? { ...value, state: "unavailable" }
        : value,
    );

    expect(evaluateCriteriaTrust(input)).toMatchObject({
      reasons: expect.arrayContaining(["reviewer_qualification_evidence_unavailable"]),
      status: "unverifiable",
    });
  });

  it("rejects self-attested source identity and qualification fixtures", () => {
    const identity = structuredClone(fixture()) as MutableCriteriaTrustInput;
    const source = identity.sources[0]?.source;
    if (source?.identityVerification.status !== "verified") {
      throw new Error("Expected verified source identity");
    }
    source.publishedByPrincipalId = source.identityVerification.verifierPrincipalId;
    expect(evaluateCriteriaTrust(identity)).toMatchObject({
      reasons: expect.arrayContaining(["source_identity_not_independent"]),
      status: "ineligible",
    });

    const qualification = structuredClone(fixture()) as MutableCriteriaTrustInput;
    const evidence = qualification.qualifications[0];
    if (!evidence?.fixtureSet || !evidence.subject) {
      throw new Error("Expected qualification evidence");
    }
    evidence.fixtureSet.publishedByPrincipalId = evidence.subject.publishedByPrincipalId;
    expect(evaluateCriteriaTrust(qualification)).toMatchObject({
      reasons: expect.arrayContaining(["qualification_fixture_not_independent"]),
      status: "ineligible",
    });
  });

  it("rejects records that claim evidence from the future", () => {
    const identity = replaceSource(fixture(), (source) => {
      if (source.identityVerification.status !== "verified") {
        throw new Error("Expected verified source identity");
      }
      source.identityVerification.verifiedAt = "2026-09-03T00:00:00.000Z";
    });
    expect(evaluateCriteriaTrust(identity)).toMatchObject({
      reasons: expect.arrayContaining(["source_identity_not_current"]),
      status: "ineligible",
    });

    const receipts = structuredClone(fixture()) as MutableCriteriaTrustInput & {
      criterionStatus: CriterionSetStatusRecord;
    };
    receipts.criterionStatus.recordedAt = "2026-09-03T00:00:00.000Z";
    const source = receipts.sources[0]?.source;
    const review = receipts.sources[0]?.review;
    const report = receipts.qualifications[0]?.report;
    if (!source || !review || !report) throw new Error("Expected complete evidence graph");
    source.recordedAt = "2026-09-03T00:00:00.000Z";
    review.reviewedAt = "2026-09-03T00:00:00.000Z";
    report.recordedAt = "2026-09-03T00:00:00.000Z";
    expect(evaluateCriteriaTrust(receipts)).toMatchObject({
      reasons: expect.arrayContaining([
        "criterion_status_not_current",
        "qualification_not_current",
        "source_not_effective",
        "source_review_not_current",
      ]),
      status: "ineligible",
    });
  });

  it("binds every qualification result to its predeclared exact case", () => {
    const input = structuredClone(fixture()) as MutableCriteriaTrustInput;
    const report = input.qualifications[0]?.report;
    const first = report?.caseResults[0];
    if (!report || !first) throw new Error("Expected qualification case result");
    first.expectedOutcome = first.expectedOutcome === "pass" ? "fail" : "pass";
    first.actualOutcome = first.expectedOutcome;
    redigest("qualification_report", report);

    expect(evaluateCriteriaTrust(input)).toMatchObject({
      reasons: expect.arrayContaining(["qualification_fixture_mismatch"]),
      status: "ineligible",
    });
  });

  it("distinguishes an empirically unqualified evaluator", () => {
    const input = structuredClone(fixture()) as MutableCriteriaTrustInput;
    const evidence = input.qualifications.find(
      ({ report }) => report?.subject.kind === "evaluator",
    );
    if (!evidence?.report) throw new Error("Expected evaluator qualification report");
    const first = evidence.report.caseResults[0];
    if (!first) throw new Error("Expected qualification case result");
    first.actualOutcome = first.expectedOutcome === "pass" ? "fail" : "pass";
    first.matched = false;
    evidence.report.status = "unqualified";
    evidence.report.summary.matchedCount -= 1;
    evidence.report.summary.mismatchedCount += 1;
    redigest("qualification_report", evidence.report);

    expect(evaluateCriteriaTrust(input)).toMatchObject({
      reasons: expect.arrayContaining(["qualification_unqualified"]),
      status: "ineligible",
    });
  });

  it("rejects search-only criteria before they can enter the trust graph", () => {
    const definition = structuredClone(fixture().criterionSet) as unknown as Record<
      string,
      unknown
    >;
    for (const key of receiptKeys.criterion_set) delete definition[key];
    Object.assign(definition, {
      discovery: { discoveryId: "dsc_search_only" },
      sources: [],
    });
    expect(CriterionSetDefinitionSchema.safeParse(definition).success).toBe(false);
  });

  it("rejects contradictory availability and cross-scope requests", () => {
    const contradiction = structuredClone(fixture()) as MutableCriteriaTrustInput;
    const first = contradiction.artifacts[0];
    if (!first) throw new Error("Expected artifact availability");
    contradiction.artifacts = [...contradiction.artifacts, { ...first, state: "unavailable" }];
    expect(() => evaluateCriteriaTrust(contradiction)).toThrow(InvalidCriteriaTrustInputError);

    const crossScope = structuredClone(fixture()) as MutableCriteriaTrustInput;
    crossScope.request.scope.projectId = "prj_other";
    expect(() => evaluateCriteriaTrust(crossScope)).toThrow(InvalidCriteriaTrustInputError);
  });

  it.each([
    [
      "source snapshot",
      (input: MutableCriteriaTrustInput) => {
        const first = input.sources[0];
        if (!first) throw new Error("Expected source evidence");
        input.sources = [...input.sources, structuredClone(first)];
      },
    ],
    [
      "qualification report",
      (input: MutableCriteriaTrustInput) => {
        const first = input.qualifications[0];
        if (!first) throw new Error("Expected qualification evidence");
        input.qualifications = [...input.qualifications, structuredClone(first)];
      },
    ],
    [
      "reviewer qualification",
      (input: MutableCriteriaTrustInput) => {
        const first = input.reviewerQualifications[0];
        if (!first) throw new Error("Expected reviewer qualification");
        input.reviewerQualifications = [...input.reviewerQualifications, structuredClone(first)];
      },
    ],
  ] as const)("rejects duplicate exact %s inputs", (_name, mutate) => {
    const input = structuredClone(fixture()) as MutableCriteriaTrustInput;
    mutate(input);
    expect(() => evaluateCriteriaTrust(input)).toThrow(InvalidCriteriaTrustInputError);
  });

  it("rejects malformed root, artifact, and reviewer evidence", () => {
    const root = structuredClone(fixture()) as MutableCriteriaTrustInput;
    root.at = "tomorrow";
    expect(() => evaluateCriteriaTrust(root)).toThrow(InvalidCriteriaTrustInputError);

    const artifact = structuredClone(fixture()) as MutableCriteriaTrustInput;
    const firstArtifact = artifact.artifacts[0];
    if (!firstArtifact) throw new Error("Expected artifact availability");
    firstArtifact.sha256 = "not-a-digest";
    expect(() => evaluateCriteriaTrust(artifact)).toThrow(InvalidCriteriaTrustInputError);

    const reviewer = structuredClone(fixture()) as MutableCriteriaTrustInput;
    const qualification = reviewer.reviewerQualifications[0];
    if (!qualification) throw new Error("Expected reviewer qualification");
    qualification.credentialEvidence = [];
    expect(() => evaluateCriteriaTrust(reviewer)).toThrow(InvalidCriteriaTrustInputError);
  });
});

describe("sourceScopeCovers", () => {
  it("allows wider authority while preserving every inherited exclusion", () => {
    const child = fixture().criterionSet.applicabilityScope;
    const wider = structuredClone(child);
    wider.environments = { mode: "any" };
    wider.locales = { mode: "any" };
    wider.exclusions = ["Excluded deployment"];
    const contained = structuredClone(child);
    contained.exclusions = ["Excluded deployment", "Unsupported preview"];

    expect(sourceScopeCovers(wider, contained)).toBe(true);
    expect(sourceScopeCovers(contained, wider)).toBe(false);
  });
});
