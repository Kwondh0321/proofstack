import { readFileSync } from "node:fs";
import {
  ReleasePolicySelectionDefinitionSchema,
  ReleasePolicySelectionSchema,
  type ReleasePolicySelection,
  type ReleasePolicySelectionDefinition,
  type ReleasePolicySelectionLifecycleEvent,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  digestReleasePolicySelectionDefinition,
  releasePolicySelectionReference,
} from "./release-authority-record-validation.js";
import {
  ReleaseDecisionVerificationBudget,
  ReleaseDecisionVerificationBudgetError,
} from "./release-decision-verification-budget.js";
import {
  resolveCapturedReleaseSelectionCensus,
  InvalidReleaseSelectionCensusError,
} from "./release-selection-census.js";

function fixture() {
  const vector = JSON.parse(
    readFileSync(
      new URL(
        "../../../contracts/vectors/release-policy-selection-definition-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).vectors[0];
  const definition = ReleasePolicySelectionDefinitionSchema.parse(vector.input.definition);
  const original = ReleasePolicySelectionSchema.parse({
    ...definition,
    schemaVersion: "0.1",
    definitionSha256: vector.sha256,
    publishedAt: definition.effectiveAt,
    publishedByPrincipalId: definition.issuerPrincipalId,
  });
  return {
    original,
    input: {
      scope: original.scope,
      reference: releasePolicySelectionReference(original),
      capturedAt: "2026-10-15T12:00:00.000001Z",
      census: {
        state: "complete" as const,
        records: [original],
        lifecycle: [] as ReleasePolicySelectionLifecycleEvent[],
      },
      budget: new ReleaseDecisionVerificationBudget({
        maxAcquisitionRecords: 100_000,
        maxAcquisitionRecordBytes: 64 * 1024 * 1024,
        maxApprovalRecords: 4_096,
      }),
    },
  };
}
function version(
  original: ReleasePolicySelection,
  patch: Partial<ReleasePolicySelectionDefinition>,
  publishedAt = "2026-10-15T11:00:00.000001Z",
) {
  const {
    schemaVersion: _schema,
    definitionSha256: _sha,
    publishedAt: _at,
    publishedByPrincipalId: _by,
    ...base
  } = original;
  const definition = ReleasePolicySelectionDefinitionSchema.parse({ ...base, ...patch });
  return ReleasePolicySelectionSchema.parse({
    ...definition,
    schemaVersion: "0.1",
    publishedAt,
    publishedByPrincipalId: definition.issuerPrincipalId,
    definitionSha256: digestReleasePolicySelectionDefinition(definition.scope, definition),
  });
}
function withdrawn(record: ReleasePolicySelection): ReleasePolicySelectionLifecycleEvent {
  return {
    schemaVersion: "0.1",
    eventId: "event_withdrawn",
    scope: record.scope,
    selection: releasePolicySelectionReference(record),
    kind: "withdrawn",
    actorPrincipalId: "user_current_installation_owner",
    occurredAt: "2026-10-15T11:00:00.000001Z",
    reason: "The original target selection is withdrawn by its current scoped operator.",
  };
}
function successor(original: ReleasePolicySelection) {
  return version(original, {
    selectionVersionId: "selection_checkout_v2",
    predecessor: releasePolicySelectionReference(original),
    effectiveAt: "2026-10-15T11:00:00.000001Z",
  });
}
function superseded(
  original: ReleasePolicySelection,
  next: ReleasePolicySelection,
): ReleasePolicySelectionLifecycleEvent {
  return {
    ...withdrawn(original),
    kind: "superseded",
    successor: releasePolicySelectionReference(next),
  };
}

describe("captured complete target selection, not current private publisher authority", () => {
  it("retains the exact original and installation publisher list without mutating sources", () => {
    const value = fixture();
    const before = structuredClone(value.input.census);
    const result = resolveCapturedReleaseSelectionCensus(value.input);
    expect(result.state).toBe("current");
    expect(result.original).toEqual(value.original);
    expect(result.original?.authorizedPublisherPrincipalIds).toEqual(
      value.original.authorizedPublisherPrincipalIds,
    );
    expect(value.input.census).toEqual(before);
    result.records[0]?.authorizedPublisherPrincipalIds.push("user_other");
    expect(value.original.authorizedPublisherPrincipalIds).not.toContain("user_other");
    expect(value.input.budget.snapshot().records).toBe(1);
  });
  it("keeps missing, unavailable and invalid enumerations non-current", () => {
    for (const state of ["complete", "unavailable", "invalid"] as const) {
      const value = fixture();
      expect(
        resolveCapturedReleaseSelectionCensus({
          ...value.input,
          census: { state, records: [], lifecycle: [] },
        }).state,
      ).toBe("unavailable");
      if (state !== "complete")
        expect(
          resolveCapturedReleaseSelectionCensus({
            ...value.input,
            census: { ...value.input.census, state },
          }).state,
        ).toBe("unavailable");
    }
  });
  it("retains complete competing versions instead of choosing the supplied or latest favorable one", () => {
    const value = fixture();
    const next = successor(value.original);
    value.input.census.records.push(next);
    const result = resolveCapturedReleaseSelectionCensus(value.input);
    expect(result.state).toBe("conflicting");
    expect(result.active).toHaveLength(2);
    expect(result.records).toHaveLength(2);
  });
  it("binds explicit supersession to its retained exact successor and preserves the old original", () => {
    const value = fixture();
    const next = successor(value.original);
    value.input.census.records.push(next);
    value.input.census.lifecycle.push(superseded(value.original, next));
    const result = resolveCapturedReleaseSelectionCensus(value.input);
    expect(result.state).toBe("superseded");
    expect(result.original).toEqual(value.original);
    expect(result.active).toEqual([next]);
    expect(
      resolveCapturedReleaseSelectionCensus({
        ...fixture().input,
        census: {
          ...value.input.census,
          records: [...value.input.census.records].reverse(),
        },
      }),
    ).toEqual(result);
  });
  it("retains withdrawal by a current replacement operator without turning it into approval", () => {
    const value = fixture();
    value.input.census.lifecycle.push(withdrawn(value.original));
    const result = resolveCapturedReleaseSelectionCensus(value.input);
    expect(result.state).toBe("withdrawn");
    expect(result.active).toEqual([]);
  });
  it("treats absent original predecessors, event targets and successors as incomplete closure", () => {
    const value = fixture();
    const next = successor(value.original);
    for (const census of [
      { state: "complete" as const, records: [next], lifecycle: [] },
      {
        state: "complete" as const,
        records: [value.original],
        lifecycle: [superseded(value.original, next)],
      },
      { state: "complete" as const, records: [value.original], lifecycle: [withdrawn(next)] },
    ])
      expect(resolveCapturedReleaseSelectionCensus({ ...fixture().input, census }).state).toBe(
        "unavailable",
      );
  });
  it("admits exact effective time and rejects exact expiry, preserving native sub-millisecond ordering", () => {
    const value = fixture();
    expect(
      resolveCapturedReleaseSelectionCensus({
        ...value.input,
        capturedAt: value.original.effectiveAt,
      }).state,
    ).toBe("current");
    expect(
      resolveCapturedReleaseSelectionCensus({
        ...fixture().input,
        capturedAt: value.original.expiresAt,
      }).state,
    ).toBe("expired");
    const future = version(
      value.original,
      { effectiveAt: "2026-10-15T12:00:00.000002Z" },
      value.original.publishedAt,
    );
    expect(
      resolveCapturedReleaseSelectionCensus({
        ...fixture().input,
        reference: releasePolicySelectionReference(future),
        census: { state: "complete", records: [future], lifecycle: [] },
      }).state,
    ).toBe("not_effective");
  });
  it("rejects duplicate source rows, events and terminal actions as conflicts", () => {
    const value = fixture();
    const event = withdrawn(value.original);
    for (const census of [
      { ...value.input.census, records: [value.original, value.original] },
      { ...value.input.census, lifecycle: [event, event] },
      { ...value.input.census, lifecycle: [event, { ...event, eventId: "event_other" }] },
    ])
      expect(resolveCapturedReleaseSelectionCensus({ ...fixture().input, census }).state).toBe(
        "conflicting",
      );
  });
  it.each([
    "scope",
    "target",
    "logical_id",
    "digest",
    "future_publication",
    "future_event",
    "wrong_event_ref",
    "wrong_successor",
  ])("rejects substituted %s instead of filtering it from a complete census", (kind) => {
    const value = fixture();
    if (kind === "scope") value.input.scope = { ...value.input.scope, tenantId: "tenant_other" };
    if (kind === "target")
      value.input.reference = { ...value.input.reference, gateTargetId: "gate_other" };
    if (kind === "logical_id")
      value.input.reference = { ...value.input.reference, selectionId: "selection_other" };
    if (kind === "digest")
      value.input.reference = { ...value.input.reference, definitionSha256: "0".repeat(64) };
    if (kind === "future_publication") value.original.publishedAt = "2026-10-15T12:00:00.000002Z";
    if (kind === "future_event")
      value.input.census.lifecycle.push({
        ...withdrawn(value.original),
        occurredAt: "2026-10-15T12:00:00.000002Z",
      });
    if (kind === "wrong_event_ref")
      value.input.census.lifecycle.push({
        ...withdrawn(value.original),
        selection: { ...value.input.reference, definitionSha256: "0".repeat(64) },
      });
    if (kind === "wrong_successor") {
      const next = successor(value.original);
      value.input.census.records.push(next);
      value.input.census.lifecycle.push({
        ...superseded(value.original, next),
        successor: { ...releasePolicySelectionReference(next), definitionSha256: "0".repeat(64) },
      } as ReleasePolicySelectionLifecycleEvent);
    }
    expect(() => resolveCapturedReleaseSelectionCensus(value.input)).toThrow(
      InvalidReleaseSelectionCensusError,
    );
  });
  it("shares cumulative admission across all invocations and propagates the tainted budget", () => {
    const value = fixture();
    value.input.budget = new ReleaseDecisionVerificationBudget({
      maxAcquisitionRecords: 2,
      maxAcquisitionRecordBytes: 1_000_000,
      maxApprovalRecords: 0,
    });
    resolveCapturedReleaseSelectionCensus(value.input);
    resolveCapturedReleaseSelectionCensus(value.input);
    expect(() => resolveCapturedReleaseSelectionCensus(value.input)).toThrow(
      ReleaseDecisionVerificationBudgetError,
    );
    expect(() => value.input.budget.snapshot()).toThrow(ReleaseDecisionVerificationBudgetError);
  });
  it("walks a complete reverse-ordered 256-version chain without recursive or repeated ancestor traversal", () => {
    const value = fixture();
    const chain = [value.original];
    const events: ReleasePolicySelectionLifecycleEvent[] = [];
    for (let index = 1; index < 256; index += 1) {
      const parent = chain[index - 1];
      if (!parent) throw new Error("Missing parent");
      const next = version(parent, {
        selectionVersionId: `selection_version_${index.toString().padStart(4, "0")}`,
        predecessor: releasePolicySelectionReference(parent),
      });
      chain.push(next);
      events.push({
        ...superseded(parent, next),
        eventId: `event_${index.toString().padStart(4, "0")}`,
      });
    }
    const last = chain.at(-1);
    if (!last) throw new Error("Missing final selection");
    const result = resolveCapturedReleaseSelectionCensus({
      ...value.input,
      reference: releasePolicySelectionReference(last),
      census: { state: "complete", records: chain.reverse(), lifecycle: events.reverse() },
    });
    expect(result.state).toBe("current");
    expect(result.active).toEqual([last]);
    expect(result.records).toHaveLength(256);
    expect(value.input.budget.snapshot().records).toBe(511);
  });
});
