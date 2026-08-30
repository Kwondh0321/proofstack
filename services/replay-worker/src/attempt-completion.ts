import { createHash } from "node:crypto";
import {
  ArtifactContentReferenceSchema,
  EvidenceScopeSchema,
  type ReplayAttemptError,
  type ReplayArtifactContentReference,
  ReplayWorkerMutationFenceSchema,
} from "@proofstack/contracts";
import {
  type CompleteDurableReplayJobCommand,
  type ReplayJobSnapshot,
  type ReplayJobWorkerRepository,
  summarizeReplayBudgetLedger,
} from "@proofstack/replay";
import { ReplayAttemptCompletionError } from "./errors.js";
import type { ReplayTargetProcessResult } from "./target-process-supervisor.js";

export interface CompleteSupervisedReplayAttemptOptions {
  readonly leaseDurationMilliseconds: number;
  readonly processResult: ReplayTargetProcessResult;
  readonly repository: ReplayJobWorkerRepository;
  readonly result?: unknown;
  readonly scope: unknown;
  readonly snapshot: ReplayJobSnapshot;
  readonly workerFence: unknown;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function detailsSha256(result: ReplayTargetProcessResult): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        exitCode: result.exitCode,
        failureCode: result.failureCode,
        isolation: result.isolation.map(({ control, verdict }) => ({ control, verdict })),
        signal: result.signal,
        status: result.status,
      }),
      "utf8",
    )
    .digest("hex");
}

function attemptError(
  code: ReplayAttemptError["code"],
  message: string,
  processResult: ReplayTargetProcessResult,
): ReplayAttemptError {
  return {
    code,
    detailsSha256: detailsSha256(processResult),
    effectCertainty: "none",
    message,
  };
}

function failureError(processResult: ReplayTargetProcessResult): ReplayAttemptError {
  switch (processResult.failureCode) {
    case "boundary_resolution_failed":
      return attemptError(
        "fixture_unavailable",
        "A declared recorded boundary could not be resolved without fallback.",
        processResult,
      );
    case "output_limit_exceeded":
      return attemptError(
        "isolation_failed",
        "The target exceeded a declared bounded output control.",
        processResult,
      );
    case "runtime_control_violated":
      return attemptError(
        "isolation_failed",
        "The target violated a declared deterministic runtime control.",
        processResult,
      );
    case "protocol_failed":
    case "target_incomplete":
      return attemptError(
        "contract_mismatch",
        "The target did not complete the exact worker protocol contract.",
        processResult,
      );
    case "spawn_failed":
      return attemptError(
        "target_content_unavailable",
        "The verified target process could not be started.",
        processResult,
      );
    case "target_exit_failed":
      return attemptError(
        "target_process_interrupted",
        "The target process exited unsuccessfully before completion.",
        processResult,
      );
    case "result_publication_failed":
      return attemptError(
        "target_temporary_failure",
        "The bounded attempt report could not be published.",
        processResult,
      );
    case "worker_cancelled":
      return attemptError(
        "authority_denied",
        "Worker execution stopped without a durable replay cancellation request.",
        processResult,
      );
    case "deadline_reached":
      return attemptError(
        "deadline_exceeded",
        "The target exceeded the immutable attempt deadline.",
        processResult,
      );
    case "invalid_supervisor_options":
    case null:
      return attemptError(
        "worker_internal_error",
        "The bounded worker could not classify the target outcome.",
        processResult,
      );
  }
}

function validateLeaseDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ReplayAttemptCompletionError("invalid_lease_policy");
  }
}

function validateContext(options: CompleteSupervisedReplayAttemptOptions) {
  try {
    const scope = EvidenceScopeSchema.parse(options.scope);
    const workerFence = ReplayWorkerMutationFenceSchema.parse(options.workerFence);
    if (
      options.snapshot.job.jobId !== workerFence.jobId ||
      !sameJson(options.snapshot.job.scope, scope) ||
      !sameJson(options.snapshot.job.currentLease?.mutationFence, workerFence)
    ) {
      throw new TypeError("Completion does not belong to the current fenced attempt");
    }
    return { scope, workerFence };
  } catch (error) {
    throw new ReplayAttemptCompletionError("invalid_completion_context", { cause: error });
  }
}

