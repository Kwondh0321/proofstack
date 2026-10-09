import {
  encodeEvaluationCanonicalJson,
  PolicyEvaluationManifestEntrySchema,
  type PolicyEvaluationRequest,
  type PolicyEvaluationSourceReference,
  PolicyEvaluationTimeSchema,
  policyEvaluationSourceReferenceKey,
  policyEvaluationTimestampOrderKey,
  type ReleaseCandidate,
} from "@proofstack/contracts";
import {
  PolicyEvaluationEvidenceReferenceError,
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
  type ReleaseCandidateRevisionAuthority,
  type ReleaseCandidateRevisionReference,
  type ReleaseCandidateRuntimeAuthority,
  type ReleaseCandidateRuntimeReference,
  releaseCandidateSourceReferences,
  validatePolicyEvaluationRequestRecord,
} from "@proofstack/core";
import { type AcquisitionBudget, PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";
import { enumerateCapturedPolicyRecord } from "./record-routing.js";

type CandidateSource = Extract<PolicyEvaluationSourceReference, { kind: "release_candidate" }>;
type Subject = ReleaseCandidateRevisionReference | ReleaseCandidateRuntimeReference;
type Graph = Pick<PolicyRecordGraph, "scope" | "evaluationTime" | "roots" | "nodes" | "edges">;

export interface PolicyCandidateAuthorities {
  readonly revision?: ReleaseCandidateRevisionAuthority;
  readonly runtime?: ReleaseCandidateRuntimeAuthority;
}

type Origin = {
  readonly parent: CandidateSource;
  readonly parentRecordSha256: string;
  readonly path: string;
  readonly edgeIndex: number;
  readonly subject: Subject;
};

export type PolicyCandidateAuthorityObservation =
  | { readonly status: "not_configured" }
  | {
      readonly status: "observed";
      readonly scope: PolicyEvaluationRequest["scope"];
      readonly evaluationTime: string;
      readonly startedAt: string;
      readonly completedAt: string;
      readonly occurrences: readonly (Origin & {
        /** Reference-authority availability only; no loaded-code or exact-model claim. */
        readonly availability: "available" | "not_verified" | "not_configured";
      })[];
      readonly unavailableParents: readonly {
        readonly source: CandidateSource;
        readonly observation: Exclude<
          PolicyRecordGraph["nodes"][number]["read"]["observation"],
          { status: "verified" }
        >;
      }[];
      readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
    };

function same(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}
function conflict(): never {
  throw new PolicyRecordGraphError("observation_conflict");
}

/** Internal material comparison; advancing observation receipts do not change the subject set. */
export function candidateAuthorityMaterialFingerprint(
  observation: PolicyCandidateAuthorityObservation,
): string {
  if (observation.status === "not_configured") return JSON.stringify(observation);
  const { startedAt: _start, completedAt: _end, ...material } = observation;
  return Buffer.from(encodeEvaluationCanonicalJson(material)).toString("utf8");
}

/** Fixed request-owned observation outside database guards. Never a seal/publication port. */
export async function observeCapturedCandidateAuthority(
  input: PolicyEvaluationRequest,
  graph: Graph,
  authorities: PolicyCandidateAuthorities | undefined,
  clock: { now(): Date | string },
  budget: AcquisitionBudget,
  limits: PolicyEvaluationEvidenceReferenceLimits,
): Promise<PolicyCandidateAuthorityObservation> {
  const request = validatePolicyEvaluationRequestRecord(input);
  new PolicyEvaluationReferenceCollector(limits);
  if (
    !same(graph.scope, request.scope) ||
    graph.evaluationTime !== request.evaluationTime ||
    !same(graph.roots, [
      { kind: "release_candidate", reference: request.candidate },
      { kind: "release_policy", reference: request.policy },
    ])
  )
    conflict();
  if (!authorities?.revision && !authorities?.runtime) return { status: "not_configured" };
  const time = () => {
    const value = clock.now();
    return PolicyEvaluationTimeSchema.parse(
      typeof value === "string" ? value : value.toISOString(),
    );
  };
  const startedAt = time();
  if (
    [request.evaluationTime, request.createdAt].some(
      (value) =>
        policyEvaluationTimestampOrderKey(value) > policyEvaluationTimestampOrderKey(startedAt),
    )
  )
    conflict();
  const nodes = new Set<string>();
  const edgeKey = (source: PolicyEvaluationSourceReference, path: string) =>
    JSON.stringify([policyEvaluationSourceReferenceKey(source), path]);
  const edges = new Map<string, { edge: Graph["edges"][number]; edgeIndex: number }>();
  graph.edges.forEach((edge, edgeIndex) => {
    const key = edgeKey(edge.parent, edge.reference.path);
    if (edges.has(key)) conflict();
    edges.set(key, { edge, edgeIndex });
  });
  const origins: Origin[] = [];
  const unavailableParents: Extract<
    PolicyCandidateAuthorityObservation,
    { status: "observed" }
  >["unavailableParents"][number][] = [];
  let references = 0;
  let referenceBytes = 0;
  for (const node of graph.nodes) {
    const { read } = node;
    const key = policyEvaluationSourceReferenceKey(read.source);
    if (nodes.has(key)) conflict();
    nodes.add(key);
    if (read.source.kind !== "release_candidate") continue;
    PolicyEvaluationManifestEntrySchema.parse({
      source: read.source,
      observation: read.observation,
    });
    if (read.observation.status !== "verified") {
      if (read.record !== null || node.references !== null) conflict();
      unavailableParents.push({ source: read.source, observation: read.observation });
      continue;
    }
    const inspected = enumerateCapturedPolicyRecord(
      { source: read.source, scope: request.scope, evaluationTime: request.evaluationTime },
      read,
      limits,
      {
        maximumRecords: request.limits.maxAcquisitionRecords,
        maximumRecordBytes: request.limits.maxAcquisitionRecordBytes,
      },
    );
    if (!same(inspected.references, node.references)) conflict();
    if (inspected.references.length > limits.maxReferences - references)
      throw new PolicyEvaluationEvidenceReferenceError("reference_limit_exceeded");
    if (inspected.referenceBytes > limits.maxReferenceBytes - referenceBytes)
      throw new PolicyEvaluationEvidenceReferenceError("reference_bytes_exceeded");
    references += inspected.references.length;
    referenceBytes += inspected.referenceBytes;
    const candidate = read.record as ReleaseCandidate;
    const {
      scope: _scope,
      schemaVersion: _version,
      definitionSha256: _hash,
      createdAt: _at,
      createdByPrincipalId: _by,
      ...definition
    } = candidate;
    for (const subject of releaseCandidateSourceReferences(definition)) {
      if (
        subject.kind !== "source_revision" &&
        subject.kind !== "model_declaration" &&
        subject.kind !== "runtime_adapter"
      )
        continue;
      let path = "/source";
      if (subject.kind !== "source_revision") {
        const index = candidate.runtimeComponents.findIndex(
          (component) => component.kind === "model" && component.role === subject.role,
        );
        if (index < 0) conflict();
        path = `/runtimeComponents/${index}${subject.kind === "runtime_adapter" ? "/adapter" : ""}`;
      }
      const match = edges.get(edgeKey(read.source, path));
      if (
        !match ||
        !same(match.edge.parent, read.source) ||
        match.edge.parentRecordSha256 !== inspected.recordSha256
      )
        conflict();
      origins.push({
        parent: read.source,
        parentRecordSha256: inspected.recordSha256,
        path,
        edgeIndex: match.edgeIndex,
        subject,
      });
    }
  }
  if (
    !nodes.has(
      policyEvaluationSourceReferenceKey({
        kind: "release_candidate",
        reference: request.candidate,
      }),
    )
  )
    conflict();
  const meter = new PolicyEvaluationReferenceCollector({
    maxReferences: limits.maxReferences - references,
    maxReferenceBytes: limits.maxReferenceBytes - referenceBytes,
  });
  for (const origin of origins) {
    const { path, subject } = origin;
    if (subject.kind === "source_revision")
      meter.controlDeclaration(path, { kind: "candidate_source", reference: subject.source });
    else if (subject.kind === "model_declaration")
      meter.controlDeclaration(path, {
        kind: "model_declaration",
        reference: {
          providerId: subject.providerId,
          providerModelId: subject.providerModelId,
          resolution: subject.resolution,
        },
      });
    else meter.record(path, "runtime_adapter", subject.adapter);
  }
  const inspected = meter.result();
  origins.forEach((origin, index) => {
    const edge = graph.edges[origin.edgeIndex];
    const expected = inspected.references[index];
    if (!edge || !expected || !same(edge.reference, expected)) conflict();
    if (origin.subject.kind === "runtime_adapter") {
      if (!same(edge.target, { kind: "runtime_adapter", reference: origin.subject.adapter }))
        conflict();
    } else if (edge.target !== null) conflict();
  });
  const inspectionUsage = {
    references: references + inspected.references.length,
    referenceBytes: referenceBytes + inspected.referenceBytes,
  };
  budget.addReferences(inspectionUsage.references, inspectionUsage.referenceBytes);
  const revision = authorities.revision && budget.wrap(authorities.revision);
  const runtime = authorities.runtime && budget.wrap(authorities.runtime);
  const occurrences: Extract<
    PolicyCandidateAuthorityObservation,
    { status: "observed" }
  >["occurrences"][number][] = [];
  for (const origin of origins) {
    const scope = structuredClone(request.scope);
    const subject = structuredClone(origin.subject);
    let availability: "available" | "not_verified" | "not_configured" = "not_configured";
    if (subject.kind === "source_revision" && revision) {
      const available: unknown = await revision.isAvailable(scope, subject);
      if (typeof available !== "boolean") conflict();
      availability = available ? "available" : "not_verified";
    } else if (subject.kind !== "source_revision" && runtime) {
      const available: unknown = await runtime.isAvailable(scope, subject);
      if (typeof available !== "boolean") conflict();
      availability = available ? "available" : "not_verified";
    }
    occurrences.push({
      ...origin,
      availability,
    });
  }
  const completedAt = time();
  if (policyEvaluationTimestampOrderKey(completedAt) < policyEvaluationTimestampOrderKey(startedAt))
    conflict();
  return structuredClone({
    status: "observed",
    scope: request.scope,
    evaluationTime: request.evaluationTime,
    startedAt,
    completedAt,
    occurrences,
    unavailableParents,
    inspectionUsage,
  });
}
