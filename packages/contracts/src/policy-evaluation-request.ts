import { z } from "zod";
import { EvidenceScopeSchema } from "./evidence.js";
import {
  POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";
import { ReleaseCandidateReferenceSchema } from "./release-candidate.js";
import { MAX_POLICY_RULES, ReleasePolicyReferenceSchema } from "./release-policy.js";

export const POLICY_EVALUATION_REQUEST_SCHEMA_VERSION = "0.1" as const;
export const POLICY_EVALUATION_ALGORITHM_VERSION = "1.0.0" as const;
export const MAX_POLICY_EVALUATION_ATTEMPTS = 8;
export const MAX_POLICY_EVALUATION_ACQUISITION_RECORDS = 100_000;
export const MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES = 64 * 1024 * 1024;
export const MAX_POLICY_EVALUATION_ARTIFACT_READ_BYTES = 256 * 1024 * 1024;
export const MAX_POLICY_EVALUATION_RULE_EVALUATIONS =
  MAX_POLICY_RULES * MAX_POLICY_EVALUATION_ATTEMPTS;
export const MAX_POLICY_EVALUATION_LEASE_MILLISECONDS = 60_000;
export const MAX_POLICY_EVALUATION_HEARTBEAT_MILLISECONDS = 10_000;
export const MAX_POLICY_EVALUATION_ATTEMPT_MILLISECONDS = 15 * 60_000;
export const MAX_POLICY_EVALUATION_DEADLINE_MILLISECONDS = 60 * 60_000;
export const MAX_POLICY_EVALUATION_BACKOFF_MILLISECONDS = 60_000;

export const PolicyEvaluationAlgorithmSchema = z
  .object({
    id: z.literal("proofstack.deterministic-policy"),
    version: z.literal(POLICY_EVALUATION_ALGORITHM_VERSION),
  })
  .strict();

export const PolicyEvaluationRetryableErrorSchema = z.enum([
  "lease_expired",
  "source_revision_changed",
  "source_temporarily_unavailable",
  "worker_interrupted",
]);

function boundedInteger(minimum: number, maximum: number) {
  return z.number().int().min(minimum).max(maximum);
}

/** All counters are cumulative for one job, including repeated observations and retries. */
export const PolicyEvaluationExecutionLimitsSchema = z
  .object({
    heartbeatIntervalMilliseconds: boundedInteger(
      100,
      MAX_POLICY_EVALUATION_HEARTBEAT_MILLISECONDS,
    ),
    leaseDurationMilliseconds: boundedInteger(1_000, MAX_POLICY_EVALUATION_LEASE_MILLISECONDS),
    maxAcquisitionRecordBytes: boundedInteger(1, MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES),
    maxAcquisitionRecords: boundedInteger(2, MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    maxArtifactReadBytes: boundedInteger(0, MAX_POLICY_EVALUATION_ARTIFACT_READ_BYTES),
    maxAttempts: boundedInteger(1, MAX_POLICY_EVALUATION_ATTEMPTS),
    maxRuleEvaluations: boundedInteger(1, MAX_POLICY_EVALUATION_RULE_EVALUATIONS),
    perAttemptTimeoutMilliseconds: boundedInteger(
      1_000,
      MAX_POLICY_EVALUATION_ATTEMPT_MILLISECONDS,
    ),
    retryBackoffMilliseconds: boundedInteger(0, MAX_POLICY_EVALUATION_BACKOFF_MILLISECONDS),
    retryableErrors: z
      .array(PolicyEvaluationRetryableErrorSchema)
      .max(PolicyEvaluationRetryableErrorSchema.options.length)
      .refine(
        (values) =>
          values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value),
        {
          message: "Retryable errors must be unique and sorted",
        },
      ),
    totalDeadlineMilliseconds: boundedInteger(1_000, MAX_POLICY_EVALUATION_DEADLINE_MILLISECONDS),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const issue = (field: keyof typeof value, message: string) =>
      context.addIssue({ code: "custom", message, path: [field] });
    if (value.heartbeatIntervalMilliseconds * 3 > value.leaseDurationMilliseconds) {
      issue(
        "heartbeatIntervalMilliseconds",
        "The lease must allow at least three heartbeat intervals",
      );
    }
    if (value.leaseDurationMilliseconds > value.perAttemptTimeoutMilliseconds) {
      issue("leaseDurationMilliseconds", "A lease cannot exceed the per-attempt timeout");
    }
    if (value.perAttemptTimeoutMilliseconds > value.totalDeadlineMilliseconds) {
      issue("perAttemptTimeoutMilliseconds", "An attempt cannot exceed the total job deadline");
    }
    if (value.maxRuleEvaluations > MAX_POLICY_RULES * value.maxAttempts) {
      issue(
        "maxRuleEvaluations",
        "Rule work cannot exceed all declared rules across the allowed attempts",
      );
    }
    if (value.maxAttempts === 1) {
      if (value.retryableErrors.length !== 0 || value.retryBackoffMilliseconds !== 0) {
        issue("retryableErrors", "Single-attempt execution cannot declare retries or backoff");
      }
    } else {
      if (value.retryableErrors.length === 0) {
        issue("retryableErrors", "Multiple attempts require explicit retryable operational errors");
      }
      if (value.retryBackoffMilliseconds >= value.totalDeadlineMilliseconds) {
        issue("retryBackoffMilliseconds", "Retry backoff must be shorter than the total deadline");
      }
    }
  });

const policyEvaluationRequestDefinitionShape = {
  algorithm: PolicyEvaluationAlgorithmSchema,
  candidate: ReleaseCandidateReferenceSchema,
  evaluationRequestId: OpaqueIdSchema,
  evaluationTime: PolicyEvaluationTimeSchema,
  limits: PolicyEvaluationExecutionLimitsSchema,
  policy: ReleasePolicyReferenceSchema,
};

export const PolicyEvaluationRequestDefinitionSchema = z
  .object(policyEvaluationRequestDefinitionShape)
  .strict();

/** Caller input contains no scope override, operand, verdict, receipt, worker, or credential. */
export const EnqueuePolicyEvaluationRequestSchema = PolicyEvaluationRequestDefinitionSchema;

export const PolicyEvaluationRequestReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    evaluationRequestId: OpaqueIdSchema,
  })
  .strict();

