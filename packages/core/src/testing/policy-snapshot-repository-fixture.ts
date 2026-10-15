import { readFileSync } from "node:fs";
import { PolicyEvaluationSnapshotInputsSchema } from "@proofstack/contracts";
import { assemblePolicyEvaluationSnapshot } from "../policy/policy-evaluation-snapshot.js";
import { addPolicyEvaluationMilliseconds } from "../policy/policy-evaluation-scheduler-time.js";

const names = [
  "policy-evaluation-configured-snapshot-inputs-v2.json",
  "policy-evaluation-configured-snapshot-inputs-v2-2dc59837.json",
  "policy-evaluation-configured-snapshot-inputs-v2-35ad83a4.json",
] as const;
const inputDigests = [
  "13a252ac9d42d18574bada286bbd85a2ed6c0f21bd84ef285804d617931074bd",
  "2dc59837672c4a9bc86a0285f29e0d25acc57d7dd12437bfc8c27a8b29d079c0",
  "35ad83a4f984d6c6705d318c4425dba2451d1d1c1107efcc5bed668503d980fb",
] as const;
/** Independently captured synthetic native inputs; no domain relationship/hash is rewritten. */
export function policySnapshotRepositoryFixture(index = 0) {
  const name = names[index];
  if (name === undefined) throw new RangeError("Unknown configured snapshot fixture");
  const inputs = PolicyEvaluationSnapshotInputsSchema.parse(
    JSON.parse(readFileSync(new URL("../../fixtures/" + name, import.meta.url), "utf8")),
  );
  const pageSet = assemblePolicyEvaluationSnapshot({
    snapshotId: "snapshot_repository_conformance",
    inputs,
  });
  if (pageSet.definition.inputSha256 !== inputDigests[index])
    throw new Error("Captured fixture canonical input changed");
  return {
    inputs,
    scope: inputs.request.scope,
    request: inputs.request,
    jobId: "job_snapshot_conformance",
    workerId: "worker_snapshot_conformance",
    evaluationId: "evaluation_snapshot_conformance",
    publicationAt: addPolicyEvaluationMilliseconds(inputs.capturedAt, 1),
    pageSet,
  };
}
