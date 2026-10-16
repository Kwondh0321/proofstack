import { describe, it, expect } from "vitest";
import {
  ReleaseDecisionInputRepositoryError,
  type ReleaseDecisionInputGraph,
} from "../release/release-decision-input-repository.js";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "../release/release-decision-verification-budget.js";
import { validateReleaseDecisionInputGraph } from "../release/release-decision-input-graph-validation.js";
import { MemoryReleaseDecisionInputRepository } from "./memory-release-decision-input-repository.js";
import {
  decisionInputVersion,
  releaseDecisionInputRepositoryFixture,
} from "./release-decision-input-repository-fixtures.js";

const limits = {
  maxAcquisitionRecords: 100000,
  maxAcquisitionRecordBytes: 64 * 1024 * 1024,
  maxApprovalRecords: 0,
};
async function fixture() {
  const graph = releaseDecisionInputRepositoryFixture("memory_probe");
  const repository = new MemoryReleaseDecisionInputRepository();
  await repository.publishReleaseDecisionInput(graph);
  const internals = repository as unknown as {
    tenants: Map<
      string,
      {
        records: Map<string, ReleaseDecisionInputGraph>;
        plans: Map<string, { inputId: string; sha256: string }>;
      }
    >;
  };
  const state = internals.tenants.get(graph.request.scope.tenantId);
  if (!state) throw new Error("Missing stored fixture state");
  return { graph, repository, state };
}
describe("original decision input memory physical integrity", () => {
  it.each(["missing", "owner", "digest"])(
    "rejects a %s local planned-ID owner and taints the cut",
    async (kind) => {
      const f = await fixture(),
        plan = f.graph.request.evaluations[0];
      if (!plan) throw new Error("Missing planned request fixture");
      if (kind === "missing") f.state.plans.delete(plan.request.evaluationRequestId);
      else
        f.state.plans.set(plan.request.evaluationRequestId, {
          inputId: kind === "owner" ? "input_foreign" : f.graph.request.decisionInputRequestId,
          sha256: kind === "digest" ? "0".repeat(64) : plan.requestSha256,
        });
      const budget = new ReleaseDecisionVerificationBudget(limits);
      await expect(
        f.repository.findReleaseDecisionInput(
          f.graph.request.scope,
          f.graph.request.decisionInputRequestId,
          budget,
        ),
      ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
      expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
      await expect(f.repository.publishReleaseDecisionInput(f.graph)).rejects.toBeInstanceOf(
        ReleaseDecisionInputRepositoryError,
      );
    },
  );
  it("rejects a valid graph substituted under another physical input ID", async () => {
    const f = await fixture(),
      other = {
        ...f.graph,
        request: decisionInputVersion(f.graph.request, {
          decisionInputRequestId: "input_physical_other",
        }),
      };
    f.state.records.set(f.graph.request.decisionInputRequestId, other);
    await expect(
      f.repository.findReleaseDecisionInput(
        f.graph.request.scope,
        f.graph.request.decisionInputRequestId,
      ),
    ).rejects.toMatchObject({ reason: "storage_invalid" });
  });
  it.each(["request", "selection", "candidate", "policies"])(
    "rejects a damaged original %s on authoritative reads",
    async (field) => {
      const f = await fixture(),
        changed = structuredClone(f.graph) as unknown as Record<string, unknown>;
      changed[field] = field === "policies" ? [] : {};
      f.state.records.set(
        f.graph.request.decisionInputRequestId,
        changed as unknown as ReleaseDecisionInputGraph,
      );
      const budget = new ReleaseDecisionVerificationBudget(limits);
      await expect(
        f.repository.findReleaseDecisionInput(
          f.graph.request.scope,
          f.graph.request.decisionInputRequestId,
          budget,
        ),
      ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
      expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
    },
  );
  it("refuses fake or already failed meters before another graph read", async () => {
    const f = await fixture();
    await expect(
      f.repository.findReleaseDecisionInput(
        f.graph.request.scope,
        f.graph.request.decisionInputRequestId,
        {} as ReleaseDecisionVerificationBudget,
      ),
    ).rejects.toBeInstanceOf(ReleaseDecisionInputRepositoryError);
    const failed = new ReleaseDecisionVerificationBudget({ ...limits, maxAcquisitionRecords: 2 });
    await expect(
      f.repository.findReleaseDecisionInput(
        f.graph.request.scope,
        f.graph.request.decisionInputRequestId,
        failed,
      ),
    ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
    await expect(
      f.repository.findReleaseDecisionInput(
        f.graph.request.scope,
        f.graph.request.decisionInputRequestId,
        failed,
      ),
    ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
  });
  it.for([
    null,
    [],
    {},
    { request: {} },
    { request: {}, candidate: {}, selection: {}, policies: {} },
  ])("rejects incomplete original graph shape %#", (raw) => {
    expect(() => validateReleaseDecisionInputGraph(raw)).toThrow(
      ReleaseDecisionInputRepositoryError,
    );
  });
  it("rejects an unrecognized graph field and original policy order", () => {
    const graph = releaseDecisionInputRepositoryFixture("shape_probe");
    expect(() =>
      validateReleaseDecisionInputGraph({ ...graph, computedDisposition: "proceed" }),
    ).toThrow(ReleaseDecisionInputRepositoryError);
    expect(() =>
      validateReleaseDecisionInputGraph({ ...graph, policies: [...graph.policies].reverse() }),
    ).toThrow(ReleaseDecisionInputRepositoryError);
  });
});
