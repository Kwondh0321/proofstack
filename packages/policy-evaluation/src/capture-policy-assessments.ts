import {
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationManifestEntry,
  type PolicyEvaluationRequest,
  type PolicyEvaluationSourceReference,
  policyEvaluationSourceReferenceKey,
  type ReleaseCandidate,
  type ReleasePolicy,
} from "@proofstack/contracts";
import {
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
} from "@proofstack/core";
import { PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";
import type { PolicyRecordRead } from "./record-routing.js";

type AssessmentSource = Extract<
  PolicyEvaluationSourceReference,
  { kind: "assessment" | "model_assurance_assessment" }
>;
type RootSource = Extract<
  PolicyEvaluationSourceReference,
  { kind: "release_candidate" | "release_policy" }
>;
type Root<K extends RootSource["kind"]> = {
  readonly source: Extract<RootSource, { kind: K }>;
  readonly recordSha256: string;
};
type Observation = PolicyEvaluationManifestEntry["observation"];

export type PolicyAssessmentBindings = {
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
} & (
  | {
      readonly status: "roots_unavailable";
      readonly unavailableRoots: readonly {
        readonly source: RootSource;
        readonly observation: Exclude<Observation, { status: "verified" }>;
      }[];
    }
  | {
      readonly status: "inspected";
      readonly candidate: Root<"release_candidate">;
      readonly policy: Root<"release_policy">;
      /** Complete candidate declaration inventory, including unused or unreadable members. */
      readonly members: readonly {
        readonly source: AssessmentSource;
        readonly candidateEdgeIndex: number;
        readonly observation: Observation;
      }[];
      /** One entry per assessment-bearing rule, in original policy order. */
      readonly rules: readonly {
        readonly ruleId: string;
        readonly ruleIndex: number;
        readonly source: AssessmentSource;
        readonly policyEdgeIndex: number;
        readonly membership:
          | { readonly status: "declared"; readonly candidateEdgeIndex: number }
          | { readonly status: "not_declared" };
        readonly observation: Observation;
      }[];
    }
);

function same(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}

/**
 * Internal only: joins the invocation's validated roots and exact graph occurrences. Declaration
 * membership and record availability are independent; neither establishes assessment lineage,
 * eligibility, current authority, a sealed snapshot or a policy outcome.
 */
export function inspectCapturedPolicyAssessments(
  request: PolicyEvaluationRequest,
  graph: Pick<PolicyRecordGraph, "nodes" | "edges">,
  limits: PolicyEvaluationEvidenceReferenceLimits,
): PolicyAssessmentBindings {
  const meter = new PolicyEvaluationReferenceCollector(limits);
  const nodes = new Map(
    graph.nodes.map(({ read }) => [policyEvaluationSourceReferenceKey(read.source), read]),
  );
  const node = (source: PolicyEvaluationSourceReference): PolicyRecordRead => {
    const read = nodes.get(policyEvaluationSourceReferenceKey(source));
    if (!read || !same(read.source, source))
      throw new PolicyRecordGraphError(
        "reference_conflict",
        policyEvaluationSourceReferenceKey(source),
      );
    return read;
  };
  const candidateSource = { kind: "release_candidate" as const, reference: request.candidate };
  const policySource = { kind: "release_policy" as const, reference: request.policy };
  const candidateRead = node(candidateSource);
  const policyRead = node(policySource);
  if (
    candidateRead.observation.status !== "verified" ||
    policyRead.observation.status !== "verified"
  )
    return structuredClone({
      status: "roots_unavailable",
      unavailableRoots: [
        { source: candidateSource, observation: candidateRead.observation },
        { source: policySource, observation: policyRead.observation },
      ].flatMap(({ source, observation }) =>
        observation.status === "verified" ? [] : [{ source, observation }],
      ),
      inspectionUsage: { references: 0, referenceBytes: 0 },
    });
  const candidate = candidateRead.record as ReleaseCandidate;
  const policy = policyRead.record as ReleasePolicy;
  const edgeKey = (source: PolicyEvaluationSourceReference, path: string) =>
    JSON.stringify([policyEvaluationSourceReferenceKey(source), path]);
  const edges = new Map<string, number>();
  graph.edges.forEach((edge, index) => {
    if (!same(edge.parent, candidateRead.source) && !same(edge.parent, policyRead.source)) return;
    const key = edgeKey(edge.parent, edge.reference.path);
    if (edges.has(key)) throw new PolicyRecordGraphError("reference_conflict", key);
    edges.set(key, index);
  });
  const occurrence = (parent: PolicyRecordRead, path: string, source: AssessmentSource) => {
    const key = edgeKey(parent.source, path);
    const index = edges.get(key);
    const edge = index === undefined ? undefined : graph.edges[index];
    if (
      !edge ||
      parent.observation.status !== "verified" ||
      edge.parentRecordSha256 !== parent.observation.recordSha256 ||
      edge.reference.kind !== "record" ||
      !same(edge.reference.source, source) ||
      !same(edge.target, source) ||
      edge.selectorFailure !== undefined
    )
      throw new PolicyRecordGraphError("reference_conflict", key);
    meter.record(path, source.kind, source.reference);
    return { index: index as number, read: node(source) };
  };
  const declarations: { path: string; source: AssessmentSource }[] = [
    ...candidate.assessments.map((reference, index) => ({
      path: `/assessments/${index}`,
      source: { kind: "assessment" as const, reference },
    })),
    ...candidate.modelAssuranceAssessments.map((reference, index) => ({
      path: `/modelAssuranceAssessments/${index}`,
      source: { kind: "model_assurance_assessment" as const, reference },
    })),
  ];
  const members = declarations.map(({ path, source }) => {
    const { index, read } = occurrence(candidateRead, path, source);
    return { source, candidateEdgeIndex: index, observation: read.observation };
  });
  const bySource = new Map(
    members.map((member) => [policyEvaluationSourceReferenceKey(member.source), member]),
  );
  const rules: Extract<PolicyAssessmentBindings, { status: "inspected" }>["rules"][number][] = [];
  policy.rules.forEach((rule, ruleIndex) => {
    const predicate = rule.predicate;
    if (!("assessment" in predicate)) return;
    const source: AssessmentSource =
      predicate.kind === "eligibility_required" && predicate.assessmentClass === "model_assurance"
        ? { kind: "model_assurance_assessment", reference: predicate.assessment }
        : { kind: "assessment", reference: predicate.assessment };
    const { index, read } = occurrence(
      policyRead,
      `/rules/${ruleIndex}/predicate/assessment`,
      source,
    );
    const member = bySource.get(policyEvaluationSourceReferenceKey(source));
    if (member && !same(member.source, source))
      throw new PolicyRecordGraphError(
        "reference_conflict",
        policyEvaluationSourceReferenceKey(source),
      );
    rules.push({
      ruleId: rule.ruleId,
      ruleIndex,
      source,
      policyEdgeIndex: index,
      membership: member
        ? { status: "declared", candidateEdgeIndex: member.candidateEdgeIndex }
        : { status: "not_declared" },
      observation: read.observation,
    });
  });
  const usage = meter.result();
  return structuredClone({
    status: "inspected",
    candidate: {
      source: candidateSource,
      recordSha256: candidateRead.observation.recordSha256,
    },
    policy: { source: policySource, recordSha256: policyRead.observation.recordSha256 },
    members,
    rules,
    inspectionUsage: { references: usage.references.length, referenceBytes: usage.referenceBytes },
  });
}
