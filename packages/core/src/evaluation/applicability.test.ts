import {
  MAX_APPLICABILITY_DEPTH,
  MAX_APPLICABILITY_NODES,
  MAX_APPLICABILITY_OPERANDS,
  type ApplicabilityContext,
  type ApplicabilityExpression,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { evaluateApplicability, InvalidApplicabilityInputError } from "./applicability.js";

const fullContext: ApplicabilityContext = {
  environmentId: "env_prod",
  jurisdiction: "kr",
  locale: "ko-kr",
  populationTags: ["adult", "financial-services"],
  riskTier: "high",
  taskKind: "payment_authorization",
};

const expressions = {
  applicable: {
    field: "risk_tier",
    operator: "equals",
    value: "high",
  },
  notApplicable: {
    field: "risk_tier",
    operator: "equals",
    value: "low",
  },
  undetermined: {
    field: "jurisdiction",
    operator: "equals",
    value: "kr",
  },
} as const satisfies Record<string, ApplicabilityExpression>;

function evaluate(
  expression: ApplicabilityExpression,
  context: ApplicabilityContext = fullContext,
) {
  return evaluateApplicability(expression, context);
}

describe("evaluateApplicability", () => {
  it.each([
    [{ field: "environment_id", operator: "equals", value: "env_prod" }, "applicable"],
    [{ field: "jurisdiction", operator: "equals", value: "kr" }, "applicable"],
    [{ field: "locale", operator: "equals", value: "en-us" }, "not_applicable"],
    [{ field: "risk_tier", operator: "equals", value: "high" }, "applicable"],
    [{ field: "task_kind", operator: "equals", value: "payment_authorization" }, "applicable"],
    [{ field: "population_tags", operator: "contains", value: "financial-services" }, "applicable"],
    [{ field: "population_tags", operator: "contains", value: "minor" }, "not_applicable"],
  ] as const)("evaluates the allowlisted typed leaf %#", (expression, result) => {
    expect(evaluateApplicability(expression, fullContext)).toEqual({
      result,
      unresolvedFields: [],
    });
  });

  it.each([
    ["environment_id", { environmentId: undefined }],
    ["jurisdiction", { jurisdiction: undefined }],
    ["locale", { locale: undefined }],
    ["risk_tier", { riskTier: undefined }],
    ["task_kind", { taskKind: undefined }],
  ] as const)("propagates a missing %s fact as undetermined", (field, omission) => {
    const context = { ...fullContext, ...omission };
    const expression = {
      field,
      operator: "equals",
      value:
        field === "environment_id"
          ? "env_prod"
          : field === "jurisdiction"
            ? "kr"
            : field === "locale"
              ? "ko-kr"
              : field === "risk_tier"
                ? "high"
                : "payment_authorization",
    };

    expect(evaluateApplicability(expression, context)).toEqual({
      result: "undetermined",
      unresolvedFields: [field],
    });
  });

  it("implements the complete strong three-valued truth tables", () => {
    const values = ["applicable", "notApplicable", "undetermined"] as const;
    const contexts = {
      applicable: fullContext,
      notApplicable: fullContext,
      undetermined: { ...fullContext, jurisdiction: undefined },
    } satisfies Record<(typeof values)[number], ApplicabilityContext>;
    const expectedAll = [
      ["applicable", "not_applicable", "undetermined"],
      ["not_applicable", "not_applicable", "not_applicable"],
      ["undetermined", "not_applicable", "undetermined"],
    ] as const;
    const expectedAny = [
      ["applicable", "applicable", "applicable"],
      ["applicable", "not_applicable", "undetermined"],
      ["applicable", "undetermined", "undetermined"],
    ] as const;

    values.forEach((left, leftIndex) => {
      values.forEach((right, rightIndex) => {
        const context =
          left === "undetermined" || right === "undetermined" ? contexts.undetermined : fullContext;
        const leftExpression = expressions[left];
        const rightExpression = expressions[right];
        expect(
          evaluate({ operator: "allOf", operands: [leftExpression, rightExpression] }, context)
            .result,
        ).toBe(expectedAll[leftIndex]?.[rightIndex]);
        expect(
          evaluate({ operator: "anyOf", operands: [leftExpression, rightExpression] }, context)
            .result,
        ).toBe(expectedAny[leftIndex]?.[rightIndex]);
      });
    });
  });

  it("implements negation without turning unknown facts into true", () => {
    expect(evaluate({ operator: "not", operand: expressions.applicable }).result).toBe(
      "not_applicable",
    );
    expect(evaluate({ operator: "not", operand: expressions.notApplicable }).result).toBe(
      "applicable",
    );
    expect(
      evaluate(
        { operator: "not", operand: expressions.undetermined },
        { ...fullContext, jurisdiction: undefined },
      ),
    ).toEqual({ result: "undetermined", unresolvedFields: ["jurisdiction"] });
  });

  it("reports only unresolved facts that can still affect the final result", () => {
    const context = { ...fullContext, jurisdiction: undefined, locale: undefined };
    expect(
      evaluate(
        {
          operator: "allOf",
          operands: [expressions.notApplicable, expressions.undetermined],
        },
        context,
      ),
    ).toEqual({ result: "not_applicable", unresolvedFields: [] });
    expect(
      evaluate(
        {
          operator: "anyOf",
          operands: [expressions.applicable, expressions.undetermined],
        },
        context,
      ),
    ).toEqual({ result: "applicable", unresolvedFields: [] });
    expect(
      evaluate(
        {
          operator: "allOf",
          operands: [
            expressions.undetermined,
            { field: "locale", operator: "equals", value: "ko-kr" },
          ],
        },
        context,
      ),
    ).toEqual({
      result: "undetermined",
      unresolvedFields: ["jurisdiction", "locale"],
    });
  });

  it("is deterministic and permutation invariant for commutative operators", () => {
    const operands = [
      expressions.applicable,
      { field: "locale", operator: "equals", value: "ko-kr" } as const,
      {
        field: "population_tags",
        operator: "contains",
        value: "financial-services",
      } as const,
    ];
    const original = evaluate({ operator: "allOf", operands });

    for (let iteration = 0; iteration < 100; iteration += 1) {
      expect(evaluate({ operator: "allOf", operands: [...operands].reverse() })).toEqual(original);
      expect(evaluate({ operator: "allOf", operands })).toEqual(original);
    }
  });

  it.each([
    [{ operator: "execute", code: "process.exit(0)" }, "expression"],
    [
      {
        field: "locale",
        operator: "equals",
        value: "ko-kr",
        script: "fetch('https://example.invalid')",
      },
      "expression",
    ],
    [
      {
        ...fullContext,
        credential: "secret",
      },
      "context",
    ],
  ] as const)("rejects executable or unknown input %#", (input, kind) => {
    const call = () =>
      kind === "expression"
        ? evaluateApplicability(input, fullContext)
        : evaluateApplicability(expressions.applicable, input);
    expect(call).toThrow(InvalidApplicabilityInputError);
    try {
      call();
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_applicability_input", input: kind });
    }
  });

  it("rejects over-limit operand, depth, node, and cyclic graphs before interpretation", () => {
    const tooManyOperands = {
      operator: "allOf",
      operands: Array.from(
        { length: MAX_APPLICABILITY_OPERANDS + 1 },
        () => expressions.applicable,
      ),
    };
    let tooDeep: unknown = expressions.applicable;
    for (let depth = 0; depth <= MAX_APPLICABILITY_DEPTH; depth += 1) {
      tooDeep = { operator: "not", operand: tooDeep };
    }
    const maximumWidthGroup = {
      operator: "allOf",
      operands: Array.from({ length: MAX_APPLICABILITY_OPERANDS }, () => expressions.applicable),
    } as const;
    const tooManyNodes = {
      operator: "allOf",
      operands: Array.from({ length: MAX_APPLICABILITY_OPERANDS }, () => maximumWidthGroup),
    };
    const nodeLowerBound = 3 + MAX_APPLICABILITY_OPERANDS * (3 + MAX_APPLICABILITY_OPERANDS * 4);
    expect(nodeLowerBound).toBeGreaterThan(MAX_APPLICABILITY_NODES);
    const cyclic: { operand?: unknown; operator: "not" } = { operator: "not" };
    cyclic.operand = cyclic;

    for (const expression of [tooManyOperands, tooDeep, tooManyNodes, cyclic]) {
      expect(() => evaluateApplicability(expression, fullContext)).toThrow(
        InvalidApplicabilityInputError,
      );
    }
  });

  it("does not mutate the expression or context", () => {
    const expression: ApplicabilityExpression = {
      operator: "allOf",
      operands: [expressions.applicable, expressions.notApplicable],
    };
    const expressionBefore = structuredClone(expression);
    const contextBefore = structuredClone(fullContext);

    evaluate(expression, fullContext);

    expect(expression).toEqual(expressionBefore);
    expect(fullContext).toEqual(contextBefore);
  });
});
