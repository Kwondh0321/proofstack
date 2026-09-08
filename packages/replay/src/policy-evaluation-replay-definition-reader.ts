import type {
  PolicyEvaluationSourceReference,
  ReplayPlan,
  TargetRelease,
} from "@proofstack/contracts";
import {
  type PolicyEvaluationDefinitionRead,
  type PolicyEvaluationDefinitionReadInput,
  readPolicyEvaluationDefinitionRecord,
} from "@proofstack/core";
import { InvalidReplayDefinitionInputError } from "./errors.js";
import {
  validateAndProjectReplayPlan,
  validateAndProjectTargetRelease,
} from "./replay-definition.js";
import type { ReplayDefinitionRepository } from "./replay-definition-repository.js";

export type PolicyEvaluationReplayDefinitionSource = Extract<
  PolicyEvaluationSourceReference,
  { readonly kind: "replay_plan" | "target_release" }
>;
export type PolicyEvaluationReplayDefinitionRead = PolicyEvaluationDefinitionRead<
  ReplayPlan | TargetRelease,
  PolicyEvaluationReplayDefinitionSource
>;

/**
 * Acquires a single exact immutable definition through read-only replay authority. A verified
 * plan/release is not a completed replay, executable-byte verification, runtime registration,
 * recursive lineage, permission to execute a target, or a sealed policy snapshot.
 */
export function readPolicyEvaluationReplayDefinition(
  input: PolicyEvaluationDefinitionReadInput<PolicyEvaluationReplayDefinitionSource>,
  repository: Pick<ReplayDefinitionRepository, "findReplayPlan" | "findTargetRelease">,
): Promise<PolicyEvaluationReplayDefinitionRead> {
  return readPolicyEvaluationDefinitionRecord<
    PolicyEvaluationReplayDefinitionSource,
    ReplayPlan | TargetRelease
  >(input, {
    isInvalidRecordError: (cause) => cause instanceof InvalidReplayDefinitionInputError,
    kinds: ["replay_plan", "target_release"],
    read: (scope, source) =>
      source.kind === "replay_plan"
        ? repository.findReplayPlan(scope, source.reference.planVersionId)
        : repository.findTargetRelease(scope, source.reference.targetReleaseId),
    validate: (source, raw) =>
      source.kind === "replay_plan"
        ? validateAndProjectReplayPlan(raw).plan
        : validateAndProjectTargetRelease(raw).release,
  });
}
