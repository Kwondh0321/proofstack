import {
  type Assessment,
  type BlindedEvaluationPlan,
  type BlindedEvaluationResult,
  type CalibrationReport,
  type EvaluationAggregationPolicy,
  type EvaluationRun,
  encodeEvaluationCanonicalJson,
  type HumanReviewerIndependence,
  type HumanReviewProtocol,
  type HumanReviewRecord,
  type IndependenceDeclaration,
  type IndependentCritique,
  type ModelAssistedEvaluatorSpec,
  type ModelAssuranceAssessment,
  type ModelEvaluatorProfile,
  type ModelQualificationReport,
  type ModelQualificationSuite,
  type OracleSpec,
  type PolicyEvaluationSourceReference,
  policyEvaluationSourceReferenceKey,
  policyEvaluationTimestampOrderKey,
  type QualificationReport,
  type RawObservation,
} from "@proofstack/contracts";
import {
  evaluateBlindedResultIntegrity,
  evaluateCalibrationCompatibility,
  evaluateHumanReviewQuorum,
  evaluateIndependentCritiqueIntegrity,
  evaluateModelQualificationApplicability,
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
} from "@proofstack/core";
import { PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyEvaluationSnapshotBindings } from "./capture-evaluation-snapshots.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";
import type { PolicyRecordRead } from "./record-routing.js";

type Source = Extract<PolicyEvaluationSourceReference, { kind: "model_assurance_assessment" }>;
type Status = "matched" | "mismatch" | "unavailable";
type Retained<T> = { readonly read: PolicyRecordRead; readonly value: T };
type Truth = boolean | undefined;

export interface PolicyModelAssuranceCheck {
  readonly kind:
    | "base_assessment"
    | "base_history"
    | "non_model_lineage"
    | "calibration"
    | "qualification"
    | "qualification_sources"
    | "qualification_evaluator"
    | "blinded_result"
    | "blind_observations"
    | "assurance_lineage"
    | "independent_critique"
    | "critique_lineage"
    | "human_quorum"
    | "human_review_lineage"
    | "declared_eligibility"
    | "validity_bound"
    | "dependency_receipts";
  /** Pointer into the retained assessment; nested evidence keeps its own graph parent. */
  readonly path: string;
  readonly observation: { readonly status: Status; readonly reasons: readonly string[] };
}

export interface PolicyModelAssuranceBindings {
  readonly parents: readonly {
    readonly source: Source;
    readonly recordSha256: string;
    readonly dependencyEdgeIndexes: readonly number[];
    readonly checks: readonly PolicyModelAssuranceCheck[];
  }[];
  readonly unavailableParents: readonly {
    readonly source: Source;
    readonly observation: Exclude<PolicyRecordRead["observation"], { status: "verified" }>;
  }[];
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
}

function same(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}

function all(values: readonly Truth[]): Truth {
  return values.includes(false) ? false : values.includes(undefined) ? undefined : true;
}

function complete<T>(values: (T | undefined)[]): values is T[] {
  return values.every((value) => value !== undefined);
}

function beforeOrAt(left: string, right: string): boolean {
  return policyEvaluationTimestampOrderKey(left) <= policyEvaluationTimestampOrderKey(right);
}

function referenceIn(reference: unknown, values: readonly unknown[]): boolean {
  return values.some((value) => same(reference, value));
}

