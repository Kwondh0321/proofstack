import {
  type Assessment,
  AssessmentSnapshotSchema,
  type EvaluationAggregate,
  EvaluationAggregateSnapshotSchema,
  type EvaluationRunResult,
  EvaluationRunSnapshotSchema,
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationManifestEntry,
  type PolicyEvaluationSourceReference,
  policyEvaluationSourceReferenceKey,
} from "@proofstack/contracts";
import {
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
} from "@proofstack/core";
import { PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyRecordGraph, PolicyRecordGraphEdge } from "./capture-record-graph.js";
import type { PolicyRecordRead } from "./record-routing.js";
import {
  inspectCapturedEvaluationRun,
  type PolicyEvaluationRunBindingCheck,
} from "./capture-evaluation-run-bindings.js";

type ParentKind =
  | "evaluation_run"
  | "evaluation_run_result"
  | "evaluation_aggregate"
  | "assessment";
type ParentSource = Extract<PolicyEvaluationSourceReference, { kind: ParentKind }>;
type Status = "matched" | "mismatch" | "unavailable";

export interface PolicyEvaluationSnapshotCheck {
  readonly kind:
    | PolicyEvaluationRunBindingCheck["kind"]
    | "run_definition"
    | "run_history"
    | "aggregate_snapshot"
    | "aggregate_history"
    | "assessment_snapshot";
  /** JSON pointer in the report's parent; empty points at that entire retained record. */
  readonly path: string;
  readonly observation: { readonly status: Status };
}

export interface PolicyEvaluationSnapshotBindings {
  readonly parents: readonly {
    readonly source: ParentSource;
    readonly recordSha256: string;
    /** Original graph edges, including nested aggregate inputs used by an assessment check. */
    readonly dependencyEdgeIndexes: readonly number[];
    readonly checks: readonly PolicyEvaluationSnapshotCheck[];
  }[];
  readonly unavailableParents: readonly {
    readonly source: ParentSource;
    readonly observation: Exclude<
      PolicyEvaluationManifestEntry["observation"],
      { status: "verified" }
    >;
  }[];
  /** Repeated snapshot inputs are charged again, even when their acquisition was shared. */
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
}

function isParent(source: PolicyEvaluationSourceReference): source is ParentSource {
  return ["evaluation_run", "evaluation_run_result", "evaluation_aggregate", "assessment"].includes(
    source.kind,
  );
}

function combinedStatus(checks: readonly PolicyEvaluationSnapshotCheck[]): Status {
  return checks.some((c) => c.observation.status === "mismatch")
    ? "mismatch"
    : checks.some((c) => c.observation.status === "unavailable")
      ? "unavailable"
      : "matched";
}

function same(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}

/**
 * Internal only: consumes this invocation's fixed, revalidated acquisition graph, never a public
 * caller's graph. Reuses domain snapshot rules without I/O, execution or authority inference.
 * A local match does not validate source trust, retained bytes or full closure.
 */
