import assert from "node:assert/strict";
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
import type {
  EvaluationRepository,
  PublishEvaluationRecordResult,
} from "../evaluation/evaluation-repository.js";
import {
  EvaluationLineageError,
  EvaluationRecordConflictError,
  type EvaluationRecordKind,
  EvaluationResourceConflictError,
  InvalidEvaluationRecordInputError,
} from "../evaluation/evaluation-repository-errors.js";

interface RecordByKind {
  readonly aggregation_policy: EvaluationAggregationPolicy;
  readonly assessment: Assessment;
  readonly criterion_set: CriterionSet;
  readonly criterion_set_status: CriterionSetStatusRecord;
  readonly discovery_record: DiscoveryRecord;
  readonly evaluation_aggregate: EvaluationAggregate;
  readonly evaluation_run: EvaluationRun;
  readonly evaluation_run_rejection: EvaluationRunRejection;
  readonly evaluation_run_result: EvaluationRunResult;
  readonly evaluator_spec: EvaluatorSpec;
  readonly oracle_spec: OracleSpec;
  readonly qualification_fixture_set: QualificationFixtureSet;
  readonly qualification_report: QualificationReport;
  readonly raw_observation: RawObservation;
  readonly source_review: SourceReviewRecord;
  readonly source_snapshot: SourceSnapshot;
}

export type EvaluationRepositoryFixtureRecord = {
  readonly [Kind in EvaluationRecordKind]: {
    readonly kind: Kind;
    readonly record: RecordByKind[Kind];
  };
}[EvaluationRecordKind];

export interface EvaluationRepositoryTestHarness {
  readonly recordConflict: EvaluationRepositoryFixtureRecord;
  readonly dispose?: () => Promise<void>;
  readonly lineageProbe: EvaluationRepositoryFixtureRecord;
  readonly otherScope: EvidenceScope;
  readonly records: readonly EvaluationRepositoryFixtureRecord[];
  readonly repository: EvaluationRepository;
  readonly resourceConflict: EvaluationRepositoryFixtureRecord;
  readonly scope: EvidenceScope;
  readonly uniquenessConflicts: readonly EvaluationRepositoryFixtureRecord[];
}

export type EvaluationRepositoryTestFactory = (
  namespace: string,
) => Promise<EvaluationRepositoryTestHarness> | EvaluationRepositoryTestHarness;

export interface EvaluationRepositoryConformanceCase {
  readonly name: string;
  readonly run: (factory: EvaluationRepositoryTestFactory) => Promise<void>;
}

const allKinds: readonly EvaluationRecordKind[] = [
  "aggregation_policy",
  "assessment",
  "criterion_set",
  "criterion_set_status",
  "discovery_record",
  "evaluation_aggregate",
  "evaluation_run",
  "evaluation_run_rejection",
  "evaluation_run_result",
  "evaluator_spec",
  "oracle_spec",
  "qualification_fixture_set",
  "qualification_report",
  "raw_observation",
  "source_review",
  "source_snapshot",
];

export async function publishEvaluationFixture(
  repository: EvaluationRepository,
  fixture: EvaluationRepositoryFixtureRecord,
): Promise<PublishEvaluationRecordResult<RecordByKind[EvaluationRecordKind]>> {
  switch (fixture.kind) {
    case "aggregation_policy":
      return repository.publishAggregationPolicy(fixture.record);
    case "assessment":
      return repository.publishAssessment(fixture.record);
    case "criterion_set":
      return repository.publishCriterionSet(fixture.record);
    case "criterion_set_status":
      return repository.publishCriterionSetStatus(fixture.record);
    case "discovery_record":
      return repository.publishDiscoveryRecord(fixture.record);
    case "evaluation_aggregate":
      return repository.publishEvaluationAggregate(fixture.record);
    case "evaluation_run":
      return repository.publishEvaluationRun(fixture.record);
    case "evaluation_run_rejection":
      return repository.publishEvaluationRunRejection(fixture.record);
    case "evaluation_run_result":
      return repository.publishEvaluationRunResult(fixture.record);
    case "evaluator_spec":
      return repository.publishEvaluatorSpec(fixture.record);
    case "oracle_spec":
      return repository.publishOracleSpec(fixture.record);
    case "qualification_fixture_set":
      return repository.publishQualificationFixtureSet(fixture.record);
    case "qualification_report":
      return repository.publishQualificationReport(fixture.record);
    case "raw_observation":
      return repository.publishRawObservation(fixture.record);
    case "source_review":
      return repository.publishSourceReview(fixture.record);
    case "source_snapshot":
      return repository.publishSourceSnapshot(fixture.record);
  }
}

function recordId(fixture: EvaluationRepositoryFixtureRecord): string {
  switch (fixture.kind) {
    case "aggregation_policy":
      return fixture.record.policyVersionId;
    case "assessment":
      return fixture.record.assessmentId;
    case "criterion_set":
      return fixture.record.criterionSetVersionId;
    case "criterion_set_status":
      return fixture.record.statusRecordId;
    case "discovery_record":
      return fixture.record.discoveryId;
    case "evaluation_aggregate":
      return fixture.record.aggregateId;
    case "evaluation_run":
      return fixture.record.evaluationRunId;
    case "evaluation_run_rejection":
      return fixture.record.rejectionId;
    case "evaluation_run_result":
      return fixture.record.resultId;
    case "evaluator_spec":
      return fixture.record.evaluatorVersionId;
    case "oracle_spec":
      return fixture.record.oracleVersionId;
    case "qualification_fixture_set":
      return fixture.record.fixtureSetVersionId;
    case "qualification_report":
      return fixture.record.qualificationReportId;
    case "raw_observation":
      return fixture.record.observationId;
    case "source_review":
      return fixture.record.sourceReviewId;
    case "source_snapshot":
      return fixture.record.sourceSnapshotId;
  }
}

