import { z } from "zod";
import { EvidenceScopeSchema } from "./evidence.js";
import { PolicyEvaluationManifestEntrySchema } from "./policy-evaluation-manifest.js";
import {
  MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
  PolicyEvaluationRequestReferenceSchema,
} from "./policy-evaluation-request.js";
import { policyEvaluationSourceReferenceKey } from "./policy-evaluation-source-reference.js";
import {
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { PostgresTimestampSchema, Sha256Schema } from "./primitives.js";

export const POLICY_EVALUATION_SNAPSHOT_RECORDS_SCHEMA_VERSION = "0.1" as const;

const IndexSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS - 1);

/** Coordinates identify every original use; they do not authenticate the referenced graph. */
export const PolicyEvaluationRecordOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("request_root"), rootIndex: IndexSchema }).strict(),
  z.object({ kind: z.literal("semantic_node"), nodeIndex: IndexSchema }).strict(),
  z.object({ kind: z.literal("stored_node"), nodeIndex: IndexSchema }).strict(),
  z.object({ kind: z.literal("semantic_edge"), edgeIndex: IndexSchema }).strict(),
  z.object({ kind: z.literal("semantic_edge_parent"), edgeIndex: IndexSchema }).strict(),
  z
    .object({ kind: z.literal("stored_edge"), edgeIndex: IndexSchema, targetIndex: IndexSchema })
    .strict(),
  z.object({ kind: z.literal("stored_edge_parent"), edgeIndex: IndexSchema }).strict(),
  z.object({ kind: z.literal("logical_root"), bindingIndex: IndexSchema }).strict(),
  z.object({ kind: z.literal("logical_root_parent"), bindingIndex: IndexSchema }).strict(),
]);

/** Stable key excludes source identity, so one graph coordinate cannot name two sources. */
export function policyEvaluationRecordOriginKey(
  origin: z.infer<typeof PolicyEvaluationRecordOriginSchema>,
): string {
  switch (origin.kind) {
    case "request_root":
      return `${origin.kind}:${origin.rootIndex}`;
    case "semantic_node":
    case "stored_node":
      return `${origin.kind}:${origin.nodeIndex}`;
    case "logical_root":
    case "logical_root_parent":
      return `${origin.kind}:${origin.bindingIndex}`;
    case "stored_edge":
      return `${origin.kind}:${origin.edgeIndex}:${origin.targetIndex}`;
    default:
      return `${origin.kind}:${origin.edgeIndex}`;
  }
}

/** Full original body identity is distinct from semantic availability. No body is copied here. */
export const PolicyEvaluationRecordWitnessSchema = z
  .object({
    entry: PolicyEvaluationManifestEntrySchema,
    storage: z
      .object({ recordSha256: Sha256Schema, receiptTime: PostgresTimestampSchema })
      .strict()
      .nullable(),
    origins: z
      .array(PolicyEvaluationRecordOriginSchema)
      .min(1)
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const observation = value.entry.observation;
    if (observation.status === "verified") {
      if (value.storage === null || observation.recordSha256 !== value.storage.recordSha256)
        context.addIssue({
          code: "custom",
          message: "Verified semantic and original body hashes must agree",
          path: ["storage"],
        });
    } else if (observation.status === "missing" || observation.reason !== "not_yet_available") {
      if (value.storage !== null)
        context.addIssue({
          code: "custom",
          message: "Missing, invalid or mismatched records have no valid original body witness",
          path: ["storage"],
        });
    } else if (value.storage === null) {
      context.addIssue({
        code: "custom",
        message: "Temporal unavailability retains its valid original body witness",
        path: ["storage"],
      });
    }
    const keys = value.origins.map(policyEvaluationRecordOriginKey);
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: "custom",
        message: "Original use coordinates cannot be duplicated",
        path: ["origins"],
      });
  });

/**
 * Record-domain snapshot input component. Owning acquisition must independently establish full
 * bodies, exact closure and coordinates. This schema is not a sealed snapshot or public input.
 * Authority histories, artifacts, traces, selectors and guarded publication remain separate.
 */
const SnapshotRecordInputsObjectSchema = z
  .object({
    schemaVersion: z.literal(POLICY_EVALUATION_SNAPSHOT_RECORDS_SCHEMA_VERSION),
    request: PolicyEvaluationRequestReferenceSchema,
    scope: EvidenceScopeSchema,
    evaluationTime: PolicyEvaluationTimeSchema,
    records: z
      .array(PolicyEvaluationRecordWitnessSchema)
      .min(2)
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const cut = policyEvaluationTimestampOrderKey(value.evaluationTime);
    const origins = new Set<string>();
    let previous = "";
    let occurrences = 1 + value.records.length;
    value.records.forEach((record, index) => {
      const key = policyEvaluationSourceReferenceKey(record.entry.source);
      if (key <= previous)
        context.addIssue({
          code: "custom",
          message:
            "Record sources must be unique and ordered by repository identity, excluding digest",
          path: ["records", index, "entry", "source"],
        });
      previous = key;
      if (record.storage !== null) {
        const future = policyEvaluationTimestampOrderKey(record.storage.receiptTime) > cut;
        if (future !== (record.entry.observation.status === "unavailable"))
          context.addIssue({
            code: "custom",
            message: "Original receipt availability must match the unchanged semantic cut",
            path: ["records", index, "entry", "observation"],
          });
      }
      occurrences += record.origins.length;
      record.origins.forEach((origin, originIndex) => {
        const coordinate = policyEvaluationRecordOriginKey(origin);
        if (origins.has(coordinate))
          context.addIssue({
            code: "custom",
            message: "One original use coordinate cannot bind different sources",
            path: ["records", index, "origins", originIndex],
          });
        origins.add(coordinate);
      });
    });
    if (occurrences > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS)
      context.addIssue({
        code: "custom",
        message: "Record input and every original use share the fixed occurrence ceiling",
        path: ["records"],
      });
  });

/** Admit total occurrences before nested parsing or material inspection. */
export const PolicyEvaluationSnapshotRecordInputsSchema = z.preprocess((raw, context) => {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const records: unknown = Reflect.get(raw, "records");
    if (Array.isArray(records)) {
      let count = 1 + records.length;
      if (count <= MAX_POLICY_EVALUATION_ACQUISITION_RECORDS) {
        for (const record of records) {
          if (record !== null && typeof record === "object" && !Array.isArray(record)) {
            const origins: unknown = Reflect.get(record, "origins");
            if (Array.isArray(origins)) count += origins.length;
          }
          if (count > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS) break;
        }
      }
      if (count > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS) {
        context.addIssue({
          code: "custom",
          message: "Record input and every original use share the fixed occurrence ceiling",
          path: ["records"],
        });
        return z.NEVER;
      }
    }
  }
  return raw;
}, SnapshotRecordInputsObjectSchema);

export type PolicyEvaluationRecordOrigin = z.infer<typeof PolicyEvaluationRecordOriginSchema>;
export type PolicyEvaluationRecordWitness = z.infer<typeof PolicyEvaluationRecordWitnessSchema>;
export type PolicyEvaluationSnapshotRecordInputs = z.infer<
  typeof PolicyEvaluationSnapshotRecordInputsSchema
>;
