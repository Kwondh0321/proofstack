import { describe, expect, it, vi } from "vitest";
import { PrincipalContextSchema } from "@proofstack/contracts";
import { createMemoryPolicySnapshotResultHarness } from "../testing/memory-policy-snapshot-result-harness.js";
import { policySnapshotRepositoryFixture } from "../testing/policy-snapshot-repository-fixture.js";
import { MemoryPolicyEvaluationJobRepository } from "../testing/memory-policy-evaluation-job-repository.js";
import { InvalidPolicyEvaluationJobGraphError } from "./policy-evaluation-job-record-validation.js";
import { PolicyEvaluationSnapshotIntegrityError } from "./policy-evaluation-snapshot.js";
import { PolicyEvaluationResultIntegrityError } from "./policy-evaluation-result-record-validation.js";
import {
  readPolicyEvaluationResultRequest,
  readPolicyEvaluationSnapshotHeaderRequest,
  readPolicyEvaluationSnapshotPageRequest,
} from "./policy-evaluation-public-reads.js";

async function harness() {
  const store = createMemoryPolicySnapshotResultHarness();
  const seed = await store.seed();
  const principal = PrincipalContextSchema.parse({
    principalId: "principal_public_reader",
    principalType: "user",
    tenantId: seed.scope.tenantId,
    authentication: { method: "development", authenticatedAt: seed.snapshot.recordedAt },
    capabilities: ["policy:read"],
    roles: ["member"],
    requestId: "request_public_reader",
    resourceScope: {
      mode: "restricted",
      projects: [{ projectId: seed.scope.projectId, environmentIds: [seed.scope.environmentId] }],
    },
  });
  const command = {
    principal,
    projectId: seed.scope.projectId,
    environmentId: seed.scope.environmentId,
    jobId: seed.jobId,
  };
  const repositories = { jobs: store.control, snapshots: store.snapshots, results: store.results };
  async function complete() {
    await store.worker.startComputation({ scope: seed.scope, fence: seed.fence });
    await store.worker.reserveWork({
      scope: seed.scope,
      fence: seed.fence,
      reservationId: "reservation_public_rules",
      delta: {
        reads: 0,
        records: 0,
        recordBytes: 0,
        references: 0,
        referenceBytes: 0,
        artifactReadBytes: 0,
        ruleEvaluations: policySnapshotRepositoryFixture().inputs.rules.ruleCount,
      },
    });
    return store.results.publishResult({
      scope: seed.scope,
      fence: seed.fence,
      evaluationId: seed.evaluationId,
      pageSet: seed.pageSet,
    });
  }
  return { store, seed, command, repositories, complete };
}

