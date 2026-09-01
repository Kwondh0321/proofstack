import type {
  EvaluationAggregate,
  EvaluationRecordEnvelope,
  EvaluationRecordKind,
  EvaluationRun,
  EvaluationRunResult,
  PrincipalContext,
  RawObservation,
} from "@proofstack/contracts";
import type { EvaluationDefinitionByKind, RecordEvaluationCommand } from "@proofstack/core";
import type { EvaluationWorkerOperations } from "@proofstack/evaluation-worker";
import type { ProofStackEvaluationClient } from "@proofstack/sdk";
import { EvaluationScenario, type ReferenceVerdict } from "./scenario.js";

type EvaluationClient = Pick<
  ProofStackEvaluationClient,
  | "createAssessment"
  | "publishDefinition"
  | "readRecord"
  | "recordCriterionSetStatus"
  | "recordRunDecision"
>;

type EnvelopeFor<Kind extends EvaluationRecordKind> = Extract<
  EvaluationRecordEnvelope,
  { readonly kind: Kind }
>;

type WorkerKind =
  | "evaluation_aggregate"
  | "evaluation_run_result"
  | "qualification_report"
  | "raw_observation";

interface RecordReference {
  readonly kind: EvaluationRecordKind;
  readonly recordId: string;
}

export interface RunEvaluationControlFlowOptions {
  readonly client: EvaluationClient;
  readonly environmentId: string;
  readonly namespace: string;
  readonly projectId: string;
  readonly worker: EvaluationWorkerOperations;
}

export interface EvaluationControlFlowSummary {
  readonly aggregate: {
    readonly aggregateId: string;
    readonly counts: EvaluationAggregate["counts"];
    readonly coverage: EvaluationAggregate["coverage"];
    readonly definitionSha256: string;
  };
  readonly assessment: {
    readonly assessmentId: string;
    readonly definitionSha256: string;
    readonly eligibility: EnvelopeFor<"assessment">["record"]["eligibility"];
    readonly supportStatus: EnvelopeFor<"assessment">["record"]["supportStatus"];
  };
  readonly criterion: {
    readonly criterionSetVersionId: string;
    readonly status: EnvelopeFor<"criterion_set_status">["record"]["status"];
  };
  readonly readBack: {
    readonly kinds: readonly EvaluationRecordKind[];
    readonly recordCount: number;
  };
  readonly sources: {
    readonly criticalConflictStatus: EnvelopeFor<"source_review">["record"]["criticalConflictStatus"];
    readonly freshnessConclusion: EnvelopeFor<"source_review">["record"]["freshnessConclusion"];
    readonly outcome: EnvelopeFor<"source_review">["record"]["outcome"];
  };
  readonly verdicts: Readonly<Record<ReferenceVerdict, number>>;
}

const referenceVerdicts = ["pass", "fail", "abstain", "error", "not_applicable"] as const;

function responseRecord<Kind extends EvaluationRecordKind>(
  envelope: EvaluationRecordEnvelope,
  expectedKind: Kind,
): EnvelopeFor<Kind>["record"] {
  if (envelope.kind !== expectedKind) {
    throw new TypeError(`Expected ${expectedKind}, received ${envelope.kind}`);
  }
  return envelope.record as EnvelopeFor<Kind>["record"];
}

function workerPrincipal(
  projectId: string,
  environmentId: string,
  requestId: string,
): PrincipalContext {
  return {
    authentication: {
      authenticatedAt: "2026-09-02T00:00:00.000Z",
      credentialId: "cred_evaluation_worker",
      method: "service_token",
    },
    capabilities: ["evaluation:run"],
    principalId: "svc_evaluator",
    principalType: "service",
    requestId,
    resourceScope: {
      mode: "restricted",
      projects: [{ environmentIds: [environmentId], projectId }],
    },
    roles: ["member"],
    tenantId: "ten_local",
  };
}

function workerCommand<Kind extends WorkerKind>(
  options: RunEvaluationControlFlowOptions,
  kind: Kind,
  recordId: string,
  definition: EvaluationDefinitionByKind[Kind],
  sequence: number,
): RecordEvaluationCommand<Kind> {
  return {
    definition,
    environmentId: options.environmentId,
    kind,
    principal: workerPrincipal(
      options.projectId,
      options.environmentId,
      `req_${options.namespace}_worker_${sequence}`,
    ),
    projectId: options.projectId,
    recordId,
  };
}

async function verifyDurableReadBack(
  client: EvaluationClient,
  references: readonly RecordReference[],
): Promise<EvaluationRecordKind[]> {
  const seen = new Set<string>();
  const kinds = new Set<EvaluationRecordKind>();
  for (const reference of references) {
    const key = `${reference.kind}:${reference.recordId}`;
    if (seen.has(key)) throw new TypeError(`Duplicate reference flow read-back target: ${key}`);
    seen.add(key);
    const response = await client.readRecord(reference);
    responseRecord(response.result, reference.kind);
    kinds.add(reference.kind);
  }
  return [...kinds].sort();
}

