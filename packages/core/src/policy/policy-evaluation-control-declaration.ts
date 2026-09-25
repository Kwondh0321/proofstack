import {
  type ComparisonDefinition,
  ComparisonDefinitionPredecessorSchema,
  type ComparisonEvidenceSnapshot,
  ComparisonSafetyEventSchema,
  OpaqueIdSchema,
  PolicyApprovalRequirementSchema,
  type ReleaseCandidate,
  ReleaseCandidateModelDeclarationSchema,
  ReleaseCandidateSourceSchema,
  type ReleasePolicy,
  ReleasePolicyPredicateSchema,
} from "@proofstack/contracts";

type Predicate = ReleasePolicy["rules"][number]["predicate"];
type Model = Extract<ReleaseCandidate["runtimeComponents"][number], { kind: "model" }>;
interface References {
  approval_requirement: Extract<Predicate, { kind: "approval_required" }>;
  artifact_identity: string;
  artifact_requirement: Extract<Predicate, { kind: "artifact_required" }>;
  candidate_source: ReleaseCandidate["source"];
  comparison_predecessor: NonNullable<ComparisonDefinition["predecessor"]>;
  model_declaration: Pick<Model, "providerId" | "providerModelId" | "resolution">;
  safety_event: ComparisonEvidenceSnapshot["fixtures"][number]["safetyEvents"][number];
}

// Positions are checked against the owning output type so union reordering cannot select a
// different predicate silently. These are declarations, never resolved evidence or authority.
const schemas = {
  approval_requirement: PolicyApprovalRequirementSchema,
  artifact_identity: OpaqueIdSchema,
  artifact_requirement: ReleasePolicyPredicateSchema.options[4],
  candidate_source: ReleaseCandidateSourceSchema,
  comparison_predecessor: ComparisonDefinitionPredecessorSchema,
  model_declaration: ReleaseCandidateModelDeclarationSchema,
  safety_event: ComparisonSafetyEventSchema,
} satisfies { [K in keyof References]: { parse(raw: unknown): References[K] } };

export type PolicyEvaluationControlDeclaration = {
  [K in keyof References]: { readonly kind: K; readonly reference: References[K] };
}[keyof References];

export function parsePolicyEvaluationControlDeclaration(
  declaration: PolicyEvaluationControlDeclaration,
): PolicyEvaluationControlDeclaration {
  if (
    !declaration ||
    Object.keys(declaration).some((key) => key !== "kind" && key !== "reference")
  ) {
    throw new TypeError("Invalid control evidence declaration");
  }
  const kind = declaration.kind;
  if (!Object.hasOwn(schemas, kind)) throw new TypeError("Invalid control evidence declaration");
  return {
    kind,
    reference: schemas[kind].parse(declaration.reference),
  } as PolicyEvaluationControlDeclaration;
}
