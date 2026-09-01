import {
  type IndependenceDeclaration,
  IndependenceDeclarationSchema,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";

export const MATERIAL_INDEPENDENCE_DIMENSIONS = [
  "baseModelFamilies",
  "criterionAuthors",
  "evaluatorDevelopers",
  "evaluatorImplementations",
  "fineTuneLineage",
  "labelSources",
  "operatingOrganizations",
  "promptAuthors",
  "providers",
  "sharedInfrastructure",
] as const;

export type MaterialIndependenceDimension = (typeof MATERIAL_INDEPENDENCE_DIMENSIONS)[number];
export type IndependenceUnverifiableReason =
  | "declaration_not_current"
  | "declaration_not_verified"
  | "scope_mismatch"
  | "unknown_material_lineage";

export type IndependenceComparison =
  | {
      readonly groupKeys: readonly [string, string];
      readonly status: "independent";
    }
  | {
      readonly sameSubject: boolean;
      readonly sharedDimensions: readonly MaterialIndependenceDimension[];
      readonly status: "correlated";
    }
  | {
      readonly reasons: readonly IndependenceUnverifiableReason[];
      readonly status: "unverifiable";
    };

export class InvalidIndependenceComparisonInputError extends Error {
  readonly code = "invalid_independence_comparison_input";

  constructor(
    readonly input: "at" | "left" | "right",
    options?: ErrorOptions,
  ) {
    super(`The independence comparison ${input} does not satisfy its bounded contract`, options);
    this.name = "InvalidIndependenceComparisonInputError";
  }
}

function parseDeclaration(input: unknown, side: "left" | "right"): IndependenceDeclaration {
  const parsed = IndependenceDeclarationSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidIndependenceComparisonInputError(side, { cause: parsed.error });
  }
  return parsed.data;
}

function parseAt(input: unknown): string {
  const parsed = UtcMillisecondTimestampSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidIndependenceComparisonInputError("at", { cause: parsed.error });
  }
  return parsed.data;
}

function subjectKey(declaration: IndependenceDeclaration): string {
  const { evaluator, modelProfile } = declaration.subject;
  return [
    evaluator.evaluatorId,
    evaluator.evaluatorVersionId,
    evaluator.definitionSha256,
    modelProfile.modelProfileId,
    modelProfile.modelProfileVersionId,
    modelProfile.definitionSha256,
  ].join(":");
}

function sameScope(left: IndependenceDeclaration, right: IndependenceDeclaration): boolean {
  return (
    left.scope.tenantId === right.scope.tenantId &&
    left.scope.projectId === right.scope.projectId &&
    left.scope.environmentId === right.scope.environmentId
  );
}

function currentAt(declaration: IndependenceDeclaration, at: string): boolean {
  const instant = Date.parse(at);
  return (
    Date.parse(declaration.validFrom) <= instant && instant < Date.parse(declaration.validUntil)
  );
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  const values = new Set(left);
  return right.some((value) => values.has(value));
}

/**
 * Compares two exact evaluator declarations without accepting a caller-authored independence flag.
 * Any unknown material lineage, stale declaration, scope mismatch, or unverified review fails closed.
 */
export function compareEvaluatorIndependence(
  leftInput: unknown,
  rightInput: unknown,
  atInput: unknown,
): IndependenceComparison {
  const left = parseDeclaration(leftInput, "left");
  const right = parseDeclaration(rightInput, "right");
  const at = parseAt(atInput);
  const reasons = new Set<IndependenceUnverifiableReason>();

  if (!sameScope(left, right)) reasons.add("scope_mismatch");
  if (left.reviewStatus !== "verified" || right.reviewStatus !== "verified") {
    reasons.add("declaration_not_verified");
  }
  if (!currentAt(left, at) || !currentAt(right, at)) reasons.add("declaration_not_current");
  if (
    MATERIAL_INDEPENDENCE_DIMENSIONS.some(
      (dimension) =>
        left.dimensions[dimension].status === "unknown" ||
        right.dimensions[dimension].status === "unknown",
    )
  ) {
    reasons.add("unknown_material_lineage");
  }
  if (reasons.size > 0) return { reasons: [...reasons].sort(), status: "unverifiable" };

  const leftKey = subjectKey(left);
  const rightKey = subjectKey(right);
  const sameSubject = leftKey === rightKey;
  const sharedDimensions = MATERIAL_INDEPENDENCE_DIMENSIONS.filter((dimension) => {
    const leftDimension = left.dimensions[dimension];
    const rightDimension = right.dimensions[dimension];
    return (
      leftDimension.status === "declared" &&
      rightDimension.status === "declared" &&
      intersects(leftDimension.identifiers, rightDimension.identifiers)
    );
  });
  if (sameSubject || sharedDimensions.length > 0) {
    return { sameSubject, sharedDimensions, status: "correlated" };
  }
  return {
    groupKeys: leftKey < rightKey ? [leftKey, rightKey] : [rightKey, leftKey],
    status: "independent",
  };
}
