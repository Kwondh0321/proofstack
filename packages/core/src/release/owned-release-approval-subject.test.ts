import { beforeAll, describe, expect, it, vi } from "vitest";
import { ReleaseApprovalSubjectSchema } from "@proofstack/contracts";
import { MemoryPolicyEvaluationJobRepository } from "../testing/memory-policy-evaluation-job-repository.js";
import { policySnapshotRepositoryFixture } from "../testing/policy-snapshot-repository-fixture.js";
import { releasePolicySelectionRepositoryFixture } from "../testing/release-policy-selection-repository-fixtures.js";
import { releasePolicySelectionReference } from "./release-authority-record-validation.js";
import { readOwnedReleaseApprovalSubject } from "./owned-release-approval-subject.js";
import { ReleaseDecisionVerificationBudget } from "./release-decision-verification-budget.js";

const limits = {
  maxAcquisitionRecords: 10000,
  maxAcquisitionRecordBytes: 16 * 1024 * 1024,
  maxApprovalRecords: 0,
};
async function completed(
  index: number,
  repository: MemoryPolicyEvaluationJobRepository,
  setTime: (value: string) => void,
) {
  const f = policySnapshotRepositoryFixture(index);
  setTime(f.request.createdAt);
  await repository.createJob({ request: f.request, jobId: f.jobId });
  const claimed = await repository.claimJob({
    scope: f.scope,
    jobId: f.jobId,
    workerId: f.workerId,
    attemptId: "attempt_owning_approval",
    leaseId: "lease_owning_approval",
  });
  const fence = claimed.job.currentLease!.mutationFence;
  setTime(f.publicationAt);
  const sealed = await repository.publishSnapshot({
    scope: f.scope,
    fence,
    pageSet: f.pageSet,
    principalId: f.workerId,
  });
  await repository.startComputation({ scope: f.scope, fence });
  await repository.reserveWork({
    scope: f.scope,
    fence,
    reservationId: "reservation_owning_approval_rules",
    delta: {
      reads: 0,
      records: 0,
      recordBytes: 0,
      references: 0,
      referenceBytes: 0,
      artifactReadBytes: 0,
      ruleEvaluations: f.inputs.rules.ruleCount,
    },
  });
  const result = await repository.publishResult({
    scope: f.scope,
    fence,
    evaluationId: f.evaluationId,
    pageSet: f.pageSet,
  });
  const rule = f.inputs.roots.policy.rules.find(
    ({ predicate }) => predicate.kind === "approval_required",
  );
  if (!rule || !result.snapshot.job.snapshot || !result.snapshot.job.result)
    throw new Error("Missing real completed fixture subject");
  const subject = ReleaseApprovalSubjectSchema.parse({
    scope: f.scope,
    // Selection is deliberately outside this historical C3 acquisition boundary.
    selection: releasePolicySelectionReference(
      releasePolicySelectionRepositoryFixture("owning_approval_subject").original,
    ),
    candidate: f.request.candidate,
    policy: f.request.policy,
    request: result.snapshot.job.request,
    snapshot: result.snapshot.job.snapshot,
    evaluation: result.snapshot.job.result,
    jobId: f.jobId,
    ruleId: rule.ruleId,
  });
  return { f, subject, sealed, result };
}
type Fixture = Awaited<ReturnType<typeof completed>>;
let original: Fixture;
let repository: MemoryPolicyEvaluationJobRepository;
let tenants: Fixture[];
beforeAll(async () => {
  let now = "2026-10-15T00:00:00Z";
  repository = new MemoryPolicyEvaluationJobRepository({ now: () => now });
  tenants = [];
  for (const index of [0, 1, 2])
    tenants.push(
      await completed(index, repository, (value) => {
        now = value;
      }),
    );
  original = tenants[0]!;
});
function context(f = original, source = repository.fork()) {
  const readers = {
    findJobForRequest: vi.fn(source.findJobForRequest.bind(source)),
    findSnapshot: vi.fn(source.findSnapshot.bind(source)),
    readSnapshotPage: vi.fn(source.readSnapshotPage.bind(source)),
    findResult: vi.fn(source.findResult.bind(source)),
  };
  return {
    source,
    readers,
    input: {
      scope: structuredClone(f.f.scope),
      subject: structuredClone(f.subject),
      capturedAt: f.f.publicationAt,
      readers,
      budget: new ReleaseDecisionVerificationBudget(limits),
    },
  };
}
async function rejected(input: Parameters<typeof readOwnedReleaseApprovalSubject>[0]) {
  await expect(readOwnedReleaseApprovalSubject(input)).rejects.toThrow();
  expect(() => input.budget.snapshot()).toThrow();
  await expect(
    readOwnedReleaseApprovalSubject({ ...context().input, budget: input.budget }),
  ).rejects.toThrow();
}
describe("owning original evaluation acquisition for an exact approval subject", () => {
  it("recomputes the real completed job/seal/result and preserves the unevaluated approval prerequisite", async () => {
    const { input, readers } = context();
    const value = await readOwnedReleaseApprovalSubject(input);
    expect(value.authorityBoundary).toBe("original_evaluation_subject_only");
    expect(value.subject).toEqual(original.subject);
    expect(value.original.jobGraph).toEqual(original.result.snapshot);
    expect(value.original.snapshot).toEqual(original.sealed.snapshot);
    expect(value.original.pageSet).toEqual(original.f.pageSet);
    expect(value.original.evaluation).toEqual(original.result.evaluation);
    expect(value.rule.predicate.kind).toBe("approval_required");
    expect(value.ruleResult).toMatchObject({
      outcome: "indeterminate",
      evidence: { kind: "not_evaluated", reason: "approval_not_evaluated" },
    });
    expect(value.candidate.createdByPrincipalId).toBe(
      original.f.inputs.roots.candidate.createdByPrincipalId,
    );
    expect(value.policy.publishedByPrincipalId).toBe(
      original.f.inputs.roots.policy.publishedByPrincipalId,
    );
    expect(readers.findJobForRequest).toHaveBeenCalledExactlyOnceWith(
      input.scope,
      input.subject.request,
    );
    expect(readers.readSnapshotPage).toHaveBeenCalledTimes(original.sealed.snapshot.pages.length);
    expect(input.budget.snapshot().approvalRecords).toBe(0);
    expect(value).not.toHaveProperty("currentAuthority");
  });
  it.each([
    "approval_required",
    "artifact_required",
    "comparison_threshold",
    "coverage_floor",
    "eligibility_required",
    "safety_event_ceiling",
    "uncertainty_bound",
  ])(
    "retains the exact original %s rule without deciding current approval or exception eligibility",
    async (kind) => {
      const { input } = context();
      const rule = original.f.inputs.roots.policy.rules.find(
        ({ predicate }) => predicate.kind === kind,
      );
      if (!rule) throw new Error("Missing retained original rule");
      input.subject.ruleId = rule.ruleId;
      const value = await readOwnedReleaseApprovalSubject(input);
      expect(value.rule).toEqual(rule);
      expect(value.ruleResult).toEqual(
        original.result.evaluation.rules.find(({ ruleId }) => ruleId === rule.ruleId),
      );
    },
  );
  it("reads three fully populated tenants with colliding job, snapshot and result IDs", async () => {
    expect(new Set(tenants.map(({ subject }) => subject.scope.tenantId)).size).toBe(3);
    for (const key of ["jobId", "snapshot", "evaluation"] as const)
      expect(
        new Set(
          tenants.map(({ subject }) =>
            key === "jobId"
              ? subject[key]
              : key === "snapshot"
                ? subject.snapshot.snapshotId
                : subject.evaluation.evaluationId,
          ),
        ).size,
      ).toBe(1);
    for (const f of tenants) {
      const value = await readOwnedReleaseApprovalSubject(context(f).input);
      expect(value.subject.scope).toEqual(f.f.scope);
      expect(value.original.evaluation).toEqual(f.result.evaluation);
      expect(value.candidate).toEqual(f.f.inputs.roots.candidate);
    }
  });
  it("owns returned records and retains full-precision cuts without changing original bytes", async () => {
    const { input } = context();
    input.capturedAt = input.capturedAt.replace("Z", "000000000000000000000000001Z");
    const value = await readOwnedReleaseApprovalSubject(input);
    expect(value.original.capturedAt).toBe(input.capturedAt);
    value.original.evaluation.recordedByPrincipalId = "mutated_return";
    value.rule.rationale = "Mutated returned rule";
    expect(
      await repository.findResult(original.f.scope, original.f.jobId, original.f.pageSet),
    ).toEqual(original.result.evaluation);
    expect(
      original.f.inputs.roots.policy.rules.find(({ ruleId }) => ruleId === value.rule.ruleId)
        ?.rationale,
    ).not.toBe("Mutated returned rule");
  });
  it.each(["tenantId", "projectId", "environmentId"] as const)(
    "rejects a substituted server %s before any source lookup",
    async (key) => {
      const { input, readers } = context();
      input.scope[key] = "scope_other";
      await rejected(input);
      expect(readers.findJobForRequest).not.toHaveBeenCalled();
    },
  );
  it.each(["candidate", "policy", "snapshot", "evaluation"] as const)(
    "rejects a substituted %s digest before descendants",
    async (key) => {
      const { input, readers } = context();
      input.subject[key].definitionSha256 = "e".repeat(64);
      await rejected(input);
      expect(readers.findJobForRequest).toHaveBeenCalledExactlyOnceWith(
        input.scope,
        input.subject.request,
      );
      expect(readers.findSnapshot).not.toHaveBeenCalled();
    },
  );
  it("derives the job from its request rather than using a substituted caller job ID", async () => {
    const { input, readers } = context();
    input.subject.jobId = "job_caller_selected";
    await rejected(input);
    expect(readers.findJobForRequest).toHaveBeenCalledExactlyOnceWith(
      input.scope,
      original.subject.request,
    );
    expect(readers.findSnapshot).not.toHaveBeenCalled();
  });
  it("rejects a request digest mismatch through the real owning request index", async () => {
    const { input, readers } = context();
    input.subject.request.definitionSha256 = "d".repeat(64);
    await rejected(input);
    expect(readers.findSnapshot).not.toHaveBeenCalled();
  });
  it("rejects a known request from another populated tenant before reading colliding snapshots", async () => {
    const { input, readers } = context(tenants[1]);
    input.subject.request = structuredClone(original.subject.request);
    await rejected(input);
    expect(readers.findSnapshot).not.toHaveBeenCalled();
  });
  it("rejects a missing original request and an actual queued job without selecting another completed result", async () => {
    let now = original.f.request.createdAt;
    const queued = new MemoryPolicyEvaluationJobRepository({ now: () => now });
    const absent = context(original, queued);
    await rejected(absent.input);
    await queued.createJob({ request: original.f.request, jobId: original.f.jobId });
    now = original.f.publicationAt;
    const pending = context(original, queued);
    await rejected(pending.input);
    expect(pending.readers.findSnapshot).not.toHaveBeenCalled();
  });
  it("rejects an original completed after the acquired cut before descendant reads", async () => {
    const { input, readers } = context();
    input.capturedAt = original.f.inputs.capturedAt;
    await rejected(input);
    expect(readers.findSnapshot).not.toHaveBeenCalled();
  });
  it("rejects a rule not present in the recomputed original policy/result", async () => {
    const { input, readers } = context();
    input.subject.ruleId = "rule_not_in_original";
    await rejected(input);
    expect(readers.findResult).toHaveBeenCalledTimes(1);
  });
  it.each(["findJobForRequest", "findSnapshot", "readSnapshotPage", "findResult"] as const)(
    "taints the whole cut on a caught %s failure",
    async (method) => {
      const { input, readers } = context();
      readers[method].mockRejectedValueOnce(new Error("Owning storage failed"));
      await rejected(input);
    },
  );
  it.each(["findSnapshot", "readSnapshotPage", "findResult"] as const)(
    "rejects missing %s material without accepting a partial original",
    async (method) => {
      const { input, readers } = context();
      readers[method].mockResolvedValueOnce(null);
      await rejected(input);
    },
  );
  it("recomputes the original result instead of trusting a retained forged verdict", async () => {
    const { input, readers } = context();
    const value = structuredClone(original.result.evaluation);
    value.recordedByPrincipalId = "worker_substituted";
    readers.findResult.mockResolvedValueOnce(value);
    await rejected(input);
  });
  it("rejects a damaged sealed page before reading the result", async () => {
    const { input, readers } = context();
    const page = structuredClone(original.f.pageSet.pages[0]);
    if (!page) throw new Error("Missing actual sealed page");
    page.definitionSha256 = "a".repeat(64);
    readers.readSnapshotPage.mockResolvedValueOnce(page);
    await rejected(input);
    expect(readers.findResult).not.toHaveBeenCalled();
  });
  it("admits the exact cumulative record and byte budget", async () => {
    const f = context();
    await readOwnedReleaseApprovalSubject(f.input);
    const used = f.input.budget.snapshot();
    const exact = context();
    exact.input.budget = new ReleaseDecisionVerificationBudget({
      ...limits,
      maxAcquisitionRecords: used.records,
      maxAcquisitionRecordBytes: used.recordBytes,
    });
    await readOwnedReleaseApprovalSubject(exact.input);
    expect(exact.input.budget.snapshot()).toEqual(used);
  });
  it.each(["maxAcquisitionRecords", "maxAcquisitionRecordBytes"] as const)(
    "rejects cumulative admission one below %s",
    async (limit) => {
      const baseline = context();
      await readOwnedReleaseApprovalSubject(baseline.input);
      const used = baseline.input.budget.snapshot();
      const below = context();
      below.input.budget = new ReleaseDecisionVerificationBudget({
        ...limits,
        maxAcquisitionRecords: used.records,
        maxAcquisitionRecordBytes: used.recordBytes,
        [limit]: (limit === "maxAcquisitionRecords" ? used.records : used.recordBytes) - 1,
      });
      await rejected(below.input);
    },
  );
  it("rejects insufficient initial byte admission before opening a source read", async () => {
    const beforeRead = context();
    beforeRead.input.budget = new ReleaseDecisionVerificationBudget({
      ...limits,
      maxAcquisitionRecordBytes: 1,
    });
    await rejected(beforeRead.input);
    expect(beforeRead.readers.findJobForRequest).not.toHaveBeenCalled();
  });
  it("requires a real meter and rejects already-failed admission before any read", async () => {
    const fake = context();
    fake.input.budget = {
      observe() {},
      snapshot() {},
    } as unknown as ReleaseDecisionVerificationBudget;
    await expect(readOwnedReleaseApprovalSubject(fake.input)).rejects.toThrow();
    expect(fake.readers.findJobForRequest).not.toHaveBeenCalled();
    const f = context();
    expect(() => f.input.budget.rejectSourceRead(new Error("Earlier owning failure"))).toThrow();
    await rejected(f.input);
    expect(f.readers.findJobForRequest).not.toHaveBeenCalled();
  });
});
