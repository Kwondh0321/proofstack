import { describe, expect, it } from "vitest";
import {
  EVIDENCE_SCHEMA_VERSION,
  EvidenceEnvelopeSchema,
  EvidenceRecordSchema,
  EvidenceTimestampSchema,
  evidenceTimestampOrderKey,
  IngestEvidenceRequestSchema,
  MAX_ATTRIBUTE_KEYS,
  MAX_EVIDENCE_BATCH_SIZE,
  MAX_EXTENSION_KEYS,
  MAX_EXTENSION_NAMESPACES,
} from "./evidence.js";
import { MAX_JSON_ARRAY_ITEMS, MAX_JSON_DEPTH } from "./primitives.js";

const validRecord = {
  eventId: "evt_01k3t5d7h9m2p4r6s8v0w2y4z6",
  kind: "tool.execute",
  name: "lookup_customer",
  source: {
    sdkName: "@proofstack/sdk",
    sdkVersion: "0.0.0",
    serviceName: "support-agent",
  },
  spanId: "00f067aa0ba902b7",
  startedAt: "2026-08-28T01:30:00.000Z",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
} as const;

describe("EvidenceRecordSchema", () => {
  it("applies safe defaults to a valid metadata-only record", () => {
    const parsed = EvidenceRecordSchema.parse(validRecord);

    expect(parsed).toMatchObject({
      attributes: {},
      contentReferences: [],
      extensions: {},
      status: "unset",
    });
  });

  it("rejects invalid trace identifiers", () => {
    const result = EvidenceRecordSchema.safeParse({
      ...validRecord,
      traceId: "00000000000000000000000000000000",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a span that is its own parent", () => {
    const result = EvidenceRecordSchema.safeParse({
      ...validRecord,
      parentSpanId: validRecord.spanId,
    });

    expect(result.success).toBe(false);
  });

  it("rejects an end timestamp before the start timestamp", () => {
    const result = EvidenceRecordSchema.safeParse({
      ...validRecord,
      endedAt: "2026-08-28T01:29:59.999Z",
    });

    expect(result.success).toBe(false);
  });

  it("compares start and end timestamps at PostgreSQL microsecond precision", () => {
    expect(
      EvidenceRecordSchema.safeParse({
        ...validRecord,
        endedAt: "2026-08-28T01:30:00.000001Z",
        startedAt: "2026-08-28T01:30:00.000002Z",
      }).success,
    ).toBe(false);
  });

  it("bounds high-cardinality attribute maps", () => {
    const attributes = Object.fromEntries(
      Array.from({ length: MAX_ATTRIBUTE_KEYS + 1 }, (_, index) => [`key_${index}`, index]),
    );

    const result = EvidenceRecordSchema.safeParse({ ...validRecord, attributes });

    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level fields", () => {
    const result = EvidenceRecordSchema.safeParse({ ...validRecord, tenantId: "ten_forged" });

    expect(result.success).toBe(false);
  });

  it("rejects deeply nested JSON before recursive validation", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth <= MAX_JSON_DEPTH; depth += 1) {
      nested = { child: nested };
    }

    expect(EvidenceRecordSchema.safeParse({ ...validRecord, attributes: { nested } }).success).toBe(
      false,
    );
  });

  it("rejects oversized JSON arrays", () => {
    const values = Array.from({ length: MAX_JSON_ARRAY_ITEMS + 1 }, (_, index) => index);

    expect(EvidenceRecordSchema.safeParse({ ...validRecord, attributes: { values } }).success).toBe(
      false,
    );
  });

  it("rejects circular JavaScript values without overflowing", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(
      EvidenceRecordSchema.safeParse({ ...validRecord, attributes: { circular } }).success,
    ).toBe(false);
  });

  it("bounds extension namespaces and values", () => {
    const namespaces = Object.fromEntries(
      Array.from({ length: MAX_EXTENSION_NAMESPACES + 1 }, (_, index) => [
        `vendor.ext_${index}`,
        {},
      ]),
    );
    const values = Object.fromEntries(
      Array.from({ length: MAX_EXTENSION_KEYS + 1 }, (_, index) => [`key_${index}`, index]),
    );

    expect(EvidenceRecordSchema.safeParse({ ...validRecord, extensions: namespaces }).success).toBe(
      false,
    );
    expect(
      EvidenceRecordSchema.safeParse({
        ...validRecord,
        extensions: { "vendor.extension": values },
      }).success,
    ).toBe(false);
  });
});

