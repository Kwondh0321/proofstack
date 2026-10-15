import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryPolicyEvaluationJobRepository,
  policyJobConformanceRequest,
} from "@proofstack/core/testing";
import {
  reservePolicyAcquisitionForSnapshot,
  type PolicyAcquisitionAdmission,
} from "./acquisition-admission.js";

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const request = policyJobConformanceRequest();
  const jobs = new MemoryPolicyEvaluationJobRepository({ now: () => request.createdAt });
  await jobs.createJob({ request, jobId: "job_admission" });
  const claimed = await jobs.claimJob({
    scope: request.scope,
    jobId: "job_admission",
    workerId: "worker_admission",
    attemptId: "attempt_admission",
    leaseId: "lease_admission",
  });
  const fence = claimed.job.currentLease!.mutationFence;
  const reserveAcquisition = vi.fn(jobs.reserveAcquisition.bind(jobs));
  const findJob = vi.fn(jobs.findJob.bind(jobs));
  const admission: PolicyAcquisitionAdmission = {
    allowanceId: "allowance_admission",
    repository: {
      findJob,
      reserveAcquisition,
      settleAcquisition: jobs.settleAcquisition.bind(jobs),
    },
  };
  return {
    request,
    jobs,
    claimed,
    fence,
    admission,
    reserveAcquisition,
    findJob,
    reserve: () => reservePolicyAcquisitionForSnapshot(request, fence, admission),
  };
}
describe("owning acquisition credit acknowledgement", () => {
  it("validates conservative terminal settlement for unknown drained work", async () => {
    const f = await fixture();
    const credit = await f.reserve();
    const settled = await f.jobs.settleAcquisition({
      scope: f.request.scope,
      fence: f.fence,
      allowanceId: f.admission.allowanceId,
      usage: null,
    });
    expect(credit.validateSettlement(settled, null)).toEqual(settled);
    expect(() =>
      credit.validateSettlement({ ...settled, usage: { ...settled.usage, reads: 0 } }, null),
    ).toThrow();
  });
  it("validates original committed credit and exact observed settlement", async () => {
    const f = await fixture();
    const reserved = await f.reserve();
    reserved.requireLive();
    expect(reserved.allowance.allowanceId).toBe(f.admission.allowanceId);
    const usage = { reads: 2, records: 1, references: 1, recordBytes: 11, referenceBytes: 9 };
    const settled = await f.jobs.settleAcquisition({
      scope: f.request.scope,
      fence: f.fence,
      allowanceId: f.admission.allowanceId,
      usage,
    });
    expect(reserved.validateSettlement(settled, usage)).toEqual(settled);
    for (const key of ["reads", "records", "references", "recordBytes", "referenceBytes"] as const)
      expect(() =>
        reserved.validateSettlement(
          { ...settled, usage: { ...settled.usage, [key]: settled.usage[key] + 1 } },
          usage,
        ),
      ).toThrow();
    expect(() =>
      reserved.validateSettlement(
        { ...settled, usage: { ...settled.usage, ruleEvaluations: 1 } },
        usage,
      ),
    ).toThrow();
    expect(() =>
      reserved.validateSettlement({ ...settled, acquisitionAllowance: reserved.allowance }, usage),
    ).toThrow();
  });
  it.each(["duplicate", "missing", "extra_usage"] as const)(
    "rejects %s acknowledgement without releasing credit",
    async (kind) => {
      const f = await fixture();
      f.reserveAcquisition.mockImplementation(async (command) => {
        const value = await f.jobs.reserveAcquisition(command);
        if (kind === "duplicate") return { ...value, created: false };
        if (kind === "missing") return { ...value, allowance: null };
        return {
          ...value,
          snapshot: { ...value.snapshot, usage: { ...value.snapshot.usage, artifactReadBytes: 1 } },
        };
      });
      await expect(f.reserve()).rejects.toThrow();
      expect(
        (await f.jobs.findJob(f.request.scope, f.fence.jobId))?.acquisitionAllowance,
      ).not.toBeNull();
    },
  );
  it("keeps ambiguously acknowledged committed credit and never retries the mutation", async () => {
    const f = await fixture();
    f.reserveAcquisition.mockImplementation(async (command) => {
      await f.jobs.reserveAcquisition(command);
      throw new Error("lost_acknowledgement");
    });
    await expect(f.reserve()).rejects.toThrow("lost_acknowledgement");
    expect(f.reserveAcquisition).toHaveBeenCalledTimes(1);
    expect(
      (await f.jobs.findJob(f.request.scope, f.fence.jobId))?.acquisitionAllowance?.allowanceId,
    ).toBe(f.admission.allowanceId);
  });
  it("rejects malformed identity before touching the owning repository", async () => {
    const f = await fixture();
    await expect(
      reservePolicyAcquisitionForSnapshot(f.request, f.fence, {
        ...f.admission,
        allowanceId: "invalid!",
      }),
    ).rejects.toThrow();
    expect(f.findJob).not.toHaveBeenCalled();
    expect(f.reserveAcquisition).not.toHaveBeenCalled();
  });
  it("refuses a different valid owning request before reserving or acquiring", async () => {
    const f = await fixture();
    const other = policyJobConformanceRequest({ ...f.request.scope, projectId: "project_other" });
    await expect(
      reservePolicyAcquisitionForSnapshot(other, f.fence, f.admission),
    ).rejects.toThrow();
    expect(f.reserveAcquisition).not.toHaveBeenCalled();
  });
  it("deducts reservation acknowledgement delay from the native original lease", async () => {
    const f = await fixture();
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(1000000);
    await expect(f.reserve()).rejects.toThrow("expired");
    expect(
      (await f.jobs.findJob(f.request.scope, f.fence.jobId))?.acquisitionAllowance,
    ).not.toBeNull();
  });
});
