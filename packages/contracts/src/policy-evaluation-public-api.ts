import { z } from "zod";
import { RequestIdSchema } from "./api.js";
import { ReadPolicyEvaluationJobResponseSchema } from "./policy-evaluation-job-api.js";
import {
  PolicyEvaluationJobHistoryHeadSchema,
  PolicyEvaluationJobHistoryPageSchema,
} from "./policy-evaluation-job-history.js";
import {
  PolicyEvaluationSnapshotSchema,
  PolicyEvaluationSnapshotPageSchema,
  PolicyEvaluationSnapshotReferenceSchema,
} from "./policy-evaluation-snapshot.js";

export const MAX_POLICY_EVALUATION_HISTORY_HEAD_RESPONSE_BYTES = 4096;
export const EnqueuePolicyEvaluationJobResponseSchema =
  ReadPolicyEvaluationJobResponseSchema.extend({ created: z.boolean() }).strict();
export const ReadPolicyEvaluationSnapshotResponseSchema = z
  .object({
    snapshot: PolicyEvaluationSnapshotSchema,
    requestId: RequestIdSchema,
  })
  .strict();
export const ReadPolicyEvaluationSnapshotPageResponseSchema = z
  .object({
    snapshot: PolicyEvaluationSnapshotReferenceSchema,
    page: PolicyEvaluationSnapshotPageSchema,
    requestId: RequestIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.snapshot.snapshotId !== value.page.snapshotId)
      context.addIssue({
        code: "custom",
        message: "Page must belong to the exact snapshot",
        path: ["page", "snapshotId"],
      });
  });
export const ReadPolicyEvaluationJobHistoryHeadResponseSchema = z
  .object({
    head: PolicyEvaluationJobHistoryHeadSchema,
    requestId: RequestIdSchema,
  })
  .strict();
export const ReadPolicyEvaluationJobHistoryPageResponseSchema = z
  .object({
    page: PolicyEvaluationJobHistoryPageSchema,
    requestId: RequestIdSchema,
  })
  .strict();

export type EnqueuePolicyEvaluationJobResponse = z.infer<
  typeof EnqueuePolicyEvaluationJobResponseSchema
>;
export type ReadPolicyEvaluationSnapshotResponse = z.infer<
  typeof ReadPolicyEvaluationSnapshotResponseSchema
>;
export type ReadPolicyEvaluationSnapshotPageResponse = z.infer<
  typeof ReadPolicyEvaluationSnapshotPageResponseSchema
>;
export type ReadPolicyEvaluationJobHistoryHeadResponse = z.infer<
  typeof ReadPolicyEvaluationJobHistoryHeadResponseSchema
>;
export type ReadPolicyEvaluationJobHistoryPageResponse = z.infer<
  typeof ReadPolicyEvaluationJobHistoryPageResponseSchema
>;