describe("EvidenceTimestampSchema", () => {
  it.each([
    "2026-08-28T01:30:00Z",
    "2026-08-28T01:30:00+15:59",
    "2026-08-28T01:30:00-15:59",
    "2026-08-28T01:30:00.123456789012345678901234567890Z",
  ])("accepts PostgreSQL-compatible instant %s", (value) => {
    expect(EvidenceTimestampSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    "0000-08-28T01:30:00Z",
    "2026-08-28T01:30:00",
    "2026-08-28T01:30:00+16:00",
    "2026-08-28T01:30:00-16:00",
    `2026-08-28T01:30:00.${"1".repeat(31)}Z`,
  ])("rejects an instant PostgreSQL cannot persist %s", (value) => {
    expect(EvidenceTimestampSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ["2026-08-28T01:30:00.0000015Z", "2026-08-28T01:30:00.000002Z"],
    ["2026-08-28T01:30:00.0000025Z", "2026-08-28T01:30:00.000002Z"],
    ["2026-08-28T01:30:00.000002500001Z", "2026-08-28T01:30:00.000003Z"],
    ["2026-08-28T01:30:00.0000014999999999999999999Z", "2026-08-28T01:30:00.000002Z"],
    ["2026-08-28T01:30:00.000125500Z", "2026-08-28T01:30:00.000125Z"],
    ["2026-08-28T01:30:59.9999995Z", "2026-08-28T01:31:00Z"],
    ["2026-08-28T10:30:00.000002+09:00", "2026-08-28T01:30:00.000002Z"],
  ])("matches PostgreSQL microsecond identity for %s and %s", (left, right) => {
    expect(evidenceTimestampOrderKey(left)).toBe(evidenceTimestampOrderKey(right));
  });

  it("orders distinct microseconds and rejects unsupported instants", () => {
    expect(evidenceTimestampOrderKey("2026-08-28T01:30:00.000001Z")).toBeLessThan(
      evidenceTimestampOrderKey("2026-08-28T01:30:00.000002Z"),
    );
    expect(() => evidenceTimestampOrderKey("0000-08-28T01:30:00Z")).toThrow(TypeError);
    expect(() => evidenceTimestampOrderKey("2026-08-28T01:30:00+16:00")).toThrow(TypeError);
  });
});

describe("IngestEvidenceRequestSchema", () => {
  it("accepts a versioned batch", () => {
    const result = IngestEvidenceRequestSchema.safeParse({
      events: [validRecord],
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
    });

    expect(result.success).toBe(true);
  });

  it("rejects an oversized batch", () => {
    const result = IngestEvidenceRequestSchema.safeParse({
      events: Array.from({ length: MAX_EVIDENCE_BATCH_SIZE + 1 }, () => validRecord),
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
    });

    expect(result.success).toBe(false);
  });

  it("rejects duplicate event identifiers inside a batch", () => {
    const result = IngestEvidenceRequestSchema.safeParse({
      events: [validRecord, validRecord],
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
    });

    expect(result.success).toBe(false);
  });
});

describe("EvidenceEnvelopeSchema", () => {
  it("requires server-owned scope and receipt time", () => {
    const result = EvidenceEnvelopeSchema.safeParse({
      evidence: validRecord,
      receivedAt: "2026-08-28T01:30:00.100Z",
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      scope: {
        environmentId: "env_local",
        projectId: "prj_local",
        tenantId: "ten_local",
      },
    });

    expect(result.success).toBe(true);
  });
});
