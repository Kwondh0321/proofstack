import { z } from "zod";
import { JsonPointerSchema } from "./artifact.js";
import { MAX_POLICY_EVALUATION_ACQUISITION_RECORDS } from "./policy-evaluation-request.js";
import { MAX_POLICY_RULES } from "./release-policy.js";
import { OpaqueIdSchema, Sha256Schema } from "./primitives.js";
import { PolicyEvaluationSourceReferenceSchema } from "./policy-evaluation-source-reference.js";

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
    "Closure coordinates must retain unique original order",
  );
export const POLICY_EVALUATION_SEMANTIC_CHECK_KINDS = [
  "parent_unavailable",
  "dataset_member",
  "dataset_predecessor",
  "fixture_predecessor",
  "runtime_family",
  "runtime_configuration",
  "boundary_kind",
  "boundary_mode",
  "invocation_digest",
  "fixture_membership",
  "fixture_format",
  "endpoint_destination",
  "endpoint_operation",
  "endpoint_boundary_kind",
  "plan_receipt",
  "start_receipt",
  "attempt_count",
  "target_release",
  "runtime_profile",
  "isolation_profile",
  "worker_protocol",
  "retry_declaration",
  "retry_timing",
  "budget_policy",
  "budget_reconciliation_receipt",
  "budget_boundary",
  "execution_boundary",
  "usage_boundary",
  "history_receipt",
  "budget_closed",
  "budget_overrun",
  "budget_usage",
  "run_criterion",
  "run_applicability_context",
  "run_applicability_result",
  "run_criterion_receipt",
  "run_status",
  "run_aggregation",
  "run_source_reviews",
  "run_criterion_reference",
  "run_specification",
  "run_budget",
  "run_qualification_subject",
  "run_qualification_fixture_set",
  "run_qualification_cases",
  "run_qualification_coverage",
  "run_qualification_outcome",
  "run_qualification_window",
  "run_qualification_receipts",
  "run_definition",
  "run_history",
  "aggregate_snapshot",
  "aggregate_history",
  "assessment_snapshot",
  "plan_dataset",
  "plan_target",
  "plan_prerequisites",
  "result_history",
  "base_assessment",
  "base_history",
  "non_model_lineage",
  "calibration",
  "qualification",
  "qualification_sources",
  "qualification_evaluator",
  "blinded_result",
  "blind_observations",
  "assurance_lineage",
  "independent_critique",
  "critique_lineage",
  "human_quorum",
  "human_review_lineage",
  "declared_eligibility",
  "validity_bound",
  "dependency_receipts",
  "assessment_history",
  "model_assurance_history",
  "aggregate_available",
  "aggregation_policy_available",
  "run_available",
  "candidate_dataset",
  "candidate_target",
  "dataset_available",
  "fixture_available",
  "target_available",
  "dataset_fixture",
] as const;
export const PolicyEvaluationSemanticCheckSchema = z
  .object({
    context: z.enum(["semantic", "stored"]),
    domain: z.enum([
      "dataset",
      "replay_plan",
      "replay_result",
      "evaluation_snapshot",
      "evaluation_replay",
      "model_assurance",
      "candidate_assessment",
    ]),
    reportIndex: Index,
    checkIndex: Index,
    parent: PolicyEvaluationSourceReferenceSchema,
    parentRecordSha256: Sha256Schema.nullable(),
    owner: PolicyEvaluationSourceReferenceSchema,
    path: z.union([z.literal(""), JsonPointerSchema]),
    kind: z.enum(POLICY_EVALUATION_SEMANTIC_CHECK_KINDS),
    status: z.enum(["matched", "mismatch", "unavailable"]),
    reasons: z.array(z.string().min(1).max(256)).max(64),
    relatedSource: PolicyEvaluationSourceReferenceSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const parents = {
      dataset: ["dataset_version", "regression_fixture_version"],
      replay_plan: ["replay_plan"],
      replay_result: ["replay_result"],
      evaluation_snapshot: [
        "evaluation_run",
        "evaluation_run_result",
        "evaluation_aggregate",
        "assessment",
      ],
      evaluation_replay: ["evaluation_run"],
      model_assurance: ["model_assurance_assessment"],
      candidate_assessment: ["assessment", "model_assurance_assessment", "release_candidate"],
    } as const;
    if (!(parents[value.domain] as readonly string[]).includes(value.parent.kind))
      context.addIssue({
        code: "custom",
        message: "Semantic report domain substituted its owning parent kind",
      });
    const kinds: Record<typeof value.domain, readonly string[]> = {
      dataset: ["dataset_member", "dataset_predecessor", "fixture_predecessor"],
      replay_plan: [
        "runtime_family",
        "runtime_configuration",
        "boundary_kind",
        "boundary_mode",
        "invocation_digest",
        "fixture_membership",
        "fixture_format",
        "endpoint_destination",
        "endpoint_operation",
        "endpoint_boundary_kind",
      ],
      replay_result: [
        "plan_receipt",
        "start_receipt",
        "attempt_count",
        "target_release",
        "runtime_profile",
        "isolation_profile",
        "worker_protocol",
        "retry_declaration",
        "retry_timing",
        "budget_policy",
        "budget_reconciliation_receipt",
        "budget_boundary",
        "execution_boundary",
        "usage_boundary",
        "history_receipt",
        "budget_closed",
        "budget_overrun",
        "budget_usage",
      ],
      evaluation_snapshot: [
        "run_criterion",
        "run_applicability_context",
        "run_applicability_result",
        "run_criterion_receipt",
        "run_status",
        "run_aggregation",
        "run_source_reviews",
        "run_criterion_reference",
        "run_specification",
        "run_budget",
        "run_qualification_subject",
        "run_qualification_fixture_set",
        "run_qualification_cases",
        "run_qualification_coverage",
        "run_qualification_outcome",
        "run_qualification_window",
        "run_qualification_receipts",
        "run_definition",
        "run_history",
        "aggregate_snapshot",
        "aggregate_history",
        "assessment_snapshot",
      ],
      evaluation_replay: [
        "plan_dataset",
        "plan_target",
        "plan_receipt",
        "plan_prerequisites",
        "result_history",
      ],
      model_assurance: [
        "base_assessment",
        "base_history",
        "non_model_lineage",
        "calibration",
        "qualification",
        "qualification_sources",
        "qualification_evaluator",
        "blinded_result",
        "blind_observations",
        "assurance_lineage",
        "independent_critique",
        "critique_lineage",
        "human_quorum",
        "human_review_lineage",
        "declared_eligibility",
        "validity_bound",
        "dependency_receipts",
      ],
      candidate_assessment: [
        "assessment_history",
        "model_assurance_history",
        "aggregate_available",
        "aggregation_policy_available",
        "run_available",
        "candidate_dataset",
        "candidate_target",
        "dataset_available",
        "fixture_available",
        "target_available",
        "dataset_fixture",
      ],
    };
    if (value.kind !== "parent_unavailable" && !kinds[value.domain].includes(value.kind))
      context.addIssue({
        code: "custom",
        message: "Semantic check kind does not belong to its owning report domain",
      });
    if (
      value.domain === "candidate_assessment" &&
      value.parent.kind === "release_candidate" &&
      value.kind !== "parent_unavailable"
    )
      context.addIssue({
        code: "custom",
        message: "Candidate root unavailability cannot substitute a member relationship",
      });
    if (value.kind !== "parent_unavailable" && value.parentRecordSha256 === null)
      context.addIssue({
        code: "custom",
        message: "Retained relationship checks require their original full body witness",
      });
    if (value.kind === "parent_unavailable" && value.status !== "unavailable")
      context.addIssue({
        code: "custom",
        message: "Unavailable parent cannot become a matched empty report",
      });
  });
