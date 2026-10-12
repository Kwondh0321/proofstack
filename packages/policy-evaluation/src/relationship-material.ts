import {
  type PolicyEvaluationManifestEntry,
  PolicyEvaluationManifestEntrySchema,
  type PolicyEvaluationRequest,
  type PolicyEvaluationSourceReference,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import {
  type PolicyEvaluationEvidenceReference,
  validatePolicyEvaluationRequestRecord,
} from "@proofstack/core";
import { type AcquisitionBudget, PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";
import {
  inspectPolicyStorageInventory,
  type PolicyStorageInventory,
} from "./capture-storage-inventory.js";
import type { PolicyRecordRead } from "./record-routing.js";
import { isStoredSelectorReference } from "./stored-selector-routing.js";

/** A validated body witness, never an assertion of semantic availability or authority. */
export interface PolicyRelationshipMaterial {
  readonly source: PolicyEvaluationSourceReference;
  readonly observation: PolicyEvaluationManifestEntry["observation"];
  readonly body: {
    readonly record: unknown;
    readonly recordSha256: string;
    readonly receiptTime: string | null;
  } | null;
}

export interface PolicyRelationshipMaterialEdge {
  readonly parent: PolicyEvaluationSourceReference;
  readonly parentRecordSha256: string;
  readonly reference: PolicyEvaluationEvidenceReference;
  readonly target: PolicyEvaluationSourceReference | null;
  /** A fixed owning selector's unavailable mapping, never a missing direct reference. */
  readonly unresolvedSelector: boolean;
  readonly hasSelectorFailure: boolean;
}

export interface PolicyRelationshipMaterialGraph {
  readonly nodes: readonly PolicyRelationshipMaterial[];
  readonly edges: readonly PolicyRelationshipMaterialEdge[];
}

export function semanticRelationshipRead(read: PolicyRecordRead): PolicyRelationshipMaterial {
  if (read.observation.status === "verified" && read.record === null)
    throw new PolicyRecordGraphError("observation_conflict");
  return {
    source: read.source,
    observation: read.observation,
    body:
      read.observation.status === "verified"
        ? { record: read.record, recordSha256: read.observation.recordSha256, receiptTime: null }
        : null,
  };
}

/** Preserve the semantic inspectors' original verified-only body boundary. */
export function semanticRelationshipMaterial(
  graph: Pick<PolicyRecordGraph, "nodes" | "edges">,
): PolicyRelationshipMaterialGraph {
  return {
    nodes: graph.nodes.map(({ read }) => semanticRelationshipRead(read)),
    edges: graph.edges.map((edge) => ({
      parent: edge.parent,
      parentRecordSha256: edge.parentRecordSha256,
      reference: edge.reference,
      target: edge.target,
      hasSelectorFailure: edge.selectorFailure !== undefined,
      unresolvedSelector:
        edge.target === null &&
        edge.reference.kind === "evaluation_run_identity" &&
        edge.selectorFailure !== undefined,
    })),
  };
}

/** Own original storage and complete reachability; never rewrite semantic observations. */
export function storedRelationshipMaterial(
  input: PolicyEvaluationRequest,
  inventory: PolicyStorageInventory,
  budget: AcquisitionBudget,
): PolicyRelationshipMaterialGraph {
  const request = validatePolicyEvaluationRequestRecord(input);
  budget.addReferences(
    1,
    Buffer.byteLength(
      serializeEvaluationCanonicalJson({
        scope: request.scope,
        evaluationTime: request.evaluationTime,
      }),
      "utf8",
    ),
  );
  // Admit complete original material before the owning derivation allocates/validates its graph.
  budget.addReferences(
    inventory.nodes.length + inventory.edges.length + inventory.logicalRoots.length,
    Buffer.byteLength(serializeEvaluationCanonicalJson(inventory), "utf8"),
  );
  const inspection = inspectPolicyStorageInventory(request, inventory, {
    nodes: [],
    bindings: [],
    selectors: new Map(),
  });
  budget.addReferences(inspection.references, inspection.referenceBytes);
  return {
    nodes: inventory.nodes.map(({ capture }) => {
      if (Reflect.ownKeys(capture).length !== 2 || Reflect.ownKeys(capture.read).length !== 3)
        throw new PolicyRecordGraphError("observation_conflict");
      const entry = PolicyEvaluationManifestEntrySchema.parse({
        source: capture.read.source,
        observation: capture.read.observation,
      });
      if (
        capture.storage === null &&
        (entry.observation.status === "verified" ||
          (entry.observation.status === "unavailable" &&
            entry.observation.reason === "not_yet_available"))
      )
        throw new PolicyRecordGraphError("observation_conflict");
      return {
        source: entry.source,
        observation: entry.observation,
        body: capture.storage
          ? {
              record: capture.storage.record,
              recordSha256: capture.storage.recordSha256,
              receiptTime: capture.storage.receiptTime,
            }
          : null,
      };
    }),
    edges: inventory.edges.map((edge) => ({
      parent: edge.parent,
      parentRecordSha256: edge.parentRecordSha256,
      reference: edge.reference,
      target: edge.targets.length === 1 ? (edge.targets[0] ?? null) : null,
      unresolvedSelector: edge.targets.length !== 1 && isStoredSelectorReference(edge.reference),
      hasSelectorFailure: edge.targets.length !== 1 && isStoredSelectorReference(edge.reference),
    })),
  };
}
