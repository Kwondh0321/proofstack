import {
  serializeEvaluationCanonicalJson,
  type PolicyEvaluationJobSnapshot,
} from "@proofstack/contracts";
import {
  claimPolicyEvaluationJob,
  heartbeatPolicyEvaluationJob,
} from "./policy-evaluation-scheduler-claim.js";
import { reservePolicyEvaluationUsage } from "./policy-evaluation-scheduler-budget.js";
import { interruptPolicyEvaluationJob } from "./policy-evaluation-scheduler-interrupt.js";
import { reclaimPolicyEvaluationJob } from "./policy-evaluation-scheduler-reclaim.js";
import { cancelPolicyEvaluationJob } from "./policy-evaluation-scheduler-cancel.js";
import { exhaustPolicyEvaluationJobHistory } from "./policy-evaluation-history-limit.js";
import {
  digestPolicyEvaluationJobGraph,
  validatePolicyEvaluationJobHistoryEntry,
  PolicyEvaluationJobHistoryError,
} from "./policy-evaluation-job-history.js";

/** Re-derive one retained transition; this does not revive a lease or establish current DB authority. */
export function replayPolicyEvaluationJobHistoryEntry(
  previous: PolicyEvaluationJobSnapshot,
  raw: unknown,
): PolicyEvaluationJobSnapshot {
  const entry = validatePolicyEvaluationJobHistoryEntry(raw);
  const { definition } = entry;
  if (
    definition.previousGraphSha256 !== digestPolicyEvaluationJobGraph(previous) ||
    definition.previousStatus !== previous.job.status ||
    definition.stateVersion !== previous.job.stateVersion + 1 ||
    serializeEvaluationCanonicalJson(definition.scope) !==
      serializeEvaluationCanonicalJson(previous.job.scope) ||
    definition.job.jobId !== previous.job.jobId ||
    definition.job.definitionSha256 !== previous.job.definitionSha256
  )
    throw new PolicyEvaluationJobHistoryError(
      "History does not bind the exact preceding owning graph",
    );
  const common = {
    snapshot: previous,
    now: definition.committedAt,
    recoveryEpoch: previous.job.recoveryEpoch,
  };
  const operation = definition.operation;
  let next: PolicyEvaluationJobSnapshot;
  switch (operation.kind) {
    case "claim":
      next = claimPolicyEvaluationJob({
        ...common,
        attemptId: operation.fence.attemptId,
        leaseId: operation.fence.leaseId,
        workerId: operation.fence.workerId,
      });
      if (
        serializeEvaluationCanonicalJson(next.job.currentLease?.mutationFence) !==
        serializeEvaluationCanonicalJson(operation.fence)
      )
        throw new PolicyEvaluationJobHistoryError(
          "Claim history substituted a fence or recovery epoch",
        );
      break;
    case "heartbeat":
      next = heartbeatPolicyEvaluationJob({ ...common, fence: operation.fence });
      break;
    case "reserve":
      next = reservePolicyEvaluationUsage({
        ...common,
        fence: operation.fence,
        delta: operation.delta,
      });
      break;
    case "interrupt":
      next = interruptPolicyEvaluationJob({
        ...common,
        fence: operation.fence,
        reason: operation.reason,
      });
      break;
    case "reclaim":
      next = reclaimPolicyEvaluationJob(common);
      break;
    case "history_limit":
      next = exhaustPolicyEvaluationJobHistory(previous, definition.committedAt);
      break;
    case "cancel":
      next = cancelPolicyEvaluationJob({ snapshot: previous, intent: operation.intent });
      break;
    case "created":
      throw new PolicyEvaluationJobHistoryError(
        "Creation cannot replace an already retained graph",
      );
  }
  if (
    next.job.status !== definition.status ||
    digestPolicyEvaluationJobGraph(next) !== definition.graphSha256
  )
    throw new PolicyEvaluationJobHistoryError(
      "History does not match independently re-derived transition output",
    );
  return next;
}
