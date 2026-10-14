import type { PolicyEvaluationJobSnapshot } from "@proofstack/contracts";
import { validatePolicyEvaluationJobSnapshotRecord } from "./policy-evaluation-job-record-validation.js";

export interface PolicyEvaluationJobOutboxIntent {
  readonly schemaVersion: "0.1";
  readonly aggregateType: "policy.evaluation.job";
  readonly aggregateId: string;
  readonly tenantId: string;
  readonly createdAt: string;
  readonly eventType:
    | "policy.evaluation.job.created"
    | "policy.evaluation.job.cancellation-requested"
    | "policy.evaluation.job.terminal";
  readonly payload: Readonly<Record<string, string | number>>;
}
/** Canonical retained metadata only; no policy disposition, classified bytes or publication grant. */
export function buildPolicyEvaluationJobOutboxIntents(
  previous: PolicyEvaluationJobSnapshot | null,
  nextInput: PolicyEvaluationJobSnapshot,
): readonly PolicyEvaluationJobOutboxIntent[] {
  const next = validatePolicyEvaluationJobSnapshotRecord({
    expected: {
      scope: nextInput.job.scope,
      job: { jobId: nextInput.job.jobId, definitionSha256: nextInput.job.definitionSha256 },
    },
    snapshot: nextInput,
  });
  const { job, cancellation } = next;
  const common = {
    schemaVersion: "0.1",
    aggregateType: "policy.evaluation.job",
    // The shared outbox key is tenant-wide; exact job digests include project/environment.
    aggregateId: `pej_${job.definitionSha256.slice(0, 60)}`,
    tenantId: job.scope.tenantId,
  } as const;
  const payload = {
    environmentId: job.scope.environmentId,
    projectId: job.scope.projectId,
    jobId: job.jobId,
    jobDefinitionSha256: job.definitionSha256,
    evaluationRequestId: job.request.evaluationRequestId,
    requestDefinitionSha256: job.request.definitionSha256,
  };
  const intents: PolicyEvaluationJobOutboxIntent[] = [];
  if (previous === null)
    intents.push({
      ...common,
      createdAt: job.createdAt,
      eventType: "policy.evaluation.job.created",
      payload,
    });
  if (cancellation !== null && previous?.cancellation == null)
    intents.push({
      ...common,
      createdAt: cancellation.requestedAt,
      eventType: "policy.evaluation.job.cancellation-requested",
      payload: {
        ...payload,
        cancellationId: cancellation.cancellationId,
        requestedByPrincipalId: cancellation.requestedByPrincipalId,
        reason: cancellation.reason,
      },
    });
  if (job.terminal !== null && previous?.job.terminal == null)
    intents.push({
      ...common,
      createdAt: job.terminal.committedAt,
      eventType: "policy.evaluation.job.terminal",
      payload: {
        ...payload,
        status: job.terminal.status,
        code: job.terminal.code,
        stateVersion: job.stateVersion,
        ...(job.result === null
          ? {}
          : {
              resultId: job.result.evaluationId,
              resultDefinitionSha256: job.result.definitionSha256,
            }),
      },
    });
  return intents;
}