export function inspectCapturedEvaluationSnapshots(
  graph: Pick<PolicyRecordGraph, "nodes" | "edges">,
  limits: PolicyEvaluationEvidenceReferenceLimits,
): PolicyEvaluationSnapshotBindings {
  const meter = new PolicyEvaluationReferenceCollector(limits);
  const nodes = new Map(
    graph.nodes.map(({ read }) => [policyEvaluationSourceReferenceKey(read.source), read]),
  );
  const edges = new Map<string, { edge: PolicyRecordGraphEdge; index: number }>();
  const edgeKey = (source: PolicyEvaluationSourceReference, path: string) =>
    JSON.stringify([policyEvaluationSourceReferenceKey(source), path]);
  graph.edges.forEach((edge, index) => {
    if (!isParent(edge.parent) && edge.parent.kind !== "qualification_report") return;
    const key = edgeKey(edge.parent, edge.reference.path);
    if (edges.has(key)) throw new PolicyRecordGraphError("reference_conflict", key);
    edges.set(key, { edge, index });
  });
  const parents: PolicyEvaluationSnapshotBindings["parents"][number][] = [];
  const unavailableParents: PolicyEvaluationSnapshotBindings["unavailableParents"][number][] = [];
  const histories = new Map<string, Status>();
  const definitions = new Map<string, Status>();
  const aggregates = new Map<
    string,
    { snapshot: unknown; dependencies: number[]; status: Status }
  >();

  const charge = (index: number) => {
    const edge = graph.edges[index] as PolicyRecordGraphEdge;
    if (edge.target) meter.record(edge.reference.path, edge.target.kind, edge.target.reference);
    else if (edge.reference.kind === "evaluation_run_identity" && edge.selectorFailure)
      meter.runIdentity(edge.reference.path, edge.reference.evaluationRunId);
    else
      throw new PolicyRecordGraphError(
        "reference_conflict",
        edgeKey(edge.parent, edge.reference.path),
      );
  };
  const dependency = (
    parent: PolicyRecordRead,
    path: string,
    kind: PolicyEvaluationSourceReference["kind"],
    indexes: number[],
  ): PolicyRecordRead | undefined => {
    const link = edges.get(edgeKey(parent.source, path));
    if (
      !link ||
      parent.observation.status !== "verified" ||
      link.edge.parentRecordSha256 !== parent.observation.recordSha256 ||
      !same(link.edge.parent, parent.source)
    )
      throw new PolicyRecordGraphError("reference_conflict", edgeKey(parent.source, path));
    charge(link.index);
    indexes.push(link.index);
    if (link.edge.target === null) return undefined;
    const child = nodes.get(policyEvaluationSourceReferenceKey(link.edge.target));
    if (!child || child.source.kind !== kind || !same(child.source, link.edge.target))
      throw new PolicyRecordGraphError("reference_conflict", edgeKey(parent.source, path));
    return child;
  };
  const body = (read: PolicyRecordRead | undefined) =>
    read?.observation.status === "verified" ? read.record : undefined;
  const check = (
    kind: PolicyEvaluationSnapshotCheck["kind"],
    path: string,
    status: Status,
  ): PolicyEvaluationSnapshotCheck => ({ kind, path, observation: { status } });
  const status = (
    snapshot: unknown,
    schema: { safeParse(value: unknown): { success: boolean } },
  ): Status =>
    snapshot === undefined
      ? "unavailable"
      : schema.safeParse(snapshot).success
        ? "matched"
        : "mismatch";
  const ordered = [...nodes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  // The passes follow the fixed dependency order, not storage or caller ordering.
  for (const kind of [
    "evaluation_run",
    "evaluation_run_result",
    "evaluation_aggregate",
    "assessment",
  ] as const) {
    for (const [key, parent] of ordered) {
      if (parent.source.kind !== kind || !isParent(parent.source)) continue;
      if (parent.observation.status !== "verified") {
        unavailableParents.push({ source: parent.source, observation: parent.observation });
        continue;
      }
      const dependencies: number[] = [];
      const checks: PolicyEvaluationSnapshotCheck[] = [];
      if (kind === "evaluation_run") {
        checks.push(
          ...inspectCapturedEvaluationRun(parent, (source, path, childKind) =>
            dependency(source, path, childKind, dependencies),
          ),
        );
        definitions.set(key, combinedStatus(checks));
      } else if (kind === "evaluation_run_result") {
        const result = parent.record as EvaluationRunResult;
        const runRead = dependency(parent, "/evaluationRunId", "evaluation_run", dependencies);
        const run = body(runRead);
        const observations = result.observations.map((_, i) =>
          body(dependency(parent, `/observations/${i}`, "raw_observation", dependencies)),
        );
        const snapshot =
          run === undefined || observations.includes(undefined)
            ? undefined
            : { run, result, observations };
        const outcome = status(snapshot, EvaluationRunSnapshotSchema);
        checks.push(check("run_history", "", outcome));
        checks.push(
          check(
            "run_definition",
            "/evaluationRunId",
            runRead === undefined
              ? "unavailable"
              : (definitions.get(policyEvaluationSourceReferenceKey(runRead.source)) ??
                  "unavailable"),
          ),
        );
        histories.set(key, combinedStatus(checks));
      } else if (kind === "evaluation_aggregate") {
        const aggregate = parent.record as EvaluationAggregate;
        const policy = body(
          dependency(parent, "/aggregationPolicy", "aggregation_policy", dependencies),
        );
        const runs: unknown[] = [];
        const results: unknown[] = [];
        aggregate.members.forEach((_, i) => {
          runs.push(body(dependency(parent, `/members/${i}/run`, "evaluation_run", dependencies)));
          const result = dependency(
            parent,
            `/members/${i}/result`,
            "evaluation_run_result",
            dependencies,
          );
          results.push(body(result));
          checks.push(
            check(
              "run_history",
              `/members/${i}/result`,
              result
                ? (histories.get(policyEvaluationSourceReferenceKey(result.source)) ??
                    "unavailable")
                : "unavailable",
            ),
          );
        });
        const snapshot =
          policy === undefined || runs.includes(undefined) || results.includes(undefined)
            ? undefined
            : { aggregate, policy, runs, results };
        const outcome = status(snapshot, EvaluationAggregateSnapshotSchema);
        checks.unshift(check("aggregate_snapshot", "", outcome));
        const historyStatus = combinedStatus(checks);
        aggregates.set(key, { snapshot, dependencies: [...dependencies], status: historyStatus });
      } else {
        const assessment = parent.record as Assessment;
        const aggregate = dependency(parent, "/aggregate", "evaluation_aggregate", dependencies);
        const retained = aggregate
          ? aggregates.get(policyEvaluationSourceReferenceKey(aggregate.source))
          : undefined;
        if (retained) {
          // AssessmentSnapshotSchema checks the nested aggregate too. Charge its full repeated
          // input frontier BEFORE parsing, rather than resetting work limits for each parent.
          retained.dependencies.forEach((index) => {
            charge(index);
            dependencies.push(index);
          });
        }
        checks.push(check("aggregate_history", "/aggregate", retained?.status ?? "unavailable"));
        checks.push(
          check(
            "assessment_snapshot",
            "",
            status(
              retained?.snapshot === undefined
                ? undefined
                : { assessment, aggregateSnapshot: retained.snapshot },
              AssessmentSnapshotSchema,
            ),
          ),
        );
      }
      parents.push({
        source: parent.source,
        recordSha256: parent.observation.recordSha256,
        dependencyEdgeIndexes: dependencies,
        checks,
      });
    }
  }
  const usage = meter.result();
  return structuredClone({
    parents,
    unavailableParents,
    inspectionUsage: { references: usage.references.length, referenceBytes: usage.referenceBytes },
  });
}
