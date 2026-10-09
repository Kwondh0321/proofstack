import {
  encodeEvaluationCanonicalJson,
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
  validatePolicyEvaluationRequestRecord,
} from "@proofstack/core";
import { PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyArtifactCapture } from "./capture-artifact-evidence.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";
import { enumerateCapturedPolicyRecord, type PolicyRecordRead } from "./record-routing.js";

type Predicate = Extract<
  ReleasePolicy["rules"][number]["predicate"],
  { kind: "artifact_required" }
>;
type Model = Extract<ReleaseCandidate["runtimeComponents"][number], { kind: "model" }>;
type ArtifactReference = ReleaseCandidate["buildArtifacts"][number]["artifact"];
type Member = {
  readonly componentKind: Predicate["componentKind"];
  readonly role: string;
  readonly candidatePath: string;
  readonly candidateEdgeIndex: number;
} & (
  | {
      readonly status: "artifact_declared";
      readonly reference: ArtifactReference;
      readonly artifactCaptureIndex: number;
    }
  | { readonly status: "model_alias"; readonly declaration: Model }
);

export interface PolicyArtifactRuleBindings {
  readonly candidate: {
    readonly source: Extract<PolicyEvaluationSourceReference, { kind: "release_candidate" }>;
    readonly recordSha256: string;
  };
  readonly policy: {
    readonly source: Extract<PolicyEvaluationSourceReference, { kind: "release_policy" }>;
    readonly recordSha256: string;
  };
  /** Complete candidate component inventory, including unused and alias-only models. */
  readonly members: readonly Member[];
  /** Every artifact-required occurrence in original policy order; no predicate outcome. */
  readonly rules: readonly {
    readonly ruleId: string;
    readonly ruleIndex: number;
    readonly predicate: Predicate;
    readonly policyEdgeIndex: number;
    readonly binding:
      | { readonly status: "component_present"; readonly memberIndex: number }
      | {
          readonly status: "component_missing";
          readonly omission: ReleaseCandidate["omissions"][number] | null;
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

/** Internal request-owned provenance join. No I/O, policy outcome, current authority or seal. */
export function inspectCapturedArtifactRules(
  input: PolicyEvaluationRequest,
  graph: Pick<PolicyRecordGraph, "scope" | "evaluationTime" | "nodes" | "edges">,
  artifacts: readonly PolicyArtifactCapture[],
  limits: PolicyEvaluationEvidenceReferenceLimits,
): PolicyArtifactRuleBindings {
  const request = validatePolicyEvaluationRequestRecord(input);
  new PolicyEvaluationReferenceCollector(limits);
  if (!same(graph.scope, request.scope) || graph.evaluationTime !== request.evaluationTime)
    conflict();
  const nodes = new Map<string, PolicyRecordRead>();
  for (const { read } of graph.nodes) {
    const key = policyEvaluationSourceReferenceKey(read.source);
    if (nodes.has(key)) conflict();
    nodes.set(key, read);
  }
  let references = 0;
  let referenceBytes = 0;
  const root = (source: PolicyEvaluationSourceReference) => {
    const read = nodes.get(policyEvaluationSourceReferenceKey(source));
    if (!read || !same(read.source, source) || read.observation.status !== "verified")
      return conflict();
    const inspected = enumerateCapturedPolicyRecord(
      { source, scope: request.scope, evaluationTime: request.evaluationTime },
      read,
      limits,
      {
        maximumRecords: request.limits.maxAcquisitionRecords,
        maximumRecordBytes: request.limits.maxAcquisitionRecordBytes,
      },
    );
    if (inspected.references.length > limits.maxReferences - references)
      throw new PolicyEvaluationEvidenceReferenceError("reference_limit_exceeded");
    if (inspected.referenceBytes > limits.maxReferenceBytes - referenceBytes)
      throw new PolicyEvaluationEvidenceReferenceError("reference_bytes_exceeded");
    references += inspected.references.length;
    referenceBytes += inspected.referenceBytes;
    return { read, recordSha256: inspected.recordSha256 };
  };
  const candidateSource = { kind: "release_candidate" as const, reference: request.candidate };
  const policySource = { kind: "release_policy" as const, reference: request.policy };
  const candidateRoot = root(candidateSource);
  const policyRoot = root(policySource);
  const candidate = candidateRoot.read.record as ReleaseCandidate;
  const policy = policyRoot.read.record as ReleasePolicy;
  const meter = new PolicyEvaluationReferenceCollector({
    maxReferences: limits.maxReferences - references,
    maxReferenceBytes: limits.maxReferenceBytes - referenceBytes,
  });
  const edgeKey = (source: PolicyEvaluationSourceReference, path: string) =>
    JSON.stringify([policyEvaluationSourceReferenceKey(source), path]);
  const edges = new Map<string, number>();
  graph.edges.forEach((edge, index) => {
    const key = edgeKey(edge.parent, edge.reference.path);
    if (edges.has(key)) conflict();
    edges.set(key, index);
  });
  const edgeAt = (owner: PolicyRecordRead, path: string, recordSha256: string) => {
    const index = edges.get(edgeKey(owner.source, path));
    const edge = index === undefined ? undefined : graph.edges[index];
    if (!edge || index === undefined || edge.parentRecordSha256 !== recordSha256) conflict();
    return { edge, index };
  };
  const captures = new Map<number, number>();
  artifacts.forEach((capture, index) => {
    if (capture.origin.kind !== "record") return;
    const edgeIndex = capture.origin.edgeIndex;
    const edge = graph.edges[edgeIndex];
    if (
      edge?.reference.kind !== "artifact" ||
      captures.has(edgeIndex) ||
      !same(capture.read.reference, edge.reference.reference) ||
      !same(capture.read.scope, request.scope) ||
      capture.read.evaluationTime !== request.evaluationTime
    )
      conflict();
    captures.set(edgeIndex, index);
  });
  const members: Member[] = [];
  const artifact = (
    componentKind: Predicate["componentKind"],
    role: string,
    path: string,
    reference: ArtifactReference,
  ) => {
    const { edge, index } = edgeAt(candidateRoot.read, path, candidateRoot.recordSha256);
    if (
      edge.reference.kind !== "artifact" ||
      edge.target !== null ||
      !same(edge.reference.reference, reference)
    )
      conflict();
    const captureIndex = captures.get(index);
    const read = captureIndex === undefined ? undefined : artifacts[captureIndex]?.read;
    if (captureIndex === undefined || !read) conflict();
    if (
      read.catalog &&
      (!same(read.catalog.metadata.scope, request.scope) ||
        !same(read.catalog.metadata.contentReference, reference))
    )
      conflict();
    if (
      read.observation.status === "verified" &&
      (!read.catalog ||
        read.observation.sha256 !== reference.sha256 ||
        read.observation.sizeBytes !== reference.sizeBytes)
    )
      conflict();
    meter.artifact(path, reference);
    members.push({
      componentKind,
      role,
      candidatePath: path,
      candidateEdgeIndex: index,
      status: "artifact_declared",
      reference,
      artifactCaptureIndex: captureIndex,
    });
  };
  candidate.buildArtifacts.forEach(({ role, artifact: reference }, index) => {
    artifact("build_artifact", role, `/buildArtifacts/${index}/artifact`, reference);
  });
  candidate.runtimeComponents.forEach((component, index) => {
    const path = `/runtimeComponents/${index}`;
    if (component.kind !== "model")
      artifact(component.kind, component.role, `${path}/content`, component.content);
    else if (component.resolution.status === "exact")
      artifact(
        "model_resolution",
        component.role,
        `${path}/resolution/resolutionEvidence`,
        component.resolution.resolutionEvidence,
      );
    else {
      const { edge, index: edgeIndex } = edgeAt(
        candidateRoot.read,
        path,
        candidateRoot.recordSha256,
      );
      const { providerId, providerModelId, resolution } = component;
      const declaration = {
        kind: "model_declaration" as const,
        reference: { providerId, providerModelId, resolution },
      };
      if (
        edge.reference.kind !== "control_declaration" ||
        edge.target !== null ||
        !same(edge.reference.declaration, declaration)
      )
        conflict();
      meter.controlDeclaration(path, declaration);
      members.push({
        componentKind: "model_resolution",
        role: component.role,
        candidatePath: path,
        candidateEdgeIndex: edgeIndex,
        status: "model_alias",
        declaration: component,
      });
    }
  });
  const rules: PolicyArtifactRuleBindings["rules"][number][] = [];
  policy.rules.forEach((rule, ruleIndex) => {
    const predicate = rule.predicate;
    if (predicate.kind !== "artifact_required") return;
    const path = `/rules/${ruleIndex}/predicate`;
    const { edge, index } = edgeAt(policyRoot.read, path, policyRoot.recordSha256);
    const declaration = { kind: "artifact_requirement" as const, reference: predicate };
    if (
      edge.reference.kind !== "control_declaration" ||
      edge.target !== null ||
      !same(edge.reference.declaration, declaration)
    )
      conflict();
    meter.controlDeclaration(path, declaration);
    const memberIndex = members.findIndex(
      (m) => m.componentKind === predicate.componentKind && m.role === predicate.role,
    );
    if (memberIndex >= 0) {
      const member = members[memberIndex];
      if (member?.status === "artifact_declared") meter.artifact(path, member.reference);
    }
    const omissionKind =
      predicate.componentKind === "model_resolution" ? "model" : predicate.componentKind;
    rules.push({
      ruleId: rule.ruleId,
      ruleIndex,
      predicate,
      policyEdgeIndex: index,
      binding:
        memberIndex >= 0
          ? { status: "component_present", memberIndex }
          : {
              status: "component_missing",
              omission:
                candidate.omissions.find(
                  (o) => o.kind === omissionKind && o.role === predicate.role,
                ) ?? null,
            },
    });
  });
  const usage = meter.result();
  return structuredClone({
    candidate: { source: candidateSource, recordSha256: candidateRoot.recordSha256 },
    policy: { source: policySource, recordSha256: policyRoot.recordSha256 },
    members,
    rules,
    inspectionUsage: {
      references: references + usage.references.length,
      referenceBytes: referenceBytes + usage.referenceBytes,
    },
  });
}
