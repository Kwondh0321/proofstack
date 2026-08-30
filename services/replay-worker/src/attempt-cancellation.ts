import { createHash } from "node:crypto";
import {
  EvidenceScopeSchema,
  type ReplayCancellationAcknowledgement,
  ReplayCancellationRequestSchema,
  type ReplayExecutionObservationPayload,
  ReplayWorkerMutationFenceSchema,
} from "@proofstack/contracts";
import type { ReplayJobRepository, ReplayJobSnapshot } from "@proofstack/replay";
import { ReplayAttemptCancellationError } from "./errors.js";

const CANCELLATION_NAMESPACE = "proofstack.replay-attempt-cancellation.v1";

export interface AcknowledgeReplayAttemptCancellationOptions {
  readonly action: ReplayCancellationAcknowledgement["action"];
  readonly leaseDurationMilliseconds: number;
  readonly repository: ReplayJobRepository;
  readonly scope: unknown;
  readonly snapshot: ReplayJobSnapshot;
  readonly workerFence: unknown;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stableId(
  prefix: "ack" | "obs",
  cancellationId: string,
  workerFence: ReturnType<typeof ReplayWorkerMutationFenceSchema.parse>,
  purpose: string,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        attemptId: workerFence.attemptId,
        cancellationId,
        fencingToken: workerFence.fencingToken,
        namespace: CANCELLATION_NAMESPACE,
        purpose,
      }),
      "utf8",
    )
    .digest("hex");
  return `${prefix}_${digest.slice(0, 40)}`;
}

function evidenceSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function parseContext(options: AcknowledgeReplayAttemptCancellationOptions) {
  try {
    const scope = EvidenceScopeSchema.parse(options.scope);
    const workerFence = ReplayWorkerMutationFenceSchema.parse(options.workerFence);
    const cancellation = ReplayCancellationRequestSchema.parse(
      options.snapshot.cancellationRequest,
    );
    const action = new Set<ReplayCancellationAcknowledgement["action"]>([
      "observed_after_uninterruptible_completion",
      "stop_requested",
      "stopped_before_target_start",
    ]).has(options.action)
      ? options.action
      : undefined;
    if (
      !action ||
      options.snapshot.job.jobId !== workerFence.jobId ||
      cancellation.jobId !== workerFence.jobId ||
      !sameJson(options.snapshot.job.scope, scope) ||
      !sameJson(cancellation.scope, scope) ||
      !sameJson(options.snapshot.job.currentLease?.mutationFence, workerFence)
    ) {
      throw new TypeError("Cancellation does not belong to the current fenced attempt");
    }
    return { action, cancellation, scope, workerFence };
  } catch (error) {
    throw new ReplayAttemptCancellationError("invalid_cancellation_context", { cause: error });
  }
}

function validateLeaseDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ReplayAttemptCancellationError("invalid_lease_policy");
  }
}

function actionEvent(
  action: ReplayCancellationAcknowledgement["action"],
): Extract<ReplayExecutionObservationPayload, { kind: "cancellation" }>["event"] {
  if (action === "observed_after_uninterruptible_completion") {
    return "late_completion_observed";
  }
  if (action === "stopped_before_target_start") return "stopped_before_target_start";
  return "stop_requested";
}

export async function acknowledgeReplayAttemptCancellation(
  options: AcknowledgeReplayAttemptCancellationOptions,
): Promise<ReplayJobSnapshot> {
  validateLeaseDuration(options.leaseDurationMilliseconds);
  const context = parseContext(options);
  const payloads = [
    {
      cancellationId: context.cancellation.cancellationId,
      event: "request_observed",
      evidenceSha256: evidenceSha256({
        cancellationId: context.cancellation.cancellationId,
        event: "request_observed",
      }),
      kind: "cancellation",
    },
    {
      cancellationId: context.cancellation.cancellationId,
      event: actionEvent(context.action),
      evidenceSha256: evidenceSha256({
        action: context.action,
        cancellationId: context.cancellation.cancellationId,
      }),
      kind: "cancellation",
    },
  ] as const satisfies readonly ReplayExecutionObservationPayload[];

  for (const [index, payload] of payloads.entries()) {
    await options.repository.heartbeatJob({
      leaseDurationMilliseconds: options.leaseDurationMilliseconds,
      scope: context.scope,
      workerFence: context.workerFence,
    });
    await options.repository.appendExecutionObservation({
      observationId: stableId(
        "obs",
        context.cancellation.cancellationId,
        context.workerFence,
        `event-${index}`,
      ),
      payload,
      scope: context.scope,
      workerFence: context.workerFence,
    });
  }
  await options.repository.heartbeatJob({
    leaseDurationMilliseconds: options.leaseDurationMilliseconds,
    scope: context.scope,
    workerFence: context.workerFence,
  });
  return await options.repository.acknowledgeCancellation({
    acknowledgementId: stableId(
      "ack",
      context.cancellation.cancellationId,
      context.workerFence,
      context.action,
    ),
    action: context.action,
    scope: context.scope,
    workerFence: context.workerFence,
  });
}
