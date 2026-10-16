import {
  policyEvaluationSnapshotReadIdentity,
  requirePolicyEvaluationSnapshotPageIndex,
  validatePolicyEvaluationStoredSnapshotHeader,
  validatePolicyEvaluationStoredSnapshotJob,
  validatePolicyEvaluationStoredSnapshotPage,
  type PolicyEvaluationSnapshotReadIdentity,
} from "@proofstack/core";
import type { PoolClient } from "pg";
import { PostgresPolicyEvaluationJobContractError } from "./postgres-policy-evaluation-job-errors.js";
import {
  readPolicyJobLastHistoryOnClient,
  readPolicyJobValue,
  verifyPolicyJobIntentsOnClient,
} from "./postgres-policy-evaluation-job-readers.js";

type Client = Pick<PoolClient, "query">;

/** Immutable original header/history/outbox checks only. Caller retains scope and guards. */
export async function readPostgresPolicySnapshotOnClient(
  client: Client,
  input: PolicyEvaluationSnapshotReadIdentity,
) {
  const expected = policyEvaluationSnapshotReadIdentity(input);
  const raw = await readPolicyJobValue(
    client,
    "SELECT public.proofstack_read_policy_snapshot($1,$2) AS value",
    [expected.snapshot.snapshotId, expected.snapshot.definitionSha256],
  );
  if (raw === null) return null;
  const root = validatePolicyEvaluationStoredSnapshotHeader(expected, raw).record;
  const rawJob = await readPolicyJobValue(
    client,
    "SELECT public.proofstack_read_policy_evaluation_job($1) AS value",
    [expected.job.jobId],
  );
  const { job } = validatePolicyEvaluationStoredSnapshotJob(expected, root, rawJob);
  await readPolicyJobLastHistoryOnClient(client, expected.scope, job);
  await verifyPolicyJobIntentsOnClient(client, job);
  return root;
}

/** Fixed exact page read on the same client, retaining all original root/graph checks. */
export async function readPostgresPolicySnapshotPageOnClient(
  client: Client,
  input: PolicyEvaluationSnapshotReadIdentity,
  indexInput: number,
) {
  const expected = policyEvaluationSnapshotReadIdentity(input);
  const index = requirePolicyEvaluationSnapshotPageIndex(indexInput);
  const root = await readPostgresPolicySnapshotOnClient(client, expected);
  if (root === null) return null;
  if (!root.pages[index])
    throw new PostgresPolicyEvaluationJobContractError("Snapshot page is outside its exact root");
  const raw = await readPolicyJobValue(
    client,
    "SELECT public.proofstack_read_policy_snapshot_page($1,$2,$3) AS value",
    [expected.snapshot.snapshotId, expected.snapshot.definitionSha256, index],
  );
  return validatePolicyEvaluationStoredSnapshotPage(expected, root, index, raw);
}