function requireClosedAccounting(snapshot: ReplayJobSnapshot) {
  try {
    const summary = summarizeReplayBudgetLedger(snapshot.budgetLedger);
    if (summary.openReservationIds.length > 0) {
      throw new ReplayAttemptCompletionError("incomplete_accounting");
    }
    return summary;
  } catch (error) {
    if (error instanceof ReplayAttemptCompletionError) throw error;
    throw new ReplayAttemptCompletionError("incomplete_accounting", { cause: error });
  }
}

function cancellationAcknowledged(
  snapshot: ReplayJobSnapshot,
  workerFence: ReturnType<typeof ReplayWorkerMutationFenceSchema.parse>,
): boolean {
  return snapshot.cancellationAcknowledgements.some(
    (acknowledgement) =>
      acknowledgement.cancellationId === snapshot.cancellationRequest?.cancellationId &&
      sameJson(acknowledgement.mutationFence, workerFence),
  );
}

function completionCommand(
  options: CompleteSupervisedReplayAttemptOptions,
  context: ReturnType<typeof validateContext>,
): CompleteDurableReplayJobCommand {
  const accounting = requireClosedAccounting(options.snapshot);
  if (options.snapshot.cancellationRequest !== null) {
    if (!cancellationAcknowledged(options.snapshot, context.workerFence)) {
      throw new ReplayAttemptCompletionError("invalid_completion_context");
    }
    return {
      code: "cancellation_committed",
      error: attemptError(
        "cancelled",
        "A durable cancellation request stopped the bounded replay attempt.",
        options.processResult,
      ),
      scope: context.scope,
      status: "cancelled",
      workerFence: context.workerFence,
    };
  }
  if (accounting.overruns.length > 0) {
    return {
      code: "budget_limit_reached",
      error: attemptError(
        "budget_exhausted",
        "Observed usage exceeded its complete reservation.",
        options.processResult,
      ),
      scope: context.scope,
      status: "budget_exhausted",
      workerFence: context.workerFence,
    };
  }
  if (options.processResult.status === "completed") {
    let result: ReplayArtifactContentReference;
    try {
      result = ArtifactContentReferenceSchema.parse(options.result);
    } catch (error) {
      throw new ReplayAttemptCompletionError("missing_result", { cause: error });
    }
    return {
      code: "completed",
      result,
      scope: context.scope,
      status: "succeeded",
      workerFence: context.workerFence,
    };
  }
  if (options.processResult.status === "deadline_reached") {
    return {
      code: "deadline_reached",
      error: failureError(options.processResult),
      scope: context.scope,
      status: "timed_out",
      workerFence: context.workerFence,
    };
  }
  return {
    code: "execution_failed",
    error: failureError(options.processResult),
    scope: context.scope,
    status: "failed",
    workerFence: context.workerFence,
  };
}

export async function completeSupervisedReplayAttempt(
  options: CompleteSupervisedReplayAttemptOptions,
): Promise<ReplayJobSnapshot> {
  validateLeaseDuration(options.leaseDurationMilliseconds);
  const requestedContext = validateContext(options);
  completionCommand(options, requestedContext);
  const snapshot = await options.repository.heartbeatJob({
    leaseDurationMilliseconds: options.leaseDurationMilliseconds,
    scope: requestedContext.scope,
    workerFence: requestedContext.workerFence,
  });
  const authoritativeOptions = { ...options, snapshot };
  const context = validateContext(authoritativeOptions);
  const command = completionCommand(authoritativeOptions, context);
  return await options.repository.completeJob(command);
}
