import { type ContentReference, encodeEvaluationCanonicalJson } from "@proofstack/contracts";
import {
  type ExactEvidenceRepository,
  type PolicyEvaluationTraceRead,
  readPolicyEvaluationTrace,
  validatePolicyEvaluationRequestRecord,
} from "@proofstack/core";
import { AcquisitionBudget, PolicyRecordGraphError } from "./acquisition-budget.js";
import {
  type PolicyComparisonEvidenceCapture,
  resolveCapturedComparisonEvidence,
} from "./capture-comparison-evidence.js";
import { acquirePolicyRecordGraph } from "./capture-record-graph.js";
import type { PolicyRecordGraphRepositories } from "./record-routing.js";

export interface PolicyTraceCapture {
  /** Index into comparisonCapture.graph.edges; binds parent identity, receipt hash and JSON path. */
  readonly edgeIndex: number;
  readonly read: PolicyEvaluationTraceRead;
}

export interface PolicyTraceArtifactReference {
  readonly traceCaptureIndex: number;
  readonly eventId: string;
  readonly eventRecordSha256: string;
  readonly path: string;
  /** Original evidence descriptor; not necessarily a managed artifact, and never proof of bytes. */
  readonly reference: ContentReference;
}

export type PolicyTraceEvidenceCapture = {
  readonly comparisonCapture: PolicyComparisonEvidenceCapture;
  readonly usage: ReturnType<AcquisitionBudget["usage"]>;
} & (
  | { readonly status: "roots_unavailable" }
  | {
      readonly status: "traces_captured";
      readonly traces: readonly PolicyTraceCapture[];
      readonly artifactReferences: readonly PolicyTraceArtifactReference[];
    }
);

function canonical(value: unknown): string {
  return Buffer.from(encodeEvaluationCanonicalJson(value)).toString("utf8");
}

/**
 * One bounded request-rooted acquisition, comparison validation and exact trace-selector capture.
 * Callers authorize both read-only port sets; this does not grant trace or classified-content access.
 * Captured means observed, not all verified. Artifact bytes, authority and snapshot sealing remain
 * separate. Internal graph/compare functions are intentionally not exported from the package root.
 */
export async function capturePolicyTraceEvidence(
  input: unknown,
  repositories: PolicyRecordGraphRepositories,
  evidence: Pick<ExactEvidenceRepository, "resolveExactEvents">,
): Promise<PolicyTraceEvidenceCapture> {
  const request = validatePolicyEvaluationRequestRecord(input);
  const budget = new AcquisitionBudget(request.limits);
  try {
    const graph = await acquirePolicyRecordGraph(request, repositories, budget);
    const comparisonCapture = resolveCapturedComparisonEvidence(request, graph);
    if (comparisonCapture.status === "roots_unavailable")
      return { status: "roots_unavailable", comparisonCapture, usage: budget.usage() };
    const port = budget.wrap(evidence);
    const traces: PolicyTraceCapture[] = [];
    const artifactReferences: PolicyTraceArtifactReference[] = [];
    const observations = new Map<string, string>();
    const events = new Map<string, string>();
    const artifacts = new Map<string, string>();
    for (const edge of graph.edges) {
      if (edge.reference.kind === "artifact")
        artifacts.set(edge.reference.reference.artifactId, canonical(edge.reference.reference));
    }
    for (let edgeIndex = 0; edgeIndex < graph.edges.length; edgeIndex++) {
      const edge = graph.edges[edgeIndex];
      if (edge?.reference.kind !== "trace_snapshot_selector") continue;
      const read = await readPolicyEvaluationTrace(
        {
          scope: request.scope,
          evaluationTime: request.evaluationTime,
          selector: edge.reference.selector,
        },
        port,
      );
      const key = canonical(read.selector);
      const observation = canonical(read.observation);
      const previous = observations.get(key);
      if (previous !== undefined && previous !== observation)
        throw new PolicyRecordGraphError(
          "observation_conflict",
          `trace_snapshot:${read.selector.traceId}`,
        );
      observations.set(key, observation);
      const traceCaptureIndex = traces.length;
      traces.push({ edgeIndex, read });
      if (read.observation.status !== "verified" || read.events === null) continue;
      for (let index = 0; index < read.events.length; index++) {
        const event = read.events[index];
        const eventRecordSha256 = read.observation.eventSha256[index];
        if (!event || !eventRecordSha256)
          throw new Error("Verified trace omitted its exact event hash");
        const eventId = event.evidence.eventId;
        const prior = events.get(eventId);
        if (prior !== undefined && prior !== eventRecordSha256)
          throw new PolicyRecordGraphError("observation_conflict", `trace_event:${eventId}`);
        events.set(eventId, eventRecordSha256);
        event.evidence.contentReferences.forEach((reference, referenceIndex) => {
          const descriptor = canonical(reference);
          const prior = artifacts.get(reference.artifactId);
          if (prior !== undefined && prior !== descriptor)
            throw new PolicyRecordGraphError(
              "reference_conflict",
              `artifact:${reference.artifactId}`,
            );
          artifacts.set(reference.artifactId, descriptor);
          const occurrence: PolicyTraceArtifactReference = {
            traceCaptureIndex,
            eventId,
            eventRecordSha256,
            path: `/events/${index}/evidence/contentReferences/${referenceIndex}`,
            reference,
          };
          budget.addReferences(1, encodeEvaluationCanonicalJson(occurrence).byteLength);
          artifactReferences.push(occurrence);
        });
      }
    }
    return {
      status: "traces_captured",
      comparisonCapture,
      traces,
      artifactReferences,
      usage: budget.usage(),
    };
  } finally {
    await budget.settle();
  }
}
