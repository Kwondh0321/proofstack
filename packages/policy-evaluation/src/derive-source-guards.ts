import {
  encodeEvaluationCanonicalJson,
  OpaqueIdSchema,
  type PolicyEvaluationRequest,
  type ReleasePolicyReference,
} from "@proofstack/contracts";
import { policyEvaluationRequestReference, releasePolicyReference } from "@proofstack/core";
import { AcquisitionBudget, PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyArtifactCapture } from "./capture-artifact-evidence.js";
import type { PolicyLifecycleObservation } from "./capture-policy-lifecycle.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";
import type { PolicyTraceArtifactReference } from "./capture-trace-evidence.js";

export type PolicyEvaluationSourceGuardOrigin =
  | { readonly kind: "artifact_capture"; readonly captureIndex: number }
  | { readonly kind: "policy_node"; readonly nodeIndex: number }
  | { readonly kind: "policy_successor"; readonly historyIndex: number };

/** A coordinate map for the installed lock domain, not a lock, revision token or authority. */
export interface PolicyEvaluationSourceGuard {
  readonly kind: "artifact" | "release_policy";
  readonly id: string;
  readonly origins: readonly PolicyEvaluationSourceGuardOrigin[];
}

export interface PolicyEvaluationSourceGuardUsage {
  readonly resources: number;
  readonly origins: number;
  /** Canonical guard-array bytes additionally admitted against the shared metadata budget. */
  readonly canonicalBytes: number;
}

interface Inputs {
  readonly request: PolicyEvaluationRequest;
  readonly graph: Pick<
    PolicyRecordGraph,
    "request" | "scope" | "evaluationTime" | "roots" | "nodes" | "edges"
  >;
  readonly traceReferences: readonly Pick<PolicyTraceArtifactReference, "reference">[];
  readonly artifacts: readonly PolicyArtifactCapture[];
  readonly lifecycle: PolicyLifecycleObservation;
}

function canonical(value: unknown): string {
  return Buffer.from(encodeEvaluationCanonicalJson(value)).toString("utf8");
}