describe("authorized original policy material reads", () => {
  it("reads the original header and every exact page before and after completion", async () => {
    const h = await harness();
    expect(await readPolicyEvaluationSnapshotHeaderRequest(h.command, h.repositories)).toEqual(
      h.seed.snapshot,
    );
    for (const page of h.seed.pageSet.pages) {
      expect(
        await readPolicyEvaluationSnapshotPageRequest(
          { ...h.command, snapshot: h.seed.expected.snapshot, pageIndex: page.pageIndex },
          h.repositories,
        ),
      ).toEqual({ snapshot: h.seed.expected.snapshot, page });
    }
    expect(await readPolicyEvaluationResultRequest(h.command, h.repositories)).toBeNull();
    const completed = await h.complete();
    expect(await readPolicyEvaluationResultRequest(h.command, h.repositories)).toEqual(
      completed.evaluation,
    );
    expect(await readPolicyEvaluationSnapshotHeaderRequest(h.command, h.repositories)).toEqual(
      h.seed.snapshot,
    );
    expect(await h.store.control.findJob(h.seed.scope, h.seed.jobId)).toEqual(completed.snapshot);
  });
  for (const operation of ["header", "page", "result"] as const) {
    it(`authorizes before malformed ${operation} identity or repository access`, async () => {
      const h = await harness();
      const jobs = vi.spyOn(h.store.control, "findJob");
      const command = {
        ...h.command,
        jobId: "",
        principal: { ...h.command.principal, capabilities: [] },
      };
      const run = () =>
        operation === "header"
          ? readPolicyEvaluationSnapshotHeaderRequest(command, h.repositories)
          : operation === "result"
            ? readPolicyEvaluationResultRequest(command, h.repositories)
            : readPolicyEvaluationSnapshotPageRequest(
                { ...command, snapshot: {}, pageIndex: -1 },
                h.repositories,
              );
      await expect(run()).rejects.toMatchObject({ name: "ForbiddenError" });
      expect(jobs).not.toHaveBeenCalled();
    });
    it(`preserves unknown authorized job absence for ${operation}`, async () => {
      const h = await harness();
      const command = { ...h.command, jobId: "job_public_unknown" };
      const result =
        operation === "header"
          ? await readPolicyEvaluationSnapshotHeaderRequest(command, h.repositories)
          : operation === "result"
            ? await readPolicyEvaluationResultRequest(command, h.repositories)
            : await readPolicyEvaluationSnapshotPageRequest(
                { ...command, snapshot: h.seed.expected.snapshot, pageIndex: 0 },
                h.repositories,
              );
      expect(result).toBeNull();
    });
  }
  it("isolates an identical job ID in another tenant", async () => {
    const h = await harness();
    const command = {
      ...h.command,
      principal: { ...h.command.principal, tenantId: "tenant_public_other" },
    };
    expect(await readPolicyEvaluationSnapshotHeaderRequest(command, h.repositories)).toBeNull();
    expect(await readPolicyEvaluationResultRequest(command, h.repositories)).toBeNull();
  });
  it("returns no material for an unsealed job", async () => {
    const h = await harness(),
      fixture = policySnapshotRepositoryFixture();
    const queued = new MemoryPolicyEvaluationJobRepository({
      now: () => fixture.request.createdAt,
    });
    await queued.createJob({ request: fixture.request, jobId: fixture.jobId });
    const repositories = { jobs: queued, snapshots: queued, results: queued };
    expect(await readPolicyEvaluationSnapshotHeaderRequest(h.command, repositories)).toBeNull();
    expect(await readPolicyEvaluationResultRequest(h.command, repositories)).toBeNull();
  });
  it("classifies malformed stored jobs as server integrity failures", async () => {
    const h = await harness();
    vi.spyOn(h.store.control, "findJob").mockResolvedValue({} as never);
    await expect(
      readPolicyEvaluationSnapshotHeaderRequest(h.command, h.repositories),
    ).rejects.toBeInstanceOf(InvalidPolicyEvaluationJobGraphError);
  });
  it("refuses missing or substituted advertised headers", async () => {
    const h = await harness();
    const reader = vi.spyOn(h.store.snapshots, "findSnapshot");
    reader
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...h.seed.snapshot, snapshotId: "snapshot_substituted" });
    await expect(
      readPolicyEvaluationSnapshotHeaderRequest(h.command, h.repositories),
    ).rejects.toBeInstanceOf(PolicyEvaluationSnapshotIntegrityError);
    await expect(
      readPolicyEvaluationSnapshotHeaderRequest(h.command, h.repositories),
    ).rejects.toBeInstanceOf(PolicyEvaluationSnapshotIntegrityError);
  });
  it("never substitutes a snapshot for another retained reference or a missing descriptor", async () => {
    const h = await harness();
    const reader = vi.spyOn(h.store.snapshots, "readSnapshotPage");
    expect(
      await readPolicyEvaluationSnapshotPageRequest(
        {
          ...h.command,
          snapshot: { ...h.seed.expected.snapshot, definitionSha256: "f".repeat(64) },
          pageIndex: 0,
        },
        h.repositories,
      ),
    ).toBeNull();
    expect(
      await readPolicyEvaluationSnapshotPageRequest(
        {
          ...h.command,
          snapshot: h.seed.expected.snapshot,
          pageIndex: h.seed.snapshot.pages.length,
        },
        h.repositories,
      ),
    ).toBeNull();
    expect(reader).not.toHaveBeenCalled();
  });
  it.each([-1, 0.5, 100000, "0"])(
    "rejects invalid page index %s before any read",
    async (pageIndex) => {
      const h = await harness();
      const jobs = vi.spyOn(h.store.control, "findJob");
      await expect(
        readPolicyEvaluationSnapshotPageRequest(
          { ...h.command, snapshot: h.seed.expected.snapshot, pageIndex },
          h.repositories,
        ),
      ).rejects.toThrow();
      expect(jobs).not.toHaveBeenCalled();
    },
  );
  it("rejects an invalid reference before any read", async () => {
    const h = await harness();
    const jobs = vi.spyOn(h.store.control, "findJob");
    await expect(
      readPolicyEvaluationSnapshotPageRequest(
        { ...h.command, snapshot: {}, pageIndex: 0 },
        h.repositories,
      ),
    ).rejects.toThrow();
    expect(jobs).not.toHaveBeenCalled();
  });
  it("refuses missing or corrupted advertised pages", async () => {
    const h = await harness();
    const reader = vi.spyOn(h.store.snapshots, "readSnapshotPage");
    reader
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...h.seed.pageSet.pages[0]!, definitionSha256: "f".repeat(64) });
    const command = { ...h.command, snapshot: h.seed.expected.snapshot, pageIndex: 0 };
    await expect(
      readPolicyEvaluationSnapshotPageRequest(command, h.repositories),
    ).rejects.toBeInstanceOf(PolicyEvaluationSnapshotIntegrityError);
    await expect(
      readPolicyEvaluationSnapshotPageRequest(command, h.repositories),
    ).rejects.toBeInstanceOf(PolicyEvaluationSnapshotIntegrityError);
  });
  it("refuses a missing owning result and a coherently shaped foreign result", async () => {
    const h = await harness();
    const completed = await h.complete();
    const reader = vi.spyOn(h.store.results, "findResult");
    reader
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...completed.evaluation, jobId: "job_other" });
    await expect(
      readPolicyEvaluationResultRequest(h.command, h.repositories),
    ).rejects.toBeInstanceOf(PolicyEvaluationResultIntegrityError);
    await expect(
      readPolicyEvaluationResultRequest(h.command, h.repositories),
    ).rejects.toBeInstanceOf(PolicyEvaluationResultIntegrityError);
  });
  it("refuses a vanished original seal on complete result reread", async () => {
    const h = await harness();
    await h.complete();
    const reader = vi.spyOn(h.store.snapshots, "findSnapshot");
    reader.mockResolvedValueOnce(h.seed.snapshot).mockResolvedValueOnce(null);
    await expect(
      readPolicyEvaluationResultRequest(h.command, h.repositories),
    ).rejects.toBeInstanceOf(PolicyEvaluationSnapshotIntegrityError);
  });
  it("rejects a changed original header receipt between complete result reads", async () => {
    const h = await harness();
    await h.complete();
    const reader = vi.spyOn(h.store.snapshots, "findSnapshot");
    const changed = {
      ...h.seed.snapshot,
      recordedAt: new Date(Date.parse(h.seed.snapshot.recordedAt) + 1).toISOString(),
    };
    reader.mockResolvedValueOnce(h.seed.snapshot).mockResolvedValueOnce(changed);
    await expect(
      readPolicyEvaluationResultRequest(h.command, h.repositories),
    ).rejects.toBeInstanceOf(PolicyEvaluationSnapshotIntegrityError);
  });
});
