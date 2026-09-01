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
import {
  type EvaluationStoredRecord,
  evaluationRecordId,
  evaluationResource,
  validateEvaluationRecord,
} from "../evaluation/evaluation-record-validation.js";
import type {
  EvaluationRepository,
  PublishEvaluationRecordResult,
} from "../evaluation/evaluation-repository.js";
import {
  EvaluationLineageError,
  EvaluationRecordConflictError,
  type EvaluationRecordKind,
  EvaluationResourceConflictError,
} from "../evaluation/evaluation-repository-errors.js";

export interface EvaluationRecordReference {
  readonly definitionSha256?: string;
  readonly recordId: string;
  readonly recordKind: EvaluationRecordKind;
}

interface TenantState {
  readonly records: Map<string, EvaluationStoredRecord>;
  readonly resources: Map<string, EvidenceScope>;
  readonly uniqueBindings: Map<string, string>;
}

function emptyTenantState(): TenantState {
  return { records: new Map(), resources: new Map(), uniqueBindings: new Map() };
}

function copyTenantState(state: TenantState): TenantState {
  return {
    records: new Map(state.records),
    resources: new Map(state.resources),
    uniqueBindings: new Map(state.uniqueBindings),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function scopesEqual(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function recordKey(kind: EvaluationRecordKind, recordId: string): string {
  return `${kind}:${recordId}`;
}

function exact(
  recordKind: EvaluationRecordKind,
  recordId: string,
  definitionSha256?: string,
): EvaluationRecordReference {
  return definitionSha256 === undefined
    ? { recordId, recordKind }
    : { definitionSha256, recordId, recordKind };
}

function sourceSnapshotReferences(record: SourceSnapshot): readonly EvaluationRecordReference[] {
  return [
    ...(record.discovery
      ? [exact("discovery_record", record.discovery.discoveryId, record.discovery.definitionSha256)]
      : []),
    ...record.conflictsWith.map(({ definitionSha256, sourceSnapshotId }) =>
      exact("source_snapshot", sourceSnapshotId, definitionSha256),
    ),
    ...record.supersedes.map(({ definitionSha256, sourceSnapshotId }) =>
      exact("source_snapshot", sourceSnapshotId, definitionSha256),
    ),
  ];
}

function sourceReviewReferences(record: SourceReviewRecord): readonly EvaluationRecordReference[] {
  return [
    exact("source_snapshot", record.source.sourceSnapshotId, record.source.definitionSha256),
    ...record.reviewedConflicts.map(({ definitionSha256, sourceSnapshotId }) =>
      exact("source_snapshot", sourceSnapshotId, definitionSha256),
    ),
    ...(record.supersedesReview
      ? [
          exact(
            "source_review",
            record.supersedesReview.sourceReviewId,
            record.supersedesReview.definitionSha256,
          ),
        ]
      : []),
  ];
}

function criterionSetReferences(record: CriterionSet): readonly EvaluationRecordReference[] {
  return [
    ...(record.predecessor
      ? [
          exact(
            "criterion_set",
            record.predecessor.criterionSetVersionId,
            record.predecessor.definitionSha256,
          ),
        ]
      : []),
    ...record.sources.flatMap(({ review, source }) => [
      exact("source_snapshot", source.sourceSnapshotId, source.definitionSha256),
      exact("source_review", review.sourceReviewId, review.definitionSha256),
    ]),
  ];
}

function criterionStatusReferences(
  record: CriterionSetStatusRecord,
): readonly EvaluationRecordReference[] {
  return [
    exact(
      "criterion_set",
      record.criterionSet.criterionSetVersionId,
      record.criterionSet.definitionSha256,
    ),
    ...(record.previousStatus
      ? [
          exact(
            "criterion_set_status",
            record.previousStatus.statusRecordId,
            record.previousStatus.definitionSha256,
          ),
        ]
      : []),
    ...(record.supersededBy
      ? [
          exact(
            "criterion_set",
            record.supersededBy.criterionSetVersionId,
            record.supersededBy.definitionSha256,
          ),
        ]
      : []),
  ];
}

function oracleReferences(record: OracleSpec): readonly EvaluationRecordReference[] {
  return [
    exact(
      "qualification_fixture_set",
      record.qualificationFixtureSet.fixtureSetVersionId,
      record.qualificationFixtureSet.definitionSha256,
    ),
    ...(record.predecessor
      ? [
          exact(
            "oracle_spec",
            record.predecessor.oracleVersionId,
            record.predecessor.definitionSha256,
          ),
        ]
      : []),
  ];
}

function evaluatorReferences(record: EvaluatorSpec): readonly EvaluationRecordReference[] {
  return [
    exact(
      "qualification_fixture_set",
      record.qualificationFixtureSet.fixtureSetVersionId,
      record.qualificationFixtureSet.definitionSha256,
    ),
    ...record.oracles.map(({ definitionSha256, oracleVersionId }) =>
      exact("oracle_spec", oracleVersionId, definitionSha256),
    ),
    ...(record.predecessor
      ? [
          exact(
            "evaluator_spec",
            record.predecessor.evaluatorVersionId,
            record.predecessor.definitionSha256,
          ),
        ]
      : []),
    ...(record.kindDeclaration.kind === "composite"
      ? record.kindDeclaration.components.map(({ definitionSha256, evaluatorVersionId }) =>
          exact("evaluator_spec", evaluatorVersionId, definitionSha256),
        )
      : []),
  ];
}

function qualificationFixtureSetReferences(
  record: QualificationFixtureSet,
): readonly EvaluationRecordReference[] {
  return record.predecessor
    ? [
        exact(
          "qualification_fixture_set",
          record.predecessor.fixtureSetVersionId,
          record.predecessor.definitionSha256,
        ),
      ]
    : [];
}

function qualificationReportReferences(
  record: QualificationReport,
): readonly EvaluationRecordReference[] {
  return [
    exact(
      "qualification_fixture_set",
      record.fixtureSet.fixtureSetVersionId,
      record.fixtureSet.definitionSha256,
    ),
    record.subject.kind === "oracle"
      ? exact(
          "oracle_spec",
          record.subject.oracle.oracleVersionId,
          record.subject.oracle.definitionSha256,
        )
      : exact(
          "evaluator_spec",
          record.subject.evaluator.evaluatorVersionId,
          record.subject.evaluator.definitionSha256,
        ),
  ];
}

function runReferences(record: EvaluationRun): readonly EvaluationRecordReference[] {
  return [
    exact(
      "aggregation_policy",
      record.aggregationPolicy.policyVersionId,
      record.aggregationPolicy.definitionSha256,
    ),
    exact(
      "criterion_set",
      record.criterion.criterionSet.criterionSetVersionId,
      record.criterion.criterionSet.definitionSha256,
    ),
    exact(
      "criterion_set_status",
      record.criterionStatus.statusRecordId,
      record.criterionStatus.definitionSha256,
    ),
    exact("evaluator_spec", record.evaluator.evaluatorVersionId, record.evaluator.definitionSha256),
    exact(
      "qualification_report",
      record.evaluatorQualification.qualificationReportId,
      record.evaluatorQualification.definitionSha256,
    ),
    exact("oracle_spec", record.oracle.oracleVersionId, record.oracle.definitionSha256),
    exact(
      "qualification_report",
      record.oracleQualification.qualificationReportId,
      record.oracleQualification.definitionSha256,
    ),
    ...record.sourceReviews.map(({ definitionSha256, sourceReviewId }) =>
      exact("source_review", sourceReviewId, definitionSha256),
    ),
  ];
}

function rejectionReferences(record: EvaluationRunRejection): readonly EvaluationRecordReference[] {
  return [
    exact(
      "criterion_set",
      record.criterion.criterionSet.criterionSetVersionId,
      record.criterion.criterionSet.definitionSha256,
    ),
    exact(
      "criterion_set_status",
      record.criterionStatus.statusRecordId,
      record.criterionStatus.definitionSha256,
    ),
    ...record.sourceReviews.map(({ definitionSha256, sourceReviewId }) =>
      exact("source_review", sourceReviewId, definitionSha256),
    ),
  ];
}

function aggregateReferences(record: EvaluationAggregate): readonly EvaluationRecordReference[] {
  return [
    exact(
      "aggregation_policy",
      record.aggregationPolicy.policyVersionId,
      record.aggregationPolicy.definitionSha256,
    ),
    exact(
      "criterion_set",
      record.criterion.criterionSet.criterionSetVersionId,
      record.criterion.criterionSet.definitionSha256,
    ),
    ...record.members.flatMap(({ result, run }) => [
      exact("evaluation_run", run.evaluationRunId, run.definitionSha256),
      exact("evaluation_run_result", result.resultId, result.definitionSha256),
    ]),
  ];
}

function assessmentReferences(record: Assessment): readonly EvaluationRecordReference[] {
  return [
    exact("evaluation_aggregate", record.aggregate.aggregateId, record.aggregate.definitionSha256),
    exact(
      "aggregation_policy",
      record.aggregationPolicy.policyVersionId,
      record.aggregationPolicy.definitionSha256,
    ),
    exact(
      "criterion_set",
      record.criterion.criterionSet.criterionSetVersionId,
      record.criterion.criterionSet.definitionSha256,
    ),
    exact(
      "criterion_set_status",
      record.criterionStatus.statusRecordId,
      record.criterionStatus.definitionSha256,
    ),
    ...record.runs.map(({ definitionSha256, evaluationRunId }) =>
      exact("evaluation_run", evaluationRunId, definitionSha256),
    ),
    ...record.observations.map(({ definitionSha256, observationId }) =>
      exact("raw_observation", observationId, definitionSha256),
    ),
    ...record.qualifications.map(({ definitionSha256, qualificationReportId }) =>
      exact("qualification_report", qualificationReportId, definitionSha256),
    ),
    ...record.sourceReviews.map(({ definitionSha256, sourceReviewId }) =>
      exact("source_review", sourceReviewId, definitionSha256),
    ),
    ...record.counterevidence.flatMap((reference) =>
      reference.kind === "source_snapshot"
        ? [
            exact(
              "source_snapshot",
              reference.source.sourceSnapshotId,
              reference.source.definitionSha256,
            ),
          ]
        : [],
    ),
  ];
}

export function evaluationRecordReferences(
  kind: EvaluationRecordKind,
  record: EvaluationStoredRecord,
): readonly EvaluationRecordReference[] {
  switch (kind) {
    case "aggregation_policy":
    case "discovery_record":
      return [];
    case "assessment":
      return assessmentReferences(record as Assessment);
    case "criterion_set":
      return criterionSetReferences(record as CriterionSet);
    case "criterion_set_status":
      return criterionStatusReferences(record as CriterionSetStatusRecord);
    case "evaluation_aggregate":
      return aggregateReferences(record as EvaluationAggregate);
    case "evaluation_run":
      return runReferences(record as EvaluationRun);
    case "evaluation_run_rejection":
      return rejectionReferences(record as EvaluationRunRejection);
    case "evaluation_run_result": {
      const result = record as EvaluationRunResult;
      return [
        exact("evaluation_run", result.evaluationRunId),
        ...result.observations.map(({ definitionSha256, observationId }) =>
          exact("raw_observation", observationId, definitionSha256),
        ),
      ];
    }
    case "evaluator_spec":
      return evaluatorReferences(record as EvaluatorSpec);
    case "oracle_spec":
      return oracleReferences(record as OracleSpec);
    case "qualification_fixture_set":
      return qualificationFixtureSetReferences(record as QualificationFixtureSet);
    case "qualification_report":
      return qualificationReportReferences(record as QualificationReport);
    case "raw_observation": {
      const observation = record as RawObservation;
      return [
        exact("evaluation_run", observation.run.evaluationRunId, observation.run.definitionSha256),
      ];
    }
    case "source_review":
      return sourceReviewReferences(record as SourceReviewRecord);
    case "source_snapshot":
      return sourceSnapshotReferences(record as SourceSnapshot);
  }
}

export function evaluationRecordUniqueBinding(
  kind: EvaluationRecordKind,
  record: EvaluationStoredRecord,
): { readonly key: string; readonly value: string } | null {
  if (kind === "evaluation_run_result") {
    const result = record as EvaluationRunResult;
    return { key: `evaluation_run_result:run:${result.evaluationRunId}`, value: result.resultId };
  }
  if (kind === "raw_observation") {
    const observation = record as RawObservation;
    return {
      key: `raw_observation:attempt:${observation.run.evaluationRunId}:${observation.attemptId}`,
      value: observation.observationId,
    };
  }
  return null;
}

/** Exact-scope, immutable in-memory implementation of the complete evaluation repository port. */
export class MemoryEvaluationRepository implements EvaluationRepository {
  private readonly tenants = new Map<string, TenantState>();

  private async find<RecordType>(
    kind: EvaluationRecordKind,
    scope: EvidenceScope,
    recordId: string,
  ): Promise<RecordType | null> {
    const record = this.tenants.get(scope.tenantId)?.records.get(recordKey(kind, recordId));
    if (!record || !scopesEqual(record.scope, scope)) return null;
    return clone(record) as RecordType;
  }

  private async publish<RecordType extends EvaluationStoredRecord>(
    kind: EvaluationRecordKind,
    candidate: RecordType,
  ): Promise<PublishEvaluationRecordResult<RecordType>> {
    const validated = validateEvaluationRecord(kind, candidate) as RecordType;
    const id = evaluationRecordId(kind, validated);
    const current = this.tenants.get(validated.scope.tenantId) ?? emptyTenantState();
    const existing = current.records.get(recordKey(kind, id));
    if (existing) {
      if (existing.definitionSha256 !== validated.definitionSha256) {
        throw new EvaluationRecordConflictError(kind, id);
      }
      return { created: false, record: clone(existing) as RecordType };
    }

    const resource = evaluationResource(kind, validated);
    if (resource) {
      const key = `${resource.kind}:${resource.resourceId}`;
      const boundScope = current.resources.get(key);
      if (boundScope && !scopesEqual(boundScope, validated.scope)) {
        throw new EvaluationResourceConflictError(resource.kind, resource.resourceId);
      }
    }

    for (const reference of evaluationRecordReferences(kind, validated)) {
      const stored = current.records.get(recordKey(reference.recordKind, reference.recordId));
      if (
        !stored ||
        !scopesEqual(stored.scope, validated.scope) ||
        (reference.definitionSha256 !== undefined &&
          stored.definitionSha256 !== reference.definitionSha256)
      ) {
        throw new EvaluationLineageError(kind, id, reference.recordKind, reference.recordId);
      }
    }

    const binding = evaluationRecordUniqueBinding(kind, validated);
    if (binding) {
      const existingId = current.uniqueBindings.get(binding.key);
      if (existingId !== undefined && existingId !== binding.value) {
        throw new EvaluationRecordConflictError(kind, binding.value);
      }
    }

    const next = copyTenantState(current);
    const stored = clone(validated);
    next.records.set(recordKey(kind, id), stored);
    if (resource) {
      next.resources.set(`${resource.kind}:${resource.resourceId}`, clone(validated.scope));
    }
    if (binding) next.uniqueBindings.set(binding.key, binding.value);
    this.tenants.set(validated.scope.tenantId, next);
    return { created: true, record: clone(stored) as RecordType };
  }

  async findAggregationPolicy(scope: EvidenceScope, id: string) {
    return this.find<EvaluationAggregationPolicy>("aggregation_policy", scope, id);
  }
  async findAssessment(scope: EvidenceScope, id: string) {
    return this.find<Assessment>("assessment", scope, id);
  }
  async findCriterionSet(scope: EvidenceScope, id: string) {
    return this.find<CriterionSet>("criterion_set", scope, id);
  }
  async findCriterionSetStatus(scope: EvidenceScope, id: string) {
    return this.find<CriterionSetStatusRecord>("criterion_set_status", scope, id);
  }
  async findDiscoveryRecord(scope: EvidenceScope, id: string) {
    return this.find<DiscoveryRecord>("discovery_record", scope, id);
  }
  async findEvaluationAggregate(scope: EvidenceScope, id: string) {
    return this.find<EvaluationAggregate>("evaluation_aggregate", scope, id);
  }
  async findEvaluationRun(scope: EvidenceScope, id: string) {
    return this.find<EvaluationRun>("evaluation_run", scope, id);
  }
  async findEvaluationRunRejection(scope: EvidenceScope, id: string) {
    return this.find<EvaluationRunRejection>("evaluation_run_rejection", scope, id);
  }
  async findEvaluationRunResult(scope: EvidenceScope, id: string) {
    return this.find<EvaluationRunResult>("evaluation_run_result", scope, id);
  }
  async findEvaluatorSpec(scope: EvidenceScope, id: string) {
    return this.find<EvaluatorSpec>("evaluator_spec", scope, id);
  }
  async findOracleSpec(scope: EvidenceScope, id: string) {
    return this.find<OracleSpec>("oracle_spec", scope, id);
  }
  async findQualificationFixtureSet(scope: EvidenceScope, id: string) {
    return this.find<QualificationFixtureSet>("qualification_fixture_set", scope, id);
  }
  async findQualificationReport(scope: EvidenceScope, id: string) {
    return this.find<QualificationReport>("qualification_report", scope, id);
  }
  async findRawObservation(scope: EvidenceScope, id: string) {
    return this.find<RawObservation>("raw_observation", scope, id);
  }
  async findSourceReview(scope: EvidenceScope, id: string) {
    return this.find<SourceReviewRecord>("source_review", scope, id);
  }
  async findSourceSnapshot(scope: EvidenceScope, id: string) {
    return this.find<SourceSnapshot>("source_snapshot", scope, id);
  }

  async publishAggregationPolicy(candidate: EvaluationAggregationPolicy) {
    return this.publish("aggregation_policy", candidate);
  }
  async publishAssessment(candidate: Assessment) {
    return this.publish("assessment", candidate);
  }
  async publishCriterionSet(candidate: CriterionSet) {
    return this.publish("criterion_set", candidate);
  }
  async publishCriterionSetStatus(candidate: CriterionSetStatusRecord) {
    return this.publish("criterion_set_status", candidate);
  }
  async publishDiscoveryRecord(candidate: DiscoveryRecord) {
    return this.publish("discovery_record", candidate);
  }
  async publishEvaluationAggregate(candidate: EvaluationAggregate) {
    return this.publish("evaluation_aggregate", candidate);
  }
  async publishEvaluationRun(candidate: EvaluationRun) {
    return this.publish("evaluation_run", candidate);
  }
  async publishEvaluationRunRejection(candidate: EvaluationRunRejection) {
    return this.publish("evaluation_run_rejection", candidate);
  }
  async publishEvaluationRunResult(candidate: EvaluationRunResult) {
    return this.publish("evaluation_run_result", candidate);
  }
  async publishEvaluatorSpec(candidate: EvaluatorSpec) {
    return this.publish("evaluator_spec", candidate);
  }
  async publishOracleSpec(candidate: OracleSpec) {
    return this.publish("oracle_spec", candidate);
  }
  async publishQualificationFixtureSet(candidate: QualificationFixtureSet) {
    return this.publish("qualification_fixture_set", candidate);
  }
  async publishQualificationReport(candidate: QualificationReport) {
    return this.publish("qualification_report", candidate);
  }
  async publishRawObservation(candidate: RawObservation) {
    return this.publish("raw_observation", candidate);
  }
  async publishSourceReview(candidate: SourceReviewRecord) {
    return this.publish("source_review", candidate);
  }
  async publishSourceSnapshot(candidate: SourceSnapshot) {
    return this.publish("source_snapshot", candidate);
  }
}
