import {
  type ReplayPlan,
  type ReplayPlanDefinition,
  ReplayPlanDefinitionSchema,
  ReplayPlanSchema,
  type TargetRelease,
  type TargetReleaseDefinition,
  TargetReleaseDefinitionSchema,
  TargetReleaseSchema,
} from "@proofstack/contracts";
import { InvalidReplayDefinitionInputError } from "./errors.js";
import {
  digestReplayPlanDefinition,
  digestTargetReleaseDefinition,
  encodeReplayPlanDefinition,
  encodeTargetReleaseDefinition,
} from "./replay-definition-digest.js";

export interface ValidatedTargetRelease {
  readonly definition: TargetReleaseDefinition;
  readonly release: TargetRelease;
}

export interface ValidatedReplayPlan {
  readonly definition: ReplayPlanDefinition;
  readonly plan: ReplayPlan;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (const [index, value] of left.entries()) {
    if (right[index] !== value) return false;
  }
  return true;
}

export function validateAndProjectTargetRelease(input: unknown): ValidatedTargetRelease {
  const parsed = TargetReleaseSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidReplayDefinitionInputError("Target release does not satisfy its contract", {
      cause: parsed.error,
    });
  }
  const {
    createdAt: _createdAt,
    createdByPrincipalId: _createdBy,
    definitionSha256,
    ...fields
  } = parsed.data;
  const definition = TargetReleaseDefinitionSchema.parse(fields);
  if (digestTargetReleaseDefinition(definition) !== definitionSha256) {
    throw new InvalidReplayDefinitionInputError("Target release definition digest does not match");
  }
  return { definition, release: parsed.data };
}

export function validateAndProjectReplayPlan(input: unknown): ValidatedReplayPlan {
  const parsed = ReplayPlanSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidReplayDefinitionInputError("Replay plan does not satisfy its contract", {
      cause: parsed.error,
    });
  }
  const {
    createdAt: _createdAt,
    createdByPrincipalId: _createdBy,
    definitionSha256,
    ...fields
  } = parsed.data;
  const definition = ReplayPlanDefinitionSchema.parse(fields);
  if (digestReplayPlanDefinition(definition) !== definitionSha256) {
    throw new InvalidReplayDefinitionInputError("Replay plan definition digest does not match");
  }
  return { definition, plan: parsed.data };
}

export function areTargetReleaseDefinitionsEqual(
  left: TargetReleaseDefinition,
  right: TargetReleaseDefinition,
): boolean {
  return bytesEqual(encodeTargetReleaseDefinition(left), encodeTargetReleaseDefinition(right));
}

export function areReplayPlanDefinitionsEqual(
  left: ReplayPlanDefinition,
  right: ReplayPlanDefinition,
): boolean {
  return bytesEqual(encodeReplayPlanDefinition(left), encodeReplayPlanDefinition(right));
}
