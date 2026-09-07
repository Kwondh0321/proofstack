import { z } from "zod";
import { RequestIdSchema } from "./api.js";
import { ReleasePolicyLifecycleEventSchema, ReleasePolicySchema } from "./release-policy.js";

/** UTF-8 JSON transport budgets, distinct from the policy's semantic collection limits. */
export const MAX_RELEASE_POLICY_REQUEST_BYTES = 1024 * 1024;
// Receipts add bounded scope, actor, exact lineage, digest, timestamp, and request identifiers.
// Reserve 4 KiB for those fields and compact JSON integer expansion; tests bound both costs.
export const MAX_RELEASE_POLICY_RESPONSE_BYTES = MAX_RELEASE_POLICY_REQUEST_BYTES + 4 * 1024;

export const PublishReleasePolicyResponseSchema = z
  .object({
    created: z.boolean(),
    policy: ReleasePolicySchema,
    requestId: RequestIdSchema,
  })
  .strict();

export const ReadReleasePolicyResponseSchema = z
  .object({
    policy: ReleasePolicySchema,
    requestId: RequestIdSchema,
  })
  .strict();

export const PublishReleasePolicyLifecycleResponseSchema = z
  .object({
    created: z.boolean(),
    event: ReleasePolicyLifecycleEventSchema,
    requestId: RequestIdSchema,
  })
  .strict();

export const ReadReleasePolicyLifecycleResponseSchema = z
  .object({
    event: ReleasePolicyLifecycleEventSchema,
    requestId: RequestIdSchema,
  })
  .strict();

export type PublishReleasePolicyResponse = z.infer<typeof PublishReleasePolicyResponseSchema>;
export type ReadReleasePolicyResponse = z.infer<typeof ReadReleasePolicyResponseSchema>;
export type PublishReleasePolicyLifecycleResponse = z.infer<
  typeof PublishReleasePolicyLifecycleResponseSchema
>;
export type ReadReleasePolicyLifecycleResponse = z.infer<
  typeof ReadReleasePolicyLifecycleResponseSchema
>;
