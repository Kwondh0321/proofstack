import { z } from "zod";
import { RequestIdSchema } from "./api.js";
import { ReleaseCandidateSchema } from "./release-candidate.js";

export const PublishReleaseCandidateResponseSchema = z
  .object({
    candidate: ReleaseCandidateSchema,
    created: z.boolean(),
    requestId: RequestIdSchema,
  })
  .strict();

export const ReadReleaseCandidateResponseSchema = z
  .object({
    candidate: ReleaseCandidateSchema,
    requestId: RequestIdSchema,
  })
  .strict();

export type PublishReleaseCandidateResponse = z.infer<typeof PublishReleaseCandidateResponseSchema>;
export type ReadReleaseCandidateResponse = z.infer<typeof ReadReleaseCandidateResponseSchema>;
