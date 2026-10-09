import {
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationManifestEntry,
  PolicyEvaluationManifestEntrySchema,
  type PolicyEvaluationRequest,
  type PolicyEvaluationSourceReference,
  policyEvaluationSourceReferenceKey,
} from "@proofstack/contracts";
import {
  inspectPolicyEvaluationImplementationResolution,
  inspectPolicyEvaluationSelector,
  type PolicyEvaluationEvidenceRead,
  type PolicyEvaluationEvidenceReference,
  PolicyEvaluationEvidenceReferenceError,
  type PolicyEvaluationEvidenceReferenceLimits,
  type PolicyEvaluationImplementationParentSource,
  PolicyEvaluationReferenceCollector,
  type PolicyEvaluationResolvableSelector,
  type PolicyEvaluationSelectorParentRead,
  type PolicyEvaluationSelectorParentSource,
  validatePolicyEvaluationRequestRecord,
} from "@proofstack/core";
import {
  inspectPolicyEvaluationModelEndpointResolution,
  type PolicyEvaluationDatasetRead,
  type PolicyEvaluationModelEndpointParentSource,
} from "@proofstack/datasets";
import { PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyRecordGraph, PolicyRecordGraphEdge } from "./capture-record-graph.js";
import { enumerateCapturedPolicyRecord, type PolicyRecordExpansion } from "./record-routing.js";

type Source = PolicyEvaluationSourceReference;
type FrontierKind = "artifact" | "trace" | "retained_declaration" | "unresolved_selector";

export interface PolicyRecordClosure {
  /** Derived from request roots and owning record fields, not graph.entries or a caller list. */
  readonly sources: readonly Source[];
  /** Original edge occurrences which are not resolved record edges; none imply verified authority. */
  readonly frontier: readonly { readonly edgeIndex: number; readonly kind: FrontierKind }[];
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
}

// New reference kinds cannot silently become leaves or an empty successful frontier.
const categories = {
  artifact: "artifact",
  control_declaration: "retained_declaration",
  criterion_selector: "selector",
  endpoint_profile_selector: "retained_declaration",
  evaluation_run_identity: "selector",
  interaction_prompt: "retained_declaration",
  interaction_tool_contract: "retained_declaration",
  model_evaluator_selector: "selector",
  protocol_declaration: "retained_declaration",
  qualification_policy: "retained_declaration",
  record: "record",
  registered_implementation: "retained_declaration",
  replay_declaration: "retained_declaration",
  trace_snapshot_selector: "trace",
} as const satisfies Record<
  PolicyEvaluationEvidenceReference["kind"],
  FrontierKind | "record" | "selector"
>;

function same(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}

function selector(
  reference: PolicyEvaluationEvidenceReference,
): PolicyEvaluationResolvableSelector | null {
  if (
    categories[reference.kind] === "selector" ||
    (reference.kind === "control_declaration" &&
      reference.declaration.kind === "comparison_predecessor")
  )
    return reference as PolicyEvaluationResolvableSelector;
  return null;
}

/** Lookup coordinates only; a digest-bearing source is never fabricated for an absent selector. */
function selectorKey(reference: PolicyEvaluationResolvableSelector): string {
  switch (reference.kind) {
    case "criterion_selector":
      return `criterion_set:${reference.selector.criterionSetVersionId}`;
    case "model_evaluator_selector":
      return `model_assisted_evaluator_spec:${reference.selector.evaluatorVersionId}`;
    case "evaluation_run_identity":
      return `evaluation_run:${reference.evaluationRunId}`;
    case "control_declaration":
      return `comparison_definition:${reference.declaration.reference.comparisonVersionId}`;
  }
}

function validFailure(failure: PolicyRecordGraphEdge["selectorFailure"]): boolean {
  if (!failure) return false;
  if (failure.status === "missing") return Object.keys(failure).length === 1;
  return (
    failure.status === "unavailable" &&
    Object.keys(failure).length === 2 &&
    ["record_invalid", "reference_mismatch", "lineage_mismatch", "not_yet_available"].includes(
      failure.reason,
    )
  );
}

/**
 * Internal independent retained-metadata derivation. Re-enumerate full captured bodies and replay
 * reachability from the immutable request, rejecting omitted/extra/substituted occurrences.
 * Missing observations retain trusted acquisition provenance; this pure function cannot prove
 * absent storage, complete mutable authority, artifact bytes, rule eligibility or a sealed cut.
 */
