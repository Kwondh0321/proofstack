import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  AssessmentDefinitionSchema,
  CriterionSetDefinitionSchema,
  CriterionSetStatusDefinitionSchema,
  DiscoveryRecordDefinitionSchema,
  encodeEvaluationCanonicalJson,
  EvaluationAggregationPolicyDefinitionSchema,
  EvaluationRunDefinitionSchema,
  EvaluationRunResultDefinitionSchema,
  EvaluatorSpecDefinitionSchema,
  OpaqueIdSchema,
  OracleSpecDefinitionSchema,
  QualificationFixtureSetDefinitionSchema,
  QualificationReportDefinitionSchema,
  RawObservationDefinitionSchema,
  SourceReviewDefinitionSchema,
  SourceSnapshotDefinitionSchema,
  type AssessmentDefinition,
  type CriterionSet,
  type CriterionSetDefinition,
  type CriterionSetStatusDefinition,
  type CriterionSetStatusRecord,
  type DiscoveryRecordDefinition,
  type EvaluationAggregateDefinition,
  type EvaluationAggregationPolicy,
  type EvaluationAggregationPolicyDefinition,
  type EvaluationRun,
  type EvaluationRunDefinition,
  type EvaluationRunResult,
  type EvaluationRunResultDefinition,
  type EvaluationVerdict,
  type EvaluatorSpec,
  type EvaluatorSpecDefinition,
  type OracleSpec,
  type OracleSpecDefinition,
  type QualificationFixtureSet,
  type QualificationFixtureSetDefinition,
  type QualificationReport,
  type QualificationReportDefinition,
  type RawObservation,
  type RawObservationDefinition,
  type SourceReviewDefinition,
  type SourceReviewRecord,
  type SourceSnapshot,
  type SourceSnapshotDefinition,
} from "@proofstack/contracts";
import { buildReferenceAggregate, evaluateApplicability } from "@proofstack/core";

type ExecutedVerdict = Exclude<EvaluationVerdict, "not_applicable">;
export type ReferenceVerdict = EvaluationVerdict;

interface StoredVector {
  readonly input: { readonly definition: Record<string, unknown> };
  readonly kind: string;
}

interface MutableObject {
  [key: string]: unknown;
}

const vectorFiles = [
  "evaluation-source-definition-v1.json",
  "evaluation-criteria-definition-v1.json",
  "evaluation-spec-definition-v1.json",
  "evaluation-qualification-definition-v1.json",
  "evaluation-run-definition-v1.json",
  "evaluation-assessment-definition-v1.json",
] as const;

const vectors = vectorFiles.flatMap(
  (file) =>
    (
      JSON.parse(
        readFileSync(
          new URL(`../../../packages/contracts/vectors/${file}`, import.meta.url),
          "utf8",
        ),
      ) as { readonly vectors: readonly StoredVector[] }
    ).vectors,
);

function template(kind: string): MutableObject {
  const vector = vectors.find((candidate) => candidate.kind === kind);
  if (!vector) throw new TypeError(`Missing ${kind} contract vector`);
  return structuredClone(vector.input.definition);
}

function object(value: unknown, label: string): MutableObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as MutableObject;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function exactReference<
  RecordType extends { readonly definitionSha256: string },
  Id extends Record<string, string>,
