import {
  type PolicyEvaluationRequest,
  type PolicyEvaluationSourceReference,
  policyEvaluationSourceReferenceKey,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import type { PolicyEvaluationEvidenceReference } from "@proofstack/core";
import { type AcquisitionBudget, PolicyRecordGraphError } from "./acquisition-budget.js";
import {
  capturePolicyLogicalRootBinding,
  inspectPolicyLogicalRootBinding,
  isPolicyLogicalRootSource,
  type PolicyLogicalRootBinding,
} from "./capture-logical-root.js";
import type { PolicyEvaluationLogicalRootPorts } from "./logical-root-ports.js";
import {
  type PolicyRecordExpansion,
  type PolicyRecordGraphRepositories,
  readAndExpandPolicyRecord,
} from "./record-routing.js";
import {
  enumerateRetainedPolicyRecord,
  type PolicyRetainedRecordCapture,
} from "./retained-record-routing.js";
import {
  inspectStoredCoreSelectors,
  inspectStoredSelectorResolution,
  isStoredSelectorReference,
  type PolicyStoredSelectorResolution,
  readStoredSelectorReference,
  storedSelectorChildren,
} from "./stored-selector-routing.js";

export interface PolicyStorageInventoryNode {
  readonly capture: PolicyRetainedRecordCapture;
  /** Null means no valid independently owned stored body, never an empty closure assertion. */
  readonly references: readonly PolicyEvaluationEvidenceReference[] | null;
}
export interface PolicyStorageInventoryEdge {
  readonly parent: PolicyEvaluationSourceReference;
  readonly parentRecordSha256: string;
  readonly reference: PolicyEvaluationEvidenceReference;
  /** Complete ordered selector outcomes preserve unavailable material without semantic promotion. */
  readonly resolution?: PolicyStoredSelectorResolution;
  readonly targets: readonly PolicyEvaluationSourceReference[];
}
export interface PolicyStorageInventory {
  readonly logicalRootConfiguration: "configured" | "unconfigured";
  readonly roots: readonly PolicyEvaluationSourceReference[];
  readonly nodes: readonly PolicyStorageInventoryNode[];
  readonly logicalRoots: readonly PolicyLogicalRootBinding[];
  readonly edges: readonly PolicyStorageInventoryEdge[];
  readonly frontier: {
    readonly records: number;
    readonly logicalRoots: number;
    readonly declarations: number;
  };
}

export interface PolicyStorageInventoryPrefetch {
  readonly nodes: readonly PolicyRecordExpansion[];
  readonly bindings: readonly PolicyLogicalRootBinding[];
  readonly selectors: ReadonlyMap<string, PolicyStoredSelectorResolution>;
}

function canonical(value: unknown): string {
  return serializeEvaluationCanonicalJson(value);
}

function sameCapture(
  left: PolicyRetainedRecordCapture | undefined,
  right: PolicyRetainedRecordCapture,
): boolean {
  // Both operands belong to this invocation. Identical owned components need no serialization;
  // separately returned material still compares complete bodies, hashes and actual receipts.
  return (
    left !== undefined &&
    ((left.read === right.read && left.storage === right.storage) ||
      canonical(left) === canonical(right))
  );
}

function directTarget(reference: PolicyEvaluationEvidenceReference) {
  if (reference.kind === "record") return reference.source;
  if (reference.kind === "qualification_policy")
    return { kind: "qualification_policy" as const, reference: reference.reference };
  if (reference.kind === "replay_declaration" && reference.declaration.kind === "endpoint_profile")
    return { kind: "endpoint_profile" as const, reference: reference.declaration.reference };
  return null;
}

/**
 * Internal request-owned acquisition. Ports share the outer request meter and held connection.
 * Original roots and unavailable stored parents are traversed only for storage provenance.
 * No artifact object/key reads, authority assertion, snapshot seal or publication occur here.
 */
export async function acquirePolicyStorageInventory(
  request: PolicyEvaluationRequest,
  ports: PolicyRecordGraphRepositories,
  rootPorts: PolicyEvaluationLogicalRootPorts | undefined,
  budget: AcquisitionBudget,
  initial: PolicyStorageInventoryPrefetch,
  reinspect?: {
    node(node: PolicyStorageInventoryNode): void;
    binding(binding: PolicyLogicalRootBinding): void;
    edge(index: number, edge: PolicyStorageInventoryEdge): void;
  },
): Promise<PolicyStorageInventory> {
  const { scope, evaluationTime } = request;
  const limits = {
    maxReferences: request.limits.maxAcquisitionRecords,
    maxReferenceBytes: request.limits.maxAcquisitionRecordBytes,
  };
  const replayLimits = {
    maximumRecords: request.limits.maxAcquisitionRecords,
    maximumRecordBytes: request.limits.maxAcquisitionRecordBytes,
  };
  const roots: PolicyEvaluationSourceReference[] = [
    { kind: "release_candidate", reference: request.candidate },
    { kind: "release_policy", reference: request.policy },
  ];
  const captures = new Map<string, PolicyRetainedRecordCapture>();
  const expected = new Map<string, PolicyEvaluationSourceReference>();
  const queued = new Set<string>();
  const queue: PolicyEvaluationSourceReference[] = [];
  const nodes: PolicyStorageInventoryNode[] = [];
  const bindings: PolicyLogicalRootBinding[] = [];
  const edges: PolicyStorageInventoryEdge[] = [];
  const prefetchedBindings = new Map(
    initial.bindings.map((binding) => [
      policyEvaluationSourceReferenceKey(binding.parent),
      binding,
    ]),
  );
  const remember = (capture: PolicyRetainedRecordCapture) => {
    const key = policyEvaluationSourceReferenceKey(capture.read.source);
    const previous = captures.get(key);
    if (previous && !sameCapture(previous, capture))
      throw new PolicyRecordGraphError("observation_conflict", key);
    captures.set(key, capture);
  };
  const enqueue = (
    source: PolicyEvaluationSourceReference,
    capture?: PolicyRetainedRecordCapture,
  ) => {
    const key = policyEvaluationSourceReferenceKey(source);
    const previous = expected.get(key);
    if (previous && canonical(previous) !== canonical(source))
      throw new PolicyRecordGraphError("reference_conflict", key);
    expected.set(key, source);
    if (capture) {
      if (canonical(capture.read.source) !== canonical(source))
        throw new PolicyRecordGraphError("reference_conflict", key);
      remember(capture);
    }
    if (!queued.has(key)) {
      queued.add(key);
      queue.push(source);
    }
  };
  for (const node of initial.nodes)
    remember({ read: node.read, storage: node.storage ?? null } as PolicyRetainedRecordCapture);
  // Preserve every original selector child before any possible later lookup of the same identity.
  for (const resolution of initial.selectors.values())
    for (const capture of storedSelectorChildren(resolution)) remember(capture);
  for (const root of roots) enqueue(root);

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const source = queue[cursor] as PolicyEvaluationSourceReference;
    const key = policyEvaluationSourceReferenceKey(source);
    const context = { scope, evaluationTime, source, replayLimits };
    let capture = captures.get(key);
    if (!capture) {
      const expansion = await readAndExpandPolicyRecord(context, ports, limits, replayLimits);
      capture = {
        read: expansion.read,
        storage: expansion.storage ?? null,
      } as PolicyRetainedRecordCapture;
      remember(capture);
    }
    const frontier = capture.storage
      ? enumerateRetainedPolicyRecord(context, capture, limits)
      : null;
    const node: PolicyStorageInventoryNode = { capture, references: frontier?.references ?? null };
    reinspect?.node(node);
    nodes.push(node);
    if (!frontier) continue;
    budget.addReferences(frontier.references.length, frontier.referenceBytes);
    const binding =
      prefetchedBindings.get(key) ??
      (await capturePolicyLogicalRootBinding(context, capture, rootPorts));
    if (binding) {
      reinspect?.binding(binding);
      bindings.push(binding);
      if (binding.status === "retained") enqueue(binding.root.read.source, binding.root);
    }
    for (const reference of frontier.references) {
      const parent = {
        parent: source,
        parentRecordSha256: frontier.storage.recordSha256,
        reference,
      };
      let edge: PolicyStorageInventoryEdge;
      if (isStoredSelectorReference(reference)) {
        const prefetched = initial.selectors.get(
          canonical({ parent: source, path: reference.path }),
        );
        let resolution = prefetched;
        if (!resolution) {
          budget.addReferences(frontier.references.length, frontier.referenceBytes);
          resolution = await readStoredSelectorReference(
            context,
            capture,
            reference,
            limits,
            ports,
          );
        }
        const children = storedSelectorChildren(resolution);
        edge = { ...parent, resolution, targets: children.map((child) => child.read.source) };
        reinspect?.edge(edges.length, edge);
        edges.push(edge);
        for (const child of children) enqueue(child.read.source, child);
      } else {
        const target = directTarget(reference);
        edge = { ...parent, targets: target ? [target] : [] };
        reinspect?.edge(edges.length, edge);
        edges.push(edge);
        if (target) enqueue(target);
      }
    }
  }
  const inventory: PolicyStorageInventory = {
    logicalRootConfiguration: rootPorts ? "configured" : "unconfigured",
    roots,
    nodes,
    logicalRoots: bindings,
    edges,
    frontier: {
      records: nodes.filter(({ capture }) => capture.storage === null).length,
      logicalRoots: bindings.filter((binding) => binding.status === "unresolved").length,
      declarations: edges.filter((edge) => edge.targets.length === 0).length,
    },
  };
  const inspection = inspectPolicyStorageInventory(request, inventory, initial);
  budget.addReferences(inspection.references, inspection.referenceBytes);
  return inventory;
}

