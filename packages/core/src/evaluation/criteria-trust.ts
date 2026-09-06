import type {
  ApplicabilityContext,
  CriterionSet,
  CriterionSetStatusRecord,
  EvaluatorSpec,
  EvidenceScope,
  OracleSpec,
  QualificationFixtureSet,
  QualificationReport,
  SourceApplicabilityScope,
  SourceReviewRecord,
  SourceReviewerQualification,
  SourceSnapshot,
} from "@proofstack/contracts";
import {
  ApplicabilityContextSchema,
  CriterionSetSchema,
  CriterionSetStatusRecordSchema,
  EvaluatorSpecSchema,
  EvidenceScopeSchema,
  evidenceTimestampOrderKey,
  OpaqueIdSchema,
  OracleSpecSchema,
  QualificationFixtureSetSchema,
  QualificationReportSchema,
  SourceReviewRecordSchema,
  SourceReviewerQualificationSchema,
  SourceSnapshotSchema,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";

export const CRITERIA_TRUST_REASONS = [
  "criterion_not_approved",
  "criterion_status_not_current",
  "criterion_status_unavailable",
  "qualification_evidence_unavailable",
  "qualification_fixture_not_independent",
  "qualification_fixture_mismatch",
  "qualification_fixture_set_unavailable",
  "qualification_not_current",
  "qualification_not_independent",
  "qualification_reference_mismatch",
  "qualification_report_unavailable",
  "qualification_unqualified",
  "requester_only_review",
  "reviewer_qualification_evidence_unavailable",
  "reviewer_qualification_not_independent",
  "reviewer_qualification_not_current",
  "reviewer_qualification_reference_mismatch",
  "reviewer_qualification_scope_mismatch",
  "reviewer_qualification_source_kind_mismatch",
  "reviewer_qualification_unavailable",
  "reviewer_qualification_unverifiable",
  "reviewer_unqualified",
  "source_applicability_not_approved",
  "source_authority_not_accepted",
  "source_conflict_review_incomplete",
  "source_conflict_unresolved",
  "source_content_unavailable",
  "source_identity_disputed",
  "source_identity_evidence_unavailable",
  "source_identity_not_current",
  "source_identity_not_independent",
  "source_identity_unverified",
  "source_license_unusable",
  "source_not_current",
  "source_not_effective",
  "source_reference_mismatch",
  "source_review_basis_unavailable",
  "source_review_not_current",
  "source_review_relationship_disclosed",
  "source_review_requires_approval",
  "source_review_unavailable",
  "source_review_unverifiable",
  "source_scope_mismatch",
  "source_snapshot_unavailable",
] as const;

export type CriteriaTrustReason = (typeof CRITERIA_TRUST_REASONS)[number];
export type CriteriaTrustStatus = "eligible" | "ineligible" | "require_approval" | "unverifiable";

export interface CriteriaTrustArtifactAvailability {
  readonly artifactId: string;
  readonly sha256: string;
  readonly state: "available" | "unavailable";
}

export interface CriteriaTrustSourceEvidence {
  readonly review: SourceReviewRecord | null;
  readonly source: SourceSnapshot | null;
}

export interface CriteriaTrustQualificationEvidence {
  readonly fixtureSet: QualificationFixtureSet | null;
  readonly report: QualificationReport | null;
  readonly subject: EvaluatorSpec | OracleSpec | null;
}

export interface CriteriaTrustArtifactReference {
  readonly artifactId: string;
  readonly sha256: string;
}

export interface EvaluateCriteriaTrustInput {
  readonly artifacts: readonly CriteriaTrustArtifactAvailability[];
  readonly at: string;
  readonly criterionSet: CriterionSet;
  readonly criterionStatus: CriterionSetStatusRecord | null;
  readonly qualifications: readonly CriteriaTrustQualificationEvidence[];
  readonly request: {
    readonly context: ApplicabilityContext;
    readonly requesterPrincipalId: string;
    readonly scope: EvidenceScope;
  };
  /** Exact, repository-resolved qualification records; requester assertions are not accepted. */
  readonly reviewerQualifications: readonly SourceReviewerQualification[];
  readonly sources: readonly CriteriaTrustSourceEvidence[];
}

export interface CriteriaTrustEvaluation {
  readonly evaluatedAt: string;
  readonly reasons: readonly CriteriaTrustReason[];
  readonly status: CriteriaTrustStatus;
}

export class InvalidCriteriaTrustInputError extends TypeError {
  readonly code = "criteria_trust_input_invalid";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidCriteriaTrustInputError";
  }
}

