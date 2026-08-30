import type { ReplayPlan, TargetRelease } from "@proofstack/contracts";
import { ReplayRepositoryContractError } from "./errors.js";
import {
  validateAndProjectReplayPlan,
  validateAndProjectTargetRelease,
  type ValidatedReplayPlan,
  type ValidatedTargetRelease,
} from "./replay-definition.js";

export function replayScopesEqual(
  left: TargetRelease["scope"],
  right: TargetRelease["scope"],
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

export function validatedStoredTargetRelease(
  input: unknown,
  scope: TargetRelease["scope"],
  targetReleaseId: string,
): ValidatedTargetRelease {
  let validated: ValidatedTargetRelease;
  try {
    validated = validateAndProjectTargetRelease(input);
  } catch (cause) {
    throw new ReplayRepositoryContractError(
      "The replay repository returned an invalid target release",
      { cause },
    );
  }
  if (
    validated.release.targetReleaseId !== targetReleaseId ||
    !replayScopesEqual(validated.release.scope, scope)
  ) {
    throw new ReplayRepositoryContractError(
      "The replay repository substituted a target release outside the exact query",
    );
  }
  return validated;
}

export function validatedStoredReplayPlan(
  input: unknown,
  scope: ReplayPlan["scope"],
  planVersionId: string,
): ValidatedReplayPlan {
  let validated: ValidatedReplayPlan;
  try {
    validated = validateAndProjectReplayPlan(input);
  } catch (cause) {
    throw new ReplayRepositoryContractError("The replay repository returned an invalid plan", {
      cause,
    });
  }
  if (
    validated.plan.planVersionId !== planVersionId ||
    !replayScopesEqual(validated.plan.scope, scope)
  ) {
    throw new ReplayRepositoryContractError(
      "The replay repository substituted a plan outside the exact query",
    );
  }
  return validated;
}
