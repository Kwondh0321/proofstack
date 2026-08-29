import { describe, expect, it } from "vitest";
import {
  ArtifactMetadataSchema,
  ArtifactOwnershipSchema,
  ArtifactRedactionSummarySchema,
  ArtifactTombstoneSchema,
  JsonPointerSchema,
  MAX_ARTIFACT_CONTENT_BYTES,
  ReserveArtifactRequestSchema,
  TombstoneArtifactRequestSchema,
} from "./artifact.js";

const reservation = {
  artifactId: "art_model_output",
  classification: "confidential",
  mediaType: "application/json",
  redaction: { status: "not_required" },
  retention: { expiresAt: "2026-09-28T00:00:00.000Z", mode: "expire" },
  sha256: "a".repeat(64),
  sizeBytes: 128,
} as const;

const metadata = {
  contentReference: {
    artifactId: reservation.artifactId,
    classification: reservation.classification,
    mediaType: reservation.mediaType,
    sha256: reservation.sha256,
    sizeBytes: reservation.sizeBytes,
  },
  createdAt: "2026-08-28T00:00:00.000Z",
  redaction: reservation.redaction,
  retention: reservation.retention,
  schemaVersion: "0.1",
  scope: {
    environmentId: "env_production",
    projectId: "prj_agent",
    tenantId: "ten_acme",
  },
  state: "reserved",
} as const;

describe("ReserveArtifactRequestSchema", () => {
  it("accepts an explicit bounded reservation", () => {
    expect(ReserveArtifactRequestSchema.parse(reservation)).toEqual(reservation);
  });

  it("requires an explicit retention and redaction decision", () => {
    const { redaction: _redaction, retention: _retention, ...incomplete } = reservation;
    expect(ReserveArtifactRequestSchema.safeParse(incomplete).success).toBe(false);
  });

  it.each([
    { mediaType: "Application/JSON" },
    { mediaType: "application/json; charset=utf-8" },
    { sizeBytes: 0 },
    { sizeBytes: MAX_ARTIFACT_CONTENT_BYTES + 1 },
    { sha256: "A".repeat(64) },
  ])("rejects non-canonical or out-of-bounds content metadata %#", (override) => {
    expect(ReserveArtifactRequestSchema.safeParse({ ...reservation, ...override }).success).toBe(
      false,
    );
  });

  it("accepts bounded source redaction provenance", () => {
    const redaction = {
      records: [
        {
          changedPaths: ["/messages/0/content", "/secret~1token"],
          matchCount: 2,
          rulesetId: "redact_default",
          rulesetVersion: "1.2.0",
          stage: "source",
        },
      ],
      status: "applied",
    } as const;

    expect(ReserveArtifactRequestSchema.safeParse({ ...reservation, redaction }).success).toBe(
      true,
    );
  });

  it("rejects server-owned redaction stages in a public reservation", () => {
    const redaction = {
      records: [
        {
          changedPaths: [],
          matchCount: 1,
          rulesetId: "redact_ingest",
          rulesetVersion: "1",
          stage: "ingest",
        },
      ],
      status: "applied",
    } as const;

    expect(ReserveArtifactRequestSchema.safeParse({ ...reservation, redaction }).success).toBe(
      false,
    );
  });
});

describe("ArtifactRedactionSummarySchema", () => {
  const record = {
    changedPaths: ["/input"],
    matchCount: 1,
    rulesetId: "redact_default",
    rulesetVersion: "1",
    stage: "source",
  } as const;

  it("keeps applied records unique and in processing order", () => {
    expect(
      ArtifactRedactionSummarySchema.safeParse({
        records: [record, { ...record, rulesetId: "redact_ingest", stage: "ingest" }],
        status: "applied",
      }).success,
    ).toBe(true);
    expect(
      ArtifactRedactionSummarySchema.safeParse({
        records: [record, record],
        status: "applied",
      }).success,
    ).toBe(false);
    expect(
      ArtifactRedactionSummarySchema.safeParse({
        records: [{ ...record, stage: "retention" }, record],
        status: "applied",
      }).success,
    ).toBe(false);
  });

  it("rejects ambiguous or duplicate changed paths", () => {
    expect(
      ArtifactRedactionSummarySchema.safeParse({ records: [], status: "applied" }).success,
    ).toBe(false);
    expect(
      ArtifactRedactionSummarySchema.safeParse({
        records: [{ ...record, changedPaths: ["/input", "/input"] }],
        status: "applied",
      }).success,
    ).toBe(false);
    expect(
      ArtifactRedactionSummarySchema.safeParse({ records: [record], status: "not_required" })
        .success,
    ).toBe(false);
  });
});

describe("JsonPointerSchema", () => {
  it.each(["/", "/messages/0/content", "/escaped~0tilde~1slash"])(
    "accepts canonical JSON Pointer %s",
    (pointer) => {
      expect(JsonPointerSchema.safeParse(pointer).success).toBe(true);
    },
  );

  it.each(["", "messages/0", "/bad~escape", "/trailing~", "/line\nbreak"])(
    "rejects malformed JSON Pointer %s",
    (pointer) => {
      expect(JsonPointerSchema.safeParse(pointer).success).toBe(false);
    },
  );
});