type Selector =
  | { readonly mode: "any" }
  | { readonly mode: "include"; readonly values: readonly string[] };

const UNVERIFIABLE_REASONS = new Set<CriteriaTrustReason>([
  "criterion_status_unavailable",
  "qualification_evidence_unavailable",
  "qualification_fixture_set_unavailable",
  "qualification_report_unavailable",
  "reviewer_qualification_evidence_unavailable",
  "reviewer_qualification_not_current",
  "reviewer_qualification_unavailable",
  "reviewer_qualification_unverifiable",
  "source_content_unavailable",
  "source_identity_evidence_unavailable",
  "source_reference_mismatch",
  "source_review_basis_unavailable",
  "source_review_unverifiable",
  "source_review_unavailable",
  "source_snapshot_unavailable",
]);

const REQUIRE_APPROVAL_REASONS = new Set<CriteriaTrustReason>([
  "requester_only_review",
  "source_review_relationship_disclosed",
  "source_review_requires_approval",
]);

function invalid(message: string, cause?: unknown): InvalidCriteriaTrustInputError {
  return new InvalidCriteriaTrustInputError(message, cause === undefined ? undefined : { cause });
}

function assertUniqueBy<T>(
  values: readonly T[],
  keyFor: (value: T) => string,
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = keyFor(value);
    if (seen.has(key)) throw invalid(`Criteria-trust ${label} must be unique`);
    seen.add(key);
  }
}

function exactReference(
  reference: { readonly definitionSha256: string },
  record: { readonly definitionSha256: string },
): boolean {
  return reference.definitionSha256 === record.definitionSha256;
}

function sameScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function atOrAfter(left: string, right: string): boolean {
  return evidenceTimestampOrderKey(left) >= evidenceTimestampOrderKey(right);
}

function before(left: string, right: string): boolean {
  return evidenceTimestampOrderKey(left) < evidenceTimestampOrderKey(right);
}

function currentAt(at: string, validFrom: string, validUntil: string): boolean {
  return atOrAfter(at, validFrom) && before(at, validUntil);
}

function selectorCovers(parent: Selector, child: Selector): boolean {
  if (parent.mode === "any") return true;
  if (child.mode === "any") return false;
  const allowed = new Set(parent.values);
  return child.values.every((value) => allowed.has(value));
}

/** Returns true only when every child population remains inside the parent authority scope. */
export function sourceScopeCovers(
  parent: SourceApplicabilityScope,
  child: SourceApplicabilityScope,
): boolean {
  return (
    selectorCovers(parent.environments, child.environments) &&
    selectorCovers(parent.jurisdictions, child.jurisdictions) &&
    selectorCovers(parent.locales, child.locales) &&
    selectorCovers(parent.populations, child.populations) &&
    selectorCovers(parent.riskTiers, child.riskTiers) &&
    selectorCovers(parent.taskKinds, child.taskKinds) &&
    parent.exclusions.every((exclusion) => child.exclusions.includes(exclusion))
  );
}

function artifactKey(value: { readonly artifactId: string; readonly sha256: string }): string {
  return `${value.artifactId}:${value.sha256}`;
}

function artifactAvailability(
  input: readonly CriteriaTrustArtifactAvailability[],
): ReadonlyMap<string, "available" | "unavailable"> {
  const values = new Map<string, "available" | "unavailable">();
  for (const item of input) {
    const artifactId = OpaqueIdSchema.safeParse(item.artifactId);
    if (!artifactId.success || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      throw invalid("Criteria-trust artifact availability is invalid");
    }
    const key = artifactKey(item);
    const existing = values.get(key);
    if (existing !== undefined && existing !== item.state) {
      throw invalid("Criteria-trust artifact availability is contradictory");
    }
    values.set(key, item.state);
  }
  return values;
}

