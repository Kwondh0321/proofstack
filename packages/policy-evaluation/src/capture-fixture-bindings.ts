import { policyEvaluationSourceReferenceKey } from "@proofstack/contracts";
import {
  inspectPolicyEvaluationFixtureArtifactBindings,
  type PolicyEvaluationDatasetRead,
} from "@proofstack/datasets";
import { PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyArtifactCapture } from "./capture-artifact-evidence.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";

export type PolicyFixtureBindingCapture = Omit<
  ReturnType<typeof inspectPolicyEvaluationFixtureArtifactBindings>,
  "artifacts"
> & {
  readonly artifacts: readonly (ReturnType<
    typeof inspectPolicyEvaluationFixtureArtifactBindings
  >["artifacts"][number] & {
    /** Every direct fixture occurrence, including prompt/request/attempt aliases. */
    readonly artifactCaptureIndexes: readonly number[];
  })[];
};

/** Internal composition over this invocation's observations, never a public caller-authored graph. */
export function inspectCapturedFixtureBindings(
  graph: PolicyRecordGraph,
  artifacts: readonly PolicyArtifactCapture[],
): readonly PolicyFixtureBindingCapture[] {
  const parents = new Map<
    string,
    Map<string, { indexes: number[]; first: PolicyArtifactCapture }>
  >();
  artifacts.forEach((capture, index) => {
    if (capture.origin.kind !== "record") return;
    const edge = graph.edges[capture.origin.edgeIndex];
    if (edge?.reference.kind !== "artifact")
      throw new PolicyRecordGraphError("observation_conflict");
    if (edge.parent.kind !== "regression_fixture_version") return;
    const key = policyEvaluationSourceReferenceKey(edge.parent);
    let byArtifact = parents.get(key);
    if (!byArtifact) {
      byArtifact = new Map();
      parents.set(key, byArtifact);
    }
    const id = capture.read.reference.artifactId;
    const prior = byArtifact.get(id);
    if (prior) prior.indexes.push(index);
    else byArtifact.set(id, { indexes: [index], first: capture });
  });
  const results: PolicyFixtureBindingCapture[] = [];
  for (const { read } of graph.nodes) {
    if (read.source.kind !== "regression_fixture_version" || read.observation.status !== "verified")
      continue;
    // The fixed dataset reader and enumerator established this type; the owning inspector below
    // revalidates the complete body and original receipt hash before interpreting any binding.
    const fixtureRead = read as PolicyEvaluationDatasetRead;
    const version = fixtureRead.record;
    if (version === null) throw new PolicyRecordGraphError("observation_conflict");
    if (version.schemaVersion !== "0.2") continue;
    const key = policyEvaluationSourceReferenceKey(read.source);
    const captured = version.interactionCapture.artifacts.map(({ contentReference }) => {
      const value = parents.get(key)?.get(contentReference.artifactId);
      if (!value) throw new PolicyRecordGraphError("observation_conflict", key);
      return value;
    });
    const result = inspectPolicyEvaluationFixtureArtifactBindings(
      { scope: graph.scope, evaluationTime: graph.evaluationTime, source: read.source },
      fixtureRead,
      captured.map(({ first }) => first.read.catalog),
    );
    results.push({
      ...result,
      artifacts: result.artifacts.map((binding, index) => ({
        ...binding,
        artifactCaptureIndexes: [...(captured[index] as (typeof captured)[number]).indexes],
      })),
    });
  }
  return results;
}
