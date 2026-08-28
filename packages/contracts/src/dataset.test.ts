import { describe, expect, it } from "vitest";
import {
  MAX_DATASET_FIXTURE_VERSIONS,
  MAX_FIXTURE_SOURCE_EVENTS,
  MAX_REGRESSION_VERSION_DESCRIPTION_CHARACTERS,
  MAX_REGRESSION_VERSION_NAME_CHARACTERS,
  PublishRegressionDatasetVersionRequestSchema,
  PublishRegressionFixtureVersionRequestSchema,
  RegressionDatasetVersionDefinitionSchema,
  RegressionDatasetVersionSchema,
  RegressionFixtureVersionDefinitionSchema,
  RegressionFixtureVersionSchema,
  RegressionTraceSnapshotDefinitionSchema,
  RegressionVersionDescriptionSchema,
  RegressionVersionNameSchema,
} from "./dataset.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

function fixtureVersion() {
  return {
    createdAt: "2026-08-29T00:01:00.000Z",
    createdByPrincipalId: "usr_fixture_author",
    definitionSha256: DIGEST_A,
    description: "The observed failure before a candidate fix.",
    fixtureId: "fix_checkout_timeout",
    fixtureVersionId: "fixv_checkout_timeout_001",
    name: "Checkout timeout",
    replayability: "evidence_only",
    schemaVersion: "0.1",
    scope: {
      environmentId: "env_production",
      projectId: "prj_checkout_agent",
      tenantId: "ten_acme",
    },
    source: {
      capturedAt: "2026-08-29T00:00:30.000Z",
      eventIds: ["evt_agent_start", "evt_model_request", "evt_agent_failure"],
      kind: "trace_snapshot",
      observedEventCount: 3,
      sourceCompleteness: "observed_snapshot",
      traceId: TRACE_ID,
    },
  } as const;
}

function datasetVersion() {
  return {
    createdAt: "2026-08-29T00:02:00.000Z",
    createdByPrincipalId: "usr_dataset_author",
    datasetId: "dat_checkout_regressions",
    datasetVersionId: "datv_checkout_regressions_001",
    definitionSha256: DIGEST_B,
    description: "Pinned checkout incidents used by the first regression suite.",
    fixtureVersions: [
      {
        definitionSha256: DIGEST_A,
        fixtureId: "fix_checkout_timeout",
        fixtureVersionId: "fixv_checkout_timeout_001",
      },
      {
        definitionSha256: DIGEST_B,
        fixtureId: "fix_checkout_decline",
        fixtureVersionId: "fixv_checkout_decline_001",
      },
    ],
    name: "Checkout regressions",
    schemaVersion: "0.1",
    scope: {
      environmentId: "env_production",
      projectId: "prj_checkout_agent",
      tenantId: "ten_acme",
    },
  } as const;
}

function fixtureVersionDefinition() {
  const value = fixtureVersion();
  return {
    description: value.description,
    fixtureId: value.fixtureId,
    fixtureVersionId: value.fixtureVersionId,
    name: value.name,
    replayability: value.replayability,
    schemaVersion: value.schemaVersion,
    scope: value.scope,
    source: {
      eventIds: value.source.eventIds,
      kind: value.source.kind,
      observedEventCount: value.source.observedEventCount,
      sourceCompleteness: value.source.sourceCompleteness,
      traceId: value.source.traceId,
    },
  } as const;
}

function datasetVersionDefinition() {
  const value = datasetVersion();
  return {
    datasetId: value.datasetId,
    datasetVersionId: value.datasetVersionId,
    description: value.description,
    fixtureVersions: value.fixtureVersions,
    name: value.name,
    schemaVersion: value.schemaVersion,
    scope: value.scope,
  } as const;
}

