import type { EvidenceEnvelope } from "@proofstack/contracts";
import { InvalidTraceCursorError } from "@proofstack/core";
import { describe, expect, it } from "vitest";
import { decodeTraceCursor, encodeTraceCursor } from "./trace-cursor.js";

const envelope = {
  evidence: {
    attributes: {},
    contentReferences: [],
    eventId: "evt_cursor_test",
    extensions: {},
    kind: "custom",
    name: "cursor-test",
    sequence: 7,
    source: {
      sdkName: "@proofstack/sdk",
      sdkVersion: "0.0.0",
      serviceName: "test-agent",
    },
    spanId: "00f067aa0ba902b7",
    startedAt: "2026-08-28T05:00:00.000Z",
    status: "ok",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  },
  receivedAt: "2026-08-28T05:00:00.100Z",
  schemaVersion: "0.1",
  scope: {
    environmentId: "env_local",
    projectId: "prj_local",
    tenantId: "ten_local",
  },
} satisfies EvidenceEnvelope;

describe("trace cursor", () => {
  it("round trips an evidence ordering key", () => {
    expect(decodeTraceCursor(encodeTraceCursor(envelope))).toEqual({
      eventId: envelope.evidence.eventId,
      sequence: 7,
      startedAt: envelope.evidence.startedAt,
    });
  });

  it("rejects malformed and non-canonical cursors", () => {
    expect(() => decodeTraceCursor("not_base64url")).toThrow(InvalidTraceCursorError);
    expect(() =>
      decodeTraceCursor(Buffer.from(JSON.stringify({ eventId: "evt_only" })).toString("base64url")),
    ).toThrow(InvalidTraceCursorError);
  });
});
