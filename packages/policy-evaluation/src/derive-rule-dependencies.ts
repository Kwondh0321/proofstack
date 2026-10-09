import {
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationManifestEntry,
  type PolicyEvaluationRequest,
  type PolicyEvaluationSourceReference,
  policyEvaluationSourceReferenceKey,
} from "@proofstack/contracts";
import {
  PolicyEvaluationEvidenceReferenceError,
  type PolicyEvaluationEvidenceReferenceLimits,
  policyEvaluationRequestReference,
  validatePolicyEvaluationRequestRecord,
} from "@proofstack/core";
import { PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyArtifactRuleBindings } from "./capture-artifact-rules.js";
import type { PolicyAssessmentRuleInputs } from "./capture-assessment-rules.js";
import type { PolicyComparisonRuleBindings } from "./capture-comparison-rules.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";
import type { PolicyRuleInputs } from "./capture-rule-inputs.js";
import { deriveCapturedRecordClosure, type PolicyRecordClosure } from "./derive-record-closure.js";

type Coordinates = {
  readonly seedEdgeIndexes: readonly number[];
  readonly sourceIndexes: readonly number[];
  readonly edgeIndexes: readonly number[];
  readonly frontierIndexes: readonly number[];
};

export interface PolicyRuleDependencyClosure {
  readonly authorityBoundary: "captured_dependencies_only";
  readonly request: PolicyRuleInputs["request"];
  readonly scope: PolicyEvaluationRequest["scope"];
  readonly evaluationTime: string;
  /** Complete independently reconstructed inventory, including unused/unreadable sources. */
  readonly sources: readonly PolicyEvaluationManifestEntry[];
  /** Original occurrences; a resolved declaration still retains its authority frontier. */
  readonly frontier: PolicyRecordClosure["frontier"];
  /** Non-rule root context, separate from each predicate's evidence dependencies. */
  readonly rootContext: Coordinates;
  readonly rules: readonly (Coordinates & {
    readonly ruleIndex: number;
    readonly ruleId: string;
  })[];
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
function sorted(values: ReadonlySet<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

/** Internal fixed composition only; coordinates do not qualify operands or seal observations. */
export function deriveCapturedRuleDependencies(
  input: PolicyEvaluationRequest,
  graph: PolicyRecordGraph,
  reports: {
    readonly artifactRules: PolicyArtifactRuleBindings;
    readonly comparisonRules: PolicyComparisonRuleBindings;
    readonly assessmentRules: PolicyAssessmentRuleInputs;
    readonly ruleInputs: PolicyRuleInputs;
  },
  limits: PolicyEvaluationEvidenceReferenceLimits,
): PolicyRuleDependencyClosure {
  const request = validatePolicyEvaluationRequestRecord(input);
  const { ruleInputs, artifactRules, comparisonRules, assessmentRules } = reports;
  if (
    !same(graph.request, policyEvaluationRequestReference(request)) ||
    !same(graph.scope, request.scope) ||
    graph.evaluationTime !== request.evaluationTime ||
    !same(ruleInputs.request, graph.request) ||
    !same(ruleInputs.scope, graph.scope) ||
    ruleInputs.evaluationTime !== graph.evaluationTime
  )
    conflict();
  // Fixed owning enumeration also rechecks hashes, receipts, selectors, protocol candidates,
  // original parent positions and reachability. Never trust graph.entries as expected closure.
  const { entries, closure } = deriveCapturedRecordClosure(request, graph, limits);
  if (!same(entries, graph.entries) || !same(closure, graph.recordClosure)) conflict();
  let references = closure.inspectionUsage.references;
  let referenceBytes = closure.inspectionUsage.referenceBytes;
  const admit = (value: unknown, count = 1) => {
    if (count > limits.maxReferences - references)
      throw new PolicyEvaluationEvidenceReferenceError("reference_limit_exceeded");
    const bytes = encodeEvaluationCanonicalJson(value).byteLength;
    if (bytes > limits.maxReferenceBytes - referenceBytes)
      throw new PolicyEvaluationEvidenceReferenceError("reference_bytes_exceeded");
    references += count;
    referenceBytes += bytes;
  };
  const context = {
    authorityBoundary: "captured_dependencies_only" as const,
    request: graph.request,
    scope: graph.scope,
    evaluationTime: graph.evaluationTime,
  };
  admit(context);
  for (const entry of entries) admit(entry);
  for (const occurrence of closure.frontier) admit(occurrence);
  const sourceIndexes = new Map(
    entries.map(({ source }, index) => [policyEvaluationSourceReferenceKey(source), index]),
  );
  const indexOf = (source: PolicyEvaluationSourceReference) => {
    const index = sourceIndexes.get(policyEvaluationSourceReferenceKey(source));
    if (index === undefined || !same(entries[index]?.source, source)) return conflict();
    return index;
  };
  const roots = new Set(graph.roots.map(indexOf));
  const byParent = new Map<number, number[]>();
  graph.edges.forEach((edge, index) => {
    const parent = indexOf(edge.parent);
    const existing = byParent.get(parent) ?? [];
    existing.push(index);
    byParent.set(parent, existing);
  });
  const frontierByEdge = new Map(
    closure.frontier.map(({ edgeIndex }, index) => [edgeIndex, index]),
  );
  const walk = (seeds: ReadonlySet<number>): Coordinates => {
    // Roots bind every frame, but only explicit root seeds are expanded. Revisiting a root
    // through a cycle must not silently pull every other rule into this rule's dependencies.
    const sources = new Set(roots);
    const edges = new Set<number>();
    const frontier = new Set<number>();
    const queue = sorted(seeds);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const index = queue[cursor];
      if (index === undefined) return conflict();
      if (edges.has(index)) continue;
      const edge = graph.edges[index];
      if (!edge) return conflict();
      edges.add(index);
      sources.add(indexOf(edge.parent));
      const frontierIndex = frontierByEdge.get(index);
      if (frontierIndex !== undefined) frontier.add(frontierIndex);
      const targets = edge.target ? [edge.target] : [];
      // A null single target can still have many retained protocol children. Preserve all
      // original members, including future/unavailable and descriptor-mismatching siblings.
      for (const member of edge.protocolResolution?.matches ?? [])
        if (member.status === "retained") targets.push(member.read.source);
      for (const target of targets) {
        const child = indexOf(target);
        if (sources.has(child)) continue;
        sources.add(child);
        queue.push(...(byParent.get(child) ?? []));
      }
    }
    return {
      seedEdgeIndexes: sorted(seeds),
      sourceIndexes: sorted(sources),
      edgeIndexes: sorted(edges),
      frontierIndexes: sorted(frontier),
    };
  };
  const chargeFrame = (frame: Coordinates) =>
    admit(
      frame,
      1 +
        frame.seedEdgeIndexes.length +
        frame.sourceIndexes.length +
        frame.edgeIndexes.length +
        frame.frontierIndexes.length,
    );
  const policyKey = policyEvaluationSourceReferenceKey(ruleInputs.policy.source);
  const candidateKey = policyEvaluationSourceReferenceKey(ruleInputs.candidate.source);
  const rootSeeds = new Set<number>();
  const candidateComparisonSeeds = new Set<number>();
  const ruleSeeds = new Map<number, Set<number>>();
  for (const [index, edge] of graph.edges.entries()) {
    const key = policyEvaluationSourceReferenceKey(edge.parent);
    if (key === policyKey) {
      const match = /^\/rules\/(\d+)\//.exec(edge.reference.path);
      if (!match) rootSeeds.add(index);
      else {
        const ruleIndex = Number(match[1]);
        const seeds = ruleSeeds.get(ruleIndex) ?? new Set<number>();
        seeds.add(index);
        ruleSeeds.set(ruleIndex, seeds);
      }
    } else if (key === candidateKey) {
      if (edge.reference.path.startsWith("/comparisons/")) candidateComparisonSeeds.add(index);
      else if (
        !["/assessments/", "/modelAssuranceAssessments/", "/buildArtifacts/"].some((prefix) =>
          edge.reference.path.startsWith(prefix),
        )
      )
        rootSeeds.add(index);
    }
  }
  const rootContext = walk(rootSeeds);
  chargeFrame(rootContext);
  const rules: PolicyRuleDependencyClosure["rules"][number][] = [];
  for (const original of ruleInputs.rules) {
    const { ruleIndex, rule, binding } = original;
    const seeds = ruleSeeds.get(ruleIndex) ?? new Set<number>();
    ruleSeeds.delete(ruleIndex);
    if (binding.kind === "comparison") {
      const entry = comparisonRules.rules[binding.inputIndex];
      if (entry?.ruleIndex !== ruleIndex || entry.ruleId !== rule.ruleId) conflict();
      for (const index of candidateComparisonSeeds) seeds.add(index);
    } else if (binding.kind === "assessment") {
      const entry = assessmentRules.rules[binding.inputIndex];
      if (entry?.ruleIndex !== ruleIndex || entry.ruleId !== rule.ruleId) conflict();
      const member = assessmentRules.members.find(({ source }) => same(source, entry.source));
      if (member) seeds.add(member.candidateEdgeIndex);
    } else if (binding.kind === "artifact") {
      const entry = artifactRules.rules[binding.inputIndex];
      if (entry?.ruleIndex !== ruleIndex || entry.ruleId !== rule.ruleId) conflict();
      if (entry.binding.status === "component_present") {
        const member = artifactRules.members[entry.binding.memberIndex];
        if (!member) conflict();
        seeds.add(member.candidateEdgeIndex);
      }
    }
    const frame = { ruleIndex, ruleId: rule.ruleId, ...walk(seeds) };
    chargeFrame(frame);
    rules.push(frame);
  }
  if (ruleSeeds.size !== 0) conflict();
  return structuredClone({
    ...context,
    sources: entries,
    frontier: closure.frontier,
    rootContext,
    rules,
    inspectionUsage: { references, referenceBytes },
  });
}
