import {
  type BlindedEvaluationPlan,
  BlindedEvaluationPlanSchema,
  type IndependenceDeclaration,
  IndependenceDeclarationSchema,
  type IndependentCritique,
  IndependentCritiqueReferenceSchema,
  IndependentCritiqueSchema,
  UtcMillisecondTimestampSchema,
} from "@proofstack/contracts";
import { compareEvaluatorIndependence } from "./model-assurance-independence.js";

export type IndependentCritiqueIntegrityReason =
  | "criterion_mismatch"
  | "critique_correlated"
  | "critique_duplicate"
  | "critique_incomplete"
  | "critique_missing"
  | "critique_unexpected"
  | "critique_unverifiable"
  | "declaration_mismatch"
  | "opposing_finding"
  | "primary_declaration_missing"
  | "scope_mismatch"
  | "uncertain_finding";

export type IndependentCritiqueIntegrity =
  | { readonly critiqueIds: readonly string[]; readonly status: "satisfied" }
  | {
      readonly reasons: readonly IndependentCritiqueIntegrityReason[];
      readonly status: "unsatisfied";
    };

type CritiqueInput = "at" | "critique" | "declaration" | "expected" | "plan";

export class InvalidIndependentCritiqueIntegrityInputError extends Error {
  readonly code = "invalid_independent_critique_integrity_input";

  constructor(
    readonly input: CritiqueInput,
    options?: ErrorOptions,
  ) {
    super(`The independent-critique ${input} does not satisfy its bounded contract`, options);
    this.name = "InvalidIndependentCritiqueIntegrityInputError";
  }
}

function parsePlan(input: unknown): BlindedEvaluationPlan {
  const parsed = BlindedEvaluationPlanSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidIndependentCritiqueIntegrityInputError("plan", { cause: parsed.error });
  }
  return parsed.data;
}

function parseCritiques(inputs: readonly unknown[]): IndependentCritique[] {
  return inputs.map((input) => {
    const parsed = IndependentCritiqueSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidIndependentCritiqueIntegrityInputError("critique", { cause: parsed.error });
    }
    return parsed.data;
  });
}

function parseDeclarations(inputs: readonly unknown[]): IndependenceDeclaration[] {
  return inputs.map((input) => {
    const parsed = IndependenceDeclarationSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidIndependentCritiqueIntegrityInputError("declaration", {
        cause: parsed.error,
      });
    }
    return parsed.data;
  });
}

function parseExpected(inputs: readonly unknown[]) {
  return inputs.map((input) => {
    const parsed = IndependentCritiqueReferenceSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidIndependentCritiqueIntegrityInputError("expected", { cause: parsed.error });
    }
    return parsed.data;
  });
}

function parseAt(input: unknown): string {
  const parsed = UtcMillisecondTimestampSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidIndependentCritiqueIntegrityInputError("at", { cause: parsed.error });
  }
  return parsed.data;
}

function sameScope(
  left: BlindedEvaluationPlan | IndependenceDeclaration | IndependentCritique,
  right: BlindedEvaluationPlan | IndependenceDeclaration | IndependentCritique,
): boolean {
  return (
    left.scope.tenantId === right.scope.tenantId &&
    left.scope.projectId === right.scope.projectId &&
    left.scope.environmentId === right.scope.environmentId
  );
}

function profileKey(value: {
  readonly definitionSha256: string;
  readonly modelProfileId: string;
  readonly modelProfileVersionId: string;
}): string {
  return `${value.modelProfileId}:${value.modelProfileVersionId}:${value.definitionSha256}`;
}

function evaluatorKey(value: {
  readonly definitionSha256: string;
  readonly evaluatorId: string;
  readonly evaluatorVersionId: string;
}): string {
  return `${value.evaluatorId}:${value.evaluatorVersionId}:${value.definitionSha256}`;
}

