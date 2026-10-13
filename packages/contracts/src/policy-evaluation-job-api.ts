import { z } from "zod";
import { RequestIdSchema } from "./api.js";
import { PolicyEvaluationJobSnapshotSchema } from "./policy-evaluation-job-snapshot.js";

// One request plus <=8 compact attempts and bounded scheduler/cancellation/native receipts.
export const MAX_POLICY_EVALUATION_JOB_RESPONSE_BYTES = 64 * 1024;
export const MAX_POLICY_EVALUATION_CANCELLATION_REQUEST_BYTES = 1024;
export const RequestPolicyEvaluationCancellationSchema = z
  .object({
    reason: z.enum(["operator_requested", "superseded_request", "incident_response"]),
  })
  .strict();
export const ReadPolicyEvaluationJobResponseSchema = z
  .object({
    snapshot: PolicyEvaluationJobSnapshotSchema,
    requestId: RequestIdSchema,
  })
  .strict();
export type RequestPolicyEvaluationCancellation = z.infer<
  typeof RequestPolicyEvaluationCancellationSchema
>;
export type ReadPolicyEvaluationJobResponse = z.infer<typeof ReadPolicyEvaluationJobResponseSchema>;
