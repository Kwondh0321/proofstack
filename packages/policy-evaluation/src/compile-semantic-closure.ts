import {
  PolicyEvaluationSnapshotClosureSchema,
  policyEvaluationSourceReferenceKey,
  serializeEvaluationCanonicalJson,
  type PolicyEvaluationSemanticCheck,
  type PolicyEvaluationSnapshotClosure,
  type PolicyEvaluationSourceReference,
} from "@proofstack/contracts";
import type { AcquisitionBudget } from "./acquisition-budget.js";
import { PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyArtifactEvidenceCapture } from "./capture-artifact-evidence.js";
import type { PolicyPreparedSnapshotInputs } from "./prepare-snapshot-inputs.js";

type Capture = Extract<PolicyArtifactEvidenceCapture, { status: "artifacts_captured" }>;
type Source = PolicyEvaluationSourceReference;
type Check = {
  readonly kind: PolicyEvaluationSemanticCheck["kind"];
  readonly path: string;
  readonly observation: {
    readonly status: "matched" | "mismatch" | "unavailable";
    readonly reason?: string;
    readonly reasons?: readonly string[];
  };
  readonly source?: Source;
};
type Parent = { readonly source: Source; readonly recordSha256: string };

/** Fixed compilation of freshly owning-validated reports. Stored findings never qualify operands. */
export function compileCapturedSemanticClosure(
  capture: Capture,
  prepared: PolicyPreparedSnapshotInputs,
  budget: AcquisitionBudget,
): PolicyEvaluationSnapshotClosure {
  if (capture.traceCapture.status !== "traces_captured")
    throw new PolicyRecordGraphError("observation_conflict");
  const graph = capture.traceCapture.comparisonCapture.graph;
  const records = prepared.sources.records.records;
  const indices = new Map(
    records.map(({ entry }, index) => [policyEvaluationSourceReferenceKey(entry.source), index]),
  );
  const indexOf = (source: Source) => {
    const index = indices.get(policyEvaluationSourceReferenceKey(source));
    if (
      index === undefined ||
      serializeEvaluationCanonicalJson(records[index]!.entry.source) !==
        serializeEvaluationCanonicalJson(source)
    )
      throw new PolicyRecordGraphError("observation_conflict", "closure_source");
    return index;
  };
  const checks: PolicyEvaluationSemanticCheck[] = [];
  const add = (
    context: "semantic" | "stored",
    domain: PolicyEvaluationSemanticCheck["domain"],
    reportIndex: number,
    parent: Parent,
    values: readonly Check[],
    dataset = false,
  ) => {
    if (records[indexOf(parent.source)]!.storage?.recordSha256 !== parent.recordSha256)
      throw new PolicyRecordGraphError("observation_conflict", "closure_parent");
    for (const [checkIndex, check] of values.entries()) {
      const owner = dataset ? parent.source : (check.source ?? parent.source);
      indexOf(owner);
      const relatedSource = dataset ? (check.source ?? null) : null;
      if (relatedSource) indexOf(relatedSource);
      const value: PolicyEvaluationSemanticCheck = {
        context,
        domain,
        reportIndex,
        checkIndex,
        parent: parent.source,
        parentRecordSha256: parent.recordSha256,
        owner,
        path: check.path,
        kind: check.kind,
        status: check.observation.status,
        reasons: [
          ...(check.observation.reasons ??
            (check.observation.reason ? [check.observation.reason] : [])),
        ],
        relatedSource,
      };
      budget.addReferences(
        1 + value.reasons.length,
        Buffer.byteLength(serializeEvaluationCanonicalJson(value), "utf8"),
      );
      checks.push(value);
    }
  };
  const unavailable = (
    context: "semantic" | "stored",
    domain: PolicyEvaluationSemanticCheck["domain"],
    offset: number,
    values: readonly {
      readonly source: Source;
      readonly observation: { readonly status: string; readonly reason?: string };
    }[],
  ) => {
    values.forEach(({ source, observation }, index) => {
      const original = records[indexOf(source)]!;
      const value: PolicyEvaluationSemanticCheck = {
        context,
        domain,
        reportIndex: offset + index,
        checkIndex: 0,
        parent: source,
        parentRecordSha256: original.storage?.recordSha256 ?? null,
        owner: source,
        path: "",
        kind: "parent_unavailable",
        status: "unavailable",
        reasons: observation.reason ? [observation.reason] : [],
        relatedSource: null,
      };
      budget.addReferences(
        1 + value.reasons.length,
        Buffer.byteLength(serializeEvaluationCanonicalJson(value), "utf8"),
      );
      checks.push(value);
    });
  };
  const parents = (
    context: "semantic" | "stored",
    domain: PolicyEvaluationSemanticCheck["domain"],
    report: {
      readonly parents: readonly (Parent & { readonly checks: readonly Check[] })[];
      readonly unavailableParents: readonly {
        readonly source: Source;
        readonly observation: { readonly status: string; readonly reason?: string };
      }[];
    },
  ) => {
    report.parents.forEach((parent, index) => {
      add(context, domain, index, parent, parent.checks);
    });
    unavailable(context, domain, report.parents.length, report.unavailableParents);
  };
  for (const [context, report] of [
    ["semantic", graph.datasetRelations],
    ["stored", graph.storedRelationships.datasets],
  ] as const) {
    report.parents.forEach((parent, index) => {
      add(context, "dataset", index, parent, parent.relations, true);
    });
    unavailable(context, "dataset", report.parents.length, report.unavailableParents);
  }
  for (const [context, report] of [
    ["semantic", graph.replayPlans],
    ["stored", graph.storedRelationships.replayPlans],
  ] as const) {
    report.plans.forEach((parent, index) => {
      add(context, "replay_plan", index, parent, parent.checks);
    });
    unavailable(context, "replay_plan", report.plans.length, report.unavailablePlans);
  }
  graph.replayResults.results.forEach((parent, index) => {
    add("semantic", "replay_result", index, parent, parent.checks);
  });
  unavailable(
    "semantic",
    "replay_result",
    graph.replayResults.results.length,
    graph.replayResults.unavailableResults,
  );
  graph.storedRelationships.replayResults.forEach((parent, index) => {
    add("stored", "replay_result", index, parent, parent.checks);
  });
  // Stored unavailable result origins retain their original nodes rather than invented bodies.
  unavailable(
    "stored",
    "replay_result",
    graph.storedRelationships.replayResults.length,
    graph.storedRelationships.unavailableResults,
  );
  parents("semantic", "evaluation_snapshot", graph.evaluationSnapshots);
  parents("stored", "evaluation_snapshot", graph.storedRelationships.evaluationSnapshots);
  parents("semantic", "evaluation_replay", graph.evaluationReplays);
  parents("stored", "evaluation_replay", graph.storedRelationships.evaluationReplays);
  parents("semantic", "model_assurance", graph.modelAssurance);
  parents("stored", "model_assurance", graph.storedRelationships.modelAssurance);
  const lineage = graph.candidateAssessmentLineage;
  if (lineage.status === "inspected") {
    lineage.members.forEach((member, index) => {
      if (member.observation.status === "verified")
        add(
          "semantic",
          "candidate_assessment",
          index,
          { source: member.source, recordSha256: member.observation.recordSha256 },
          member.checks,
        );
      else unavailable("semantic", "candidate_assessment", index, [member]);
    });
  } else unavailable("semantic", "candidate_assessment", 0, [lineage]);
  const dependencies = capture.ruleDependencies;
  const coordinates = (value: typeof dependencies.rootContext) => {
    const sourceIndexes = value.sourceIndexes
      .map((index) => {
        const original = dependencies.sources[index];
        if (!original)
          throw new PolicyRecordGraphError("observation_conflict", "closure_coordinate");
        return indexOf(original.source);
      })
      .sort((a, b) => a - b);
    const own = new Set(sourceIndexes);
    const checkIndexes = checks.flatMap((check, index) =>
      check.context === "semantic" &&
      own.has(indexOf(check.parent)) &&
      own.has(indexOf(check.owner))
        ? [index]
        : [],
    );
    const frontierEdgeIndexes = value.frontierIndexes.map((index) => {
      const original = dependencies.frontier[index];
      if (!original) throw new PolicyRecordGraphError("observation_conflict", "closure_frontier");
      return original.edgeIndex;
    });
    return {
      sourceIndexes,
      edgeIndexes: [...value.edgeIndexes],
      frontierEdgeIndexes,
      checkIndexes,
    };
  };
  const material = {
    schemaVersion: "0.1" as const,
    checks,
    rootContext: coordinates(dependencies.rootContext),
    rules: dependencies.rules.map((rule) => ({
      ruleIndex: rule.ruleIndex,
      ruleId: rule.ruleId,
      ...coordinates(rule),
    })),
  };
  budget.addReferences(
    1 +
      material.rules.length +
      [material.rootContext, ...material.rules].reduce(
        (sum, row) =>
          sum +
          row.sourceIndexes.length +
          row.edgeIndexes.length +
          row.frontierEdgeIndexes.length +
          row.checkIndexes.length,
        0,
      ),
    Buffer.byteLength(serializeEvaluationCanonicalJson(material), "utf8"),
  );
  return PolicyEvaluationSnapshotClosureSchema.parse(material);
}
