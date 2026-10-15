import {
  policyEvaluationSnapshotReadIdentity,
  requirePolicyEvaluationSnapshotPageIndex,
  validatePolicyEvaluationStoredSnapshotHeader,
  validatePolicyEvaluationStoredSnapshotPage,
  validatePolicyEvaluationStoredSnapshotJob,
  type PolicyEvaluationSnapshotReadIdentity,
  type PolicyEvaluationSnapshotReader,
} from "@proofstack/core";
import type { PoolClient } from "pg";
import {
  PostgresPolicyEvaluationJobReader,
  PostgresPolicyEvaluationJobContractError,
} from "./postgres-policy-evaluation-job-base.js";

/** Exact immutable root/page reads; original receipts never establish current execution authority. */
export class PostgresPolicySnapshotRepository
  extends PostgresPolicyEvaluationJobReader
  implements PolicyEvaluationSnapshotReader
{
  private async rootOnClient(client: PoolClient, expected: PolicyEvaluationSnapshotReadIdentity) {
    const raw = await this.one(
      client,
      "SELECT public.proofstack_read_policy_snapshot($1,$2) AS value",
      [expected.snapshot.snapshotId, expected.snapshot.definitionSha256],
    );
    if (raw === null) return null;
    const root = validatePolicyEvaluationStoredSnapshotHeader(expected, raw).record;
    const rawJob = await this.one(
      client,
      "SELECT public.proofstack_read_policy_evaluation_job($1) AS value",
      [expected.job.jobId],
    );
    const { job } = validatePolicyEvaluationStoredSnapshotJob(expected, root, rawJob);
    await this.lastOnClient(client, expected.scope, job);
    await this.verifyIntents(client, job);
    return root;
  }
  async findSnapshot(input: PolicyEvaluationSnapshotReadIdentity) {
    const expected = policyEvaluationSnapshotReadIdentity(input);
    return this.transact(expected.scope, (client) => this.rootOnClient(client, expected));
  }
  async readSnapshotPage(input: PolicyEvaluationSnapshotReadIdentity, indexInput: number) {
    const expected = policyEvaluationSnapshotReadIdentity(input);
    const index = requirePolicyEvaluationSnapshotPageIndex(indexInput);
    return this.transact(expected.scope, async (client) => {
      const root = await this.rootOnClient(client, expected);
      if (root === null) return null;
      if (!root.pages[index])
        throw new PostgresPolicyEvaluationJobContractError(
          "Snapshot page is outside its exact root",
        );
      const raw = await this.one(
        client,
        "SELECT public.proofstack_read_policy_snapshot_page($1,$2,$3) AS value",
        [expected.snapshot.snapshotId, expected.snapshot.definitionSha256, index],
      );
      return validatePolicyEvaluationStoredSnapshotPage(expected, root, index, raw);
    });
  }
}
