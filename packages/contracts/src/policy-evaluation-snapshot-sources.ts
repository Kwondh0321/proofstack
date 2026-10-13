import { z } from "zod";
import { serializeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { MAX_POLICY_EVALUATION_ACQUISITION_RECORDS } from "./policy-evaluation-request.js";
import { PolicyEvaluationReferenceSchema } from "./policy-evaluation-reference.js";
import { PolicyEvaluationSnapshotRecordInputsSchema } from "./policy-evaluation-snapshot-records.js";
import {
  policyEvaluationRecordOriginKey,
  type PolicyEvaluationRecordOrigin,
} from "./policy-evaluation-snapshot-records.js";
import {
  PolicyEvaluationSourceReferenceSchema,
  policyEvaluationSourceReferenceKey,
} from "./policy-evaluation-source-reference.js";
import { Sha256Schema } from "./primitives.js";

const IndexSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS - 1);
const ParentShape = {
  parent: PolicyEvaluationSourceReferenceSchema,
  parentRecordSha256: Sha256Schema,
};

export const PolicyEvaluationSemanticFrontierSchema = z
  .object({
    ...ParentShape,
    edgeIndex: IndexSchema,
    kind: z.enum(["artifact", "trace", "retained_declaration", "unresolved_selector"]),
    reference: PolicyEvaluationReferenceSchema,
    target: PolicyEvaluationSourceReferenceSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const kind = value.reference.kind;
    const selector =
      ["criterion_selector", "model_evaluator_selector", "evaluation_run_identity"].includes(
        kind,
      ) ||
      (value.reference.kind === "control_declaration" &&
        value.reference.declaration.kind === "comparison_predecessor");
    const expected =
      kind === "artifact"
        ? "artifact"
        : kind === "trace_snapshot_selector"
          ? "trace"
          : selector
            ? "unresolved_selector"
            : "retained_declaration";
    if (kind === "record" || value.kind !== expected)
      context.addIssue({
        code: "custom",
        message: "Frontier must preserve its owning reference category",
      });
    if (
      (kind === "artifact" || kind === "trace_snapshot_selector" || selector) &&
      value.target !== null
    )
      context.addIssue({
        code: "custom",
        message: "Artifact/trace occurrences cannot invent record targets",
      });
  });

export const PolicyEvaluationStoredMappingSchema = z
  .object({
    ...ParentShape,
    edgeIndex: IndexSchema,
    reference: PolicyEvaluationReferenceSchema,
    targets: z
      .array(PolicyEvaluationSourceReferenceSchema)
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    cardinality: z.enum(["zero", "unique", "multiple"]),
    resolutionSha256: Sha256Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const cardinality =
      value.targets.length === 0 ? "zero" : value.targets.length === 1 ? "unique" : "multiple";
    if (value.reference.kind === "record" || value.cardinality !== cardinality)
      context.addIssue({
        code: "custom",
        message: "Original non-record mapping must retain its complete target cardinality",
      });
  });

export const PolicyEvaluationLogicalRootMappingSchema = z
  .object({
    ...ParentShape,
    bindingIndex: IndexSchema,
    state: z.discriminatedUnion("status", [
      z
        .object({ status: z.literal("unresolved"), reason: z.literal("root_port_unconfigured") })
        .strict(),
      z
        .object({ status: z.literal("retained"), root: PolicyEvaluationSourceReferenceSchema })
        .strict(),
    ]),
  })
  .strict();

