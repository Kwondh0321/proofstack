import { z } from "zod";
import { RequestIdSchema } from "./api.js";
import { PolicyEvaluationSchema } from "./policy-evaluation-result.js";

/** Result-only response. Input pages and scheduler histories have independent bounds. */
export const ReadPolicyEvaluationResponseSchema = z
  .object({
    evaluation: PolicyEvaluationSchema,
    requestId: RequestIdSchema,
  })
  .strict();
export type ReadPolicyEvaluationResponse = z.infer<typeof ReadPolicyEvaluationResponseSchema>;
