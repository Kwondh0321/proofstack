import {
  type Assessment,
  type EvaluationAggregate,
  type EvaluationAggregationPolicy,
  type ModelAssuranceAssessment,
  encodeEvaluationCanonicalJson,
  PolicyEvaluationManifestEntrySchema,
  type PolicyEvaluationManifestEntry,
  type PolicyEvaluationRequest,
  type PolicyEvaluationSourceReference,
  policyEvaluationSourceReferenceKey,
  type ReleasePolicy,
} from "@proofstack/contracts";
import {
  PolicyEvaluationEvidenceReferenceError,
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
  policyEvaluationRequestReference,
  validatePolicyEvaluationRequestRecord,
} from "@proofstack/core";
import { PolicyRecordGraphError } from "./acquisition-budget.js";
import { inspectCapturedCandidateAssessmentLineage } from "./capture-candidate-assessment-lineage.js";
import { inspectCapturedEvaluationSnapshots } from "./capture-evaluation-snapshots.js";
import { inspectCapturedModelAssurance } from "./capture-model-assurance.js";
import { inspectCapturedPolicyAssessments } from "./capture-policy-assessments.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";
import { enumerateCapturedPolicyRecord } from "./record-routing.js";

type Source = PolicyEvaluationSourceReference;
type Predicate = Extract<ReleasePolicy["rules"][number]["predicate"], { assessment: unknown }>;
type Inventory = Extract<PolicyRecordGraph["policyAssessments"], { status: "inspected" }>;
type Captured<T> =
  | {
      readonly status: "verified";
      readonly source: Source;
      readonly recordSha256: string;
      readonly record: T;
    }
  | {
      readonly status: "unavailable";
      readonly source: Source;
      readonly observation: Exclude<
        PolicyEvaluationManifestEntry["observation"],
        { status: "verified" }
      >;
    };
type AggregateInput = {
  readonly aggregate: Captured<EvaluationAggregate>;
  readonly aggregationPolicy: Captured<EvaluationAggregationPolicy>;
};
type Operand =
  | (AggregateInput & {
      readonly kind: "coverage_count";
      readonly field: "decidedCount" | "attemptedCount";
      readonly count: number | null;
    })
  | (AggregateInput & {
      readonly kind: "uncertainty_interval";
      readonly field: "lowerBound" | "upperBound";
      readonly bound: string | null;
      readonly compatibility: {
        readonly status: "compatible" | "incompatible";
        readonly reasons: readonly (
          | "aggregate_unavailable"
          | "policy_unavailable"
          | "interval_not_reported"
          | "method"
          | "confidence"
          | "sampling_assumption"
        )[];
      };
    })
  | {
      readonly kind: "evaluation_eligibility";
      readonly eligibility: Assessment["eligibility"];
      readonly dimensions: Assessment["dimensions"];
    }
  | {
      readonly kind: "model_eligibility";
      readonly eligibility: ModelAssuranceAssessment["eligibility"];
      readonly reasons: ModelAssuranceAssessment["reasons"];
      readonly baseAssessment: ModelAssuranceAssessment["baseAssessment"];
    };

export interface PolicyAssessmentRuleInputs {
  readonly authorityBoundary: "retained_inputs_only";
  readonly candidate: Inventory["candidate"];
  readonly policy: Inventory["policy"];
  /** Every original candidate evaluation/model declaration, including unused or unreadable members. */
  readonly members: Inventory["members"];
  readonly rules: readonly {
    readonly ruleId: string;
    readonly ruleIndex: number;
    readonly predicate: Predicate;
    readonly source: Source;
    readonly policyEdgeIndex: number;
    readonly membership: Inventory["rules"][number]["membership"];
    readonly binding:
      | { readonly status: "not_declared" }
      | {
          readonly status: "assessment_unavailable";
          readonly observation: Exclude<
            PolicyEvaluationManifestEntry["observation"],
            { status: "verified" }
          >;
        }
      | {
          readonly status: "inputs_retained";
          readonly assessment: Extract<
            Captured<Assessment | ModelAssuranceAssessment>,
            { status: "verified" }
          >;
          /** Indexes into this invocation's independently reproduced owning prerequisite reports. */
          readonly prerequisites: {
            readonly candidateLineageIndex: number;
            readonly assessmentSnapshotIndex: number | null;
            readonly aggregateSnapshotIndex: number | null;
            readonly modelAssuranceIndex: number | null;
          };
          readonly operand: Operand;
        };
  }[];
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
}

function same(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}
function conflict(): never {
  throw new PolicyRecordGraphError("observation_conflict");
}

