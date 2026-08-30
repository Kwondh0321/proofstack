import { createHash } from "node:crypto";
import {
  EvidenceScopeSchema,
  type ReplayExecutionObservationPayload,
  ReplayExecutionObservationPayloadSchema,
  ReplayWorkerMutationFenceSchema,
} from "@proofstack/contracts";
import type { ReplayJobSnapshot, ReplayJobWorkerRepository } from "@proofstack/replay";
import { ReplayAttemptObservationError } from "./errors.js";
import type { ReplayTargetProcessResult } from "./target-process-supervisor.js";

export interface RecordSupervisedExecutionObservationsOptions {
  readonly leaseDurationMilliseconds: number;
  readonly processResult: Pick<ReplayTargetProcessResult, "executionObservations" | "isolation">;
  readonly repository: ReplayJobWorkerRepository;
  readonly scope: unknown;
  readonly workerFence: unknown;
}

function observationId(attemptId: string, fencingToken: number, index: number): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        attemptId,
        fencingToken,
        index,
        namespace: "proofstack.supervised-execution-observation.v1",
      }),
      "utf8",
    )
    .digest("hex");
  return `obs_${digest.slice(0, 40)}`;
}

function validateLeaseDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ReplayAttemptObservationError("invalid_lease_policy");
  }
}

function validateBatch(
  processResult: RecordSupervisedExecutionObservationsOptions["processResult"],
): readonly ReplayExecutionObservationPayload[] {
  try {
    const execution = processResult.executionObservations.map((payload) => {
      const parsed = ReplayExecutionObservationPayloadSchema.parse(payload);
      if (parsed.kind === "cancellation" || parsed.kind === "isolation") {
        throw new TypeError("Supervisor execution observations contain an invalid kind");
      }
      return parsed;
    });
    const isolation = processResult.isolation.map((payload) => {
      const parsed = ReplayExecutionObservationPayloadSchema.parse(payload);
      if (parsed.kind !== "isolation") {
        throw new TypeError("Supervisor isolation observations contain an invalid kind");
      }
      return parsed;
    });
    return Object.freeze([...execution, ...isolation]);
  } catch (error) {
    throw new ReplayAttemptObservationError("invalid_observation_batch", { cause: error });
  }
}

export async function recordSupervisedExecutionObservations(
  options: RecordSupervisedExecutionObservationsOptions,
): Promise<ReplayJobSnapshot> {
  validateLeaseDuration(options.leaseDurationMilliseconds);
  let scope: ReturnType<typeof EvidenceScopeSchema.parse>;
  let workerFence: ReturnType<typeof ReplayWorkerMutationFenceSchema.parse>;
  let payloads: readonly ReplayExecutionObservationPayload[];
  try {
    scope = EvidenceScopeSchema.parse(options.scope);
    workerFence = ReplayWorkerMutationFenceSchema.parse(options.workerFence);
    payloads = validateBatch(options.processResult);
  } catch (error) {
    if (error instanceof ReplayAttemptObservationError) throw error;
    throw new ReplayAttemptObservationError("invalid_observation_batch", { cause: error });
  }

  let latestSnapshot: ReplayJobSnapshot | undefined;
  for (const [index, payload] of payloads.entries()) {
    latestSnapshot = await options.repository.heartbeatJob({
      leaseDurationMilliseconds: options.leaseDurationMilliseconds,
      scope,
      workerFence,
    });
    latestSnapshot = await options.repository.appendExecutionObservation({
      observationId: observationId(workerFence.attemptId, workerFence.fencingToken, index),
      payload,
      scope,
      workerFence,
    });
  }
  return (
    latestSnapshot ??
    (await options.repository.heartbeatJob({
      leaseDurationMilliseconds: options.leaseDurationMilliseconds,
      scope,
      workerFence,
    }))
  );
}
