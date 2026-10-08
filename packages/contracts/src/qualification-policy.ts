import { z } from "zod";
import { QualificationCaseKindSchema, QualificationReportSchema } from "./evaluation-spec.js";
import { EvidenceScopeSchema } from "./evidence.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";

export const QUALIFICATION_POLICY_SCHEMA_VERSION = "0.1" as const;
export const QUALIFICATION_POLICY_ALGORITHM_VERSION = "proofstack.qualification-cases.v1" as const;
export const QUALIFICATION_POLICY_CASE_KINDS = Object.freeze([
  ...QualificationCaseKindSchema.options,
]);

/** The existing exact report reference is retained without new required fields. */
export const QualificationPolicyReferenceSchema = QualificationReportSchema.shape.policy;

/** Explicit data for the existing fixed case requirements, not release or qualification authority. */
export const QualificationPolicyDefinitionSchema = z
  .object({
    algorithmVersion: z.literal(QUALIFICATION_POLICY_ALGORITHM_VERSION),
    caseMatching: z.literal("all_predeclared_cases"),
    policyId: OpaqueIdSchema,
    policyVersionId: OpaqueIdSchema,
    recordKind: z.literal("qualification_policy"),
    requiredCaseKinds: z
      .array(QualificationCaseKindSchema)
      .length(QUALIFICATION_POLICY_CASE_KINDS.length)
      .refine(
        (kinds) => kinds.every((kind, index) => kind === QUALIFICATION_POLICY_CASE_KINDS[index]),
        { message: "Qualification policy requires every case kind in canonical order" },
      ),
    unexpectedErrorLimit: z.literal(0),
  })
  .strict();

export const QualificationPolicyRecordSchema = QualificationPolicyDefinitionSchema.extend({
  definitionSha256: Sha256Schema,
  publishedAt: UtcMillisecondTimestampSchema,
  publishedByPrincipalId: OpaqueIdSchema,
  schemaVersion: z.literal(QUALIFICATION_POLICY_SCHEMA_VERSION),
  scope: EvidenceScopeSchema,
}).strict();

export type QualificationPolicyDefinition = z.infer<typeof QualificationPolicyDefinitionSchema>;
export type QualificationPolicyRecord = z.infer<typeof QualificationPolicyRecordSchema>;
export type QualificationPolicyReference = z.infer<typeof QualificationPolicyReferenceSchema>;