function artifactsAvailable(
  references: readonly CriteriaTrustArtifactReference[],
  available: ReadonlyMap<string, "available" | "unavailable">,
): boolean {
  return references.every((reference) => available.get(artifactKey(reference)) === "available");
}

function exactSourceKey(value: {
  readonly definitionSha256: string;
  readonly sourceSnapshotId: string;
}) {
  return `${value.sourceSnapshotId}:${value.definitionSha256}`;
}

function exactReviewKey(value: {
  readonly definitionSha256: string;
  readonly sourceReviewId: string;
}) {
  return `${value.sourceReviewId}:${value.definitionSha256}`;
}

function exactReviewerQualificationKey(value: {
  readonly definitionSha256: string;
  readonly qualificationId: string;
}) {
  return `${value.qualificationId}:${value.definitionSha256}`;
}

function exactQualificationKey(value: {
  readonly definitionSha256: string;
  readonly qualificationReportId: string;
}) {
  return `${value.qualificationReportId}:${value.definitionSha256}`;
}

function parseSources(
  input: readonly CriteriaTrustSourceEvidence[],
): CriteriaTrustSourceEvidence[] {
  const parsed = input.map((value) => {
    try {
      return {
        review: value.review === null ? null : SourceReviewRecordSchema.parse(value.review),
        source: value.source === null ? null : SourceSnapshotSchema.parse(value.source),
      };
    } catch (cause) {
      throw invalid("Criteria-trust source evidence is invalid", cause);
    }
  });
  assertUniqueBy(
    parsed.flatMap(({ source }) => (source ? [source] : [])),
    exactSourceKey,
    "source snapshots",
  );
  assertUniqueBy(
    parsed.flatMap(({ review }) => (review ? [review] : [])),
    exactReviewKey,
    "source reviews",
  );
  return parsed;
}

function parseQualifications(
  input: readonly CriteriaTrustQualificationEvidence[],
): CriteriaTrustQualificationEvidence[] {
  const parsed = input.map((value) => {
    try {
      const subject =
        value.subject === null
          ? null
          : "evaluatorId" in value.subject
            ? EvaluatorSpecSchema.parse(value.subject)
            : OracleSpecSchema.parse(value.subject);
      return {
        fixtureSet:
          value.fixtureSet === null ? null : QualificationFixtureSetSchema.parse(value.fixtureSet),
        report: value.report === null ? null : QualificationReportSchema.parse(value.report),
        subject,
      };
    } catch (cause) {
      throw invalid("Criteria-trust qualification evidence is invalid", cause);
    }
  });
  assertUniqueBy(
    parsed.flatMap(({ report }) => (report ? [report] : [])),
    exactQualificationKey,
    "qualification reports",
  );
  return parsed;
}

function parseReviewerQualifications(
  input: readonly SourceReviewerQualification[],
): SourceReviewerQualification[] {
  const parsed = input.map((value) => {
    try {
      return SourceReviewerQualificationSchema.parse(value);
    } catch (cause) {
      throw invalid("Criteria-trust reviewer qualification is invalid", cause);
    }
  });
  assertUniqueBy(parsed, exactReviewerQualificationKey, "reviewer qualifications");
  return parsed;
}

function contextMatchesScope(
  context: ApplicabilityContext,
  scope: EvidenceScope,
  authority: SourceApplicabilityScope,
): boolean {
  const scalarMatches = (selector: Selector, value: string | undefined): boolean =>
    selector.mode === "any" || (value !== undefined && selector.values.includes(value));
  const populationSelector = authority.populations;
  const populationsMatch =
    populationSelector.mode === "any" ||
    (context.populationTags.length > 0 &&
      context.populationTags.every((value) => populationSelector.values.includes(value)));
  return (
    scalarMatches(authority.environments, context.environmentId ?? scope.environmentId) &&
    scalarMatches(authority.jurisdictions, context.jurisdiction) &&
    scalarMatches(authority.locales, context.locale) &&
    populationsMatch &&
    scalarMatches(authority.riskTiers, context.riskTier) &&
    scalarMatches(authority.taskKinds, context.taskKind)
  );
}

