import assert from "node:assert/strict";
import { encodeEvaluationCanonicalJson, type EvidenceScope } from "@proofstack/contracts";
import {
  ReleaseReviewerAuthorityRepositoryError,
  type ReleaseReviewerAuthorityRepository,
} from "../release/release-reviewer-authority-repository.js";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "../release/release-decision-verification-budget.js";
import { releaseReviewerAuthorityReference } from "../release/release-authority-record-validation.js";
import { resolveCapturedReleaseReviewerCensus } from "../release/release-reviewer-census.js";
import {
  type releaseReviewerAuthorityRepositoryFixture,
  authorityVersion,
} from "./release-reviewer-authority-repository-fixtures.js";

export interface ReleaseReviewerAuthorityRepositoryTestHarness {
  readonly repository: ReleaseReviewerAuthorityRepository;
  readonly fixture: ReturnType<typeof releaseReviewerAuthorityRepositoryFixture>;
  readonly dispose?: () => Promise<void>;
}
export type ReleaseReviewerAuthorityRepositoryTestFactory = (
  namespace: string,
) =>
  | ReleaseReviewerAuthorityRepositoryTestHarness
  | Promise<ReleaseReviewerAuthorityRepositoryTestHarness>;
const limits = {
  maxAcquisitionRecords: 100_000,
  maxAcquisitionRecordBytes: 64 * 1024 * 1024,
  maxApprovalRecords: 4096,
};
const budget = () => new ReleaseDecisionVerificationBudget(limits);
type Case = {
  readonly name: string;
  readonly run: (factory: ReleaseReviewerAuthorityRepositoryTestFactory) => Promise<void>;
};
function test(
  name: string,
  namespace: string,
  run: (h: ReleaseReviewerAuthorityRepositoryTestHarness) => Promise<void>,
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
async function read(h: ReleaseReviewerAuthorityRepositoryTestHarness, meter = budget()) {
  return h.repository.readReleaseReviewerAuthorityTarget(h.fixture.scope, h.fixture.target, meter);
}
const reason = (expected: ReleaseReviewerAuthorityRepositoryError["reason"]) => (error: unknown) =>
  error instanceof ReleaseReviewerAuthorityRepositoryError && error.reason === expected;
export const releaseReviewerAuthorityRepositoryConformanceCases: readonly Case[] = [
  test(
    "owns separate roots for distinct reviewers of the same installation gate",
    "reviewer_roots",
    async (h) => {
      const { original } = h.fixture;
      await h.repository.publishReleaseReviewerAuthority(original);
      const other = authorityVersion(
        original,
        {
          authorityId: "authority_other_reviewer",
          authorityVersionId: "version_other_reviewer",
          reviewerPrincipalId: "reviewer_other",
        },
        original.publishedAt,
      );
      await h.repository.publishReleaseReviewerAuthority(other);
      const first = await read(h);
      const second = await h.repository.readReleaseReviewerAuthorityTarget(
        h.fixture.scope,
        { ...h.fixture.target, reviewerPrincipalId: other.reviewerPrincipalId },
        budget(),
      );
      assert.deepEqual(first.root, original);
      assert.deepEqual(first.records, [original]);
      assert.deepEqual(second.root, other);
      assert.deepEqual(second.records, [other]);
      assert.deepEqual(
        await h.repository.readReleaseReviewerAuthorityTarget(
          h.fixture.scope,
          { ...h.fixture.target, reviewerPrincipalId: "reviewer_unbound" },
          budget(),
        ),
        { root: null, records: [], lifecycle: [] },
      );
    },
  ),
  test(
    "retains synthetic provenance and unverified/rejected competing declarations without upgrading them",
    "status",
    async (h) => {
      await h.repository.publishReleaseReviewerAuthority(h.fixture.original);
      const uncertain = authorityVersion(
        h.fixture.original,
        {
          authorityVersionId: "version_unverifiable",
          status: "unverifiable",
          statusReasons: ["Independent qualification could not be verified."],
        },
        h.fixture.successor.publishedAt,
      );
      const rejected = authorityVersion(
        h.fixture.original,
        {
          authorityVersionId: "version_rejected",
          status: "rejected",
          statusReasons: ["The operator rejected this declaration."],
          conflicts: ["Declared subject relationship remains unresolved."],
        },
        h.fixture.successor.publishedAt,
      );
      await h.repository.publishReleaseReviewerAuthority(uncertain);
      await h.repository.publishReleaseReviewerAuthority(rejected);
      const census = await read(h);
      assert.equal(census.records.length, 3);
      assert.ok(census.records.every((row) => row.assurance === "synthetic_reference"));
      assert.deepEqual(
        census.records.find((row) => row.authorityVersionId === uncertain.authorityVersionId),
        uncertain,
      );
      assert.deepEqual(
        census.records.find((row) => row.authorityVersionId === rejected.authorityVersionId),
        rejected,
      );
    },
  ),
  test(
    "rejects self-issued or forged canonical authority before creating a target/version",
    "invalid_authority",
    async (h) => {
      for (const row of [
        { ...h.fixture.original, reviewerPrincipalId: h.fixture.original.issuerPrincipalId },
        { ...h.fixture.original, definitionSha256: "0".repeat(64) },
      ]) {
        await assert.rejects(h.repository.publishReleaseReviewerAuthority(row));
        assert.equal(
          await h.repository.findReleaseReviewerAuthority(h.fixture.scope, row.authorityVersionId),
          null,
        );
        assert.deepEqual(
          await h.repository.readReleaseReviewerAuthorityTarget(
            h.fixture.scope,
            { ...h.fixture.target, reviewerPrincipalId: row.reviewerPrincipalId },
            budget(),
          ),
          { root: null, records: [], lifecycle: [] },
        );
      }
    },
  ),
  test(
    "keeps future-effective versions in the full owning inventory",
    "future_version",
    async (h) => {
      await h.repository.publishReleaseReviewerAuthority(h.fixture.original);
      const future = authorityVersion(
        h.fixture.original,
        {
          authorityVersionId: "version_future_effective",
          effectiveAt: "2026-10-15T13:00:00.000001Z",
        },
        h.fixture.successor.publishedAt,
      );
      await h.repository.publishReleaseReviewerAuthority(future);
      const census = await read(h);
      assert.equal(census.records.length, 2);
      assert.ok(census.records.some((row) => row.authorityVersionId === future.authorityVersionId));
      assert.equal(census.root?.authorityVersionId, h.fixture.original.authorityVersionId);
    },
  ),
  test(
    "compares submicrosecond lifecycle receipts without rounding through Date",
    "native_precision",
    async (h) => {
      const original = { ...h.fixture.original, publishedAt: "2026-10-15T11:00:00.000001Z" };
      await h.repository.publishReleaseReviewerAuthority(original);
      await assert.rejects(
        h.repository.publishReleaseReviewerAuthorityLifecycleEvent({
          ...h.fixture.revocation,
          occurredAt: "2026-10-15T11:00:00.000000999999999999Z",
        }),
        reason("receipt_invalid"),
      );
      await h.repository.publishReleaseReviewerAuthorityLifecycleEvent({
        ...h.fixture.revocation,
        occurredAt: original.publishedAt,
      });
      assert.equal((await read(h)).lifecycle[0]?.occurredAt, original.publishedAt);
    },
  ),
  test(
    "charges an absent reviewer target without inventing verified authority",
    "missing",
    async (h) => {
      const meter = budget();
      assert.deepEqual(await read(h, meter), { root: null, records: [], lifecycle: [] });
      assert.equal(meter.snapshot().records, 1);
      assert.equal(
        await h.repository.findReleaseReviewerAuthority(
          h.fixture.scope,
          h.fixture.original.authorityVersionId,
        ),
        null,
      );
    },
  ),
  test(
    "derives its immutable target root and retains all competing versions without choosing latest",
    "complete",
    async (h) => {
      const { original, successor } = h.fixture;
      await h.repository.publishReleaseReviewerAuthority(original);
      await h.repository.publishReleaseReviewerAuthority(successor);
      const census = await read(h);
      assert.deepEqual(census.root, original);
      assert.deepEqual(census.records, [original, successor]);
      const result = resolveCapturedReleaseReviewerCensus({
        scope: h.fixture.scope,
        reference: releaseReviewerAuthorityReference(original),
        capturedAt: "2026-10-15T12:00:00.000001Z",
        census: { state: "complete", records: census.records, lifecycle: census.lifecycle },
        budget: budget(),
      });
      assert.equal(result.state, "conflicting");
    },
  ),
  test(
    "preserves first publication and terminal receipts across identical retries",
    "receipts",
    async (h) => {
      const { original, revocation } = h.fixture;
      assert.deepEqual(await h.repository.publishReleaseReviewerAuthority(original), {
        created: true,
        authority: original,
      });
      assert.deepEqual(
        await h.repository.publishReleaseReviewerAuthority({
          ...original,
          publishedAt: "2026-10-15T11:00:00.000002Z",
        }),
        { created: false, authority: original },
      );
      await h.repository.publishReleaseReviewerAuthorityLifecycleEvent(revocation);
      assert.deepEqual(
        await h.repository.publishReleaseReviewerAuthorityLifecycleEvent({
          ...revocation,
          occurredAt: "2026-10-15T11:00:00.000002Z",
          actorPrincipalId: "principal_retry",
        }),
        { created: false, event: revocation },
      );
      assert.deepEqual((await read(h)).lifecycle, [revocation]);
    },
  ),
  ...(["tenantId", "projectId", "environmentId"] as const).map((field) =>
    test(
      `reads neither versions nor target/history outside exact ${field}`,
      `scope_${field.toLowerCase()}`,
      async (h) => {
        await h.repository.publishReleaseReviewerAuthority(h.fixture.original);
        await h.repository.publishReleaseReviewerAuthorityLifecycleEvent(h.fixture.revocation);
        const scope = { ...h.fixture.scope, [field]: "scope_other" };
        assert.equal(
          await h.repository.findReleaseReviewerAuthority(
            scope,
            h.fixture.original.authorityVersionId,
          ),
          null,
        );
        assert.equal(
          await h.repository.findReleaseReviewerAuthorityLifecycleEvent(
            scope,
            h.fixture.revocation.eventId,
          ),
          null,
        );
        assert.deepEqual(
          await h.repository.readReleaseReviewerAuthorityTarget(scope, h.fixture.target, budget()),
          { root: null, records: [], lifecycle: [] },
        );
      },
    ),
  ),
  test(
    "isolates colliding authority/version/reviewer-target/event IDs in three tenants",
    "tenants",
    async (h) => {
      const retained: {
        scope: EvidenceScope;
        row: typeof h.fixture.original;
        event: typeof h.fixture.revocation;
      }[] = [];
      for (const tenantId of [
        h.fixture.scope.tenantId,
        "tenant_reviewer_two",
        "tenant_reviewer_three",
      ]) {
        const scope: EvidenceScope = { ...h.fixture.scope, tenantId };
        const row = authorityVersion(h.fixture.original, { scope }, h.fixture.original.publishedAt);
        await h.repository.publishReleaseReviewerAuthority(row);
        const event = {
          ...h.fixture.revocation,
          scope,
          authority: releaseReviewerAuthorityReference(row),
        };
        await h.repository.publishReleaseReviewerAuthorityLifecycleEvent(event);
        retained.push({ scope, row, event });
      }
      // Read all three again AFTER every colliding write; immediate per-tenant readback alone
      // would miss a broken implementation that overwrites earlier tenants on the next write.
      for (const { scope, row, event } of retained) {
        assert.deepEqual(
          await h.repository.findReleaseReviewerAuthority(scope, row.authorityVersionId),
          row,
        );
        assert.deepEqual(
          (await h.repository.readReleaseReviewerAuthorityTarget(scope, h.fixture.target, budget()))
            .lifecycle,
          [event],
        );
      }
    },
  ),
  test(
    "never exposes caller input or returned nested collections as stored state",
    "ownership",
    async (h) => {
      const input = structuredClone(h.fixture.original),
        expected = structuredClone(input);
      const published = await h.repository.publishReleaseReviewerAuthority(input);
      input.roleIds.push("principal_input_mutation");
      published.authority.roleIds.push("principal_response_mutation");
      const first = await read(h);
      first.root?.roleIds.push("principal_root_mutation");
      first.records[0]?.reviewBasis.pop();
      assert.deepEqual(
        await h.repository.findReleaseReviewerAuthority(
          h.fixture.scope,
          expected.authorityVersionId,
        ),
        expected,
      );
      await h.repository.publishReleaseReviewerAuthorityLifecycleEvent(h.fixture.revocation);
      const event = await h.repository.findReleaseReviewerAuthorityLifecycleEvent(
        h.fixture.scope,
        h.fixture.revocation.eventId,
      );
      if (!event) throw new Error("Missing stored event");
      event.reason = "Changed response";
      assert.deepEqual((await read(h)).lifecycle, [h.fixture.revocation]);
    },
  ),
  ...(["authorityId", "installationId", "gateTargetId", "reviewerPrincipalId"] as const).map(
    (field) =>
      test(
        `rejects immutable target/logical-root reassignment through ${field}`,
        `binding_${field.toLowerCase()}`,
        async (h) => {
          await h.repository.publishReleaseReviewerAuthority(h.fixture.original);
          const changed = authorityVersion(
            h.fixture.original,
            { [field]: "other_binding", authorityVersionId: "version_reassignment" },
            h.fixture.original.publishedAt,
          );
          await assert.rejects(
            h.repository.publishReleaseReviewerAuthority(changed),
            reason("target_conflict"),
          );
          assert.deepEqual((await read(h)).records, [h.fixture.original]);
        },
      ),
  ),
  test(
    "rejects a substituted immutable version and preserves the entire prior graph",
    "version_conflict",
    async (h) => {
      await h.repository.publishReleaseReviewerAuthority(h.fixture.original);
      const changed = authorityVersion(
        h.fixture.original,
        { rationale: "Different valid declaration" },
        h.fixture.original.publishedAt,
      );
      await assert.rejects(
        h.repository.publishReleaseReviewerAuthority(changed),
        reason("version_conflict"),
      );
      assert.deepEqual((await read(h)).records, [h.fixture.original]);
    },
  ),
  ...(["missing", "digest", "future_receipt"] as const).map((kind) =>
    test(
      `rejects ${kind} predecessor without creating a partial target`,
      `parent_${kind}`,
      async (h) => {
        if (kind !== "missing")
          await h.repository.publishReleaseReviewerAuthority(h.fixture.original);
        const previous = releaseReviewerAuthorityReference(h.fixture.original);
        const changed = authorityVersion(
          h.fixture.successor,
          {
            predecessor:
              kind === "digest" ? { ...previous, definitionSha256: "0".repeat(64) } : previous,
          },
          kind === "future_receipt"
            ? "2026-10-15T00:00:00.000000000001Z"
            : h.fixture.successor.publishedAt,
        );
        await assert.rejects(
          h.repository.publishReleaseReviewerAuthority(changed),
          reason(kind === "future_receipt" ? "receipt_invalid" : "lineage_invalid"),
        );
        assert.equal(
          await h.repository.findReleaseReviewerAuthority(
            h.fixture.scope,
            changed.authorityVersionId,
          ),
          null,
        );
      },
    ),
  ),
  test(
    "preserves exact supersession, old root and revocation history without reactivation",
    "lifecycle",
    async (h) => {
      const { original, successor, supersession, revocation } = h.fixture;
      await h.repository.publishReleaseReviewerAuthority(original);
      await h.repository.publishReleaseReviewerAuthority(successor);
      await h.repository.publishReleaseReviewerAuthorityLifecycleEvent(supersession);
      const later = {
        ...revocation,
        eventId: "event_revoke_successor",
        authority: releaseReviewerAuthorityReference(successor),
        occurredAt: "2026-10-15T11:00:00.000002Z",
      };
      await h.repository.publishReleaseReviewerAuthorityLifecycleEvent(later);
      const census = await read(h);
      assert.deepEqual(census.root, original);
      assert.deepEqual(census.lifecycle, [supersession, later]);
      assert.equal(
        resolveCapturedReleaseReviewerCensus({
          scope: h.fixture.scope,
          reference: releaseReviewerAuthorityReference(successor),
          capturedAt: "2026-10-15T12:00:00.000001Z",
          census: { state: "complete", records: census.records, lifecycle: census.lifecycle },
          budget: budget(),
        }).state,
        "revoked",
      );
    },
  ),
  test(
    "rejects missing/mismatched successors and events before native publication receipts",
    "invalid_events",
    async (h) => {
      await h.repository.publishReleaseReviewerAuthority(h.fixture.original);
      await assert.rejects(
        h.repository.publishReleaseReviewerAuthorityLifecycleEvent(h.fixture.supersession),
        reason("lineage_invalid"),
      );
      await assert.rejects(
        h.repository.publishReleaseReviewerAuthorityLifecycleEvent({
          ...h.fixture.revocation,
          occurredAt: "2026-10-15T00:00:00.000000000001Z",
        }),
        reason("receipt_invalid"),
      );
      assert.deepEqual((await read(h)).lifecycle, []);
    },
  ),
  test(
    "rejects changed event bodies and a second terminal without overwriting first receipts",
    "terminal",
    async (h) => {
      await h.repository.publishReleaseReviewerAuthority(h.fixture.original);
      await h.repository.publishReleaseReviewerAuthorityLifecycleEvent(h.fixture.revocation);
      await assert.rejects(
        h.repository.publishReleaseReviewerAuthorityLifecycleEvent({
          ...h.fixture.revocation,
          reason: "Changed original intent",
        }),
        reason("event_conflict"),
      );
      await assert.rejects(
        h.repository.publishReleaseReviewerAuthorityLifecycleEvent({
          ...h.fixture.revocation,
          eventId: "event_second_terminal",
        }),
        reason("terminal_conflict"),
      );
      assert.deepEqual((await read(h)).lifecycle, [h.fixture.revocation]);
    },
  ),
  test(
    "linearizes simultaneous identical and conflicting publications",
    "concurrent",
    async (h) => {
      const published = await Promise.all(
        Array.from({ length: 8 }, () =>
          h.repository.publishReleaseReviewerAuthority(structuredClone(h.fixture.original)),
        ),
      );
      assert.equal(published.filter((row) => row.created).length, 1);
      const events = await Promise.allSettled([
        h.repository.publishReleaseReviewerAuthorityLifecycleEvent(h.fixture.revocation),
        h.repository.publishReleaseReviewerAuthorityLifecycleEvent({
          ...h.fixture.revocation,
          eventId: "event_racing_terminal",
        }),
      ]);
      assert.equal(events.filter((row) => row.status === "fulfilled").length, 1);
      assert.equal(events.filter((row) => row.status === "rejected").length, 1);
      assert.equal((await read(h)).lifecycle.length, 1);
    },
  ),
  test(
    "charges repeated full inventories to one original meter and never returns a budget-truncated census",
    "budget",
    async (h) => {
      await h.repository.publishReleaseReviewerAuthority(h.fixture.original);
      await h.repository.publishReleaseReviewerAuthority(h.fixture.successor);
      await h.repository.publishReleaseReviewerAuthorityLifecycleEvent(h.fixture.supersession);
      const meter = budget();
      const census = await read(h, meter);
      const first = meter.snapshot();
      const minimumRows = [census.root, ...census.records, ...census.lifecycle];
      assert.ok(first.records >= minimumRows.length);
      assert.ok(
        first.recordBytes >=
          minimumRows.reduce(
            (total, row) => total + encodeEvaluationCanonicalJson(row).byteLength,
            0,
          ),
      );
      const exactMeter = new ReleaseDecisionVerificationBudget({
        ...limits,
        maxAcquisitionRecords: first.records,
        maxAcquisitionRecordBytes: first.recordBytes,
      });
      assert.deepEqual(await read(h, exactMeter), census);
      assert.deepEqual(exactMeter.snapshot(), first);
      await read(h, meter);
      assert.equal(meter.snapshot().records, first.records * 2);
      assert.equal(meter.snapshot().recordBytes, first.recordBytes * 2);
      for (const patch of [
        { maxAcquisitionRecords: first.records - 1 },
        { maxAcquisitionRecordBytes: first.recordBytes - 1 },
      ]) {
        const shorter = new ReleaseDecisionVerificationBudget({ ...limits, ...patch });
        await assert.rejects(read(h, shorter), ReleaseDecisionVerificationBudgetError);
        assert.throws(() => shorter.snapshot(), ReleaseDecisionVerificationBudgetError);
      }
      assert.deepEqual((await read(h)).records, [h.fixture.original, h.fixture.successor]);
    },
  ),
];
