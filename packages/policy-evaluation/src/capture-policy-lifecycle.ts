import {
  encodeEvaluationCanonicalJson,
  policyEvaluationSourceReferenceKey,
} from "@proofstack/contracts";
import {
  type Clock,
  inspectPolicyEvaluationControlRecord,
  type PolicyLifecycleObservation,
  type PolicyLifecycleReadRepository,
  readPolicyEvaluationLifecycle,
} from "@proofstack/core";
import { PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";

export type { PolicyLifecycleObservation, PolicyLifecycleReadRepository } from "@proofstack/core";

/** Internal request-rooted composition; lifecycle semantics and digests stay in the owning core. */
export async function observeCapturedPolicyLifecycle(
  graph: Pick<PolicyRecordGraph, "roots" | "nodes" | "scope" | "evaluationTime">,
  repository: PolicyLifecycleReadRepository,
  clock: Clock,
): Promise<PolicyLifecycleObservation> {
  const roots = graph.roots.filter((source) => source.kind === "release_policy");
  const root = roots[0];
  const parent =
    root &&
    graph.nodes.find(
      ({ read }) =>
        policyEvaluationSourceReferenceKey(read.source) ===
        policyEvaluationSourceReferenceKey(root),
    )?.read;
  if (
    roots.length !== 1 ||
    !root ||
    !parent ||
    parent.observation.status !== "verified" ||
    !Buffer.from(encodeEvaluationCanonicalJson(parent.source)).equals(
      encodeEvaluationCanonicalJson(root),
    )
  )
    throw new PolicyRecordGraphError("reference_conflict");
  const input = { scope: graph.scope, evaluationTime: graph.evaluationTime, source: root };
  const inspected = inspectPolicyEvaluationControlRecord(input, parent.record);
  if (
    inspected.observation.status !== "verified" ||
    inspected.observation.recordSha256 !== parent.observation.recordSha256
  )
    throw new PolicyRecordGraphError("observation_conflict");
  return readPolicyEvaluationLifecycle(
    { scope: graph.scope, evaluationTime: graph.evaluationTime, policy: root.reference },
    inspected,
    repository,
    clock,
  );
}
