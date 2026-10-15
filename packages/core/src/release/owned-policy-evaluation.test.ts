import { readFileSync } from "node:fs";
import {
  PolicyEvaluationSnapshotSchema,
  type PolicyEvaluationSnapshotInputs,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { MemoryPolicyEvaluationJobRepository } from "../testing/memory-policy-evaluation-job-repository.js";
import { assemblePolicyEvaluationSnapshot } from "../policy/policy-evaluation-snapshot.js";
import { computeSealedPolicyEvaluation } from "../policy/compute-sealed-policy-evaluation.js";
import { digestPolicyEvaluationDefinition } from "../policy/policy-evaluation-result-record-validation.js";
import {
  sealPolicyEvaluationJob,
  startPolicyEvaluationComputation,
} from "../policy/policy-evaluation-scheduler-seal.js";
import { reservePolicyEvaluationUsage } from "../policy/policy-evaluation-scheduler-budget.js";
import { completePolicyEvaluationJob } from "../policy/policy-evaluation-scheduler-complete.js";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "./release-decision-verification-budget.js";
import {
  inspectOwnedPolicyEvaluation,
  InvalidOwnedPolicyEvaluationError,
} from "./owned-policy-evaluation.js";

/** Standalone historical C3 model; it does not publish a C4 input or assert current authority. */
async function fixture() {
  const inputs = JSON.parse(
    readFileSync(
      new URL(
        "../../../contracts/vectors/policy-evaluation-snapshot-inputs-v2.fixture.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as PolicyEvaluationSnapshotInputs;
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
describe("owning original policy graph and sealed evidence, never fresh publication authority", () => {
  it("recomputes original outcomes and exposes underlying unavailable approval-only prerequisites", async () => {
    const value = await fixture();
    const result = inspectOwnedPolicyEvaluation(value);
    expect(result.evaluation).toEqual(value.evaluation);
    const approval = result.evaluation.rules.find(
      ({ predicateKind }) => predicateKind === "approval_required",
    );
    expect(approval).toMatchObject({
      outcome: "indeterminate",
      evidence: { kind: "not_evaluated", reason: "approval_not_evaluated" },
    });
    expect(result.prerequisites.originalPolicyState).toBe("authority_unavailable");
    expect(result.prerequisites.candidateAuthority).toBe("unavailable");
    expect(result.policy.policyVersionId).toBe(value.jobGraph.request.policy.policyVersionId);
    expect(result.candidate.candidateVersionId).toBe(
      value.jobGraph.request.candidate.candidateVersionId,
    );
    expect(result.originalSourceWitnesses.length).toBeGreaterThan(0);
  });
  it("owns its results without mutating caller graph, pages or source receipts", async () => {
    const value = await fixture();
    const before = structuredClone({
      graph: value.jobGraph,
      snapshot: value.snapshot,
      pages: value.pageSet,
      evaluation: value.evaluation,
    });
    const result = inspectOwnedPolicyEvaluation(value);
    result.job.createdByPrincipalId = "user_other";
    expect({
      graph: value.jobGraph,
      snapshot: value.snapshot,
      pages: value.pageSet,
      evaluation: value.evaluation,
    }).toEqual(before);
  });
  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects another owning %s",
    async (field) => {
      const value = await fixture();
      value.expected.scope = { ...value.expected.scope, [field]: "scope_other" };
      expect(() => inspectOwnedPolicyEvaluation(value)).toThrow(InvalidOwnedPolicyEvaluationError);
    },
  );
  it.each([
    "request",
    "job",
    "sealing_worker",
    "deciding_worker",
    "future_cut",
    "original_request_receipt",
  ])("rejects substituted original %s", async (kind) => {
    const value = await fixture();
    if (kind === "request")
      value.expected.request = { ...value.expected.request, evaluationRequestId: "request_other" };
    if (kind === "job")
      value.expected.job = { ...value.expected.job, definitionSha256: "0".repeat(64) };
    if (kind === "sealing_worker") {
      value.snapshot.workerId = "worker_other";
      value.snapshot.sealedByPrincipalId = "worker_other";
    }
    if (kind === "deciding_worker") {
      value.evaluation.workerId = "worker_other";
      value.evaluation.recordedByPrincipalId = "worker_other";
    }
    if (kind === "future_cut")
      value.capturedAt = "2026-10-01T02:00:00.001999999999999999999999999999Z";
    if (kind === "original_request_receipt") {
      value.jobGraph.request.createdByPrincipalId = "user_other";
      value.jobGraph.job.createdByPrincipalId = "user_other";
    }
    expect(() => inspectOwnedPolicyEvaluation(value)).toThrow(InvalidOwnedPolicyEvaluationError);
  });
  it("rejects rehashed forged results even with consistently replaced owning result references", async () => {
    const value = await fixture();
    const rule = value.evaluation.rules.find(
      ({ evidence, predicateKind }) =>
        evidence.kind === "not_evaluated" && predicateKind !== "approval_required",
    );
    if (rule?.evidence.kind !== "not_evaluated")
      throw new Error("Missing unavailable original rule");
    rule.evidence.reason = "source_unavailable";
    const {
      schemaVersion: _v,
      scope,
      definitionSha256: _sha,
      recordedAt: _at,
      recordedByPrincipalId: _by,
      jobId: _job,
      attemptId: _attempt,
      workerId: _worker,
      leaseId: _lease,
      fencingToken: _fence,
      recoveryEpoch: _epoch,
      ...definition
    } = value.evaluation;
    value.evaluation.definitionSha256 = digestPolicyEvaluationDefinition(scope, definition);
    if (!value.jobGraph.job.result) throw new Error("Missing original result reference");
    value.jobGraph.job.result.definitionSha256 = value.evaluation.definitionSha256;
    expect(() => inspectOwnedPolicyEvaluation(value)).toThrow(InvalidOwnedPolicyEvaluationError);
  });
  it("charges all original graph rows and complete pages against one aggregate verification budget", async () => {
    const value = await fixture();
    const count = 5 + value.pageSet.pages.length;
    value.budget = new ReleaseDecisionVerificationBudget({
      maxAcquisitionRecords: count,
      maxAcquisitionRecordBytes: 64 * 1024 * 1024,
      maxApprovalRecords: 0,
    });
    inspectOwnedPolicyEvaluation(value);
    expect(value.budget.snapshot().records).toBe(count);
    const shorter = await fixture();
    shorter.budget = new ReleaseDecisionVerificationBudget({
      maxAcquisitionRecords: count - 1,
      maxAcquisitionRecordBytes: 64 * 1024 * 1024,
      maxApprovalRecords: 0,
    });
    expect(() => inspectOwnedPolicyEvaluation(shorter)).toThrow(
      ReleaseDecisionVerificationBudgetError,
    );
    expect(() => shorter.budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
  });
});
