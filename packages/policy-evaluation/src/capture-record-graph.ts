import {
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationManifestEntry,
  type PolicyEvaluationRequest,
  type PolicyEvaluationSourceReference,
  policyEvaluationSourceReferenceKey,
} from "@proofstack/contracts";
import {
  type PolicyEvaluationControlRead,
  type PolicyEvaluationEvidenceRead,
  type PolicyEvaluationEvidenceReference,
  type PolicyEvaluationImplementationParentSource,
  type PolicyEvaluationSelectorParentSource,
  type PolicyEvaluationSelectorRead,
  policyEvaluationRequestReference,
  readPolicyEvaluationImplementationResolution,
  readPolicyEvaluationSelector,
  validatePolicyEvaluationRequestRecord,
} from "@proofstack/core";
import {
  inspectPolicyEvaluationDatasetRelations,
  type PolicyDatasetRelations,
  type PolicyEvaluationDatasetRead,
  type PolicyEvaluationModelEndpointCheck,
  type PolicyEvaluationModelEndpointParentSource,
  readPolicyEvaluationModelEndpointResolution,
} from "@proofstack/datasets";
import {
  inspectPolicyEvaluationReplayPlanBindings,
  inspectPolicyEvaluationReplayResultBindings,
  type PolicyEvaluationReplayDefinitionRead,
  type PolicyEvaluationReplayResultRead,
  type PolicyReplayPlanBindingRead,
  type PolicyReplayPlanBindings,
  type PolicyReplayResultBindings,
} from "@proofstack/replay";
import { AcquisitionBudget, PolicyRecordGraphError } from "./acquisition-budget.js";
import {
  inspectCapturedCandidateAssessmentLineage,
  type PolicyCandidateAssessmentLineage,
} from "./capture-candidate-assessment-lineage.js";
import {
  inspectCapturedEvaluationReplayBindings,
  type PolicyEvaluationReplayBindings,
} from "./capture-evaluation-replay-bindings.js";
import {
  inspectCapturedEvaluationSnapshots,
  type PolicyEvaluationSnapshotBindings,
} from "./capture-evaluation-snapshots.js";
import {
  inspectCapturedModelAssurance,
  type PolicyModelAssuranceBindings,
} from "./capture-model-assurance.js";
import {
  inspectCapturedPolicyAssessments,
  type PolicyAssessmentBindings,
} from "./capture-policy-assessments.js";
import { deriveCapturedRecordClosure, type PolicyRecordClosure } from "./derive-record-closure.js";
import {
  emptyEndpointProfiles,
  emptyImplementationRegistrations,
  emptyQualificationPolicies,
  enumerateCapturedPolicyRecord,
  type PolicyRecordExpansion,
  type PolicyRecordGraphRepositories,
  type PolicyRecordRead,
  readAndExpandPolicyRecord,
} from "./record-routing.js";
import { CapturedGraphReinspection } from "./reinspect-captured-observations.js";