/** Internal composition over the complete request-owned capture; never a public subset input. */
export function deriveCapturedPolicySourceGuards(
  { request, graph, traceReferences, artifacts, lifecycle }: Inputs,
  budget: AcquisitionBudget,
): {
  readonly guards: readonly PolicyEvaluationSourceGuard[];
  readonly usage: PolicyEvaluationSourceGuardUsage;
} {
  const roots = [
    { kind: "release_candidate", reference: request.candidate },
    { kind: "release_policy", reference: request.policy },
  ];
  if (
    canonical(graph.request) !== canonical(policyEvaluationRequestReference(request)) ||
    canonical(graph.scope) !== canonical(request.scope) ||
    graph.evaluationTime !== request.evaluationTime ||
    canonical(graph.roots) !== canonical(roots)
  )
    throw new PolicyRecordGraphError("reference_conflict");
  const root = graph.nodes.find(
    ({ read }) =>
      read.source.kind === "release_policy" && canonical(read.source) === canonical(roots[1]),
  )?.read;
  if (
    !root ||
    root.observation.status !== "verified" ||
    canonical(lifecycle.scope) !== canonical(request.scope) ||
    canonical(lifecycle.policy) !== canonical(request.policy) ||
    lifecycle.evaluationTime !== request.evaluationTime ||
    lifecycle.policyRecordSha256 !== root.observation.recordSha256
  )
    throw new PolicyRecordGraphError("observation_conflict");

  const resources = new Map<
    string,
    {
      kind: PolicyEvaluationSourceGuard["kind"];
      id: string;
      origins: PolicyEvaluationSourceGuardOrigin[];
    }
  >();
  const descriptors = new Map<string, string>();
  const observations = new Map<string, string>();
  let originCount = 0;
  let canonicalBytes = 0;
  const charge = (bytes: number) => {
    // Coordinates do not create new evidence-reference occurrences, but their bytes are not free.
    budget.addReferences(0, bytes);
    canonicalBytes += bytes;
  };
  charge(2); // The enclosing array, before any allocation of resource/origin entries.
  const add = (
    kind: PolicyEvaluationSourceGuard["kind"],
    id: string,
    origin: PolicyEvaluationSourceGuardOrigin,
    descriptor: unknown,
    observation: unknown,
  ) => {
    const key = JSON.stringify([kind, id]);
    if (!OpaqueIdSchema.safeParse(id).success)
      throw new PolicyRecordGraphError("reference_conflict", key);
    const exact = canonical(descriptor);
    const previousDescriptor = descriptors.get(key);
    if (previousDescriptor !== undefined && previousDescriptor !== exact)
      throw new PolicyRecordGraphError("reference_conflict", key);
    const observed = canonical(observation);
    const previousObservation = observations.get(key);
    if (previousObservation !== undefined && previousObservation !== observed)
      throw new PolicyRecordGraphError("observation_conflict", key);
    let resource = resources.get(key);
    if (!resource) {
      if (resources.size >= request.limits.maxAcquisitionRecords)
        throw new PolicyRecordGraphError("guard_limit");
      resource = { kind, id, origins: [] };
      charge(encodeEvaluationCanonicalJson(resource).byteLength + (resources.size > 0 ? 1 : 0));
      resources.set(key, resource);
    }
    charge(
      encodeEvaluationCanonicalJson(origin).byteLength + (resource.origins.length > 0 ? 1 : 0),
    );
    resource.origins.push(origin);
    originCount++;
    descriptors.set(key, exact);
    observations.set(key, observed);
  };
  const policy = (
    reference: ReleasePolicyReference,
    origin: PolicyEvaluationSourceGuardOrigin,
    observation: unknown,
  ) => add("release_policy", reference.policyVersionId, origin, reference, observation);
  graph.nodes.forEach(({ read }, nodeIndex) => {
    if (read.source.kind === "release_policy")
      policy(read.source.reference, { kind: "policy_node", nodeIndex }, read.observation);
  });

  let captureIndex = 0;
  const artifact = (
    origin: PolicyArtifactCapture["origin"],
    reference: PolicyArtifactCapture["read"]["reference"],
  ) => {
    const captured = artifacts[captureIndex];
    if (
      !captured ||
      canonical(captured.origin) !== canonical(origin) ||
      canonical(captured.read.reference) !== canonical(reference) ||
      canonical(captured.read.scope) !== canonical(request.scope) ||
      captured.read.evaluationTime !== request.evaluationTime
    )
      throw new PolicyRecordGraphError("observation_conflict");
    add("artifact", reference.artifactId, { kind: "artifact_capture", captureIndex }, reference, {
      catalog: captured.read.catalog,
      observation: captured.read.observation,
    });
    captureIndex++;
  };
  graph.edges.forEach((edge, edgeIndex) => {
    if (edge.reference.kind === "artifact")
      artifact({ kind: "record", edgeIndex }, edge.reference.reference);
  });
  traceReferences.forEach(({ reference }, artifactReferenceIndex) => {
    artifact({ kind: "trace", artifactReferenceIndex }, reference);
  });
  if (captureIndex !== artifacts.length) throw new PolicyRecordGraphError("observation_conflict");
  lifecycle.history.forEach(({ record, successor }, historyIndex) => {
    if (record.kind === "superseded") {
      if (
        !successor ||
        canonical(releasePolicyReference(successor.record)) !== canonical(record.successor)
      )
        throw new PolicyRecordGraphError("observation_conflict");
      policy(
        record.successor,
        { kind: "policy_successor", historyIndex },
        {
          status: "verified",
          recordSha256: successor.recordSha256,
        },
      );
    } else if (successor !== null) throw new PolicyRecordGraphError("observation_conflict");
  });
  const guards = [...resources.values()].sort((left, right) =>
    left.kind < right.kind
      ? -1
      : left.kind > right.kind
        ? 1
        : left.id < right.id
          ? -1
          : left.id > right.id
            ? 1
            : 0,
  );
  return { guards, usage: { resources: guards.length, origins: originCount, canonicalBytes } };
}
