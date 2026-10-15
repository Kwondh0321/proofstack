import { z } from "zod";
import {
  OpaqueIdSchema,
  PrincipalContextSchema,
  PolicyEvaluationJobSnapshotSchema,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type PrincipalContext,
  type PolicyEvaluation,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationRequest,
  type PolicyEvaluationWorkerMutationFence,
} from "@proofstack/contracts";
import {
  ForbiddenError,
  requireCapability,
  requirePolicyEvaluationExecution,
  claimPolicyEvaluationJobRequest,
  digestPolicyEvaluationJobDefinition,
  validatePolicyEvaluationJobSnapshotRecord,
  readCompletePolicyEvaluationSnapshot,
  validatePolicyEvaluationResultRecord,
  PolicyEvaluationSchedulerTransitionError,
  type PolicyEvaluationJobWorkerRepository,
  type PolicyEvaluationJobComputationRepository,
  type PolicyEvaluationSnapshotReader,
  type PolicyEvaluationResultPublisher,
  type PolicyEvaluationResultReader,
} from "@proofstack/core";
import type { ServiceTokenAuthenticator } from "@proofstack/identity";
import {
  publishPolicyEvaluationWithReservedRules,
  type PolicyEvaluationSnapshotSealReceipt,
} from "@proofstack/policy-evaluation";

const Delivery = z
  .object({
    schemaVersion: z.literal("0.1"),
    projectId: OpaqueIdSchema,
    environmentId: OpaqueIdSchema,
    jobId: OpaqueIdSchema,
  })
  .strict();
export interface PolicyWorkerAttemptPorts {
  readonly worker: PolicyEvaluationJobWorkerRepository & PolicyEvaluationJobComputationRepository;
  readonly snapshots: PolicyEvaluationSnapshotReader;
  readonly results: PolicyEvaluationResultPublisher & PolicyEvaluationResultReader;
  seal(input: {
    readonly principal: PrincipalContext;
    readonly request: PolicyEvaluationRequest;
    readonly fence: PolicyEvaluationWorkerMutationFence;
  }): Promise<PolicyEvaluationSnapshotSealReceipt>;
  close(): Promise<void>;
}
export interface PolicyWorkerAttemptOutcome {
  readonly disposition: "completed" | "observed_terminal" | "deferred";
  readonly job: PolicyEvaluationJobSnapshot;
  readonly evaluation: PolicyEvaluation | null;
}
export class PolicyWorkerJobUnavailableError extends Error {
  constructor() {
    super("Exact policy job is unavailable");
    this.name = "PolicyWorkerJobUnavailableError";
  }
}
export class PolicyWorkerAttemptError extends Error {
  constructor(
    readonly phase: "acquisition" | "computation",
    readonly job: PolicyEvaluationJobSnapshot,
    cause: unknown,
  ) {
    super("Policy worker attempt failed", { cause });
    this.name = "PolicyWorkerAttemptError";
  }
}
const same = (a: unknown, b: unknown) =>
  serializeEvaluationCanonicalJson(a) === serializeEvaluationCanonicalJson(b);