/** Fixed internal descriptive inputs, not eligibility evaluation, complete current authority or a seal. */
export function inspectCapturedAssessmentRules(
  input: PolicyEvaluationRequest,
  capture: PolicyRecordGraph,
  limits: PolicyEvaluationEvidenceReferenceLimits,
): PolicyAssessmentRuleInputs {
  const request = validatePolicyEvaluationRequestRecord(input);
  new PolicyEvaluationReferenceCollector(limits);
  const graph = structuredClone(capture);
  const candidateSource = { kind: "release_candidate" as const, reference: request.candidate };
  const policySource = { kind: "release_policy" as const, reference: request.policy };
  if (
    !same(graph.request, policyEvaluationRequestReference(request)) ||
    !same(graph.scope, request.scope) ||
    graph.evaluationTime !== request.evaluationTime ||
    !same(graph.roots, [candidateSource, policySource])
  )
    conflict();
  const nodes = new Map<string, (typeof graph.nodes)[number]>();
  for (const node of graph.nodes) {
    const key = policyEvaluationSourceReferenceKey(node.read.source);
    if (nodes.has(key)) conflict();
    nodes.set(key, node);
  }
  const edgeKey = (source: Source, path: string) =>
    JSON.stringify([policyEvaluationSourceReferenceKey(source), path]);
  const edges = new Map<string, number>();
  const edgesByParent = new Map<string, (typeof graph.edges)[number][]>();
  graph.edges.forEach((edge, index) => {
    const parentKey = policyEvaluationSourceReferenceKey(edge.parent);
    const parent = nodes.get(parentKey);
    if (!parent || !same(parent.read.source, edge.parent)) conflict();
    const key = edgeKey(edge.parent, edge.reference.path);
    if (edges.has(key)) conflict();
    edges.set(key, index);
    const siblings = edgesByParent.get(parentKey);
    if (siblings) siblings.push(edge);
    else edgesByParent.set(parentKey, [edge]);
  });
  let references = 0;
  let referenceBytes = 0;
  const charge = (count: number, bytes: number) => {
    if (count > limits.maxReferences - references)
      throw new PolicyEvaluationEvidenceReferenceError("reference_limit_exceeded");
    if (bytes > limits.maxReferenceBytes - referenceBytes)
      throw new PolicyEvaluationEvidenceReferenceError("reference_bytes_exceeded");
    references += count;
    referenceBytes += bytes;
  };
  // Owning model/evaluation reproductions can inspect any of their captured dependencies.
  // Revalidate every original body/receipt/reference before letting those fixed inspectors run.
  for (const node of graph.nodes) {
    const { read } = node;
    if (
      Object.keys(read).some((key) => !["record", "source", "observation"].includes(key)) ||
      !PolicyEvaluationManifestEntrySchema.safeParse({
        source: read.source,
        observation: read.observation,
      }).success
    )
      conflict();
    const parentEdges = edgesByParent.get(policyEvaluationSourceReferenceKey(read.source)) ?? [];
    if (read.observation.status !== "verified") {
      if (read.record !== null || node.references !== null || parentEdges.length !== 0) conflict();
      continue;
    }
    const checked = enumerateCapturedPolicyRecord(
      { source: read.source, scope: request.scope, evaluationTime: request.evaluationTime },
      read,
      limits,
      {
        maximumRecords: request.limits.maxAcquisitionRecords,
        maximumRecordBytes: request.limits.maxAcquisitionRecordBytes,
      },
    );
    if (
      !same(checked.references, node.references) ||
      parentEdges.length !== checked.references.length
    )
      conflict();
    charge(checked.references.length, checked.referenceBytes);
    for (const reference of checked.references) {
      const index = edges.get(edgeKey(read.source, reference.path));
      const edge = index === undefined ? undefined : graph.edges[index];
      if (
        !edge ||
        edge.parentRecordSha256 !== checked.recordSha256 ||
        !same(edge.reference, reference) ||
        (reference.kind === "record" && !same(edge.target, reference.source))
      )
        conflict();
    }
  }
  const retained = <T>(source: Source): Captured<T> => {
    const read = nodes.get(policyEvaluationSourceReferenceKey(source))?.read;
    if (!read || !same(read.source, source)) return conflict();
    return read.observation.status === "verified"
      ? {
          status: "verified",
          source,
          recordSha256: read.observation.recordSha256,
          record: read.record as T,
        }
      : { status: "unavailable", source, observation: read.observation };
  };
  const policy = retained<ReleasePolicy>(policySource);
  const candidate = retained<unknown>(candidateSource);
  if (policy.status !== "verified" || candidate.status !== "verified") return conflict();
  const inventory = inspectCapturedPolicyAssessments(request, graph, limits);
  const evaluation = inspectCapturedEvaluationSnapshots(graph, limits);
  const model = inspectCapturedModelAssurance(graph, evaluation, limits);
  const lineage = inspectCapturedCandidateAssessmentLineage(
    request,
    graph,
    evaluation,
    model,
    limits,
  );
  if (
    inventory.status !== "inspected" ||
    lineage.status !== "inspected" ||
    !same(inventory, graph.policyAssessments) ||
    !same(evaluation, graph.evaluationSnapshots) ||
    !same(model, graph.modelAssurance) ||
    !same(lineage, graph.candidateAssessmentLineage)
  )
    return conflict();
  for (const report of [inventory, evaluation, model, lineage])
    charge(report.inspectionUsage.references, report.inspectionUsage.referenceBytes);
  const context = {
    authorityBoundary: "retained_inputs_only" as const,
    candidate: inventory.candidate,
    policy: inventory.policy,
    members: inventory.members,
  };
  charge(1, encodeEvaluationCanonicalJson(context).byteLength);
  const rules: PolicyAssessmentRuleInputs["rules"][number][] = [];
  const indexOf = (
    parents: readonly { readonly source: Source }[],
    source: Source,
  ): number | null => {
    const index = parents.findIndex((parent) => same(parent.source, source));
    return index < 0 ? null : index;
  };
  for (const original of inventory.rules) {
    const predicate = policy.record.rules[original.ruleIndex]?.predicate;
    if (!predicate || !("assessment" in predicate)) conflict();
    const assessment = retained<Assessment | ModelAssuranceAssessment>(original.source);
    let binding: PolicyAssessmentRuleInputs["rules"][number]["binding"];
    if (original.membership.status === "not_declared") binding = { status: "not_declared" };
    else if (assessment.status === "unavailable")
      binding = { status: "assessment_unavailable", observation: assessment.observation };
    else {
      const candidateLineageIndex = indexOf(lineage.members, original.source);
      if (candidateLineageIndex === null) conflict();
      let operand: Operand;
      let aggregateSource: Source | null = null;
      if (
        predicate.kind === "eligibility_required" &&
        predicate.assessmentClass === "model_assurance"
      ) {
        const record = assessment.record as ModelAssuranceAssessment;
        operand = {
          kind: "model_eligibility",
          eligibility: record.eligibility,
          reasons: record.reasons,
          baseAssessment: record.baseAssessment,
        };
      } else {
        const record = assessment.record as Assessment;
        if (predicate.kind === "eligibility_required")
          operand = {
            kind: "evaluation_eligibility",
            eligibility: record.eligibility,
            dimensions: record.dimensions,
          };
        else {
          aggregateSource = { kind: "evaluation_aggregate", reference: record.aggregate };
          const aggregate = retained<EvaluationAggregate>(aggregateSource);
          const aggregationPolicy = retained<EvaluationAggregationPolicy>({
            kind: "aggregation_policy",
            reference: record.aggregationPolicy,
          });
          if (predicate.kind === "coverage_floor") {
            const field = predicate.sampleClass === "decided" ? "decidedCount" : "attemptedCount";
            operand = {
              kind: "coverage_count",
              aggregate,
              aggregationPolicy,
              field,
              count: aggregate.status === "verified" ? aggregate.record.counts[field] : null,
            };
          } else {
            const field = predicate.bound === "lower" ? "lowerBound" : "upperBound";
            const reasons: Extract<
              Operand,
              { kind: "uncertainty_interval" }
            >["compatibility"]["reasons"][number][] = [];
            let bound: string | null = null;
            if (aggregate.status !== "verified") reasons.push("aggregate_unavailable");
            else {
              if (aggregate.record.samplingAssumption.status !== "supported")
                reasons.push("sampling_assumption");
              const reported = aggregate.record.passInterval;
              if (reported.status !== "reported") reasons.push("interval_not_reported");
              else {
                bound = reported.interval[field];
                if (
                  reported.interval.method !== predicate.intervalMethod ||
                  reported.interval.methodVersion !== predicate.intervalMethodVersion
                )
                  reasons.push("method");
                if (
                  reported.interval.confidenceLevelBasisPoints !==
                  predicate.confidenceLevelBasisPoints
                )
                  reasons.push("confidence");
              }
            }
            if (aggregationPolicy.status !== "verified") reasons.push("policy_unavailable");
            else {
              const method = aggregationPolicy.record.method;
              if (
                method.method !== predicate.intervalMethod ||
                (method.method === "wilson_score_interval" &&
                  method.methodVersion !== predicate.intervalMethodVersion)
              ) {
                if (!reasons.includes("method")) reasons.push("method");
              }
              if (
                method.method === "wilson_score_interval" &&
                method.confidenceLevelBasisPoints !== predicate.confidenceLevelBasisPoints &&
                !reasons.includes("confidence")
              )
                reasons.push("confidence");
            }
            operand = {
              kind: "uncertainty_interval",
              aggregate,
              aggregationPolicy,
              field,
              bound,
              compatibility: {
                status: reasons.length === 0 ? "compatible" : "incompatible",
                reasons,
              },
            };
          }
        }
      }
      binding = {
        status: "inputs_retained",
        assessment,
        operand,
        prerequisites: {
          candidateLineageIndex,
          assessmentSnapshotIndex: indexOf(evaluation.parents, original.source),
          aggregateSnapshotIndex:
            aggregateSource === null ? null : indexOf(evaluation.parents, aggregateSource),
          modelAssuranceIndex: indexOf(model.parents, original.source),
        },
      };
    }
    const rule = {
      ruleId: original.ruleId,
      ruleIndex: original.ruleIndex,
      predicate,
      source: original.source,
      policyEdgeIndex: original.policyEdgeIndex,
      membership: original.membership,
      binding,
    };
    charge(1, encodeEvaluationCanonicalJson(rule).byteLength);
    rules.push(rule);
  }
  return structuredClone({ ...context, rules, inspectionUsage: { references, referenceBytes } });
}