/**
 * Runs one deliberately contested evaluation through the public API and the narrow worker port.
 * The expected result is conservative: evidence remains inspectable, but it is not release-eligible.
 */
export async function runEvaluationControlFlow(
  options: RunEvaluationControlFlowOptions,
): Promise<EvaluationControlFlowSummary> {
  const scenario = new EvaluationScenario({
    environmentId: options.environmentId,
    namespace: options.namespace,
  });
  const references: RecordReference[] = [];
  const remember = (kind: EvaluationRecordKind, recordId: string): void => {
    references.push({ kind, recordId });
  };

  const discovery = responseRecord(
    (
      await options.client.publishDefinition({
        recordId: `dsc_primary_${options.namespace}`,
        request: { definition: scenario.discovery(), kind: "discovery_record" },
      })
    ).result,
    "discovery_record",
  );
  remember("discovery_record", discovery.discoveryId);

  const conflictSource = responseRecord(
    (
      await options.client.publishDefinition({
        recordId: scenario.ids.sourceConflict,
        request: { definition: scenario.conflictingSource(), kind: "source_snapshot" },
      })
    ).result,
    "source_snapshot",
  );
  remember("source_snapshot", conflictSource.sourceSnapshotId);

  const primarySource = responseRecord(
    (
      await options.client.publishDefinition({
        recordId: scenario.ids.sourcePrimary,
        request: {
          definition: scenario.primarySource(discovery, conflictSource),
          kind: "source_snapshot",
        },
      })
    ).result,
    "source_snapshot",
  );
  remember("source_snapshot", primarySource.sourceSnapshotId);

  const conflictReview = responseRecord(
    (
      await options.client.publishDefinition({
        recordId: scenario.ids.sourceReviewConflict,
        request: {
          definition: scenario.conflictingSourceReview(conflictSource),
          kind: "source_review",
        },
      })
    ).result,
    "source_review",
  );
  remember("source_review", conflictReview.sourceReviewId);

  const primaryReview = responseRecord(
    (
      await options.client.publishDefinition({
        recordId: scenario.ids.sourceReviewPrimary,
        request: {
          definition: scenario.primarySourceReview(primarySource, conflictSource),
          kind: "source_review",
        },
      })
    ).result,
    "source_review",
  );
  remember("source_review", primaryReview.sourceReviewId);

  const fixtureSet = responseRecord(
    (
      await options.client.publishDefinition({
        recordId: scenario.ids.fixtureSetVersion,
        request: {
          definition: scenario.qualificationFixtureSet(),
          kind: "qualification_fixture_set",
        },
      })
    ).result,
    "qualification_fixture_set",
  );
  remember("qualification_fixture_set", fixtureSet.fixtureSetVersionId);

  const oracle = responseRecord(
    (
      await options.client.publishDefinition({
        recordId: scenario.ids.oracleVersion,
        request: { definition: scenario.oracle(fixtureSet), kind: "oracle_spec" },
      })
    ).result,
    "oracle_spec",
  );
  remember("oracle_spec", oracle.oracleVersionId);

  const evaluator = responseRecord(
    (
      await options.client.publishDefinition({
        recordId: scenario.ids.evaluatorVersion,
        request: {
          definition: scenario.evaluator(fixtureSet, oracle),
          kind: "evaluator_spec",
        },
      })
    ).result,
    "evaluator_spec",
  );
  remember("evaluator_spec", evaluator.evaluatorVersionId);

  const criterionSet = responseRecord(
    (
      await options.client.publishDefinition({
        recordId: scenario.ids.criterionSetVersion,
        request: {
          definition: scenario.criterionSet({
            conflictReview,
            conflictSource,
            evaluator,
            oracle,
            primaryReview,
            primarySource,
          }),
          kind: "criterion_set",
        },
      })
    ).result,
    "criterion_set",
  );
  remember("criterion_set", criterionSet.criterionSetVersionId);

  const policy = responseRecord(
    (
      await options.client.publishDefinition({
        recordId: scenario.ids.policyVersion,
        request: { definition: scenario.aggregationPolicy(), kind: "aggregation_policy" },
      })
    ).result,
    "aggregation_policy",
  );
  remember("aggregation_policy", policy.policyVersionId);

  const draftStatus = responseRecord(
    (
      await options.client.recordCriterionSetStatus({
        recordId: scenario.ids.statusDraft,
        request: {
          definition: scenario.draftStatus(criterionSet),
          kind: "criterion_set_status",
        },
      })
    ).result,
    "criterion_set_status",
  );
  remember("criterion_set_status", draftStatus.statusRecordId);

  const approvedStatus = responseRecord(
    (
      await options.client.recordCriterionSetStatus({
        recordId: scenario.ids.statusApproved,
        request: {
          definition: scenario.approvedStatus(criterionSet, draftStatus),
          kind: "criterion_set_status",
        },
      })
    ).result,
    "criterion_set_status",
  );
  remember("criterion_set_status", approvedStatus.statusRecordId);

  let workerSequence = 0;
  const oracleQualification = (
    await options.worker.recordQualificationReport(
      workerCommand(
        options,
        "qualification_report",
        `qlr_oracle_${options.namespace}`,
        scenario.qualificationReport(oracle, fixtureSet),
        workerSequence++,
      ),
    )
  ).record;
  remember("qualification_report", oracleQualification.qualificationReportId);
  const evaluatorQualification = (
    await options.worker.recordQualificationReport(
      workerCommand(
        options,
        "qualification_report",
        `qlr_evaluator_${options.namespace}`,
        scenario.qualificationReport(evaluator, fixtureSet),
        workerSequence++,
      ),
    )
  ).record;
  remember("qualification_report", evaluatorQualification.qualificationReportId);

  const runs: EvaluationRun[] = [];
  const observations: RawObservation[] = [];
  const results: EvaluationRunResult[] = [];
  for (const verdict of referenceVerdicts) {
    const run = responseRecord(
      (
        await options.client.recordRunDecision({
          recordId: `evr_${verdict}_${options.namespace}`,
          request: {
            definition: scenario.run({
              criterionSet,
              evaluator,
              evaluatorQualification,
              oracle,
              oracleQualification,
              policy,
              sourceReviews: [conflictReview, primaryReview],
              status: approvedStatus,
              verdict,
            }),
            kind: "evaluation_run",
          },
        })
      ).result,
      "evaluation_run",
    );
    runs.push(run);
    remember("evaluation_run", run.evaluationRunId);

    let observation: RawObservation | undefined;
    if (verdict !== "not_applicable") {
      observation = (
        await options.worker.recordRawObservation(
          workerCommand(
            options,
            "raw_observation",
            `obs_${verdict}_${options.namespace}`,
            scenario.observation(run, verdict),
            workerSequence++,
          ),
        )
      ).record;
      observations.push(observation);
      remember("raw_observation", observation.observationId);
    }

    const result = (
      await options.worker.recordEvaluationRunResult(
        workerCommand(
          options,
          "evaluation_run_result",
          `evs_${verdict}_${options.namespace}`,
          scenario.result(run, verdict, observation),
          workerSequence++,
        ),
      )
    ).record;
    results.push(result);
    remember("evaluation_run_result", result.resultId);
  }

  const aggregate = (
    await options.worker.createEvaluationAggregate(
      workerCommand(
        options,
        "evaluation_aggregate",
        scenario.ids.aggregate,
        scenario.aggregate(policy, criterionSet, runs, results),
        workerSequence++,
      ),
    )
  ).record;
  remember("evaluation_aggregate", aggregate.aggregateId);

  const assessment = responseRecord(
    (
      await options.client.createAssessment({
        recordId: scenario.ids.assessment,
        request: {
          definition: scenario.assessment({
            aggregate,
            criterionSet,
            observations,
            policy,
            qualifications: [oracleQualification, evaluatorQualification],
            reviews: [conflictReview, primaryReview],
            runs,
            sources: [conflictSource, primarySource],
            status: approvedStatus,
          }),
          kind: "assessment",
        },
      })
    ).result,
    "assessment",
  );
  remember("assessment", assessment.assessmentId);

  const kinds = await verifyDurableReadBack(options.client, references);
  const verdicts: Record<ReferenceVerdict, number> = {
    abstain: 0,
    error: 0,
    fail: 0,
    not_applicable: 0,
    pass: 0,
  };
  for (const result of results) verdicts[result.verdict] += 1;

  return {
    aggregate: {
      aggregateId: aggregate.aggregateId,
      counts: aggregate.counts,
      coverage: aggregate.coverage,
      definitionSha256: aggregate.definitionSha256,
    },
    assessment: {
      assessmentId: assessment.assessmentId,
      definitionSha256: assessment.definitionSha256,
      eligibility: assessment.eligibility,
      supportStatus: assessment.supportStatus,
    },
    criterion: {
      criterionSetVersionId: criterionSet.criterionSetVersionId,
      status: approvedStatus.status,
    },
    readBack: { kinds, recordCount: references.length },
    sources: {
      criticalConflictStatus: primaryReview.criticalConflictStatus,
      freshnessConclusion: primaryReview.freshnessConclusion,
      outcome: primaryReview.outcome,
    },
    verdicts,
  };
}
