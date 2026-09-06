import type {
  ApplicabilityContext,
  CriteriaTrustEvaluation,
  CriterionSet,
  CriterionSetStatusRecord,
  EvaluatorSpec,
  EvidenceScope,
  OracleSpec,
  PrincipalContext,
  QualificationFixtureSet,
  QualificationReport,
  SourceReviewerQualification,
  SourceReviewRecord,
  SourceSnapshot,
} from "@proofstack/contracts";
import {
  ApplicabilityContextSchema,
  EvidenceScopeSchema,
  MAX_CRITERIA_TRUST_QUALIFICATION_REPORTS,
  OpaqueIdSchema,
  PrincipalContextSchema,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "../auth/authorization.js";
import type { Clock } from "../clock.js";
import {
  type CriteriaTrustArtifactAvailability,
  type CriteriaTrustArtifactReference,
  type CriteriaTrustQualificationEvidence,
  type CriteriaTrustSourceEvidence,
  evaluateCriteriaTrust,
} from "./criteria-trust.js";
import { evaluationRecordId, validateEvaluationRecord } from "./evaluation-record-validation.js";
import type { EvaluationRepository } from "./evaluation-repository.js";
import {
  type EvaluationRecordKind,
  EvaluationRecordNotFoundError,
  EvaluationRepositoryContractError,
  InvalidEvaluationRecordInputError,
} from "./evaluation-repository-errors.js";

interface CriteriaTrustRoute {
  readonly environmentId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
}

export interface ResolveCriteriaTrustCommand extends CriteriaTrustRoute {
  readonly context: ApplicabilityContext;
  readonly criterionSetVersionId: string;
  readonly criterionStatusRecordId: string;
  /**
   * Candidate immutable reports to resolve. Omitting an expected subject fails closed as
   * `qualification_report_unavailable`; report contents and trust fields are never accepted here.
   */
  readonly qualificationReportIds: readonly string[];
}

export interface ResolveCriteriaTrustArtifactsCommand {
  readonly references: readonly CriteriaTrustArtifactReference[];
  readonly scope: EvidenceScope;
}

/**
 * Server-owned artifact availability boundary. Implementations must resolve exact retained bytes,
 * not accept caller assertions or infer availability from search results or metadata snippets.
 */
export interface CriteriaTrustArtifactResolver {
  resolve(
    command: ResolveCriteriaTrustArtifactsCommand,
  ): Promise<readonly CriteriaTrustArtifactAvailability[]>;
}

export interface ResolveCriteriaTrustDependencies {
  readonly artifactResolver: CriteriaTrustArtifactResolver;
  readonly clock: Clock;
  readonly repository: EvaluationRepository;
}

interface AuthorizedCriteriaTrustRequest {
  readonly context: ApplicabilityContext;
  readonly criterionSetVersionId: string;
  readonly criterionStatusRecordId: string;
  readonly principal: PrincipalContext;
  readonly qualificationReportIds: readonly string[];
  readonly scope: EvidenceScope;
}

type ResolvedEvaluationRecord =
  | CriterionSet
  | CriterionSetStatusRecord
  | EvaluatorSpec
  | OracleSpec
  | QualificationFixtureSet
  | QualificationReport
  | SourceReviewerQualification
  | SourceReviewRecord
  | SourceSnapshot;

function invalidInput(message: string, cause?: unknown): InvalidEvaluationRecordInputError {
  return new InvalidEvaluationRecordInputError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function authorize(command: ResolveCriteriaTrustCommand): AuthorizedCriteriaTrustRequest {
  let principal: PrincipalContext;
  try {
    principal = PrincipalContextSchema.parse(command.principal);
  } catch (cause) {
    throw invalidInput("Criteria-trust principal is invalid", cause);
  }
  requireCapability(principal, "evaluation:read");
  requireEnvironmentAccess(principal, command.projectId, command.environmentId);

  const scope = EvidenceScopeSchema.safeParse({
    environmentId: command.environmentId,
    projectId: command.projectId,
    tenantId: principal.tenantId,
  });
  const criterionSetVersionId = OpaqueIdSchema.safeParse(command.criterionSetVersionId);
  const criterionStatusRecordId = OpaqueIdSchema.safeParse(command.criterionStatusRecordId);
  const context = ApplicabilityContextSchema.safeParse(command.context);
  if (
    !scope.success ||
    !criterionSetVersionId.success ||
    !criterionStatusRecordId.success ||
    !context.success
  ) {
    const cause = !scope.success
      ? scope.error
      : !criterionSetVersionId.success
        ? criterionSetVersionId.error
        : !criterionStatusRecordId.success
          ? criterionStatusRecordId.error
          : context.error;
    throw invalidInput("Criteria-trust request is invalid", cause);
  }
  if (
    !Array.isArray(command.qualificationReportIds) ||
    command.qualificationReportIds.length > MAX_CRITERIA_TRUST_QUALIFICATION_REPORTS
  ) {
    throw invalidInput("Criteria-trust qualification report selection is invalid");
  }
  const qualificationReportIds = command.qualificationReportIds.map((value) => {
    const parsed = OpaqueIdSchema.safeParse(value);
    if (!parsed.success) {
      throw invalidInput("Criteria-trust qualification report selection is invalid", parsed.error);
    }
    return parsed.data;
  });
  if (new Set(qualificationReportIds).size !== qualificationReportIds.length) {
    throw invalidInput("Criteria-trust qualification reports must be unique");
  }

  return {
    context: context.data,
    criterionSetVersionId: criterionSetVersionId.data,
    criterionStatusRecordId: criterionStatusRecordId.data,
    principal,
    qualificationReportIds: qualificationReportIds.sort(),
    scope: scope.data,
  };
}

function serverTimestamp(clock: Clock): string {
  let value: string;
  try {
    value = clock.now().toISOString();
  } catch (cause) {
    throw invalidInput("Criteria-trust clock is invalid", cause);
  }
  const parsed = UtcMillisecondTimestampSchema.safeParse(value);
  if (!parsed.success) throw invalidInput("Criteria-trust clock is invalid", parsed.error);
  return parsed.data;
}

function sameScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function exactRecord<RecordType extends ResolvedEvaluationRecord>(
  input: unknown,
  kind: EvaluationRecordKind,
  scope: EvidenceScope,
  recordId: string,
  expectedDefinitionSha256?: string,
): RecordType {
  let record: ResolvedEvaluationRecord;
  try {
    record = validateEvaluationRecord(kind, input) as ResolvedEvaluationRecord;
  } catch (cause) {
    throw new EvaluationRepositoryContractError(
      "Criteria-trust repository returned an invalid record",
      { cause },
    );
  }
  if (
    evaluationRecordId(kind, record) !== recordId ||
    !sameScope(record.scope, scope) ||
    (expectedDefinitionSha256 !== undefined && record.definitionSha256 !== expectedDefinitionSha256)
  ) {
    throw new EvaluationRepositoryContractError(
      "Criteria-trust repository substituted a record outside the exact query",
    );
  }
  return structuredClone(record) as RecordType;
}

function artifactKey(reference: CriteriaTrustArtifactReference): string {
  return `${reference.artifactId}:${reference.sha256}`;
}

function artifactReferences(input: {
  readonly qualifications: readonly CriteriaTrustQualificationEvidence[];
  readonly reviewerQualifications: readonly SourceReviewerQualification[];
  readonly sources: readonly CriteriaTrustSourceEvidence[];
}): CriteriaTrustArtifactReference[] {
  const references = [
    ...input.sources.flatMap(({ review, source }) => [
      ...(source
        ? [
            source.content,
            ...(source.identityVerification.status === "verified"
              ? source.identityVerification.evidence
              : []),
          ]
        : []),
      ...(review ? review.reviewBasis : []),
    ]),
    ...input.reviewerQualifications.flatMap(({ credentialEvidence }) => credentialEvidence),
    ...input.qualifications.flatMap(({ report }) =>
      report
        ? [
            ...report.environmentEvidence,
            ...report.caseResults.flatMap(({ rawEvidence }) => rawEvidence),
          ]
        : [],
    ),
  ];
  return [
    ...new Map(references.map((reference) => [artifactKey(reference), reference])).values(),
  ].sort((left, right) => artifactKey(left).localeCompare(artifactKey(right)));
}

function unavailableArtifacts(
  references: readonly CriteriaTrustArtifactReference[],
): CriteriaTrustArtifactAvailability[] {
  return references.map((reference) => ({ ...reference, state: "unavailable" }));
}

function normalizeArtifactAvailability(
  references: readonly CriteriaTrustArtifactReference[],
  input: readonly unknown[],
): CriteriaTrustArtifactAvailability[] {
  const expected = new Map(references.map((reference) => [artifactKey(reference), reference]));
  const resolved = new Map<string, "available" | "unavailable">();
  for (const candidate of input) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new EvaluationRepositoryContractError(
        "Criteria-trust artifact resolver returned an invalid availability result",
      );
    }
    const item = candidate as Partial<CriteriaTrustArtifactAvailability>;
    const artifactId = OpaqueIdSchema.safeParse(item.artifactId);
    const sha256 = typeof item.sha256 === "string" ? item.sha256 : "";
    const key = `${item.artifactId ?? ""}:${sha256}`;
    if (
      !artifactId.success ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      (item.state !== "available" && item.state !== "unavailable") ||
      !expected.has(key)
    ) {
      throw new EvaluationRepositoryContractError(
        "Criteria-trust artifact resolver returned an invalid availability result",
      );
    }
    const existing = resolved.get(key);
    if (existing !== undefined && existing !== item.state) {
      throw new EvaluationRepositoryContractError(
        "Criteria-trust artifact resolver returned contradictory availability",
      );
    }
    resolved.set(key, item.state);
  }
  return references.map((reference) => ({
    ...reference,
    state: resolved.get(artifactKey(reference)) ?? "unavailable",
  }));
}

