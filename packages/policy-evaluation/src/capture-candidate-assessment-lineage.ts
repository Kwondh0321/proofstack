import {
  type Assessment,
  type EvaluationAggregate,
  type EvaluationAggregationPolicy,
  type EvaluationRun,
  type ModelAssuranceAssessment,
  type PolicyEvaluationRequest,
  type PolicyEvaluationSourceReference,
  type RegressionDatasetVersion,
  type ReleaseCandidate,
  encodeEvaluationCanonicalJson,
  policyEvaluationSourceReferenceKey,
} from "@proofstack/contracts";
import {
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
} from "@proofstack/core";
import { PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyEvaluationSnapshotBindings } from "./capture-evaluation-snapshots.js";
import type { PolicyModelAssuranceBindings } from "./capture-model-assurance.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";
import type { PolicyRecordRead } from "./record-routing.js";

type Source = PolicyEvaluationSourceReference;
type CandidateSource = Extract<Source, { kind: "release_candidate" }>;
type AssessmentSource = Extract<Source, { kind: "assessment" | "model_assurance_assessment" }>;
type Status = "matched" | "mismatch" | "unavailable";

export interface PolicyCandidateAssessmentLineageCheck {
  readonly kind:
    | "assessment_history"
    | "model_assurance_history"
    | "aggregate_available"
    | "aggregation_policy_available"
    | "run_available"
    | "candidate_dataset"
    | "candidate_target"
    | "dataset_available"
    | "fixture_available"
    | "target_available"
    | "dataset_fixture";
  /** Exact retained owner and JSON pointer, not a path in the release candidate. */
  readonly source: Source;
  readonly path: string;
  readonly observation: { readonly status: Status };
}

export type PolicyCandidateAssessmentLineage = {
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
} & (
  | {
      readonly status: "candidate_unavailable";
      readonly source: CandidateSource;
      readonly observation: Exclude<PolicyRecordRead["observation"], { status: "verified" }>;
    }
  | {
      readonly status: "inspected";
      readonly candidate: { readonly source: CandidateSource; readonly recordSha256: string };
      /** Every candidate declaration, including unused and unreadable assessments. */
      readonly members: readonly {
        readonly source: AssessmentSource;
        readonly candidateEdgeIndex: number;
        readonly observation: PolicyRecordRead["observation"];
        /** Original graph edges, retaining repetitions across shared base assessments/runs. */
        readonly dependencyEdgeIndexes: readonly number[];
        readonly checks: readonly PolicyCandidateAssessmentLineageCheck[];
      }[];
    }
);

function same(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}

