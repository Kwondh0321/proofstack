import assert from "node:assert/strict";
import {
  encodeEvaluationCanonicalJson,
  type ReleaseApprovalDefinition,
  type ReleaseApproval,
} from "@proofstack/contracts";
import {
  ReleaseApprovalRepositoryError,
  type ReleaseApprovalRepository,
} from "../release/release-approval-repository.js";
import { releaseApprovalReference } from "../release/release-authority-record-validation.js";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "../release/release-decision-verification-budget.js";
import {
  type releaseApprovalRepositoryFixture,
  approvalVersion,
  approvalRevocation,
} from "./release-approval-repository-fixtures.js";

export interface ReleaseApprovalRepositoryTestHarness {
  readonly repository: ReleaseApprovalRepository;
  readonly fixture: ReturnType<typeof releaseApprovalRepositoryFixture>;
  readonly dispose?: () => Promise<void>;
}
export type ReleaseApprovalRepositoryTestFactory = (
  namespace: string,
) => ReleaseApprovalRepositoryTestHarness | Promise<ReleaseApprovalRepositoryTestHarness>;
const limits = {
  maxAcquisitionRecords: 100_000,
  maxAcquisitionRecordBytes: 64 * 1024 * 1024,
  maxApprovalRecords: 4096,
};
const meter = () => new ReleaseDecisionVerificationBudget(limits);
type Case = {
  readonly name: string;
  readonly run: (factory: ReleaseApprovalRepositoryTestFactory) => Promise<void>;
};
function test(
  name: string,
  namespace: string,
  run: (h: ReleaseApprovalRepositoryTestHarness) => Promise<void>,
): Case {
  return {
    name,
    async run(factory) {
      const h = await factory(namespace);
      try {
        await run(h);
      } finally {
        await h.dispose?.();
      }
    },
  };
}
const reason = (expected: ReleaseApprovalRepositoryError["reason"]) => (error: unknown) =>
  error instanceof ReleaseApprovalRepositoryError && error.reason === expected;
