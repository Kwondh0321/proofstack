import { describe, expect, it } from "vitest";
import type {
  ReleasePolicySelection,
  ReleasePolicySelectionLifecycleEvent,
} from "@proofstack/contracts";
import { ReleaseDecisionVerificationBudget } from "../release/release-decision-verification-budget.js";
import { MemoryReleasePolicySelectionRepository } from "./memory-release-policy-selection-repository.js";
import {
  releasePolicySelectionRepositoryFixture,
  selectionVersion,
} from "./release-policy-selection-repository-fixtures.js";

/** Deliberately corrupt physical storage, never an alternate public repository mutation interface. */
type Storage = {
  versions: Map<string, ReleasePolicySelection>;
  roots: Map<string, ReleasePolicySelection>;
  targets: Map<string, ReleasePolicySelection>;
  events: Map<string, ReleasePolicySelectionLifecycleEvent>;
  terminals: Map<string, string>;
};
const meter = () =>
  new ReleaseDecisionVerificationBudget({
    maxAcquisitionRecords: 100_000,
    maxAcquisitionRecordBytes: 64 * 1024 * 1024,
    maxApprovalRecords: 0,
  });
async function fixture() {
  const f = releasePolicySelectionRepositoryFixture("physical");
  const repository = new MemoryReleasePolicySelectionRepository();
  await repository.publishReleasePolicySelection(f.original);
  await repository.publishReleasePolicySelection(f.successor);
  await repository.publishReleasePolicySelectionLifecycleEvent(f.supersession);
  const state = (repository as unknown as { tenants: Map<string, Storage> }).tenants.get(
    f.scope.tenantId,
  );
  if (!state) throw new Error("Missing actual stored memory state");
  return { f, repository, state };
}
describe("owning selection memory storage integrity", () => {
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
      if (kind === "root_version") state.versions.delete(f.original.selectionVersionId);
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
        state.versions.delete(f.successor.selectionVersionId);
        state.versions.set("version_wrong_slot", f.successor);
      }
      const budget = meter();
      await expect(
        repository.readReleasePolicySelectionTarget(f.scope, f.target, budget),
      ).rejects.toMatchObject({ code: "release_decision_verification_source_read_failed" });
      expect(() => budget.snapshot()).toThrow();
      expect(() => budget.observe({ later: "caught failure cannot continue" })).toThrow();
    },
  );
  it("rejects a valid canonical version substituted into another exact version slot", async () => {
    const { f, repository, state } = await fixture();
    const other = selectionVersion(
      f.successor,
      { selectionVersionId: "version_substituted" },
      f.successor.publishedAt,
    );
    state.versions.set(f.successor.selectionVersionId, other);
    await expect(
      repository.findReleasePolicySelection(f.scope, f.successor.selectionVersionId),
    ).rejects.toMatchObject({ reason: "storage_invalid" });
  });
  it("rejects an event substituted into another exact event slot", async () => {
    const { f, repository, state } = await fixture();
    state.events.set(f.supersession.eventId, { ...f.supersession, eventId: "event_substituted" });
    await expect(
      repository.findReleasePolicySelectionLifecycleEvent(f.scope, f.supersession.eventId),
    ).rejects.toMatchObject({ reason: "storage_invalid" });
  });
  it("does not silently rebind a dangling physical target or logical root on publication", async () => {
    for (const kind of ["target", "root"] as const) {
      const { f, repository, state } = await fixture();
      if (kind === "target") state.targets.clear();
      else state.roots.clear();
      const next = selectionVersion(
        f.successor,
        { selectionVersionId: "version_after_corruption" },
        f.successor.publishedAt,
      );
      await expect(repository.publishReleasePolicySelection(next)).rejects.toMatchObject({
        reason: "storage_invalid",
      });
      expect(state.versions.has(next.selectionVersionId)).toBe(false);
    }
  });
});
