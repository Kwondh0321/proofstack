import { z } from "zod";
import { RequestIdSchema } from "./api.js";
import {
  ComparisonDefinitionRecordSchema,
  ComparisonEvidenceSnapshotSchema,
} from "./evaluation-comparison.js";
import { ComparisonResultSchema } from "./evaluation-comparison-result.js";

export const ComparisonRecordKindSchema = z.enum([
  "comparison_definition",
  "comparison_evidence_snapshot",
  "comparison_result",
]);

export const ComparisonRecordEnvelopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("comparison_definition"),
      record: ComparisonDefinitionRecordSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("comparison_evidence_snapshot"),
      record: ComparisonEvidenceSnapshotSchema,
    })
    .strict(),
  z.object({ kind: z.literal("comparison_result"), record: ComparisonResultSchema }).strict(),
]);

export const PublishComparisonRecordResponseSchema = z
  .object({
    created: z.boolean(),
    requestId: RequestIdSchema,
    result: ComparisonRecordEnvelopeSchema,
  })
  .strict();

export const ReadComparisonRecordResponseSchema = z
  .object({
    requestId: RequestIdSchema,
    result: ComparisonRecordEnvelopeSchema,
  })
  .strict();

export type ComparisonRecordEnvelope = z.infer<typeof ComparisonRecordEnvelopeSchema>;
export type ComparisonRecordKind = z.infer<typeof ComparisonRecordKindSchema>;
export type PublishComparisonRecordResponse = z.infer<typeof PublishComparisonRecordResponseSchema>;
export type ReadComparisonRecordResponse = z.infer<typeof ReadComparisonRecordResponseSchema>;