describe("regression version text", () => {
  it("accepts bounded NFC text by Unicode scalar count", () => {
    expect(RegressionVersionNameSchema.safeParse("Agent reliability 🧪").success).toBe(true);
    expect(
      RegressionVersionNameSchema.safeParse("🧪".repeat(MAX_REGRESSION_VERSION_NAME_CHARACTERS))
        .success,
    ).toBe(true);
    expect(
      RegressionVersionDescriptionSchema.safeParse(
        "a".repeat(MAX_REGRESSION_VERSION_DESCRIPTION_CHARACTERS),
      ).success,
    ).toBe(true);
  });

  it.each([
    "",
    " leading",
    "trailing ",
    "line\nbreak",
    "e\u0301",
    "\ud800",
    "\udc00",
    "\u0085",
    "\u061c",
    "\u200e",
    "\u200f",
    "\u2028",
    "\u2029",
    "\u202e",
    "\u2066",
    "a".repeat(MAX_REGRESSION_VERSION_NAME_CHARACTERS + 1),
  ])("rejects non-canonical version names %j", (value) => {
    expect(RegressionVersionNameSchema.safeParse(value).success).toBe(false);
  });

  it("rejects over-limit descriptions independently of names", () => {
    expect(
      RegressionVersionDescriptionSchema.safeParse(
        "a".repeat(MAX_REGRESSION_VERSION_DESCRIPTION_CHARACTERS + 1),
      ).success,
    ).toBe(false);
  });
});

