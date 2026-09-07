import { z } from "zod";
import { RequestIdSchema } from "./api.js";
import {
  PolicyEvaluationManifestSchema,
  PolicyEvaluationManifestPageSchema,
  PolicyEvaluationManifestReferenceSchema,
} from "./policy-evaluation-manifest.js";

export const ReadPolicyEvaluationManifestResponseSchema = z
  .object({
    manifest: PolicyEvaluationManifestSchema,
    requestId: RequestIdSchema,
  })
  .strict();

export const ReadPolicyEvaluationManifestPageResponseSchema = z
  .object({
    manifest: PolicyEvaluationManifestReferenceSchema,
    page: PolicyEvaluationManifestPageSchema,
    requestId: RequestIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.manifest.manifestId !== value.page.manifestId)
      context.addIssue({
        code: "custom",
        message: "Page must belong to the exact manifest",
        path: ["page", "manifestId"],
      });
  });

export type ReadPolicyEvaluationManifestResponse = z.infer<
  typeof ReadPolicyEvaluationManifestResponseSchema
>;
export type ReadPolicyEvaluationManifestPageResponse = z.infer<
  typeof ReadPolicyEvaluationManifestPageResponseSchema
>;
