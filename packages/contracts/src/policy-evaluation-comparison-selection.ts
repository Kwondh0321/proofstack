import { z } from "zod";
import {
  ComparisonDefinitionReferenceSchema,
  ComparisonEvidenceSnapshotReferenceSchema,
} from "./evaluation-comparison.js";
import { EvidenceScopeSchema } from "./evidence.js";
import { PolicyEvaluationRequestReferenceSchema } from "./policy-evaluation-request.js";
import { Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";
import {
  MAX_RELEASE_CANDIDATE_COMPARISONS,
  ReleaseCandidateComparisonReferenceSchema,
  ReleaseCandidateReferenceSchema,
} from "./release-candidate.js";
import { MAX_POLICY_RULES, ReleasePolicyReferenceSchema } from "./release-policy.js";

export const POLICY_EVALUATION_COMPARISON_SELECTION_SCHEMA_VERSION = "0.1" as const;

const UnavailableReasonSchema = z.enum([
  "record_invalid",
  "reference_mismatch",
  "not_yet_available",
]);

export const PolicyEvaluationCandidateComparisonMemberSchema = z
  .object({
    observation: z.discriminatedUnion("status", [
      z.object({ status: z.literal("missing") }).strict(),
      z.object({ reason: UnavailableReasonSchema, status: z.literal("unavailable") }).strict(),
      z
        .object({
          baselineSnapshot: ComparisonEvidenceSnapshotReferenceSchema,
          candidateSnapshot: ComparisonEvidenceSnapshotReferenceSchema,
          comparison: ComparisonDefinitionReferenceSchema,
          latestSourceCutoff: UtcMillisecondTimestampSchema,
          recordSha256: Sha256Schema,
          status: z.literal("verified"),
        })
        .strict()
        .superRefine((value, context) => {
          if (value.baselineSnapshot.role !== "baseline")
            context.addIssue({
              code: "custom",
              message: "Verified result baseline snapshot must have the baseline role",
              path: ["baselineSnapshot", "role"],
            });
          if (value.candidateSnapshot.role !== "candidate")
            context.addIssue({
              code: "custom",
              message: "Verified result candidate snapshot must have the candidate role",
              path: ["candidateSnapshot", "role"],
            });
        }),
    ]),
    reference: ReleaseCandidateComparisonReferenceSchema,
  })
  .strict();

const CandidateComparisonReferencesSchema = z
  .array(ReleaseCandidateComparisonReferenceSchema)
  .max(MAX_RELEASE_CANDIDATE_COMPARISONS)
  .refine(
    (values) =>
      values.every(
        (value, index) => index === 0 || (values[index - 1]?.resultId ?? "") < value.resultId,
      ),
    { message: "Comparison result references must be unique and ordered by resultId" },
  );

export const PolicyEvaluationComparisonResolutionSchema = z.discriminatedUnion("status", [
  z
    .object({
      comparison: ComparisonDefinitionReferenceSchema,
      result: ReleaseCandidateComparisonReferenceSchema,
      status: z.literal("unique"),
    })
    .strict(),
  z
    .object({
      comparison: ComparisonDefinitionReferenceSchema,
      status: z.literal("missing"),
    })
    .strict(),
  z
    .object({
      comparison: ComparisonDefinitionReferenceSchema,
      matches: CandidateComparisonReferencesSchema.min(2),
      status: z.literal("ambiguous"),
      unresolvedMembers: CandidateComparisonReferencesSchema,
    })
    .strict(),
  z
    .object({
      comparison: ComparisonDefinitionReferenceSchema,
      knownMatches: CandidateComparisonReferencesSchema.max(1),
      status: z.literal("unresolved"),
      unresolvedMembers: CandidateComparisonReferencesSchema.min(1),
    })
    .strict(),
]);

const inventoryShape = {
  candidate: ReleaseCandidateReferenceSchema,
  members: z
    .array(PolicyEvaluationCandidateComparisonMemberSchema)
    .min(1)
    .max(MAX_RELEASE_CANDIDATE_COMPARISONS),
  policy: ReleasePolicyReferenceSchema,
  policyComparisons: z.array(PolicyEvaluationComparisonResolutionSchema).max(MAX_POLICY_RULES),
  request: PolicyEvaluationRequestReferenceSchema,
  schemaVersion: z.literal(POLICY_EVALUATION_COMPARISON_SELECTION_SCHEMA_VERSION),
  scope: EvidenceScopeSchema,
};

function exactReference(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function refineInventory(
  value: z.infer<z.ZodObject<typeof inventoryShape>>,
  context: z.RefinementCtx,
): void {
  if (context.issues.length > 0) return;
  if (
    !value.members.every(
      (member, index) =>
        index === 0 ||
        (value.members[index - 1]?.reference.resultId ?? "") < member.reference.resultId,
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Candidate comparison members must be complete, unique and ordered by resultId",
      path: ["members"],
    });
  }
  if (
    !value.policyComparisons.every(
      (resolution, index) =>
        index === 0 ||
        (value.policyComparisons[index - 1]?.comparison.comparisonVersionId ?? "") <
          resolution.comparison.comparisonVersionId,
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Policy comparisons must be unique and ordered by repository identity",
      path: ["policyComparisons"],
    });
  }
  const unreadable = value.members
    .filter(({ observation }) => observation.status !== "verified")
    .map(({ reference }) => reference);
  for (const [index, resolution] of value.policyComparisons.entries()) {
    const matches = value.members
      .filter(
        (member) =>
          member.observation.status === "verified" &&
          exactReference(member.observation.comparison, resolution.comparison),
      )
      .map(({ reference }) => reference);
    let valid = false;
    if (matches.length >= 2)
      valid =
        resolution.status === "ambiguous" &&
        exactReference(resolution.matches, matches) &&
        exactReference(resolution.unresolvedMembers, unreadable);
    else if (unreadable.length > 0)
      valid =
        resolution.status === "unresolved" &&
        exactReference(resolution.knownMatches, matches) &&
        exactReference(resolution.unresolvedMembers, unreadable);
    else if (matches.length === 1)
      valid = resolution.status === "unique" && exactReference(resolution.result, matches[0]);
    else valid = resolution.status === "missing";
    if (!valid)
      context.addIssue({
        code: "custom",
        message:
          "Comparison resolution must account for every verified match and every unreadable candidate member",
        path: ["policyComparisons", index],
      });
  }
}

export const PolicyEvaluationComparisonInventorySchema = z
  .object(inventoryShape)
  .strict()
  .superRefine(refineInventory);

export type PolicyEvaluationCandidateComparisonMember = z.infer<
  typeof PolicyEvaluationCandidateComparisonMemberSchema
>;
export type PolicyEvaluationComparisonResolution = z.infer<
  typeof PolicyEvaluationComparisonResolutionSchema
>;
export type PolicyEvaluationComparisonInventory = z.infer<
  typeof PolicyEvaluationComparisonInventorySchema
>;
