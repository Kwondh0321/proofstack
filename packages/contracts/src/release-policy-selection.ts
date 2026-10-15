import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { encodeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { AssuranceRationaleSchema } from "./evaluation-source.js";
import { EvidenceScopeSchema } from "./evidence.js";
import {
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { OpaqueIdSchema, Sha256Schema } from "./primitives.js";
import { ReleaseCandidateTargetSchema } from "./release-candidate.js";
import {
  PolicyApprovalRequirementSchema,
  ReleasePolicyModeSchema,
  ReleasePolicyReferenceSchema,
} from "./release-policy.js";

export const RELEASE_POLICY_SELECTION_SCHEMA_VERSION = "0.1" as const;
export const MAX_RELEASE_POLICY_SELECTION_POLICIES = 16;
export const MAX_RELEASE_POLICY_SELECTION_PUBLISHERS = 32;
export const MAX_RELEASE_POLICY_SELECTION_DEFINITION_BYTES = 256 * 1024;
export const MAX_RELEASE_POLICY_SELECTION_RESPONSE_BYTES =
  MAX_RELEASE_POLICY_SELECTION_DEFINITION_BYTES + 4 * 1024;

function orderedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

/** A parseable reference is not current installation or decision authority. */
export const ReleasePolicySelectionReferenceSchema = z
  .object({
    selectionId: OpaqueIdSchema,
    selectionVersionId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
    installationId: OpaqueIdSchema,
    gateTargetId: OpaqueIdSchema,
  })
  .strict();

/** Exception authority is explicit even when a policy declares no normal approval rule. */
export const ReleasePolicyExceptionRequirementSchema = PolicyApprovalRequirementSchema.superRefine(
  (value, context) => {
    if (!value.excludeCandidateAuthor)
      context.addIssue({
        code: "custom",
        message: "Exceptions must exclude the candidate author",
        path: ["excludeCandidateAuthor"],
      });
    if (value.humanReviewerGroupIds.length === 0)
      context.addIssue({
        code: "custom",
        message: "Exceptions require an explicit independent human reviewer group",
        path: ["humanReviewerGroupIds"],
      });
  },
);

export const SelectedReleasePolicySchema = z
  .object({
    policy: ReleasePolicyReferenceSchema,
    mode: ReleasePolicyModeSchema,
    exceptionRequirement: ReleasePolicyExceptionRequirementSchema.optional(),
  })
  .strict();

const DefinitionShape = {
  selectionId: OpaqueIdSchema,
  selectionVersionId: OpaqueIdSchema,
  installationId: OpaqueIdSchema,
  gateTargetId: OpaqueIdSchema,
  scope: EvidenceScopeSchema,
  candidateTarget: ReleaseCandidateTargetSchema,
  mode: z.enum(["observation_only", "enforce"]),
  policies: z
    .array(SelectedReleasePolicySchema)
    .max(MAX_RELEASE_POLICY_SELECTION_POLICIES)
    .refine((values) => orderedUnique(values.map(({ policy }) => policy.policyId)), {
      message: "Selected policies must have distinct logical policy IDs in ascending order",
    }),
  authorizedPublisherPrincipalIds: z
    .array(OpaqueIdSchema)
    .min(1)
    .max(MAX_RELEASE_POLICY_SELECTION_PUBLISHERS)
    .refine(orderedUnique, "Decision publishers must be unique and ordered"),
  issuerPrincipalId: OpaqueIdSchema,
  authorityEvidence: ArtifactContentReferenceSchema,
  rationale: AssuranceRationaleSchema,
  effectiveAt: PolicyEvaluationTimeSchema,
  expiresAt: PolicyEvaluationTimeSchema,
  predecessor: ReleasePolicySelectionReferenceSchema.optional(),
};

type SelectionDefinition = z.infer<z.ZodObject<typeof DefinitionShape>>;

function checkDefinition(value: SelectionDefinition, context: z.RefinementCtx): void {
  if (context.issues.length > 0) return;
  const issue = (message: string, path: string) =>
    context.addIssue({ code: "custom", message, path: [path] });
  if (value.scope.environmentId !== value.candidateTarget.environmentId)
    issue("The candidate target must belong to the selection environment", "candidateTarget");
  if (
    policyEvaluationTimestampOrderKey(value.effectiveAt) >=
    policyEvaluationTimestampOrderKey(value.expiresAt)
  )
    issue("Selection validity must end after it begins", "expiresAt");
  const mandatory = value.policies.some(({ mode }) => mode === "mandatory");
  if ((value.mode === "enforce") !== mandatory)
    issue("Enforcement requires a mandatory policy; observation cannot downgrade one", "mode");
  const previous = value.predecessor;
  if (previous) {
    if (
      previous.selectionId !== value.selectionId ||
      previous.installationId !== value.installationId ||
      previous.gateTargetId !== value.gateTargetId
    )
      issue("A predecessor must retain the exact logical installation target", "predecessor");
    if (previous.selectionVersionId === value.selectionVersionId)
      issue("A selection version cannot be its own predecessor", "predecessor");
  }
  // Measure only the definition, not its bounded server receipt. Optional JS undefined fields
  // are absent from JSON; malformed scalar values have already been rejected by owning schemas.
  const definition = Object.fromEntries(
    Object.keys(DefinitionShape)
      .filter((key) => value[key as keyof SelectionDefinition] !== undefined)
      .map((key) => [key, value[key as keyof SelectionDefinition]]),
  );
  if (
    encodeEvaluationCanonicalJson(JSON.parse(JSON.stringify(definition))).byteLength >
    MAX_RELEASE_POLICY_SELECTION_DEFINITION_BYTES
  )
    issue("Selection definition exceeds its canonical UTF-8 byte ceiling", "policies");
}

/** Shape, inventory and byte admission only; owning readers must prove current complete authority. */
export const ReleasePolicySelectionDefinitionSchema = z
  .object(DefinitionShape)
  .strict()
  .superRefine(checkDefinition);

export const ReleasePolicySelectionSchema = z
  .object({
    ...DefinitionShape,
    definitionSha256: Sha256Schema,
    schemaVersion: z.literal(RELEASE_POLICY_SELECTION_SCHEMA_VERSION),
    publishedAt: PolicyEvaluationTimeSchema,
    publishedByPrincipalId: OpaqueIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    checkDefinition(value, context);
    if (context.issues.length > 0) return;
    if (value.publishedByPrincipalId !== value.issuerPrincipalId)
      context.addIssue({ code: "custom", message: "Selection publisher must match its issuer" });
    if (
      policyEvaluationTimestampOrderKey(value.publishedAt) >=
      policyEvaluationTimestampOrderKey(value.expiresAt)
    )
      context.addIssue({ code: "custom", message: "An expired selection cannot be published" });
  });

const LifecycleShape = {
  eventId: OpaqueIdSchema,
  selection: ReleasePolicySelectionReferenceSchema,
  scope: EvidenceScopeSchema,
  reason: AssuranceRationaleSchema,
  actorPrincipalId: OpaqueIdSchema,
  occurredAt: PolicyEvaluationTimeSchema,
  schemaVersion: z.literal(RELEASE_POLICY_SELECTION_SCHEMA_VERSION),
};

export const ReleasePolicySelectionLifecycleEventSchema = z
  .discriminatedUnion("kind", [
    z.object({ ...LifecycleShape, kind: z.literal("withdrawn") }).strict(),
    z
      .object({
        ...LifecycleShape,
        kind: z.literal("superseded"),
        successor: ReleasePolicySelectionReferenceSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.kind !== "superseded") return;
    if (
      value.successor.selectionId !== value.selection.selectionId ||
      value.successor.installationId !== value.selection.installationId ||
      value.successor.gateTargetId !== value.selection.gateTargetId ||
      value.successor.selectionVersionId === value.selection.selectionVersionId
    )
      context.addIssue({
        code: "custom",
        message: "Supersession must name a different version of the exact installation target",
      });
  });

export type ReleasePolicySelectionDefinition = z.infer<
  typeof ReleasePolicySelectionDefinitionSchema
>;
export type ReleasePolicySelection = z.infer<typeof ReleasePolicySelectionSchema>;
export type ReleasePolicySelectionReference = z.infer<typeof ReleasePolicySelectionReferenceSchema>;
export type ReleasePolicySelectionLifecycleEvent = z.infer<
  typeof ReleasePolicySelectionLifecycleEventSchema
>;
export type SelectedReleasePolicy = z.infer<typeof SelectedReleasePolicySchema>;