function checked(
  raw: unknown,
  scope: EvidenceScope,
  jobId: string,
  original?: PolicyEvaluationJobSnapshot,
) {
  const parsed = PolicyEvaluationJobSnapshotSchema.parse(raw);
  const job = validatePolicyEvaluationJobSnapshotRecord({
    expected: {
      scope,
      job: {
        jobId,
        definitionSha256:
          original?.job.definitionSha256 ??
          digestPolicyEvaluationJobDefinition(scope, { jobId, request: parsed.job.request }),
      },
    },
    snapshot: parsed,
  });
  if (original && !same(job.request, original.request))
    throw new Error("Policy worker repository changed original request receipts");
  return job;
}
function conflict(error: unknown): error is PolicyEvaluationSchedulerTransitionError {
  return (
    error instanceof PolicyEvaluationSchedulerTransitionError &&
    (error.reason === "state_conflict" ||
      error.reason === "retry_not_ready" ||
      error.reason === "deadline_reached")
  );
}
async function operate(
  principal: PrincipalContext,
  scope: EvidenceScope,
  jobId: string,
  ports: PolicyWorkerAttemptPorts,
  nextId: (kind: "attempt" | "lease" | "rule_reservation" | "evaluation") => string,
): Promise<PolicyWorkerAttemptOutcome> {
  const raw = await ports.worker.findJob(scope, jobId);
  if (raw === null) throw new PolicyWorkerJobUnavailableError();
  const original = checked(raw, scope, jobId);
  const read = async () => {
    const current = await ports.worker.findJob(scope, jobId);
    if (current === null) throw new PolicyWorkerJobUnavailableError();
    return checked(current, scope, jobId, original);
  };
  const finish = async (
    job: PolicyEvaluationJobSnapshot,
    disposition: PolicyWorkerAttemptOutcome["disposition"],
  ): Promise<PolicyWorkerAttemptOutcome> => {
    if (job.job.status !== "completed") return { disposition, job, evaluation: null };
    const material = await originalInput(job);
    const evaluation = await ports.results.findResult(scope, jobId, material.pageSet);
    if (evaluation === null) throw new Error("Completed policy job omitted original result");
    // The checked completed graph already binds its terminal record to the final deciding attempt.
    const attempt = job.attempts.at(-1)!;
    const checkedEvaluation = validatePolicyEvaluationResultRecord({
      expected: {
        scope,
        jobId,
        request: job.job.request,
        snapshot: job.job.snapshot!,
        result: job.job.result!,
        fence: attempt.mutationFence,
        completedAt: job.job.terminal!.committedAt,
      },
      record: evaluation,
      snapshotRecord: material.snapshot,
      pageSet: material.pageSet,
    });
    return { disposition, job, evaluation: checkedEvaluation };
  };
  const originalInput = async (job: PolicyEvaluationJobSnapshot) => {
    // Callers require a validated running/completed graph, which necessarily retains its seal.
    const material = await readCompletePolicyEvaluationSnapshot(ports.snapshots, {
      scope,
      job: { jobId, definitionSha256: job.job.definitionSha256 },
      request: job.job.request,
      snapshot: job.job.snapshot!,
    });
    if (material === null) throw new Error("Policy worker omitted exact stored snapshot pages");
    return material;
  };
  if (original.job.terminal) return finish(original, "observed_terminal");
  // DB-owned observation closes expired work/deadlines; a healthy state rejects without mutation.
  try {
    checked(await ports.worker.reclaimJob({ scope, jobId }), scope, jobId, original);
  } catch (error) {
    if (!conflict(error)) throw error;
  }
  let job = await read();
  if (job.job.terminal) return finish(job, "observed_terminal");
  if (job.job.currentLease) return finish(job, "deferred");
  try {
    job = checked(
      await claimPolicyEvaluationJobRequest(
        { principal, projectId: scope.projectId, environmentId: scope.environmentId, jobId },
        {
          repository: ports.worker,
          newAttemptId: () => nextId("attempt"),
          newLeaseId: () => nextId("lease"),
        },
      ),
      scope,
      jobId,
      original,
    );
  } catch (error) {
    if (!conflict(error)) throw error;
    if (error.reason === "deadline_reached") {
      try {
        checked(await ports.worker.reclaimJob({ scope, jobId }), scope, jobId, original);
      } catch (reclaimError) {
        if (!conflict(reclaimError)) throw reclaimError;
      }
    }
    job = await read();
    return finish(job, job.job.terminal ? "observed_terminal" : "deferred");
  }
  if (job.job.terminal) return finish(job, "observed_terminal");
  // The authenticated claim use case has independently checked the complete nonterminal fence.
  const fence = Object.freeze(job.job.currentLease!.mutationFence);
  let phase: "acquisition" | "computation" = job.job.snapshot ? "computation" : "acquisition";
  try {
    if (job.job.snapshot === null) {
      const sealed = await ports.seal({ principal, request: job.request, fence });
      job = checked(sealed.job, scope, jobId, original);
      if (job.job.status !== "sealed" || !same(job.job.currentLease!.mutationFence, fence))
        throw new Error("Policy worker seal changed its owning attempt");
    }
    phase = "computation";
    if (job.job.status === "sealed")
      job = checked(await ports.worker.startComputation({ scope, fence }), scope, jobId, original);
    if (job.job.status !== "running" || !same(job.job.currentLease!.mutationFence, fence))
      throw new Error("Policy worker computation changed its owning attempt");
    const material = await originalInput(job);
    const result = await publishPolicyEvaluationWithReservedRules(
      { principal, scope, fence, evaluationId: nextId("evaluation") },
      {
        repository: ports.worker,
        publisher: ports.results,
        snapshotRecord: material.snapshot,
        pageSet: material.pageSet,
        nextReservationId: () => nextId("rule_reservation"),
      },
    );
    return {
      disposition: "completed",
      job: checked(result.snapshot, scope, jobId, original),
      evaluation: result.evaluation,
    };
  } catch (error) {
    try {
      job = await read();
      if (job.job.currentLease !== null && same(job.job.currentLease.mutationFence, fence)) {
        try {
          job = checked(
            await ports.worker.interruptJob({ scope, fence, reason: "worker_interrupted" }),
            scope,
            jobId,
            original,
          );
        } catch (settlementError) {
          if (!(settlementError instanceof PolicyEvaluationSchedulerTransitionError))
            throw settlementError;
          if (settlementError.reason === "lease_expired")
            job = checked(await ports.worker.reclaimJob({ scope, jobId }), scope, jobId, original);
          else if (
            settlementError.reason === "state_conflict" ||
            settlementError.reason === "stale_fence"
          ) {
            job = await read();
            if (job.job.currentLease !== null && same(job.job.currentLease.mutationFence, fence))
              throw settlementError;
          } else throw settlementError;
        }
      }
      if (job.job.status === "completed") return await finish(job, "observed_terminal");
    } catch (settlementError) {
      throw new AggregateError(
        [error, settlementError],
        "Policy worker failed and could not settle its owned attempt",
      );
    }
    throw new PolicyWorkerAttemptError(phase, job, error);
  }
}