function addSourceReasons(
  reasons: Set<CriteriaTrustReason>,
  criterionSet: CriterionSet,
  request: EvaluateCriteriaTrustInput["request"],
  sourceEvidence: readonly CriteriaTrustSourceEvidence[],
  reviewerQualifications: readonly SourceReviewerQualification[],
  availableArtifacts: ReadonlyMap<string, "available" | "unavailable">,
  at: string,
): void {
  const sources = new Map(
    sourceEvidence
      .filter((value): value is CriteriaTrustSourceEvidence & { source: SourceSnapshot } =>
        Boolean(value.source),
      )
      .map((value) => [exactSourceKey(value.source), value]),
  );
  const reviews = new Map(
    sourceEvidence
      .filter((value): value is CriteriaTrustSourceEvidence & { review: SourceReviewRecord } =>
        Boolean(value.review),
      )
      .map((value) => [exactReviewKey(value.review), value]),
  );
  const reviewerEvidence = new Map(
    reviewerQualifications.map((value) => [exactReviewerQualificationKey(value), value]),
  );
  const reviewerEvidenceById = new Map(
    reviewerQualifications.map((value) => [value.qualificationId, value]),
  );

  for (const expected of criterionSet.sources) {
    const source = sources.get(exactSourceKey(expected.source))?.source ?? null;
    const review = reviews.get(exactReviewKey(expected.review))?.review ?? null;
    if (!source) reasons.add("source_snapshot_unavailable");
    if (!review) reasons.add("source_review_unavailable");
    if (!source || !review) continue;

    if (
      !sameScope(source.scope, criterionSet.scope) ||
      !sameScope(review.scope, criterionSet.scope) ||
      !exactReference(expected.source, source) ||
      !exactReference(expected.review, review) ||
      review.source.sourceSnapshotId !== source.sourceSnapshotId ||
      !exactReference(review.source, source)
    ) {
      reasons.add("source_reference_mismatch");
      continue;
    }
    if (!artifactsAvailable([source.content], availableArtifacts)) {
      reasons.add("source_content_unavailable");
    }
    if (source.identityVerification.status === "disputed") {
      reasons.add("source_identity_disputed");
    } else if (source.identityVerification.status === "unverified") {
      reasons.add("source_identity_unverified");
    } else {
      if (!artifactsAvailable(source.identityVerification.evidence, availableArtifacts)) {
        reasons.add("source_identity_evidence_unavailable");
      }
      if (before(at, source.identityVerification.verifiedAt)) {
        reasons.add("source_identity_not_current");
      }
      if (
        source.identityVerification.verifierPrincipalId === source.publishedByPrincipalId ||
        source.identityVerification.verifierPrincipalId === criterionSet.publishedByPrincipalId ||
        source.identityVerification.verifierPrincipalId === request.requesterPrincipalId
      ) {
        reasons.add("source_identity_not_independent");
      }
    }
    if (
      before(at, source.recordedAt) ||
      (source.effectiveAt !== undefined && before(at, source.effectiveAt))
    ) {
      reasons.add("source_not_effective");
    }
    if (source.expiresAt && !before(at, source.expiresAt)) reasons.add("source_not_current");
    if (
      before(at, review.reviewedAt) ||
      review.freshnessConclusion !== "current" ||
      !currentAt(at, review.validFrom, review.validUntil)
    ) {
      reasons.add("source_review_not_current");
    }
    if (review.outcome === "require_approval") reasons.add("source_review_requires_approval");
    if (review.outcome === "unverifiable") reasons.add("source_review_unverifiable");
    if (review.declaredRelationships.length > 0) {
      reasons.add("source_review_relationship_disclosed");
    }
    if (review.authorityConclusion !== "accepted" || review.outcome === "rejected") {
      reasons.add("source_authority_not_accepted");
    }
    if (review.applicabilityConclusion !== "approved") {
      reasons.add("source_applicability_not_approved");
    }
    if (review.licensingConclusion !== "usable" || source.license.status !== "declared") {
      reasons.add("source_license_unusable");
    }
    if (
      !sourceScopeCovers(source.applicabilityScope, criterionSet.applicabilityScope) ||
      !sourceScopeCovers(review.approvedScope, criterionSet.applicabilityScope) ||
      !contextMatchesScope(request.context, request.scope, criterionSet.applicabilityScope)
    ) {
      reasons.add("source_scope_mismatch");
    }
    if (review.criticalConflictStatus === "unresolved") {
      reasons.add("source_conflict_unresolved");
    }
    const reviewedConflictKeys = new Set(review.reviewedConflicts.map(exactSourceKey));
    if (
      source.conflictsWith.some((conflict) => !reviewedConflictKeys.has(exactSourceKey(conflict)))
    ) {
      reasons.add("source_conflict_review_incomplete");
    }
    if (!artifactsAvailable(review.reviewBasis, availableArtifacts)) {
      reasons.add("source_review_basis_unavailable");
    }
    if (
      review.reviewedByPrincipalId === criterionSet.publishedByPrincipalId ||
      review.reviewedByPrincipalId === request.requesterPrincipalId
    ) {
      reasons.add("requester_only_review");
    }
    const reviewerReference = review.reviewerQualification;
    const reviewer = reviewerReference
      ? reviewerEvidence.get(exactReviewerQualificationKey(reviewerReference))
      : undefined;
    if (!reviewerReference) {
      reasons.add("reviewer_qualification_unavailable");
    } else if (!reviewer) {
      reasons.add(
        reviewerEvidenceById.has(reviewerReference.qualificationId)
          ? "reviewer_qualification_reference_mismatch"
          : "reviewer_qualification_unavailable",
      );
    } else if (
      !sameScope(reviewer.scope, criterionSet.scope) ||
      reviewer.reviewerPrincipalId !== review.reviewedByPrincipalId
    ) {
      reasons.add("reviewer_qualification_reference_mismatch");
    } else if (
      !sourceScopeCovers(reviewer.applicabilityScope, criterionSet.applicabilityScope) ||
      !sourceScopeCovers(reviewer.applicabilityScope, review.approvedScope)
    ) {
      reasons.add("reviewer_qualification_scope_mismatch");
    } else if (!reviewer.sourceKinds.includes(source.sourceKind)) {
      reasons.add("reviewer_qualification_source_kind_mismatch");
    } else if (reviewer.status === "unqualified") {
      reasons.add("reviewer_unqualified");
    } else if (reviewer.status === "unverifiable") {
      reasons.add("reviewer_qualification_unverifiable");
    } else if (
      before(at, reviewer.recordedAt) ||
      !currentAt(at, reviewer.validFrom, reviewer.validUntil)
    ) {
      reasons.add("reviewer_qualification_not_current");
    } else if (
      reviewer.verifiedByPrincipalId === reviewer.reviewerPrincipalId ||
      reviewer.verifiedByPrincipalId === criterionSet.publishedByPrincipalId ||
      reviewer.verifiedByPrincipalId === request.requesterPrincipalId
    ) {
      reasons.add("reviewer_qualification_not_independent");
    } else if (!artifactsAvailable(reviewer.credentialEvidence, availableArtifacts)) {
      reasons.add("reviewer_qualification_evidence_unavailable");
    }
  }
}