export function deriveCapturedRecordClosure(
  input: PolicyEvaluationRequest,
  graph: Pick<PolicyRecordGraph, "roots" | "nodes" | "edges">,
  limits: PolicyEvaluationEvidenceReferenceLimits,
): {
  readonly entries: readonly PolicyEvaluationManifestEntry[];
  readonly closure: PolicyRecordClosure;
} {
  const request = validatePolicyEvaluationRequestRecord(input);
  // Apply the shared finite limit contract, including rejecting unexpected limit fields.
  new PolicyEvaluationReferenceCollector(limits);
  const roots: Source[] = [
    { kind: "release_candidate", reference: request.candidate },
    { kind: "release_policy", reference: request.policy },
  ];
  if (!same(roots, graph.roots)) throw new PolicyRecordGraphError("reference_conflict");
  if (graph.nodes.length > request.limits.maxAcquisitionRecords)
    throw new PolicyRecordGraphError("record_limit");
  const nodes = new Map<string, PolicyRecordExpansion>();
  let previousKey = "";
  for (const node of graph.nodes) {
    const { read } = node;
    const entry = PolicyEvaluationManifestEntrySchema.parse({
      source: read.source,
      observation: read.observation,
    });
    const key = policyEvaluationSourceReferenceKey(entry.source);
    if (
      key <= previousKey ||
      Object.keys(node).some((field) => field !== "read" && field !== "references") ||
      Object.keys(read).some((field) => !["source", "observation", "record"].includes(field))
    )
      throw new PolicyRecordGraphError("reference_conflict", key);
    previousKey = key;
    if (
      read.observation.status !== "verified" &&
      (read.record !== null || node.references !== null)
    )
      throw new PolicyRecordGraphError("observation_conflict", key);
    nodes.set(key, node);
  }

  const expected = new Map<string, Source>();
  const queue: Source[] = [];
  const entries: PolicyEvaluationManifestEntry[] = [];
  const frontier: PolicyRecordClosure["frontier"][number][] = [];
  const artifacts = new Map<string, string>();
  let references = 0;
  let referenceBytes = 0;
  let edgeIndex = 0;
  const enqueue = (source: Source) => {
    const key = policyEvaluationSourceReferenceKey(source);
    const prior = expected.get(key);
    if (prior && !same(prior, source)) throw new PolicyRecordGraphError("reference_conflict", key);
    if (!prior) {
      expected.set(key, source);
      queue.push(source);
    }
  };
  roots.forEach(enqueue);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const source = queue[cursor] as Source;
    const key = policyEvaluationSourceReferenceKey(source);
    const node = nodes.get(key);
    if (!node || !same(source, node.read.source))
      throw new PolicyRecordGraphError("reference_conflict", key);
    const { read } = node;
    entries.push({ source, observation: read.observation });
    if (read.observation.status !== "verified") continue;
    const derived = enumerateCapturedPolicyRecord(
      { source, scope: request.scope, evaluationTime: request.evaluationTime },
      read,
      limits,
      {
        maximumRecordBytes: request.limits.maxAcquisitionRecordBytes,
        maximumRecords: request.limits.maxAcquisitionRecords,
      },
    );
    if (!same(derived.references, node.references))
      throw new PolicyRecordGraphError("reference_conflict", key);
    if (derived.references.length > limits.maxReferences - references)
      throw new PolicyEvaluationEvidenceReferenceError("reference_limit_exceeded");
    if (derived.referenceBytes > limits.maxReferenceBytes - referenceBytes)
      throw new PolicyEvaluationEvidenceReferenceError("reference_bytes_exceeded");
    references += derived.references.length;
    referenceBytes += derived.referenceBytes;
    for (const reference of derived.references) {
      const index = edgeIndex++;
      const edge = graph.edges[index];
      if (
        !edge ||
        !same(edge.parent, source) ||
        edge.parentRecordSha256 !== derived.recordSha256 ||
        !same(edge.reference, reference) ||
        Object.keys(edge).some(
          (field) =>
            ![
              "parent",
              "parentRecordSha256",
              "reference",
              "target",
              "selectorFailure",
              "registrationFailure",
              "endpointFailure",
              "endpointChecks",
            ].includes(field),
        )
      )
        throw new PolicyRecordGraphError("reference_conflict", key);
      if (reference.kind !== "registered_implementation" && edge.registrationFailure !== undefined)
        throw new PolicyRecordGraphError("reference_conflict", key);
      if (
        reference.kind !== "endpoint_profile_selector" &&
        (edge.endpointFailure !== undefined || edge.endpointChecks !== undefined)
      )
        throw new PolicyRecordGraphError("reference_conflict", key);
      if (reference.kind === "endpoint_profile_selector") {
        if (edge.selectorFailure !== undefined)
          throw new PolicyRecordGraphError("reference_conflict", key);
        const child = nodes.get(
          `endpoint_profile:${reference.selector.endpointProfileId}:${reference.selector.endpointProfileVersion}`,
        )?.read;
        // A missing mapping still consumes full parent inspection; absence is not free work.
        if (derived.references.length > limits.maxReferences - references)
          throw new PolicyEvaluationEvidenceReferenceError("reference_limit_exceeded");
        if (derived.referenceBytes > limits.maxReferenceBytes - referenceBytes)
          throw new PolicyEvaluationEvidenceReferenceError("reference_bytes_exceeded");
        references += derived.references.length;
        referenceBytes += derived.referenceBytes;
        const resolved = inspectPolicyEvaluationModelEndpointResolution(
          {
            source: source as PolicyEvaluationModelEndpointParentSource,
            scope: request.scope,
            evaluationTime: request.evaluationTime,
            path: reference.path,
            limits,
          },
          read as PolicyEvaluationDatasetRead,
          child?.observation.status === "verified" ? child.record : null,
        );
        if (!same(resolved.checks, edge.endpointChecks))
          throw new PolicyRecordGraphError("observation_conflict", key);
        if (edge.target !== null) {
          if (
            edge.endpointFailure !== undefined ||
            resolved.status !== "resolved" ||
            !same(resolved.evidence.source, edge.target) ||
            !same(resolved.evidence.observation, child?.observation)
          )
            throw new PolicyRecordGraphError("observation_conflict", key);
          enqueue(resolved.evidence.source);
        } else {
          const failure = edge.endpointFailure;
          if (
            !validFailure(failure) ||
            (failure?.status === "unavailable" &&
              !["record_invalid", "reference_mismatch", "not_yet_available"].includes(
                failure.reason,
              )) ||
            resolved.status === "resolved" ||
            (child?.observation.status === "verified" &&
              (resolved.status !== "unavailable" ||
                !same(failure, { status: resolved.status, reason: resolved.reason })))
          )
            throw new PolicyRecordGraphError("observation_conflict", key);
        }
        frontier.push({ edgeIndex: index, kind: "retained_declaration" });
        continue;
      }
      if (reference.kind === "registered_implementation") {
        if (edge.selectorFailure !== undefined)
          throw new PolicyRecordGraphError("reference_conflict", key);
        const child = nodes.get(
          `evaluation_implementation_registration:${reference.reference.implementationId}:${reference.reference.implementationVersionId}`,
        )?.read;
        let resolved:
          | ReturnType<typeof inspectPolicyEvaluationImplementationResolution>
          | undefined;
        if (child?.observation.status === "verified") {
          if (derived.references.length > limits.maxReferences - references)
            throw new PolicyEvaluationEvidenceReferenceError("reference_limit_exceeded");
          if (derived.referenceBytes > limits.maxReferenceBytes - referenceBytes)
            throw new PolicyEvaluationEvidenceReferenceError("reference_bytes_exceeded");
          references += derived.references.length;
          referenceBytes += derived.referenceBytes;
          resolved = inspectPolicyEvaluationImplementationResolution(
            {
              source: source as PolicyEvaluationImplementationParentSource,
              scope: request.scope,
              evaluationTime: request.evaluationTime,
              path: reference.path,
              limits,
            },
            read as PolicyEvaluationEvidenceRead,
            child.record,
          );
        }
        if (edge.target !== null) {
          if (
            edge.registrationFailure !== undefined ||
            resolved?.status !== "resolved" ||
            !same(resolved.evidence.source, edge.target) ||
            !same(resolved.evidence.observation, child?.observation)
          )
            throw new PolicyRecordGraphError("observation_conflict", key);
          enqueue(resolved.evidence.source);
        } else {
          const failure = edge.registrationFailure;
          if (
            !validFailure(failure) ||
            (failure?.status === "unavailable" &&
              !["record_invalid", "reference_mismatch", "not_yet_available"].includes(
                failure.reason,
              )) ||
            (resolved !== undefined &&
              (resolved.status !== "unavailable" ||
                !same(failure, { status: resolved.status, reason: resolved.reason })))
          )
            throw new PolicyRecordGraphError("observation_conflict", key);
        }
        // A joined declaration still does not prove installed bytes/current external authority.
        frontier.push({ edgeIndex: index, kind: "retained_declaration" });
        continue;
      }
      if (
        reference.kind === "replay_declaration" &&
        reference.declaration.kind === "endpoint_profile"
      ) {
        const target: Source = {
          kind: "endpoint_profile",
          reference: reference.declaration.reference,
        };
        if (edge.selectorFailure !== undefined || !same(target, edge.target))
          throw new PolicyRecordGraphError("reference_conflict", key);
        enqueue(target);
        frontier.push({ edgeIndex: index, kind: "retained_declaration" });
        continue;
      }
      if (reference.kind === "qualification_policy") {
        const target: Source = { kind: "qualification_policy", reference: reference.reference };
        if (edge.selectorFailure !== undefined || !same(target, edge.target))
          throw new PolicyRecordGraphError("reference_conflict", key);
        enqueue(target);
        // Valid retained policy data does not authenticate current qualification authority.
        frontier.push({ edgeIndex: index, kind: "retained_declaration" });
        continue;
      }
      if (reference.kind === "record") {
        if (edge.selectorFailure !== undefined || !same(reference.source, edge.target))
          throw new PolicyRecordGraphError("reference_conflict", key);
        enqueue(reference.source);
        continue;
      }
      const selected = selector(reference);
      if (selected) {
        const child = nodes.get(selectorKey(selected))?.read;
        const resolved =
          child?.observation.status === "verified"
            ? inspectPolicyEvaluationSelector(
                {
                  source: source as PolicyEvaluationSelectorParentSource,
                  scope: request.scope,
                  evaluationTime: request.evaluationTime,
                  path: reference.path,
                  limits,
                },
                read as PolicyEvaluationSelectorParentRead,
                child.record,
              )
            : undefined;
        if (edge.target !== null) {
          if (
            edge.selectorFailure !== undefined ||
            resolved?.status !== "resolved" ||
            !same(resolved.evidence.source, edge.target) ||
            !same(resolved.evidence.observation, child?.observation)
          )
            throw new PolicyRecordGraphError("observation_conflict", key);
          enqueue(resolved.evidence.source);
        } else {
          if (
            !validFailure(edge.selectorFailure) ||
            (resolved !== undefined &&
              (resolved.status !== "unavailable" ||
                !same(edge.selectorFailure, { status: resolved.status, reason: resolved.reason })))
          )
            throw new PolicyRecordGraphError("observation_conflict", key);
          frontier.push({ edgeIndex: index, kind: "unresolved_selector" });
        }
        continue;
      }
      if (edge.target !== null || edge.selectorFailure !== undefined)
        throw new PolicyRecordGraphError("reference_conflict", key);
      if (reference.kind === "artifact") {
        const identity = reference.reference.artifactId;
        const descriptor = Buffer.from(encodeEvaluationCanonicalJson(reference.reference)).toString(
          "utf8",
        );
        const prior = artifacts.get(identity);
        if (prior !== undefined && prior !== descriptor)
          throw new PolicyRecordGraphError("reference_conflict", `artifact:${identity}`);
        artifacts.set(identity, descriptor);
      }
      const kind = categories[reference.kind];
      // The fixed enumerator and selector branch above exhaust all record-bearing forms.
      if (kind === "selector") throw new PolicyRecordGraphError("reference_conflict", key);
      frontier.push({ edgeIndex: index, kind });
    }
  }
  if (edgeIndex !== graph.edges.length || expected.size !== nodes.size)
    throw new PolicyRecordGraphError("reference_conflict");
  entries.sort((left, right) => {
    const a = policyEvaluationSourceReferenceKey(left.source);
    const b = policyEvaluationSourceReferenceKey(right.source);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return structuredClone({
    entries,
    closure: {
      sources: entries.map(({ source }) => source),
      frontier,
      inspectionUsage: { references, referenceBytes },
    },
  });
}
