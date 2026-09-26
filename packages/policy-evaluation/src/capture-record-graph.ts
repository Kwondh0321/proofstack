import {
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationManifestEntry,
  type PolicyEvaluationRequest,
  type PolicyEvaluationSourceReference,
  policyEvaluationSourceReferenceKey,
} from "@proofstack/contracts";
import {
  enumeratePolicyEvaluationControlReferences,
  enumeratePolicyEvaluationEvidenceReferences,
  type PolicyEvaluationControlRead,
  type PolicyEvaluationEvidenceRead,
  type PolicyEvaluationEvidenceSource,
  type PolicyEvaluationEvidenceReference,
  type PolicyEvaluationSelectorParentSource,
  type PolicyEvaluationSelectorRead,
  policyEvaluationRequestReference,
  readPolicyEvaluationSelector,
  validatePolicyEvaluationRequestRecord,
} from "@proofstack/core";
import {
  inspectPolicyEvaluationDatasetRelations,
  type PolicyDatasetRelations,
  type PolicyEvaluationDatasetRead,
} from "@proofstack/datasets";
import {
  inspectPolicyEvaluationReplayPlanBindings,
  inspectPolicyEvaluationReplayResultBindings,
  type PolicyEvaluationReplayDefinitionRead,
  type PolicyEvaluationReplayResultRead,
  type PolicyReplayResultBindings,
  type PolicyReplayPlanBindingRead,
  type PolicyReplayPlanBindings,
} from "@proofstack/replay";
import { AcquisitionBudget, PolicyRecordGraphError } from "./acquisition-budget.js";
import {
  inspectCapturedEvaluationSnapshots,
  type PolicyEvaluationSnapshotBindings,
} from "./capture-evaluation-snapshots.js";
import {
  inspectCapturedModelAssurance,
  type PolicyModelAssuranceBindings,
} from "./capture-model-assurance.js";
import {
  type PolicyRecordExpansion,
  type PolicyRecordGraphRepositories,
  type PolicyRecordRead,
  readAndExpandPolicyRecord,
} from "./record-routing.js";

export interface PolicyRecordGraphEdge {
  readonly parent: PolicyEvaluationSourceReference;
  readonly parentRecordSha256: string;
  readonly reference: PolicyEvaluationEvidenceReference;
  /** Null retains a declaration/artifact/selector frontier; it is never a successful empty edge. */
  readonly target: PolicyEvaluationSourceReference | null;
  readonly selectorFailure?:
    | { readonly status: "missing" }
    | Pick<Extract<PolicyEvaluationSelectorRead, { status: "unavailable" }>, "status" | "reason">;
}

export interface PolicyRecordGraph {
  readonly request: ReturnType<typeof policyEvaluationRequestReference>;
  readonly scope: PolicyEvaluationRequest["scope"];
  readonly evaluationTime: string;
  readonly roots: readonly PolicyEvaluationSourceReference[];
  /** Sorted unique record observations. Unreadable parents have references:null. */
  readonly nodes: readonly PolicyRecordExpansion[];
  /** Deterministic breadth-first parent order, preserving every occurrence within each parent. */
  readonly edges: readonly PolicyRecordGraphEdge[];
  readonly entries: readonly PolicyEvaluationManifestEntry[];
  /** Exact membership/predecessor observations, not whole-graph semantic eligibility. */
  readonly datasetRelations: PolicyDatasetRelations;
  /** Retained run/aggregate/assessment consistency, not criterion trust or policy satisfaction. */
  readonly evaluationSnapshots: PolicyEvaluationSnapshotBindings;
  /** Retained model/human prerequisites, not current authority or a release decision. */
  readonly modelAssurance: PolicyModelAssuranceBindings;
  /** Declared replay-plan consistency, not execution or installed runtime authority. */
  readonly replayPlans: PolicyReplayPlanBindings;
  /** All retained attempts and accounting, not proof of execution or policy satisfaction. */
  readonly replayResults: {
    readonly results: readonly PolicyReplayResultBindings[];
    readonly unavailableResults: readonly {
      readonly source: PolicyEvaluationReplayResultRead["source"];
      readonly observation: Exclude<
        PolicyEvaluationReplayResultRead["observation"],
        { status: "verified" }
      >;
    }[];
  };
  readonly usage: ReturnType<AcquisitionBudget["usage"]>;
  readonly unresolved: { readonly records: number; readonly references: number };
}

function canonical(value: unknown): string {
  return Buffer.from(encodeEvaluationCanonicalJson(value)).toString("utf8");
}