async function resolveArtifacts(
  resolver: CriteriaTrustArtifactResolver,
  scope: EvidenceScope,
  references: readonly CriteriaTrustArtifactReference[],
): Promise<CriteriaTrustArtifactAvailability[]> {
  if (references.length === 0) return [];
  let resolved: readonly CriteriaTrustArtifactAvailability[];
  try {
    resolved = await resolver.resolve({
      references: structuredClone(references),
      scope: structuredClone(scope),
    });
  } catch {
    return unavailableArtifacts(references);
  }
  if (!Array.isArray(resolved)) {
    throw new EvaluationRepositoryContractError(
      "Criteria-trust artifact resolver returned a non-array result",
    );
  }
  return normalizeArtifactAvailability(references, resolved);
}

async function resolveSources(
  repository: EvaluationRepository,
  scope: EvidenceScope,
  criterionSet: CriterionSet,
): Promise<{
  readonly reviewerQualifications: readonly SourceReviewerQualification[];
  readonly sources: readonly CriteriaTrustSourceEvidence[];
}> {
  const reviewerQualifications = new Map<string, SourceReviewerQualification>();
  const sources = await Promise.all(
    criterionSet.sources.map(async (reference): Promise<CriteriaTrustSourceEvidence> => {
      const [sourceInput, reviewInput] = await Promise.all([
        repository.findSourceSnapshot(structuredClone(scope), reference.source.sourceSnapshotId),
        repository.findSourceReview(structuredClone(scope), reference.review.sourceReviewId),
      ]);
      const source =
        sourceInput === null
          ? null
          : exactRecord<SourceSnapshot>(
              sourceInput,
              "source_snapshot",
              scope,
              reference.source.sourceSnapshotId,
              reference.source.definitionSha256,
            );
      const review =
        reviewInput === null
          ? null
          : exactRecord<SourceReviewRecord>(
              reviewInput,
              "source_review",
              scope,
              reference.review.sourceReviewId,
              reference.review.definitionSha256,
            );
      if (review?.reviewerQualification) {
        const reviewerReference = review.reviewerQualification;
        let qualification = reviewerQualifications.get(reviewerReference.qualificationId);
        if (!qualification) {
          const qualificationInput = await repository.findSourceReviewerQualification(
            structuredClone(scope),
            reviewerReference.qualificationId,
          );
          if (qualificationInput !== null) {
            qualification = exactRecord<SourceReviewerQualification>(
              qualificationInput,
              "source_reviewer_qualification",
              scope,
              reviewerReference.qualificationId,
              reviewerReference.definitionSha256,
            );
            reviewerQualifications.set(reviewerReference.qualificationId, qualification);
          }
        } else {
          exactRecord<SourceReviewerQualification>(
            qualification,
            "source_reviewer_qualification",
            scope,
            reviewerReference.qualificationId,
            reviewerReference.definitionSha256,
          );
        }
      }
      return { review, source };
    }),
  );
  return { reviewerQualifications: [...reviewerQualifications.values()], sources };
}

