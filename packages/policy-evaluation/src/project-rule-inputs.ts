import {
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationRuleProjection,
  PolicyEvaluationSnapshotRuleInputsSchema,
  type PolicyEvaluationSnapshotRuleInputs,
  type PolicyEvaluationSourceReference,
} from "@proofstack/contracts";
import {
  PolicyEvaluationEvidenceReferenceError,
  type PolicyEvaluationEvidenceReferenceLimits,
} from "@proofstack/core";
import { PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyArtifactCapture } from "./capture-artifact-evidence.js";
import type { PolicyArtifactRuleBindings } from "./capture-artifact-rules.js";
import type { PolicyAssessmentRuleInputs } from "./capture-assessment-rules.js";
import type { PolicyComparisonEvidenceCapture } from "./capture-comparison-evidence.js";
import type { PolicyComparisonRuleBindings } from "./capture-comparison-rules.js";
import type { PolicyRuleInputs } from "./capture-rule-inputs.js";

export interface PolicySnapshotRuleInputs {
  readonly inputs: PolicyEvaluationSnapshotRuleInputs;
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
}

type Input = PolicyEvaluationRuleProjection["input"];
type AssessmentInput = Extract<Input, { kind: "assessment" }>;
type RetainedOperand = Extract<
  AssessmentInput["binding"],
  { status: "inputs_retained" }
>["operand"];

function conflict(): never {
  throw new PolicyRecordGraphError("observation_conflict");
}

