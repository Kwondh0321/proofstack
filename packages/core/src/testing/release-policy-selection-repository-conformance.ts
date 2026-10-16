import assert from "node:assert/strict";
import { encodeEvaluationCanonicalJson, type EvidenceScope } from "@proofstack/contracts";
import {
  ReleasePolicySelectionRepositoryError,
  type ReleasePolicySelectionRepository,
} from "../release/release-policy-selection-repository.js";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "../release/release-decision-verification-budget.js";
import { releasePolicySelectionReference } from "../release/release-authority-record-validation.js";
import { resolveCapturedReleaseSelectionCensus } from "../release/release-selection-census.js";
import {
  type releasePolicySelectionRepositoryFixture,
  selectionVersion,
} from "./release-policy-selection-repository-fixtures.js";

export interface ReleasePolicySelectionRepositoryTestHarness {
  readonly repository: ReleasePolicySelectionRepository;
  readonly fixture: ReturnType<typeof releasePolicySelectionRepositoryFixture>;
  readonly dispose?: () => Promise<void>;
}
export type ReleasePolicySelectionRepositoryTestFactory = (
  namespace: string,
) =>
  | ReleasePolicySelectionRepositoryTestHarness
  | Promise<ReleasePolicySelectionRepositoryTestHarness>;
const limits = {
  maxAcquisitionRecords: 100_000,
  maxAcquisitionRecordBytes: 64 * 1024 * 1024,
  maxApprovalRecords: 4096,
};
const budget = () => new ReleaseDecisionVerificationBudget(limits);
type Case = {
  readonly name: string;
  readonly run: (factory: ReleasePolicySelectionRepositoryTestFactory) => Promise<void>;
};
function test(
  name: string,
  namespace: string,
  run: (h: ReleasePolicySelectionRepositoryTestHarness) => Promise<void>,
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
async function read(h: ReleasePolicySelectionRepositoryTestHarness, meter = budget()) {
  return h.repository.readReleasePolicySelectionTarget(h.fixture.scope, h.fixture.target, meter);
}
const reason = (expected: ReleasePolicySelectionRepositoryError["reason"]) => (error: unknown) =>
  error instanceof ReleasePolicySelectionRepositoryError && error.reason === expected;
export const releasePolicySelectionRepositoryConformanceCases: readonly Case[] = [
  test(
    "keeps future-effective versions in the full owning inventory",
    "future_version",
    async (h) => {
      await h.repository.publishReleasePolicySelection(h.fixture.original);
      const future = selectionVersion(
        h.fixture.original,
        {
          selectionVersionId: "version_future_effective",
          effectiveAt: "2026-10-15T13:00:00.000001Z",
        },
        h.fixture.successor.publishedAt,
      );
      await h.repository.publishReleasePolicySelection(future);
      const census = await read(h);
      assert.equal(census.records.length, 2);
      assert.ok(census.records.some((row) => row.selectionVersionId === future.selectionVersionId));
      assert.equal(census.root?.selectionVersionId, h.fixture.original.selectionVersionId);
    },
  ),
  test(
    "compares submicrosecond lifecycle receipts without rounding through Date",
    "native_precision",
    async (h) => {
      const original = { ...h.fixture.original, publishedAt: "2026-10-15T11:00:00.000001Z" };
      await h.repository.publishReleasePolicySelection(original);
      await assert.rejects(
        h.repository.publishReleasePolicySelectionLifecycleEvent({
          ...h.fixture.withdrawal,
          occurredAt: "2026-10-15T11:00:00.000000999999999999Z",
        }),
        reason("receipt_invalid"),
      );
      await h.repository.publishReleasePolicySelectionLifecycleEvent({
        ...h.fixture.withdrawal,
        occurredAt: original.publishedAt,
      });
      assert.equal((await read(h)).lifecycle[0]?.occurredAt, original.publishedAt);
    },
  ),
  test(
    "keeps a missing target distinct from an explicit observation-only selection and charges absence",
    "missing",
    async (h) => {
      const meter = budget();
      assert.deepEqual(await read(h, meter), { root: null, records: [], lifecycle: [] });
      assert.equal(meter.snapshot().records, 1);
      assert.equal(
        await h.repository.findReleasePolicySelection(
          h.fixture.scope,
          h.fixture.original.selectionVersionId,
        ),
        null,
      );
      const observationOnly = selectionVersion(
        h.fixture.original,
        { mode: "observation_only", policies: [] },
        h.fixture.original.publishedAt,
      );
      await h.repository.publishReleasePolicySelection(observationOnly);
      const stored = await read(h);
      assert.deepEqual(stored.root, observationOnly);
      assert.deepEqual(stored.records, [observationOnly]);
      assert.equal(stored.root?.mode, "observation_only");
      assert.deepEqual(stored.root?.policies, []);
    },
  ),
  test(
    "derives its immutable target root and retains all competing versions without choosing latest",
    "complete",
    async (h) => {
      const { original, successor } = h.fixture;
      await h.repository.publishReleasePolicySelection(original);
      await h.repository.publishReleasePolicySelection(successor);
      const census = await read(h);
      assert.deepEqual(census.root, original);
      assert.deepEqual(census.records, [original, successor]);
      const result = resolveCapturedReleaseSelectionCensus({
        scope: h.fixture.scope,
        reference: releasePolicySelectionReference(original),
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
      const { original, withdrawal } = h.fixture;
      assert.deepEqual(await h.repository.publishReleasePolicySelection(original), {
        created: true,
        selection: original,
      });
      assert.deepEqual(
        await h.repository.publishReleasePolicySelection({
          ...original,
          publishedAt: "2026-10-15T11:00:00.000002Z",
        }),
        { created: false, selection: original },
      );
      await h.repository.publishReleasePolicySelectionLifecycleEvent(withdrawal);
      assert.deepEqual(
        await h.repository.publishReleasePolicySelectionLifecycleEvent({
          ...withdrawal,
          occurredAt: "2026-10-15T11:00:00.000002Z",
          actorPrincipalId: "principal_retry",
        }),
        { created: false, event: withdrawal },
      );
      assert.deepEqual((await read(h)).lifecycle, [withdrawal]);
    },
  ),
  ...(["tenantId", "projectId", "environmentId"] as const).map((field) =>
    test(
      `reads neither versions nor target/history outside exact ${field}`,
      `scope_${field.toLowerCase()}`,
      async (h) => {
        await h.repository.publishReleasePolicySelection(h.fixture.original);
        await h.repository.publishReleasePolicySelectionLifecycleEvent(h.fixture.withdrawal);
        const scope = { ...h.fixture.scope, [field]: "scope_other" };
        assert.equal(
          await h.repository.findReleasePolicySelection(
            scope,
            h.fixture.original.selectionVersionId,
          ),
          null,
        );
        assert.equal(
          await h.repository.findReleasePolicySelectionLifecycleEvent(
            scope,
            h.fixture.withdrawal.eventId,
          ),
          null,
        );
        assert.deepEqual(
          await h.repository.readReleasePolicySelectionTarget(scope, h.fixture.target, budget()),
          { root: null, records: [], lifecycle: [] },
        );
      },
    ),
  ),
  test(
    "isolates colliding selection/version/target/event IDs in three tenants",
    "tenants",
    async (h) => {
      const retained: {
        scope: EvidenceScope;
        row: typeof h.fixture.original;
        event: typeof h.fixture.withdrawal;
      }[] = [];
      for (const tenantId of [
        h.fixture.scope.tenantId,
        "tenant_selection_two",
        "tenant_selection_three",
      ]) {
        const scope: EvidenceScope = { ...h.fixture.scope, tenantId };
        const row = selectionVersion(h.fixture.original, { scope }, h.fixture.original.publishedAt);
        await h.repository.publishReleasePolicySelection(row);
        const event = {
          ...h.fixture.withdrawal,
          scope,
          selection: releasePolicySelectionReference(row),
        };
        await h.repository.publishReleasePolicySelectionLifecycleEvent(event);
        retained.push({ scope, row, event });
      }
      // Read all three again AFTER every colliding write; immediate per-tenant readback alone
      // would miss a broken implementation that overwrites earlier tenants on the next write.
      for (const { scope, row, event } of retained) {
        assert.deepEqual(
          await h.repository.findReleasePolicySelection(scope, row.selectionVersionId),
          row,
        );
        assert.deepEqual(
          (await h.repository.readReleasePolicySelectionTarget(scope, h.fixture.target, budget()))
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
      const published = await h.repository.publishReleasePolicySelection(input);
      input.authorizedPublisherPrincipalIds.push("principal_input_mutation");
      published.selection.authorizedPublisherPrincipalIds.push("principal_response_mutation");
      const first = await read(h);
      first.root?.authorizedPublisherPrincipalIds.push("principal_root_mutation");
      first.records[0]?.policies.pop();
      assert.deepEqual(
        await h.repository.findReleasePolicySelection(h.fixture.scope, expected.selectionVersionId),
        expected,
      );
      await h.repository.publishReleasePolicySelectionLifecycleEvent(h.fixture.withdrawal);
      const event = await h.repository.findReleasePolicySelectionLifecycleEvent(
        h.fixture.scope,
        h.fixture.withdrawal.eventId,
      );
      if (!event) throw new Error("Missing stored event");
      event.reason = "Changed response";
      assert.deepEqual((await read(h)).lifecycle, [h.fixture.withdrawal]);
    },
  ),
  ...(["selectionId", "installationId", "gateTargetId"] as const).map((field) =>
    test(
      `rejects immutable target/logical-root reassignment through ${field}`,
      `binding_${field.toLowerCase()}`,
      async (h) => {
        await h.repository.publishReleasePolicySelection(h.fixture.original);
        const changed = selectionVersion(
          h.fixture.original,
          { [field]: "other_binding", selectionVersionId: "version_reassignment" },
          h.fixture.original.publishedAt,
        );
        await assert.rejects(
          h.repository.publishReleasePolicySelection(changed),
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
      await h.repository.publishReleasePolicySelection(h.fixture.original);
      const changed = selectionVersion(
        h.fixture.original,
        { rationale: "Different valid declaration" },
        h.fixture.original.publishedAt,
      );
      await assert.rejects(
        h.repository.publishReleasePolicySelection(changed),
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
          await h.repository.publishReleasePolicySelection(h.fixture.original);
        const previous = releasePolicySelectionReference(h.fixture.original);
        const changed = selectionVersion(
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
          h.repository.publishReleasePolicySelection(changed),
          reason(kind === "future_receipt" ? "receipt_invalid" : "lineage_invalid"),
        );
        assert.equal(
          await h.repository.findReleasePolicySelection(
            h.fixture.scope,
            changed.selectionVersionId,
          ),
          null,
        );
      },
    ),
  ),
  test(
    "preserves exact supersession, old root and withdrawal history without reactivation",
    "lifecycle",
    async (h) => {
      const { original, successor, supersession, withdrawal } = h.fixture;
      await h.repository.publishReleasePolicySelection(original);
      await h.repository.publishReleasePolicySelection(successor);
      await h.repository.publishReleasePolicySelectionLifecycleEvent(supersession);
      const later = {
        ...withdrawal,
        eventId: "event_withdraw_successor",
        selection: releasePolicySelectionReference(successor),
        occurredAt: "2026-10-15T11:00:00.000002Z",
      };
      await h.repository.publishReleasePolicySelectionLifecycleEvent(later);
      const census = await read(h);
      assert.deepEqual(census.root, original);
      assert.deepEqual(census.lifecycle, [supersession, later]);
      assert.equal(
        resolveCapturedReleaseSelectionCensus({
          scope: h.fixture.scope,
          reference: releasePolicySelectionReference(successor),
          capturedAt: "2026-10-15T12:00:00.000001Z",
          census: { state: "complete", records: census.records, lifecycle: census.lifecycle },
          budget: budget(),
        }).state,
        "withdrawn",
      );
    },
  ),
  test(
    "rejects missing/mismatched successors and events before native publication receipts",
    "invalid_events",
    async (h) => {
      await h.repository.publishReleasePolicySelection(h.fixture.original);
      await assert.rejects(
        h.repository.publishReleasePolicySelectionLifecycleEvent(h.fixture.supersession),
        reason("lineage_invalid"),
      );
      await assert.rejects(
        h.repository.publishReleasePolicySelectionLifecycleEvent({
          ...h.fixture.withdrawal,
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
      await h.repository.publishReleasePolicySelection(h.fixture.original);
      await h.repository.publishReleasePolicySelectionLifecycleEvent(h.fixture.withdrawal);
      await assert.rejects(
        h.repository.publishReleasePolicySelectionLifecycleEvent({
          ...h.fixture.withdrawal,
          reason: "Changed original intent",
        }),
        reason("event_conflict"),
      );
      await assert.rejects(
        h.repository.publishReleasePolicySelectionLifecycleEvent({
          ...h.fixture.withdrawal,
          eventId: "event_second_terminal",
        }),
        reason("terminal_conflict"),
      );
      assert.deepEqual((await read(h)).lifecycle, [h.fixture.withdrawal]);
    },
  ),
  test(
    "linearizes simultaneous identical and conflicting publications",
    "concurrent",
    async (h) => {
      const published = await Promise.all(
        Array.from({ length: 8 }, () =>
          h.repository.publishReleasePolicySelection(structuredClone(h.fixture.original)),
        ),
      );
      assert.equal(published.filter((row) => row.created).length, 1);
      const events = await Promise.allSettled([
        h.repository.publishReleasePolicySelectionLifecycleEvent(h.fixture.withdrawal),
        h.repository.publishReleasePolicySelectionLifecycleEvent({
          ...h.fixture.withdrawal,
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
      await h.repository.publishReleasePolicySelection(h.fixture.original);
      await h.repository.publishReleasePolicySelection(h.fixture.successor);
      await h.repository.publishReleasePolicySelectionLifecycleEvent(h.fixture.supersession);
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
