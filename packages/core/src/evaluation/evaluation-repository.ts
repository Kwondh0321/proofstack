import type {
  Assessment,
  CriterionSet,
  CriterionSetStatusRecord,
  DiscoveryRecord,
  EvaluationAggregate,
  EvaluationAggregationPolicy,
  EvaluationRun,
  EvaluationRunRejection,
  EvaluationRunResult,
  EvaluatorSpec,
  EvidenceScope,
  OracleSpec,
  QualificationFixtureSet,
  QualificationReport,
  RawObservation,
  SourceReviewRecord,
  SourceSnapshot,
} from "@proofstack/contracts";

export interface PublishEvaluationRecordResult<Record> {
  readonly created: boolean;
  readonly record: Record;
}

export interface EvaluationSourceRepository {
  findDiscoveryRecord(scope: EvidenceScope, discoveryId: string): Promise<DiscoveryRecord | null>;
  findSourceReview(scope: EvidenceScope, sourceReviewId: string): Promise<SourceReviewRecord | null>;
  findSourceSnapshot(scope: EvidenceScope, sourceSnapshotId: string): Promise<SourceSnapshot | null>;
  publishDiscoveryRecord(
    candidate: DiscoveryRecord,
  ): Promise<PublishEvaluationRecordResult<DiscoveryRecord>>;
  publishSourceReview(
    candidate: SourceReviewRecord,
  ): Promise<PublishEvaluationRecordResult<SourceReviewRecord>>;
  publishSourceSnapshot(
    candidate: SourceSnapshot,
  ): Promise<PublishEvaluationRecordResult<SourceSnapshot>>;
}

export interface EvaluationDefinitionRepository {
  findAggregationPolicy(
    scope: EvidenceScope,
    policyVersionId: string,
  ): Promise<EvaluationAggregationPolicy | null>;
  findCriterionSet(
    scope: EvidenceScope,
    criterionSetVersionId: string,
  ): Promise<CriterionSet | null>;
  findCriterionSetStatus(
    scope: EvidenceScope,
    statusRecordId: string,
  ): Promise<CriterionSetStatusRecord | null>;
  findEvaluatorSpec(scope: EvidenceScope, evaluatorVersionId: string): Promise<EvaluatorSpec | null>;
  findOracleSpec(scope: EvidenceScope, oracleVersionId: string): Promise<OracleSpec | null>;
  findQualificationFixtureSet(
    scope: EvidenceScope,
    fixtureSetVersionId: string,
  ): Promise<QualificationFixtureSet | null>;
  findQualificationReport(
    scope: EvidenceScope,
    qualificationReportId: string,
  ): Promise<QualificationReport | null>;
  publishAggregationPolicy(
    candidate: EvaluationAggregationPolicy,
  ): Promise<PublishEvaluationRecordResult<EvaluationAggregationPolicy>>;
  publishCriterionSet(
    candidate: CriterionSet,
  ): Promise<PublishEvaluationRecordResult<CriterionSet>>;
  publishCriterionSetStatus(
    candidate: CriterionSetStatusRecord,
  ): Promise<PublishEvaluationRecordResult<CriterionSetStatusRecord>>;
  publishEvaluatorSpec(
    candidate: EvaluatorSpec,
  ): Promise<PublishEvaluationRecordResult<EvaluatorSpec>>;
  publishOracleSpec(candidate: OracleSpec): Promise<PublishEvaluationRecordResult<OracleSpec>>;
  publishQualificationFixtureSet(
    candidate: QualificationFixtureSet,
  ): Promise<PublishEvaluationRecordResult<QualificationFixtureSet>>;
  publishQualificationReport(
    candidate: QualificationReport,
  ): Promise<PublishEvaluationRecordResult<QualificationReport>>;
}

export interface EvaluationExecutionRepository {
  findEvaluationRun(scope: EvidenceScope, evaluationRunId: string): Promise<EvaluationRun | null>;
  findEvaluationRunRejection(
    scope: EvidenceScope,
    rejectionId: string,
  ): Promise<EvaluationRunRejection | null>;
  findEvaluationRunResult(
    scope: EvidenceScope,
    resultId: string,
  ): Promise<EvaluationRunResult | null>;
  findRawObservation(
    scope: EvidenceScope,
    observationId: string,
  ): Promise<RawObservation | null>;
  publishEvaluationRun(
    candidate: EvaluationRun,
  ): Promise<PublishEvaluationRecordResult<EvaluationRun>>;
  publishEvaluationRunRejection(
    candidate: EvaluationRunRejection,
  ): Promise<PublishEvaluationRecordResult<EvaluationRunRejection>>;
  publishEvaluationRunResult(
    candidate: EvaluationRunResult,
  ): Promise<PublishEvaluationRecordResult<EvaluationRunResult>>;
  publishRawObservation(
    candidate: RawObservation,
  ): Promise<PublishEvaluationRecordResult<RawObservation>>;
}

export interface EvaluationAssessmentRepository {
  findAssessment(scope: EvidenceScope, assessmentId: string): Promise<Assessment | null>;
  findEvaluationAggregate(
    scope: EvidenceScope,
    aggregateId: string,
  ): Promise<EvaluationAggregate | null>;
  publishAssessment(candidate: Assessment): Promise<PublishEvaluationRecordResult<Assessment>>;
  publishEvaluationAggregate(
    candidate: EvaluationAggregate,
  ): Promise<PublishEvaluationRecordResult<EvaluationAggregate>>;
}

/**
 * Persistence boundary for the immutable evaluation evidence graph.
 *
 * Implementations must validate each schema and canonical definition digest, bind versioned
 * resources tenant-wide, resolve exact-scope lineage before a write becomes visible, own stored
 * values, return the authoritative original on identical retries, and write nothing on conflict.
 * Find methods deliberately return `null` for both absence and values outside the exact scope.
 */
export interface EvaluationRepository
  extends EvaluationSourceRepository,
    EvaluationDefinitionRepository,
    EvaluationExecutionRepository,
    EvaluationAssessmentRepository {}
