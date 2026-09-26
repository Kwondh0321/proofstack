import {
  type ContentReference,
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationSourceReference,
  type PolicyInstallationBinding,
  policyEvaluationSourceReferenceKey,
  type ReleasePolicy,
  type SourceReviewerQualification,
  type SourceReviewRecord,
  type SourceSnapshot,
} from "@proofstack/contracts";
import {
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
  type ReleasePolicyAuthorityArtifactAvailability,
  type ReleasePolicyAuthorityValidation,
  type ResolvedReleasePolicySourceAuthority,
  validateReleasePolicyEvaluationAuthority,
} from "@proofstack/core";
import { PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyArtifactCapture } from "./capture-artifact-evidence.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";
import type { PolicyRecordRead } from "./record-routing.js";

type Source = Extract<PolicyEvaluationSourceReference, { kind: "release_policy" }>;
type Retained<T> = { readonly read: PolicyRecordRead; readonly value: T };

export interface PolicyAuthorityPrerequisites {
  readonly source: Source;
  readonly recordSha256: string;
  readonly evaluationTime: string;
  /** Static retained requirements only; no lifecycle, revision guard or sealed authority. */
  readonly requirements: ReleasePolicyAuthorityValidation;
  readonly dependencyEdgeIndexes: readonly number[];
  readonly artifactCaptureIndexes: readonly number[];
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
}

function same(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}