function metered(
  repositories: PolicyRecordGraphRepositories,
  budget: AcquisitionBudget,
): PolicyRecordGraphRepositories {
  return {
    control: {
      comparison: budget.wrap(repositories.control.comparison),
      releaseCandidate: budget.wrap(repositories.control.releaseCandidate),
      releasePolicy: budget.wrap(repositories.control.releasePolicy),
      installationBinding: budget.wrap(repositories.control.installationBinding),
    },
    evidence: {
      evaluation: budget.wrap(repositories.evidence.evaluation),
      modelAssurance: budget.wrap(repositories.evidence.modelAssurance),
    },
    datasets: budget.wrap(repositories.datasets),
    replayDefinitions: budget.wrap(repositories.replayDefinitions),
    replayResults: budget.wrap(repositories.replayResults),
    runtimeDefinitions: budget.wrap(repositories.runtimeDefinitions),
  };
}

/**
 * Derives a record dependency graph from a validated immutable request, not caller-chosen roots.
 * The trusted composer must authorize acquisition and supply correctly scoped read-only ports.
 * This is a metadata acquisition building block, NOT a sealed snapshot or complete semantic,
 * artifact/authority validation. No worker, approval, lease, retry, or public API authority exists here.
 */
export async function capturePolicyRecordGraph(
  candidate: unknown,
  repositories: PolicyRecordGraphRepositories,
): Promise<PolicyRecordGraph> {
  const request = validatePolicyEvaluationRequestRecord(candidate);
  const budget = new AcquisitionBudget(request.limits);
  return acquirePolicyRecordGraph(request, repositories, budget);
}

