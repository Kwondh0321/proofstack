import {
  type ComparisonDefinition,
  type ComparisonDefinitionReference,
  type ComparisonMetricResult,
  type ComparisonResult,
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationComparisonInventory,
  PolicyEvaluationManifestEntrySchema,
  type PolicyEvaluationRequest,
  type PolicyEvaluationSourceReference,
  policyEvaluationSourceReferenceKey,
  type ReleaseCandidate,
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
import {
  type CapturedPolicyComparison,
  type PolicyComparisonEvidenceCapture,
  resolveCapturedComparisonEvidence,
} from "./capture-comparison-evidence.js";
import { enumerateCapturedPolicyRecord } from "./record-routing.js";

type Predicate = Extract<
  ReleasePolicy["rules"][number]["predicate"],
  { comparison: ComparisonDefinitionReference }
>;
type Root<K extends "release_candidate" | "release_policy"> = {
  readonly source: Extract<PolicyEvaluationSourceReference, { kind: K }>;
  readonly recordSha256: string;
};
type Metric = {
  readonly definitionIndex: number;
  readonly resultIndex: number;
  readonly stratumIndex: number;
  readonly definition: ComparisonDefinition["metrics"][number];
  readonly result: ComparisonMetricResult;
  readonly stratum: ComparisonDefinition["strata"][number];
  readonly provenance: {
    readonly calculationPolicy: ComparisonDefinition["calculationPolicy"];
    readonly comparability: ComparisonResult["comparability"];
    readonly pairing: ComparisonResult["pairing"];
    readonly latestSourceCutoff: string;
  };
  readonly recordHashes: {
    readonly comparison: string;
    readonly result: string;
    readonly baselineSnapshot: string;
    readonly candidateSnapshot: string;
  };
  readonly compatibility: {
    readonly status: "compatible" | "incompatible";
    readonly reasons: readonly ("metric_kind" | "unit" | "event_class")[];
  };
};

export interface PolicyComparisonRuleBindings {
  readonly candidate: Root<"release_candidate">;
  readonly policy: Root<"release_policy">;
  /** Complete original candidate inventory, including unused and unreadable members. */
  readonly inventory: PolicyEvaluationComparisonInventory;
  readonly rules: readonly {
    readonly ruleId: string;
    readonly ruleIndex: number;
    readonly predicate: Predicate;
    readonly policyEdgeIndex: number;
    /** Index in this invocation's complete comparisonCapture.comparisons array. */
    readonly comparisonIndex: number;
    readonly binding:
      | {
          readonly status: "comparison_unusable";
          readonly reason: Exclude<CapturedPolicyComparison["status"], "lineage_verified">;
        }
      | { readonly status: "metric_missing" }
      | { readonly status: "metric_bound"; readonly metric: Metric };
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

/** Internal exact input join, not numeric evaluation, complete current authority or sealing. */
export function inspectCapturedComparisonRules(
  input: PolicyEvaluationRequest,
  capture: PolicyComparisonEvidenceCapture,
  limits: PolicyEvaluationEvidenceReferenceLimits,
): PolicyComparisonRuleBindings {
  const request = validatePolicyEvaluationRequestRecord(input);
  new PolicyEvaluationReferenceCollector(limits);
  const graph = capture.graph;
  const candidateSource = { kind: "release_candidate" as const, reference: request.candidate };
  const policySource = { kind: "release_policy" as const, reference: request.policy };
  if (
    capture.status !== "inventory_captured" ||
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
  const edges = new Map<string, number>();
  const edgeKey = (source: PolicyEvaluationSourceReference, path: string) =>
    JSON.stringify([policyEvaluationSourceReferenceKey(source), path]);
  graph.edges.forEach((edge, index) => {
    const key = edgeKey(edge.parent, edge.reference.path);
    if (edges.has(key)) conflict();
    edges.set(key, index);
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
  const inspect = (source: PolicyEvaluationSourceReference, required: boolean) => {
    const node = nodes.get(policyEvaluationSourceReferenceKey(source));
    if (!node || !same(node.read.source, source)) return conflict();
    if (
      !PolicyEvaluationManifestEntrySchema.safeParse({
        source: node.read.source,
        observation: node.read.observation,
      }).success
    )
      conflict();
    if (node.read.observation.status !== "verified") {
      if (required || node.read.record !== null || node.references !== null) conflict();
      if (graph.edges.some((edge) => same(edge.parent, source))) conflict();
      return node.read;
    }
    const checked = enumerateCapturedPolicyRecord(
      { source, scope: request.scope, evaluationTime: request.evaluationTime },
      node.read,
      limits,
      {
        maximumRecords: request.limits.maxAcquisitionRecords,
        maximumRecordBytes: request.limits.maxAcquisitionRecordBytes,
      },
    );
    if (!same(checked.references, node.references)) conflict();
    charge(checked.references.length, checked.referenceBytes);
    const parentEdges = graph.edges.filter((edge) => same(edge.parent, source));
    if (parentEdges.length !== checked.references.length) conflict();
    for (const reference of checked.references) {
      const index = edges.get(edgeKey(source, reference.path));
      const edge = index === undefined ? undefined : graph.edges[index];
      if (
        !edge ||
        edge.parentRecordSha256 !== checked.recordSha256 ||
        !same(edge.reference, reference) ||
        (reference.kind === "record" && !same(edge.target, reference.source))
      )
        conflict();
    }
    return node.read;
  };
  const candidateRead = inspect(candidateSource, true);
  const policyRead = inspect(policySource, true);
  if (
    candidateRead.observation.status !== "verified" ||
    policyRead.observation.status !== "verified"
  )
    return conflict();
  const candidate = candidateRead.record as ReleaseCandidate;
  const policy = policyRead.record as ReleasePolicy;
  const candidateHash = candidateRead.observation.recordSha256;
  const policyHash = policyRead.observation.recordSha256;
  const edgeAt = (source: PolicyEvaluationSourceReference, path: string, hash: string) => {
    const index = edges.get(edgeKey(source, path));
    const edge = index === undefined ? undefined : graph.edges[index];
    if (index === undefined || !edge || edge.parentRecordSha256 !== hash) return conflict();
    return { edge, index };
  };
  candidate.comparisons.forEach((reference, index) => {
    const source = { kind: "comparison_result" as const, reference };
    inspect(source, false);
    const { edge } = edgeAt(candidateSource, `/comparisons/${index}`, candidateHash);
    if (
      edge.reference.kind !== "record" ||
      !same(edge.reference.source, source) ||
      !same(edge.target, source)
    )
      conflict();
  });
  // Revalidate original definitions/snapshots, including unavailable lineage prerequisites,
  // before the owning selector/reproducer can use any captured body.
  for (const { read } of graph.nodes)
    if (read.source.kind === "comparison_definition" || read.source.kind === "comparison_snapshot")
      inspect(read.source, false);
  const resolved = resolveCapturedComparisonEvidence(request, graph);
  if (
    resolved.status !== "inventory_captured" ||
    !same(resolved.inventory, capture.inventory) ||
    !same(resolved.comparisons, capture.comparisons)
  )
    return conflict();
  const context = {
    candidate: { source: candidateSource, recordSha256: candidateHash },
    policy: { source: policySource, recordSha256: policyHash },
    inventory: resolved.inventory,
  };
  charge(1, encodeEvaluationCanonicalJson(context).byteLength);
  const hashAt = (source: PolicyEvaluationSourceReference) => {
    const read = nodes.get(policyEvaluationSourceReferenceKey(source))?.read;
    if (!read || !same(read.source, source) || read.observation.status !== "verified")
      return conflict();
    return read.observation.recordSha256;
  };
  const rules: PolicyComparisonRuleBindings["rules"][number][] = [];
  for (const [ruleIndex, { ruleId, predicate }] of policy.rules.entries()) {
    if (!("comparison" in predicate)) continue;
    const { edge, index: policyEdgeIndex } = edgeAt(
      policySource,
      `/rules/${ruleIndex}/predicate/comparison`,
      policyHash,
    );
    const comparisonSource = {
      kind: "comparison_definition" as const,
      reference: predicate.comparison,
    };
    if (
      edge.reference.kind !== "record" ||
      !same(edge.reference.source, comparisonSource) ||
      !same(edge.target, comparisonSource)
    )
      conflict();
    const comparisonIndex = resolved.comparisons.findIndex((item) =>
      same(item.selection.comparison, predicate.comparison),
    );
    const captured = resolved.comparisons[comparisonIndex];
    if (!captured) conflict();
    let binding: PolicyComparisonRuleBindings["rules"][number]["binding"];
    if (captured.status !== "lineage_verified") {
      binding = { status: "comparison_unusable", reason: captured.status };
    } else {
      const { comparison, result, baselineSnapshot, candidateSnapshot } = captured.lineage;
      const definitionIndex = comparison.metrics.findIndex(
        (metric) => metric.metricId === predicate.metricId,
      );
      const resultIndex = result.metricResults.findIndex(
        (metric) => metric.metricId === predicate.metricId,
      );
      const definition = comparison.metrics[definitionIndex];
      const metricResult = result.metricResults[resultIndex];
      if (!definition && !metricResult) {
        binding = { status: "metric_missing" };
      } else {
        if (!definition || !metricResult) conflict();
        const stratumIndex = comparison.strata.findIndex(
          (stratum) => stratum.stratumId === definition.stratumId,
        );
        const stratum = comparison.strata[stratumIndex];
        if (!stratum) conflict();
        const reasons: Metric["compatibility"]["reasons"][number][] = [];
        if (predicate.kind === "comparison_threshold") {
          if (definition.kind !== predicate.metricKind) reasons.push("metric_kind");
          if (definition.unit !== predicate.unit) reasons.push("unit");
        } else if (predicate.kind === "safety_event_ceiling") {
          if (definition.kind !== "safety_event_count") reasons.push("metric_kind");
          if (definition.unit !== predicate.unit) reasons.push("unit");
          if (
            definition.kind === "safety_event_count" &&
            definition.eventKind !== predicate.eventClass
          )
            reasons.push("event_class");
        }
        binding = {
          status: "metric_bound",
          metric: {
            definitionIndex,
            resultIndex,
            stratumIndex,
            definition,
            result: metricResult,
            stratum,
            provenance: {
              calculationPolicy: comparison.calculationPolicy,
              comparability: result.comparability,
              pairing: result.pairing,
              latestSourceCutoff: result.latestSourceCutoff,
            },
            recordHashes: {
              comparison: hashAt(comparisonSource),
              result: hashAt({ kind: "comparison_result", reference: captured.selection.result }),
              baselineSnapshot: hashAt({
                kind: "comparison_snapshot",
                reference: {
                  role: baselineSnapshot.role,
                  snapshotId: baselineSnapshot.snapshotId,
                  definitionSha256: baselineSnapshot.definitionSha256,
                },
              }),
              candidateSnapshot: hashAt({
                kind: "comparison_snapshot",
                reference: {
                  role: candidateSnapshot.role,
                  snapshotId: candidateSnapshot.snapshotId,
                  definitionSha256: candidateSnapshot.definitionSha256,
                },
              }),
            },
            compatibility: {
              status: reasons.length === 0 ? "compatible" : "incompatible",
              reasons,
            },
          },
        };
      }
    }
    const rule = { ruleId, ruleIndex, predicate, policyEdgeIndex, comparisonIndex, binding };
    charge(1, encodeEvaluationCanonicalJson(rule).byteLength);
    rules.push(rule);
  }
  return structuredClone({ ...context, rules, inspectionUsage: { references, referenceBytes } });
}
