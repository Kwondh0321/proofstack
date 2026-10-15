import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type {
  PolicyEvaluationSnapshot,
  PolicyEvaluationSnapshotInputs,
} from "@proofstack/contracts";
import { assemblePolicyEvaluationSnapshot } from "./policy-evaluation-snapshot.js";
import { MemoryPolicyEvaluationJobRepository } from "../testing/memory-policy-evaluation-job-repository.js";
import { sealPolicyEvaluationJob } from "./policy-evaluation-scheduler-seal.js";
import { recoverPolicyEvaluationJob } from "./policy-evaluation-job-recovery.js";
import { digestPolicyEvaluationJobDefinition } from "./policy-evaluation-job-record-validation.js";
import {
  readCompletePolicyEvaluationSnapshot,
  validatePolicyEvaluationStoredSnapshotHeader,
  validatePolicyEvaluationStoredSnapshotJob,
  validatePolicyEvaluationStoredSnapshotPage,
  type PolicyEvaluationSnapshotReadIdentity,
} from "./policy-evaluation-snapshot-repository.js";

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
  const pageSet = assemblePolicyEvaluationSnapshot({ snapshotId: "snapshot_stored_read", inputs });
  const jobs = new MemoryPolicyEvaluationJobRepository({ now: () => inputs.capturedAt });
  await jobs.createJob({ request: inputs.request, jobId: "job_stored_read" });
  const claimed = await jobs.claimJob({
    scope: inputs.request.scope,
    jobId: "job_stored_read",
    workerId: "worker_stored_read",
    attemptId: "attempt_stored_read",
    leaseId: "lease_stored_read",
  });
  const fence = claimed.job.currentLease!.mutationFence;
  const reference = {
    snapshotId: pageSet.definition.snapshotId,
    definitionSha256: pageSet.definitionSha256,
  };
  const sealedAt = "2026-10-01T02:00:00.001Z";
  const snapshot: PolicyEvaluationSnapshot = {
    ...pageSet.definition,
    scope: inputs.request.scope,
    schemaVersion: "0.1",
    definitionSha256: reference.definitionSha256,
    sealedAt,
    recordedAt: sealedAt,
    sealedByPrincipalId: fence.workerId,
    ...fence,
  };
  const job = sealPolicyEvaluationJob({
    snapshot: claimed,
    now: sealedAt,
    recoveryEpoch: 0,
    fence,
    sealedSnapshot: reference,
  });
  const expected: PolicyEvaluationSnapshotReadIdentity = {
    scope: inputs.request.scope,
    job: { jobId: job.job.jobId, definitionSha256: job.job.definitionSha256 },
    request: job.job.request,
    snapshot: reference,
  };
  const findSnapshot = vi.fn(async () => structuredClone(snapshot));
  const readSnapshotPage = vi.fn(
    async (_expected: PolicyEvaluationSnapshotReadIdentity, index: number) =>
      structuredClone(pageSet.pages[index] ?? null),
  );
  return {
    snapshot,
    pageSet,
    job,
    expected,
    reader: { findSnapshot, readSnapshotPage },
    findSnapshot,
    readSnapshotPage,
  };
}
describe("exact stored policy snapshot reads", () => {
  it("reassembles original pages and delegates full semantic validation without changing receipts", async () => {
    const f = await fixture();
    expect(await readCompletePolicyEvaluationSnapshot(f.reader, f.expected)).toEqual({
      snapshot: f.snapshot,
      pageSet: f.pageSet,
    });
    expect(f.readSnapshotPage.mock.calls.map((call) => call[1])).toEqual(
      f.pageSet.pages.map((_, index) => index),
    );
    expect(validatePolicyEvaluationStoredSnapshotJob(f.expected, f.snapshot, f.job).root).toEqual(
      f.snapshot,
    );
  });
  it("preserves original sealing identity after recovery closes the old attempt", async () => {
    const f = await fixture();
    const recovered = recoverPolicyEvaluationJob({
      snapshot: f.job,
      now: "2026-10-01T02:00:00.002Z",
      recoveryEpoch: 1,
    });
    expect(recovered.job.currentLease).toBeNull();
    expect(
      validatePolicyEvaluationStoredSnapshotJob(f.expected, f.snapshot, recovered).root,
    ).toEqual(f.snapshot);
  });
  it("returns absence without starting page I/O", async () => {
    const f = await fixture();
    const readSnapshotPage = vi.fn();
    expect(
      await readCompletePolicyEvaluationSnapshot(
        { findSnapshot: async () => null, readSnapshotPage },
        f.expected,
      ),
    ).toBeNull();
    expect(readSnapshotPage).not.toHaveBeenCalled();
  });
  it("rejects an incoherent owning job digest before dependencies", async () => {
    const f = await fixture();
    await expect(
      readCompletePolicyEvaluationSnapshot(f.reader, {
        ...f.expected,
        job: { ...f.expected.job, definitionSha256: "0".repeat(64) },
      }),
    ).rejects.toThrow();
    expect(f.findSnapshot).not.toHaveBeenCalled();
  });
  it("does not silently omit an advertised missing page", async () => {
    const f = await fixture();
    f.readSnapshotPage.mockResolvedValueOnce(null);
    await expect(readCompletePolicyEvaluationSnapshot(f.reader, f.expected)).rejects.toMatchObject({
      code: "invalid_snapshot",
    });
  });
  it.each(["request", "worker", "digest", "scope"] as const)(
    "rejects a substituted %s in retained header/attempt",
    async (kind) => {
      const f = await fixture();
      const record = structuredClone(f.snapshot);
      if (kind === "request")
        record.request = { ...record.request, evaluationRequestId: "request_other" };
      if (kind === "worker") {
        record.workerId = "worker_other";
        record.sealedByPrincipalId = record.workerId;
      }
      if (kind === "digest") record.inputSha256 = "1".repeat(64);
      if (kind === "scope") record.scope = { ...record.scope, projectId: "project_other" };
      expect(() => validatePolicyEvaluationStoredSnapshotJob(f.expected, record, f.job)).toThrow();
    },
  );
  it("rejects a wrong expected root and canonical header digest", async () => {
    const f = await fixture();
    expect(() =>
      validatePolicyEvaluationStoredSnapshotHeader(
        { ...f.expected, snapshot: { ...f.expected.snapshot, definitionSha256: "0".repeat(64) } },
        f.snapshot,
      ),
    ).toThrow();
    expect(() =>
      validatePolicyEvaluationStoredSnapshotHeader(f.expected, { ...f.snapshot, frameCount: 0 }),
    ).toThrow();
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER, NaN])(
    "rejects invalid page index %s",
    async (index) => {
      const f = await fixture();
      expect(() =>
        validatePolicyEvaluationStoredSnapshotPage(
          f.expected,
          f.snapshot,
          index,
          f.pageSet.pages[0],
        ),
      ).toThrow();
    },
  );
  it("rejects page identity, descriptor and canonical frame corruption", async () => {
    const f = await fixture();
    const original = f.pageSet.pages[0]!;
    for (const page of [
      { ...original, snapshotId: "snapshot_other" },
      { ...original, definitionSha256: "0".repeat(64) },
      {
        ...original,
        frames: original.frames.map((frame, index) =>
          index === 0 ? { ...frame, dataBase64url: "e30" } : frame,
        ),
      },
    ])
      expect(() =>
        validatePolicyEvaluationStoredSnapshotPage(f.expected, f.snapshot, 0, page),
      ).toThrow();
  });
  it("binds expected scope into its job definition rather than borrowing another scope", async () => {
    const f = await fixture();
    const scope = { ...f.expected.scope, environmentId: "environment_other" };
    const expected = {
      ...f.expected,
      scope,
      job: {
        ...f.expected.job,
        definitionSha256: digestPolicyEvaluationJobDefinition(scope, {
          jobId: f.expected.job.jobId,
          request: f.expected.request,
        }),
      },
    };
    await expect(readCompletePolicyEvaluationSnapshot(f.reader, expected)).rejects.toThrow();
    expect(f.readSnapshotPage).not.toHaveBeenCalled();
  });
});
