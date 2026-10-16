import {
  PolicyEvaluationSnapshotSchema,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationSnapshot,
  type PolicyEvaluationSnapshotPageSet,
} from "@proofstack/contracts";
import { validatePolicyEvaluationResultRecord } from "@proofstack/core";
import type { PoolClient } from "pg";
import { PostgresPolicyEvaluationJobContractError } from "./postgres-policy-evaluation-job-errors.js";
import {
  readPolicyJobValue,
  readPostgresPolicyEvaluationJobOnClient,
} from "./postgres-policy-evaluation-job-readers.js";

/** Shared immutable validation for owning publication and provided-client historical reads. */
export function validatePostgresStoredPolicyResult(
  job: PolicyEvaluationJobSnapshot,
  record: unknown,
  original: PolicyEvaluationSnapshot,
  pageSet: PolicyEvaluationSnapshotPageSet,
) {
  const result = job.job.result;
  const terminal = job.job.terminal;
  const attempt = job.attempts.find(
    (entry) => entry.mutationFence.attemptId === terminal?.attemptId,
  );
  const snapshot = job.job.snapshot;
  if (
    job.job.status !== "completed" ||
    !result ||
    !terminal ||
    !attempt ||
    attempt.closure?.status !== "completed" ||
    attempt.closure.committedAt !== terminal.committedAt ||
    serializeEvaluationCanonicalJson(attempt.snapshot) !==
      serializeEvaluationCanonicalJson(snapshot) ||
    !snapshot
  )
    throw new PostgresPolicyEvaluationJobContractError(
      "Policy result omitted its deciding closed attempt",
    );
  return validatePolicyEvaluationResultRecord({
    expected: {
      scope: job.job.scope,
      jobId: job.job.jobId,
      request: job.job.request,
      snapshot,
      result,
      fence: attempt.mutationFence,
      completedAt: terminal.committedAt,
    },
    record,
    snapshotRecord: original,
    pageSet,
  });
}

/** Recompute an original result on the caller's client. No current publication authority. */
export async function readPostgresPolicyEvaluationResultOnClient(
  client: Pick<PoolClient, "query">,
  scope: EvidenceScope,
  jobId: string,
  pageSet: PolicyEvaluationSnapshotPageSet,
) {
  const job = await readPostgresPolicyEvaluationJobOnClient(client, scope, jobId);
  if (job === null) return null;
  const reference = job.job.result;
  if (!reference) return null;
  const record = await readPolicyJobValue(
    client,
    "SELECT public.proofstack_read_policy_evaluation_result($1,$2) AS value",
    [reference.evaluationId, reference.definitionSha256],
  );
  const snapshot = job.job.snapshot;
  if (!snapshot)
    throw new PostgresPolicyEvaluationJobContractError("Policy result omitted original seal");
  const original = PolicyEvaluationSnapshotSchema.parse(
    await readPolicyJobValue(
      client,
      "SELECT public.proofstack_read_policy_snapshot($1,$2) AS value",
      [snapshot.snapshotId, snapshot.definitionSha256],
    ),
  );
  return validatePostgresStoredPolicyResult(job, record, original, pageSet);
}
