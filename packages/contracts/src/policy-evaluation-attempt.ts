import { z } from "zod";
import { EvidenceScopeSchema } from "./evidence.js";
import { PolicyEvaluationWorkerMutationFenceSchema } from "./policy-evaluation-job-fence.js";
import {
  MAX_POLICY_EVALUATION_ATTEMPTS,
  PolicyEvaluationRetryableErrorSchema,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES,
  MAX_POLICY_EVALUATION_ARTIFACT_READ_BYTES,
  MAX_POLICY_EVALUATION_RULE_EVALUATIONS,
} from "./policy-evaluation-request.js";
import { PolicyEvaluationSnapshotReferenceSchema } from "./policy-evaluation-snapshot.js";
import {
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { OpaqueIdSchema } from "./primitives.js";

export const POLICY_EVALUATION_ATTEMPT_SCHEMA_VERSION = "0.1" as const;
export const PolicyEvaluationUsageSchema = z
  .object({
    reads: z.number().int().nonnegative().max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    records: z.number().int().nonnegative().max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    recordBytes: z.number().int().nonnegative().max(MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES),
    references: z.number().int().nonnegative().max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    referenceBytes: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES),
    artifactReadBytes: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_POLICY_EVALUATION_ARTIFACT_READ_BYTES),
    ruleEvaluations: z.number().int().nonnegative().max(MAX_POLICY_EVALUATION_RULE_EVALUATIONS),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.recordBytes + value.referenceBytes > MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES)
      context.addIssue({
        code: "custom",
        message: "Record and repeated-reference bytes share one cumulative ceiling",
      });
  });
const Closure = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), committedAt: PolicyEvaluationTimeSchema }).strict(),
  z
    .object({
      status: z.literal("interrupted"),
      reason: PolicyEvaluationRetryableErrorSchema,
      committedAt: PolicyEvaluationTimeSchema,
    })
    .strict(),
  z
    .object({
      status: z.enum(["failed", "cancelled", "timed_out", "budget_exhausted"]),
      reason: z.enum([
        "contract_rejected",
        "acquisition_failed",
        "execution_failed",
        "cancellation_committed",
        "deadline_reached",
        "budget_limit_reached",
      ]),
      committedAt: PolicyEvaluationTimeSchema,
    })
    .strict(),
]);
/** Append-only start/closure. Once bound, a sealed snapshot is retained by every later attempt. */
export const PolicyEvaluationAttemptSchema = z
  .object({
    schemaVersion: z.literal(POLICY_EVALUATION_ATTEMPT_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
    mutationFence: PolicyEvaluationWorkerMutationFenceSchema,
    attemptSequence: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_POLICY_EVALUATION_ATTEMPTS - 1),
    startedAt: PolicyEvaluationTimeSchema,
    deadlineAt: PolicyEvaluationTimeSchema,
    phase: z.enum(["acquiring", "computing"]),
    snapshot: PolicyEvaluationSnapshotReferenceSchema.nullable(),
    usageAtStart: PolicyEvaluationUsageSchema,
    usageAtClose: PolicyEvaluationUsageSchema.nullable(),
    closure: Closure.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const time = policyEvaluationTimestampOrderKey;
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    if (time(value.deadlineAt) <= time(value.startedAt))
      issue("Attempt requires its positive frozen execution window");
    if ((value.phase === "computing") !== (value.snapshot !== null))
      issue("Computing requires the original sealed snapshot; acquiring cannot carry one");
    if ((value.closure === null) !== (value.usageAtClose === null))
      issue("Every closed attempt retains its cumulative usage receipt");
    if (value.closure !== null) {
      if (time(value.closure.committedAt) < time(value.startedAt))
        issue("Attempt closure cannot precede its original start");
      if (value.closure.status === "completed" && value.phase !== "computing")
        issue("Acquisition alone cannot complete a policy evaluation");
      if (
        value.closure.status === "interrupted" &&
        value.phase === "computing" &&
        value.closure.reason === "source_revision_changed"
      )
        issue("A post-seal retry cannot recapture a fresher source cut");
      if (value.closure.status !== "completed" && value.closure.status !== "interrupted") {
        const codes = {
          failed: ["contract_rejected", "acquisition_failed", "execution_failed"],
          cancelled: ["cancellation_committed"],
          timed_out: ["deadline_reached"],
          budget_exhausted: ["budget_limit_reached"],
        };
        if (!codes[value.closure.status].includes(value.closure.reason))
          issue("Closure must retain its original operational cause");
      }
    }
    if (value.usageAtClose !== null)
      for (const key of Object.keys(value.usageAtStart) as (keyof typeof value.usageAtStart)[])
        if (value.usageAtClose[key] < value.usageAtStart[key])
          issue("Failed, cancelled and repeated work cannot refund cumulative usage");
  });
export const PolicyEvaluationCancellationSchema = z
  .object({
    jobId: OpaqueIdSchema,
    cancellationId: OpaqueIdSchema,
    scope: EvidenceScopeSchema,
    requestedAt: PolicyEvaluationTimeSchema,
    requestedByPrincipalId: OpaqueIdSchema,
    reason: z.enum(["operator_requested", "superseded_request", "incident_response"]),
  })
  .strict();
export type PolicyEvaluationUsage = z.infer<typeof PolicyEvaluationUsageSchema>;
export type PolicyEvaluationAttempt = z.infer<typeof PolicyEvaluationAttemptSchema>;
export type PolicyEvaluationCancellation = z.infer<typeof PolicyEvaluationCancellationSchema>;
