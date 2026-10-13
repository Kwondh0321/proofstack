import { z } from "zod";
import { serializeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { EvidenceScopeSchema } from "./evidence.js";
import { PolicyEvaluationLifecycleInputsSchema } from "./policy-evaluation-authority.js";
import { PolicyEvaluationSourceObservationSchema } from "./policy-evaluation-manifest.js";
import { PolicyEvaluationSourceReferenceSchema } from "./policy-evaluation-source-reference.js";
import { PolicyEvaluationTimeSchema } from "./policy-evaluation-time.js";
import { Sha256Schema } from "./primitives.js";
import { ReleaseCandidateTargetSchema } from "./release-candidate.js";
import { ReleasePolicyApplicabilitySchema } from "./release-policy.js";

const condition = {
  status: z.enum(["match", "mismatch", "unknown", "not_evaluated"]),
  reason: z.enum([
    "any",
    "optional_absent",
    "optional_present",
    "value_missing",
    "equal",
    "not_equal",
    "member",
    "not_member",
    "contains_all",
    "missing_population",
    "exact_set",
    "different_set",
    "authority_unverified",
  ]),
};
function dimension<K extends keyof typeof ReleasePolicyApplicabilitySchema.shape>(
  field: K,
  target: z.ZodTypeAny,
) {
  return z
    .object({
      field: z.literal(field),
      policyPath: z.literal(`/applicability/${field}`),
      candidatePath: z.literal(`/target/${field}`),
      selector: ReleasePolicyApplicabilitySchema.shape[field],
      targetValue: target.nullable(),
      ...condition,
    })
    .strict();
}
const Witness = z
  .object({ source: PolicyEvaluationSourceReferenceSchema, recordSha256: Sha256Schema })
  .strict();

/** Original applicability inputs and descriptive conjunction, not release or worker authority. */
export const PolicyEvaluationSnapshotApplicabilitySchema = z
  .object({
    scope: EvidenceScopeSchema,
    evaluationTime: PolicyEvaluationTimeSchema,
    authorityBoundary: z.literal("retained_prerequisites_only"),
    candidate: Witness.refine((value) => value.source.kind === "release_candidate"),
    policy: Witness.refine((value) => value.source.kind === "release_policy"),
    installationBinding: z
      .object({
        source: PolicyEvaluationSourceReferenceSchema.refine(
          (source) => source.kind === "policy_installation_binding",
        ),
        observation: PolicyEvaluationSourceObservationSchema,
      })
      .strict(),
    lifecycle: PolicyEvaluationLifecycleInputsSchema,
    dimensions: z.tuple([
      dimension("jurisdiction", ReleaseCandidateTargetSchema.shape.jurisdiction.unwrap()),
      dimension("locale", ReleaseCandidateTargetSchema.shape.locale.unwrap()),
      dimension(
        "maximumDataClassification",
        ReleaseCandidateTargetSchema.shape.maximumDataClassification,
      ),
      dimension("populationTags", ReleaseCandidateTargetSchema.shape.populationTags),
      dimension("purpose", ReleaseCandidateTargetSchema.shape.purpose),
      dimension("riskTier", ReleaseCandidateTargetSchema.shape.riskTier),
      dimension("taskKind", ReleaseCandidateTargetSchema.shape.taskKind),
    ]),
    conjunction: z.enum(["match", "mismatch", "unknown", "not_evaluated"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const same = (left: unknown, right: unknown) =>
      serializeEvaluationCanonicalJson(left) === serializeEvaluationCanonicalJson(right);
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    if (
      !same(value.lifecycle.scope, value.scope) ||
      value.lifecycle.evaluationTime !== value.evaluationTime ||
      !same(value.lifecycle.policy, value.policy.source.reference) ||
      value.lifecycle.policyRecordSha256 !== value.policy.recordSha256
    )
      issue("Applicability must retain its exact root policy, scope and lifecycle cut");
    const blocked = value.dimensions.some(({ status }) => status === "not_evaluated");
    if (
      blocked &&
      value.dimensions.some(
        ({ status, reason }) => status !== "not_evaluated" || reason !== "authority_unverified",
      )
    )
      issue("Unverified authority cannot hide individual applicability dimensions");
    const conjunction = blocked
      ? "not_evaluated"
      : value.dimensions.some(({ status }) => status === "mismatch")
        ? "mismatch"
        : value.dimensions.some(({ status }) => status === "unknown")
          ? "unknown"
          : "match";
    if (value.conjunction !== conjunction)
      issue("Applicability conjunction must preserve all seven original dimensions");
    if (value.lifecycle.state !== "no_terminal_event_at_evaluation" && !blocked)
      issue("Terminal policy authority cannot become a usable applicability match or mismatch");
  });

export type PolicyEvaluationSnapshotApplicability = z.infer<
  typeof PolicyEvaluationSnapshotApplicabilitySchema
>;
