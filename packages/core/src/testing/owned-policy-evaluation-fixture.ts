import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  PolicyEvaluationSnapshotSchema,
  type PolicyEvaluationSnapshotInputs,
  encodeEvaluationCanonicalJson,
} from "@proofstack/contracts";
import { MemoryPolicyEvaluationJobRepository } from "./memory-policy-evaluation-job-repository.js";
import { assemblePolicyEvaluationSnapshot } from "../policy/policy-evaluation-snapshot.js";
import { computeSealedPolicyEvaluation } from "../policy/compute-sealed-policy-evaluation.js";
import { digestPolicyEvaluationDefinition } from "../policy/policy-evaluation-result-record-validation.js";
import { digestPolicyEvaluationRequestDefinition } from "../policy/policy-evaluation-request-record-validation.js";
import { assemblePolicyEvaluationManifest } from "../policy/policy-evaluation-manifest.js";
import {
  sealPolicyEvaluationJob,
  startPolicyEvaluationComputation,
} from "../policy/policy-evaluation-scheduler-seal.js";
import { reservePolicyEvaluationUsage } from "../policy/policy-evaluation-scheduler-budget.js";
import { completePolicyEvaluationJob } from "../policy/policy-evaluation-scheduler-complete.js";
import { ReleaseDecisionVerificationBudget } from "../release/release-decision-verification-budget.js";

/** Standalone historical C3 model; it does not publish a C4 input or assert current authority. */
export async function ownedPolicyEvaluationFixture(model?: "new_request_at_capture_cut") {
  const inputs = JSON.parse(
    readFileSync(
      new URL(
        "../../../contracts/vectors/policy-evaluation-snapshot-inputs-v2.fixture.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as PolicyEvaluationSnapshotInputs;
  if (model === "new_request_at_capture_cut") {
    // Build a NEW synthetic request before enqueue/seal/computation. This is not a rewrite of an
    // existing snapshot, real I/O receipt or captured/native authority. Source bodies remain fixed;
    // component cut labels below are synthetic model inputs, never authenticated observations.
    inputs.request.evaluationRequestId = "request_new_current_cut_model";
    inputs.request.evaluationTime = inputs.capturedAt;
    const {
      schemaVersion: _version,
      scope,
      definitionSha256: _sha,
      createdAt: _at,
      createdByPrincipalId: _by,
      ...definition
    } = inputs.request;
    inputs.request.definitionSha256 = digestPolicyEvaluationRequestDefinition(scope, definition);
    const reference = {
      evaluationRequestId: inputs.request.evaluationRequestId,
      definitionSha256: inputs.request.definitionSha256,
    };
    inputs.sources.records.request = reference;
    inputs.rules.request = reference;
    inputs.manifest = assemblePolicyEvaluationManifest({
      manifestId: "manifest_new_current_cut_model",
      request: reference,
      scope,
      entries: inputs.sources.records.records.map(({ entry }) => entry),
    });
    for (const component of [
      inputs.sources.records,
      inputs.rules,
      inputs.policyAuthority,
      ...Object.values(inputs.policyLifecycle),
      inputs.applicability,
      inputs.applicability.lifecycle,
      ...Object.values(inputs.candidateAuthority),
      ...Object.values(inputs.criterionAuthority),
      ...inputs.artifacts,
      ...inputs.storedArtifacts,
    ]) {
      if (component && "evaluationTime" in component) component.evaluationTime = inputs.capturedAt;
    }
    for (const lifecycle of [
      inputs.applicability.lifecycle,
      ...Object.values(inputs.policyLifecycle),
    ]) {
      const {
        startedAt: _start,
        completedAt: _end,
        state: _state,
        observationSha256: _digest,
        ...material
      } = lifecycle;
      lifecycle.observationSha256 = createHash("sha256")
        .update(
          encodeEvaluationCanonicalJson({
            format: "proofstack.policy-lifecycle-observation.v1",
            ...material,
          }),
        )
        .digest("hex");
    }
  }
  inputs.request.createdAt = inputs.capturedAt;
  const repository = new MemoryPolicyEvaluationJobRepository({ now: () => inputs.capturedAt });
  await repository.createJob({ request: inputs.request, jobId: "job_owned_original" });
  const claimed = await repository.claimJob({
    scope: inputs.request.scope,
    jobId: "job_owned_original",
    workerId: "worker_owned_original",
    attemptId: "attempt_owned_original",
    leaseId: "lease_owned_original",
  });
  const lease = claimed.job.currentLease;
  if (!lease) throw new Error("Missing actual claimed lease");
  const fence = lease.mutationFence;
  const pageSet = assemblePolicyEvaluationSnapshot({
    snapshotId: "snapshot_owned_original",
    inputs,
  });
  const reference = {
    snapshotId: pageSet.definition.snapshotId,
    definitionSha256: pageSet.definitionSha256,
  };
  const sealedAt = "2026-10-01T02:00:00.001Z";
  const completedAt = "2026-10-01T02:00:00.002Z";
  const snapshot = PolicyEvaluationSnapshotSchema.parse({
    ...pageSet.definition,
    ...fence,
    scope: inputs.request.scope,
    schemaVersion: "0.1",
    definitionSha256: pageSet.definitionSha256,
    sealedAt,
    recordedAt: sealedAt,
    sealedByPrincipalId: fence.workerId,
  });
  const transition = { now: sealedAt, recoveryEpoch: 0, fence };
  const sealed = sealPolicyEvaluationJob({
    ...transition,
    snapshot: claimed,
    sealedSnapshot: reference,
  });
  const running = startPolicyEvaluationComputation({ ...transition, snapshot: sealed });
  const reserved = reservePolicyEvaluationUsage({
    ...transition,
    snapshot: running,
    delta: {
      reads: 0,
      records: 0,
      recordBytes: 0,
      references: 0,
      referenceBytes: 0,
      artifactReadBytes: 0,
      ruleEvaluations: inputs.rules.ruleCount,
    },
  });
  const expected = {
    scope: inputs.request.scope,
    jobId: claimed.job.jobId,
    request: claimed.job.request,
    snapshot: reference,
  };
  const definition = computeSealedPolicyEvaluation({
    evaluationId: "evaluation_owned_original",
    expected,
    record: snapshot,
    pageSet,
  });
  const evaluation = {
    ...definition,
    ...fence,
    scope: inputs.request.scope,
    schemaVersion: "0.1" as const,
    definitionSha256: digestPolicyEvaluationDefinition(inputs.request.scope, definition),
    recordedAt: completedAt,
    recordedByPrincipalId: fence.workerId,
  };
  const jobGraph = completePolicyEvaluationJob({
    ...transition,
    now: completedAt,
    snapshot: reserved,
    result: {
      evaluationId: evaluation.evaluationId,
      definitionSha256: evaluation.definitionSha256,
    },
    ruleCount: definition.ruleCount,
  });
  return {
    expected: {
      scope: expected.scope,
      request: expected.request,
      job: { jobId: jobGraph.job.jobId, definitionSha256: jobGraph.job.definitionSha256 },
    },
    jobGraph,
    snapshot,
    pageSet,
    evaluation,
    capturedAt: "2026-10-01T02:00:00.003Z",
    budget: new ReleaseDecisionVerificationBudget({
      maxAcquisitionRecords: 10_000,
      maxAcquisitionRecordBytes: 64 * 1024 * 1024,
      maxApprovalRecords: 4_096,
    }),
  };
}
