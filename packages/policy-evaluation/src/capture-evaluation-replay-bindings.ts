import {
  type EvaluationRun,
  type PolicyEvaluationSourceReference,
  type ReplayPlan,
  encodeEvaluationCanonicalJson,
  policyEvaluationSourceReferenceKey,
  policyEvaluationTimestampOrderKey,
} from "@proofstack/contracts";
import {
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
} from "@proofstack/core";
import { PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";
import type { PolicyRecordRead } from "./record-routing.js";

type Source = PolicyEvaluationSourceReference;
type RunSource = Extract<Source, { kind: "evaluation_run" }>;
type Status = "matched" | "mismatch" | "unavailable";

export interface PolicyEvaluationReplayCheck {
  readonly kind:
    | "plan_dataset"
    | "plan_target"
    | "plan_receipt"
    | "plan_prerequisites"
    | "result_history";
  /** JSON pointer in the retained evaluation run. */
  readonly path: string;
  readonly observation: { readonly status: Status };
}

export interface PolicyEvaluationReplayBindings {
  readonly parents: readonly {
    readonly source: RunSource;
    readonly recordSha256: string;
    /** Original run and plan edges, repeated when a plan is shared by several runs. */
    readonly dependencyEdgeIndexes: readonly number[];
    readonly checks: readonly PolicyEvaluationReplayCheck[];
  }[];
  readonly unavailableParents: readonly {
    readonly source: RunSource;
    readonly observation: Exclude<PolicyRecordRead["observation"], { status: "verified" }>;
  }[];
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
}

function same(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}

function combined(statuses: readonly string[]): Status {
  return statuses.includes("mismatch")
    ? "mismatch"
    : statuses.some((status) => status !== "matched" && status !== "verified")
      ? "unavailable"
      : "matched";
}

/** Fixed internal composition: retained relationships, never replay execution or sealing. */
export function inspectCapturedEvaluationReplayBindings(
  graph: Pick<PolicyRecordGraph, "nodes" | "edges" | "replayPlans" | "replayResults">,
  limits: PolicyEvaluationEvidenceReferenceLimits,
): PolicyEvaluationReplayBindings {
  const meter = new PolicyEvaluationReferenceCollector(limits);
  const nodes = new Map(
    graph.nodes.map(({ read }) => [policyEvaluationSourceReferenceKey(read.source), read]),
  );
  const edgeKey = (source: Source, path: string) =>
    JSON.stringify([policyEvaluationSourceReferenceKey(source), path]);
  const edges = new Map<string, number>();
  graph.edges.forEach((edge, index) => {
    const key = edgeKey(edge.parent, edge.reference.path);
    if (edges.has(key)) throw new PolicyRecordGraphError("reference_conflict", key);
    edges.set(key, index);
  });
  const plans = new Map(
    graph.replayPlans.plans.map((report) => [
      policyEvaluationSourceReferenceKey(report.source),
      {
        report,
        status: combined([
          ...report.checks.map((check) => check.observation.status),
          ...report.dependencies.map((dependency) => dependency.recordObservation.status),
        ]),
      },
    ]),
  );
  const results = new Map(
    graph.replayResults.results.map((report) => [
      policyEvaluationSourceReferenceKey(report.source),
      { report, status: combined(report.checks.map((check) => check.observation.status)) },
    ]),
  );
  const parents: PolicyEvaluationReplayBindings["parents"][number][] = [];
  const unavailableParents: PolicyEvaluationReplayBindings["unavailableParents"][number][] = [];
  const ordered = [...nodes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [, parent] of ordered) {
    if (parent.source.kind !== "evaluation_run") continue;
    if (parent.observation.status !== "verified") {
      unavailableParents.push({ source: parent.source, observation: parent.observation });
      continue;
    }
    const run = parent.record as EvaluationRun;
    const indexes: number[] = [];
    const dependency = (
      owner: PolicyRecordRead,
      path: string,
      source: Source,
    ): PolicyRecordRead => {
      const key = edgeKey(owner.source, path);
      const index = edges.get(key);
      const edge = index === undefined ? undefined : graph.edges[index];
      const child = nodes.get(policyEvaluationSourceReferenceKey(source));
      if (
        index === undefined ||
        !edge ||
        owner.observation.status !== "verified" ||
        edge.parentRecordSha256 !== owner.observation.recordSha256 ||
        !same(edge.parent, owner.source) ||
        edge.reference.kind !== "record" ||
        !same(edge.reference.source, source) ||
        !same(edge.target, source) ||
        edge.selectorFailure !== undefined ||
        !child ||
        !same(child.source, source)
      )
        throw new PolicyRecordGraphError("reference_conflict", key);
      meter.record(path, source.kind, source.reference);
      indexes.push(index);
      return child;
    };
    const checks: PolicyEvaluationReplayCheck[] = [];
    const check = (kind: PolicyEvaluationReplayCheck["kind"], path: string, status: Status) => {
      checks.push({ kind, path, observation: { status } });
    };
    const planRead = dependency(parent, "/replay/plan", {
      kind: "replay_plan",
      reference: run.replay.plan,
    });
    const resultRead = dependency(parent, "/replay", {
      kind: "replay_result",
      reference: run.replay,
    });
    dependency(parent, "/dataset", { kind: "dataset_version", reference: run.dataset });
    dependency(parent, "/replay/targetRelease", {
      kind: "target_release",
      reference: run.replay.targetRelease,
    });
    const plan =
      planRead.observation.status === "verified" ? (planRead.record as ReplayPlan) : null;
    if (plan) {
      dependency(planRead, "/dataset", { kind: "dataset_version", reference: plan.dataset });
      dependency(planRead, "/targetRelease", {
        kind: "target_release",
        reference: plan.targetRelease,
      });
    }
    check(
      "plan_dataset",
      "/dataset",
      !plan ? "unavailable" : same(plan.dataset, run.dataset) ? "matched" : "mismatch",
    );
    check(
      "plan_target",
      "/replay/targetRelease",
      !plan
        ? "unavailable"
        : same(plan.targetRelease, run.replay.targetRelease)
          ? "matched"
          : "mismatch",
    );
    check(
      "plan_receipt",
      "/replay/completedAt",
      !plan
        ? "unavailable"
        : policyEvaluationTimestampOrderKey(plan.createdAt) <=
            policyEvaluationTimestampOrderKey(run.replay.completedAt)
          ? "matched"
          : "mismatch",
    );
    const planReport = plans.get(policyEvaluationSourceReferenceKey(planRead.source));
    if (
      planRead.observation.status === "verified" &&
      (!planReport ||
        !same(planReport.report.source, planRead.source) ||
        planReport.report.recordSha256 !== planRead.observation.recordSha256 ||
        planReport.report.checks.length === 0)
    )
      throw new PolicyRecordGraphError(
        "reference_conflict",
        policyEvaluationSourceReferenceKey(planRead.source),
      );
    check(
      "plan_prerequisites",
      "/replay/plan",
      planRead.observation.status === "verified"
        ? (planReport as NonNullable<typeof planReport>).status
        : "unavailable",
    );
    const resultReport = results.get(policyEvaluationSourceReferenceKey(resultRead.source));
    if (
      resultRead.observation.status === "verified" &&
      (!resultReport ||
        !same(resultReport.report.source, resultRead.source) ||
        resultReport.report.recordSha256 !== resultRead.observation.recordSha256 ||
        resultReport.report.checks.length === 0 ||
        !same(resultReport.report.plan.source, planRead.source) ||
        !same(resultReport.report.plan.recordObservation, planRead.observation))
    )
      throw new PolicyRecordGraphError(
        "reference_conflict",
        policyEvaluationSourceReferenceKey(resultRead.source),
      );
    check(
      "result_history",
      "/replay",
      resultRead.observation.status === "verified"
        ? (resultReport as NonNullable<typeof resultReport>).status
        : "unavailable",
    );
    parents.push({
      source: parent.source,
      recordSha256: parent.observation.recordSha256,
      dependencyEdgeIndexes: indexes,
      checks,
    });
  }
  const usage = meter.result();
  return structuredClone({
    parents,
    unavailableParents,
    inspectionUsage: {
      references: usage.references.length,
      referenceBytes: usage.referenceBytes,
    },
  });
}
