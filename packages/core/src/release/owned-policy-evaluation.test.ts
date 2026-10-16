import { describe, expect, it } from "vitest";
import { digestPolicyEvaluationDefinition } from "../policy/policy-evaluation-result-record-validation.js";
import { ownedPolicyEvaluationFixture as fixture } from "../testing/owned-policy-evaluation-fixture.js";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "./release-decision-verification-budget.js";
import {
  inspectOwnedPolicyEvaluation,
  InvalidOwnedPolicyEvaluationError,
} from "./owned-policy-evaluation.js";

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
