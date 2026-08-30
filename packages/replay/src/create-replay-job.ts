import {
  type CreateReplayJobRequest,
  CreateReplayJobRequestSchema,
  EvidenceScopeSchema,
  OpaqueIdSchema,
  type PrincipalContext,
  PrincipalContextSchema,
  type ReplayJobSnapshot,
  type ReplayPlanJobReference,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "@proofstack/core";
import { InvalidReplayJobInputError, ReplayRepositoryContractError } from "./errors.js";
import { validatedReplayJobMutationResult } from "./replay-job-control-validation.js";
import type { ReplayJobControlRepository } from "./replay-job-repository.js";

export interface CreateDurableReplayJobCommand {
  readonly environmentId: string;
  readonly jobId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
  readonly request: CreateReplayJobRequest;
}

export interface CreateDurableReplayJobResult {
  readonly created: boolean;
  readonly snapshot: ReplayJobSnapshot;
}

function invalidInput(message: string, cause?: unknown): InvalidReplayJobInputError {
  return new InvalidReplayJobInputError(message, cause === undefined ? undefined : { cause });
}

function creationPrincipal(input: unknown): PrincipalContext {
  try {
    return PrincipalContextSchema.parse(input);
  } catch (cause) {
    throw invalidInput("Replay job creation principal is invalid", cause);
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
  if (!parsed.success) throw invalidInput("Replay job creation scope is invalid", parsed.error);
  return parsed.data;
}

function routeJobId(input: unknown): string {
  const parsed = OpaqueIdSchema.safeParse(input);
  if (!parsed.success) throw invalidInput("Replay job creation jobId is invalid", parsed.error);
  return parsed.data;
}

function creationRequest(input: unknown): CreateReplayJobRequest {
  const parsed = CreateReplayJobRequestSchema.safeParse(input);
  if (!parsed.success) throw invalidInput("Replay job creation request is invalid", parsed.error);
  return parsed.data;
}

function plansEqual(left: ReplayPlanJobReference, right: ReplayPlanJobReference): boolean {
  return (
    left.planId === right.planId &&
    left.planVersionId === right.planVersionId &&
    left.definitionSha256 === right.definitionSha256
  );
}

/** Creates one durable queued job from an already-published exact plan reference. */
export class CreateDurableReplayJob {
  constructor(private readonly repository: ReplayJobControlRepository) {}

  async execute(command: CreateDurableReplayJobCommand): Promise<CreateDurableReplayJobResult> {
    const principal = creationPrincipal(command.principal);
    requireCapability(principal, "replay:run");
    const projectId = command.projectId;
    const environmentId = command.environmentId;
    requireEnvironmentAccess(principal, projectId, environmentId);
    const scope = exactScope(principal, projectId, environmentId);
    const jobId = routeJobId(command.jobId);
    const request = creationRequest(command.request);
    if (request.jobId !== jobId) {
      throw invalidInput("Replay job creation route and request do not match");
    }

    const result = validatedReplayJobMutationResult(
      await this.repository.createJob({
        createdByPrincipalId: principal.principalId,
        jobId,
        plan: structuredClone(request.plan),
        scope: structuredClone(scope),
      }),
      scope,
      jobId,
    );
    if (
      result.snapshot.job.createdByPrincipalId !== principal.principalId ||
      !plansEqual(result.snapshot.job.plan, request.plan) ||
      (result.created &&
        (result.snapshot.job.status !== "queued" ||
          result.snapshot.job.stateVersion !== 1 ||
          result.snapshot.job.recoveryEpoch !== 0))
    ) {
      throw new ReplayRepositoryContractError(
        "Replay job creation result violates the repository contract",
      );
    }
    return { created: result.created, snapshot: structuredClone(result.snapshot) };
  }
}