function criterionKey(value: {
  readonly criterionId: string;
  readonly criterionSet: {
    readonly criterionSetId: string;
    readonly criterionSetVersionId: string;
    readonly definitionSha256: string;
  };
}): string {
  return `${value.criterionSet.criterionSetId}:${value.criterionSet.criterionSetVersionId}:${value.criterionId}:${value.criterionSet.definitionSha256}`;
}

/** Reconstructs independent critique coverage without accepting a caller-authored quorum flag. */
export function evaluateIndependentCritiqueIntegrity(
  planInput: unknown,
  expectedInputs: readonly unknown[],
  critiqueInputs: readonly unknown[],
  declarationInputs: readonly unknown[],
  atInput: unknown,
): IndependentCritiqueIntegrity {
  const plan = parsePlan(planInput);
  const expected = parseExpected(expectedInputs);
  const critiques = parseCritiques(critiqueInputs);
  const declarations = parseDeclarations(declarationInputs);
  const at = parseAt(atInput);
  const reasons = new Set<IndependentCritiqueIntegrityReason>();
  const expectedById = new Map(expected.map((reference) => [reference.critiqueId, reference]));
  const critiqueById = new Map(critiques.map((critique) => [critique.critiqueId, critique]));
  if (expectedById.size !== expected.length || critiqueById.size !== critiques.length) {
    reasons.add("critique_duplicate");
  }
  for (const reference of expected) {
    const critique = critiqueById.get(reference.critiqueId);
    if (!critique || critique.definitionSha256 !== reference.definitionSha256) {
      reasons.add("critique_missing");
    }
  }
  if (critiques.some(({ critiqueId }) => !expectedById.has(critiqueId))) {
    reasons.add("critique_unexpected");
  }

  const declarationById = new Map(
    declarations.map((declaration) => [declaration.independenceDeclarationId, declaration]),
  );
  if (declarationById.size !== declarations.length) {
    throw new InvalidIndependentCritiqueIntegrityInputError("declaration");
  }
  const primary = declarationById.get(plan.independenceDeclaration.independenceDeclarationId);
  const primaryValid =
    primary !== undefined &&
    primary.definitionSha256 === plan.independenceDeclaration.definitionSha256 &&
    sameScope(plan, primary);
  if (!primaryValid) {
    reasons.add("primary_declaration_missing");
  }
  const planCriteria = new Set(plan.criteria.map(criterionKey));
  for (const critique of critiques) {
    if (!sameScope(plan, critique)) reasons.add("scope_mismatch");
    if (!planCriteria.has(criterionKey(critique.criterion))) reasons.add("criterion_mismatch");
    if (
      Date.parse(critique.completedAt) > Date.parse(at) ||
      Date.parse(critique.recordedAt) > Date.parse(at)
    ) {
      reasons.add("critique_incomplete");
    }
    const declaration = declarationById.get(
      critique.independenceDeclaration.independenceDeclarationId,
    );
    if (
      !declaration ||
      declaration.definitionSha256 !== critique.independenceDeclaration.definitionSha256 ||
      evaluatorKey(declaration.subject.evaluator) !== evaluatorKey(critique.evaluator) ||
      profileKey(declaration.subject.modelProfile) !== profileKey(critique.modelProfile)
    ) {
      reasons.add("declaration_mismatch");
    } else if (primaryValid) {
      const comparison = compareEvaluatorIndependence(primary, declaration, at);
      if (comparison.status === "correlated") reasons.add("critique_correlated");
      if (comparison.status === "unverifiable") reasons.add("critique_unverifiable");
    }
    if (critique.outcome.status !== "produced") {
      reasons.add("critique_incomplete");
      continue;
    }
    if (critique.outcome.findings.some(({ impact }) => impact === "opposes")) {
      reasons.add("opposing_finding");
    }
    if (critique.outcome.findings.some(({ impact }) => impact === "uncertain")) {
      reasons.add("uncertain_finding");
    }
  }
  return reasons.size === 0
    ? { critiqueIds: [...critiqueById.keys()].sort(), status: "satisfied" }
    : { reasons: [...reasons].sort(), status: "unsatisfied" };
}