describe("PublishRegressionFixtureVersionRequestSchema", () => {
  const request = {
    description: "Capture the failure before changing the target.",
    fixtureVersionId: "fixv_checkout_timeout_001",
    name: "Checkout timeout",
    predecessorVersionId: "fixv_checkout_timeout_000",
    source: { kind: "trace_snapshot", traceId: TRACE_ID },
  } as const;

  it("accepts only caller-owned fixture definition fields", () => {
    expect(PublishRegressionFixtureVersionRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    { createdAt: "2026-08-29T00:00:00.000Z" },
    { definitionSha256: DIGEST_A },
    { fixtureId: "fix_route_owned" },
    { replayability: "executable" },
    { schemaVersion: "0.1" },
    { scope: fixtureVersion().scope },
    { source: { eventIds: ["evt_forged"], kind: "trace_snapshot", traceId: TRACE_ID } },
  ])("rejects a server-owned or unknown fixture request field %#", (override) => {
    expect(
      PublishRegressionFixtureVersionRequestSchema.safeParse({ ...request, ...override }).success,
    ).toBe(false);
  });

  it("rejects a self-referential predecessor", () => {
    expect(
      PublishRegressionFixtureVersionRequestSchema.safeParse({
        ...request,
        predecessorVersionId: request.fixtureVersionId,
      }).success,
    ).toBe(false);
  });
});

describe("RegressionTraceSnapshotDefinitionSchema", () => {
  it("accepts and preserves the exact ordered semantic trace snapshot", () => {
    const value = fixtureVersionDefinition().source;
    expect(RegressionTraceSnapshotDefinitionSchema.parse(value)).toEqual(value);
    expect(RegressionTraceSnapshotDefinitionSchema.parse(value).eventIds).toEqual([
      "evt_agent_start",
      "evt_model_request",
      "evt_agent_failure",
    ]);
  });

  it("strictly excludes the server capture timestamp", () => {
    const value = fixtureVersionDefinition().source;
    expect(
      RegressionTraceSnapshotDefinitionSchema.safeParse({
        ...value,
        capturedAt: fixtureVersion().source.capturedAt,
      }).success,
    ).toBe(false);
  });

  it("retains event uniqueness and observed-count invariants", () => {
    const value = fixtureVersionDefinition().source;
    expect(
      RegressionTraceSnapshotDefinitionSchema.safeParse({
        ...value,
        observedEventCount: value.observedEventCount - 1,
      }).success,
    ).toBe(false);
    expect(
      RegressionTraceSnapshotDefinitionSchema.safeParse({
        ...value,
        eventIds: [value.eventIds[0], value.eventIds[0]],
        observedEventCount: 2,
      }).success,
    ).toBe(false);
  });
});

describe("RegressionFixtureVersionDefinitionSchema", () => {
  it("accepts only the complete semantic fixture definition", () => {
    const value = fixtureVersionDefinition();
    expect(RegressionFixtureVersionDefinitionSchema.parse(value)).toEqual(value);
  });

  it("rejects a stored fixture version instead of silently projecting its definition", () => {
    expect(RegressionFixtureVersionDefinitionSchema.safeParse(fixtureVersion()).success).toBe(
      false,
    );
  });

  it.each([
    { createdAt: fixtureVersion().createdAt },
    { createdByPrincipalId: fixtureVersion().createdByPrincipalId },
    { definitionSha256: fixtureVersion().definitionSha256 },
  ])("strictly excludes stored fixture provenance %#", (provenance) => {
    expect(
      RegressionFixtureVersionDefinitionSchema.safeParse({
        ...fixtureVersionDefinition(),
        ...provenance,
      }).success,
    ).toBe(false);
  });

  it("rejects a stored snapshot timestamp nested in the semantic source", () => {
    expect(
      RegressionFixtureVersionDefinitionSchema.safeParse({
        ...fixtureVersionDefinition(),
        source: fixtureVersion().source,
      }).success,
    ).toBe(false);
  });

  it("retains the resolved predecessor invariant", () => {
    const value = fixtureVersionDefinition();
    expect(
      RegressionFixtureVersionDefinitionSchema.safeParse({
        ...value,
        predecessor: {
          definitionSha256: DIGEST_B,
          fixtureVersionId: value.fixtureVersionId,
        },
      }).success,
    ).toBe(false);
  });
});

describe("RegressionFixtureVersionSchema", () => {
  it("accepts an explicit evidence-only observed trace snapshot", () => {
    expect(RegressionFixtureVersionSchema.parse(fixtureVersion())).toEqual(fixtureVersion());
  });

  it.each([
    "2026-08-29T00:00:00.123456789012345678901234567890Z",
    "2026-08-29T00:00:00+15:59",
    "2026-08-29T00:00:00-15:59",
  ])("accepts the PostgreSQL-compatible source capture timestamp %s", (timestamp) => {
    const value = fixtureVersion();
    expect(
      RegressionFixtureVersionSchema.safeParse({
        ...value,
        createdAt: "2026-08-30T16:00:00.000Z",
        source: { ...value.source, capturedAt: timestamp },
      }).success,
    ).toBe(true);
  });

  it.each([
    "2026-08-29T00:00:00.123456789012345678901234567890Z",
    "2026-08-29T00:00:00+15:59",
    "2026-08-29T00:00:00-15:59",
  ])("rejects a noncanonical publication timestamp %s", (timestamp) => {
    expect(
      RegressionFixtureVersionSchema.safeParse({ ...fixtureVersion(), createdAt: timestamp })
        .success,
    ).toBe(false);
  });

  it.each([
    "0000-08-29T00:00:00Z",
    "2026-08-29T00:00:00",
    "2026-08-29T00:00:00+16:00",
    "2026-08-29T00:00:00-16:00",
    "2026-08-29T00:00:00+23:59",
    `2026-08-29T00:00:00.${"1".repeat(31)}Z`,
  ])("rejects a non-persistable fixture timestamp %s", (timestamp) => {
    const value = fixtureVersion();
    expect(
      RegressionFixtureVersionSchema.safeParse({ ...value, createdAt: timestamp }).success,
    ).toBe(false);
    expect(
      RegressionFixtureVersionSchema.safeParse({
        ...value,
        source: { ...value.source, capturedAt: timestamp },
      }).success,
    ).toBe(false);
  });

  it("orders capture provenance at PostgreSQL microsecond precision", () => {
    const value = fixtureVersion();
    expect(
      RegressionFixtureVersionSchema.safeParse({
        ...value,
        createdAt: "2026-08-29T00:00:00.000Z",
        source: { ...value.source, capturedAt: "2026-08-29T00:00:00.0009Z" },
      }).success,
    ).toBe(false);
    expect(
      RegressionFixtureVersionSchema.safeParse({
        ...value,
        createdAt: "2026-08-29T00:00:00.000Z",
        source: { ...value.source, capturedAt: "2026-08-29T00:00:00.0000004Z" },
      }).success,
    ).toBe(true);
  });

  it.each([
    { replayability: "deterministic" },
    { schemaVersion: "1.0" },
    { definitionSha256: "A".repeat(64) },
    { source: { ...fixtureVersion().source, sourceCompleteness: "complete" } },
    { source: { ...fixtureVersion().source, observedEventCount: 2 } },
    {
      source: {
        ...fixtureVersion().source,
        eventIds: ["evt_agent_start", "evt_agent_start"],
        observedEventCount: 2,
      },
    },
    { createdAt: "2026-08-29T00:00:00.000Z" },
    { unexpected: true },
  ])("rejects an inconsistent fixture version %#", (override) => {
    expect(
      RegressionFixtureVersionSchema.safeParse({ ...fixtureVersion(), ...override }).success,
    ).toBe(false);
  });

  it("rejects empty and over-limit trace snapshots", () => {
    const value = fixtureVersion();
    expect(
      RegressionFixtureVersionSchema.safeParse({
        ...value,
        source: { ...value.source, eventIds: [], observedEventCount: 0 },
      }).success,
    ).toBe(false);
    const eventIds = Array.from(
      { length: MAX_FIXTURE_SOURCE_EVENTS + 1 },
      (_, index) => `evt_${index.toString().padStart(4, "0")}`,
    );
    expect(
      RegressionFixtureVersionSchema.safeParse({
        ...value,
        source: { ...value.source, eventIds, observedEventCount: eventIds.length },
      }).success,
    ).toBe(false);
  });

  it("accepts the exact trace snapshot event limit", () => {
    const value = fixtureVersion();
    const eventIds = Array.from(
      { length: MAX_FIXTURE_SOURCE_EVENTS },
      (_, index) => `evt_${index.toString().padStart(4, "0")}`,
    );
    expect(
      RegressionFixtureVersionSchema.safeParse({
        ...value,
        source: { ...value.source, eventIds, observedEventCount: eventIds.length },
      }).success,
    ).toBe(true);
  });

  it("preserves publisher-established trace order without inferring it from opaque ids", () => {
    const value = fixtureVersion();
    const eventIds = [...value.source.eventIds].reverse();
    const parsed = RegressionFixtureVersionSchema.parse({
      ...value,
      source: { ...value.source, eventIds },
    });
    expect(parsed.source.eventIds).toEqual(eventIds);
  });

  it("rejects a self-referential resolved predecessor", () => {
    const value = fixtureVersion();
    expect(
      RegressionFixtureVersionSchema.safeParse({
        ...value,
        predecessor: {
          definitionSha256: DIGEST_B,
          fixtureVersionId: value.fixtureVersionId,
        },
      }).success,
    ).toBe(false);
  });
});

describe("PublishRegressionDatasetVersionRequestSchema", () => {
  const request = {
    datasetVersionId: "datv_checkout_regressions_001",
    description: "Pinned regression inputs.",
    fixtureVersions: datasetVersion().fixtureVersions.map(({ fixtureId, fixtureVersionId }) => ({
      fixtureId,
      fixtureVersionId,
    })),
    name: "Checkout regressions",
    predecessorVersionId: "datv_checkout_regressions_000",
  } as const;

  it("accepts ordered exact fixture identities without caller-supplied digests", () => {
    expect(PublishRegressionDatasetVersionRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    { createdAt: "2026-08-29T00:00:00.000Z" },
    { datasetId: "dat_route_owned" },
    { definitionSha256: DIGEST_A },
    { schemaVersion: "0.1" },
    { scope: datasetVersion().scope },
    {
      fixtureVersions: [
        ...request.fixtureVersions,
        {
          definitionSha256: DIGEST_A,
          fixtureId: "fix_extra",
          fixtureVersionId: "fixv_extra_001",
        },
      ],
    },
  ])("rejects a server-owned or unknown dataset request field %#", (override) => {
    expect(
      PublishRegressionDatasetVersionRequestSchema.safeParse({ ...request, ...override }).success,
    ).toBe(false);
  });

  it("rejects empty, duplicate logical, self-predecessor, and over-limit definitions", () => {
    expect(
      PublishRegressionDatasetVersionRequestSchema.safeParse({ ...request, fixtureVersions: [] })
        .success,
    ).toBe(false);
    expect(
      PublishRegressionDatasetVersionRequestSchema.safeParse({
        ...request,
        fixtureVersions: [request.fixtureVersions[0], request.fixtureVersions[0]],
      }).success,
    ).toBe(false);
    expect(
      PublishRegressionDatasetVersionRequestSchema.safeParse({
        ...request,
        predecessorVersionId: request.datasetVersionId,
      }).success,
    ).toBe(false);
    expect(
      PublishRegressionDatasetVersionRequestSchema.safeParse({
        ...request,
        fixtureVersions: Array.from({ length: MAX_DATASET_FIXTURE_VERSIONS + 1 }, (_, index) => ({
          fixtureId: `fix_${index.toString().padStart(4, "0")}`,
          fixtureVersionId: `fixv_${index.toString().padStart(4, "0")}`,
        })),
      }).success,
    ).toBe(false);
  });

  it("rejects one fixture version reused under different logical fixture ids", () => {
    const fixtureVersion = request.fixtureVersions[0];
    if (fixtureVersion === undefined) throw new Error("expected a fixture version test value");
    expect(
      PublishRegressionDatasetVersionRequestSchema.safeParse({
        ...request,
        fixtureVersions: [
          fixtureVersion,
          {
            fixtureId: "fix_different_logical_id",
            fixtureVersionId: fixtureVersion.fixtureVersionId,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts the exact dataset fixture limit", () => {
    const fixtureVersions = Array.from({ length: MAX_DATASET_FIXTURE_VERSIONS }, (_, index) => ({
      fixtureId: `fix_${index.toString().padStart(4, "0")}`,
      fixtureVersionId: `fixv_${index.toString().padStart(4, "0")}`,
    }));
    expect(
      PublishRegressionDatasetVersionRequestSchema.safeParse({
        ...request,
        fixtureVersions,
      }).success,
    ).toBe(true);
  });
});

describe("RegressionDatasetVersionDefinitionSchema", () => {
  it("accepts and preserves exact resolved fixture membership order", () => {
    const value = datasetVersionDefinition();
    const parsed = RegressionDatasetVersionDefinitionSchema.parse(value);
    expect(parsed).toEqual(value);
    expect(parsed.fixtureVersions.map(({ fixtureId }) => fixtureId)).toEqual([
      "fix_checkout_timeout",
      "fix_checkout_decline",
    ]);
  });

  it("rejects a stored dataset version instead of silently projecting its definition", () => {
    expect(RegressionDatasetVersionDefinitionSchema.safeParse(datasetVersion()).success).toBe(
      false,
    );
  });

  it.each([
    { createdAt: datasetVersion().createdAt },
    { createdByPrincipalId: datasetVersion().createdByPrincipalId },
    { definitionSha256: datasetVersion().definitionSha256 },
  ])("strictly excludes stored dataset provenance %#", (provenance) => {
    expect(
      RegressionDatasetVersionDefinitionSchema.safeParse({
        ...datasetVersionDefinition(),
        ...provenance,
      }).success,
    ).toBe(false);
  });

  it("retains membership uniqueness and resolved predecessor invariants", () => {
    const value = datasetVersionDefinition();
    expect(
      RegressionDatasetVersionDefinitionSchema.safeParse({
        ...value,
        fixtureVersions: [value.fixtureVersions[0], value.fixtureVersions[0]],
      }).success,
    ).toBe(false);
    expect(
      RegressionDatasetVersionDefinitionSchema.safeParse({
        ...value,
        predecessor: {
          datasetVersionId: value.datasetVersionId,
          definitionSha256: DIGEST_A,
        },
      }).success,
    ).toBe(false);
  });
});

describe("RegressionDatasetVersionSchema", () => {
  it("accepts and preserves semantic fixture membership order", () => {
    const value = datasetVersion();
    expect(RegressionDatasetVersionSchema.parse(value)).toEqual(value);
    expect(
      RegressionDatasetVersionSchema.parse(value).fixtureVersions.map(({ fixtureId }) => fixtureId),
    ).toEqual(["fix_checkout_timeout", "fix_checkout_decline"]);
  });

  it.each([
    "2026-08-29T00:00:00.123456789012345678901234567890Z",
    "2026-08-29T00:00:00+15:59",
    "2026-08-29T00:00:00-15:59",
  ])("rejects the noncanonical dataset publication timestamp %s", (timestamp) => {
    expect(
      RegressionDatasetVersionSchema.safeParse({ ...datasetVersion(), createdAt: timestamp })
        .success,
    ).toBe(false);
  });

  it.each([
    "0000-08-29T00:00:00Z",
    "2026-08-29T00:00:00",
    "2026-08-29T00:00:00+16:00",
    "2026-08-29T00:00:00-16:00",
    "2026-08-29T00:00:00+23:59",
    `2026-08-29T00:00:00.${"1".repeat(31)}Z`,
  ])("rejects the non-persistable dataset timestamp %s", (timestamp) => {
    expect(
      RegressionDatasetVersionSchema.safeParse({ ...datasetVersion(), createdAt: timestamp })
        .success,
    ).toBe(false);
  });

  it.each([
    { fixtureVersions: [] },
    {
      fixtureVersions: [datasetVersion().fixtureVersions[0], datasetVersion().fixtureVersions[0]],
    },
    {
      fixtureVersions: [
        datasetVersion().fixtureVersions[0],
        {
          ...datasetVersion().fixtureVersions[1],
          fixtureVersionId: datasetVersion().fixtureVersions[0].fixtureVersionId,
        },
      ],
    },
    {
      predecessor: {
        datasetVersionId: datasetVersion().datasetVersionId,
        definitionSha256: DIGEST_A,
      },
    },
    { definitionSha256: "invalid" },
    { unexpected: true },
  ])("rejects an inconsistent dataset version %#", (override) => {
    expect(
      RegressionDatasetVersionSchema.safeParse({ ...datasetVersion(), ...override }).success,
    ).toBe(false);
  });

  it("accepts the exact resolved fixture limit and rejects one additional reference", () => {
    const value = datasetVersion();
    const fixtureVersions = Array.from({ length: MAX_DATASET_FIXTURE_VERSIONS }, (_, index) => ({
      definitionSha256: index % 2 === 0 ? DIGEST_A : DIGEST_B,
      fixtureId: `fix_${index.toString().padStart(4, "0")}`,
      fixtureVersionId: `fixv_${index.toString().padStart(4, "0")}`,
    }));
    expect(RegressionDatasetVersionSchema.safeParse({ ...value, fixtureVersions }).success).toBe(
      true,
    );
    expect(
      RegressionDatasetVersionSchema.safeParse({
        ...value,
        fixtureVersions: [
          ...fixtureVersions,
          {
            definitionSha256: DIGEST_A,
            fixtureId: "fix_over_limit",
            fixtureVersionId: "fixv_over_limit",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
