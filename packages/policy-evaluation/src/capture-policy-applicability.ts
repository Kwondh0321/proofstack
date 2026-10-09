import {
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationRequest,
  type PolicyEvaluationSourceReference,
  policyEvaluationSourceReferenceKey,
  policyEvaluationTimestampOrderKey,
  type ReleaseCandidate,
  type ReleasePolicy,
  type ReleasePolicyApplicability,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";
import {
  inspectPolicyEvaluationControlRecord,
  PolicyEvaluationEvidenceReferenceError,
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
  readPolicyEvaluationLifecycle,
  validatePolicyEvaluationRequestRecord,
} from "@proofstack/core";
import { PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyArtifactCapture } from "./capture-artifact-evidence.js";
import { inspectCapturedPolicyAuthority } from "./capture-policy-authority.js";
import type { PolicyLifecycleObservation } from "./capture-policy-lifecycle.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";
import { enumerateCapturedPolicyRecord } from "./record-routing.js";

const fields = [
  "jurisdiction",
  "locale",
  "maximumDataClassification",
  "populationTags",
  "purpose",
  "riskTier",
  "taskKind",
] as const satisfies readonly (keyof ReleasePolicyApplicability)[];
type Field = (typeof fields)[number];
type Condition = {
  readonly status: "match" | "mismatch" | "unknown" | "not_evaluated";
  readonly reason:
    | "any"
    | "optional_absent"
    | "optional_present"
    | "value_missing"
    | "equal"
    | "not_equal"
    | "member"
    | "not_member"
    | "contains_all"
    | "missing_population"
    | "exact_set"
    | "different_set"
    | "authority_unverified";
};
type Dimension = {
  [K in Field]: Condition & {
    readonly field: K;
    readonly policyPath: `/applicability/${K}`;
    readonly candidatePath: `/target/${K}`;
    readonly selector: ReleasePolicyApplicability[K];
    readonly targetValue: NonNullable<ReleaseCandidate["target"][K]> | null;
  };
}[Field];

export interface PolicyApplicabilityInputs {
  readonly scope: PolicyEvaluationRequest["scope"];
  readonly evaluationTime: string;
  readonly authorityBoundary: "retained_prerequisites_only";
  readonly candidate: {
    readonly source: Extract<PolicyEvaluationSourceReference, { kind: "release_candidate" }>;
    readonly recordSha256: string;
  };
  readonly policy: {
    readonly source: Extract<PolicyEvaluationSourceReference, { kind: "release_policy" }>;
    readonly recordSha256: string;
  };
  readonly installationBinding: {
    readonly source: Extract<
      PolicyEvaluationSourceReference,
      { kind: "policy_installation_binding" }
    >;
    readonly observation: PolicyRecordGraph["nodes"][number]["read"]["observation"];
  };
  readonly lifecycle: PolicyLifecycleObservation;
  readonly dimensions: readonly Dimension[];
  /** Descriptive input conjunction only, never a policy outcome or current authority. */
  readonly conjunction: "match" | "mismatch" | "unknown" | "not_evaluated";
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

function condition(
  selector: ReleasePolicyApplicability[Field],
  value: string | string[] | null,
): Condition {
  switch (selector.operator) {
    case "any":
      return { status: "match", reason: "any" };
    case "absent":
      return value === null
        ? { status: "match", reason: "optional_absent" }
        : { status: "mismatch", reason: "optional_present" };
    case "equals":
    case "one_of": {
      if (value === null) return { status: "unknown", reason: "value_missing" };
      if (typeof value !== "string") return conflict();
      if (selector.operator === "equals")
        return value === selector.value
          ? { status: "match", reason: "equal" }
          : { status: "mismatch", reason: "not_equal" };
      return (selector.values as readonly string[]).includes(value)
        ? { status: "match", reason: "member" }
        : { status: "mismatch", reason: "not_member" };
    }
    case "contains_all":
    case "exactly": {
      if (!Array.isArray(value)) return conflict();
      if (selector.operator === "contains_all")
        return selector.values.every((item) => value.includes(item))
          ? { status: "match", reason: "contains_all" }
          : { status: "mismatch", reason: "missing_population" };
      return same(value, selector.values)
        ? { status: "match", reason: "exact_set" }
        : { status: "mismatch", reason: "different_set" };
    }
  }
}

/** Internal retained-input projection; no external I/O, predicate, seal or publication port. */
export async function inspectCapturedPolicyApplicability(
  input: PolicyEvaluationRequest,
  graph: PolicyRecordGraph,
  artifacts: readonly PolicyArtifactCapture[],
  lifecycle: PolicyLifecycleObservation,
  limits: PolicyEvaluationEvidenceReferenceLimits,
) {
  const request = validatePolicyEvaluationRequestRecord(input);
  new PolicyEvaluationReferenceCollector(limits);
  const candidateSource = { kind: "release_candidate" as const, reference: request.candidate };
  const policySource = { kind: "release_policy" as const, reference: request.policy };
  if (
    !same(graph.scope, request.scope) ||
    graph.evaluationTime !== request.evaluationTime ||
    !same(graph.roots, [candidateSource, policySource])
  )
    conflict();
  const nodes = new Map<string, PolicyRecordGraph["nodes"][number]>();
  for (const node of graph.nodes) {
    const key = policyEvaluationSourceReferenceKey(node.read.source);
    if (nodes.has(key)) conflict();
    nodes.set(key, node);
  }
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
    if (node.read.observation.status !== "verified") {
      if (required || node.read.record !== null || node.references !== null) conflict();
      return node.read;
    }
    const retained = enumerateCapturedPolicyRecord(
      { source, scope: request.scope, evaluationTime: request.evaluationTime },
      node.read,
      limits,
      {
        maximumRecords: request.limits.maxAcquisitionRecords,
        maximumRecordBytes: request.limits.maxAcquisitionRecordBytes,
      },
    );
    if (!same(retained.references, node.references)) conflict();
    charge(retained.references.length, retained.referenceBytes);
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
  const bindingSource = {
    kind: "policy_installation_binding" as const,
    reference: policy.installationBinding,
  };
  const bindingRead = inspect(bindingSource, false);
  const bindingEdges = graph.edges.filter(
    (edge) => same(edge.parent, policySource) && edge.reference.path === "/installationBinding",
  );
  const bindingEdge = bindingEdges[0];
  if (
    bindingEdges.length !== 1 ||
    !bindingEdge ||
    bindingEdge.parentRecordSha256 !== policyRead.observation.recordSha256 ||
    bindingEdge.reference.kind !== "record" ||
    !same(bindingEdge.reference.source, bindingSource) ||
    !same(bindingEdge.target, bindingSource)
  )
    conflict();
  const start = UtcMillisecondTimestampSchema.parse(lifecycle.startedAt);
  const end = UtcMillisecondTimestampSchema.parse(lifecycle.completedAt);
  if (
    policyEvaluationTimestampOrderKey(end) < policyEvaluationTimestampOrderKey(start) ||
    [request.evaluationTime, request.createdAt].some(
      (at) => policyEvaluationTimestampOrderKey(at) > policyEvaluationTimestampOrderKey(start),
    )
  )
    conflict();
  // Reuse owning lifecycle validation over retained copies, never external replacement evidence.
  let ticks = 0;
  const retainedLifecycle = await readPolicyEvaluationLifecycle(
    { scope: request.scope, evaluationTime: request.evaluationTime, policy: request.policy },
    inspectPolicyEvaluationControlRecord(
      { scope: request.scope, evaluationTime: request.evaluationTime, source: policySource },
      policyRead.record,
    ),
    {
      listReleasePolicyLifecycleEvents: async () =>
        structuredClone(lifecycle.history.map(({ record }) => record)),
      findReleasePolicy: async (_scope, versionId) =>
        structuredClone(
          lifecycle.history.find(({ successor }) => successor?.record.policyVersionId === versionId)
            ?.successor?.record ?? null,
        ),
    },
    { now: () => new Date(ticks++ === 0 ? start : end) },
  );
  if (!same(retainedLifecycle, lifecycle)) conflict();
  const authority = inspectCapturedPolicyAuthority(graph, artifacts, {
    maxReferences: limits.maxReferences - references,
    maxReferenceBytes: limits.maxReferenceBytes - referenceBytes,
  });
  charge(authority.inspectionUsage.references, authority.inspectionUsage.referenceBytes);
  const blocked =
    authority.requirements.status !== "valid" ||
    retainedLifecycle.state !== "no_terminal_event_at_evaluation";
  const dimensions = fields.map((field) => {
    const selector = policy.applicability[field];
    const value = candidate.target[field] ?? null;
    return {
      field,
      policyPath: `/applicability/${field}`,
      candidatePath: `/target/${field}`,
      selector,
      targetValue: value,
      ...(blocked
        ? { status: "not_evaluated" as const, reason: "authority_unverified" as const }
        : condition(selector, value)),
    } as Dimension;
  });
  const context = {
    scope: request.scope,
    evaluationTime: request.evaluationTime,
    authorityBoundary: "retained_prerequisites_only" as const,
    candidate: { source: candidateSource, recordSha256: candidateRead.observation.recordSha256 },
    policy: { source: policySource, recordSha256: policyRead.observation.recordSha256 },
    installationBinding: { source: bindingSource, observation: bindingRead.observation },
    lifecycle: retainedLifecycle,
  };
  for (const frame of [context, ...dimensions])
    charge(1, encodeEvaluationCanonicalJson(frame).byteLength);
  const conjunction = blocked
    ? "not_evaluated"
    : dimensions.some(({ status }) => status === "mismatch")
      ? "mismatch"
      : dimensions.some(({ status }) => status === "unknown")
        ? "unknown"
        : "match";
  const applicability: PolicyApplicabilityInputs = {
    ...context,
    dimensions,
    conjunction,
    inspectionUsage: {
      references: references - authority.inspectionUsage.references,
      referenceBytes: referenceBytes - authority.inspectionUsage.referenceBytes,
    },
  };
  return structuredClone({ authority, applicability });
}
