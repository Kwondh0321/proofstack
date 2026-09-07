import { z } from "zod";
import { RequestIdSchema } from "./api.js";
import { PolicyEvaluationRequestSchema } from "./policy-evaluation-request.js";

/** Request-only UTF-8 budgets; snapshot, result, and history transports have separate contracts. */
export const MAX_POLICY_EVALUATION_REQUEST_BYTES = 4 * 1024;
// Reserve 4 KiB for exact scope, actor, digest, server receipt, escaped correlation ID, and integer
// expansion. Maximum valid semantic inputs and the complete read envelope are bounded in tests.
export const MAX_POLICY_EVALUATION_REQUEST_RESPONSE_BYTES =
  MAX_POLICY_EVALUATION_REQUEST_BYTES + 4 * 1024;

export const ReadPolicyEvaluationRequestResponseSchema = z
  .object({
    request: PolicyEvaluationRequestSchema,
    requestId: RequestIdSchema,
  })
  .strict();

export type ReadPolicyEvaluationRequestResponse = z.infer<
  typeof ReadPolicyEvaluationRequestResponseSchema
>;
