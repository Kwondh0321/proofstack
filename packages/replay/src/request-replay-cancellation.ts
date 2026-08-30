import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  type PrincipalContext,
  PrincipalContextSchema,
  type ReplayJobSnapshot,
  type RequestReplayCancellation,
  RequestReplayCancellationSchema,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "@proofstack/core";
import { InvalidReplayJobInputError, ReplayRepositoryContractError } from "./errors.js";
import { validatedReplayJobMutationResult } from "./replay-job-control-validation.js";
import type { ReplayJobControlRepository } from "./replay-job-repository.js";

export interface RequestReplayJobCancellationCommand {
  readonly environmentId: string;
  readonly jobId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
  readonly request: RequestReplayCancellation;
}

export interface RequestReplayJobCancellationResult {
  readonly created: boolean;
  readonly snapshot: ReplayJobSnapshot;
}

function invalidInput(message: string, cause: unknown): InvalidReplayJobInputError {
  return new InvalidReplayJobInputError(message, { cause });
}

function cancellationPrincipal(input: unknown): PrincipalContext {
  try {
    return PrincipalContextSchema.parse(input);
  } catch (cause) {
    throw invalidInput("Replay cancellation principal is invalid", cause);
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
  if (!parsed.success) throw invalidInput("Replay cancellation scope is invalid", parsed.error);
  return parsed.data;
}

function routeJobId(input: unknown): string {
  const parsed = OpaqueIdSchema.safeParse(input);
  if (!parsed.success) throw invalidInput("Replay cancellation jobId is invalid", parsed.error);
  return parsed.data;
}

function cancellationRequest(input: unknown): RequestReplayCancellation {
  const parsed = RequestReplayCancellationSchema.safeParse(input);
  if (!parsed.success) throw invalidInput("Replay cancellation request is invalid", parsed.error);
  return parsed.data;
}

function cancellationMatches(
  stored: NonNullable<ReplayJobSnapshot["cancellationRequest"]>,
  request: RequestReplayCancellation,
): boolean {
  return (
    stored.cancellationId === request.cancellationId &&
    stored.reasonCode === request.reasonCode &&
    stored.reason === request.reason
  );
}

/** Records one immutable cancellation request without granting worker mutation authority. */
export class RequestDurableReplayCancellation {
  constructor(private readonly repository: ReplayJobControlRepository) {}

  async execute(
    command: RequestReplayJobCancellationCommand,
  ): Promise<RequestReplayJobCancellationResult> {
    const principal = cancellationPrincipal(command.principal);
    requireCapability(principal, "replay:cancel");
    const projectId = command.projectId;
    const environmentId = command.environmentId;
    requireEnvironmentAccess(principal, projectId, environmentId);
    const scope = exactScope(principal, projectId, environmentId);
    const jobId = routeJobId(command.jobId);
    const request = cancellationRequest(command.request);

    const result = validatedReplayJobMutationResult(
      await this.repository.requestCancellation({
        input: structuredClone(request),
        jobId,
        requestedByPrincipalId: principal.principalId,
        scope: structuredClone(scope),
      }),
      scope,
      jobId,
    );
    const stored = result.snapshot.cancellationRequest;
    if (stored === null) {
      if (result.created || result.snapshot.job.terminal === undefined) {
        throw new ReplayRepositoryContractError(
          "Replay cancellation result violates the repository contract",
        );
      }
    } else if (
      !cancellationMatches(stored, request) ||
      (result.created && stored.requestedByPrincipalId !== principal.principalId)
    ) {
      throw new ReplayRepositoryContractError(
        "Replay cancellation result violates the repository contract",
      );
    }
    return { created: result.created, snapshot: structuredClone(result.snapshot) };
  }
}