describe("ArtifactMetadataSchema", () => {
  it("accepts every valid lifecycle state, including abandoned reservations", () => {
    const available = {
      ...metadata,
      availableAt: "2026-08-28T00:01:00.000Z",
      state: "available",
    };
    const tombstoned = {
      ...available,
      state: "tombstoned",
      tombstonedAt: "2026-08-28T00:02:00.000Z",
    };
    const purged = {
      ...tombstoned,
      purgedAt: "2026-08-28T00:03:00.000Z",
      state: "purged",
    };
    const abandoned = {
      ...metadata,
      state: "tombstoned",
      tombstonedAt: "2026-08-28T00:02:00.000Z",
    };

    for (const value of [metadata, available, tombstoned, purged, abandoned]) {
      expect(ArtifactMetadataSchema.safeParse(value).success).toBe(true);
    }
  });

  it.each([
    { ...metadata, availableAt: "2026-08-28T00:01:00.000Z" },
    {
      ...metadata,
      contentReference: { ...metadata.contentReference, mediaType: "Application/JSON" },
    },
    {
      ...metadata,
      contentReference: { ...metadata.contentReference, sizeBytes: 0 },
    },
    { ...metadata, state: "available" },
    { ...metadata, state: "tombstoned" },
    {
      ...metadata,
      purgedAt: "2026-08-28T00:03:00.000Z",
      state: "tombstoned",
      tombstonedAt: "2026-08-28T00:02:00.000Z",
    },
    { ...metadata, state: "purged", tombstonedAt: "2026-08-28T00:02:00.000Z" },
    {
      ...metadata,
      availableAt: "2026-08-28T00:02:00.000Z",
      state: "tombstoned",
      tombstonedAt: "2026-08-28T00:01:00.000Z",
    },
  ])("rejects inconsistent lifecycle metadata %#", (value) => {
    expect(ArtifactMetadataSchema.safeParse(value).success).toBe(false);
  });

  it("binds a content reference to the latest redaction stage", () => {
    const applied = {
      records: [
        {
          changedPaths: ["/secret"],
          matchCount: 1,
          rulesetId: "redact_source",
          rulesetVersion: "1",
          stage: "source",
        },
        {
          changedPaths: ["/token"],
          matchCount: 1,
          rulesetId: "redact_ingest",
          rulesetVersion: "2",
          stage: "ingest",
        },
      ],
      status: "applied",
    } as const;

    expect(
      ArtifactMetadataSchema.safeParse({
        ...metadata,
        contentReference: { ...metadata.contentReference, redactedAt: "ingest" },
        redaction: applied,
      }).success,
    ).toBe(true);
    expect(ArtifactMetadataSchema.safeParse({ ...metadata, redaction: applied }).success).toBe(
      false,
    );
  });
});

describe("ArtifactOwnershipSchema", () => {
  const ownership = {
    artifactId: "art_model_output",
    boundAt: "2026-08-29T03:12:00.000Z",
    boundByPrincipalId: "usr_dataset_manager",
    owner: {
      fixtureId: "fix_checkout_failure",
      fixtureVersionId: "fxv_checkout_failure_interactions",
      kind: "regression_fixture_version",
    },
    schemaVersion: "0.1",
    scope: metadata.scope,
  } as const;

  it("accepts append-only fixture ownership without infrastructure or content fields", () => {
    expect(ArtifactOwnershipSchema.parse(ownership)).toEqual(ownership);
    expect(JSON.stringify(ownership)).not.toContain("objectKey");
    expect(JSON.stringify(ownership)).not.toContain("wrappedDataKey");
  });

  it.each([
    { artifactId: "" },
    { boundAt: "2026-08-29T03:12:00Z" },
    { boundByPrincipalId: "" },
    { owner: { ...ownership.owner, fixtureId: "" } },
    { owner: { ...ownership.owner, fixtureVersionId: "" } },
    { owner: { ...ownership.owner, kind: "dataset_version" } },
    { schemaVersion: "0.2" },
    { scope: { ...ownership.scope, tenantId: "" } },
    { objectKey: "objects/v1/secret" },
  ])("rejects an invalid or caller-expanded ownership record %#", (override) => {
    expect(ArtifactOwnershipSchema.safeParse({ ...ownership, ...override }).success).toBe(false);
  });
});

describe("artifact tombstone contracts", () => {
  it("accepts a bounded audited tombstone", () => {
    expect(
      ArtifactTombstoneSchema.safeParse({
        actorPrincipalId: "usr_operator",
        artifactId: reservation.artifactId,
        occurredAt: "2026-08-28T00:02:00.000Z",
        reason: "retention period elapsed",
        tombstoneId: "del_artifact_001",
        trigger: "retention",
      }).success,
    ).toBe(true);
  });

  it.each(["", " surrounding whitespace ", "line\nbreak", "x".repeat(513)])(
    "rejects invalid tombstone reason %#",
    (reason) => {
      expect(TombstoneArtifactRequestSchema.safeParse({ reason }).success).toBe(false);
    },
  );
});
