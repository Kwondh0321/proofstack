import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  type PrincipalContext,
  PrincipalContextSchema,
  type ReplayPlan,
  type ReplayPlanDefinition,
  ReplayPlanDefinitionSchema,
  ReplayPlanSchema,
  type TargetRelease,
  type TargetReleaseDefinition,
  TargetReleaseDefinitionSchema,
  TargetReleaseSchema,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";
import { type Clock, requireCapability, requireEnvironmentAccess } from "@proofstack/core";
import {
  InvalidReplayDefinitionInputError,
  ReplayDefinitionConflictError,
  ReplayRepositoryContractError,
} from "./errors.js";
import {
  areReplayPlanDefinitionsEqual,
  areTargetReleaseDefinitionsEqual,
} from "./replay-definition.js";
import {
  digestReplayPlanDefinition,
  digestTargetReleaseDefinition,
} from "./replay-definition-digest.js";
import type { ReplayDefinitionRepository } from "./replay-definition-repository.js";
import {
  replayScopesEqual,
  validatedStoredReplayPlan,
  validatedStoredTargetRelease,
} from "./replay-definition-validation.js";

interface ReplayDefinitionPublicationRoute {
  readonly environmentId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
}

export interface PublishTargetReleaseCommand extends ReplayDefinitionPublicationRoute {
  readonly definition: TargetReleaseDefinition;
  readonly targetId: string;
  readonly targetReleaseId: string;
}

export interface PublishReplayPlanCommand extends ReplayDefinitionPublicationRoute {
  readonly definition: ReplayPlanDefinition;
  readonly planId: string;
  readonly planVersionId: string;
}

export interface PublishTargetReleaseResult {
  readonly created: boolean;
  readonly release: TargetRelease;
}

export interface PublishReplayPlanResult {
  readonly created: boolean;
  readonly plan: ReplayPlan;
}

export interface PublishReplayDefinitionDependencies {
  readonly clock: Clock;
  readonly repository: ReplayDefinitionRepository;
}

function invalidInput(message: string, cause?: unknown): InvalidReplayDefinitionInputError {
  return new InvalidReplayDefinitionInputError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function publicationPrincipal(input: unknown): PrincipalContext {
  try {
    return PrincipalContextSchema.parse(input);
  } catch (cause) {
    throw invalidInput("Replay definition publication principal is invalid", cause);
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
  if (!parsed.success) {
    throw invalidInput("Replay definition publication scope is invalid", parsed.error);
  }
  return parsed.data;
}

function routeIdentifier(input: unknown, field: string): string {
  const parsed = OpaqueIdSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput(`Replay definition publication ${field} is invalid`, parsed.error);
  }
  return parsed.data;
}

function targetDefinition(input: unknown): TargetReleaseDefinition {
  const parsed = TargetReleaseDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput("Target release publication definition is invalid", parsed.error);
  }
  return parsed.data;
}

function planDefinition(input: unknown): ReplayPlanDefinition {
  const parsed = ReplayPlanDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput("Replay plan publication definition is invalid", parsed.error);
  }
  return parsed.data;
}

