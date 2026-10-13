import { z } from "zod";
import { CriterionSetStatusRecordSchema } from "./evaluation-criteria.js";
import { EvidenceScopeSchema } from "./evidence.js";
import { PolicyEvaluationSourceObservationSchema } from "./policy-evaluation-manifest.js";
import { MAX_POLICY_EVALUATION_ACQUISITION_RECORDS } from "./policy-evaluation-request.js";
import { PolicyEvaluationSourceReferenceSchema } from "./policy-evaluation-source-reference.js";
import {
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { PostgresTimestampSchema, Sha256Schema } from "./primitives.js";
import { serializeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";

const Index = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS - 1);
const Indices = z
  .array(Index)
  .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS)
  .refine(
    (values) => values.every((value, index) => index === 0 || value > values[index - 1]!),
    "History coordinates must preserve unique original order",
  );
const Criterion = PolicyEvaluationSourceReferenceSchema.refine(
  (source) => source.kind === "criterion_set",
);
const Status = PolicyEvaluationSourceReferenceSchema.refine(
  (source) => source.kind === "criterion_set_status",
);

export const PolicyEvaluationCriterionHistoryProjectionSchema = z
  .object({
    at: PolicyEvaluationTimeSchema,
    status: z.enum(["unresolved", "empty", "ambiguous", "head"]),
    active: Indices,
    heads: z
      .array(z.object({ historyIndex: Index, expired: z.boolean() }).strict())
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    inactivePredecessors: Indices,
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const active = new Set(value.active);
    const heads = value.heads.map(({ historyIndex }) => historyIndex);
    if (
      !heads.every(
        (index, offset) => active.has(index) && (offset === 0 || index > heads[offset - 1]!),
      ) ||
      !value.inactivePredecessors.every((index) => active.has(index))
    )
      context.addIssue({
        code: "custom",
        message: "Heads and inactive predecessors must retain original active coordinates",
      });
    if (
      (value.status === "empty" && heads.length !== 0) ||
      (value.status === "head" && heads.length !== 1) ||
      (value.status === "ambiguous" && heads.length < 2)
    )
      context.addIssue({
        code: "custom",
        message: "History projection state must retain complete head cardinality",
      });
    if (
      value.status !== "unresolved" &&
      (value.inactivePredecessors.length > 0 || (value.active.length > 0 && heads.length === 0))
    )
      context.addIssue({
        code: "custom",
        message:
          "Unresolved original predecessor/head evidence cannot become an empty or usable history",
      });
  });

export const PolicyEvaluationCriterionSelectionSchema = z.enum([
  "approved_head",
  "history_unresolved",
  "history_empty",
  "history_ambiguous",
  "selected_status_unavailable",
  "selected_status_not_head",
  "head_expired",
  "head_not_approved",
]);

/** Successor full bodies are owning-validated before projecting these exact original witnesses. */
export const PolicyEvaluationAuthoritySuccessorSchema = z
  .object({
    source: Criterion,
    observation: PolicyEvaluationSourceObservationSchema,
    storage: z
      .object({ recordSha256: Sha256Schema, receiptTime: PostgresTimestampSchema })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const observation = value.observation;
    const verified = observation.status === "verified";
    const future =
      observation.status === "unavailable" && observation.reason === "not_yet_available";
    if (
      (verified && value.storage === null) ||
      (!verified && !future && value.storage !== null) ||
      (observation.status === "verified" &&
        value.storage?.recordSha256 !== observation.recordSha256)
    )
      context.addIssue({
        code: "custom",
        message: "Successor availability must preserve its exact original storage witness",
      });
  });

