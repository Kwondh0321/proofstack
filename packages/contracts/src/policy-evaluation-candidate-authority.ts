import { z } from "zod";
import { JsonPointerSchema } from "./artifact.js";
import { EvidenceScopeSchema } from "./evidence.js";
import { PolicyEvaluationSourceObservationSchema } from "./policy-evaluation-manifest.js";
import { MAX_POLICY_EVALUATION_ACQUISITION_RECORDS } from "./policy-evaluation-request.js";
import { PolicyEvaluationSourceReferenceSchema } from "./policy-evaluation-source-reference.js";
import {
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { OpaqueIdSchema, Sha256Schema } from "./primitives.js";
import {
  ReleaseCandidateAdapterReferenceSchema,
  ReleaseCandidateModelDeclarationSchema,
  ReleaseCandidateSourceSchema,
} from "./release-candidate.js";

const Candidate = PolicyEvaluationSourceReferenceSchema.refine(
  (source) => source.kind === "release_candidate",
);
const Index = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS - 1);
export const PolicyEvaluationCandidateAuthoritySubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source_revision"), source: ReleaseCandidateSourceSchema }).strict(),
  z
    .object({
      kind: z.literal("model_declaration"),
      ...ReleaseCandidateModelDeclarationSchema.shape,
      role: OpaqueIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("runtime_adapter"),
      adapter: ReleaseCandidateAdapterReferenceSchema,
      role: OpaqueIdSchema,
    })
    .strict(),
]);

const Observed = z
  .object({
    status: z.literal("observed"),
    scope: EvidenceScopeSchema,
    evaluationTime: PolicyEvaluationTimeSchema,
    startedAt: PolicyEvaluationTimeSchema,
    completedAt: PolicyEvaluationTimeSchema,
    occurrences: z
      .array(
        z
          .object({
            parent: Candidate,
            parentRecordSha256: Sha256Schema,
            path: JsonPointerSchema,
            edgeIndex: Index,
            subject: PolicyEvaluationCandidateAuthoritySubjectSchema,
            availability: z.enum(["available", "not_verified", "not_configured"]),
          })
          .strict(),
      )
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
    unavailableParents: z
      .array(
        z
          .object({
            source: Candidate,
            observation: z.union([
              PolicyEvaluationSourceObservationSchema.options[1],
              PolicyEvaluationSourceObservationSchema.options[2],
            ]),
          })
          .strict(),
      )
      .max(MAX_POLICY_EVALUATION_ACQUISITION_RECORDS),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    if (
      policyEvaluationTimestampOrderKey(value.startedAt) <
        policyEvaluationTimestampOrderKey(value.evaluationTime) ||
      policyEvaluationTimestampOrderKey(value.completedAt) <
        policyEvaluationTimestampOrderKey(value.startedAt)
    )
      context.addIssue({
        code: "custom",
        message: "Candidate authority receipts must preserve capture order and semantic cut",
      });
    const coordinates = new Set<number>();
    for (const occurrence of value.occurrences) {
      if (coordinates.has(occurrence.edgeIndex))
        context.addIssue({
          code: "custom",
          message: "Candidate authority occurrences must retain unique original graph coordinates",
        });
      coordinates.add(occurrence.edgeIndex);
    }
  });

/** Availability of declared operator-owned references, not loaded code or real-provider truth. */
export const PolicyEvaluationCandidateAuthorityInputsSchema = z.preprocess(
  (raw, context) => {
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      let count = 1;
      for (const key of ["occurrences", "unavailableParents"] as const) {
        const items: unknown = Reflect.get(raw, key);
        if (Array.isArray(items)) count += items.length;
      }
      if (count > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS) {
        context.addIssue({
          code: "custom",
          message: "Candidate authority occurrences exceed the fixed snapshot ceiling",
        });
        return z.NEVER;
      }
    }
    return raw;
  },
  z.union([z.object({ status: z.literal("not_configured") }).strict(), Observed]),
);

export type PolicyEvaluationCandidateAuthorityInputs = z.infer<
  typeof PolicyEvaluationCandidateAuthorityInputsSchema
>;