const MAX_SERVER_TIME_KEY = policyEvaluationTimestampOrderKey("9999-12-31T23:59:59.999Z");

export const PolicyEvaluationRequestSchema = z
  .object({
    ...policyEvaluationRequestDefinitionShape,
    createdAt: UtcMillisecondTimestampSchema,
    createdByPrincipalId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
    schemaVersion: z.literal(POLICY_EVALUATION_REQUEST_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const deadline =
      policyEvaluationTimestampOrderKey(value.createdAt) +
      BigInt(value.limits.totalDeadlineMilliseconds) * POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND;
    if (deadline > MAX_SERVER_TIME_KEY) {
      context.addIssue({
        code: "custom",
        message: "The server receipt must leave room for the complete declared job deadline",
        path: ["createdAt"],
      });
    }
  });

export type PolicyEvaluationExecutionLimits = z.infer<typeof PolicyEvaluationExecutionLimitsSchema>;
export type PolicyEvaluationRequestDefinition = z.infer<
  typeof PolicyEvaluationRequestDefinitionSchema
>;
export type PolicyEvaluationRequest = z.infer<typeof PolicyEvaluationRequestSchema>;
export type PolicyEvaluationRequestReference = z.infer<
  typeof PolicyEvaluationRequestReferenceSchema
>;
export type EnqueuePolicyEvaluationRequest = z.infer<typeof EnqueuePolicyEvaluationRequestSchema>;