const Observed = z
  .object({
    status: z.literal("observed"),
    scope: EvidenceScopeSchema,
    evaluationTime: PolicyEvaluationTimeSchema,
    startedAt: PolicyEvaluationTimeSchema,
    completedAt: PolicyEvaluationTimeSchema,
    historySha256: Sha256Schema,
    history: z
      .array(
        z.object({ record: CriterionSetStatusRecordSchema, recordSha256: Sha256Schema }).strict(),
      )
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    successors: z
      .array(PolicyEvaluationAuthoritySuccessorSchema)
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    criteria: z
      .array(
        z
          .object({
            source: Criterion,
            observation: PolicyEvaluationSourceObservationSchema,
            historyIndexes: Indices,
            issues: z
              .array(
                z
                  .object({
                    historyIndex: Index,
                    reason: z.enum([
                      "criterion_mismatch",
                      "criterion_receipt_order",
                      "previous_missing",
                      "previous_digest_mismatch",
                      "previous_criterion_mismatch",
                      "previous_receipt_order",
                      "history_cycle",
                      "successor_unavailable",
                      "successor_receipt_order",
                    ]),
                  })
                  .strict(),
              )
              .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
            atEvaluation: PolicyEvaluationCriterionHistoryProjectionSchema,
            atCapture: PolicyEvaluationCriterionHistoryProjectionSchema,
          })
          .strict(),
      )
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    selections: z
      .array(
        z
          .object({
            parent: PolicyEvaluationSourceReferenceSchema.refine(
              (source) =>
                source.kind === "assessment" ||
                source.kind === "evaluation_run" ||
                source.kind === "evaluation_run_rejection",
            ),
            parentRecordSha256: Sha256Schema,
            criterion: Criterion,
            status: Status,
            criterionEdgeIndex: Index,
            statusEdgeIndex: Index,
            atEvaluation: PolicyEvaluationCriterionSelectionSchema,
            atCapture: PolicyEvaluationCriterionSelectionSchema,
          })
          .strict(),
      )
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const same = (left: unknown, right: unknown) =>
      serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    if (
      policyEvaluationTimestampOrderKey(value.startedAt) <
        policyEvaluationTimestampOrderKey(value.evaluationTime) ||
      policyEvaluationTimestampOrderKey(value.completedAt) <
        policyEvaluationTimestampOrderKey(value.startedAt)
    )
      issue("Criterion authority receipts must preserve capture order and semantic cut");
    for (const { record } of value.history)
      if (
        !same(record.scope, value.scope) ||
        policyEvaluationTimestampOrderKey(record.recordedAt) >
          policyEvaluationTimestampOrderKey(value.completedAt)
      )
        issue(
          "Complete status history must retain exact scope and nonfuture authoritative receipts",
        );
    for (const criterion of value.criteria) {
      if (
        criterion.atEvaluation.at !== value.evaluationTime ||
        criterion.atCapture.at !== value.completedAt
      )
        issue("Criterion projections must use the exact original semantic and capture cuts");
      const own = new Set(criterion.historyIndexes);
      if (
        criterion.historyIndexes.some((index) => index >= value.history.length) ||
        criterion.issues.some(({ historyIndex }) => historyIndex >= value.history.length) ||
        [...criterion.atEvaluation.active, ...criterion.atCapture.active].some(
          (index) => !own.has(index),
        )
      )
        issue("Criterion projections must join complete original history coordinates");
    }
  });

/** Bound all nested occurrence lists before reading history/record material. */
export const PolicyEvaluationCriterionAuthorityInputsSchema = z.preprocess(
  (raw, context) => {
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      let count = 1;
      for (const key of ["history", "successors", "criteria", "selections"] as const) {
        const items: unknown = Reflect.get(raw, key);
        if (!Array.isArray(items)) continue;
        count += items.length;
        if (key === "criteria" && count <= MAX_POLICY_EVALUATION_ACQUISITION_RECORDS)
          for (const item of items) {
            if (item !== null && typeof item === "object" && !Array.isArray(item)) {
              for (const field of ["historyIndexes", "issues"] as const) {
                const values: unknown = Reflect.get(item, field);
                if (Array.isArray(values)) count += values.length;
              }
              for (const field of ["atEvaluation", "atCapture"] as const) {
                const projection: unknown = Reflect.get(item, field);
                if (
                  projection !== null &&
                  typeof projection === "object" &&
                  !Array.isArray(projection)
                )
                  for (const list of ["active", "heads", "inactivePredecessors"] as const) {
                    const values: unknown = Reflect.get(projection, list);
                    if (Array.isArray(values)) count += values.length;
                  }
              }
            }
            if (count > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS) break;
          }
      }
      if (count > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS) {
        context.addIssue({
          code: "custom",
          message: "Criterion authority occurrences exceed the fixed snapshot ceiling",
        });
        return z.NEVER;
      }
    }
    return raw;
  },
  z.union([z.object({ status: z.literal("not_required") }).strict(), Observed]),
);

export type PolicyEvaluationCriterionAuthorityInputs = z.infer<
  typeof PolicyEvaluationCriterionAuthorityInputsSchema
>;