export interface PolicyRecordGraphEdge {
  readonly parent: PolicyEvaluationSourceReference;
  readonly parentRecordSha256: string;
  readonly reference: PolicyEvaluationEvidenceReference;
  /**
   * Null retains a declaration/artifact/selector frontier, never a successful empty edge.
   * A joined declaration target still leaves current-authority validation in the frontier.
   */
  readonly target: PolicyEvaluationSourceReference | null;
  readonly selectorFailure?:
    | { readonly status: "missing" }
    | Pick<Extract<PolicyEvaluationSelectorRead, { status: "unavailable" }>, "status" | "reason">;
  /** Retained registration data resolution only; installed bytes/current authority remain open. */
  readonly registrationFailure?:
    | { readonly status: "missing" }
    | {
        readonly status: "unavailable";
        readonly reason: "record_invalid" | "reference_mismatch" | "not_yet_available";
      };
  /** Independent retained model endpoint data; four context checks are separate from authority. */
  readonly endpointFailure?:
    | { readonly status: "missing" }
    | {
        readonly status: "unavailable";
        readonly reason: "record_invalid" | "reference_mismatch" | "not_yet_available";
      };
  readonly endpointChecks?: readonly PolicyEvaluationModelEndpointCheck[];
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
  /** Independently re-derived retained record inventory and explicit non-record frontier. */
  readonly recordClosure: PolicyRecordClosure;
  /** Exact rule-to-candidate assessment declarations, not transitive lineage or eligibility. */
  readonly policyAssessments: PolicyAssessmentBindings;
  /** Candidate dataset/target lineage joined to retained histories, not current authority. */
  readonly candidateAssessmentLineage: PolicyCandidateAssessmentLineage;
  /** Exact membership/predecessor observations, not whole-graph semantic eligibility. */
  readonly datasetRelations: PolicyDatasetRelations;
  /** Retained run/aggregate/assessment consistency, not criterion trust or policy satisfaction. */
  readonly evaluationSnapshots: PolicyEvaluationSnapshotBindings;
  /** Run-to-plan dataset/target and retained replay prerequisites, not execution authority. */
  readonly evaluationReplays: PolicyEvaluationReplayBindings;
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
    implementationRegistrations: budget.wrap(
      repositories.implementationRegistrations ?? emptyImplementationRegistrations,
    ),
    qualificationPolicies: budget.wrap(
      repositories.qualificationPolicies ?? emptyQualificationPolicies,
    ),
    endpointProfiles: budget.wrap(repositories.endpointProfiles ?? emptyEndpointProfiles),
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

/**
 * Internal composition boundary: only request-owning entry points supply this shared meter and
 * their own retained graph. This optional comparison neither acquires guards nor grants a seal.
 */
export async function acquirePolicyRecordGraph(
  request: PolicyEvaluationRequest,
  repositories: PolicyRecordGraphRepositories,
  budget: AcquisitionBudget,
  retained?: PolicyRecordGraph,
): Promise<PolicyRecordGraph> {
  let reinspection: CapturedGraphReinspection | undefined;
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
  const admitEdge = (edge: PolicyRecordGraphEdge) => {
    reinspection?.edge(edges.length, edge);
    edges.push(edge);
  };

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
    reinspection = retained ? new CapturedGraphReinspection(request, retained) : undefined;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const source = queue[cursor] as PolicyEvaluationSourceReference;
      const key = policyEvaluationSourceReferenceKey(source);
      let expansion: PolicyRecordExpansion;
      const prefetched = captured.get(key);
      if (prefetched) {
        // Only fixed parent-bound readers prefetch nodes. Reinspect their original observations before
        // traversal; do not query it again or discard the reciprocal edge that led back to a parent.
        const frontier = enumerateCapturedPolicyRecord(
          { evaluationTime, scope, source },
          prefetched,
          limits,
          replayLimits,
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
      reinspection?.expansion(expansion);
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
          admitEdge({ ...parent, target: reference.source });
          enqueue(reference.source);
        } else if (
          reference.kind === "replay_declaration" &&
          reference.declaration.kind === "endpoint_profile"
        ) {
          const target = {
            kind: "endpoint_profile" as const,
            reference: reference.declaration.reference,
          };
          admitEdge({ ...parent, target });
          enqueue(target);
        } else if (reference.kind === "qualification_policy") {
          // The original validated declaration already supplies all expected coordinates.
          // Retain its exact target even when independently stored data is missing/unavailable.
          const target = { kind: "qualification_policy" as const, reference: reference.reference };
          admitEdge({ ...parent, target });
          enqueue(target);
        } else if (reference.kind === "endpoint_profile_selector") {
          // Every original occurrence reinspects the complete parent before its exact lookup.
          budget.addReferences(references.length, referenceBytes);
          const resolved = await readPolicyEvaluationModelEndpointResolution(
            {
              evaluationTime,
              scope,
              source: source as PolicyEvaluationModelEndpointParentSource,
              path: reference.path,
              limits,
            },
            read as PolicyEvaluationDatasetRead,
            ports.endpointProfiles ?? emptyEndpointProfiles,
          );
          if (resolved.status === "resolved") {
            admitEdge({
              ...parent,
              target: resolved.evidence.source,
              endpointChecks: resolved.checks,
            });
            reinspection?.read(resolved.evidence);
            enqueue(resolved.evidence.source, resolved.evidence);
          } else {
            admitEdge({
              ...parent,
              target: null,
              endpointChecks: resolved.checks,
              endpointFailure:
                resolved.status === "missing"
                  ? { status: "missing" }
                  : { status: "unavailable", reason: resolved.reason },
            });
          }
        } else if (reference.kind === "registered_implementation") {
          // Charge complete parent reinspection before another read, including repeated origins.
          budget.addReferences(references.length, referenceBytes);
          const resolved = await readPolicyEvaluationImplementationResolution(
            {
              evaluationTime,
              scope,
              source: source as PolicyEvaluationImplementationParentSource,
              path: reference.path,
              limits,
            },
            read as PolicyEvaluationEvidenceRead,
            ports.implementationRegistrations ?? emptyImplementationRegistrations,
          );
          if (resolved.status === "resolved") {
            admitEdge({ ...parent, target: resolved.evidence.source });
            reinspection?.read(resolved.evidence);
            enqueue(resolved.evidence.source, resolved.evidence);
          } else {
            admitEdge({
              ...parent,
              target: null,
              registrationFailure:
                resolved.status === "missing"
                  ? { status: "missing" }
                  : { status: "unavailable", reason: resolved.reason },
            });
          }
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
            admitEdge({ ...parent, target: resolved.evidence.source });
            reinspection?.read(resolved.evidence as PolicyRecordRead);
            enqueue(resolved.evidence.source, resolved.evidence as PolicyRecordRead);
          } else
            admitEdge({
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
          admitEdge({ ...parent, target: null });
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
    const admitInspection = <
      T extends {
        readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
      },
    >(
      report: T,
    ): T => {
      budget.addReferences(
        report.inspectionUsage.references,
        report.inspectionUsage.referenceBytes,
      );
      return report;
    };
    const { entries, closure } = deriveCapturedRecordClosure(
      request,
      { roots, nodes, edges },
      limits,
    );
    const recordClosure = admitInspection(closure);
    const policyAssessments = admitInspection(
      inspectCapturedPolicyAssessments(request, { nodes, edges }, limits),
    );
    const evaluationSnapshots = admitInspection(
      inspectCapturedEvaluationSnapshots({ nodes, edges }, limits),
    );
    const modelAssurance = admitInspection(
      inspectCapturedModelAssurance({ nodes, edges }, evaluationSnapshots, limits),
    );
    const candidateAssessmentLineage = admitInspection(
      inspectCapturedCandidateAssessmentLineage(
        request,
        { nodes, edges },
        evaluationSnapshots,
        modelAssurance,
        limits,
      ),
    );
    const replayPlans = admitInspection(
      inspectPolicyEvaluationReplayPlanBindings(
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
              read.source.kind === "replay_isolation_profile" ||
              read.source.kind === "endpoint_profile",
          ),
        limits,
      ),
    );
    const evaluationReplays = admitInspection(
      inspectCapturedEvaluationReplayBindings(
        {
          nodes,
          edges,
          replayPlans,
          replayResults: { results: replayResults, unavailableResults },
        },
        limits,
      ),
    );
    const graph: PolicyRecordGraph = {
      request: policyEvaluationRequestReference(request),
      scope,
      evaluationTime,
      roots,
      nodes,
      edges,
      entries,
      recordClosure,
      policyAssessments,
      candidateAssessmentLineage,
      evaluationSnapshots,
      evaluationReplays,
      modelAssurance,
      replayResults: { results: replayResults, unavailableResults },
      datasetRelations: admitInspection(
        inspectPolicyEvaluationDatasetRelations(
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
      ),
      replayPlans,
      usage: budget.usage(),
      unresolved: {
        records: nodes.filter(({ read }) => read.observation.status !== "verified").length,
        references: recordClosure.frontier.length,
      },
    };
    reinspection?.complete(graph);
    return graph;
  } finally {
    await budget.settle();
  }
}
