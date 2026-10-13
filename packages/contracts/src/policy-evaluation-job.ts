import { z } from "zod";
import { EvidenceScopeSchema } from "./evidence.js";
import { PolicyEvaluationLeaseSchema } from "./policy-evaluation-job-fence.js";
import {
  PolicyEvaluationRequestReferenceSchema,
  MAX_POLICY_EVALUATION_ATTEMPTS,
} from "./policy-evaluation-request.js";
import { PolicyEvaluationResultReferenceSchema } from "./policy-evaluation-result.js";
import { PolicyEvaluationSnapshotReferenceSchema } from "./policy-evaluation-snapshot.js";
import {
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { OpaqueIdSchema, Sha256Schema } from "./primitives.js";

export const POLICY_EVALUATION_JOB_SCHEMA_VERSION = "0.1" as const;
const JobDefinitionShape = {
  jobId: OpaqueIdSchema,
  request: PolicyEvaluationRequestReferenceSchema,
};
export const PolicyEvaluationJobDefinitionSchema = z.object(JobDefinitionShape).strict();
export const PolicyEvaluationJobReferenceSchema = z
  .object({ jobId: OpaqueIdSchema, definitionSha256: Sha256Schema })
  .strict();
export const PolicyEvaluationJobStatusSchema = z.enum([
  "queued",
  "acquiring",
  "sealed",
  "running",
  "retry_ready",
  "completed",
  "failed",
  "timed_out",
  "budget_exhausted",
  "cancelled",
]);
export const PolicyEvaluationJobTerminalStatusSchema = z.enum([
  "completed",
  "failed",
  "timed_out",
  "budget_exhausted",
  "cancelled",
]);
export const PolicyEvaluationJobTerminalCodeSchema = z.enum([
  "evaluation_completed",
  "contract_rejected",
  "acquisition_failed",
  "execution_failed",
  "retries_exhausted",
  "deadline_reached",
  "budget_limit_reached",
  "cancellation_committed",
]);
const Terminal = z
  .object({
    status: PolicyEvaluationJobTerminalStatusSchema,
    code: PolicyEvaluationJobTerminalCodeSchema,
    attemptId: OpaqueIdSchema.nullable(),
    committedAt: PolicyEvaluationTimeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const codes = {
      completed: ["evaluation_completed"],
      failed: ["contract_rejected", "acquisition_failed", "execution_failed", "retries_exhausted"],
      timed_out: ["deadline_reached"],
      budget_exhausted: ["budget_limit_reached"],
      cancelled: ["cancellation_committed"],
    };
    if (!codes[value.status].includes(value.code))
      context.addIssue({
        code: "custom",
        message: "Terminal status must retain its original operational cause",
      });
    if (value.status === "completed" && value.attemptId === null)
      context.addIssue({ code: "custom", message: "Completion requires its deciding attempt" });
  });

/** Mutable scheduler projection. Immutable input/result records have separate owning validation. */
export const PolicyEvaluationJobSchema = z
  .object({
    schemaVersion: z.literal(POLICY_EVALUATION_JOB_SCHEMA_VERSION),
    ...JobDefinitionShape,
    definitionSha256: Sha256Schema,
    scope: EvidenceScopeSchema,
    createdAt: PolicyEvaluationTimeSchema,
    createdByPrincipalId: OpaqueIdSchema,
    deadlineAt: PolicyEvaluationTimeSchema,
    updatedAt: PolicyEvaluationTimeSchema,
    stateVersion: z.number().int().positive().safe(),
    recoveryEpoch: z.number().int().nonnegative().safe(),
    lastFencingToken: z.number().int().nonnegative().safe(),
    attemptCount: z.number().int().nonnegative().max(MAX_POLICY_EVALUATION_ATTEMPTS),
    status: PolicyEvaluationJobStatusSchema,
    currentLease: PolicyEvaluationLeaseSchema.nullable(),
    snapshot: PolicyEvaluationSnapshotReferenceSchema.nullable(),
    result: PolicyEvaluationResultReferenceSchema.nullable(),
    retryAt: PolicyEvaluationTimeSchema.nullable(),
    terminal: Terminal.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const time = policyEvaluationTimestampOrderKey;
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    if (
      time(value.updatedAt) < time(value.createdAt) ||
      time(value.deadlineAt) <= time(value.createdAt)
    )
      issue("Job receipts cannot precede creation or remove its positive execution window");
    const terminal = PolicyEvaluationJobTerminalStatusSchema.safeParse(value.status).success;
    if (terminal !== (value.terminal !== null))
      issue("Terminal scheduler state requires exactly one terminal record");
    if (
      value.terminal !== null &&
      (value.terminal.status !== value.status ||
        time(value.terminal.committedAt) > time(value.updatedAt) ||
        time(value.terminal.committedAt) < time(value.createdAt))
    )
      issue("Terminal receipt must match job status and original receipt order");
    const leased = ["acquiring", "sealed", "running"].includes(value.status);
    if (leased !== (value.currentLease !== null))
      issue("Only active acquiring/sealed/running states own a current lease");
    if (value.currentLease !== null) {
      const lease = value.currentLease;
      if (
        lease.mutationFence.jobId !== value.jobId ||
        lease.mutationFence.fencingToken !== value.lastFencingToken ||
        lease.mutationFence.recoveryEpoch !== value.recoveryEpoch ||
        lease.scope.tenantId !== value.scope.tenantId ||
        lease.scope.projectId !== value.scope.projectId ||
        lease.scope.environmentId !== value.scope.environmentId ||
        lease.attemptSequence + 1 !== value.attemptCount ||
        lease.jobDeadlineAt !== value.deadlineAt ||
        time(lease.acquiredAt) < time(value.createdAt) ||
        time(lease.heartbeatAt) > time(value.updatedAt)
      )
        issue("Current lease must bind exact scope/job/attempt/fence/epoch and frozen deadline");
    }
    if ((value.attemptCount === 0) !== (value.lastFencingToken === 0))
      issue("Claimed execution must retain its positive fence and attempt count");
    if (["queued", "acquiring"].includes(value.status) && value.snapshot !== null)
      issue("Pre-seal scheduler state cannot contain a sealed snapshot");
    if (["sealed", "running", "completed"].includes(value.status) && value.snapshot === null)
      issue("Post-seal scheduler state requires its immutable snapshot");
    if ((value.status === "completed") !== (value.result !== null))
      issue("Only completed jobs retain an immutable policy result");
    if ((value.status === "retry_ready") !== (value.retryAt !== null))
      issue("Retry readiness requires its explicit finite retry receipt");
    if (
      value.retryAt !== null &&
      (value.attemptCount === 0 ||
        time(value.retryAt) < time(value.updatedAt) ||
        time(value.retryAt) >= time(value.deadlineAt))
    )
      issue("Retry cannot precede closure, omit prior work or extend the original job deadline");
    if (value.status === "queued" && value.attemptCount !== 0)
      issue("Initial queued state cannot erase an earlier attempt");
    if (
      value.terminal !== null &&
      (value.attemptCount === 0) !== (value.terminal.attemptId === null)
    )
      issue("Terminal receipt must preserve whether any attempt actually started");
  });
export type PolicyEvaluationJob = z.infer<typeof PolicyEvaluationJobSchema>;
export type PolicyEvaluationJobDefinition = z.infer<typeof PolicyEvaluationJobDefinitionSchema>;
export type PolicyEvaluationJobReference = z.infer<typeof PolicyEvaluationJobReferenceSchema>;