/** Internal only: the fixed capture supplies validated records, edges and evaluation reports. */
export function inspectCapturedModelAssurance(
  graph: Pick<PolicyRecordGraph, "nodes" | "edges">,
  evaluation: PolicyEvaluationSnapshotBindings,
  limits: PolicyEvaluationEvidenceReferenceLimits,
): PolicyModelAssuranceBindings {
  const meter = new PolicyEvaluationReferenceCollector(limits);
  const nodes = new Map(
    graph.nodes.map(({ read }) => [policyEvaluationSourceReferenceKey(read.source), read]),
  );
  const edgeKey = (source: PolicyEvaluationSourceReference, path: string) =>
    JSON.stringify([policyEvaluationSourceReferenceKey(source), path]);
  const edges = new Map<string, number>();
  graph.edges.forEach((edge, index) => {
    const key = edgeKey(edge.parent, edge.reference.path);
    if (edges.has(key)) throw new PolicyRecordGraphError("reference_conflict", key);
    edges.set(key, index);
  });
  const snapshots = new Map(
    evaluation.parents.map((parent) => [policyEvaluationSourceReferenceKey(parent.source), parent]),
  );
  const parents: PolicyModelAssuranceBindings["parents"][number][] = [];
  const unavailableParents: PolicyModelAssuranceBindings["unavailableParents"][number][] = [];
  const ordered = [...nodes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [, parent] of ordered) {
    if (parent.source.kind !== "model_assurance_assessment") continue;
    if (parent.observation.status !== "verified") {
      unavailableParents.push({ source: parent.source, observation: parent.observation });
      continue;
    }
    const assessment = parent.record as ModelAssuranceAssessment;
    const at = assessment.evaluatedAt;
    const checks: PolicyModelAssuranceCheck[] = [];
    const dependencies: number[] = [];
    const receipts: Truth[] = [];
    const validity: Truth[] = [];
    const check = (
      kind: PolicyModelAssuranceCheck["kind"],
      path: string,
      value: Truth,
      reasons: readonly string[] = [],
    ) => {
      checks.push({
        kind,
        path,
        observation: {
          status: value === undefined ? "unavailable" : value ? "matched" : "mismatch",
          reasons: [...reasons],
        },
      });
    };
    const read = <T>(
      owner: PolicyRecordRead | undefined,
      path: string,
      kind: PolicyEvaluationSourceReference["kind"],
    ): Retained<T> | undefined => {
      if (!owner) {
        receipts.push(undefined);
        return undefined;
      }
      const key = edgeKey(owner.source, path);
      const index = edges.get(key);
      const edge = index === undefined ? undefined : graph.edges[index];
      if (
        index === undefined ||
        !edge ||
        owner.observation.status !== "verified" ||
        edge.parentRecordSha256 !== owner.observation.recordSha256 ||
        !same(edge.parent, owner.source) ||
        !edge.target ||
        edge.target.kind !== kind
      )
        throw new PolicyRecordGraphError("reference_conflict", key);
      meter.record(path, kind, edge.target.reference);
      dependencies.push(index);
      const child = nodes.get(policyEvaluationSourceReferenceKey(edge.target));
      if (!child || !same(child.source, edge.target))
        throw new PolicyRecordGraphError("reference_conflict", key);
      if (child.observation.status !== "verified") {
        receipts.push(undefined);
        return undefined;
      }
      const fields = child.record as unknown as Record<string, unknown>;
      const receipt = fields["recordedAt"] ?? fields["publishedAt"] ?? fields["createdAt"];
      if (typeof receipt !== "string") throw new PolicyRecordGraphError("reference_conflict", key);
      receipts.push(beforeOrAt(receipt, at));
      return { read: child, value: child.record as T };
    };
    const deadline = (value: { readonly validUntil: string } | undefined) =>
      validity.push(
        value === undefined ? undefined : beforeOrAt(assessment.validUntil, value.validUntil),
      );

    const base = read<Assessment>(parent, "/baseAssessment", "assessment");
    const policy = read<EvaluationAggregationPolicy>(
      base?.read,
      "/aggregationPolicy",
      "aggregation_policy",
    );
    check("declared_eligibility", "/eligibility", assessment.eligibility === "eligible");
    check(
      "base_assessment",
      "/baseAssessment",
      base === undefined
        ? undefined
        : base.value.eligibility.status === "eligible" &&
            base.value.dimensions.sourceFreshness === "current" &&
            base.value.riskTier === assessment.riskTier,
    );
    const baseHistory = base && snapshots.get(policyEvaluationSourceReferenceKey(base.read.source));
    check(
      "base_history",
      "/baseAssessment",
      baseHistory === undefined
        ? undefined
        : all(
            baseHistory.checks.map((c) =>
              c.observation.status === "unavailable"
                ? undefined
                : c.observation.status === "matched",
            ),
          ),
    );

    const qualification = (
      report: Retained<ModelQualificationReport> | undefined,
      path: string,
    ) => {
      const suite = read<ModelQualificationSuite>(
        report?.read,
        "/suite",
        "model_qualification_suite",
      );
      const profile = read<ModelEvaluatorProfile>(
        report?.read,
        "/modelProfile",
        "model_evaluator_profile",
      );
      const independence = read<IndependenceDeclaration>(
        report?.read,
        "/independenceDeclaration",
        "independence_declaration",
      );
      const calibration = read<CalibrationReport>(
        report?.read,
        "/calibrationReport",
        "calibration_report",
      );
      const plan = read<BlindedEvaluationPlan>(suite?.read, "/blindedPlan", "blinded_plan");
      const evaluator = read<ModelAssistedEvaluatorSpec>(
        report?.read,
        "/evaluator",
        "model_assisted_evaluator_spec",
      );
      const baseQualification = read<QualificationReport>(
        report?.read,
        "/baseQualificationReport",
        "qualification_report",
      );
      const outcome =
        report && suite && profile && independence && calibration && plan
          ? evaluateModelQualificationApplicability(
              suite.value,
              report.value,
              profile.value,
              independence.value,
              calibration.value,
              plan.value,
              at,
            )
          : undefined;
      check(
        "qualification",
        path,
        all([
          report
            ? report.value.status === "qualified" &&
              beforeOrAt(report.value.validFrom, at) &&
              !beforeOrAt(report.value.validUntil, at)
            : undefined,
          outcome === undefined ? undefined : outcome.status === "applicable",
        ]),
        outcome?.status === "inapplicable" ? outcome.reasons : [],
      );
      check(
        "qualification_sources",
        path,
        all([
          report && calibration
            ? same(report.value.baseQualificationReport, calibration.value.qualificationReport)
            : undefined,
          suite && baseQualification
            ? same(baseQualification.value.fixtureSet, suite.value.baseQualificationFixtureSet)
            : undefined,
          baseQualification
            ? baseQualification.value.status === "qualified" &&
              beforeOrAt(baseQualification.value.validFrom, at) &&
              !beforeOrAt(baseQualification.value.validUntil, at)
            : undefined,
        ]),
      );
      check(
        "qualification_evaluator",
        path,
        all([
          report && evaluator
            ? same(evaluator.value.modelProfile, report.value.modelProfile)
            : undefined,
          evaluator && profile
            ? evaluator.value.evaluatorId === profile.value.evaluator.evaluatorId &&
              evaluator.value.evaluatorVersionId === profile.value.evaluator.evaluatorVersionId
            : undefined,
          suite && evaluator
            ? suite.value.criteria.every((criterion) =>
                referenceIn(criterion, evaluator.value.supportedCriteria),
              )
            : undefined,
        ]),
      );
      for (const value of [
        report?.value,
        suite?.value,
        profile?.value,
        independence?.value,
        calibration?.value,
        plan?.value,
      ])
        deadline(value);
      return { report, suite, profile, independence, calibration, plan };
    };
    const primary = qualification(
      read<ModelQualificationReport>(
        parent,
        "/modelQualificationReport",
        "model_qualification_report",
      ),
      "/modelQualificationReport",
    );
    const plan = read<BlindedEvaluationPlan>(parent, "/blindedPlan", "blinded_plan");
    const blind = read<BlindedEvaluationResult>(parent, "/blindedResult", "blinded_result");
    const calibration = read<CalibrationReport>(parent, "/calibrationReport", "calibration_report");
    const protocol = read<HumanReviewProtocol>(
      parent,
      "/humanReviewProtocol",
      "human_review_protocol",
    );
    for (const value of [plan?.value, calibration?.value, protocol?.value]) deadline(value);
    const blindOutcome =
      plan && blind ? evaluateBlindedResultIntegrity(plan.value, blind.value) : undefined;
    check(
      "blinded_result",
      "/blindedResult",
      all([
        blind ? blind.value.status === "consistent" : undefined,
        blindOutcome === undefined ? undefined : blindOutcome.status === "consistent",
      ]),
      blindOutcome && blindOutcome.status !== "consistent" ? blindOutcome.reasons : [],
    );
    if (blind)
      blind.value.attempts.forEach((attempt, index) => {
        if (attempt.status !== "completed") return;
        const observation = read<RawObservation>(
          blind.read,
          `/attempts/${index}/observation`,
          "raw_observation",
        );
        check(
          "blind_observations",
          "/blindedResult",
          observation === undefined
            ? undefined
            : observation.value.verdict === attempt.verdict &&
                beforeOrAt(observation.value.recordedAt, blind.value.recordedAt),
        );
      });
    check(
      "assurance_lineage",
      "",
      all([
        plan && primary.report
          ? same(plan.value.evaluator, primary.report.value.evaluator) &&
            same(plan.value.modelProfile, primary.report.value.modelProfile) &&
            same(plan.value.independenceDeclaration, primary.report.value.independenceDeclaration)
          : undefined,
        plan ? same(plan.value.calibrationReport, assessment.calibrationReport) : undefined,
        primary.suite ? same(primary.suite.value.blindedPlan, assessment.blindedPlan) : undefined,
        primary.report
          ? same(primary.report.value.calibrationReport, assessment.calibrationReport)
          : undefined,
        protocol ? protocol.value.claim.riskTier === assessment.riskTier : undefined,
        protocol && base
          ? referenceIn(base.value.criterion, protocol.value.claim.criteria)
          : undefined,
      ]),
    );

    const calibrate = (
      profile: Retained<ModelEvaluatorProfile> | undefined,
      report: Retained<CalibrationReport> | undefined,
      criteria: readonly Assessment["criterion"][] | undefined,
      evaluator: CalibrationReport["evaluator"] | undefined,
      path: string,
    ) => {
      const outcome =
        profile && report && policy && criteria && evaluator
          ? evaluateCalibrationCompatibility(profile.value, report.value, {
              at,
              criteria,
              dataset: policy.value.dataset,
              evaluator,
              locale: assessment.calibrationContext.locale,
              populationTags: assessment.calibrationContext.populationTags,
              qualificationReport: report.value.qualificationReport,
              riskTier: assessment.riskTier,
              scope: assessment.scope,
              taskKindId: assessment.calibrationContext.taskKindId,
            })
          : undefined;
      check(
        "calibration",
        path,
        all([
          report
            ? report.value.status === "calibrated" &&
              report.value.distributionShift.status === "no_shift_detected"
            : undefined,
          outcome === undefined ? undefined : outcome.status === "compatible",
        ]),
        outcome?.status === "incompatible" ? outcome.reasons : [],
      );
    };
    calibrate(
      primary.profile,
      calibration,
      base ? [base.value.criterion] : undefined,
      plan?.value.evaluator,
      "/calibrationReport",
    );

    const observations = assessment.nonModelEvidence.observations.map((_, i) =>
      read<RawObservation>(parent, `/nonModelEvidence/observations/${i}`, "raw_observation"),
    );
    const runs = observations.map((observation) =>
      read<EvaluationRun>(observation?.read, "/run", "evaluation_run"),
    );
    const oracles = assessment.nonModelEvidence.oracles.map((_, i) =>
      read<OracleSpec>(parent, `/nonModelEvidence/oracles/${i}`, "oracle_spec"),
    );
    check(
      "non_model_lineage",
      "/nonModelEvidence",
      all([
        observations.length > 0 && oracles.length > 0,
        ...assessment.nonModelEvidence.observations.map((ref) =>
          base ? referenceIn(ref, base.value.observations) : undefined,
        ),
        ...assessment.nonModelEvidence.oracles.map((ref) =>
          runs.some((run) => run && same(run.value.oracle, ref))
            ? true
            : complete(runs)
              ? false
              : undefined,
        ),
        ...observations.map((o) => (o === undefined ? undefined : true)),
        ...oracles.map((o) => (o === undefined ? undefined : true)),
      ]),
    );
    const critiques = assessment.critiques.map((_, i) =>
      read<IndependentCritique>(parent, `/critiques/${i}`, "independent_critique"),
    );
    const declarations = assessment.independenceDeclarations.map((_, i) =>
      read<IndependenceDeclaration>(
        parent,
        `/independenceDeclarations/${i}`,
        "independence_declaration",
      ),
    );
    const critiqueOutcome =
      plan && complete(critiques) && complete(declarations)
        ? evaluateIndependentCritiqueIntegrity(
            plan.value,
            assessment.critiques,
            critiques.map((c) => c.value),
            declarations.map((d) => d.value),
            at,
          )
        : undefined;
    check(
      "independent_critique",
      "/critiques",
      all([
        critiques.length > 0,
        ...critiques.map((critique) =>
          critique === undefined
            ? undefined
            : critique.value.outcome.status === "produced" &&
              critique.value.outcome.findings.every((finding) => finding.impact === "supports"),
        ),
        critiqueOutcome === undefined ? undefined : critiqueOutcome.status === "satisfied",
      ]),
      critiqueOutcome?.status === "unsatisfied" ? critiqueOutcome.reasons : [],
    );
    critiques.forEach((critique, i) => {
      const path = `/critiques/${i}`;
      const qualified = qualification(
        read<ModelQualificationReport>(
          critique?.read,
          "/modelQualificationReport",
          "model_qualification_report",
        ),
        path,
      );
      check(
        "critique_lineage",
        path,
        all([
          critique
            ? referenceIn(critique.value.observation, assessment.nonModelEvidence.observations)
            : undefined,
          critique && qualified.report
            ? same(critique.value.evaluator, qualified.report.value.evaluator) &&
              same(critique.value.modelProfile, qualified.report.value.modelProfile) &&
              same(critique.value.calibrationReport, qualified.report.value.calibrationReport) &&
              same(
                critique.value.independenceDeclaration,
                qualified.report.value.independenceDeclaration,
              ) &&
              same(
                critique.value.qualificationReport,
                qualified.report.value.baseQualificationReport,
              )
            : undefined,
        ]),
      );
      calibrate(
        qualified.profile,
        qualified.calibration,
        critique ? [critique.value.criterion] : undefined,
        critique?.value.evaluator,
        path,
      );
    });
    const reviews = assessment.humanReviews.map((_, i) =>
      read<HumanReviewRecord>(parent, `/humanReviews/${i}`, "human_review_record"),
    );
    const humanDeclarations = reviews.map((review) =>
      read<HumanReviewerIndependence>(
        review?.read,
        "/independenceDeclaration",
        "human_reviewer_independence",
      ),
    );
    const uniqueDeclarations = new Map(
      humanDeclarations.filter((d) => d !== undefined).map((d) => [d.value.declarationId, d.value]),
    );
    // Let the owning quorum algorithm resolve supersession before considering opposition.
    // Missing declarations can explain two of its failure reasons; those alone cannot prove a
    // mismatch. Other failures (including active opposition) survive missing independence evidence.
    const quorum =
      protocol && complete(reviews)
        ? evaluateHumanReviewQuorum(
            protocol.value,
            reviews.map((r) => r.value),
            [...uniqueDeclarations.values()],
            at,
          )
        : undefined;
    check(
      "human_quorum",
      "/humanReviews",
      all([
        reviews.length > 0,
        quorum === undefined
          ? undefined
          : quorum.status === "satisfied"
            ? true
            : complete(humanDeclarations) ||
                quorum.reasons.some(
                  (reason) =>
                    reason !== "independence_not_verified" &&
                    reason !== "independence_group_shortfall",
                )
              ? false
              : undefined,
      ]),
      quorum?.status === "unsatisfied" ? quorum.reasons : [],
    );
    reviews.forEach((review, i) => {
      check(
        "human_review_lineage",
        `/humanReviews/${i}`,
        review === undefined
          ? undefined
          : same(review.value.assessment, assessment.baseAssessment) &&
              assessment.nonModelEvidence.observations.every((ref) =>
                referenceIn(ref, review.value.observations),
              ) &&
              assessment.critiques.every((ref) => referenceIn(ref, review.value.critiques)),
      );
      validity.push(
        review === undefined
          ? undefined
          : beforeOrAt(assessment.validUntil, review.value.expiresAt),
      );
      deadline(humanDeclarations[i]?.value);
    });
    check("validity_bound", "/validUntil", all(validity));
    check(
      "dependency_receipts",
      "/evaluatedAt",
      all([beforeOrAt(at, assessment.recordedAt), ...receipts]),
    );
    parents.push({
      source: parent.source,
      recordSha256: parent.observation.recordSha256,
      dependencyEdgeIndexes: dependencies,
      checks,
    });
  }
  const usage = meter.result();
  return structuredClone({
    parents,
    unavailableParents,
    inspectionUsage: {
      references: usage.references.length,
      referenceBytes: usage.referenceBytes,
    },
  });
}
