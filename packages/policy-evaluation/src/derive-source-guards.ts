import {
  encodeEvaluationCanonicalJson,
  OpaqueIdSchema,
  type PolicyEvaluationRequest,
  type ReleasePolicyReference,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import { policyEvaluationRequestReference, releasePolicyReference } from "@proofstack/core";
import { type AcquisitionBudget, PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyArtifactCapture } from "./capture-artifact-evidence.js";
import type { PolicyLifecycleObservation } from "./capture-policy-lifecycle.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";
import {
  artifactCatalogMaterial,
  type PolicyStoredArtifactCapture,
  storedArtifactOccurrences,
} from "./capture-stored-artifacts.js";
import type { PolicyTraceArtifactReference } from "./capture-trace-evidence.js";

export type PolicyEvaluationSourceGuardOrigin =
  | { readonly kind: "artifact_capture"; readonly captureIndex: number }
  | { readonly kind: "policy_node"; readonly nodeIndex: number }
  | { readonly kind: "storage_policy_node"; readonly nodeIndex: number }
  | { readonly kind: "stored_artifact_capture"; readonly captureIndex: number }
  | { readonly kind: "storage_artifact_identity"; readonly edgeIndex: number }
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
    "request" | "scope" | "evaluationTime" | "roots" | "nodes" | "edges" | "storageInventory"
  >;
  readonly traceReferences: readonly Pick<PolicyTraceArtifactReference, "reference">[];
  readonly artifacts: readonly PolicyArtifactCapture[];
  readonly storedArtifacts: readonly PolicyStoredArtifactCapture[];
  readonly lifecycle: PolicyLifecycleObservation;
}

function canonical(value: unknown): string {
  return serializeEvaluationCanonicalJson(value);
}

/** Internal composition over the complete request-owned capture; never a public subset input. */
export function deriveCapturedPolicySourceGuards(
  { request, graph, traceReferences, artifacts, storedArtifacts, lifecycle }: Inputs,
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
    descriptor?: unknown,
    observation?: unknown,
  ) => {
    const key = JSON.stringify([kind, id]);
    if (!OpaqueIdSchema.safeParse(id).success)
      throw new PolicyRecordGraphError("reference_conflict", key);
    const exact = descriptor === undefined ? undefined : canonical(descriptor);
    const previousDescriptor = descriptors.get(key);
    if (exact !== undefined && previousDescriptor !== undefined && previousDescriptor !== exact)
      throw new PolicyRecordGraphError("reference_conflict", key);
    const observed = observation === undefined ? undefined : canonical(observation);
    const previousObservation = observations.get(key);
    if (
      observed !== undefined &&
      previousObservation !== undefined &&
      previousObservation !== observed
    )
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
    if (exact !== undefined) descriptors.set(key, exact);
    if (observed !== undefined) observations.set(key, observed);
  };
  const policy = (
    reference: ReleasePolicyReference,
    origin: PolicyEvaluationSourceGuardOrigin,
    observation: unknown,
  ) => add("release_policy", reference.policyVersionId, origin, reference, observation);
  graph.nodes.forEach(({ read, storage }, nodeIndex) => {
    if (read.source.kind === "release_policy")
      policy(
        read.source.reference,
        { kind: "policy_node", nodeIndex },
        storage ?? read.observation,
      );
  });
  graph.storageInventory.nodes.forEach(({ capture }, nodeIndex) => {
    if (capture.read.source.kind === "release_policy")
      policy(
        capture.read.source.reference,
        { kind: "storage_policy_node", nodeIndex },
        capture.storage ?? capture.read.observation,
      );
  });

  let captureIndex = 0;
  const contentObservations = new Map<string, string>();
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
    const content = canonical({
      catalog: captured.read.catalog,
      observation: captured.read.observation,
    });
    const previousContent = contentObservations.get(reference.artifactId);
    if (previousContent !== undefined && previousContent !== content)
      throw new PolicyRecordGraphError("observation_conflict");
    contentObservations.set(reference.artifactId, content);
    add(
      "artifact",
      reference.artifactId,
      { kind: "artifact_capture", captureIndex },
      reference,
      artifactCatalogMaterial(captured.read),
    );
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
  const storedOccurrences = storedArtifactOccurrences(graph);
  if (storedOccurrences.length !== storedArtifacts.length)
    throw new PolicyRecordGraphError("observation_conflict");
  storedOccurrences.forEach(({ origin, reference }, captureIndex) => {
    const captured = storedArtifacts[captureIndex];
    if (
      !captured ||
      canonical(captured.origin) !== canonical(origin) ||
      canonical(captured.read.reference) !== canonical(reference) ||
      canonical(captured.read.scope) !== canonical(request.scope) ||
      captured.read.evaluationTime !== request.evaluationTime
    )
      throw new PolicyRecordGraphError("observation_conflict");
    add(
      "artifact",
      reference.artifactId,
      { kind: "stored_artifact_capture", captureIndex },
      reference,
      { catalog: captured.read.catalog, observation: captured.read.observation },
    );
  });
  graph.storageInventory.edges.forEach(({ reference }, edgeIndex) => {
    if (
      reference.kind === "control_declaration" &&
      reference.declaration.kind === "artifact_identity"
    )
      add("artifact", reference.declaration.reference, {
        kind: "storage_artifact_identity",
        edgeIndex,
      });
  });
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
          record: successor.record,
          recordSha256: successor.recordSha256,
          receiptTime: successor.record.publishedAt,
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
