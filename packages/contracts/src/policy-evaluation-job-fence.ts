import { z } from "zod";
import { EvidenceScopeSchema } from "./evidence.js";
import { MAX_POLICY_EVALUATION_ATTEMPTS } from "./policy-evaluation-request.js";
import {
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { OpaqueIdSchema } from "./primitives.js";

export const POLICY_EVALUATION_LEASE_SCHEMA_VERSION = "0.1" as const;
const Positive = z.number().int().positive().safe();
const Nonnegative = z.number().int().nonnegative().safe();
export const PolicyEvaluationWorkerMutationFenceSchema = z
  .object({
    jobId: OpaqueIdSchema,
    attemptId: OpaqueIdSchema,
    workerId: OpaqueIdSchema,
    leaseId: OpaqueIdSchema,
    fencingToken: Positive,
    recoveryEpoch: Nonnegative,
  })
  .strict();

/** Native receipt geometry only; authority requires live normalized state, epoch and DB expiry. */
export const PolicyEvaluationLeaseSchema = z
  .object({
    schemaVersion: z.literal(POLICY_EVALUATION_LEASE_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
    mutationFence: PolicyEvaluationWorkerMutationFenceSchema,
    attemptSequence: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_POLICY_EVALUATION_ATTEMPTS - 1),
    acquiredAt: PolicyEvaluationTimeSchema,
    heartbeatAt: PolicyEvaluationTimeSchema,
    expiresAt: PolicyEvaluationTimeSchema,
    attemptDeadlineAt: PolicyEvaluationTimeSchema,
    jobDeadlineAt: PolicyEvaluationTimeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const order = policyEvaluationTimestampOrderKey;
    const issue = (field: keyof typeof value, message: string) =>
      context.addIssue({ code: "custom", message, path: [field] });
    if (order(value.heartbeatAt) < order(value.acquiredAt))
      issue("heartbeatAt", "Heartbeat cannot precede original lease acquisition");
    if (order(value.expiresAt) <= order(value.heartbeatAt))
      issue("expiresAt", "Expiry must follow the latest heartbeat strictly");
    if (order(value.expiresAt) > order(value.attemptDeadlineAt))
      issue("expiresAt", "Lease cannot extend original attempt deadline");
    if (order(value.attemptDeadlineAt) > order(value.jobDeadlineAt))
      issue("attemptDeadlineAt", "Attempt cannot extend original job deadline");
  });
export type PolicyEvaluationWorkerMutationFence = z.infer<
  typeof PolicyEvaluationWorkerMutationFenceSchema
>;
export type PolicyEvaluationLease = z.infer<typeof PolicyEvaluationLeaseSchema>;
