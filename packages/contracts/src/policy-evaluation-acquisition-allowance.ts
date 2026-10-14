import { z } from "zod";
import { OpaqueIdSchema } from "./primitives.js";
import { PolicyEvaluationWorkerMutationFenceSchema } from "./policy-evaluation-job-fence.js";
import { PolicyEvaluationTimeSchema } from "./policy-evaluation-time.js";
import {
  MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES,
} from "./policy-evaluation-request.js";

const Count = z.number().int().nonnegative().max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS);
const Bytes = z.number().int().nonnegative().max(MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES);
/** Observed metadata counts, distinct from artifact bytes and rule invocations. */
export const PolicyEvaluationAcquisitionUsageSchema = z
  .object({
    reads: Count,
    records: Count,
    references: Count,
    recordBytes: Bytes,
    referenceBytes: Bytes,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.recordBytes + value.referenceBytes > MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES)
      context.addIssue({
        code: "custom",
        message: "Metadata record and reference bytes share one ceiling",
      });
  });
/** One shared byte allowance; record/reference counts retain their independent request ceilings. */
export const PolicyEvaluationAcquisitionLimitsSchema = z
  .object({
    reads: Count,
    records: Count,
    references: Count,
    recordAndReferenceBytes: Bytes,
  })
  .strict();
export const PolicyEvaluationAcquisitionAllowanceSchema = z
  .object({
    schemaVersion: z.literal("0.1"),
    allowanceId: OpaqueIdSchema,
    mutationFence: PolicyEvaluationWorkerMutationFenceSchema,
    reservedAt: PolicyEvaluationTimeSchema,
    usageAtReservation: PolicyEvaluationAcquisitionUsageSchema,
    limits: PolicyEvaluationAcquisitionLimitsSchema,
  })
  .strict();
export type PolicyEvaluationAcquisitionUsage = z.infer<
  typeof PolicyEvaluationAcquisitionUsageSchema
>;
export type PolicyEvaluationAcquisitionLimits = z.infer<
  typeof PolicyEvaluationAcquisitionLimitsSchema
>;
export type PolicyEvaluationAcquisitionAllowance = z.infer<
  typeof PolicyEvaluationAcquisitionAllowanceSchema
>;