function subjectKey(subject: EvaluatorSpec | OracleSpec): string {
  return "evaluatorId" in subject
    ? `evaluator:${subject.evaluatorId}:${subject.evaluatorVersionId}:${subject.definitionSha256}`
    : `oracle:${subject.oracleId}:${subject.oracleVersionId}:${subject.definitionSha256}`;
}

function reportSubjectKey(report: QualificationReport): string {
  return report.subject.kind === "evaluator"
    ? `evaluator:${report.subject.evaluator.evaluatorId}:${report.subject.evaluator.evaluatorVersionId}:${report.subject.evaluator.definitionSha256}`
    : `oracle:${report.subject.oracle.oracleId}:${report.subject.oracle.oracleVersionId}:${report.subject.oracle.definitionSha256}`;
}

function addQualificationReasons(
  reasons: Set<CriteriaTrustReason>,
  criterionSet: CriterionSet,
  request: EvaluateCriteriaTrustInput["request"],
  qualifications: readonly CriteriaTrustQualificationEvidence[],
  availableArtifacts: ReadonlyMap<string, "available" | "unavailable">,
  at: string,
): void {
  const reports = new Map(
    qualifications
      .filter(
        (value): value is CriteriaTrustQualificationEvidence & { report: QualificationReport } =>
          Boolean(value.report),
      )
      .map((value) => [exactQualificationKey(value.report), value]),
  );
  const expectedSubjects = new Map<string, Set<string>>();
  for (const criterion of criterionSet.criteria) {
    const fixtureIds = criterion.qualificationFixtures.map(
      ({ fixture }) => fixture.fixtureVersionId,
    );
    for (const key of [
      `evaluator:${criterion.evaluator.evaluatorId}:${criterion.evaluator.evaluatorVersionId}:${criterion.evaluator.definitionSha256}`,
      `oracle:${criterion.oracle.oracleId}:${criterion.oracle.oracleVersionId}:${criterion.oracle.definitionSha256}`,
    ]) {
      const expected = expectedSubjects.get(key) ?? new Set<string>();
      for (const fixtureId of fixtureIds) expected.add(fixtureId);
      expectedSubjects.set(key, expected);
    }
  }

  const matchedSubjects = new Set<string>();
  for (const evidence of reports.values()) {
    const report = evidence.report;
    const key = reportSubjectKey(report);
    const expected = expectedSubjects.get(key);
    if (!expected) {
      reasons.add("qualification_reference_mismatch");
      continue;
    }
    if (!evidence.subject || subjectKey(evidence.subject) !== key) {
      reasons.add("qualification_reference_mismatch");
      continue;
    }
    matchedSubjects.add(key);
    if (!evidence.fixtureSet) {
      reasons.add("qualification_fixture_set_unavailable");
      continue;
    }
    if (
      !sameScope(report.scope, criterionSet.scope) ||
      !sameScope(evidence.subject.scope, criterionSet.scope) ||
      !sameScope(evidence.fixtureSet.scope, criterionSet.scope) ||
      report.fixtureSet.fixtureSetVersionId !== evidence.fixtureSet.fixtureSetVersionId ||
      report.fixtureSet.fixtureSetId !== evidence.fixtureSet.fixtureSetId ||
      !exactReference(report.fixtureSet, evidence.fixtureSet)
    ) {
      reasons.add("qualification_reference_mismatch");
      continue;
    }
    const fixtureIds = new Set(
      evidence.fixtureSet.cases.map(({ fixture }) => fixture.fixtureVersionId),
    );
    const exactCaseById = new Map(evidence.fixtureSet.cases.map((value) => [value.caseId, value]));
    const caseLineageMatches =
      report.caseResults.length === evidence.fixtureSet.cases.length &&
      report.caseResults.every((value) => {
        const expectedCase = exactCaseById.get(value.caseId);
        return (
          expectedCase !== undefined &&
          expectedCase.caseKind === value.caseKind &&
          expectedCase.expectedOutcome === value.expectedOutcome
        );
      });
    if ([...expected].some((fixtureId) => !fixtureIds.has(fixtureId)) || !caseLineageMatches) {
      reasons.add("qualification_fixture_mismatch");
    }
    if (report.status !== "qualified") reasons.add("qualification_unqualified");
    if (
      before(at, report.recordedAt) ||
      before(at, report.completedAt) ||
      before(at, evidence.fixtureSet.publishedAt) ||
      before(at, evidence.subject.publishedAt) ||
      !currentAt(at, report.validFrom, report.validUntil)
    ) {
      reasons.add("qualification_not_current");
    }
    if (
      evidence.fixtureSet.publishedByPrincipalId === evidence.subject.publishedByPrincipalId ||
      evidence.fixtureSet.publishedByPrincipalId === report.executedByPrincipalId ||
      evidence.fixtureSet.publishedByPrincipalId === criterionSet.publishedByPrincipalId ||
      evidence.fixtureSet.publishedByPrincipalId === request.requesterPrincipalId
    ) {
      reasons.add("qualification_fixture_not_independent");
    }
    if (
      report.executedByPrincipalId === evidence.subject.publishedByPrincipalId ||
      report.executedByPrincipalId === criterionSet.publishedByPrincipalId ||
      report.executedByPrincipalId === request.requesterPrincipalId
    ) {
      reasons.add("qualification_not_independent");
    }
    const evidenceArtifacts = [
      ...report.environmentEvidence,
      ...report.caseResults.flatMap(({ rawEvidence }) => rawEvidence),
    ];
    if (!artifactsAvailable(evidenceArtifacts, availableArtifacts)) {
      reasons.add("qualification_evidence_unavailable");
    }
  }
  if (matchedSubjects.size !== expectedSubjects.size) {
    reasons.add("qualification_report_unavailable");
  }
}