async function resolveQualifications(
  repository: EvaluationRepository,
  scope: EvidenceScope,
  qualificationReportIds: readonly string[],
): Promise<CriteriaTrustQualificationEvidence[]> {
  const subjects = new Map<string, EvaluatorSpec | OracleSpec>();
  const fixtureSets = new Map<string, QualificationFixtureSet>();
  return Promise.all(
    qualificationReportIds.map(async (qualificationReportId) => {
      const reportInput = await repository.findQualificationReport(
        structuredClone(scope),
        qualificationReportId,
      );
      if (reportInput === null) return { fixtureSet: null, report: null, subject: null };
      const report = exactRecord<QualificationReport>(
        reportInput,
        "qualification_report",
        scope,
        qualificationReportId,
      );
      const subjectReference =
        report.subject.kind === "evaluator" ? report.subject.evaluator : report.subject.oracle;
      const subjectKind = report.subject.kind === "evaluator" ? "evaluator_spec" : "oracle_spec";
      const subjectVersionId =
        report.subject.kind === "evaluator"
          ? report.subject.evaluator.evaluatorVersionId
          : report.subject.oracle.oracleVersionId;
      const subjectKey = `${subjectKind}:${subjectVersionId}`;
      let subject = subjects.get(subjectKey) ?? null;
      if (!subject) {
        const subjectInput =
          report.subject.kind === "evaluator"
            ? await repository.findEvaluatorSpec(structuredClone(scope), subjectVersionId)
            : await repository.findOracleSpec(structuredClone(scope), subjectVersionId);
        if (subjectInput !== null) {
          subject = exactRecord<EvaluatorSpec | OracleSpec>(
            subjectInput,
            subjectKind,
            scope,
            subjectVersionId,
            subjectReference.definitionSha256,
          );
          subjects.set(subjectKey, subject);
        }
      } else {
        exactRecord<EvaluatorSpec | OracleSpec>(
          subject,
          subjectKind,
          scope,
          subjectVersionId,
          subjectReference.definitionSha256,
        );
      }

      const fixtureVersionId = report.fixtureSet.fixtureSetVersionId;
      let fixtureSet = fixtureSets.get(fixtureVersionId) ?? null;
      if (!fixtureSet) {
        const fixtureInput = await repository.findQualificationFixtureSet(
          structuredClone(scope),
          fixtureVersionId,
        );
        if (fixtureInput !== null) {
          fixtureSet = exactRecord<QualificationFixtureSet>(
            fixtureInput,
            "qualification_fixture_set",
            scope,
            fixtureVersionId,
            report.fixtureSet.definitionSha256,
          );
          fixtureSets.set(fixtureVersionId, fixtureSet);
        }
      } else {
        exactRecord<QualificationFixtureSet>(
          fixtureSet,
          "qualification_fixture_set",
          scope,
          fixtureVersionId,
          report.fixtureSet.definitionSha256,
        );
      }
      return { fixtureSet, report, subject };
    }),
  );
}