async function findFixture(
  repository: EvaluationRepository,
  scope: EvidenceScope,
  fixture: EvaluationRepositoryFixtureRecord,
) {
  const id = recordId(fixture);
  switch (fixture.kind) {
    case "aggregation_policy":
      return repository.findAggregationPolicy(scope, id);
    case "assessment":
      return repository.findAssessment(scope, id);
    case "criterion_set":
      return repository.findCriterionSet(scope, id);
    case "criterion_set_status":
      return repository.findCriterionSetStatus(scope, id);
    case "discovery_record":
      return repository.findDiscoveryRecord(scope, id);
    case "evaluation_aggregate":
      return repository.findEvaluationAggregate(scope, id);
    case "evaluation_run":
      return repository.findEvaluationRun(scope, id);
    case "evaluation_run_rejection":
      return repository.findEvaluationRunRejection(scope, id);
    case "evaluation_run_result":
      return repository.findEvaluationRunResult(scope, id);
    case "evaluator_spec":
      return repository.findEvaluatorSpec(scope, id);
    case "oracle_spec":
      return repository.findOracleSpec(scope, id);
    case "qualification_fixture_set":
      return repository.findQualificationFixtureSet(scope, id);
    case "qualification_report":
      return repository.findQualificationReport(scope, id);
    case "raw_observation":
      return repository.findRawObservation(scope, id);
    case "source_review":
      return repository.findSourceReview(scope, id);
    case "source_snapshot":
      return repository.findSourceSnapshot(scope, id);
  }
}

async function withHarness(
  factory: EvaluationRepositoryTestFactory,
  namespace: string,
  test: (harness: EvaluationRepositoryTestHarness) => Promise<void>,
): Promise<void> {
  const harness = await factory(namespace);
  try {
    await test(harness);
  } finally {
    await harness.dispose?.();
  }
}

async function publishGraph(harness: EvaluationRepositoryTestHarness): Promise<void> {
  for (const fixture of harness.records) {
    const result = await publishEvaluationFixture(harness.repository, fixture);
    assert.equal(result.created, true, `${fixture.kind} must be created once`);
    assert.deepEqual(result.record, fixture.record, `${fixture.kind} must return its stored value`);
  }
}

export const evaluationRepositoryConformanceCases: readonly EvaluationRepositoryConformanceCase[] =
  [
    {
      name: "publishes and reads the complete immutable evaluation graph in dependency order",
      async run(factory) {
        await withHarness(factory, "complete_graph", async (harness) => {
          assert.deepEqual(
            [...new Set(harness.records.map(({ kind }) => kind))].sort(),
            [...allKinds],
            "fixture graph must exercise every evaluation record kind",
          );
          await publishGraph(harness);
          for (const fixture of harness.records) {
            assert.deepEqual(
              await findFixture(harness.repository, harness.scope, fixture),
              fixture.record,
              `${fixture.kind} exact-scope read must reconstruct the record`,
            );
          }
        });
      },
    },
    {
      name: "returns authoritative clones for identical retries and hides every cross-scope record",
      async run(factory) {
        await withHarness(factory, "retry_and_isolation", async (harness) => {
          await publishGraph(harness);
          for (const fixture of harness.records) {
            const retry = await publishEvaluationFixture(
              harness.repository,
              structuredClone(fixture),
            );
            assert.equal(retry.created, false, `${fixture.kind} retry must be idempotent`);
            assert.deepEqual(retry.record, fixture.record);
            retry.record.definitionSha256 = "0".repeat(64);
            assert.deepEqual(
              await findFixture(harness.repository, harness.scope, fixture),
              fixture.record,
            );
            assert.equal(await findFixture(harness.repository, harness.otherScope, fixture), null);
          }
        });
      },
    },
    {
      name: "rejects invalid digests before visibility and missing lineage without partial state",
      async run(factory) {
        await withHarness(factory, "invalid_and_lineage", async (harness) => {
          const first = structuredClone(harness.records[0]);
          assert.ok(first, "fixture graph must not be empty");
          first.record.definitionSha256 = "0".repeat(64);
          await assert.rejects(
            publishEvaluationFixture(harness.repository, first),
            InvalidEvaluationRecordInputError,
          );
          assert.equal(await findFixture(harness.repository, harness.scope, first), null);

          await assert.rejects(
            publishEvaluationFixture(harness.repository, harness.lineageProbe),
            EvaluationLineageError,
          );
          assert.equal(
            await findFixture(harness.repository, harness.scope, harness.lineageProbe),
            null,
          );
        });
      },
    },
    {
      name: "rejects semantic, tenant-resource, and terminal uniqueness rebinding atomically",
      async run(factory) {
        await withHarness(factory, "conflict_bindings", async (harness) => {
          await publishGraph(harness);
          await assert.rejects(
            publishEvaluationFixture(harness.repository, harness.recordConflict),
            EvaluationRecordConflictError,
          );
          await assert.rejects(
            publishEvaluationFixture(harness.repository, harness.resourceConflict),
            EvaluationResourceConflictError,
          );
          assert.equal(
            await findFixture(
              harness.repository,
              harness.resourceConflict.record.scope,
              harness.resourceConflict,
            ),
            null,
          );
          for (const conflict of harness.uniquenessConflicts) {
            await assert.rejects(
              publishEvaluationFixture(harness.repository, conflict),
              EvaluationRecordConflictError,
            );
            assert.equal(await findFixture(harness.repository, harness.scope, conflict), null);
          }
        });
      },
    },
  ];
