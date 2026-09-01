import {
  type ApplicabilityContext,
  ApplicabilityContextSchema,
  type ApplicabilityExpression,
  ApplicabilityExpressionSchema,
  type ApplicabilityResult,
} from "@proofstack/contracts";

export type ApplicabilityContextField =
  | "environment_id"
  | "jurisdiction"
  | "locale"
  | "population_tags"
  | "risk_tier"
  | "task_kind";

export interface ApplicabilityEvaluation {
  readonly result: ApplicabilityResult;
  readonly unresolvedFields: readonly ApplicabilityContextField[];
}

export class InvalidApplicabilityInputError extends Error {
  readonly code = "invalid_applicability_input";

  constructor(
    readonly input: "context" | "expression",
    options?: ErrorOptions,
  ) {
    super(`The applicability ${input} does not satisfy its bounded contract`, options);
    this.name = "InvalidApplicabilityInputError";
  }
}

interface InternalEvaluation {
  readonly result: ApplicabilityResult;
  readonly unresolvedFields: ReadonlySet<ApplicabilityContextField>;
}

const noUnresolvedFields = new Set<ApplicabilityContextField>();

function decided(result: Exclude<ApplicabilityResult, "undetermined">): InternalEvaluation {
  return { result, unresolvedFields: noUnresolvedFields };
}

function undetermined(field: ApplicabilityContextField): InternalEvaluation {
  return { result: "undetermined", unresolvedFields: new Set([field]) };
}

function mergeUnresolvedFields(
  evaluations: readonly InternalEvaluation[],
): ReadonlySet<ApplicabilityContextField> {
  return new Set(evaluations.flatMap(({ unresolvedFields }) => [...unresolvedFields]));
}

function evaluateEquals(
  expression: Extract<ApplicabilityExpression, { readonly operator: "equals" }>,
  context: ApplicabilityContext,
): InternalEvaluation {
  switch (expression.field) {
    case "environment_id":
      return context.environmentId === undefined
        ? undetermined(expression.field)
        : decided(context.environmentId === expression.value ? "applicable" : "not_applicable");
    case "jurisdiction":
      return context.jurisdiction === undefined
        ? undetermined(expression.field)
        : decided(context.jurisdiction === expression.value ? "applicable" : "not_applicable");
    case "locale":
      return context.locale === undefined
        ? undetermined(expression.field)
        : decided(context.locale === expression.value ? "applicable" : "not_applicable");
    case "risk_tier":
      return context.riskTier === undefined
        ? undetermined(expression.field)
        : decided(context.riskTier === expression.value ? "applicable" : "not_applicable");
    case "task_kind":
      return context.taskKind === undefined
        ? undetermined(expression.field)
        : decided(context.taskKind === expression.value ? "applicable" : "not_applicable");
  }
}

function evaluateExpression(
  expression: ApplicabilityExpression,
  context: ApplicabilityContext,
): InternalEvaluation {
  if (expression.operator === "equals") return evaluateEquals(expression, context);
  if (expression.operator === "contains") {
    return decided(
      context.populationTags.includes(expression.value) ? "applicable" : "not_applicable",
    );
  }
  if (expression.operator === "not") {
    const operand = evaluateExpression(expression.operand, context);
    if (operand.result === "undetermined") return operand;
    return decided(operand.result === "applicable" ? "not_applicable" : "applicable");
  }

  const operands = expression.operands.map((operand) => evaluateExpression(operand, context));
  if (expression.operator === "allOf") {
    if (operands.some(({ result }) => result === "not_applicable")) {
      return decided("not_applicable");
    }
    const unresolvedFields = mergeUnresolvedFields(operands);
    return unresolvedFields.size > 0
      ? { result: "undetermined", unresolvedFields }
      : decided("applicable");
  }

  if (operands.some(({ result }) => result === "applicable")) return decided("applicable");
  const unresolvedFields = mergeUnresolvedFields(operands);
  return unresolvedFields.size > 0
    ? { result: "undetermined", unresolvedFields }
    : decided("not_applicable");
}

function parseExpression(input: unknown): ApplicabilityExpression {
  const parsed = ApplicabilityExpressionSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidApplicabilityInputError("expression", { cause: parsed.error });
  }
  return parsed.data;
}

function parseContext(input: unknown): ApplicabilityContext {
  const parsed = ApplicabilityContextSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidApplicabilityInputError("context", { cause: parsed.error });
  }
  return parsed.data;
}

/**
 * Evaluates a bounded, non-executable applicability expression using strong three-valued logic.
 * Invalid contracts are rejected; absent optional facts propagate as `undetermined`.
 */
export function evaluateApplicability(
  expression: unknown,
  context: unknown,
): ApplicabilityEvaluation {
  const evaluation = evaluateExpression(parseExpression(expression), parseContext(context));
  return {
    result: evaluation.result,
    unresolvedFields:
      evaluation.result === "undetermined" ? [...evaluation.unresolvedFields].sort() : [],
  };
}