>(record: RecordType, id: Id): { readonly definitionSha256: string } & Id {
  return { definitionSha256: record.definitionSha256, ...id };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function contextSha256(value: unknown): string {
  return sha256(encodeEvaluationCanonicalJson(value));
}

function artifactReference(artifactId: string, character: string) {
  return {
    artifactId,
    classification: "internal" as const,
    mediaType: "application/json",
    sha256: character.repeat(64),
    sizeBytes: 1_024,
  };
}

export interface EvaluationScenarioOptions {
  readonly environmentId: string;
  readonly namespace: string;
}

export class EvaluationScenario {
  readonly ids: {
    readonly aggregate: string;
    readonly assessment: string;
    readonly criterionSet: string;
    readonly criterionSetVersion: string;
    readonly evaluatorVersion: string;
    readonly fixtureSetVersion: string;
    readonly oracleVersion: string;
    readonly policyVersion: string;
    readonly sourceConflict: string;
    readonly sourcePrimary: string;
    readonly sourceReviewConflict: string;
    readonly sourceReviewPrimary: string;
    readonly statusApproved: string;
    readonly statusDraft: string;
  };
  private readonly environmentId: string;
  private readonly namespace: string;

  constructor(options: EvaluationScenarioOptions) {
    if (!/^[a-z0-9]{1,20}$/.test(options.namespace)) {
      throw new TypeError("Evaluation scenario namespace must contain 1-20 lowercase characters");
    }
    this.environmentId = OpaqueIdSchema.parse(options.environmentId);
    this.namespace = options.namespace;
    this.ids = Object.freeze({
      aggregate: this.id("eva_reference"),
      assessment: this.id("asm_reference"),
      criterionSet: this.id("crs_response"),
      criterionSetVersion: this.id("csv_response_v1"),
      evaluatorVersion: this.id("evv_schema_v1"),
      fixtureSetVersion: this.id("qfv_schema_v1"),
      oracleVersion: this.id("orv_schema_v1"),
      policyVersion: this.id("agv_schema_v1"),
      sourceConflict: this.id("src_conflicting"),
      sourcePrimary: this.id("src_primary"),
      sourceReviewConflict: this.id("srv_conflicting"),
      sourceReviewPrimary: this.id("srv_primary"),
      statusApproved: this.id("csr_approved"),
      statusDraft: this.id("csr_draft"),
    });
  }

  private id(prefix: string): string {
    return OpaqueIdSchema.parse(`${prefix}_${this.namespace}`);
  }

  private criterionSelector() {
    return {
      criterionId: this.id("crt_schema"),
      criterionSetId: this.ids.criterionSet,
      criterionSetVersionId: this.ids.criterionSetVersion,
    };
  }

  discovery(): DiscoveryRecordDefinition {
    const definition = template("discovery_record");
    definition["discoveryId"] = this.id("dsc_primary");
    return DiscoveryRecordDefinitionSchema.parse(definition);
  }

  conflictingSource(): SourceSnapshotDefinition {
    const definition = template("source_snapshot");
    definition["sourceSnapshotId"] = this.ids.sourceConflict;
    definition["canonicalUri"] = `https://standards.example.test/${this.namespace}/conflicting`;
    definition["conflictsWith"] = [];
    definition["supersedes"] = [];
    delete definition["discovery"];
    const scope = object(definition["applicabilityScope"], "source applicability scope");
    object(scope["environments"], "source environment scope")["values"] = [this.environmentId];
    const content = object(definition["content"], "source content");
    content["artifactId"] = this.id("art_source_conflicting");
    content["sha256"] = "2".repeat(64);
    return SourceSnapshotDefinitionSchema.parse(definition);
  }

  primarySource(
    discovery: { readonly definitionSha256: string; readonly discoveryId: string },
    conflict: SourceSnapshot,
  ): SourceSnapshotDefinition {
    const definition = template("source_snapshot");
    definition["sourceSnapshotId"] = this.ids.sourcePrimary;
    definition["canonicalUri"] = `https://standards.example.test/${this.namespace}/primary`;
    definition["conflictsWith"] = [
      exactReference(conflict, { sourceSnapshotId: conflict.sourceSnapshotId }),
    ];
    definition["supersedes"] = [];
    definition["discovery"] = {
      candidateRank: 1,
      ...exactReference(discovery, { discoveryId: discovery.discoveryId }),
    };
    const scope = object(definition["applicabilityScope"], "source applicability scope");
    object(scope["environments"], "source environment scope")["values"] = [this.environmentId];
    const content = object(definition["content"], "source content");
    content["artifactId"] = this.id("art_source_primary");
    content["sha256"] = "1".repeat(64);
    return SourceSnapshotDefinitionSchema.parse(definition);
  }

  conflictingSourceReview(source: SourceSnapshot): SourceReviewDefinition {
    const definition = template("source_review");
    definition["sourceReviewId"] = this.ids.sourceReviewConflict;
    definition["source"] = exactReference(source, {
      sourceSnapshotId: source.sourceSnapshotId,
    });
    definition["reviewedConflicts"] = [];
    definition["criticalConflictStatus"] = "none";
    const approvedScope = object(definition["approvedScope"], "approved source scope");
    object(approvedScope["environments"], "approved environments")["values"] = [this.environmentId];
    definition["rationale"] =
      "The conflicting primary source is current and retained as explicit counterevidence.";
    delete definition["supersedesReview"];
    return SourceReviewDefinitionSchema.parse(definition);
  }

  primarySourceReview(source: SourceSnapshot, conflict: SourceSnapshot): SourceReviewDefinition {
    const definition = template("source_review");
    definition["sourceReviewId"] = this.ids.sourceReviewPrimary;
    definition["source"] = exactReference(source, {
      sourceSnapshotId: source.sourceSnapshotId,
    });
    definition["reviewedConflicts"] = [
      exactReference(conflict, { sourceSnapshotId: conflict.sourceSnapshotId }),
    ];
    definition["criticalConflictStatus"] = "unresolved";
    definition["freshnessConclusion"] = "expired";
    definition["outcome"] = "require_approval";
    const approvedScope = object(definition["approvedScope"], "approved source scope");
    object(approvedScope["environments"], "approved environments")["values"] = [this.environmentId];
    definition["rationale"] =
      "The review is expired and the conflicting primary source remains unresolved.";
    definition["validUntil"] = "2026-09-01T00:00:00Z";
    delete definition["supersedesReview"];
    return SourceReviewDefinitionSchema.parse(definition);
  }

  qualificationFixtureSet(): QualificationFixtureSetDefinition {
    const definition = template("qualification_fixture_set");
    definition["fixtureSetId"] = this.id("qfs_schema");
    definition["fixtureSetVersionId"] = this.ids.fixtureSetVersion;
    for (const item of array(definition["cases"], "qualification cases")) {
      object(item, "qualification case")["criterion"] = this.criterionSelector();
    }
    delete definition["predecessor"];
    return QualificationFixtureSetDefinitionSchema.parse(definition);
  }

  oracle(fixtureSet: QualificationFixtureSet): OracleSpecDefinition {
    const definition = template("oracle_spec");
    definition["oracleId"] = this.id("orc_schema");
    definition["oracleVersionId"] = this.ids.oracleVersion;
    definition["qualificationFixtureSet"] = {
      fixtureSetId: fixtureSet.fixtureSetId,
      ...exactReference(fixtureSet, { fixtureSetVersionId: fixtureSet.fixtureSetVersionId }),
    };
    definition["supportedCriteria"] = [this.criterionSelector()];
    delete definition["predecessor"];
    return OracleSpecDefinitionSchema.parse(definition);
  }

  evaluator(fixtureSet: QualificationFixtureSet, oracle: OracleSpec): EvaluatorSpecDefinition {
    const definition = template("evaluator_spec");
    definition["evaluatorId"] = this.id("evl_schema");
    definition["evaluatorVersionId"] = this.ids.evaluatorVersion;
    definition["qualificationFixtureSet"] = {
      fixtureSetId: fixtureSet.fixtureSetId,
      ...exactReference(fixtureSet, { fixtureSetVersionId: fixtureSet.fixtureSetVersionId }),
    };
    definition["oracles"] = [
      {
        oracleId: oracle.oracleId,
        ...exactReference(oracle, { oracleVersionId: oracle.oracleVersionId }),
      },
    ];
    definition["supportedCriteria"] = [this.criterionSelector()];
    delete definition["predecessor"];
    return EvaluatorSpecDefinitionSchema.parse(definition);
  }

  criterionSet(input: {
    readonly conflictReview: SourceReviewRecord;
    readonly conflictSource: SourceSnapshot;
    readonly evaluator: EvaluatorSpec;
    readonly oracle: OracleSpec;
    readonly primaryReview: SourceReviewRecord;
    readonly primarySource: SourceSnapshot;
  }): CriterionSetDefinition {
    const definition = template("criterion_set");
    definition["criterionSetId"] = this.ids.criterionSet;
    definition["criterionSetVersionId"] = this.ids.criterionSetVersion;
    const applicabilityScope = object(
      definition["applicabilityScope"],
      "criterion applicability scope",
    );
    object(applicabilityScope["environments"], "criterion environments")["values"] = [
      this.environmentId,
    ];
    definition["sources"] = [
      {
        review: exactReference(input.conflictReview, {
          sourceReviewId: input.conflictReview.sourceReviewId,
        }),
        source: exactReference(input.conflictSource, {
          sourceSnapshotId: input.conflictSource.sourceSnapshotId,
        }),
      },
      {
        review: exactReference(input.primaryReview, {
          sourceReviewId: input.primaryReview.sourceReviewId,
        }),
        source: exactReference(input.primarySource, {
          sourceSnapshotId: input.primarySource.sourceSnapshotId,
        }),
      },
    ];
    const criterion = object(array(definition["criteria"], "criteria")[0], "reference criterion");
    criterion["criterionId"] = this.criterionSelector().criterionId;
    criterion["counterevidence"] = [
      exactReference(input.conflictSource, {
        sourceSnapshotId: input.conflictSource.sourceSnapshotId,
      }),
    ];
    criterion["evaluator"] = {
      evaluatorId: input.evaluator.evaluatorId,
      ...exactReference(input.evaluator, {
        evaluatorVersionId: input.evaluator.evaluatorVersionId,
      }),
    };
    criterion["oracle"] = {
      oracleId: input.oracle.oracleId,
      ...exactReference(input.oracle, { oracleVersionId: input.oracle.oracleVersionId }),
    };
    const expression = object(criterion["applicability"], "criterion applicability");
    const environmentOperand = object(
      array(expression["operands"], "applicability operands")[0],
      "environment operand",
    );
    environmentOperand["value"] = this.environmentId;
    delete definition["predecessor"];
    return CriterionSetDefinitionSchema.parse(definition);
  }

  aggregationPolicy(): EvaluationAggregationPolicyDefinition {
    const definition = template("aggregation_policy");
    definition["policyId"] = this.id("agp_reference");
    definition["policyVersionId"] = this.ids.policyVersion;
    definition["minimumCoverageBasisPoints"] = 7_500;
    return EvaluationAggregationPolicyDefinitionSchema.parse(definition);
  }

  draftStatus(criterionSet: CriterionSet): CriterionSetStatusDefinition {
    const definition = template("criterion_set_status");
    definition["statusRecordId"] = this.ids.statusDraft;
    definition["status"] = "draft";
    definition["criterionSet"] = {
      criterionSetId: criterionSet.criterionSetId,
      ...exactReference(criterionSet, {
        criterionSetVersionId: criterionSet.criterionSetVersionId,
      }),
    };
    definition["effectiveAt"] = "2026-09-01T00:00:00Z";
    delete definition["expiresAt"];
    delete definition["previousStatus"];
    delete definition["supersededBy"];
    return CriterionSetStatusDefinitionSchema.parse(definition);
  }

  approvedStatus(
    criterionSet: CriterionSet,
    draft: CriterionSetStatusRecord,
  ): CriterionSetStatusDefinition {
    const definition = template("criterion_set_status");
    definition["statusRecordId"] = this.ids.statusApproved;
    definition["status"] = "approved";
    definition["criterionSet"] = {
      criterionSetId: criterionSet.criterionSetId,
      ...exactReference(criterionSet, {
        criterionSetVersionId: criterionSet.criterionSetVersionId,
      }),
    };
    definition["previousStatus"] = exactReference(draft, {
      statusRecordId: draft.statusRecordId,
    });
    definition["effectiveAt"] = "2026-09-01T00:01:00Z";
    definition["expiresAt"] = "2027-01-01T00:00:00Z";
    delete definition["supersededBy"];
    return CriterionSetStatusDefinitionSchema.parse(definition);
  }

  qualificationReport(
    subject: OracleSpec | EvaluatorSpec,
    fixtureSet: QualificationFixtureSet,
  ): QualificationReportDefinition {
    const definition = template("qualification_report");
    const isOracle = "oracleVersionId" in subject;
    definition["qualificationReportId"] = this.id(isOracle ? "qlr_oracle" : "qlr_evaluator");
    definition["fixtureSet"] = {
      fixtureSetId: fixtureSet.fixtureSetId,
      ...exactReference(fixtureSet, { fixtureSetVersionId: fixtureSet.fixtureSetVersionId }),
    };
    definition["subject"] = isOracle
      ? {
          kind: "oracle",
          oracle: {
            oracleId: subject.oracleId,
            ...exactReference(subject, { oracleVersionId: subject.oracleVersionId }),
          },
        }
      : {
          evaluator: {
            evaluatorId: subject.evaluatorId,
            ...exactReference(subject, { evaluatorVersionId: subject.evaluatorVersionId }),
          },
          kind: "evaluator",
        };
    definition["validUntil"] = "2027-01-01T00:00:00Z";
    return QualificationReportDefinitionSchema.parse(definition);
  }

  run(input: {
    readonly criterionSet: CriterionSet;
    readonly evaluator: EvaluatorSpec;
    readonly evaluatorQualification: QualificationReport;
    readonly oracle: OracleSpec;
    readonly oracleQualification: QualificationReport;
    readonly policy: EvaluationAggregationPolicy;
    readonly sourceReviews: readonly SourceReviewRecord[];
    readonly status: CriterionSetStatusRecord;
    readonly verdict: ReferenceVerdict;
  }): EvaluationRunDefinition {
    const definition = template("evaluation_run");
    const runId = this.id(`evr_${input.verdict}`);
    definition["evaluationRunId"] = runId;
    definition["aggregationPolicy"] = {
      policyId: input.policy.policyId,
      ...exactReference(input.policy, { policyVersionId: input.policy.policyVersionId }),
    };
    definition["criterion"] = {
      criterionId: this.criterionSelector().criterionId,
      criterionSet: {
        criterionSetId: input.criterionSet.criterionSetId,
        ...exactReference(input.criterionSet, {
          criterionSetVersionId: input.criterionSet.criterionSetVersionId,
        }),
      },
    };
    definition["criterionStatus"] = exactReference(input.status, {
      statusRecordId: input.status.statusRecordId,
    });
    definition["evaluator"] = {
      evaluatorId: input.evaluator.evaluatorId,
      ...exactReference(input.evaluator, {
        evaluatorVersionId: input.evaluator.evaluatorVersionId,
      }),
    };
    definition["evaluatorQualification"] = exactReference(input.evaluatorQualification, {
      qualificationReportId: input.evaluatorQualification.qualificationReportId,
    });
    definition["oracle"] = {
      oracleId: input.oracle.oracleId,
      ...exactReference(input.oracle, { oracleVersionId: input.oracle.oracleVersionId }),
    };
    definition["oracleQualification"] = exactReference(input.oracleQualification, {
      qualificationReportId: input.oracleQualification.qualificationReportId,
    });
    definition["sourceReviews"] = input.sourceReviews
      .map((review) => exactReference(review, { sourceReviewId: review.sourceReviewId }))
      .sort((left, right) => left.sourceReviewId.localeCompare(right.sourceReviewId));
    const context = {
      environmentId: this.environmentId,
      locale: "en",
      populationTags: input.verdict === "not_applicable" ? [] : ["adult users"],
      riskTier: "high" as const,
      taskKind: "task_support",
    };
    const criterion = input.criterionSet.criteria[0];
    if (!criterion) throw new TypeError("Reference criterion set is empty");
    const applicability = evaluateApplicability(criterion.applicability, context);
    definition["applicability"] = {
      ...object(definition["applicability"], "run applicability"),
      context,
      contextSha256: contextSha256(context),
      evaluatedAt: "2026-09-01T00:02:00Z",
      result: applicability.result,
    };
    definition["attempts"] =
      input.verdict === "not_applicable"
        ? []
        : [
            {
              ...object(array(definition["attempts"], "attempts")[0], "attempt"),
              attemptId: this.id(`att_${input.verdict}`),
              attemptSequence: 0,
            },
          ];
    definition["dataset"] = {
      datasetId: this.id("dts_reference"),
      datasetVersionId: this.id("dtv_reference_v1"),
      definitionSha256: "7".repeat(64),
    };
    definition["fixture"] = {
      fixtureId: this.id(`fix_${input.verdict}`),
      fixtureVersionId: this.id(`fxv_${input.verdict}_v1`),
      definitionSha256: "c".repeat(64),
    };
    const replay = object(definition["replay"], "replay reference");
    replay["jobId"] = this.id(`rjb_${input.verdict}`);
    replay["attemptId"] = this.id(`rat_${input.verdict}`);
    return EvaluationRunDefinitionSchema.parse(definition);
  }

  observation(run: EvaluationRun, verdict: ExecutedVerdict): RawObservationDefinition {
    const definition = template("raw_observation");
    const attempt = run.attempts[0];
    if (!attempt) throw new TypeError("Executed reference run is missing its attempt");
    definition["observationId"] = this.id(`obs_${verdict}`);
    definition["attemptId"] = attempt.attemptId;
    definition["attemptSequence"] = attempt.attemptSequence;
    definition["run"] = exactReference(run, { evaluationRunId: run.evaluationRunId });
    definition["startedAt"] = run.createdAt;
    definition["completedAt"] = run.createdAt;
    definition["executedByPrincipalId"] = "svc_evaluator";
    definition["verdict"] = verdict;
    definition["evidence"] = [
      {
        artifact: artifactReference(this.id(`art_observation_${verdict}`), "6"),
        kind: "artifact",
      },
    ];
    if (verdict === "error") {
      delete definition["measurement"];
      definition["error"] = {
        code: "evaluator_internal_error",
        message: "The bounded evaluator returned a typed non-retryable execution error.",
      };
      definition["output"] = { produced: false };
      object(definition["budgetUsage"], "budget usage")["outputBytes"] = 0;
    } else if (verdict === "abstain") {
      delete definition["measurement"];
      definition["abstention"] = {
        code: "insufficient_evidence",
        rationale: "The exact input omitted a field required for a decided measurement.",
      };
      definition["outOfDistribution"] = "out_of_distribution";
    } else {
      object(definition["measurement"], "measurement")["value"] = verdict === "pass";
    }
    return RawObservationDefinitionSchema.parse(definition);
  }

  result(
    run: EvaluationRun,
    verdict: ReferenceVerdict,
    observation?: RawObservation,
  ): EvaluationRunResultDefinition {
    const definition = template("evaluation_run_result");
    definition["resultId"] = this.id(`evs_${verdict}`);
    definition["evaluationRunId"] = run.evaluationRunId;
    definition["completedAt"] = run.createdAt;
    definition["verdict"] = verdict;
    definition["terminalReason"] =
      verdict === "not_applicable"
        ? "not_applicable"
        : verdict === "error"
          ? "non_retryable_error"
          : "completed";
    definition["observations"] = observation
      ? [exactReference(observation, { observationId: observation.observationId })]
      : [];
    return EvaluationRunResultDefinitionSchema.parse(definition);
  }

  aggregate(
    policy: EvaluationAggregationPolicy,
    criterionSet: CriterionSet,
    runs: readonly EvaluationRun[],
    results: readonly EvaluationRunResult[],
  ): EvaluationAggregateDefinition {
    const resultByRun = new Map(results.map((result) => [result.evaluationRunId, result]));
    const members = runs.map((run) => {
      const result = resultByRun.get(run.evaluationRunId);
      if (!result) throw new TypeError(`Missing result for ${run.evaluationRunId}`);
      return {
        independenceGroupId: this.id("ind_schema"),
        result: exactReference(result, {
          evaluationRunId: result.evaluationRunId,
          resultId: result.resultId,
        }),
        run: exactReference(run, { evaluationRunId: run.evaluationRunId }),
        verdict: result.verdict,
      };
    });
    return buildReferenceAggregate({
      aggregateId: this.ids.aggregate,
      criterion: {
        criterionId: this.criterionSelector().criterionId,
        criterionSet: {
          criterionSetId: criterionSet.criterionSetId,
          ...exactReference(criterionSet, {
            criterionSetVersionId: criterionSet.criterionSetVersionId,
          }),
        },
      },
      knownLimitations: [
        "The bounded reference fixtures do not establish production representativeness",
      ],
      members,
      policy,
      samplingAssumption: {
        evidence: [artifactReference(this.id("art_sampling_assumption"), "b")],
        status: "supported",
      },
    });
  }

  assessment(input: {
    readonly aggregate: { readonly aggregateId: string; readonly definitionSha256: string };
    readonly criterionSet: CriterionSet;
    readonly observations: readonly RawObservation[];
    readonly policy: EvaluationAggregationPolicy;
    readonly qualifications: readonly QualificationReport[];
    readonly reviews: readonly SourceReviewRecord[];
    readonly runs: readonly EvaluationRun[];
    readonly sources: readonly SourceSnapshot[];
    readonly status: CriterionSetStatusRecord;
  }): AssessmentDefinition {
    const definition = template("assessment");
    definition["assessmentId"] = this.ids.assessment;
    definition["aggregate"] = exactReference(input.aggregate, {
      aggregateId: input.aggregate.aggregateId,
    });
    definition["aggregationPolicy"] = {
      policyId: input.policy.policyId,
      ...exactReference(input.policy, { policyVersionId: input.policy.policyVersionId }),
    };
    definition["criterion"] = {
      criterionId: this.criterionSelector().criterionId,
      criterionSet: {
        criterionSetId: input.criterionSet.criterionSetId,
        ...exactReference(input.criterionSet, {
          criterionSetVersionId: input.criterionSet.criterionSetVersionId,
        }),
      },
    };
    definition["criterionLifecycleStatus"] = "approved";
    definition["criterionStatus"] = exactReference(input.status, {
      statusRecordId: input.status.statusRecordId,
    });
    definition["runs"] = input.runs
      .map((run) => exactReference(run, { evaluationRunId: run.evaluationRunId }))
      .sort((left, right) => left.evaluationRunId.localeCompare(right.evaluationRunId));
    definition["observations"] = input.observations
      .map((observation) =>
        exactReference(observation, { observationId: observation.observationId }),
      )
      .sort((left, right) => left.observationId.localeCompare(right.observationId));
    definition["qualifications"] = input.qualifications
      .map((report) =>
        exactReference(report, { qualificationReportId: report.qualificationReportId }),
      )
      .sort((left, right) => left.qualificationReportId.localeCompare(right.qualificationReportId));
    definition["sourceReviews"] = input.reviews
      .map((review) => exactReference(review, { sourceReviewId: review.sourceReviewId }))
      .sort((left, right) => left.sourceReviewId.localeCompare(right.sourceReviewId));
    definition["dimensions"] = {
      applicability: "applicable",
      coverage: "insufficient",
      independence: "sufficient",
      integrity: "verified",
      qualification: "current",
      sourceFreshness: "not_current",
      sourceIdentity: "verified",
      statisticalAssumptions: "supported",
    };
    definition["eligibility"] = {
      reasons: [
        "critical_counterevidence",
        "human_review_required",
        "insufficient_coverage",
        "source_review_not_current",
        "unresolved_disagreement",
      ],
      status: "ineligible",
    };
    const conflictEvidence = input.sources
      .map((source) => ({
        kind: "source_snapshot",
        source: exactReference(source, { sourceSnapshotId: source.sourceSnapshotId }),
      }))
      .sort((left, right) =>
        left.source.sourceSnapshotId.localeCompare(right.source.sourceSnapshotId),
      );
    definition["conflicts"] = [
      {
        conflictId: this.id("cnf_primary_sources"),
        evidence: conflictEvidence,
        severity: "critical",
        status: "unresolved",
        summary: "Two retained primary sources make unresolved conflicting claims.",
      },
    ];
    const disagreementEvidence = input.observations
      .flatMap((observation) => observation.evidence)
      .slice(0, 2)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    definition["disagreement"] = {
      evidence: disagreementEvidence,
      rationale: "Decided observations include both pass and fail outcomes.",
      status: "unresolved",
    };
    definition["counterevidence"] = [conflictEvidence[0]];
    definition["supportStatus"] = "inconclusive";
    definition["supportRationale"] =
      "The bounded evidence is mixed, low-coverage, stale, and critically contested.";
    definition["riskTier"] = "high";
    definition["knownLimitations"] = [
      "Eligibility is evidence usability and never a release decision",
      "The selected reference cases are not a production population sample",
    ];
    definition["minorityFindings"] = ["One decided case contradicted the criterion"];
    definition["exclusions"] = ["Autonomous release approval"];
    return AssessmentDefinitionSchema.parse(definition);
  }
}
