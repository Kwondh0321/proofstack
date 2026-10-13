import {
  type PolicyEvaluationManifestPageSet,
  type PolicyEvaluationRequest,
  type PolicyEvaluationSnapshotRuleInputs,
  type PolicyEvaluationSnapshotSourceInputs,
  type PolicyEvaluationSourceReference,
  POLICY_EVALUATION_MANIFEST_PAGE_SIZE,
  PolicyEvaluationSnapshotSourceInputsSchema,
  policyEvaluationSourceReferenceKey,
  serializeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import {
  assemblePolicyEvaluationManifest,
  validatePolicyEvaluationSnapshotSources,
} from "@proofstack/core";
import { type AcquisitionBudget, PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyRecordGraph } from "./capture-record-graph.js";
import { derivePolicyInputRecordSources } from "./derive-input-record-sources.js";

export interface PolicyPreparedSnapshotInputs {
  readonly sources: PolicyEvaluationSnapshotSourceInputs;
  readonly manifest: PolicyEvaluationManifestPageSet;
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
}

function conflict(): never {
  throw new PolicyRecordGraphError("observation_conflict");
}
function same(left: unknown, right: unknown) {
  return serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
}

/** Fixed internal join on already owning-validated inputs, with no second capture or new I/O. */
export function prepareCapturedSnapshotInputs(
  request: PolicyEvaluationRequest,
  graph: PolicyRecordGraph,
  rules: PolicyEvaluationSnapshotRuleInputs,
  manifestId: string,
  budget: AcquisitionBudget,
): PolicyPreparedSnapshotInputs {
  const before = budget.usage();
  const records = derivePolicyInputRecordSources(request, graph, budget);
  if (
    !same(rules.request, records.request) ||
    !same(rules.scope, records.scope) ||
    rules.evaluationTime !== records.evaluationTime
  )
    conflict();
  const witnesses = new Map(
    records.records.map(({ entry }) => [policyEvaluationSourceReferenceKey(entry.source), entry]),
  );
  const entry = (source: PolicyEvaluationSourceReference) => {
    budget.addReferences(1, 0);
    const retained = witnesses.get(policyEvaluationSourceReferenceKey(source));
    if (!retained || !same(retained.source, source)) conflict();
    budget.addReferences(0, Buffer.byteLength(serializeEvaluationCanonicalJson(retained), "utf8"));
    return retained;
  };
  const witness = (value: { source: PolicyEvaluationSourceReference; recordSha256: string }) => {
    const retained = entry(value.source);
    if (
      retained.observation.status !== "verified" ||
      retained.observation.recordSha256 !== value.recordSha256
    )
      conflict();
  };
  witness(rules.candidate);
  witness(rules.policy);
  for (const { input } of rules.rules) {
    if (input.kind === "comparison") {
      entry({ kind: "comparison_definition", reference: input.selection.comparison });
      if (input.selection.status === "unique")
        entry({ kind: "comparison_result", reference: input.selection.result });
      if (input.binding.status === "metric_bound")
        for (const value of Object.values(input.binding.metric.witnesses)) witness(value);
    } else if (input.kind === "assessment") {
      const source = input.source;
      if (input.binding.status === "assessment_unavailable") {
        if (!same(entry(source).observation, input.binding.observation)) conflict();
      } else if (input.binding.status === "inputs_retained") {
        witness(input.binding.assessment);
        const operand = input.binding.operand;
        if (operand.kind === "coverage_count" || operand.kind === "uncertainty_interval")
          for (const retained of [operand.aggregate, operand.aggregationPolicy]) {
            if (retained.status === "verified") witness(retained.witness);
            else if (!same(entry(retained.source).observation, retained.observation)) conflict();
          }
      }
    }
  }
  const sourceMaterial = {
    records: {
      schemaVersion: "0.1",
      request: records.request,
      scope: records.scope,
      evaluationTime: records.evaluationTime,
      records: records.records,
    },
    semanticFrontier: records.semanticFrontier,
    storedMappings: records.storedMappings,
    logicalRoots: records.logicalRoots,
  };
  budget.addReferences(
    1 +
      records.records.length +
      records.records.reduce((count, record) => count + record.origins.length, 0) +
      records.semanticFrontier.length +
      records.storedMappings.length +
      records.logicalRoots.mappings.length,
    0,
  );
  budget.addReferences(
    0,
    Buffer.byteLength(serializeEvaluationCanonicalJson(sourceMaterial), "utf8"),
  );
  const sources = PolicyEvaluationSnapshotSourceInputsSchema.parse(sourceMaterial);
  // Charge every manifest entry, page, descriptor and root before assembling/copying pages.
  const pageCount = Math.ceil(records.records.length / POLICY_EVALUATION_MANIFEST_PAGE_SIZE);
  budget.addReferences(1 + records.records.length + 2 * pageCount, 0);
  const manifest = assemblePolicyEvaluationManifest({
    entries: records.records.map(({ entry }) => entry),
    manifestId,
    request: records.request,
    scope: records.scope,
  });
  budget.addReferences(0, Buffer.byteLength(serializeEvaluationCanonicalJson(manifest), "utf8"));
  const joined = validatePolicyEvaluationSnapshotSources({
    expected: {
      request: records.request,
      scope: records.scope,
      evaluationTime: records.evaluationTime,
      manifest: {
        manifestId: manifest.manifest.manifestId,
        definitionSha256: manifest.manifest.definitionSha256,
      },
    },
    sources,
    pageSet: manifest,
  });
  const after = budget.usage();
  return {
    sources: joined,
    manifest,
    inspectionUsage: {
      references: after.references - before.references,
      referenceBytes: after.referenceBytes - before.referenceBytes,
    },
  };
}
