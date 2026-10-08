import {
  type Assessment,
  type CriterionSet,
  type CriterionSetStatusRecord,
  type EvaluationRun,
  type EvaluationRunRejection,
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationSourceReference,
  PolicyEvaluationTimeSchema,
  policyEvaluationSourceReferenceKey,
  policyEvaluationTimestampOrderKey,
} from "@proofstack/contracts";
import {
  type CriterionStatusHistoryLimits,
  type CriterionStatusHistoryRepository,
  inspectCriterionStatusHistory,
  inspectPolicyEvaluationEvidenceRecord,
  type PolicyEvaluationEvidenceRead,
  PolicyEvaluationReferenceCollector,
} from "@proofstack/core";
import { PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";
import {
  type CriterionHistoryProjection,
  type CriterionStatusSelection,
  inspectCriterionStatusSelection,
  projectCriterionHistory,
} from "./criterion-history-projection.js";
import type { PolicyRecordGraphRepositories, PolicyRecordRead } from "./record-routing.js";

type CriterionSource = Extract<PolicyEvaluationSourceReference, { kind: "criterion_set" }>;
type SelectedParent = Extract<
  PolicyEvaluationSourceReference,
  { kind: "assessment" | "evaluation_run" | "evaluation_run_rejection" }
>;
type Graph = Pick<PolicyRecordGraph, "scope" | "evaluationTime" | "nodes" | "edges">;
type CriterionAuthorityClock = { now(): Date | string };
export type CriterionAuthorityReadRepository = CriterionStatusHistoryRepository &
  Pick<PolicyRecordGraphRepositories["evidence"]["evaluation"], "findCriterionSet">;

export interface CriterionAuthorityIssue {
  readonly historyIndex: number;
  readonly reason:
    | "criterion_mismatch"
    | "criterion_receipt_order"
    | "previous_missing"
    | "previous_digest_mismatch"
    | "previous_criterion_mismatch"
    | "previous_receipt_order"
    | "history_cycle"
    | "successor_unavailable"
    | "successor_receipt_order";
}

export type PolicyCriterionAuthorityObservation =
  | { readonly status: "not_required" }
  | {
      readonly status: "observed";
      readonly scope: PolicyRecordGraph["scope"];
      readonly evaluationTime: string;
      readonly startedAt: string;
      readonly completedAt: string;
      /** Owning scope/history digest only, not an atomic revision or publication authority. */
      readonly historySha256: string;
      readonly history: readonly {
        readonly record: CriterionSetStatusRecord;
        readonly recordSha256: string;
      }[];
      /** Later successor content is control evidence, never a replacement policy-time operand. */
      readonly successors: readonly PolicyEvaluationEvidenceRead[];
      readonly criteria: readonly {
        readonly source: CriterionSource;
        readonly observation: PolicyEvaluationEvidenceRead["observation"];
        readonly historyIndexes: readonly number[];
        readonly issues: readonly CriterionAuthorityIssue[];
        readonly atEvaluation: CriterionHistoryProjection;
        readonly atCapture: CriterionHistoryProjection;
      }[];
      readonly selections: readonly {
        readonly parent: SelectedParent;
        readonly parentRecordSha256: string;
        readonly criterion: CriterionSource;
        readonly status: Extract<PolicyEvaluationSourceReference, { kind: "criterion_set_status" }>;
        readonly criterionEdgeIndex: number;
        readonly statusEdgeIndex: number;
        readonly atEvaluation: CriterionStatusSelection;
        readonly atCapture: CriterionStatusSelection;
      }[];
      readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
    };

function canonical(value: unknown): string {
  return Buffer.from(encodeEvaluationCanonicalJson(value)).toString("utf8");
}
/** Internal material comparison. Advancing clocks/projections are not stored-history changes. */
export function criterionAuthorityMaterialFingerprint(
  observation: PolicyCriterionAuthorityObservation,
): string {
  if (observation.status === "not_required") return canonical(observation);
  return canonical({
    format: "proofstack.criterion-authority-observation.v1",
    scope: observation.scope,
    evaluationTime: observation.evaluationTime,
    historySha256: observation.historySha256,
    successors: observation.successors,
    criteria: observation.criteria.map(({ source, observation }) => ({ source, observation })),
    selections: observation.selections.map(
      ({ atEvaluation: _a, atCapture: _b, ...selection }) => selection,
    ),
  });
}
function conflict(): never {
  throw new PolicyRecordGraphError("observation_conflict");
}

/**
 * Complete request-owned status discovery before/after content. No caller-chosen criterion list,
 * latest/favorable status, eligibility upgrade or claim that an unguarded observation is a seal.
 */
export async function observeCapturedCriterionAuthority(
  graph: Graph,
  repository: CriterionAuthorityReadRepository,
  clock: CriterionAuthorityClock,
  limits: CriterionStatusHistoryLimits,
): Promise<PolicyCriterionAuthorityObservation> {
  const criterionNodes = graph.nodes.filter(({ read }) => read.source.kind === "criterion_set");
  if (criterionNodes.length === 0) return { status: "not_required" };
  const time = () => {
    const now = clock.now();
    return PolicyEvaluationTimeSchema.parse(typeof now === "string" ? now : now.toISOString());
  };
  const startedAt = time();
  if (
    policyEvaluationTimestampOrderKey(startedAt) <
    policyEvaluationTimestampOrderKey(graph.evaluationTime)
  )
    conflict();
  const meter = new PolicyEvaluationReferenceCollector({
    maxReferences: limits.maxRecords,
    maxReferenceBytes: limits.maxRecordBytes,
  });
  const nodes = new Map<string, PolicyRecordRead>();
  for (const { read } of graph.nodes) {
    const key = policyEvaluationSourceReferenceKey(read.source);
    if (nodes.has(key)) conflict();
    nodes.set(key, read);
  }
  const revalidate = (read: PolicyRecordRead) => {
    const source = read.source as PolicyEvaluationEvidenceRead["source"];
    const owned = inspectPolicyEvaluationEvidenceRecord(
      { source, scope: graph.scope, evaluationTime: graph.evaluationTime },
      read.record,
    );
    // Missing/unavailable observations retain acquisition provenance. A null body cannot prove
    // absence or reconstruct the reason for an unavailable record, but may never be verified.
    if (read.observation.status === "verified") {
      if (canonical(owned.observation) !== canonical(read.observation)) conflict();
    } else if (read.record !== null) conflict();
    return owned;
  };
  const criteriaByVersion = new Map<string, PolicyEvaluationEvidenceRead>();
  for (const { read } of criterionNodes) {
    const source = read.source as CriterionSource;
    revalidate(read);
    meter.record("/criterion", source.kind, source.reference);
    criteriaByVersion.set(
      source.reference.criterionSetVersionId,
      read as PolicyEvaluationEvidenceRead,
    );
  }
  const retained = inspectCriterionStatusHistory(
    graph.scope,
    await repository.listCriterionSetStatuses(structuredClone(graph.scope), { ...limits }),
    limits,
  );
  const history = retained.history.map(({ record }) => record);
  const byId = new Map(history.map((record, index) => [record.statusRecordId, index]));
  const byVersion = new Map<string, number[]>();
  const successorSources = new Map<string, CriterionSource>();
  history.forEach((record, index) => {
    const version = record.criterionSet.criterionSetVersionId;
    if (!criteriaByVersion.has(version)) return;
    const indexes = byVersion.get(version) ?? [];
    indexes.push(index);
    byVersion.set(version, indexes);
    meter.record(`/history/${index}/criterionSet`, "criterion_set", record.criterionSet);
    if (record.previousStatus)
      meter.record(
        `/history/${index}/previousStatus`,
        "criterion_set_status",
        record.previousStatus,
      );
    if (record.supersededBy) {
      const source: CriterionSource = { kind: "criterion_set", reference: record.supersededBy };
      meter.record(`/history/${index}/supersededBy`, source.kind, source.reference);
      const key = source.reference.criterionSetVersionId;
      const previous = successorSources.get(key);
      if (previous && canonical(previous) !== canonical(source)) conflict();
      successorSources.set(key, source);
    }
  });
  // Compare every known status, including a known missing/unavailable one, with the complete
  // inventory at the original semantic cut. A newly arrived row cannot silently repair the graph.
  for (const { read } of graph.nodes) {
    if (read.source.kind !== "criterion_set_status") continue;
    revalidate(read);
    const index = byId.get(read.source.reference.statusRecordId);
    const current = inspectPolicyEvaluationEvidenceRecord(
      { source: read.source, scope: graph.scope, evaluationTime: graph.evaluationTime },
      index === undefined ? null : history[index],
    );
    if (canonical(current.observation) !== canonical(read.observation)) conflict();
  }
  const retainedSuccessors: { source: CriterionSource; record: unknown }[] = [];
  for (const [, source] of [...successorSources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    retainedSuccessors.push({
      source,
      record: await repository.findCriterionSet(
        structuredClone(graph.scope),
        source.reference.criterionSetVersionId,
      ),
    });
  const completedAt = time();
  const cut = policyEvaluationTimestampOrderKey(completedAt);
  if (
    cut < policyEvaluationTimestampOrderKey(startedAt) ||
    history.some((record) => policyEvaluationTimestampOrderKey(record.recordedAt) > cut)
  )
    conflict();
  const successors = retainedSuccessors.map(({ source, record }) =>
    inspectPolicyEvaluationEvidenceRecord(
      { source, scope: graph.scope, evaluationTime: completedAt },
      record,
    ),
  );
  const successorReads = new Map(
    successors.map((read) => [policyEvaluationSourceReferenceKey(read.source), read]),
  );
  const criteria: Extract<
    PolicyCriterionAuthorityObservation,
    { status: "observed" }
  >["criteria"][number][] = [];
  for (const [, read] of criteriaByVersion) {
    const source = read.source as CriterionSource;
    const indexes = byVersion.get(source.reference.criterionSetVersionId) ?? [];
    const issues: CriterionAuthorityIssue[] = [];
    const add = (historyIndex: number, reason: CriterionAuthorityIssue["reason"]) =>
      issues.push({ historyIndex, reason });
    for (const index of indexes) {
      const record = history[index] as CriterionSetStatusRecord;
      if (canonical(record.criterionSet) !== canonical(source.reference))
        add(index, "criterion_mismatch");
      if (
        read.observation.status === "verified" &&
        policyEvaluationTimestampOrderKey(record.recordedAt) <
          policyEvaluationTimestampOrderKey((read.record as CriterionSet).publishedAt)
      )
        add(index, "criterion_receipt_order");
      if (record.previousStatus) {
        const previousIndex = byId.get(record.previousStatus.statusRecordId);
        const previous = previousIndex === undefined ? undefined : history[previousIndex];
        if (!previous) add(index, "previous_missing");
        else {
          if (previous.definitionSha256 !== record.previousStatus.definitionSha256)
            add(index, "previous_digest_mismatch");
          if (canonical(previous.criterionSet) !== canonical(record.criterionSet))
            add(index, "previous_criterion_mismatch");
          if (
            policyEvaluationTimestampOrderKey(previous.recordedAt) >
            policyEvaluationTimestampOrderKey(record.recordedAt)
          )
            add(index, "previous_receipt_order");
        }
      }
      if (record.supersededBy) {
        const successor = successorReads.get(
          policyEvaluationSourceReferenceKey({
            kind: "criterion_set",
            reference: record.supersededBy,
          }),
        );
        if (successor?.observation.status !== "verified") add(index, "successor_unavailable");
        else if (
          policyEvaluationTimestampOrderKey((successor.record as CriterionSet).publishedAt) >
          policyEvaluationTimestampOrderKey(record.recordedAt)
        )
          add(index, "successor_receipt_order");
      }
    }
    // Iterative chain traversal: bounded history depth cannot overflow the JS call stack.
    const finished = new Set<string>();
    for (const index of indexes) {
      let current: CriterionSetStatusRecord | undefined = history[index];
      const path = new Set<string>();
      while (
        current &&
        current.criterionSet.criterionSetVersionId === source.reference.criterionSetVersionId &&
        !finished.has(current.statusRecordId)
      ) {
        if (path.has(current.statusRecordId)) {
          add(index, "history_cycle");
          break;
        }
        path.add(current.statusRecordId);
        const next = current.previousStatus
          ? byId.get(current.previousStatus.statusRecordId)
          : undefined;
        current = next === undefined ? undefined : history[next];
      }
      for (const id of path) finished.add(id);
    }
    const unresolved = read.observation.status !== "verified" || issues.length > 0;
    criteria.push({
      source,
      observation: read.observation,
      historyIndexes: indexes,
      issues,
      atEvaluation: projectCriterionHistory(history, indexes, graph.evaluationTime, unresolved),
      atCapture: projectCriterionHistory(history, indexes, completedAt, unresolved),
    });
  }
  const projected = new Map(
    criteria.map((entry) => [entry.source.reference.criterionSetVersionId, entry]),
  );
  const edgeKey = (source: PolicyEvaluationSourceReference, path: string) =>
    JSON.stringify([policyEvaluationSourceReferenceKey(source), path]);
  const edges = new Map<string, number>();
  graph.edges.forEach((edge, index) => {
    const key = edgeKey(edge.parent, edge.reference.path);
    if (edges.has(key)) conflict();
    edges.set(key, index);
  });
  const selections: Extract<
    PolicyCriterionAuthorityObservation,
    { status: "observed" }
  >["selections"][number][] = [];
  for (const { read } of graph.nodes) {
    if (
      !["assessment", "evaluation_run", "evaluation_run_rejection"].includes(read.source.kind) ||
      read.observation.status !== "verified"
    )
      continue;
    revalidate(read);
    const parentRecordSha256 = read.observation.recordSha256;
    const record = read.record as Assessment | EvaluationRun | EvaluationRunRejection;
    const criterion: CriterionSource = {
      kind: "criterion_set",
      reference: record.criterion.criterionSet,
    };
    const status = { kind: "criterion_set_status" as const, reference: record.criterionStatus };
    const edgeAt = (path: string, expected: PolicyEvaluationSourceReference) => {
      meter.record(path, expected.kind, expected.reference);
      const index = edges.get(edgeKey(read.source, path));
      const edge = index === undefined ? undefined : graph.edges[index];
      if (
        index === undefined ||
        !edge ||
        edge.parentRecordSha256 !== parentRecordSha256 ||
        canonical(edge.parent) !== canonical(read.source) ||
        edge.reference.kind !== "record" ||
        canonical(edge.reference.source) !== canonical(expected) ||
        canonical(edge.target) !== canonical(expected) ||
        canonical(nodes.get(policyEvaluationSourceReferenceKey(expected))?.source ?? null) !==
          canonical(expected)
      )
        conflict();
      return index;
    };
    const criterionEdgeIndex = edgeAt("/criterion/criterionSet", criterion);
    const statusEdgeIndex = edgeAt("/criterionStatus", status);
    const projection = projected.get(criterion.reference.criterionSetVersionId);
    if (!projection || canonical(projection.source) !== canonical(criterion)) conflict();
    const index = byId.get(status.reference.statusRecordId);
    const selected = index === undefined ? undefined : history[index];
    const selectedIndex =
      selected &&
      selected.definitionSha256 === status.reference.definitionSha256 &&
      canonical(selected.criterionSet) === canonical(criterion.reference)
        ? index
        : undefined;
    selections.push({
      parent: read.source as SelectedParent,
      parentRecordSha256,
      criterion,
      status,
      criterionEdgeIndex,
      statusEdgeIndex,
      atEvaluation: inspectCriterionStatusSelection(
        history,
        selectedIndex,
        projection.atEvaluation,
      ),
      atCapture: inspectCriterionStatusSelection(history, selectedIndex, projection.atCapture),
    });
  }
  const inspection = meter.result();
  return structuredClone({
    status: "observed",
    scope: graph.scope,
    evaluationTime: graph.evaluationTime,
    startedAt,
    completedAt,
    historySha256: retained.historySha256,
    history: retained.history,
    successors,
    criteria,
    selections,
    inspectionUsage: {
      references: inspection.references.length,
      referenceBytes: inspection.referenceBytes,
    },
  });
}
