import { describe, expect, it } from "vitest";
import {
  EVIDENCE_SCHEMA_VERSION,
  EvidenceEnvelopeSchema,
  EvidenceRecordSchema,
  IngestEvidenceRequestSchema,
  MAX_ATTRIBUTE_KEYS,
  MAX_EVIDENCE_BATCH_SIZE,
} from "./evidence.js";

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