/**
 * Builds and evaluates a trust graph from exact server-side records.
 *
 * The command contains selectors and applicability context only. Current time, immutable record
 * semantics, reviewer qualifications, source evidence, and retained-byte availability come from
 * trusted application ports and fail closed when unavailable.
 */
export class ResolveCriteriaTrust {
  constructor(private readonly dependencies: ResolveCriteriaTrustDependencies) {}

  async execute(command: ResolveCriteriaTrustCommand): Promise<CriteriaTrustEvaluation> {
    const request = authorize(command);
    const evaluatedAt = serverTimestamp(this.dependencies.clock);
    const criterionSetInput = await this.dependencies.repository.findCriterionSet(
      structuredClone(request.scope),
      request.criterionSetVersionId,
    );
    if (criterionSetInput === null) {
      throw new EvaluationRecordNotFoundError("criterion_set", request.criterionSetVersionId);
    }
    const criterionSet = exactRecord<CriterionSet>(
      criterionSetInput,
      "criterion_set",
      request.scope,
      request.criterionSetVersionId,
    );

    const [criterionStatusInput, sourceEvidence, qualifications] = await Promise.all([
      this.dependencies.repository.findCriterionSetStatus(
        structuredClone(request.scope),
        request.criterionStatusRecordId,
      ),
      resolveSources(this.dependencies.repository, request.scope, criterionSet),
      resolveQualifications(
        this.dependencies.repository,
        request.scope,
        request.qualificationReportIds,
      ),
    ]);
    const criterionStatus =
      criterionStatusInput === null
        ? null
        : exactRecord<CriterionSetStatusRecord>(
            criterionStatusInput,
            "criterion_set_status",
            request.scope,
            request.criterionStatusRecordId,
          );
    const references = artifactReferences({
      qualifications,
      reviewerQualifications: sourceEvidence.reviewerQualifications,
      sources: sourceEvidence.sources,
    });
    const artifacts = await resolveArtifacts(
      this.dependencies.artifactResolver,
      request.scope,
      references,
    );

    return evaluateCriteriaTrust({
      artifacts,
      at: evaluatedAt,
      criterionSet,
      criterionStatus,
      qualifications,
      request: {
        context: request.context,
        requesterPrincipalId: request.principal.principalId,
        scope: request.scope,
      },
      reviewerQualifications: sourceEvidence.reviewerQualifications,
      sources: sourceEvidence.sources,
    });
  }
}
