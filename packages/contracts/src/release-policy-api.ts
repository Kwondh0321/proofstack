import { z } from "zod";
import { RequestIdSchema } from "./api.js";
import { ReleasePolicyLifecycleEventSchema, ReleasePolicySchema } from "./release-policy.js";

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