async function read(h: ReleaseApprovalRepositoryTestHarness, budget = meter()) {
  return h.repository.readReleaseApprovalSubject(
    h.fixture.scope,
    h.fixture.original.kind,
    h.fixture.subject,
    budget,
  );
}
function anotherReviewer(
  original: ReleaseApproval,
  principalId: string,
  patch: Partial<ReleaseApprovalDefinition> = {},
) {
  return approvalVersion(original, {
    reviewer: { ...original.reviewer, principalId, credentialId: `session_${principalId}` },
    authority: { ...original.authority, reviewerPrincipalId: principalId },
    ...patch,
  });
}
export const releaseApprovalRepositoryConformanceCases: readonly Case[] = [
  test("charges exact subject absence without inventing an approval", "missing", async (h) => {
    const budget = meter();
    assert.deepEqual(await read(h, budget), { records: [], revocations: [] });
    assert.equal(budget.snapshot().records, 1);
    assert.equal(
      await h.repository.findReleaseApproval(h.fixture.scope, h.fixture.original.approvalId),
      null,
    );
  }),
  test(
    "preserves the first complete approval across a new login, native receipt and derived current authority version",
    "retry",
    async (h) => {
      const original = h.fixture.original;
      assert.deepEqual(await h.repository.publishReleaseApproval(original), {
        created: true,
        approval: original,
      });
      const retried = approvalVersion(original, {
        reviewer: {
          ...original.reviewer,
          credentialId: "session_new_login",
          requestId: "request_retry",
          authenticatedAt: "2026-10-15T10:10:00.000Z",
        },
        authority: {
          ...original.authority,
          authorityVersionId: "authority_current_version",
          definitionSha256: "1".repeat(64),
        },
        recordedAt: "2026-10-15T10:15:00.000001Z",
      });
      assert.notEqual(retried.definitionSha256, original.definitionSha256);
      assert.deepEqual(await h.repository.publishReleaseApproval(retried), {
        created: false,
        approval: original,
      });
      assert.deepEqual((await read(h)).records, [original]);
      await h.repository.publishReleaseApprovalRevocation(h.fixture.revocation);
      assert.deepEqual(await h.repository.publishReleaseApproval(retried), {
        created: false,
        approval: original,
      });
      assert.deepEqual((await read(h)).revocations, [h.fixture.revocation]);
    },
  ),
  test("rejects another reviewer reusing an existing action ID", "reviewer_conflict", async (h) => {
    await h.repository.publishReleaseApproval(h.fixture.original);
    await assert.rejects(
      h.repository.publishReleaseApproval(anotherReviewer(h.fixture.original, "reviewer_other")),
      reason("approval_conflict"),
    );
    assert.deepEqual((await read(h)).records, [h.fixture.original]);
  }),
  ...(["action", "rationale", "expires", "condition", "subject"] as const).map((kind) =>
    test(
      `rejects changed ${kind} intent without altering original receipts`,
      `intent_${kind}`,
      async (h) => {
        const original = h.fixture.original;
        await h.repository.publishReleaseApproval(original);
        const patch: Partial<ReleaseApprovalDefinition> =
          kind === "action"
            ? { action: "oppose" }
            : kind === "rationale"
              ? { rationale: "Changed original review intent." }
              : kind === "expires"
                ? { expiresAt: "2026-10-15T12:00:00.000001Z" }
                : kind === "condition"
                  ? { conditions: ["An unresolved condition."] }
                  : { subject: { ...original.subject, ruleId: "rule_different" } };
        await assert.rejects(
          h.repository.publishReleaseApproval(approvalVersion(original, patch)),
          reason("approval_conflict"),
        );
        assert.deepEqual((await read(h)).records, [original]);
      },
    ),
  ),
  ...(["tenantId", "projectId", "environmentId"] as const).map((field) =>
    test(
      `isolates exact ${field} before reading approval or revocation`,
      `scope_${field.toLowerCase()}`,
      async (h) => {
        await h.repository.publishReleaseApproval(h.fixture.original);
        await h.repository.publishReleaseApprovalRevocation(h.fixture.revocation);
        const scope = { ...h.fixture.scope, [field]: "scope_other" };
        assert.equal(
          await h.repository.findReleaseApproval(scope, h.fixture.original.approvalId),
          null,
        );
        assert.equal(
          await h.repository.findReleaseApprovalRevocation(scope, h.fixture.revocation.eventId),
          null,
        );
        assert.deepEqual(
          await h.repository.readReleaseApprovalSubject(
            scope,
            h.fixture.original.kind,
            { ...h.fixture.subject, scope },
            meter(),
          ),
          { records: [], revocations: [] },
        );
      },
    ),
  ),
  test(
    "retains colliding approval/event IDs in all three tenants after every write",
    "tenants",
    async (h) => {
      const retained: { row: ReleaseApproval; event: typeof h.fixture.revocation }[] = [];
      for (const tenantId of [
        h.fixture.scope.tenantId,
        "tenant_approval_two",
        "tenant_approval_three",
      ]) {
        const scope = { ...h.fixture.scope, tenantId },
          row = approvalVersion(h.fixture.original, { subject: { ...h.fixture.subject, scope } });
        await h.repository.publishReleaseApproval(row);
        const event = approvalRevocation(h.fixture.revocation, {
          scope,
          approval: releaseApprovalReference(row),
        });
        await h.repository.publishReleaseApprovalRevocation(event);
        retained.push({ row, event });
      }
      for (const { row, event } of retained) {
        assert.deepEqual(
          await h.repository.findReleaseApproval(row.subject.scope, row.approvalId),
          row,
        );
        assert.deepEqual(
          await h.repository.readReleaseApprovalSubject(
            row.subject.scope,
            row.kind,
            row.subject,
            meter(),
          ),
          { records: [row], revocations: [event] },
        );
      }
    },
  ),
  test(
    "keeps every action, unresolved declaration, expired original and revocation without a favorable filter",
    "complete",
    async (h) => {
      const rows = [
        h.fixture.original,
        ...(["oppose", "escalate", "abstain"] as const).map((action, index) =>
          anotherReviewer(h.fixture.original, `reviewer_${index}`, {
            approvalId: `approval_other_${index}`,
            action,
            conditions: ["Unresolved declared condition."],
            declaredConflicts: ["Declared relationship."],
          }),
        ),
      ];
      for (const row of rows) await h.repository.publishReleaseApproval(row);
      await h.repository.publishReleaseApprovalRevocation(h.fixture.revocation);
      const census = await read(h);
      assert.deepEqual(
        census.records.map((row) => row.approvalId),
        rows.map((row) => row.approvalId).sort(),
      );
      assert.deepEqual(census.revocations, [h.fixture.revocation]);
      assert.deepEqual(
        census.records.find((row) => row.approvalId === h.fixture.original.approvalId),
        h.fixture.original,
      );
    },
  ),
  test(
    "keeps normal approval and known-rule exception inventories separate for the same exact subject",
    "kind",
    async (h) => {
      await h.repository.publishReleaseApproval(h.fixture.original);
      const exception = approvalVersion(h.fixture.original, {
        approvalId: "approval_exception",
        kind: "rule_exception",
        action: "oppose",
      });
      await h.repository.publishReleaseApproval(exception);
      assert.deepEqual((await read(h)).records, [h.fixture.original]);
      assert.deepEqual(
        await h.repository.readReleaseApprovalSubject(
          h.fixture.scope,
          "rule_exception",
          h.fixture.subject,
          meter(),
        ),
        { records: [exception], revocations: [] },
      );
      assert.deepEqual(
        await h.repository.readReleaseApprovalSubject(
          h.fixture.scope,
          h.fixture.original.kind,
          { ...h.fixture.subject, ruleId: "rule_unbound" },
          meter(),
        ),
        { records: [], revocations: [] },
      );
    },
  ),
  test("returns owned input/approval/revocation/census copies", "copies", async (h) => {
    const input = structuredClone(h.fixture.original);
    const result = await h.repository.publishReleaseApproval(input);
    input.conditions.push("Input mutation");
    result.approval.reviewer.requestId = "request_mutated";
    const census = await read(h);
    census.records[0]?.declaredConflicts.push("Response mutation");
    const event = await h.repository.publishReleaseApprovalRevocation(h.fixture.revocation);
    event.event.reason = "Response mutation";
    assert.deepEqual(
      await h.repository.findReleaseApproval(h.fixture.scope, input.approvalId),
      h.fixture.original,
    );
    assert.deepEqual(
      await h.repository.findReleaseApprovalRevocation(h.fixture.scope, event.event.eventId),
      h.fixture.revocation,
    );
  }),
  test(
    "preserves exact supersession and revocation history without rewriting the predecessor",
    "lineage",
    async (h) => {
      await h.repository.publishReleaseApproval(h.fixture.original);
      await h.repository.publishReleaseApproval(h.fixture.successor);
      await h.repository.publishReleaseApprovalRevocation(h.fixture.revocation);
      assert.deepEqual(await read(h), {
        records: [h.fixture.original, h.fixture.successor],
        revocations: [h.fixture.revocation],
      });
      assert.deepEqual(
        await h.repository.findReleaseApproval(h.fixture.scope, h.fixture.original.approvalId),
        h.fixture.original,
      );
    },
  ),
  ...(["missing", "digest", "principal", "subject", "kind", "receipt"] as const).map((kind) =>
    test(`rejects ${kind} supersession lineage wholly`, `lineage_${kind}`, async (h) => {
      if (kind !== "missing") await h.repository.publishReleaseApproval(h.fixture.original);
      let row = h.fixture.successor;
      if (kind === "digest")
        row = approvalVersion(row, {
          supersedes: {
            ...releaseApprovalReference(h.fixture.original),
            definitionSha256: "0".repeat(64),
          },
        });
      if (kind === "principal") row = anotherReviewer(row, "reviewer_other");
      if (kind === "subject")
        row = approvalVersion(row, { subject: { ...row.subject, ruleId: "rule_other" } });
      if (kind === "kind") row = approvalVersion(row, { kind: "rule_exception", action: "oppose" });
      if (kind === "receipt")
        row = approvalVersion(row, { recordedAt: "2026-10-15T10:00:05.000000999999999999Z" });
      await assert.rejects(
        h.repository.publishReleaseApproval(row),
        reason(kind === "receipt" ? "receipt_invalid" : "lineage_invalid"),
      );
      assert.equal(await h.repository.findReleaseApproval(h.fixture.scope, row.approvalId), null);
    }),
  ),
  test(
    "linearizes simultaneous original retries and rejects a second successor fork",
    "races",
    async (h) => {
      const attempts = await Promise.all(
        Array.from({ length: 8 }, () => h.repository.publishReleaseApproval(h.fixture.original)),
      );
      assert.equal(attempts.filter((row) => row.created).length, 1);
      const competing = approvalVersion(h.fixture.successor, {
        approvalId: "approval_competing_successor",
      });
      const results = await Promise.allSettled([
        h.repository.publishReleaseApproval(h.fixture.successor),
        h.repository.publishReleaseApproval(competing),
      ]);
      assert.equal(results.filter((row) => row.status === "fulfilled").length, 1);
      assert.equal(results.filter((row) => row.status === "rejected").length, 1);
      assert.equal((await read(h)).records.length, 2);
    },
  ),
  test(
    "preserves original revocation receipt across another login receipt",
    "revoke_retry",
    async (h) => {
      await h.repository.publishReleaseApproval(h.fixture.original);
      await h.repository.publishReleaseApprovalRevocation(h.fixture.revocation);
      const newer = approvalRevocation(h.fixture.revocation, {
        reviewer: {
          ...h.fixture.revocation.reviewer,
          credentialId: "session_revoke_new",
          requestId: "request_revoke_retry",
          authenticatedAt: "2026-10-15T10:25:00.000Z",
        },
        occurredAt: "2026-10-15T10:30:00.000001Z",
      });
      assert.deepEqual(await h.repository.publishReleaseApprovalRevocation(newer), {
        created: false,
        event: h.fixture.revocation,
      });
      assert.deepEqual((await read(h)).records, [h.fixture.original]);
    },
  ),
  ...(["missing", "digest", "reviewer", "receipt", "body", "second"] as const).map((kind) =>
    test(`rejects ${kind} revocation wholly`, `revoke_${kind}`, async (h) => {
      if (kind !== "missing") await h.repository.publishReleaseApproval(h.fixture.original);
      if (kind === "body" || kind === "second")
        await h.repository.publishReleaseApprovalRevocation(h.fixture.revocation);
      const event = approvalRevocation(
        h.fixture.revocation,
        kind === "digest"
          ? { approval: { ...h.fixture.revocation.approval, definitionSha256: "0".repeat(64) } }
          : kind === "reviewer"
            ? { reviewer: { ...h.fixture.revocation.reviewer, principalId: "reviewer_other" } }
            : kind === "receipt"
              ? { occurredAt: "2026-10-15T10:00:05.000000999999999999Z" }
              : kind === "body"
                ? { reason: "Different revocation intent" }
                : kind === "second"
                  ? { eventId: "event_second_revoke" }
                  : {},
      );
      await assert.rejects(
        h.repository.publishReleaseApprovalRevocation(event),
        reason(
          kind === "receipt"
            ? "receipt_invalid"
            : kind === "body"
              ? "revocation_conflict"
              : kind === "second"
                ? "revocation_state_conflict"
                : "lineage_invalid",
        ),
      );
      assert.deepEqual(
        (await read(h)).revocations,
        kind === "body" || kind === "second" ? [h.fixture.revocation] : [],
      );
    }),
  ),
  test(
    "charges complete repeated inventories, accepts exact quotas and rejects one-below without returning a prefix",
    "budget",
    async (h) => {
      await h.repository.publishReleaseApproval(h.fixture.original);
      await h.repository.publishReleaseApproval(h.fixture.successor);
      await h.repository.publishReleaseApprovalRevocation(h.fixture.revocation);
      const budget = meter(),
        census = await read(h, budget),
        cost = budget.snapshot();
      const retained = [...census.records, ...census.revocations];
      assert.ok(cost.records >= retained.length);
      assert.ok(cost.approvalRecords >= census.records.length);
      assert.ok(
        cost.recordBytes >=
          retained.reduce((sum, row) => sum + encodeEvaluationCanonicalJson(row).byteLength, 0),
      );
      const exact = new ReleaseDecisionVerificationBudget({
        maxAcquisitionRecords: cost.records,
        maxAcquisitionRecordBytes: cost.recordBytes,
        maxApprovalRecords: cost.approvalRecords,
      });
      assert.deepEqual(await read(h, exact), census);
      assert.deepEqual(exact.snapshot(), cost);
      await read(h, budget);
      assert.equal(budget.snapshot().records, cost.records * 2);
      assert.equal(budget.snapshot().approvalRecords, cost.approvalRecords * 2);
      for (const patch of [
        { maxAcquisitionRecords: cost.records - 1 },
        { maxAcquisitionRecordBytes: cost.recordBytes - 1 },
        { maxApprovalRecords: cost.approvalRecords - 1 },
      ]) {
        const smaller = new ReleaseDecisionVerificationBudget({ ...limits, ...patch });
        await assert.rejects(read(h, smaller), ReleaseDecisionVerificationBudgetError);
        assert.throws(() => smaller.snapshot(), ReleaseDecisionVerificationBudgetError);
      }
    },
  ),
];
