import {
  type PolicyEvaluationManifestEntry,
  PolicyEvaluationManifestEntrySchema,
  type PolicyEvaluationRequest,
  type PolicyEvaluationSourceReference,
  policyEvaluationSourceReferenceKey,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import {
  hashEvaluationCanonicalJson,
  policyEvaluationRequestReference,
  validatePolicyEvaluationRequestRecord,
} from "@proofstack/core";
import { AcquisitionBudget, PolicyRecordGraphError } from "./acquisition-budget.js";
import { acquirePolicyRecordGraph, type PolicyRecordGraph } from "./capture-record-graph.js";
import { inspectPolicyStorageInventory } from "./capture-storage-inventory.js";
import { deriveCapturedRecordClosure } from "./derive-record-closure.js";
import type { PolicyRecordGraphRepositories } from "./record-routing.js";

type Origin =
  | { readonly kind: "request_root"; readonly rootIndex: number }
  | { readonly kind: "semantic_node"; readonly nodeIndex: number }
  | { readonly kind: "stored_node"; readonly nodeIndex: number }
  | { readonly kind: "semantic_edge"; readonly edgeIndex: number }
  | { readonly kind: "semantic_edge_parent"; readonly edgeIndex: number }
  | { readonly kind: "stored_edge"; readonly edgeIndex: number; readonly targetIndex: number }
  | { readonly kind: "stored_edge_parent"; readonly edgeIndex: number }
  | { readonly kind: "logical_root"; readonly bindingIndex: number }
  | { readonly kind: "logical_root_parent"; readonly bindingIndex: number };

export interface PolicyInputRecordSources {
  /** Record-domain closure only; authority histories, artifacts and traces remain separate inputs. */
  readonly authorityBoundary: "record_sources_only";
  readonly request: ReturnType<typeof policyEvaluationRequestReference>;
  readonly scope: PolicyEvaluationRequest["scope"];
  readonly evaluationTime: string;
  readonly records: readonly {
    readonly entry: PolicyEvaluationManifestEntry;
    /** Original body identity, including future bodies; never a semantic availability upgrade. */
    readonly storage: { readonly recordSha256: string; readonly receiptTime: string } | null;
    /** Every original use is retained even when a manifest entry is unique. */
    readonly origins: readonly Origin[];
  }[];
  readonly semanticFrontier: readonly (ReturnType<
    typeof deriveCapturedRecordClosure
  >["closure"]["frontier"][number] &
    Pick<
      PolicyRecordGraph["edges"][number],
      "parent" | "parentRecordSha256" | "reference" | "target"
    >)[];
  /** Original non-record mappings retain zero/unique/multiple outcomes and their exact edge origin. */
  readonly storedMappings: readonly {
    readonly edgeIndex: number;
    readonly parent: PolicyEvaluationSourceReference;
    readonly parentRecordSha256: string;
    readonly reference: PolicyRecordGraph["edges"][number]["reference"];
    readonly targets: readonly PolicyEvaluationSourceReference[];
    /** Structural cardinality only; not authority or verified semantic selection. */
    readonly cardinality: "zero" | "unique" | "multiple";
    /** Full owning resolution fingerprint; retained child bodies are not copied here. */
    readonly resolutionSha256: string | null;
  }[];
  readonly logicalRoots: {
    readonly configuration: PolicyRecordGraph["logicalRoots"]["configuration"];
    readonly mappings: readonly {
      readonly bindingIndex: number;
      readonly parent: PolicyEvaluationSourceReference;
      readonly parentRecordSha256: string;
      readonly state:
        | { readonly status: "unresolved"; readonly reason: "root_port_unconfigured" }
        | { readonly status: "retained"; readonly root: PolicyEvaluationSourceReference };
    }[];
  };
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
}

function canonical(value: unknown): string {
  return serializeEvaluationCanonicalJson(value);
}
function conflict(identity?: string): never {
  throw new PolicyRecordGraphError("observation_conflict", identity);
}

/** Server-owned record acquisition and derivation share one immutable request's finite meter. */
export async function capturePolicyInputRecordSources(
  input: PolicyEvaluationRequest,
  repositories: PolicyRecordGraphRepositories,
) {
  const request = validatePolicyEvaluationRequestRecord(input);
  const budget = new AcquisitionBudget(request.limits);
  const graph = await acquirePolicyRecordGraph(request, repositories, budget);
  const sources = derivePolicyInputRecordSources(request, graph, budget);
  return {
    status: "record_sources_captured" as const,
    graph,
    sources,
    usage: budget.usage(),
  };
}

/** Fixed internal derivation from owning bodies; no supplied expected list, I/O or seal. */
export function derivePolicyInputRecordSources(
  input: PolicyEvaluationRequest,
  graph: PolicyRecordGraph,
  budget: AcquisitionBudget,
): PolicyInputRecordSources {
  const request = validatePolicyEvaluationRequestRecord(input);
  const reference = policyEvaluationRequestReference(request);
  const inventory = graph.storageInventory;
  if (
    canonical(graph.request) !== canonical(reference) ||
    canonical(graph.scope) !== canonical(request.scope) ||
    graph.evaluationTime !== request.evaluationTime ||
    graph.logicalRoots.configuration !== inventory.logicalRootConfiguration
  )
    conflict();
  const before = budget.usage();
  // Admit occurrences before serializing or copying their material, then admit exact bytes.
  budget.addReferences(
    1 +
      graph.nodes.length +
      graph.edges.length +
      graph.logicalRoots.bindings.length +
      inventory.nodes.length +
      inventory.edges.length +
      inventory.logicalRoots.length,
    0,
  );
  budget.addReferences(
    0,
    Buffer.byteLength(
      canonical({
        request: reference,
        scope: request.scope,
        evaluationTime: request.evaluationTime,
        semantic: {
          roots: graph.roots,
          nodes: graph.nodes,
          edges: graph.edges,
          logicalRoots: graph.logicalRoots,
        },
        inventory,
      }),
      "utf8",
    ),
  );
  const limits = {
    maxReferences: request.limits.maxAcquisitionRecords,
    maxReferenceBytes: request.limits.maxAcquisitionRecordBytes,
  };
  const semantic = deriveCapturedRecordClosure(request, graph, limits);
  budget.addReferences(
    semantic.closure.inspectionUsage.references,
    semantic.closure.inspectionUsage.referenceBytes,
  );
  const stored = inspectPolicyStorageInventory(request, inventory, {
    nodes: graph.nodes,
    bindings: graph.logicalRoots.bindings,
    selectors: new Map(),
  });
  budget.addReferences(stored.references, stored.referenceBytes);
  const records = new Map<
    string,
    {
      entry: PolicyEvaluationManifestEntry;
      storage: PolicyInputRecordSources["records"][number]["storage"];
      origins: Origin[];
    }
  >();
  inventory.nodes.forEach(({ capture }, nodeIndex) => {
    const entry = PolicyEvaluationManifestEntrySchema.parse({
      source: capture.read.source,
      observation: capture.read.observation,
    });
    const key = policyEvaluationSourceReferenceKey(entry.source);
    if (records.has(key)) conflict(key);
    records.set(key, {
      entry,
      storage: capture.storage
        ? { recordSha256: capture.storage.recordSha256, receiptTime: capture.storage.receiptTime }
        : null,
      origins: [{ kind: "stored_node", nodeIndex }],
    });
  });
  const record = (source: PolicyEvaluationSourceReference) => {
    const key = policyEvaluationSourceReferenceKey(source);
    const value = records.get(key);
    if (!value || canonical(value.entry.source) !== canonical(source)) conflict(key);
    return value;
  };
  graph.nodes.forEach(({ read }, nodeIndex) => {
    const value = record(read.source);
    if (canonical(value.entry.observation) !== canonical(read.observation)) conflict();
    value.origins.push({ kind: "semantic_node", nodeIndex });
  });
  for (const entry of semantic.entries)
    if (canonical(record(entry.source).entry) !== canonical(entry)) conflict();
  graph.roots.forEach((source, rootIndex) => {
    record(source).origins.push({ kind: "request_root", rootIndex });
  });
  graph.edges.forEach(({ parent, target }, edgeIndex) => {
    record(parent).origins.push({ kind: "semantic_edge_parent", edgeIndex });
    if (target) record(target).origins.push({ kind: "semantic_edge", edgeIndex });
  });
  inventory.edges.forEach(({ parent, targets }, edgeIndex) => {
    record(parent).origins.push({ kind: "stored_edge_parent", edgeIndex });
    targets.forEach((source, targetIndex) => {
      record(source).origins.push({ kind: "stored_edge", edgeIndex, targetIndex });
    });
  });
  inventory.logicalRoots.forEach((binding, bindingIndex) => {
    record(binding.parent).origins.push({ kind: "logical_root_parent", bindingIndex });
    if (binding.status === "retained")
      record(binding.root.read.source).origins.push({ kind: "logical_root", bindingIndex });
  });
  const ordered = [...records.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, value]) => value);
  const material = {
    authorityBoundary: "record_sources_only" as const,
    request: reference,
    scope: request.scope,
    evaluationTime: request.evaluationTime,
    records: ordered,
    logicalRoots: {
      configuration: inventory.logicalRootConfiguration,
      mappings: inventory.logicalRoots.map((binding, bindingIndex) => ({
        bindingIndex,
        parent: binding.parent,
        parentRecordSha256: binding.parentRecordSha256,
        state:
          binding.status === "retained"
            ? { status: "retained" as const, root: binding.root.read.source }
            : { status: "unresolved" as const, reason: binding.reason },
      })),
    },
    semanticFrontier: semantic.closure.frontier.map((frontier) => {
      const edge = graph.edges[frontier.edgeIndex];
      if (!edge) conflict();
      return {
        ...frontier,
        parent: edge.parent,
        parentRecordSha256: edge.parentRecordSha256,
        reference: edge.reference,
        target: edge.target,
      };
    }),
    storedMappings: inventory.edges.flatMap((edge, edgeIndex) =>
      edge.reference.kind === "record"
        ? []
        : [
            {
              edgeIndex,
              parent: edge.parent,
              parentRecordSha256: edge.parentRecordSha256,
              reference: edge.reference,
              targets: edge.targets,
              cardinality:
                edge.targets.length === 0
                  ? ("zero" as const)
                  : edge.targets.length === 1
                    ? ("unique" as const)
                    : ("multiple" as const),
              resolutionSha256: edge.resolution
                ? hashEvaluationCanonicalJson(edge.resolution)
                : null,
            },
          ],
    ),
  };
  budget.addReferences(
    1 +
      ordered.length +
      ordered.reduce((sum, value) => sum + value.origins.length, 0) +
      material.semanticFrontier.length +
      material.storedMappings.length +
      material.logicalRoots.mappings.length,
    Buffer.byteLength(canonical(material), "utf8"),
  );
  const after = budget.usage();
  return structuredClone({
    ...material,
    inspectionUsage: {
      references: after.references - before.references,
      referenceBytes: after.referenceBytes - before.referenceBytes,
    },
  });
}
