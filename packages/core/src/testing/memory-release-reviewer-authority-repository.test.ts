import { describe, expect, it } from "vitest";
import type {
  ReleaseReviewerAuthority,
  ReleaseReviewerAuthorityLifecycleEvent,
} from "@proofstack/contracts";
import { ReleaseDecisionVerificationBudget } from "../release/release-decision-verification-budget.js";
import { MemoryReleaseReviewerAuthorityRepository } from "./memory-release-reviewer-authority-repository.js";
import {
  releaseReviewerAuthorityRepositoryFixture,
  authorityVersion,
} from "./release-reviewer-authority-repository-fixtures.js";

/** Deliberately corrupt physical storage, never an alternate public repository mutation interface. */
type Storage = {
  versions: Map<string, ReleaseReviewerAuthority>;
  roots: Map<string, ReleaseReviewerAuthority>;
  targets: Map<string, ReleaseReviewerAuthority>;
  events: Map<string, ReleaseReviewerAuthorityLifecycleEvent>;
  terminals: Map<string, string>;
};
const meter = () =>
  new ReleaseDecisionVerificationBudget({
    maxAcquisitionRecords: 100_000,
    maxAcquisitionRecordBytes: 64 * 1024 * 1024,
    maxApprovalRecords: 0,
  });
async function fixture() {
  const f = releaseReviewerAuthorityRepositoryFixture("physical");
  const repository = new MemoryReleaseReviewerAuthorityRepository();
  await repository.publishReleaseReviewerAuthority(f.original);
  await repository.publishReleaseReviewerAuthority(f.successor);
  await repository.publishReleaseReviewerAuthorityLifecycleEvent(f.supersession);
  const state = (repository as unknown as { tenants: Map<string, Storage> }).tenants.get(
    f.scope.tenantId,
  );
  if (!state) throw new Error("Missing actual stored memory state");
  return { f, repository, state };
}
describe("owning reviewer authority memory storage integrity", () => {
  it("keeps tentative versions, root indexes and terminal history isolated in both directions", async () => {
    const f = releaseReviewerAuthorityRepositoryFixture("fork");
    const repository = new MemoryReleaseReviewerAuthorityRepository();
    await repository.publishReleaseReviewerAuthority(f.original);
    const fork = repository.fork();
    await fork.publishReleaseReviewerAuthority(f.successor);
    await fork.publishReleaseReviewerAuthorityLifecycleEvent(f.supersession);
    expect(await repository.readReleaseReviewerAuthorityTarget(f.scope, f.target, meter())).toEqual(
      { root: f.original, records: [f.original], lifecycle: [] },
    );
    await repository.publishReleaseReviewerAuthorityLifecycleEvent(f.revocation);
    expect(
      (await fork.readReleaseReviewerAuthorityTarget(f.scope, f.target, meter())).lifecycle,
    ).toEqual([f.supersession]);
    expect(
      await fork.findReleaseReviewerAuthority(f.scope, f.successor.authorityVersionId),
    ).toEqual(f.successor);
    expect(
      await repository.findReleaseReviewerAuthority(f.scope, f.successor.authorityVersionId),
    ).toBeNull();
  });
  it.each([
    "target_index",
    "logical_root",
    "root_version",
    "terminal_event",
    "terminal_index",
    "event_receipt",
    "event_key",
    "version_key",
  ])(
    "taints the complete cut after corrupt %s instead of reporting absence or a favorable prefix",
    async (kind) => {
      const { f, repository, state } = await fixture();
      if (kind === "target_index") state.targets.clear();
      if (kind === "logical_root") state.roots.clear();
      if (kind === "root_version") state.versions.delete(f.original.authorityVersionId);
      if (kind === "terminal_event") state.events.clear();
      if (kind === "terminal_index") state.terminals.clear();
      if (kind === "event_receipt")
        state.events.set(f.supersession.eventId, {
          ...f.supersession,
          occurredAt: "2026-10-15T00:00:00.000000000001Z",
        });
      if (kind === "event_key") {
        state.events.delete(f.supersession.eventId);
        state.events.set("event_wrong_slot", f.supersession);
      }
      if (kind === "version_key") {
        state.versions.delete(f.successor.authorityVersionId);
        state.versions.set("version_wrong_slot", f.successor);
      }
      const budget = meter();
      await expect(
        repository.readReleaseReviewerAuthorityTarget(f.scope, f.target, budget),
      ).rejects.toMatchObject({ code: "release_decision_verification_source_read_failed" });
      expect(() => budget.snapshot()).toThrow();
      expect(() => budget.observe({ later: "caught failure cannot continue" })).toThrow();
    },
  );
  it("rejects a valid canonical version substituted into another exact version slot", async () => {
    const { f, repository, state } = await fixture();
    const other = authorityVersion(
      f.successor,
      { authorityVersionId: "version_substituted" },
      f.successor.publishedAt,
    );
    state.versions.set(f.successor.authorityVersionId, other);
    await expect(
      repository.findReleaseReviewerAuthority(f.scope, f.successor.authorityVersionId),
    ).rejects.toMatchObject({ reason: "storage_invalid" });
  });
  it("rejects an event substituted into another exact event slot", async () => {
    const { f, repository, state } = await fixture();
    state.events.set(f.supersession.eventId, { ...f.supersession, eventId: "event_substituted" });
    await expect(
      repository.findReleaseReviewerAuthorityLifecycleEvent(f.scope, f.supersession.eventId),
    ).rejects.toMatchObject({ reason: "storage_invalid" });
  });
  it("does not silently rebind a dangling physical target or logical root on publication", async () => {
    for (const kind of ["target", "root"] as const) {
      const { f, repository, state } = await fixture();
      if (kind === "target") state.targets.clear();
      else state.roots.clear();
      const next = authorityVersion(
        f.successor,
        { authorityVersionId: "version_after_corruption" },
        f.successor.publishedAt,
      );
      await expect(repository.publishReleaseReviewerAuthority(next)).rejects.toMatchObject({
        reason: "storage_invalid",
      });
      expect(state.versions.has(next.authorityVersionId)).toBe(false);
    }
  });
});