/** Internal composition boundary: only request-owning entry points may supply this shared meter. */
export async function acquirePolicyRecordGraph(
  request: PolicyEvaluationRequest,
  repositories: PolicyRecordGraphRepositories,
  budget: AcquisitionBudget,
): Promise<PolicyRecordGraph> {
  const { evaluationTime, scope } = request;
  const ports = metered(repositories, budget);
  const limits = {
    maxReferenceBytes: request.limits.maxAcquisitionRecordBytes,
    maxReferences: request.limits.maxAcquisitionRecords,
  };
  const replayLimits = {
    maximumRecordBytes: request.limits.maxAcquisitionRecordBytes,
    maximumRecords: request.limits.maxAcquisitionRecords,
  };
  const roots: PolicyEvaluationSourceReference[] = [
    { kind: "release_candidate", reference: request.candidate },
    { kind: "release_policy", reference: request.policy },
  ];
  const queue: PolicyEvaluationSourceReference[] = [];
  const expected = new Map<string, PolicyEvaluationSourceReference>();
  const captured = new Map<string, PolicyRecordRead>();
  const expanded = new Map<string, PolicyRecordExpansion>();
  const artifacts = new Map<string, string>();
  const edges: PolicyRecordGraphEdge[] = [];

  const enqueue = (source: PolicyEvaluationSourceReference, read?: PolicyRecordRead) => {
    const key = policyEvaluationSourceReferenceKey(source);
    const previous = expected.get(key);
    if (previous && canonical(previous) !== canonical(source))
      throw new PolicyRecordGraphError("reference_conflict", key);
    if (!previous) {
      expected.set(key, source);
      queue.push(source);
    }
    if (read) {
      const observed = captured.get(key);
      if (observed && canonical(observed.observation) !== canonical(read.observation))
        throw new PolicyRecordGraphError("observation_conflict", key);
      if (!observed) captured.set(key, read);
    }
  };
  for (const root of roots) enqueue(root);

  try {
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const source = queue[cursor] as PolicyEvaluationSourceReference;
      const key = policyEvaluationSourceReferenceKey(source);
      let expansion: PolicyRecordExpansion;
      const prefetched = captured.get(key);
      if (prefetched) {
        // Only a fixed selector reader can prefetch a node. Reinspect its original observation before
        // traversal; do not query it again or discard the reciprocal edge that led back to a parent.
        const frontier =
          source.kind === "comparison_definition"
            ? enumeratePolicyEvaluationControlReferences(
                { evaluationTime, scope, source },
                prefetched as PolicyEvaluationControlRead,
                limits,
              )
            : enumeratePolicyEvaluationEvidenceReferences(
                {
                  evaluationTime,
                  scope,
                  source: source as PolicyEvaluationEvidenceSource,
                },
                prefetched as PolicyEvaluationEvidenceRead,
                limits,
              );
        expansion = { read: prefetched, references: frontier.references };
      } else {
        expansion = await readAndExpandPolicyRecord(
          { evaluationTime, scope, source },
          ports,
          limits,
          replayLimits,
        );
        enqueue(source, expansion.read);
      }
      expanded.set(key, expansion);
      const { read, references } = expansion;
      if (references === null || read.observation.status !== "verified") continue;
      const referenceBytes = references.reduce(
        (sum, reference) => sum + encodeEvaluationCanonicalJson(reference).byteLength,
        0,
      );
      budget.addReferences(references.length, referenceBytes);
      for (const reference of references) {
        const parent = {
          parent: source,
          parentRecordSha256: read.observation.recordSha256,
          reference,
        };
        if (reference.kind === "record") {
          enqueue(reference.source);
          edges.push({ ...parent, target: reference.source });
        } else if (
          reference.kind === "criterion_selector" ||
          reference.kind === "model_evaluator_selector" ||
          reference.kind === "evaluation_run_identity" ||
          (reference.kind === "control_declaration" &&
            reference.declaration.kind === "comparison_predecessor")
        ) {
          const resolved = await readPolicyEvaluationSelector(
            {
              evaluationTime,
              scope,
              source: source as PolicyEvaluationSelectorParentSource,
              path: reference.path,
              limits,
            },
            read as PolicyEvaluationControlRead | PolicyEvaluationEvidenceRead,
            {
              comparison: ports.control.comparison,
              evaluation: ports.evidence.evaluation,
              modelAssurance: ports.evidence.modelAssurance,
            },
          );
          if (resolved.status === "resolved") {
            enqueue(resolved.evidence.source, resolved.evidence as PolicyRecordRead);
            edges.push({ ...parent, target: resolved.evidence.source });
          } else
            edges.push({
              ...parent,
              target: null,
              selectorFailure:
                resolved.status === "missing"
                  ? { status: "missing" }
                  : { status: "unavailable", reason: resolved.reason },
            });
        } else {
          if (reference.kind === "artifact") {
            const id = reference.reference.artifactId;
            const descriptor = canonical(reference.reference);
            const previous = artifacts.get(id);
            if (previous && previous !== descriptor)
              throw new PolicyRecordGraphError("reference_conflict", `artifact:${id}`);
            artifacts.set(id, descriptor);
          }
          edges.push({ ...parent, target: null });
        }
      }
    }
    const nodes = [...expanded.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, node]) => node);
    const replayResults: PolicyReplayResultBindings[] = [];
    const unavailableResults: PolicyRecordGraph["replayResults"]["unavailableResults"][number][] =
      [];
    for (const { read } of nodes) {
      if (read.source.kind !== "replay_result") continue;
      if (read.observation.status !== "verified") {
        unavailableResults.push({ source: read.source, observation: read.observation });
        continue;
      }
      const planKey = policyEvaluationSourceReferenceKey({
        kind: "replay_plan",
        reference: read.source.reference.plan,
      });
      const planRead = captured.get(planKey);
      if (planRead?.source.kind !== "replay_plan")
        throw new PolicyRecordGraphError("reference_conflict", planKey);
      replayResults.push(
        inspectPolicyEvaluationReplayResultBindings(
          { scope, evaluationTime, source: read.source, limits: replayLimits },
          read as PolicyEvaluationReplayResultRead,
          planRead as PolicyEvaluationReplayDefinitionRead,
        ),
      );
    }
    const evaluationSnapshots = inspectCapturedEvaluationSnapshots({ nodes, edges }, limits);
    return {
      request: policyEvaluationRequestReference(request),
      scope,
      evaluationTime,
      roots,
      nodes,
      edges,
      entries: nodes.map(({ read }) => ({ source: read.source, observation: read.observation })),
      evaluationSnapshots,
      modelAssurance: inspectCapturedModelAssurance({ nodes, edges }, evaluationSnapshots, limits),
      replayResults: { results: replayResults, unavailableResults },
      datasetRelations: inspectPolicyEvaluationDatasetRelations(
        { scope, evaluationTime },
        nodes
          .map(({ read }) => read)
          .filter(
            (read): read is PolicyEvaluationDatasetRead =>
              read.source.kind === "dataset_version" ||
              read.source.kind === "regression_fixture_version",
          ),
        limits,
      ),
      replayPlans: inspectPolicyEvaluationReplayPlanBindings(
        { scope, evaluationTime },
        nodes
          .map(({ read }) => read)
          .filter(
            (read): read is PolicyReplayPlanBindingRead =>
              read.source.kind === "replay_plan" ||
              read.source.kind === "target_release" ||
              read.source.kind === "dataset_version" ||
              read.source.kind === "regression_fixture_version" ||
              read.source.kind === "replay_runtime_profile" ||
              read.source.kind === "replay_isolation_profile",
          ),
        limits,
      ),
      usage: budget.usage(),
      unresolved: {
        records: nodes.filter(({ read }) => read.observation.status !== "verified").length,
        references: edges.filter(({ target }) => target === null).length,
      },
    };
  } finally {
    await budget.settle();
  }
}