/** Complete record-domain metadata, not source-body authentication or a publication capability. */
const SourceInputsObjectSchema = z
  .object({
    records: PolicyEvaluationSnapshotRecordInputsSchema,
    semanticFrontier: z
      .array(PolicyEvaluationSemanticFrontierSchema)
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    storedMappings: z
      .array(PolicyEvaluationStoredMappingSchema)
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    logicalRoots: z
      .object({
        configuration: z.enum(["configured", "unconfigured"]),
        mappings: z
          .array(PolicyEvaluationLogicalRootMappingSchema)
          .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const sources = new Map(
      value.records.records.map((record) => [
        policyEvaluationSourceReferenceKey(record.entry.source),
        { record, origins: new Set(record.origins.map(policyEvaluationRecordOriginKey)) },
      ]),
    );
    const same = (left: unknown, right: unknown) =>
      serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    const witness = (source: z.infer<typeof PolicyEvaluationSourceReferenceSchema>) => {
      const record = sources.get(policyEvaluationSourceReferenceKey(source));
      if (!record || !same(record.record.entry.source, source)) {
        issue("Every retained relationship source must be in the exact record inventory");
        return undefined;
      }
      return record;
    };
    const origin = (
      source: z.infer<typeof PolicyEvaluationSourceReferenceSchema>,
      coordinate: PolicyEvaluationRecordOrigin,
      hash?: string,
      semantic = false,
    ) => {
      const record = witness(source);
      if (!record) return;
      if (!record.origins.has(policyEvaluationRecordOriginKey(coordinate)))
        issue("Relationship occurrence must retain its original record-use coordinate");
      if (
        hash !== undefined &&
        (record.record.storage === null ||
          record.record.storage.recordSha256 !== hash ||
          (semantic && record.record.entry.observation.status !== "verified"))
      )
        issue(
          "Relationship parent must retain its unchanged original body witness and availability",
        );
    };
    let previous = -1;
    for (const frontier of value.semanticFrontier) {
      if (frontier.edgeIndex <= previous)
        issue("Semantic frontier must retain unique original edge order");
      previous = frontier.edgeIndex;
      origin(
        frontier.parent,
        { kind: "semantic_edge_parent", edgeIndex: frontier.edgeIndex },
        frontier.parentRecordSha256,
        true,
      );
      if (frontier.target !== null)
        origin(frontier.target, { kind: "semantic_edge", edgeIndex: frontier.edgeIndex });
    }
    previous = -1;
    for (const mapping of value.storedMappings) {
      if (mapping.edgeIndex <= previous)
        issue("Stored mappings must retain unique original edge order");
      previous = mapping.edgeIndex;
      origin(
        mapping.parent,
        { kind: "stored_edge_parent", edgeIndex: mapping.edgeIndex },
        mapping.parentRecordSha256,
      );
      mapping.targets.forEach((source, targetIndex) => {
        origin(source, { kind: "stored_edge", edgeIndex: mapping.edgeIndex, targetIndex });
      });
    }
    for (const [index, mapping] of value.logicalRoots.mappings.entries()) {
      if (mapping.bindingIndex !== index)
        issue("Logical-root mappings must retain complete contiguous original binding order");
      origin(
        mapping.parent,
        { kind: "logical_root_parent", bindingIndex: index },
        mapping.parentRecordSha256,
      );
      if (mapping.state.status === "retained") {
        if (value.logicalRoots.configuration !== "configured")
          issue("Unconfigured logical-root ports cannot provide a retained root");
        origin(mapping.state.root, { kind: "logical_root", bindingIndex: index });
      } else if (value.logicalRoots.configuration !== "unconfigured")
        issue("Configured logical-root ports cannot claim to be unconfigured");
    }
    const mappings = new Map(value.storedMappings.map((mapping) => [mapping.edgeIndex, mapping]));
    for (const record of value.records.records)
      for (const coordinate of record.origins) {
        if (coordinate.kind === "stored_edge") {
          const mapping = mappings.get(coordinate.edgeIndex);
          if (mapping && coordinate.targetIndex >= mapping.targets.length)
            issue("Retained stored-mapping coordinates cannot outlive their original target list");
        } else if (
          coordinate.kind === "logical_root" ||
          coordinate.kind === "logical_root_parent"
        ) {
          const binding = value.logicalRoots.mappings[coordinate.bindingIndex];
          if (
            !binding ||
            (coordinate.kind === "logical_root" && binding.state.status !== "retained")
          )
            issue("Every logical-root use must retain its corresponding original binding");
        }
      }
  });

/** Bound total output occurrences before walking any nested relationship/source material. */
export const PolicyEvaluationSnapshotSourceInputsSchema = z.preprocess((raw, context) => {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    let count = 1;
    let targets = 0;
    const recordInput: unknown = Reflect.get(raw, "records");
    if (recordInput !== null && typeof recordInput === "object" && !Array.isArray(recordInput)) {
      const rows: unknown = Reflect.get(recordInput, "records");
      if (Array.isArray(rows)) {
        count += rows.length;
        if (count <= MAX_POLICY_EVALUATION_ACQUISITION_RECORDS)
          for (const row of rows) {
            if (row !== null && typeof row === "object" && !Array.isArray(row)) {
              const origins: unknown = Reflect.get(row, "origins");
              if (Array.isArray(origins)) count += origins.length;
            }
            if (count > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS) break;
          }
      }
    }
    for (const key of ["semanticFrontier", "storedMappings"] as const) {
      const items: unknown = Reflect.get(raw, key);
      if (!Array.isArray(items)) continue;
      count += items.length;
      if (key === "storedMappings" && count <= MAX_POLICY_EVALUATION_ACQUISITION_RECORDS)
        for (const item of items) {
          if (item !== null && typeof item === "object" && !Array.isArray(item)) {
            const members: unknown = Reflect.get(item, "targets");
            if (Array.isArray(members)) targets += members.length;
          }
          if (targets > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS) break;
        }
    }
    const logical: unknown = Reflect.get(raw, "logicalRoots");
    if (logical !== null && typeof logical === "object" && !Array.isArray(logical)) {
      const mappings: unknown = Reflect.get(logical, "mappings");
      if (Array.isArray(mappings)) count += mappings.length;
    }
    if (
      count > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS ||
      targets > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS
    ) {
      context.addIssue({
        code: "custom",
        message: "Relationship occurrences exceed the fixed source-input ceiling",
      });
      return z.NEVER;
    }
  }
  return raw;
}, SourceInputsObjectSchema);

export type PolicyEvaluationSnapshotSourceInputs = z.infer<
  typeof PolicyEvaluationSnapshotSourceInputsSchema
>;
