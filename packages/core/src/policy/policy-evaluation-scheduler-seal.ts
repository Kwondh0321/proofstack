import {
  PolicyEvaluationJobSnapshotSchema,
  PolicyEvaluationSnapshotReferenceSchema,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationSnapshotReference,
  type PolicyEvaluationWorkerMutationFence,
} from "@proofstack/contracts";
import { requirePolicyEvaluationLiveFence } from "./policy-evaluation-live-fence.js";
import { PolicyEvaluationSchedulerTransitionError } from "./policy-evaluation-scheduler-claim.js";

type LiveTransition = {
  readonly snapshot: PolicyEvaluationJobSnapshot;
  readonly now: string;
  readonly recoveryEpoch: number;
  readonly fence: PolicyEvaluationWorkerMutationFence;
};

/** Logical transition only. The store must own current source guards and atomic record publication. */
export function sealPolicyEvaluationJob(
  input: LiveTransition & {
    readonly sealedSnapshot: PolicyEvaluationSnapshotReference;
  },
): PolicyEvaluationJobSnapshot {
  const result = PolicyEvaluationJobSnapshotSchema.parse(input.snapshot);
  requirePolicyEvaluationLiveFence({ ...input, snapshot: result });
  const reference = PolicyEvaluationSnapshotReferenceSchema.parse(input.sealedSnapshot);
  const { job } = result;
  const latest = result.attempts.at(-1);
  if (
    job.status !== "acquiring" ||
    job.snapshot !== null ||
    !latest ||
    latest.closure !== null ||
    latest.phase !== "acquiring" ||
    latest.snapshot !== null
  )
    throw new PolicyEvaluationSchedulerTransitionError("state_conflict");
  if (job.stateVersion >= Number.MAX_SAFE_INTEGER)
    throw new PolicyEvaluationSchedulerTransitionError("counter_exhausted");
  // Preserve the admitted attempt/lease/worker/fence/start/deadline/usage. Sealing is not a claim.
  latest.phase = "computing";
  latest.snapshot = reference;
  job.snapshot = reference;
  job.status = "sealed";
  job.stateVersion++;
  job.updatedAt = input.now;
  return PolicyEvaluationJobSnapshotSchema.parse(result);
}

/** Start computation on the already bound snapshot and the same live attempt. No source recapture. */
export function startPolicyEvaluationComputation(
  input: LiveTransition,
): PolicyEvaluationJobSnapshot {
  const result = PolicyEvaluationJobSnapshotSchema.parse(input.snapshot);
  requirePolicyEvaluationLiveFence({ ...input, snapshot: result });
  const { job } = result;
  const latest = result.attempts.at(-1);
  if (
    job.status !== "sealed" ||
    job.snapshot === null ||
    !latest ||
    latest.closure !== null ||
    latest.phase !== "computing"
  )
    throw new PolicyEvaluationSchedulerTransitionError("state_conflict");
  if (job.stateVersion >= Number.MAX_SAFE_INTEGER)
    throw new PolicyEvaluationSchedulerTransitionError("counter_exhausted");
  job.status = "running";
  job.stateVersion++;
  job.updatedAt = input.now;
  return PolicyEvaluationJobSnapshotSchema.parse(result);
}
