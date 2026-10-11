import {
  type PolicyEvaluationRequest,
  policyEvaluationSourceReferenceKey,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import { policyEvaluationRequestReference } from "@proofstack/core";
import type { PolicyLogicalRootBinding } from "./capture-logical-root.js";
import type { PolicyRecordGraph, PolicyRecordGraphEdge } from "./capture-record-graph.js";
import type {
  PolicyStorageInventoryEdge,
  PolicyStorageInventoryNode,
} from "./capture-storage-inventory.js";
import type { PolicyTraceEvidenceCapture } from "./capture-trace-evidence.js";
import type { PolicyRecordExpansion, PolicyRecordRead } from "./record-routing.js";

/** Internal revision failure, distinct from operational errors and cumulative budget failures. */
export class PolicyCapturedObservationRecheckError extends Error {
  readonly code = "policy_captured_observation_recheck_failed";
  readonly reason = "source_revision_changed";
  constructor(readonly identity: string) {
    super(`Captured policy observation changed (${identity})`);
    this.name = "PolicyCapturedObservationRecheckError";
  }
}

function canonical(value: unknown): string {
  return serializeEvaluationCanonicalJson(value);
}

function graphMaterial({ usage: _usage, ...material }: PolicyRecordGraph) {
  return material;
}

function traceMaterial(capture: PolicyTraceEvidenceCapture) {
  const { usage: _usage, comparisonCapture, ...material } = capture;
  return {
    ...material,
    comparisonCapture: {
      ...comparisonCapture,
      graph: graphMaterial(comparisonCapture.graph),
    },
  };
}

/**
 * Retained observations are produced by the same request-owning invocation, never public input.
 * Comparing material does not establish guards, complete mutable authority, or a sealed snapshot.
 */
export class CapturedGraphReinspection {
  private readonly reads = new Map<string, string>();
  private readonly expansions = new Map<string, string>();
  private readonly logicalRoots = new Map<string, string>();
  private readonly edges: readonly string[];
  private readonly material: string;
  private readonly storageNodes = new Map<string, string>();
  private readonly storageBindings = new Map<string, string>();
  private readonly storageEdges: readonly string[];

  constructor(request: PolicyEvaluationRequest, retained: PolicyRecordGraph) {
    if (
      canonical({
        request: policyEvaluationRequestReference(request),
        scope: request.scope,
        evaluationTime: request.evaluationTime,
        roots: [
          { kind: "release_candidate", reference: request.candidate },
          { kind: "release_policy", reference: request.policy },
        ],
      }) !==
      canonical({
        request: retained.request,
        scope: retained.scope,
        evaluationTime: retained.evaluationTime,
        roots: retained.roots,
      })
    )
      throw new PolicyCapturedObservationRecheckError("request");
    for (const node of retained.nodes) {
      const key = policyEvaluationSourceReferenceKey(node.read.source);
      if (this.reads.has(key)) throw new PolicyCapturedObservationRecheckError(key);
      this.reads.set(key, canonical(node.read));
      this.expansions.set(key, canonical(node));
    }
    this.edges = retained.edges.map(canonical);
    for (const binding of retained.logicalRoots.bindings) {
      const key = policyEvaluationSourceReferenceKey(binding.parent);
      if (this.logicalRoots.has(key)) throw new PolicyCapturedObservationRecheckError(key);
      this.logicalRoots.set(key, canonical(binding));
    }
    this.material = canonical(graphMaterial(retained));
    for (const node of retained.storageInventory.nodes) {
      const key = policyEvaluationSourceReferenceKey(node.capture.read.source);
      if (this.storageNodes.has(key)) throw new PolicyCapturedObservationRecheckError(key);
      this.storageNodes.set(key, canonical(node));
    }
    for (const binding of retained.storageInventory.logicalRoots) {
      const key = policyEvaluationSourceReferenceKey(binding.parent);
      if (this.storageBindings.has(key)) throw new PolicyCapturedObservationRecheckError(key);
      this.storageBindings.set(key, canonical(binding));
    }
    this.storageEdges = retained.storageInventory.edges.map(canonical);
  }

  /** Called on selector-prefetched records before enqueueing their descendants. */
  read(read: PolicyRecordRead) {
    const key = policyEvaluationSourceReferenceKey(read.source);
    if (this.reads.get(key) !== canonical(read))
      throw new PolicyCapturedObservationRecheckError(key);
  }

  /** Called before processing any references from a newly read parent. */
  expansion(expansion: PolicyRecordExpansion) {
    const key = policyEvaluationSourceReferenceKey(expansion.read.source);
    if (this.expansions.get(key) !== canonical(expansion))
      throw new PolicyCapturedObservationRecheckError(key);
  }

  /** Compare full original root material before following any parent descendants. */
  logicalRoot(binding: PolicyLogicalRootBinding) {
    const key = policyEvaluationSourceReferenceKey(binding.parent);
    if (this.logicalRoots.get(key) !== canonical(binding))
      throw new PolicyCapturedObservationRecheckError(`logical_root:${key}`);
  }

  /** Compare selector outcomes and repeated ordered occurrences before enqueueing targets. */
  edge(index: number, edge: PolicyRecordGraphEdge) {
    if (this.edges[index] !== canonical(edge))
      throw new PolicyCapturedObservationRecheckError(`edge:${index}`);
  }

  storageNode(node: PolicyStorageInventoryNode) {
    const key = policyEvaluationSourceReferenceKey(node.capture.read.source);
    if (this.storageNodes.get(key) !== canonical(node))
      throw new PolicyCapturedObservationRecheckError(`storage_node:${key}`);
  }

  storageBinding(binding: PolicyLogicalRootBinding) {
    const key = policyEvaluationSourceReferenceKey(binding.parent);
    if (this.storageBindings.get(key) !== canonical(binding))
      throw new PolicyCapturedObservationRecheckError(`storage_root:${key}`);
  }

  storageEdge(index: number, edge: PolicyStorageInventoryEdge) {
    if (this.storageEdges[index] !== canonical(edge))
      throw new PolicyCapturedObservationRecheckError(`storage_edge:${index}`);
  }

  complete(graph: PolicyRecordGraph) {
    if (this.material !== canonical(graphMaterial(graph)))
      throw new PolicyCapturedObservationRecheckError("graph");
  }
}

/** Retains complete trace envelopes, hashes, parent indices and every artifact occurrence. */
export class CapturedTraceReinspection {
  private readonly traces: readonly string[];
  private readonly material: string;

  constructor(retained: PolicyTraceEvidenceCapture) {
    this.traces = retained.status === "traces_captured" ? retained.traces.map(canonical) : [];
    this.material = canonical(traceMaterial(retained));
  }

  trace(index: number, trace: { readonly edgeIndex: number; readonly read: unknown }) {
    if (this.traces[index] !== canonical(trace))
      throw new PolicyCapturedObservationRecheckError(`trace:${index}`);
  }

  complete(capture: PolicyTraceEvidenceCapture) {
    if (this.material !== canonical(traceMaterial(capture)))
      throw new PolicyCapturedObservationRecheckError("trace_capture");
  }
}