/** One authenticated delivery/attempt. No automatic mutation retry, outcome selection or scheduler. */
export async function runPolicyWorkerAttempt(
  input: { readonly serviceToken: string; readonly requestId: string; readonly delivery: unknown },
  dependencies: {
    readonly authenticator: Pick<ServiceTokenAuthenticator, "authenticate">;
    createRuntime(
      scope: EvidenceScope,
      principal: PrincipalContext,
    ): Promise<PolicyWorkerAttemptPorts>;
    nextId(kind: "attempt" | "lease" | "rule_reservation" | "evaluation"): string;
  },
): Promise<PolicyWorkerAttemptOutcome> {
  const principal = PrincipalContextSchema.parse(
    await dependencies.authenticator.authenticate(input.serviceToken, input.requestId),
  );
  requireCapability(principal, "policy:evaluation:execute");
  if (principal.principalType !== "service" || principal.authentication.method !== "service_token")
    throw new ForbiddenError("Policy worker requires an authenticated service principal");
  const delivery = Delivery.parse(input.delivery);
  const scope = Object.freeze({
    tenantId: principal.tenantId,
    projectId: delivery.projectId,
    environmentId: delivery.environmentId,
  });
  requirePolicyEvaluationExecution(principal, scope);
  const ports = await dependencies.createRuntime(scope, structuredClone(principal));
  let failed = false,
    failure: unknown,
    outcome: PolicyWorkerAttemptOutcome | undefined;
  try {
    outcome = await operate(principal, scope, delivery.jobId, ports, dependencies.nextId);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await ports.close();
  } catch (cleanupError) {
    if (failed)
      throw new AggregateError(
        [failure, cleanupError],
        "Policy worker operation and cleanup failed",
      );
    throw cleanupError;
  }
  if (failed) throw failure;
  return outcome!;
}