/** Rebuild storage reachability and ordered occurrences from immutable roots and owning bodies. */
export function inspectPolicyStorageInventory(
  request: PolicyEvaluationRequest,
  inventory: PolicyStorageInventory,
  initial: PolicyStorageInventoryPrefetch,
) {
  const roots: PolicyEvaluationSourceReference[] = [
    { kind: "release_candidate", reference: request.candidate },
    { kind: "release_policy", reference: request.policy },
  ];
  function fail(identity: string): never {
    throw new PolicyRecordGraphError("observation_conflict", identity);
  }
  if (canonical(roots) !== canonical(inventory.roots)) fail("storage_roots");
  if (!["configured", "unconfigured"].includes(inventory.logicalRootConfiguration))
    fail("storage_root_configuration");
  const nodes = new Map<string, PolicyStorageInventoryNode>();
  for (const node of inventory.nodes) {
    const key = policyEvaluationSourceReferenceKey(node.capture.read.source);
    if (nodes.has(key)) fail(key);
    nodes.set(key, node);
  }
  const compareCapture = (capture: PolicyRetainedRecordCapture) => {
    const key = policyEvaluationSourceReferenceKey(capture.read.source);
    if (!sameCapture(nodes.get(key)?.capture, capture)) fail(key);
  };
  for (const node of initial.nodes)
    compareCapture({
      read: node.read,
      storage: node.storage ?? null,
    } as PolicyRetainedRecordCapture);
  for (const binding of initial.bindings)
    if (binding.status === "retained") compareCapture(binding.root);
  for (const resolution of initial.selectors.values())
    for (const capture of storedSelectorChildren(resolution)) compareCapture(capture);
  const bindings = new Map<string, PolicyLogicalRootBinding>();
  for (const binding of inventory.logicalRoots) {
    const key = policyEvaluationSourceReferenceKey(binding.parent);
    if (bindings.has(key)) fail(key);
    bindings.set(key, binding);
  }
  for (const binding of initial.bindings) {
    const key = policyEvaluationSourceReferenceKey(binding.parent);
    const captured = bindings.get(key);
    if (captured !== binding && canonical(captured ?? null) !== canonical(binding)) fail(key);
  }
  const expected = new Map<string, PolicyEvaluationSourceReference>();
  const queue: PolicyEvaluationSourceReference[] = [];
  const enqueue = (source: PolicyEvaluationSourceReference) => {
    const key = policyEvaluationSourceReferenceKey(source);
    const previous = expected.get(key);
    if (previous && canonical(previous) !== canonical(source)) fail(key);
    if (!previous) {
      expected.set(key, source);
      queue.push(source);
    }
  };
  for (const root of roots) enqueue(root);
  let edgeIndex = 0;
  let bindingIndex = 0;
  let references = 0;
  let referenceBytes = 0;
  const limits = {
    maxReferences: request.limits.maxAcquisitionRecords,
    maxReferenceBytes: request.limits.maxAcquisitionRecordBytes,
  };
  const replayLimits = {
    maximumRecords: request.limits.maxAcquisitionRecords,
    maximumRecordBytes: request.limits.maxAcquisitionRecordBytes,
  };
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const source = queue[cursor] as PolicyEvaluationSourceReference;
    const key = policyEvaluationSourceReferenceKey(source);
    const node = nodes.get(key);
    if (
      !node ||
      inventory.nodes[cursor] !== node ||
      canonical(node.capture.read.source) !== canonical(source)
    )
      fail(key);
    if (!node.capture.storage) {
      if (node.references !== null) fail(key);
      if (node.capture.read.observation.status === "verified" || node.capture.read.record !== null)
        fail(key);
      continue;
    }
    const context = {
      source,
      scope: request.scope,
      evaluationTime: request.evaluationTime,
      replayLimits,
    };
    // Every fixed stored enumerator already owns and revalidates the complete capture.
    const frontier = enumerateRetainedPolicyRecord(context, node.capture, limits);
    references += frontier.references.length;
    referenceBytes += frontier.referenceBytes;
    if (canonical(frontier.references) !== canonical(node.references)) fail(key);
    const binding = bindings.get(key);
    if (isPolicyLogicalRootSource(source) !== Boolean(binding)) fail(key);
    if (binding) {
      if (inventory.logicalRootConfiguration === "configured" && binding.status !== "retained")
        fail(key);
      if (
        inventory.logicalRootConfiguration === "unconfigured" &&
        (binding.status !== "unresolved" || binding.reason !== "root_port_unconfigured")
      )
        fail(key);
      if (
        inventory.logicalRoots[bindingIndex++] !== binding ||
        binding.parentRecordSha256 !== frontier.storage.recordSha256
      )
        fail(key);
      if (binding.status === "retained") {
        const inspectedBinding = inspectPolicyLogicalRootBinding(
          context,
          node.capture,
          binding.root.storage?.record,
        );
        if (canonical(inspectedBinding) !== canonical(binding)) fail(key);
        // The owning root inspector above validated the root at the original cut.
        const rootNode = nodes.get(policyEvaluationSourceReferenceKey(binding.root.read.source));
        if (!rootNode || !sameCapture(rootNode.capture, binding.root)) fail(key);
        enqueue(binding.root.read.source);
      }
    }
    const coreSelectors: Extract<PolicyStoredSelectorResolution, { kind: "selector" }>[] = [];
    for (const reference of frontier.references) {
      const edge = inventory.edges[edgeIndex++];
      if (
        !edge ||
        canonical({
          parent: edge.parent,
          parentRecordSha256: edge.parentRecordSha256,
          reference: edge.reference,
        }) !==
          canonical({
            parent: source,
            parentRecordSha256: frontier.storage.recordSha256,
            reference,
          })
      )
        fail(key);
      let targets: readonly PolicyEvaluationSourceReference[];
      if (isStoredSelectorReference(reference)) {
        if (
          !edge.resolution ||
          canonical(edge.resolution.report.reference) !== canonical(reference) ||
          canonical(edge.resolution.report.parentStorage) !==
            canonical({
              source,
              recordSha256: frontier.storage.recordSha256,
              receiptTime: frontier.storage.receiptTime,
            })
        )
          fail(key);
        const children = storedSelectorChildren(edge.resolution);
        const prefetched = initial.selectors.get(
          canonical({ parent: source, path: reference.path }),
        );
        if (
          prefetched &&
          prefetched !== edge.resolution &&
          canonical(prefetched) !== canonical(edge.resolution)
        )
          fail(key);
        const batched =
          edge.resolution.kind === "selector" &&
          edge.resolution.report.childCapture?.storage !== null &&
          edge.resolution.report.childCapture?.storage !== undefined;
        const inspectedResolution = batched
          ? null
          : inspectStoredSelectorResolution(
              context,
              node.capture,
              reference,
              limits,
              edge.resolution,
            );
        if (batched && edge.resolution.kind === "selector") coreSelectors.push(edge.resolution);
        if (batched || inspectedResolution) {
          references += frontier.references.length;
          referenceBytes += frontier.referenceBytes;
        }
        if (inspectedResolution && canonical(inspectedResolution) !== canonical(edge.resolution))
          fail(key);
        if (
          canonical(edge.resolution.report.parentSemanticObservation) !==
            canonical(node.capture.read.observation) ||
          canonical(edge.resolution.report.inspectionUsage) !==
            canonical({
              references: frontier.references.length,
              referenceBytes: frontier.referenceBytes,
            })
        )
          fail(key);
        for (const child of children) {
          const childNode = nodes.get(policyEvaluationSourceReferenceKey(child.read.source));
          if (!childNode || !sameCapture(childNode.capture, child)) fail(key);
        }
        targets = children.map((child) => child.read.source);
      } else {
        if (edge.resolution) fail(key);
        const target = directTarget(reference);
        targets = target ? [target] : [];
      }
      if (canonical(targets) !== canonical(edge.targets)) fail(key);
      for (const target of targets) enqueue(target);
    }
    const inspectedCore = inspectStoredCoreSelectors(context, node.capture, limits, coreSelectors);
    for (let index = 0; index < coreSelectors.length; index++)
      if (canonical(inspectedCore[index]) !== canonical(coreSelectors[index])) fail(key);
  }
  if (
    queue.length !== inventory.nodes.length ||
    edgeIndex !== inventory.edges.length ||
    bindingIndex !== inventory.logicalRoots.length
  )
    fail("storage_closure");
  if (
    canonical(inventory.frontier) !==
    canonical({
      records: inventory.nodes.filter(({ capture }) => capture.storage === null).length,
      logicalRoots: inventory.logicalRoots.filter((binding) => binding.status === "unresolved")
        .length,
      declarations: inventory.edges.filter((edge) => edge.targets.length === 0).length,
    })
  )
    fail("storage_frontier");
  return { references, referenceBytes };
}