/** Internal projection of freshly reproduced owning reports; no new read, verdict or seal. */
export function projectCapturedRuleInputs(
  capture: PolicyComparisonEvidenceCapture,
  artifacts: readonly PolicyArtifactCapture[],
  reports: {
    readonly ruleInputs: PolicyRuleInputs;
    readonly artifactRules: PolicyArtifactRuleBindings;
    readonly assessmentRules: PolicyAssessmentRuleInputs;
    readonly comparisonRules: PolicyComparisonRuleBindings;
  },
  limits: PolicyEvaluationEvidenceReferenceLimits,
): PolicySnapshotRuleInputs {
  const { ruleInputs, artifactRules, assessmentRules, comparisonRules } = reports;
  const context = {
    schemaVersion: "0.1" as const,
    request: ruleInputs.request,
    scope: ruleInputs.scope,
    evaluationTime: ruleInputs.evaluationTime,
    candidate: ruleInputs.candidate,
    policy: ruleInputs.policy,
    ruleCount: ruleInputs.ruleCount,
  };
  let references = 0;
  let referenceBytes = 0;
  const charge = (value: unknown, count: number) => {
    if (count > limits.maxReferences - references)
      throw new PolicyEvaluationEvidenceReferenceError("reference_limit_exceeded");
    const bytes = encodeEvaluationCanonicalJson(value).byteLength;
    if (bytes > limits.maxReferenceBytes - referenceBytes)
      throw new PolicyEvaluationEvidenceReferenceError("reference_bytes_exceeded");
    references += count;
    referenceBytes += bytes;
  };
  charge(context, 1);
  const rules: PolicyEvaluationRuleProjection[] = [];
  for (const original of ruleInputs.rules) {
    const binding = original.binding;
    let input: Input;
    let count = 1;
    if (binding.kind === "approval") {
      input = { kind: "approval", status: "not_evaluated", reason: "approval_not_evaluated" };
    } else if (binding.kind === "comparison") {
      const frame = comparisonRules.rules[binding.inputIndex];
      if (!frame || capture.status !== "inventory_captured") conflict();
      const comparison = capture.comparisons[frame.comparisonIndex];
      if (!comparison) conflict();
      if (frame.binding.status !== "metric_bound") {
        input = { kind: "comparison", selection: comparison.selection, binding: frame.binding };
      } else {
        if (comparison.status !== "lineage_verified") conflict();
        const { recordHashes, compatibility: _compatibility, ...metric } = frame.binding.metric;
        const witness = (source: PolicyEvaluationSourceReference, recordSha256: string) => ({
          source,
          recordSha256,
        });
        const { baselineSnapshot, candidateSnapshot } = comparison.lineage;
        input = {
          kind: "comparison",
          selection: comparison.selection,
          binding: {
            status: "metric_bound",
            metric: {
              ...metric,
              witnesses: {
                comparison: witness(
                  { kind: "comparison_definition", reference: comparison.selection.comparison },
                  recordHashes.comparison,
                ),
                result: witness(
                  { kind: "comparison_result", reference: comparison.selection.result },
                  recordHashes.result,
                ),
                baselineSnapshot: witness(
                  {
                    kind: "comparison_snapshot",
                    reference: {
                      role: "baseline",
                      snapshotId: baselineSnapshot.snapshotId,
                      definitionSha256: baselineSnapshot.definitionSha256,
                    },
                  },
                  recordHashes.baselineSnapshot,
                ),
                candidateSnapshot: witness(
                  {
                    kind: "comparison_snapshot",
                    reference: {
                      role: "candidate",
                      snapshotId: candidateSnapshot.snapshotId,
                      definitionSha256: candidateSnapshot.definitionSha256,
                    },
                  },
                  recordHashes.candidateSnapshot,
                ),
              },
            },
          },
        };
        count += 4;
      }
    } else if (binding.kind === "assessment") {
      const frame = assessmentRules.rules[binding.inputIndex];
      if (!frame) conflict();
      if (frame.binding.status !== "inputs_retained") {
        input = { kind: "assessment", source: frame.source, binding: frame.binding };
      } else {
        const captured = frame.binding;
        const originalOperand = captured.operand;
        let operand: RetainedOperand;
        if (
          originalOperand.kind === "evaluation_eligibility" ||
          originalOperand.kind === "model_eligibility"
        ) {
          operand = originalOperand;
        } else {
          const aggregate = originalOperand.aggregate;
          const aggregationPolicy = originalOperand.aggregationPolicy;
          const shared = {
            aggregate:
              aggregate.status === "verified"
                ? {
                    status: "verified" as const,
                    witness: { source: aggregate.source, recordSha256: aggregate.recordSha256 },
                    projection: {
                      counts: aggregate.record.counts,
                      samplingAssumption: aggregate.record.samplingAssumption,
                      passInterval: aggregate.record.passInterval,
                    },
                  }
                : aggregate,
            aggregationPolicy:
              aggregationPolicy.status === "verified"
                ? {
                    status: "verified" as const,
                    witness: {
                      source: aggregationPolicy.source,
                      recordSha256: aggregationPolicy.recordSha256,
                    },
                    projection: { method: aggregationPolicy.record.method },
                  }
                : aggregationPolicy,
          };
          operand =
            originalOperand.kind === "coverage_count"
              ? { ...shared, kind: originalOperand.kind, field: originalOperand.field }
              : { ...shared, kind: originalOperand.kind, field: originalOperand.field };
          count += 2;
        }
        input = {
          kind: "assessment",
          source: frame.source,
          binding: {
            status: "inputs_retained",
            assessment: {
              source: captured.assessment.source,
              recordSha256: captured.assessment.recordSha256,
            },
            operand,
          },
        };
        count++;
      }
    } else {
      const frame = artifactRules.rules[binding.inputIndex];
      if (!frame) conflict();
      if (frame.binding.status === "component_missing") {
        input = { kind: "artifact", binding: { status: "component_missing" } };
      } else {
        const member = artifactRules.members[frame.binding.memberIndex];
        if (!member) conflict();
        if (member.status === "model_alias") {
          input = { kind: "artifact", binding: { status: "model_alias" } };
        } else {
          const read = artifacts[member.artifactCaptureIndex]?.read;
          if (!read) conflict();
          input = {
            kind: "artifact",
            binding: {
              status: "artifact_declared",
              reference: member.reference,
              catalog:
                read.catalog === null
                  ? null
                  : { recordSha256: read.catalog.recordSha256, ownership: read.catalog.ownership },
              observation: read.observation,
            },
          };
          count++;
        }
      }
    }
    const frame = { ruleIndex: original.ruleIndex, rule: original.rule, input };
    charge(frame, count);
    rules.push(frame);
  }
  const parsed = PolicyEvaluationSnapshotRuleInputsSchema.safeParse({ ...context, rules });
  if (!parsed.success) conflict();
  return { inputs: parsed.data, inspectionUsage: { references, referenceBytes } };
}
