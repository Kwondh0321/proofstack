import {
  type PolicyEvaluationSourceReference,
  PolicyEvaluationSourceReferenceSchema,
  policyEvaluationSourceReferenceKey,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import { PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";
import type { PolicyEvaluationLogicalRootPorts } from "./logical-root-ports.js";
import {
  inspectRetainedPolicyRecord,
  type PolicyRecordContext,
  type PolicyRetainedRecordCapture,
  validateRetainedPolicyRecord,
} from "./retained-record-routing.js";

export type PolicyLogicalRootSource = Extract<
  PolicyEvaluationSourceReference,
  {
    kind:
      | "aggregation_policy"
      | "criterion_set"
      | "evaluator_spec"
      | "oracle_spec"
      | "qualification_fixture_set"
      | "comparison_definition"
      | "comparison_snapshot"
      | "comparison_result"
      | "release_candidate"
      | "release_policy"
      | "dataset_version"
      | "regression_fixture_version";
  }
>;

export type PolicyLogicalRootBinding = {
  readonly parent: PolicyLogicalRootSource;
  readonly parentRecordSha256: string;
} & (
  | { readonly status: "unresolved"; readonly reason: "root_port_unconfigured" }
  | { readonly status: "retained"; readonly root: PolicyRetainedRecordCapture }
);

export function isPolicyLogicalRootSource(
  source: PolicyEvaluationSourceReference,
): source is PolicyLogicalRootSource {
  return [
    "aggregation_policy",
    "criterion_set",
    "evaluator_spec",
    "oracle_spec",
    "qualification_fixture_set",
    "comparison_definition",
    "comparison_snapshot",
    "comparison_result",
    "release_candidate",
    "release_policy",
    "dataset_version",
    "regression_fixture_version",
  ].includes(source.kind);
}

function rootCoordinates(source: PolicyLogicalRootSource) {
  switch (source.kind) {
    case "aggregation_policy":
    case "release_policy":
      return { kind: source.kind, logicalId: "policyId", versionId: "policyVersionId" };
    case "criterion_set":
      return { kind: source.kind, logicalId: "criterionSetId", versionId: "criterionSetVersionId" };
    case "evaluator_spec":
      return { kind: source.kind, logicalId: "evaluatorId", versionId: "evaluatorVersionId" };
    case "oracle_spec":
      return { kind: source.kind, logicalId: "oracleId", versionId: "oracleVersionId" };
    case "qualification_fixture_set":
      return { kind: source.kind, logicalId: "fixtureSetId", versionId: "fixtureSetVersionId" };
    case "comparison_definition":
    case "comparison_snapshot":
    case "comparison_result":
      return {
        kind: "comparison_definition",
        logicalId: "comparisonId",
        versionId: "comparisonVersionId",
      };
    case "release_candidate":
      return { kind: source.kind, logicalId: "candidateId", versionId: "candidateVersionId" };
    case "dataset_version":
      return { kind: source.kind, logicalId: "datasetId", versionId: "datasetVersionId" };
    case "regression_fixture_version":
      return { kind: source.kind, logicalId: "fixtureId", versionId: "fixtureVersionId" };
  }
}

/** Internal storage binding, not a semantic operand, current authority or sealed publication. */
export function inspectPolicyLogicalRootBinding(
  context: PolicyRecordContext,
  parent: PolicyRetainedRecordCapture,
  raw: unknown,
): PolicyLogicalRootBinding {
  const { source } = context;
  if (!isPolicyLogicalRootSource(source)) throw new TypeError("Unsupported logical-root source");
  const owned = validateRetainedPolicyRecord(context, parent);
  return inspectOwnedLogicalRootBinding({ ...context, source }, owned, raw);
}

// Both public entry points validate and own the parent before entering this private boundary.
function inspectOwnedLogicalRootBinding(
  context: PolicyRecordContext & { readonly source: PolicyLogicalRootSource },
  owned: PolicyRetainedRecordCapture,
  raw: unknown,
): PolicyLogicalRootBinding {
  const { source } = context;
  const storage = owned.storage;
  const key = policyEvaluationSourceReferenceKey(source);
  if (!storage || raw === null || typeof raw !== "object")
    throw new PolicyRecordGraphError("observation_conflict", key);
  const fields = raw as Readonly<Record<string, unknown>> & { readonly definitionSha256?: unknown };
  const coords = rootCoordinates(source);
  const original = storage.record as unknown as Readonly<Record<string, unknown>> & {
    readonly comparison?: unknown;
  };
  const logicalId =
    source.kind === "comparison_snapshot" || source.kind === "comparison_result"
      ? (original.comparison as { readonly comparisonId: string }).comparisonId
      : original[coords.logicalId];
  if (fields[coords.logicalId] !== logicalId)
    throw new PolicyRecordGraphError("observation_conflict", key);
  const rootSource = PolicyEvaluationSourceReferenceSchema.parse({
    kind: coords.kind,
    reference: {
      [coords.logicalId]: fields[coords.logicalId],
      [coords.versionId]: fields[coords.versionId],
      definitionSha256: fields.definitionSha256,
    },
  });
  const root = inspectRetainedPolicyRecord({ ...context, source: rootSource }, raw);
  if (!root?.storage) throw new PolicyRecordGraphError("observation_conflict", key);
  if (
    policyEvaluationSourceReferenceKey(rootSource) === key &&
    (serializeEvaluationCanonicalJson(rootSource) !== serializeEvaluationCanonicalJson(source) ||
      root.storage.recordSha256 !== storage.recordSha256)
  )
    throw new PolicyRecordGraphError("observation_conflict", key);
  return {
    parent: structuredClone(source),
    parentRecordSha256: storage.recordSha256,
    status: "retained",
    root,
  };
}

/** Exact-child owning lookup; comparison snapshot's manifest alias is mapped explicitly. */
export async function capturePolicyLogicalRootBinding(
  context: PolicyRecordContext,
  parent: PolicyRetainedRecordCapture,
  ports: PolicyEvaluationLogicalRootPorts | undefined,
): Promise<PolicyLogicalRootBinding | null> {
  const ownedContext = structuredClone(context);
  if (!isPolicyLogicalRootSource(ownedContext.source) || !parent.storage) return null;
  const owned = validateRetainedPolicyRecord(ownedContext, parent);
  if (!owned.storage) throw new TypeError("Expected retained parent storage");
  const source = ownedContext.source;
  const scope = structuredClone(ownedContext.scope);
  if (!ports)
    return {
      parent: source,
      parentRecordSha256: owned.storage.recordSha256,
      status: "unresolved",
      reason: "root_port_unconfigured",
    };
  const id = policyEvaluationSourceReferenceKey(source).slice(source.kind.length + 1);
  let raw: unknown;
  switch (source.kind) {
    case "aggregation_policy":
    case "criterion_set":
    case "evaluator_spec":
    case "oracle_spec":
    case "qualification_fixture_set":
      raw = await ports.evaluation.findEvaluationLogicalRoot(scope, source.kind, id);
      break;
    case "comparison_definition":
    case "comparison_result":
      raw = await ports.comparison.findComparisonLogicalRoot(scope, source.kind, id);
      break;
    case "comparison_snapshot":
      raw = await ports.comparison.findComparisonLogicalRoot(
        scope,
        "comparison_evidence_snapshot",
        id,
      );
      break;
    case "release_candidate":
      raw = await ports.releaseCandidate.findReleaseCandidateLogicalRoot(scope, id);
      break;
    case "release_policy":
      raw = await ports.releasePolicy.findReleasePolicyLogicalRoot(scope, id);
      break;
    case "dataset_version":
      raw = await ports.datasets.findDatasetLogicalRoot(scope, id);
      break;
    case "regression_fixture_version":
      raw =
        "schemaVersion" in owned.storage.record && owned.storage.record.schemaVersion === "0.2"
          ? await ports.datasets.findRecordedInteractionFixtureLogicalRoot(scope, id)
          : await ports.datasets.findFixtureLogicalRoot(scope, id);
      break;
  }
  return inspectOwnedLogicalRootBinding({ ...ownedContext, source }, owned, raw);
}

/** Independently reject missing, extra, reordered or substituted original-root witnesses. */
export function inspectCapturedLogicalRootBindings(
  context: Pick<PolicyRecordContext, "scope" | "evaluationTime">,
  graph: Pick<PolicyRecordGraph, "nodes" | "logicalRoots">,
): void {
  const bindings: PolicyLogicalRootBinding[] = [];
  const sources = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.storage)
      sources.set(
        policyEvaluationSourceReferenceKey(node.read.source),
        serializeEvaluationCanonicalJson({ source: node.read.source, storage: node.storage }),
      );
  }
  if (!["configured", "unconfigured"].includes(graph.logicalRoots.configuration))
    throw new PolicyRecordGraphError("reference_conflict", "logical_root_configuration");
  for (const node of graph.nodes) {
    if (!node.storage || !isPolicyLogicalRootSource(node.read.source)) continue;
    const ownedContext = { ...context, source: node.read.source };
    const parent = { read: node.read, storage: node.storage } as PolicyRetainedRecordCapture;
    if (graph.logicalRoots.configuration === "unconfigured") {
      validateRetainedPolicyRecord(ownedContext, parent);
      bindings.push({
        parent: node.read.source,
        parentRecordSha256: node.storage.recordSha256,
        status: "unresolved",
        reason: "root_port_unconfigured",
      });
    } else {
      const retained = graph.logicalRoots.bindings[bindings.length];
      if (retained?.status !== "retained")
        throw new PolicyRecordGraphError("observation_conflict", "logical_root_binding");
      bindings.push(
        inspectPolicyLogicalRootBinding(ownedContext, parent, retained.root.storage?.record),
      );
      const inspected = bindings.at(-1);
      if (inspected?.status !== "retained") throw new TypeError("Expected retained root");
      const key = policyEvaluationSourceReferenceKey(inspected.root.read.source);
      const material = serializeEvaluationCanonicalJson({
        source: inspected.root.read.source,
        storage: inspected.root.storage,
      });
      const previous = sources.get(key);
      if (previous !== undefined && previous !== material)
        throw new PolicyRecordGraphError("observation_conflict", key);
      sources.set(key, material);
    }
  }
  if (
    serializeEvaluationCanonicalJson({
      configuration: graph.logicalRoots.configuration,
      bindings,
    }) !== serializeEvaluationCanonicalJson(graph.logicalRoots)
  )
    throw new PolicyRecordGraphError("observation_conflict", "logical_root_bindings");
}