/** Internal composition over one fixed, authorized capture; no I/O or replacement evidence. */
export function inspectCapturedPolicyAuthority(
  graph: PolicyRecordGraph,
  artifacts: readonly PolicyArtifactCapture[],
  limits: PolicyEvaluationEvidenceReferenceLimits,
): PolicyAuthorityPrerequisites {
  const meter = new PolicyEvaluationReferenceCollector(limits);
  const nodes = new Map(
    graph.nodes.map(({ read }) => [policyEvaluationSourceReferenceKey(read.source), read]),
  );
  const edgeKey = (source: PolicyEvaluationSourceReference, path: string) =>
    JSON.stringify([policyEvaluationSourceReferenceKey(source), path]);
  const edges = new Map<string, number>();
  graph.edges.forEach((edge, index) => {
    const key = edgeKey(edge.parent, edge.reference.path);
    if (edges.has(key)) throw new PolicyRecordGraphError("reference_conflict", key);
    edges.set(key, index);
  });
  const artifactByEdge = new Map<number, number>();
  artifacts.forEach(({ origin }, index) => {
    if (origin.kind !== "record") return;
    if (artifactByEdge.has(origin.edgeIndex))
      throw new PolicyRecordGraphError("observation_conflict");
    artifactByEdge.set(origin.edgeIndex, index);
  });
  const dependencyEdgeIndexes: number[] = [];
  const artifactCaptureIndexes: number[] = [];
  const availability = new Map<string, ReleasePolicyAuthorityArtifactAvailability>();
  const edgeAt = (owner: PolicyRecordRead, path: string) => {
    const key = edgeKey(owner.source, path);
    const index = edges.get(key);
    const edge = index === undefined ? undefined : graph.edges[index];
    if (
      index === undefined ||
      !edge ||
      owner.observation.status !== "verified" ||
      edge.parentRecordSha256 !== owner.observation.recordSha256 ||
      !same(edge.parent, owner.source)
    )
      throw new PolicyRecordGraphError("reference_conflict", key);
    return { edge, index };
  };
  const read = <T>(
    owner: PolicyRecordRead,
    path: string,
    kind: PolicyEvaluationSourceReference["kind"],
  ): Retained<T> | undefined => {
    const { edge, index } = edgeAt(owner, path);
    if (!edge.target || edge.target.kind !== kind)
      throw new PolicyRecordGraphError("reference_conflict");
    meter.record(path, kind, edge.target.reference);
    dependencyEdgeIndexes.push(index);
    const child = nodes.get(policyEvaluationSourceReferenceKey(edge.target));
    if (!child || !same(child.source, edge.target))
      throw new PolicyRecordGraphError("reference_conflict");
    return child.observation.status === "verified"
      ? { read: child, value: child.record as T }
      : undefined;
  };
  const artifact = (owner: PolicyRecordRead, path: string, reference: ContentReference) => {
    const { edge, index } = edgeAt(owner, path);
    if (edge.reference.kind !== "artifact" || !same(edge.reference.reference, reference))
      throw new PolicyRecordGraphError("reference_conflict");
    meter.artifact(path, reference);
    dependencyEdgeIndexes.push(index);
    const captureIndex = artifactByEdge.get(index);
    const capture = captureIndex === undefined ? undefined : artifacts[captureIndex];
    if (
      captureIndex === undefined ||
      !capture ||
      !same(capture.read.reference, reference) ||
      !same(capture.read.scope, graph.scope) ||
      capture.read.evaluationTime !== graph.evaluationTime
    )
      throw new PolicyRecordGraphError("observation_conflict");
    artifactCaptureIndexes.push(captureIndex);
    const state = capture.read.observation.status === "verified" ? "available" : "unavailable";
    const key = JSON.stringify([reference.artifactId, reference.sha256]);
    const previous = availability.get(key);
    if (previous && previous.state !== state)
      throw new PolicyRecordGraphError("observation_conflict");
    availability.set(key, { artifactId: reference.artifactId, sha256: reference.sha256, state });
  };
  const roots = graph.roots.filter((root): root is Source => root.kind === "release_policy");
  const root = roots[0];
  const parent = root && nodes.get(policyEvaluationSourceReferenceKey(root));
  if (
    roots.length !== 1 ||
    !parent ||
    parent.observation.status !== "verified" ||
    !same(parent.source, root)
  )
    throw new PolicyRecordGraphError("reference_conflict");
  const policy = parent.record as ReleasePolicy;
  const binding = read<PolicyInstallationBinding>(
    parent,
    "/installationBinding",
    "policy_installation_binding",
  );
  if (binding) artifact(binding.read, "/authorityEvidence", binding.value.authorityEvidence);
  const sources = new Map<string, ResolvedReleasePolicySourceAuthority>();
  const sourceAt = (path: string, reference: ReleasePolicy["sources"][number]) => {
    const source = read<SourceSnapshot>(parent, `${path}/source`, "source_snapshot");
    const review = read<SourceReviewRecord>(parent, `${path}/review`, "source_review");
    const reviewer = review?.value.reviewerQualification
      ? read<SourceReviewerQualification>(
          review.read,
          "/reviewerQualification",
          "source_reviewer_qualification",
        )
      : undefined;
    if (source) {
      artifact(source.read, "/content", source.value.content);
      if (source.value.identityVerification.status !== "unverified")
        source.value.identityVerification.evidence.forEach((ref, i) => {
          artifact(source.read, `/identityVerification/evidence/${i}`, ref);
        });
    }
    if (review)
      review.value.reviewBasis.forEach((ref, i) => {
        artifact(review.read, `/reviewBasis/${i}`, ref);
      });
    if (reviewer)
      reviewer.value.credentialEvidence.forEach((ref, i) => {
        artifact(reviewer.read, `/credentialEvidence/${i}`, ref);
      });
    sources.set(Buffer.from(encodeEvaluationCanonicalJson(reference)).toString("utf8"), {
      reference,
      source: source?.value ?? null,
      review: review?.value ?? null,
      reviewerQualification: reviewer?.value ?? null,
    });
  };
  policy.sources.forEach((ref, i) => {
    sourceAt(`/sources/${i}`, ref);
  });
  policy.counterevidence.forEach((ref, i) => {
    sourceAt(`/counterevidence/${i}`, ref);
  });
  // Rule occurrences are still charged and retain their original edges, even when their source
  // pairs have already appeared in the policy's schema-validated authority set.
  policy.rules.forEach((rule, i) => {
    rule.sources.forEach((ref, j) => {
      sourceAt(`/rules/${i}/sources/${j}`, ref);
    });
  });
  const {
    schemaVersion: _version,
    scope,
    definitionSha256: _hash,
    publishedAt: _at,
    publishedByPrincipalId,
    ...definition
  } = policy;
  const requirements = validateReleasePolicyEvaluationAuthority({
    at: graph.evaluationTime,
    definition,
    publisherPrincipalId: publishedByPrincipalId,
    scope,
    installationBinding: binding?.value ?? null,
    sources: [...sources.values()],
    artifacts: [...availability.values()],
  });
  const usage = meter.result();
  return structuredClone({
    source: root,
    recordSha256: parent.observation.recordSha256,
    evaluationTime: graph.evaluationTime,
    requirements,
    dependencyEdgeIndexes,
    artifactCaptureIndexes,
    inspectionUsage: { references: usage.references.length, referenceBytes: usage.referenceBytes },
  });
}
