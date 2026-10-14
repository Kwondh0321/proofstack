import {
  type CriterionSet,
  type PolicyEvaluationRequest,
  type PolicyEvaluationSnapshotInputs,
  PolicyEvaluationSnapshotInputsSchema,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import {
  hashEvaluationCanonicalJson,
  inspectPolicyEvaluationControlRecord,
} from "@proofstack/core";
import { type AcquisitionBudget, PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyArtifactEvidenceCapture } from "./capture-artifact-evidence.js";
import type { PolicyCandidateAuthorityObservation } from "./capture-candidate-authority.js";
import type { PolicyCriterionAuthorityObservation } from "./capture-criterion-authority.js";
import type { PolicyPreparedSnapshotInputs } from "./prepare-snapshot-inputs.js";
import { compileCapturedSemanticClosure } from "./compile-semantic-closure.js";

type Capture = Extract<PolicyArtifactEvidenceCapture, { status: "artifacts_captured" }>;
function conflict(): never {
  throw new PolicyRecordGraphError("observation_conflict");
}
function admitFrames(
  value: unknown,
  budget: AcquisitionBudget,
  ancestors = new Set<object>(),
  depth = 0,
): void {
  if (value === null || typeof value !== "object") return;
  if (depth > 64 || ancestors.has(value)) throw new PolicyRecordGraphError("unmeasurable_record");
  budget.addReferences(1, 0);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item === null || typeof item !== "object") budget.addReferences(1, 0);
      else admitFrames(item, budget, ancestors, depth + 1);
    }
  } else for (const item of Object.values(value)) admitFrames(item, budget, ancestors, depth + 1);
  ancestors.delete(value);
}
function withoutUsage<T extends { readonly inspectionUsage: unknown }>(value: T) {
  const { inspectionUsage: _usage, ...material } = value;
  return material;
}
function candidate(value: PolicyCandidateAuthorityObservation) {
  return value.status === "not_configured" ? value : withoutUsage(value);
}
function criteria(value: PolicyCriterionAuthorityObservation) {
  if (value.status === "not_required") return value;
  const { successors, ...material } = withoutUsage(value);
  return {
    ...material,
    successors: successors.map((read) => {
      if (read.source.kind !== "criterion_set") conflict();
      const storage =
        read.observation.status === "verified" && read.record !== null
          ? {
              recordSha256: read.observation.recordSha256,
              receiptTime: (read.record as CriterionSet).publishedAt,
            }
          : null;
      return { source: read.source, observation: read.observation, storage };
    }),
  };
}

/** Fixed internal compilation. Own capture bodies are revalidated before bounded projection. */
export function compileCapturedSnapshotInputs(
  request: PolicyEvaluationRequest,
  capture: Capture,
  prepared: PolicyPreparedSnapshotInputs,
  budget: AcquisitionBudget,
): {
  readonly inputs: PolicyEvaluationSnapshotInputs;
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
} {
  const before = budget.usage();
  if (capture.traceCapture.status !== "traces_captured") conflict();
  const traceCapture = capture.traceCapture;
  const graph = traceCapture.comparisonCapture.graph;
  const root = (kind: "release_candidate" | "release_policy") => {
    const source =
      kind === "release_candidate"
        ? { kind, reference: request.candidate }
        : { kind, reference: request.policy };
    const node = graph.nodes.find(
      ({ read }) =>
        serializeEvaluationCanonicalJson(read.source) === serializeEvaluationCanonicalJson(source),
    );
    if (!node || node.read.observation.status !== "verified") conflict();
    const checked = inspectPolicyEvaluationControlRecord(
      { source, scope: request.scope, evaluationTime: request.evaluationTime },
      node.read.record,
    );
    if (
      checked.observation.status !== "verified" ||
      checked.record === null ||
      checked.observation.recordSha256 !== node.read.observation.recordSha256
    )
      conflict();
    return checked.record;
  };
  const material = {
    schemaVersion: "0.2" as const,
    request,
    capturedAt: capture.completedAt,
    roots: { candidate: root("release_candidate"), policy: root("release_policy") },
    sources: prepared.sources,
    rules: capture.snapshotRules.inputs,
    manifest: prepared.manifest,
    policyAuthority: withoutUsage(capture.policyAuthority),
    policyLifecycle: capture.policyLifecycle,
    candidateAuthority: {
      beforeArtifacts: candidate(capture.candidateAuthority.beforeArtifacts),
      afterArtifacts: candidate(capture.candidateAuthority.afterArtifacts),
    },
    criterionAuthority: {
      beforeArtifacts: criteria(capture.criterionAuthority.beforeArtifacts),
      afterArtifacts: criteria(capture.criterionAuthority.afterArtifacts),
      ...(capture.criterionAuthority.underGuards
        ? { underGuards: criteria(capture.criterionAuthority.underGuards) }
        : {}),
    },
    applicability: withoutUsage(capture.applicability),
    evaluationTrust: withoutUsage(capture.evaluationTrust),
    traces: traceCapture.traces.map(({ edgeIndex, read }) => ({
      edgeIndex,
      scope: read.scope,
      selector: read.selector,
      observation: read.observation,
    })),
    traceArtifactReferences: traceCapture.artifactReferences,
    artifacts: capture.artifacts.map(({ origin, read }) => {
      const { usage: _usage, ...observation } = read;
      return { origin, ...observation };
    }),
    storedArtifacts: capture.storedArtifacts.map(({ origin, read }) => ({ origin, ...read })),
    fixtureBindings: capture.fixtureBindings,
    closure: compileCapturedSemanticClosure(capture, prepared, budget),
    sourceGuards: capture.sourceGuards,
  };
  // Admit every structured output frame and array occurrence, including repeated authority rows,
  // descriptors, selector positions and root/rule metadata, before serialization and copying.
  // The ancestor set detects cycles only; shared values are charged again at every original use.
  admitFrames(material, budget);
  budget.addReferences(0, Buffer.byteLength(serializeEvaluationCanonicalJson(material), "utf8"));
  const parsed = PolicyEvaluationSnapshotInputsSchema.safeParse(material);
  if (!parsed.success) {
    const error = new PolicyRecordGraphError("observation_conflict", "snapshot_inputs");
    Object.defineProperty(error, "cause", { value: parsed.error });
    throw error;
  }
  const inputs = parsed.data;
  if (
    hashEvaluationCanonicalJson(inputs.roots.candidate) !== inputs.rules.candidate.recordSha256 ||
    hashEvaluationCanonicalJson(inputs.roots.policy) !== inputs.rules.policy.recordSha256
  )
    conflict();
  const after = budget.usage();
  return {
    inputs,
    inspectionUsage: {
      references: after.references - before.references,
      referenceBytes: after.referenceBytes - before.referenceBytes,
    },
  };
}
