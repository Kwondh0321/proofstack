import {
  type PolicyEvaluationRequest,
  type PolicyEvaluationSourceReference,
  policyEvaluationSourceReferenceKey,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import { validatePolicyEvaluationRequestRecord } from "@proofstack/core";
import {
  inspectPolicyEvaluationStoredDatasetRelations,
  type PolicyEvaluationDatasetCapture,
  type PolicyStoredDatasetRelations,
} from "@proofstack/datasets";
import {
  inspectPolicyEvaluationStoredReplayPlanBindings,
  inspectPolicyEvaluationStoredReplayResultBindings,
  type PolicyEvaluationReplayDefinitionCapture,
  type PolicyEvaluationReplayResultCapture,
  type PolicyStoredReplayPlanBindingCapture,
  type PolicyStoredReplayPlanBindings,
  type PolicyStoredReplayResultBindings,
} from "@proofstack/replay";
import { type AcquisitionBudget, PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyStorageInventory } from "./capture-storage-inventory.js";
import {
  inspectEvaluationReplayMaterial,
  type PolicyEvaluationReplayMaterialBindings,
} from "./capture-evaluation-replay-bindings.js";
import {
  inspectEvaluationSnapshotMaterial,
  type PolicyEvaluationMaterialSnapshotBindings,
} from "./capture-evaluation-snapshots.js";
import {
  inspectModelAssuranceMaterial,
  type PolicyModelAssuranceMaterialBindings,
} from "./capture-model-assurance.js";
import { storedRelationshipMaterial } from "./relationship-material.js";

type Source = PolicyEvaluationSourceReference;
type Origin = {
  readonly nodeIndex: number;
  readonly dependencyEdgeIndexes: readonly number[];
};

export interface PolicyStoredRelationships {
  readonly authorityBoundary: "stored_relationships_only";
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
  readonly datasets: PolicyStoredDatasetRelations;
  readonly datasetOrigins: readonly Origin[];
  readonly replayPlans: PolicyStoredReplayPlanBindings;
  readonly replayPlanOrigins: readonly Origin[];
  readonly replayResults: readonly PolicyStoredReplayResultBindings[];
  readonly replayResultOrigins: readonly Origin[];
  readonly evaluationSnapshots: PolicyEvaluationMaterialSnapshotBindings;
  readonly evaluationSnapshotOrigins: readonly Origin[];
  readonly evaluationReplays: PolicyEvaluationReplayMaterialBindings;
  readonly evaluationReplayOrigins: readonly Origin[];
  readonly modelAssurance: PolicyModelAssuranceMaterialBindings;
  readonly modelAssuranceOrigins: readonly Origin[];
  readonly unavailableResults: readonly {
    readonly nodeIndex: number;
    readonly source: Extract<Source, { kind: "replay_result" }>;
    readonly observation: Exclude<
      PolicyEvaluationReplayResultCapture["read"]["observation"],
      { status: "verified" }
    >;
  }[];
}

/** Fixed internal composition over this request's validated original storage, never operands. */
export function inspectCapturedStoredRelationships(
  input: PolicyEvaluationRequest,
  inventory: PolicyStorageInventory,
  budget: AcquisitionBudget,
): PolicyStoredRelationships {
  const request = validatePolicyEvaluationRequestRecord(input);
  const before = budget.usage();
  const context = { scope: request.scope, evaluationTime: request.evaluationTime };
  const limits = {
    maxReferences: request.limits.maxAcquisitionRecords,
    maxReferenceBytes: request.limits.maxAcquisitionRecordBytes,
  };
  const material = storedRelationshipMaterial(request, inventory, budget);
  const canonical = (value: unknown) => serializeEvaluationCanonicalJson(value);
  const conflict = (): never => {
    throw new PolicyRecordGraphError("observation_conflict");
  };
  const nodes = new Map<string, number>();
  inventory.nodes.forEach(({ capture }, index) => {
    const key = policyEvaluationSourceReferenceKey(capture.read.source);
    if (nodes.has(key)) conflict();
    nodes.set(key, index);
  });
  const edgeKey = (source: Source, path: string) =>
    JSON.stringify([policyEvaluationSourceReferenceKey(source), path]);
  const edges = new Map<string, number>();
  inventory.edges.forEach((edge, index) => {
    const key = edgeKey(edge.parent, edge.reference.path);
    if (edges.has(key)) conflict();
    edges.set(key, index);
  });
  const admit = <
    T extends {
      readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
    },
  >(
    report: T,
  ): T => {
    budget.addReferences(report.inspectionUsage.references, report.inspectionUsage.referenceBytes);
    return report;
  };
  const origin = (
    source: Source,
    hash: string,
    dependencies: readonly { readonly path: string; readonly source: Source }[],
  ): Origin => {
    const nodeIndex = nodes.get(policyEvaluationSourceReferenceKey(source));
    const node = nodeIndex === undefined ? undefined : inventory.nodes[nodeIndex];
    if (
      nodeIndex === undefined ||
      !node?.capture.storage ||
      node.capture.storage.recordSha256 !== hash ||
      canonical(node.capture.read.source) !== canonical(source)
    )
      return conflict();
    const dependencyEdgeIndexes = dependencies.map((dependency) => {
      const index = edges.get(edgeKey(source, dependency.path));
      const edge = index === undefined ? undefined : inventory.edges[index];
      if (
        index === undefined ||
        !edge ||
        edge.parentRecordSha256 !== hash ||
        canonical(edge.parent) !== canonical(source) ||
        canonical(edge.targets) !== canonical([dependency.source])
      )
        return conflict();
      return index;
    });
    const frame = { nodeIndex, dependencyEdgeIndexes };
    budget.addReferences(
      1 + dependencyEdgeIndexes.length,
      Buffer.byteLength(canonical(frame), "utf8"),
    );
    return frame;
  };
  const captures = inventory.nodes.map(({ capture }) => capture);
  const datasets = admit(
    inspectPolicyEvaluationStoredDatasetRelations(
      context,
      captures.filter(
        (capture): capture is PolicyEvaluationDatasetCapture =>
          capture.read.source.kind === "dataset_version" ||
          capture.read.source.kind === "regression_fixture_version",
      ),
      limits,
    ),
  );
  const replayPlans = admit(
    inspectPolicyEvaluationStoredReplayPlanBindings(
      context,
      captures.filter(
        (capture): capture is PolicyStoredReplayPlanBindingCapture =>
          capture.read.source.kind === "replay_plan" ||
          capture.read.source.kind === "target_release" ||
          capture.read.source.kind === "dataset_version" ||
          capture.read.source.kind === "regression_fixture_version" ||
          capture.read.source.kind === "replay_runtime_profile" ||
          capture.read.source.kind === "replay_isolation_profile" ||
          capture.read.source.kind === "endpoint_profile",
      ),
      limits,
    ),
  );
  const replayResults: PolicyStoredReplayResultBindings[] = [];
  const replayResultOrigins: Origin[] = [];
  const unavailableResults: PolicyStoredRelationships["unavailableResults"][number][] = [];
  inventory.nodes.forEach(({ capture }, nodeIndex) => {
    if (capture.read.source.kind !== "replay_result") return;
    if (capture.storage === null) {
      if (capture.read.observation.status === "verified") conflict();
      const frame = {
        nodeIndex,
        source: capture.read.source,
        observation: capture.read
          .observation as PolicyStoredRelationships["unavailableResults"][number]["observation"],
      };
      budget.addReferences(1, Buffer.byteLength(canonical(frame), "utf8"));
      unavailableResults.push(frame);
      return;
    }
    const source = capture.read.source;
    const planSource = { kind: "replay_plan" as const, reference: source.reference.plan };
    const planIndex = nodes.get(policyEvaluationSourceReferenceKey(planSource));
    const plan = planIndex === undefined ? undefined : inventory.nodes[planIndex]?.capture;
    if (!plan || canonical(plan.read.source) !== canonical(planSource)) conflict();
    const report = admit(
      inspectPolicyEvaluationStoredReplayResultBindings(
        {
          ...context,
          source,
          limits: {
            maximumRecords: request.limits.maxAcquisitionRecords,
            maximumRecordBytes: request.limits.maxAcquisitionRecordBytes,
          },
        },
        capture as PolicyEvaluationReplayResultCapture,
        plan as PolicyEvaluationReplayDefinitionCapture,
        limits,
      ),
    );
    replayResults.push(report);
    replayResultOrigins.push(
      origin(source, report.recordSha256, [{ path: "/job/plan", source: report.plan.source }]),
    );
  });
  const evaluationSnapshots = admit(inspectEvaluationSnapshotMaterial(material, limits));
  const evaluationReplays = admit(
    inspectEvaluationReplayMaterial(
      material,
      {
        plans: replayPlans.plans.map((plan) => ({
          ...plan,
          dependencies: plan.dependencies.map((dependency) => ({
            bodyPresent: dependency.storage !== null,
          })),
        })),
        results: replayResults,
      },
      limits,
    ),
  );
  const modelAssurance = admit(
    inspectModelAssuranceMaterial(material, evaluationSnapshots, limits),
  );
  const materialOrigin = (parent: {
    readonly source: Source;
    readonly recordSha256: string;
    readonly receiptTime: string | null;
    readonly recordObservation: unknown;
    readonly dependencyEdgeIndexes: readonly number[];
  }): Origin => {
    const nodeIndex = nodes.get(policyEvaluationSourceReferenceKey(parent.source));
    const capture = nodeIndex === undefined ? undefined : inventory.nodes[nodeIndex]?.capture;
    if (
      nodeIndex === undefined ||
      !capture?.storage ||
      capture.storage.recordSha256 !== parent.recordSha256 ||
      capture.storage.receiptTime !== parent.receiptTime ||
      canonical(capture.read.source) !== canonical(parent.source) ||
      canonical(capture.read.observation) !== canonical(parent.recordObservation)
    )
      return conflict();
    // Nested/repeated dependencies keep their actual owner, not a substituted top-level parent.
    for (const index of parent.dependencyEdgeIndexes) {
      const edge = inventory.edges[index];
      const owner = edge && nodes.get(policyEvaluationSourceReferenceKey(edge.parent));
      const ownerCapture = owner === undefined ? undefined : inventory.nodes[owner]?.capture;
      if (
        !edge ||
        !ownerCapture?.storage ||
        canonical(ownerCapture.read.source) !== canonical(edge.parent) ||
        ownerCapture.storage.recordSha256 !== edge.parentRecordSha256
      )
        return conflict();
    }
    const frame = { nodeIndex, dependencyEdgeIndexes: parent.dependencyEdgeIndexes };
    budget.addReferences(
      1 + frame.dependencyEdgeIndexes.length,
      Buffer.byteLength(canonical(frame), "utf8"),
    );
    return frame;
  };
  const report = {
    authorityBoundary: "stored_relationships_only" as const,
    datasets,
    datasetOrigins: datasets.parents.map((parent) =>
      origin(parent.source, parent.recordSha256, parent.relations),
    ),
    replayPlans,
    replayPlanOrigins: replayPlans.plans.map((plan) =>
      origin(plan.source, plan.recordSha256, plan.dependencies),
    ),
    replayResults,
    replayResultOrigins,
    evaluationSnapshots,
    evaluationSnapshotOrigins: evaluationSnapshots.parents.map(materialOrigin),
    evaluationReplays,
    evaluationReplayOrigins: evaluationReplays.parents.map(materialOrigin),
    modelAssurance,
    modelAssuranceOrigins: modelAssurance.parents.map(materialOrigin),
    unavailableResults,
  };
  budget.addReferences(0, Buffer.byteLength(canonical(report), "utf8"));
  const after = budget.usage();
  return structuredClone({
    ...report,
    inspectionUsage: {
      references: after.references - before.references,
      referenceBytes: after.referenceBytes - before.referenceBytes,
    },
  });
}