/** Internal composition only: fixed request roots, captured edges and owning-domain reports. */
export function inspectCapturedCandidateAssessmentLineage(
  request: PolicyEvaluationRequest,
  graph: Pick<PolicyRecordGraph, "nodes" | "edges">,
  evaluation: PolicyEvaluationSnapshotBindings,
  model: PolicyModelAssuranceBindings,
  limits: PolicyEvaluationEvidenceReferenceLimits,
): PolicyCandidateAssessmentLineage {
  const meter = new PolicyEvaluationReferenceCollector(limits);
  const nodes = new Map(
    graph.nodes.map(({ read }) => [policyEvaluationSourceReferenceKey(read.source), read]),
  );
  const node = (source: Source): PolicyRecordRead => {
    const read = nodes.get(policyEvaluationSourceReferenceKey(source));
    if (!read || !same(read.source, source))
      throw new PolicyRecordGraphError(
        "reference_conflict",
        policyEvaluationSourceReferenceKey(source),
      );
    return read;
  };
  const source: CandidateSource = { kind: "release_candidate", reference: request.candidate };
  const root = node(source);
  if (root.observation.status !== "verified")
    return structuredClone({
      status: "candidate_unavailable",
      source,
      observation: root.observation,
      inspectionUsage: { references: 0, referenceBytes: 0 },
    });
  const candidate = root.record as ReleaseCandidate;
  const edgeKey = (parent: Source, path: string) =>
    JSON.stringify([policyEvaluationSourceReferenceKey(parent), path]);
  const edges = new Map<string, number>();
  graph.edges.forEach((edge, index) => {
    const key = edgeKey(edge.parent, edge.reference.path);
    if (edges.has(key)) throw new PolicyRecordGraphError("reference_conflict", key);
    edges.set(key, index);
  });
  const dependency = (parent: PolicyRecordRead, path: string, expected: Source) => {
    const key = edgeKey(parent.source, path);
    const index = edges.get(key);
    const edge = index === undefined ? undefined : graph.edges[index];
    if (
      index === undefined ||
      !edge ||
      parent.observation.status !== "verified" ||
      edge.parentRecordSha256 !== parent.observation.recordSha256 ||
      !same(edge.parent, parent.source) ||
      edge.reference.kind !== "record" ||
      !same(edge.reference.source, expected) ||
      !same(edge.target, expected) ||
      edge.selectorFailure !== undefined
    )
      throw new PolicyRecordGraphError("reference_conflict", key);
    meter.record(path, expected.kind, expected.reference);
    return { index, read: node(expected) };
  };
  const histories = new Map(
    [...evaluation.parents, ...model.parents].map((parent) => [
      policyEvaluationSourceReferenceKey(parent.source),
      parent,
    ]),
  );
  const datasets = new Map(
    candidate.datasets.map((reference, index) => [
      policyEvaluationSourceReferenceKey({ kind: "dataset_version", reference }),
      index,
    ]),
  );
  const declarations: { path: string; source: AssessmentSource }[] = [
    ...candidate.assessments.map((reference, i) => ({
      path: `/assessments/${i}`,
      source: { kind: "assessment" as const, reference },
    })),
    ...candidate.modelAssuranceAssessments.map((reference, i) => ({
      path: `/modelAssuranceAssessments/${i}`,
      source: { kind: "model_assurance_assessment" as const, reference },
    })),
  ];
  const members = declarations.map((declaration) => {
    const member = dependency(root, declaration.path, declaration.source);
    const indexes: number[] = [];
    const checks: PolicyCandidateAssessmentLineageCheck[] = [];
    const check = (
      kind: PolicyCandidateAssessmentLineageCheck["kind"],
      owner: PolicyRecordRead,
      path: string,
      status: Status,
    ) => {
      checks.push({ kind, source: owner.source, path, observation: { status } });
    };
    const read = (parent: PolicyRecordRead, path: string, expected: Source) => {
      const child = dependency(parent, path, expected);
      indexes.push(child.index);
      return child.read;
    };
    const available = (
      kind: PolicyCandidateAssessmentLineageCheck["kind"],
      owner: PolicyRecordRead,
      path: string,
      child: PolicyRecordRead,
    ) => {
      check(kind, owner, path, child.observation.status === "verified" ? "matched" : "unavailable");
      return child.observation.status === "verified";
    };
    const history = (
      owner: PolicyRecordRead,
      kind: "assessment_history" | "model_assurance_history",
    ) => {
      if (owner.observation.status !== "verified") {
        check(kind, owner, "", "unavailable");
        return;
      }
      const report = histories.get(policyEvaluationSourceReferenceKey(owner.source));
      if (
        !report ||
        !same(report.source, owner.source) ||
        report.recordSha256 !== owner.observation.recordSha256 ||
        report.checks.length === 0
      )
        throw new PolicyRecordGraphError(
          "reference_conflict",
          policyEvaluationSourceReferenceKey(owner.source),
        );
      // Consume the owning report without parsing the snapshot again. This traversal charges
      // its exact source occurrences separately from the report's original inspection usage.
      check(
        kind,
        owner,
        "",
        report.checks.some((c) => c.observation.status === "mismatch")
          ? "mismatch"
          : report.checks.some((c) => c.observation.status === "unavailable")
            ? "unavailable"
            : "matched",
      );
    };
    let assessmentRead = member.read;
    if (assessmentRead.source.kind === "model_assurance_assessment") {
      history(assessmentRead, "model_assurance_history");
      if (assessmentRead.observation.status === "verified")
        assessmentRead = read(assessmentRead, "/baseAssessment", {
          kind: "assessment",
          reference: (assessmentRead.record as ModelAssuranceAssessment).baseAssessment,
        });
    }
    if (assessmentRead.source.kind === "assessment") {
      history(assessmentRead, "assessment_history");
      if (assessmentRead.observation.status === "verified") {
        const assessment = assessmentRead.record as Assessment;
        const aggregateRead = read(assessmentRead, "/aggregate", {
          kind: "evaluation_aggregate",
          reference: assessment.aggregate,
        });
        if (available("aggregate_available", assessmentRead, "/aggregate", aggregateRead)) {
          const aggregate = aggregateRead.record as EvaluationAggregate;
          const policyRead = read(aggregateRead, "/aggregationPolicy", {
            kind: "aggregation_policy",
            reference: aggregate.aggregationPolicy,
          });
          if (
            available(
              "aggregation_policy_available",
              aggregateRead,
              "/aggregationPolicy",
              policyRead,
            )
          ) {
            const reference = (policyRead.record as EvaluationAggregationPolicy).dataset;
            const datasetSource = { kind: "dataset_version" as const, reference };
            const datasetRead = read(policyRead, "/dataset", datasetSource);
            const index = datasets.get(policyEvaluationSourceReferenceKey(datasetSource));
            const declared = index !== undefined && same(candidate.datasets[index], reference);
            check("candidate_dataset", policyRead, "/dataset", declared ? "matched" : "mismatch");
            if (declared) read(root, `/datasets/${index}`, datasetSource);
            available("dataset_available", policyRead, "/dataset", datasetRead);
          }
          // A valid observed empty aggregate has no run from which to establish a target.
          if (aggregate.members.length === 0)
            check("candidate_target", aggregateRead, "/members", "unavailable");
          aggregate.members.forEach((value, i) => {
            const path = `/members/${i}/run`;
            const runRead = read(aggregateRead, path, {
              kind: "evaluation_run",
              reference: value.run,
            });
            if (!available("run_available", aggregateRead, path, runRead)) return;
            const run = runRead.record as EvaluationRun;
            const datasetSource = { kind: "dataset_version" as const, reference: run.dataset };
            const datasetRead = read(runRead, "/dataset", datasetSource);
            const datasetIndex = datasets.get(policyEvaluationSourceReferenceKey(datasetSource));
            const declared =
              datasetIndex !== undefined && same(candidate.datasets[datasetIndex], run.dataset);
            check("candidate_dataset", runRead, "/dataset", declared ? "matched" : "mismatch");
            if (declared) read(root, `/datasets/${datasetIndex}`, datasetSource);
            const datasetAvailable = available(
              "dataset_available",
              runRead,
              "/dataset",
              datasetRead,
            );
            const fixtureRead = read(runRead, "/fixture", {
              kind: "regression_fixture_version",
              reference: run.fixture,
            });
            available("fixture_available", runRead, "/fixture", fixtureRead);
            check(
              "dataset_fixture",
              runRead,
              "/fixture",
              !datasetAvailable
                ? "unavailable"
                : (datasetRead.record as RegressionDatasetVersion).fixtureVersions.some((ref) =>
                      same(ref, run.fixture),
                    )
                  ? "matched"
                  : "mismatch",
            );
            const targetSource = {
              kind: "target_release" as const,
              reference: run.replay.targetRelease,
            };
            const targetRead = read(runRead, "/replay/targetRelease", targetSource);
            const targetMatches = same(candidate.targetRelease, run.replay.targetRelease);
            check(
              "candidate_target",
              runRead,
              "/replay/targetRelease",
              targetMatches ? "matched" : "mismatch",
            );
            if (targetMatches) read(root, "/targetRelease", targetSource);
            available("target_available", runRead, "/replay/targetRelease", targetRead);
          });
        }
      }
    }
    return {
      source: declaration.source,
      candidateEdgeIndex: member.index,
      observation: member.read.observation,
      dependencyEdgeIndexes: indexes,
      checks,
    };
  });
  const usage = meter.result();
  return structuredClone({
    status: "inspected",
    candidate: { source, recordSha256: root.observation.recordSha256 },
    members,
    inspectionUsage: { references: usage.references.length, referenceBytes: usage.referenceBytes },
  });
}
