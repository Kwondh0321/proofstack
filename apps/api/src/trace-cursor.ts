import {
  type EvidenceEnvelope,
  EvidenceTimestampSchema,
  OpaqueIdSchema,
  type TracePageCursor,
} from "@proofstack/contracts";
import { type EvidencePageCursor, InvalidTraceCursorError } from "@proofstack/core";
import { z } from "zod";

const TraceCursorPayloadSchema = z
  .object({
    eventId: OpaqueIdSchema,
    sequence: z.number().int().nonnegative(),
    startedAt: EvidenceTimestampSchema,
  })
  .strict();

export function encodeTraceCursor(envelope: EvidenceEnvelope): TracePageCursor {
  return Buffer.from(
    JSON.stringify({
      eventId: envelope.evidence.eventId,
      sequence: envelope.evidence.sequence ?? 0,
      startedAt: envelope.evidence.startedAt,
    }),
  ).toString("base64url");
}

export function decodeTraceCursor(cursor: TracePageCursor): EvidencePageCursor {
  try {
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new InvalidTraceCursorError();
    return TraceCursorPayloadSchema.parse(JSON.parse(decoded.toString("utf8")));
  } catch {
    throw new InvalidTraceCursorError();
  }
}