const Coordinates = z
  .object({
    sourceIndexes: Indices,
    edgeIndexes: Indices,
    frontierEdgeIndexes: Indices,
    checkIndexes: Indices,
  })
  .strict();
/** Complete owning relationship findings and original dependency uses; no computed policy outcome. */
export const PolicyEvaluationSnapshotClosureSchema = z
  .object({
    schemaVersion: z.literal("0.1"),
    checks: z
      .array(PolicyEvaluationSemanticCheckSchema)
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    rootContext: Coordinates,
    rules: z
      .array(
        Coordinates.extend({
          ruleIndex: z
            .number()
            .int()
            .nonnegative()
            .max(MAX_POLICY_RULES - 1),
          ruleId: OpaqueIdSchema,
        }).strict(),
      )
      .max(MAX_POLICY_RULES),
  })
  .strict()
  .superRefine((value, context) => {
    value.rules.forEach((rule, index) => {
      if (rule.ruleIndex !== index)
        context.addIssue({
          code: "custom",
          message: "Closure must retain complete original rule order",
        });
    });
    for (const row of [value.rootContext, ...value.rules])
      if (row.checkIndexes.some((index) => index >= value.checks.length))
        context.addIssue({
          code: "custom",
          message: "Closure references an omitted semantic check",
        });
    const origins = value.checks.map((check) =>
      JSON.stringify([check.context, check.domain, check.reportIndex, check.checkIndex]),
    );
    if (new Set(origins).size !== origins.length)
      context.addIssue({
        code: "custom",
        message: "Closure cannot duplicate an owning report check coordinate",
      });
  });
export type PolicyEvaluationSnapshotClosure = z.infer<typeof PolicyEvaluationSnapshotClosureSchema>;
export type PolicyEvaluationSemanticCheck = z.infer<typeof PolicyEvaluationSemanticCheckSchema>;