function publicationTimestamp(clock: Clock): string {
  let timestamp: string;
  try {
    timestamp = clock.now().toISOString();
  } catch (cause) {
    throw invalidInput("Replay definition publication clock is invalid", cause);
  }
  const parsed = UtcMillisecondTimestampSchema.safeParse(timestamp);
  if (!parsed.success) {
    throw invalidInput("Replay definition publication clock is invalid", parsed.error);
  }
  return parsed.data;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resultFields(input: unknown): { readonly created: boolean; readonly definition: unknown } {
  if (typeof input !== "object" || input === null) {
    throw new ReplayRepositoryContractError(
      "Replay definition publication result violates the repository contract",
    );
  }
  let keys: readonly PropertyKey[];
  let created: unknown;
  let definition: unknown;
  try {
    keys = Reflect.ownKeys(input);
    created = Reflect.get(input, "created");
    definition = Reflect.get(input, "definition");
  } catch (cause) {
    throw new ReplayRepositoryContractError(
      "Replay definition publication result violates the repository contract",
      { cause },
    );
  }
  if (
    keys.length !== 2 ||
    !keys.includes("created") ||
    !keys.includes("definition") ||
    typeof created !== "boolean"
  ) {
    throw new ReplayRepositoryContractError(
      "Replay definition publication result violates the repository contract",
    );
  }
  return { created, definition };
}

function targetPublicationResult(
  input: unknown,
  scope: TargetRelease["scope"],
  targetReleaseId: string,
): {
  readonly created: boolean;
  readonly release: TargetRelease;
  readonly definition: TargetReleaseDefinition;
} {
  const fields = resultFields(input);
  const validated = validatedStoredTargetRelease(fields.definition, scope, targetReleaseId);
  return { created: fields.created, definition: validated.definition, release: validated.release };
}

function planPublicationResult(
  input: unknown,
  scope: ReplayPlan["scope"],
  planVersionId: string,
): {
  readonly created: boolean;
  readonly plan: ReplayPlan;
  readonly definition: ReplayPlanDefinition;
} {
  const fields = resultFields(input);
  const validated = validatedStoredReplayPlan(fields.definition, scope, planVersionId);
  return { created: fields.created, definition: validated.definition, plan: validated.plan };
}

function authorizedPublication(command: ReplayDefinitionPublicationRoute): {
  readonly principal: PrincipalContext;
  readonly scope: ReturnType<typeof EvidenceScopeSchema.parse>;
} {
  const principal = publicationPrincipal(command.principal);
  requireCapability(principal, "replay:manage");
  const projectId = command.projectId;
  const environmentId = command.environmentId;
  requireEnvironmentAccess(principal, projectId, environmentId);
  return { principal, scope: exactScope(principal, projectId, environmentId) };
}

/** Publishes one immutable target release using server-owned authorship, time, and digest. */
export class PublishTargetRelease {
  constructor(private readonly dependencies: PublishReplayDefinitionDependencies) {}

  async execute(command: PublishTargetReleaseCommand): Promise<PublishTargetReleaseResult> {
    const { principal, scope } = authorizedPublication(command);
    const targetId = routeIdentifier(command.targetId, "targetId");
    const targetReleaseId = routeIdentifier(command.targetReleaseId, "targetReleaseId");
    const definition = targetDefinition(command.definition);
    if (
      !replayScopesEqual(definition.scope, scope) ||
      definition.targetId !== targetId ||
      definition.targetReleaseId !== targetReleaseId
    ) {
      throw invalidInput("Target release publication route and definition do not match");
    }

    const existingInput = await this.dependencies.repository.findTargetRelease(
      structuredClone(scope),
      targetReleaseId,
    );
    if (existingInput !== null) {
      const existing = validatedStoredTargetRelease(existingInput, scope, targetReleaseId);
      if (!areTargetReleaseDefinitionsEqual(existing.definition, definition)) {
        throw new ReplayDefinitionConflictError();
      }
      const result = targetPublicationResult(
        await this.dependencies.repository.publishTargetRelease(structuredClone(existing.release)),
        scope,
        targetReleaseId,
      );
      if (result.created || !sameJson(result.release, existing.release)) {
        throw new ReplayRepositoryContractError(
          "Target release publication retry violates the repository contract",
        );
      }
      return { created: false, release: structuredClone(result.release) };
    }

    const candidate = TargetReleaseSchema.parse({
      ...definition,
      createdAt: publicationTimestamp(this.dependencies.clock),
      createdByPrincipalId: principal.principalId,
      definitionSha256: digestTargetReleaseDefinition(definition),
    });
    const result = targetPublicationResult(
      await this.dependencies.repository.publishTargetRelease(structuredClone(candidate)),
      scope,
      targetReleaseId,
    );
    if (
      !areTargetReleaseDefinitionsEqual(result.definition, definition) ||
      (result.created && !sameJson(result.release, candidate))
    ) {
      throw new ReplayRepositoryContractError(
        "Published target release violates the repository contract",
      );
    }
    return { created: result.created, release: structuredClone(result.release) };
  }
}

/** Publishes one immutable exact replay plan using server-owned authorship, time, and digest. */
export class PublishReplayPlan {
  constructor(private readonly dependencies: PublishReplayDefinitionDependencies) {}

  async execute(command: PublishReplayPlanCommand): Promise<PublishReplayPlanResult> {
    const { principal, scope } = authorizedPublication(command);
    const planId = routeIdentifier(command.planId, "planId");
    const planVersionId = routeIdentifier(command.planVersionId, "planVersionId");
    const definition = planDefinition(command.definition);
    if (
      !replayScopesEqual(definition.scope, scope) ||
      definition.planId !== planId ||
      definition.planVersionId !== planVersionId
    ) {
      throw invalidInput("Replay plan publication route and definition do not match");
    }

    const existingInput = await this.dependencies.repository.findReplayPlan(
      structuredClone(scope),
      planVersionId,
    );
    if (existingInput !== null) {
      const existing = validatedStoredReplayPlan(existingInput, scope, planVersionId);
      if (!areReplayPlanDefinitionsEqual(existing.definition, definition)) {
        throw new ReplayDefinitionConflictError();
      }
      const result = planPublicationResult(
        await this.dependencies.repository.publishReplayPlan(structuredClone(existing.plan)),
        scope,
        planVersionId,
      );
      if (result.created || !sameJson(result.plan, existing.plan)) {
        throw new ReplayRepositoryContractError(
          "Replay plan publication retry violates the repository contract",
        );
      }
      return { created: false, plan: structuredClone(result.plan) };
    }

    const candidate = ReplayPlanSchema.parse({
      ...definition,
      createdAt: publicationTimestamp(this.dependencies.clock),
      createdByPrincipalId: principal.principalId,
      definitionSha256: digestReplayPlanDefinition(definition),
    });
    const result = planPublicationResult(
      await this.dependencies.repository.publishReplayPlan(structuredClone(candidate)),
      scope,
      planVersionId,
    );
    if (
      !areReplayPlanDefinitionsEqual(result.definition, definition) ||
      (result.created && !sameJson(result.plan, candidate))
    ) {
      throw new ReplayRepositoryContractError(
        "Published replay plan violates the repository contract",
      );
    }
    return { created: result.created, plan: structuredClone(result.plan) };
  }
}