function statusFor(reasons: ReadonlySet<CriteriaTrustReason>): CriteriaTrustStatus {
  if (reasons.size === 0) return "eligible";
  const values = [...reasons];
  if (
    values.some(
      (reason) => !UNVERIFIABLE_REASONS.has(reason) && !REQUIRE_APPROVAL_REASONS.has(reason),
    )
  ) {
    return "ineligible";
  }
  if (values.some((reason) => UNVERIFIABLE_REASONS.has(reason))) return "unverifiable";
  return "require_approval";
}

/**
 * Derives criterion usability from exact, already-resolved records.
 *
 * Search rank, snippets, generated summaries, requester assertions, and caller-authored trust
 * fields are intentionally absent. Missing evidence remains unavailable instead of being inferred.
 */
export function evaluateCriteriaTrust(input: EvaluateCriteriaTrustInput): CriteriaTrustEvaluation {
  let at: string;
  let criterionSet: CriterionSet;
  let criterionStatus: CriterionSetStatusRecord | null;
  let request: EvaluateCriteriaTrustInput["request"];
  try {
    at = UtcMillisecondTimestampSchema.parse(input.at);
    criterionSet = CriterionSetSchema.parse(input.criterionSet);
    criterionStatus =
      input.criterionStatus === null
        ? null
        : CriterionSetStatusRecordSchema.parse(input.criterionStatus);
    request = {
      context: ApplicabilityContextSchema.parse(input.request.context),
      requesterPrincipalId: OpaqueIdSchema.parse(input.request.requesterPrincipalId),
      scope: EvidenceScopeSchema.parse(input.request.scope),
    };
  } catch (cause) {
    throw invalid("Criteria-trust root input is invalid", cause);
  }
  if (!sameScope(request.scope, criterionSet.scope)) {
    throw invalid("Criteria-trust request scope must match the criterion scope");
  }

  const availableArtifacts = artifactAvailability(input.artifacts);
  const sources = parseSources(input.sources);
  const qualifications = parseQualifications(input.qualifications);
  const reviewerQualifications = parseReviewerQualifications(input.reviewerQualifications);
  const reasons = new Set<CriteriaTrustReason>();

  if (!criterionStatus) {
    reasons.add("criterion_status_unavailable");
  } else if (
    !sameScope(criterionStatus.scope, criterionSet.scope) ||
    criterionStatus.criterionSet.criterionSetId !== criterionSet.criterionSetId ||
    criterionStatus.criterionSet.criterionSetVersionId !== criterionSet.criterionSetVersionId ||
    !exactReference(criterionStatus.criterionSet, criterionSet)
  ) {
    reasons.add("criterion_status_unavailable");
  } else {
    if (criterionStatus.status !== "approved") reasons.add("criterion_not_approved");
    if (
      before(at, criterionStatus.recordedAt) ||
      before(at, criterionStatus.effectiveAt) ||
      (criterionStatus.expiresAt !== undefined && !before(at, criterionStatus.expiresAt))
    ) {
      reasons.add("criterion_status_not_current");
    }
  }

  addSourceReasons(
    reasons,
    criterionSet,
    request,
    sources,
    reviewerQualifications,
    availableArtifacts,
    at,
  );
  addQualificationReasons(reasons, criterionSet, request, qualifications, availableArtifacts, at);

  return {
    evaluatedAt: at,
    reasons: [...reasons].sort(),
    status: statusFor(reasons),
  };
}
