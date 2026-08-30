import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  type PrincipalContext,
  PrincipalContextSchema,
  type ReplayPlan,
  type TargetRelease,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "@proofstack/core";
import { InvalidReplayDefinitionInputError, ReplayDefinitionNotFoundError } from "./errors.js";
import {
  validatedStoredReplayPlan,
  validatedStoredTargetRelease,
} from "./replay-definition-validation.js";
import type { ReplayDefinitionRepository } from "./replay-definition-repository.js";

interface ReplayDefinitionReadRoute {
  readonly environmentId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
}

export interface ReadTargetReleaseCommand extends ReplayDefinitionReadRoute {
  readonly targetId: string;
  readonly targetReleaseId: string;
}

export interface ReadReplayPlanCommand extends ReplayDefinitionReadRoute {
  readonly planId: string;
  readonly planVersionId: string;
}

function invalidInput(message: string, cause: unknown): InvalidReplayDefinitionInputError {
  return new InvalidReplayDefinitionInputError(message, { cause });
}

function readPrincipal(input: unknown): PrincipalContext {
  try {
    return PrincipalContextSchema.parse(input);
  } catch (cause) {
    throw invalidInput("Replay definition read principal is invalid", cause);
  }
}

function exactScope(
  principal: PrincipalContext,
  projectId: unknown,
  environmentId: unknown,
): ReturnType<typeof EvidenceScopeSchema.parse> {
  const parsed = EvidenceScopeSchema.safeParse({
    environmentId,
    projectId,
    tenantId: principal.tenantId,
  });
  if (!parsed.success) throw invalidInput("Replay definition read scope is invalid", parsed.error);
  return parsed.data;
}

function readIdentifier(input: unknown, field: string): string {
  const parsed = OpaqueIdSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput(`Replay definition read ${field} is invalid`, parsed.error);
  }
  return parsed.data;
}

function authorizedScope(command: ReplayDefinitionReadRoute): {
  readonly scope: ReturnType<typeof EvidenceScopeSchema.parse>;
} {
  const principal = readPrincipal(command.principal);
  requireCapability(principal, "replay:read");
  const projectId = command.projectId;
  const environmentId = command.environmentId;
  requireEnvironmentAccess(principal, projectId, environmentId);
  return { scope: exactScope(principal, projectId, environmentId) };
}

/** Reads one exact immutable target release without revealing another target or scope. */
export class ReadTargetRelease {
  constructor(private readonly repository: ReplayDefinitionRepository) {}

  async execute(command: ReadTargetReleaseCommand): Promise<TargetRelease> {
    const { scope } = authorizedScope(command);
    const targetId = readIdentifier(command.targetId, "targetId");
    const targetReleaseId = readIdentifier(command.targetReleaseId, "targetReleaseId");
    const stored = await this.repository.findTargetRelease(structuredClone(scope), targetReleaseId);
    if (stored === null) throw new ReplayDefinitionNotFoundError();
    const release = validatedStoredTargetRelease(stored, scope, targetReleaseId).release;
    if (release.targetId !== targetId) throw new ReplayDefinitionNotFoundError();
    return structuredClone(release);
  }
}

/** Reads one exact immutable replay plan without revealing another plan or scope. */
export class ReadReplayPlan {
  constructor(private readonly repository: ReplayDefinitionRepository) {}

  async execute(command: ReadReplayPlanCommand): Promise<ReplayPlan> {
    const { scope } = authorizedScope(command);
    const planId = readIdentifier(command.planId, "planId");
    const planVersionId = readIdentifier(command.planVersionId, "planVersionId");
    const stored = await this.repository.findReplayPlan(structuredClone(scope), planVersionId);
    if (stored === null) throw new ReplayDefinitionNotFoundError();
    const plan = validatedStoredReplayPlan(stored, scope, planVersionId).plan;
    if (plan.planId !== planId) throw new ReplayDefinitionNotFoundError();
    return structuredClone(plan);
  }
}
