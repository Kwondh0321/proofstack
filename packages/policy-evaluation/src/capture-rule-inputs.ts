import {
  encodeEvaluationCanonicalJson,
  type PolicyEvaluationRequest,
  type ReleasePolicy,
} from "@proofstack/contracts";
import {
  PolicyEvaluationEvidenceReferenceError,
  type PolicyEvaluationEvidenceReferenceLimits,
  policyEvaluationRequestReference,
  validatePolicyEvaluationRequestRecord,
} from "@proofstack/core";
import { PolicyRecordGraphError } from "./acquisition-budget.js";
import type { PolicyArtifactCapture } from "./capture-artifact-evidence.js";
import { inspectCapturedArtifactRules } from "./capture-artifact-rules.js";
import { inspectCapturedAssessmentRules } from "./capture-assessment-rules.js";
import type { PolicyComparisonEvidenceCapture } from "./capture-comparison-evidence.js";
import { inspectCapturedComparisonRules } from "./capture-comparison-rules.js";

type Rule = ReleasePolicy["rules"][number];
type Approval = Extract<Rule["predicate"], { kind: "approval_required" }>;
type Family = "artifact" | "comparison" | "assessment";

export interface PolicyRuleInputs {
  readonly authorityBoundary: "retained_inputs_only";
  readonly request: ReturnType<typeof policyEvaluationRequestReference>;
  readonly scope: PolicyEvaluationRequest["scope"];
  readonly evaluationTime: string;
  readonly candidate: ReturnType<typeof inspectCapturedArtifactRules>["candidate"];
  readonly policy: ReturnType<typeof inspectCapturedArtifactRules>["policy"];
  readonly ruleCount: number;
  /** Exactly one full original rule in policy order, including repeated prerequisites. */
  readonly rules: readonly {
    readonly ruleIndex: number;
    readonly rule: Rule;
    readonly binding:
      | { readonly kind: Family; readonly inputIndex: number }
      | {
          readonly kind: "approval";
          readonly status: "not_evaluated";
          readonly reason: "approval_not_evaluated";
          readonly declaration: Approval;
        };
  }[];
  /** Additional whole-rule admission; family reports retain their separate original usage. */
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
}

function same(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}
function conflict(): never {
  throw new PolicyRecordGraphError("observation_conflict");
}

/** Fixed internal composition. No supplied report/validator, additional I/O, outcome or seal. */
export function inspectCapturedRuleInputs(
  input: PolicyEvaluationRequest,
  capture: PolicyComparisonEvidenceCapture,
  artifacts: readonly PolicyArtifactCapture[],
  limits: PolicyEvaluationEvidenceReferenceLimits,
) {
  const request = validatePolicyEvaluationRequestRecord(input);
  const owned = structuredClone({ capture, artifacts });
  // Owning validators reproduce all original families exactly once on this owned capture.
  const artifactRules = inspectCapturedArtifactRules(
    request,
    owned.capture.graph,
    owned.artifacts,
    limits,
  );
  const comparisonRules = inspectCapturedComparisonRules(request, owned.capture, limits);
  const assessmentRules = inspectCapturedAssessmentRules(request, owned.capture.graph, limits);
  for (const report of [comparisonRules, assessmentRules])
    if (
      !same(report.candidate, artifactRules.candidate) ||
      !same(report.policy, artifactRules.policy)
    )
      conflict();
  const root = owned.capture.graph.nodes.find(({ read }) =>
    same(read.source, artifactRules.policy.source),
  )?.read;
  if (root?.observation.status !== "verified" || root.record === null) conflict();
  const policy = root.record as ReleasePolicy;
  let references = 0;
  let referenceBytes = 0;
  const charge = (count: number, bytes: number) => {
    if (count > limits.maxReferences - references)
      throw new PolicyEvaluationEvidenceReferenceError("reference_limit_exceeded");
    if (bytes > limits.maxReferenceBytes - referenceBytes)
      throw new PolicyEvaluationEvidenceReferenceError("reference_bytes_exceeded");
    references += count;
    referenceBytes += bytes;
  };
  for (const report of [artifactRules, comparisonRules, assessmentRules])
    charge(report.inspectionUsage.references, report.inspectionUsage.referenceBytes);
  const familyReferences = references;
  const familyBytes = referenceBytes;
  const context = {
    authorityBoundary: "retained_inputs_only" as const,
    request: policyEvaluationRequestReference(request),
    scope: request.scope,
    evaluationTime: request.evaluationTime,
    candidate: artifactRules.candidate,
    policy: artifactRules.policy,
    ruleCount: policy.rules.length,
  };
  charge(1, encodeEvaluationCanonicalJson(context).byteLength);
  const inputs = new Map<number, { kind: Family; inputIndex: number }>();
  const add = (
    kind: Family,
    rules: readonly {
      readonly ruleIndex: number;
      readonly ruleId: string;
      readonly predicate: Rule["predicate"];
    }[],
  ) => {
    rules.forEach((entry, inputIndex) => {
      const original = policy.rules[entry.ruleIndex];
      if (
        !original ||
        original.ruleId !== entry.ruleId ||
        !same(original.predicate, entry.predicate) ||
        inputs.has(entry.ruleIndex)
      )
        conflict();
      inputs.set(entry.ruleIndex, { kind, inputIndex });
    });
  };
  add("artifact", artifactRules.rules);
  add("comparison", comparisonRules.rules);
  add("assessment", assessmentRules.rules);
  const rules: PolicyRuleInputs["rules"][number][] = [];
  for (const [ruleIndex, rule] of policy.rules.entries()) {
    const predicate = rule.predicate;
    let binding: PolicyRuleInputs["rules"][number]["binding"];
    if (predicate.kind === "approval_required") {
      if (inputs.has(ruleIndex)) conflict();
      binding = {
        kind: "approval",
        status: "not_evaluated",
        reason: "approval_not_evaluated",
        declaration: predicate,
      };
    } else {
      const family: Family =
        predicate.kind === "artifact_required"
          ? "artifact"
          : predicate.kind === "comparison_threshold" ||
              predicate.kind === "safety_event_ceiling" ||
              (predicate.kind === "coverage_floor" && predicate.sourceKind !== "assessment_samples")
            ? "comparison"
            : "assessment";
      const found = inputs.get(ruleIndex);
      if (!found || found.kind !== family) conflict();
      binding = found;
      inputs.delete(ruleIndex);
    }
    const frame = { ruleIndex, rule, binding };
    charge(1, encodeEvaluationCanonicalJson(frame).byteLength);
    rules.push(frame);
  }
  if (inputs.size !== 0) conflict();
  const ruleInputs: PolicyRuleInputs = {
    ...context,
    rules,
    inspectionUsage: {
      references: references - familyReferences,
      referenceBytes: referenceBytes - familyBytes,
    },
  };
  return structuredClone({ artifactRules, comparisonRules, assessmentRules, ruleInputs });
}
