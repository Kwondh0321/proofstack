import {
  EvidenceScopeSchema,
  OpaqueIdSchema,
  type PrincipalContext,
  PrincipalContextSchema,
  type ReplayJobSnapshot,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "@proofstack/core";
import { InvalidReplayJobInputError, ReplayJobNotFoundError } from "./errors.js";
import { validatedReplayJobSnapshot } from "./replay-job-control-validation.js";
import type { ReplayJobControlRepository } from "./replay-job-repository.js";

export interface ReadReplayJobCommand {
  readonly environmentId: string;
  readonly jobId: string;
  readonly principal: PrincipalContext;
  readonly projectId: string;
}

function invalidInput(message: string, cause: unknown): InvalidReplayJobInputError {
  return new InvalidReplayJobInputError(message, { cause });
}

function readPrincipal(input: unknown): PrincipalContext {
  try {
    return PrincipalContextSchema.parse(input);
  } catch (cause) {
    throw invalidInput("Replay job read principal is invalid", cause);
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
  if (!parsed.success) throw invalidInput("Replay job read scope is invalid", parsed.error);
  return parsed.data;
}

function readJobId(input: unknown): string {
  const parsed = OpaqueIdSchema.safeParse(input);
  if (!parsed.success) throw invalidInput("Replay job read jobId is invalid", parsed.error);
  return parsed.data;
}

/** Reads one exact durable replay job and its validated immutable histories. */
export class ReadReplayJob {
  constructor(private readonly repository: ReplayJobControlRepository) {}

  async execute(command: ReadReplayJobCommand): Promise<ReplayJobSnapshot> {
    const principal = readPrincipal(command.principal);
    requireCapability(principal, "replay:read");
    const projectId = command.projectId;
    const environmentId = command.environmentId;
    requireEnvironmentAccess(principal, projectId, environmentId);
    const scope = exactScope(principal, projectId, environmentId);
    const jobId = readJobId(command.jobId);
    const stored = await this.repository.findJob(structuredClone(scope), jobId);
    if (stored === null) throw new ReplayJobNotFoundError();
    return structuredClone(validatedReplayJobSnapshot(stored, scope, jobId));
  }
}
