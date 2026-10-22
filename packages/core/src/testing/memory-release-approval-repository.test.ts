import { describe, expect, it } from "vitest";
import {
  serializeEvaluationCanonicalJson,
  type ReleaseApproval,
  type ReleaseApprovalRevocation,
} from "@proofstack/contracts";
import { MemoryReleaseApprovalRepository } from "./memory-release-approval-repository.js";
import {
  releaseApprovalRepositoryFixture,
  approvalVersion,
} from "./release-approval-repository-fixtures.js";
import { ReleaseDecisionVerificationBudget } from "../release/release-decision-verification-budget.js";

/** Deliberate physical corruption is test-only, never a production mutation port. */
interface Storage {
  approvals: Map<string, ReleaseApproval>;
  subjects: Map<string, ReadonlySet<string>>;
  successors: Map<string, string>;
  revocations: Map<string, ReleaseApprovalRevocation>;
  revoked: Map<string, string>;
}
const meter = () =>
  new ReleaseDecisionVerificationBudget({
    maxAcquisitionRecords: 100_000,
    maxAcquisitionRecordBytes: 64 * 1024 * 1024,
    maxApprovalRecords: 4096,
  });
async function fixture() {
  const f = releaseApprovalRepositoryFixture("physical"),
    repository = new MemoryReleaseApprovalRepository();
  await repository.publishReleaseApproval(f.original);
  await repository.publishReleaseApproval(f.successor);
  await repository.publishReleaseApprovalRevocation(f.revocation);
  const state = (repository as unknown as { tenants: Map<string, Storage> }).tenants.get(
    f.scope.tenantId,
  );
  if (!state) throw new Error("Missing actual stored approval state");
  return { f, repository, state };
}
describe("owning approval inventory and original receipt integrity", () => {
  it("isolates tentative successors and revocations while preserving complete original indexes", async () => {
    const f = releaseApprovalRepositoryFixture("fork_authority"),
      original = new MemoryReleaseApprovalRepository();
    await original.publishReleaseApproval(f.original);
    const next = original.fork();
    await next.publishReleaseApproval(f.successor);
    await next.publishReleaseApprovalRevocation(f.revocation);
    expect(
      await original.readReleaseApprovalSubject(f.scope, f.original.kind, f.subject, meter()),
    ).toEqual({ records: [f.original], revocations: [] });
    const forked = await next.readReleaseApprovalSubject(
      f.scope,
      f.original.kind,
      f.subject,
      meter(),
    );
    expect(forked.records).toHaveLength(2);
    expect(forked.revocations).toEqual([f.revocation]);
    const another = next.fork();
    expect(await another.findReleaseApproval(f.scope, f.successor.approvalId)).toEqual(f.successor);
    expect(await another.findReleaseApprovalRevocation(f.scope, f.revocation.eventId)).toEqual(
      f.revocation,
    );
    // Owner-only physical corruption in one abandoned branch must not poison its retained sibling.
    const state = (another as unknown as { tenants: Map<string, Storage> }).tenants.get(
      f.scope.tenantId,
    );
    if (!state) throw new Error("Missing forked state");
    const stored = state.approvals.get(f.original.approvalId);
    if (!stored) throw new Error("Missing original approval");
    stored.reviewer.requestId = "request_damaged_branch";
    state.subjects.clear();
    state.successors.clear();
    state.revoked.clear();
    await expect(
      another.readReleaseApprovalSubject(f.scope, f.original.kind, f.subject, meter()),
    ).rejects.toBeDefined();
    expect(
      await next.readReleaseApprovalSubject(f.scope, f.original.kind, f.subject, meter()),
    ).toEqual(forked);
  });
  it.each([
    "subject_index_missing",
    "subject_index_extra",
    "successor_index",
    "successor_row",
    "revocation_index",
    "revocation_event",
    "approval_slot",
    "event_slot",
    "native_receipt",
    "forged_record",
    "parent_hash",
  ])(
    "taints the whole read after corrupt %s instead of returning a favorable prefix",
    async (kind) => {
      const { f, repository, state } = await fixture();
      if (kind === "subject_index_missing") state.subjects.clear();
      if (kind === "subject_index_extra")
        state.subjects.set(
          serializeEvaluationCanonicalJson([f.original.kind, f.subject]),
          new Set([f.original.approvalId, f.successor.approvalId, "approval_missing"]),
        );
      if (kind === "successor_index") state.successors.clear();
      if (kind === "successor_row") state.approvals.delete(f.successor.approvalId);
      if (kind === "revocation_index") state.revoked.clear();
      if (kind === "revocation_event") state.revocations.clear();
      if (kind === "approval_slot")
        state.approvals.set(
          f.successor.approvalId,
          approvalVersion(f.successor, { approvalId: "approval_other_slot" }),
        );
      if (kind === "event_slot")
        state.revocations.set(f.revocation.eventId, {
          ...f.revocation,
          eventId: "event_other_slot",
        });
      if (kind === "native_receipt")
        state.revocations.set(f.revocation.eventId, {
          ...f.revocation,
          occurredAt: "2026-10-15T10:00:05.000000999999999999Z",
        });
      if (kind === "forged_record")
        state.approvals.set(f.original.approvalId, {
          ...f.original,
          definitionSha256: "0".repeat(64),
        });
      if (kind === "parent_hash")
        state.approvals.set(
          f.successor.approvalId,
          approvalVersion(f.successor, {
            supersedes: { approvalId: f.original.approvalId, definitionSha256: "0".repeat(64) },
          }),
        );
      const budget = meter();
      await expect(
        repository.readReleaseApprovalSubject(f.scope, f.original.kind, f.subject, budget),
      ).rejects.toMatchObject({ code: "release_decision_verification_source_read_failed" });
      expect(() => budget.snapshot()).toThrow();
      expect(() => budget.observe({ later: "cannot continue after caught failure" })).toThrow();
    },
  );
  it("rejects a substituted exact approval or event slot", async () => {
    const { f, repository, state } = await fixture();
    state.approvals.set(
      f.successor.approvalId,
      approvalVersion(f.successor, { approvalId: "approval_other_slot" }),
    );
    await expect(
      repository.findReleaseApproval(f.scope, f.successor.approvalId),
    ).rejects.toMatchObject({ reason: "storage_invalid" });
    state.revocations.set(f.revocation.eventId, { ...f.revocation, eventId: "event_other_slot" });
    await expect(
      repository.findReleaseApprovalRevocation(f.scope, f.revocation.eventId),
    ).rejects.toMatchObject({ reason: "storage_invalid" });
  });
  it("rejects invalid canonical or non-OIDC receipts before any mutation", async () => {
    const f = releaseApprovalRepositoryFixture("invalid"),
      repository = new MemoryReleaseApprovalRepository();
    for (const kind of ["digest", "principal", "authentication"] as const) {
      const row = structuredClone(f.original);
      if (kind === "digest") row.definitionSha256 = "0".repeat(64);
      if (kind === "principal") Reflect.set(row.reviewer, "principalType", "service");
      if (kind === "authentication")
        Reflect.set(row.reviewer, "authenticationMethod", "development");
      await expect(repository.publishReleaseApproval(row)).rejects.toThrow();
      expect(await repository.findReleaseApproval(f.scope, row.approvalId)).toBeNull();
    }
  });
  it("preserves first source-read failure when a caller catches it and attempts another subject", async () => {
    const { f, repository } = await fixture();
    const budget = meter();
    let first: unknown;
    try {
      await repository.readReleaseApprovalSubject(
        f.scope,
        f.original.kind,
        { ...f.subject, scope: { ...f.scope, projectId: "project_other" } },
        budget,
      );
    } catch (cause) {
      first = cause;
    }
    expect(first).toMatchObject({
      code: "release_decision_verification_source_read_failed",
      cause: { reason: "scope_mismatch" },
    });
    await expect(
      repository.readReleaseApprovalSubject(f.scope, f.original.kind, f.subject, budget),
    ).rejects.toBe(first);
  });
});
