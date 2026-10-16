import { policyEvaluationSourceReferenceKey } from "@proofstack/contracts";
import {
  inspectOwnedPolicyEvaluation,
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "@proofstack/core";
import {
  createMemoryPolicySnapshotResultHarness,
  policySnapshotRepositoryFixture,
} from "@proofstack/core/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { captureOriginalEvaluationActors } from "./capture-original-evaluation-actors.js";
import type { PolicyRecordGraphRepositories } from "./record-routing.js";

const limits = {
  maxAcquisitionRecords: 10_000,
  maxAcquisitionRecordBytes: 64 * 1024 * 1024,
  maxApprovalRecords: 0,
};
type Original = Parameters<typeof captureOriginalEvaluationActors>[0]["original"];
let original: Original;
beforeAll(async () => {
  const f = policySnapshotRepositoryFixture();
  const h = createMemoryPolicySnapshotResultHarness();
  const seed = await h.seed();
  await h.worker.startComputation({ scope: seed.scope, fence: seed.fence });
  await h.worker.reserveWork({
    scope: seed.scope,
    fence: seed.fence,
    reservationId: "reservation_original_actors",
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
  const completed = await h.results.publishResult({
    scope: seed.scope,
    fence: seed.fence,
    evaluationId: seed.evaluationId,
    pageSet: seed.pageSet,
  });
  const jobGraph = await h.control.findJob(seed.scope, seed.jobId);
  if (!jobGraph) throw new Error("Missing actual completed original job");
  original = {
    expected: {
      scope: seed.scope,
      request: jobGraph.job.request,
      job: { jobId: seed.jobId, definitionSha256: jobGraph.job.definitionSha256 },
    },
    jobGraph,
    snapshot: seed.snapshot,
    pageSet: seed.pageSet,
    evaluation: completed.evaluation,
    capturedAt: f.publicationAt,
  };
});

/** Unavailable upstream sources are explicit negative cases, never a successful complete cut. */
function absentSources(read: () => Promise<null>): PolicyRecordGraphRepositories {
  const absent = new Proxy({}, { get: () => read });
  return {
    control: {
      comparison: absent,
      releaseCandidate: absent,
      releasePolicy: absent,
      installationBinding: absent,
    },
    evidence: { evaluation: absent, modelAssurance: absent },
    datasets: absent,
    replayDefinitions: absent,
    replayResults: absent,
    runtimeDefinitions: absent,
    protocolDefinitions: absent,
    endpointProfiles: absent,
    implementationRegistrations: absent,
    qualificationPolicies: absent,
  } as PolicyRecordGraphRepositories;
}

describe("historical original actors from the real completed C3 memory repository", () => {
  it("preserves immutable subject authors and every original witness while reporting unavailable upstream actors", async () => {
    const before = structuredClone(original);
    const read = vi.fn(async () => null);
    const result = await captureOriginalEvaluationActors({
      original,
      records: absentSources(read),
      budget: new ReleaseDecisionVerificationBudget(limits),
    });
    const owned = inspectOwnedPolicyEvaluation({
      ...original,
      budget: new ReleaseDecisionVerificationBudget(limits),
    });
    expect(result.authorityBoundary).toBe("original_evaluation_actors_only");
    expect(result.candidate.authorPrincipalId).toBe(owned.candidate.createdByPrincipalId);
    expect(result.policy.authorPrincipalId).toBe(owned.policy.publishedByPrincipalId);
    expect(result.original.evaluatorPrincipalId).toBe(owned.evaluation.recordedByPrincipalId);
    expect(result.original.requesterPrincipalId).toBe(owned.request.createdByPrincipalId);
    expect(result.sourceState).toBe("unavailable");
    expect(result.evaluationActorState).toBe("unavailable");
    expect(result.evaluatorPrincipalIds).toEqual([owned.evaluation.recordedByPrincipalId]);
    expect(
      new Map(
        result.sources.map((row) => [
          policyEvaluationSourceReferenceKey(row.witness.entry.source),
          row.witness,
        ]),
      ),
    ).toEqual(
      new Map(
        owned.originalSourceWitnesses.map((row) => [
          policyEvaluationSourceReferenceKey(row.entry.source),
          row,
        ]),
      ),
    );
    const known = owned.originalSourceWitnesses.filter(({ storage }) => storage !== null);
    const dualFixtureReads = known.filter(
      ({ entry }) => entry.source.kind === "regression_fixture_version",
    ).length;
    // Both original fixture formats must be checked; only the two exact retained roots skip I/O.
    expect(read).toHaveBeenCalledTimes(known.length - 2 + dualFixtureReads);
    for (const call of read.mock.calls) expect(call).not.toHaveLength(0);
    expect(result.sources.filter(({ state }) => state === "observed")).toHaveLength(2);
    expect(original).toEqual(before);
  });
  it.each(["scope", "request", "job"] as const)(
    "rejects an inexact original %s identity before upstream reads",
    async (kind) => {
      const changed = structuredClone(original);
      if (kind === "scope") changed.expected.scope.environmentId = "env_other";
      else changed.expected[kind].definitionSha256 = "0".repeat(64);
      const read = vi.fn(async () => null);
      await expect(
        captureOriginalEvaluationActors({
          original: changed,
          records: absentSources(read),
          budget: new ReleaseDecisionVerificationBudget(limits),
        }),
      ).rejects.toMatchObject({ code: "owned_policy_evaluation_invalid" });
      expect(read).not.toHaveBeenCalled();
    },
  );
  it("does not perform upstream I/O after aggregate admission is exhausted", async () => {
    const read = vi.fn(async () => null);
    const budget = new ReleaseDecisionVerificationBudget({ ...limits, maxAcquisitionRecords: 2 });
    await expect(
      captureOriginalEvaluationActors({ original, records: absentSources(read), budget }),
    ).rejects.toBeInstanceOf(ReleaseDecisionVerificationBudgetError);
    expect(read).not.toHaveBeenCalled();
    expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
  });
  it("taints the entire shared cut on one failed owning read and never retries automatically", async () => {
    const cause = new Error("isolated original source unavailable");
    const read = vi.fn(async (): Promise<null> => {
      throw cause;
    });
    const budget = new ReleaseDecisionVerificationBudget(limits);
    await expect(
      captureOriginalEvaluationActors({ original, records: absentSources(read), budget }),
    ).rejects.toMatchObject({ code: "release_decision_verification_source_read_failed", cause });
    expect(read).toHaveBeenCalledTimes(1);
    expect(() => budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
    expect(() => budget.observe({})).toThrow(ReleaseDecisionVerificationBudgetError);
  });
});
