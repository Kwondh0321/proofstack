import {
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationComparisonInventory,
  type PolicyEvaluationComparisonResolution,
  type PolicyEvaluationManifestEntry,
  type PolicyEvaluationRequest,
  policyEvaluationSourceReferenceKey,
  type ReleaseCandidate,
} from "@proofstack/contracts";
import {
  type PolicyEvaluationComparisonLineage,
  PolicyEvaluationComparisonLineageError,
  type PolicyEvaluationControlRead,
  type PolicyEvaluationControlSource,
  resolveCapturedPolicyEvaluationComparisons,
  resolvePolicyEvaluationComparisonLineage,
  validatePolicyEvaluationRequestRecord,
} from "@proofstack/core";
import { capturePolicyRecordGraph, type PolicyRecordGraph } from "./capture-record-graph.js";
import type { PolicyRecordGraphRepositories } from "./record-routing.js";

type UniqueSelection = Extract<PolicyEvaluationComparisonResolution, { status: "unique" }>;

export type CapturedPolicyComparison =
  | {
      readonly status: "selection_unresolved";
      readonly selection: Exclude<PolicyEvaluationComparisonResolution, { status: "unique" }>;
    }
  | {
      readonly status: "records_unavailable";
      readonly selection: UniqueSelection;
      readonly unavailableRecords: readonly PolicyEvaluationManifestEntry[];
    }
  | {
      readonly status: "lineage_invalid";
      readonly selection: UniqueSelection;
      readonly reason: PolicyEvaluationComparisonLineageError["code"];
    }
  | {
      readonly status: "lineage_verified";
      readonly selection: UniqueSelection;
      readonly lineage: PolicyEvaluationComparisonLineage;
    };

export type PolicyComparisonEvidenceCapture = { readonly graph: PolicyRecordGraph } & (
  | {
      readonly status: "roots_unavailable";
      readonly unavailableRoots: readonly PolicyEvaluationManifestEntry[];
    }
  | {
      readonly status: "inventory_captured";
      readonly inventory: PolicyEvaluationComparisonInventory;
      readonly comparisons: readonly CapturedPolicyComparison[];
    }
);

function exact(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}

function entry(read: PolicyEvaluationControlRead): PolicyEvaluationManifestEntry {
  return { source: read.source, observation: read.observation };
}

/**
 * Acquire once from request roots, preserve the complete comparison inventory, then rederive each
 * uniquely selected comparison using only captured bodies. No caller-supplied graph is accepted.
 * Trusted callers must authorize the read ports first. Even lineage_verified is not recursive
 * semantic closure, artifact/authority validation, a sealed snapshot, or a policy/release verdict.
 */
export async function capturePolicyComparisonEvidence(
  input: unknown,
  repositories: PolicyRecordGraphRepositories,
): Promise<PolicyComparisonEvidenceCapture> {
  const request = validatePolicyEvaluationRequestRecord(input);
  const graph = await capturePolicyRecordGraph(request, repositories);
  return resolveCapturedComparisonEvidence(request, graph);
}

/** Internal only: the graph must come from this invocation's fixed acquisition pipeline. */
export function resolveCapturedComparisonEvidence(
  request: PolicyEvaluationRequest,
  graph: PolicyRecordGraph,
): PolicyComparisonEvidenceCapture {
  const nodes = new Map(
    graph.nodes.map(({ read }) => [policyEvaluationSourceReferenceKey(read.source), read]),
  );
  const control = (source: PolicyEvaluationControlSource): PolicyEvaluationControlRead => {
    const read = nodes.get(policyEvaluationSourceReferenceKey(source));
    // This is an internal graph invariant, not an absent repository record. The latter has a node
    // with its explicit missing/unavailable observation and must never be synthesized here.
    if (!read || !exact(read.source, source))
      throw new Error("Captured comparison source is absent or changed");
    return read as PolicyEvaluationControlRead;
  };
  const candidate = control({ kind: "release_candidate", reference: request.candidate });
  const policy = control({ kind: "release_policy", reference: request.policy });
  const unavailableRoots = [candidate, policy]
    .filter(({ observation }) => observation.status !== "verified")
    .map(entry);
  if (unavailableRoots.length > 0) return { graph, status: "roots_unavailable", unavailableRoots };

  const roots = { candidate: candidate.record, policy: policy.record, request };
  const acquisitions = (candidate.record as ReleaseCandidate).comparisons.map((reference) =>
    control({ kind: "comparison_result", reference }),
  );
  const inventory = resolveCapturedPolicyEvaluationComparisons({ ...roots, acquisitions });
  const comparisons: CapturedPolicyComparison[] = inventory.policyComparisons.map((selection) => {
    if (selection.status !== "unique") return { status: "selection_unresolved", selection };
    const member = inventory.members.find(({ reference }) => exact(reference, selection.result));
    if (member?.observation.status !== "verified")
      throw new Error("Unique comparison lacks a verified member");
    const definition = control({ kind: "comparison_definition", reference: selection.comparison });
    const baseline = control({
      kind: "comparison_snapshot",
      reference: member.observation.baselineSnapshot,
    });
    const current = control({
      kind: "comparison_snapshot",
      reference: member.observation.candidateSnapshot,
    });
    const unavailableRecords = [definition, baseline, current]
      .filter(({ observation }) => observation.status !== "verified")
      .map(entry);
    if (unavailableRecords.length > 0)
      return { status: "records_unavailable", selection, unavailableRecords };
    try {
      // Unique selection requires EVERY candidate member to be verified. Only at this point is
      // the raw-body lineage API lossless: no missing/unavailable observation can become null.
      const lineage = resolvePolicyEvaluationComparisonLineage({
        ...roots,
        acquisitions: acquisitions.map((read) => ({
          reference: (
            read.source as Extract<PolicyEvaluationControlSource, { kind: "comparison_result" }>
          ).reference,
          result: read.record,
        })),
        comparison: definition.record,
        baselineSnapshot: baseline.record,
        candidateSnapshot: current.record,
      });
      if (!exact(lineage.inventory, inventory))
        throw new Error("Comparison inventory changed during lineage verification");
      return { status: "lineage_verified", selection, lineage };
    } catch (cause) {
      if (!(cause instanceof PolicyEvaluationComparisonLineageError)) throw cause;
      return { status: "lineage_invalid", selection, reason: cause.code };
    }
  });
  return { graph, status: "inventory_captured", inventory, comparisons };
}
