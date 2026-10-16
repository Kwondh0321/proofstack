import {
  policyEvaluationSnapshotReadIdentity,
  requirePolicyEvaluationSnapshotPageIndex,
  type PolicyEvaluationSnapshotReadIdentity,
  type PolicyEvaluationSnapshotReader,
} from "@proofstack/core";
import { PostgresPolicyEvaluationJobReader } from "./postgres-policy-evaluation-job-base.js";
import {
  readPostgresPolicySnapshotOnClient,
  readPostgresPolicySnapshotPageOnClient,
} from "./postgres-policy-snapshot-readers.js";

/** Exact immutable root/page reads; original receipts never establish current execution authority. */
export class PostgresPolicySnapshotRepository
  extends PostgresPolicyEvaluationJobReader
  implements PolicyEvaluationSnapshotReader
{
  async findSnapshot(input: PolicyEvaluationSnapshotReadIdentity) {
    const expected = policyEvaluationSnapshotReadIdentity(input);
    return this.transact(expected.scope, (client) =>
      readPostgresPolicySnapshotOnClient(client, expected),
    );
  }
  async readSnapshotPage(input: PolicyEvaluationSnapshotReadIdentity, indexInput: number) {
    const expected = policyEvaluationSnapshotReadIdentity(input);
    const index = requirePolicyEvaluationSnapshotPageIndex(indexInput);
    return this.transact(expected.scope, (client) =>
      readPostgresPolicySnapshotPageOnClient(client, expected, index),
    );
  }
}
