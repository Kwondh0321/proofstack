import {
  type BlindedEvaluationPlan,
  BlindedEvaluationPlanSchema,
  type BlindedEvaluationResult,
  BlindedEvaluationResultSchema,
} from "@proofstack/contracts";

export type BlindedResultIntegrityReason =
  | "attempt_failed"
  | "attempt_metadata_mismatch"
  | "attempt_missing"
  | "label_leakage"
  | "order_rationale_variance"
  | "order_verdict_variance"
  | "plan_invalid"
  | "plan_not_valid_for_execution"
  | "plan_reference_mismatch"
  | "result_before_plan_publication"
  | "scope_mismatch"
  | "status_declaration_mismatch"
  | "unexpected_attempt";

export type BlindedResultIntegrity =
  | {
      readonly attemptIds: readonly string[];
      readonly comparisonPairIds: readonly string[];
      readonly status: "consistent";
    }
  | {
      readonly reasons: readonly BlindedResultIntegrityReason[];
      readonly status: "disagreement" | "invalid";
    };

export class InvalidBlindedResultIntegrityInputError extends Error {
  readonly code = "invalid_blinded_result_integrity_input";

  constructor(
    readonly input: "plan" | "result",
    options?: ErrorOptions,
  ) {
    super(`The blinded-result integrity ${input} does not satisfy its bounded contract`, options);
    this.name = "InvalidBlindedResultIntegrityInputError";
  }
}

function parsePlan(input: unknown): BlindedEvaluationPlan {
  const parsed = BlindedEvaluationPlanSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidBlindedResultIntegrityInputError("plan", { cause: parsed.error });
  }
  return parsed.data;
}

function parseResult(input: unknown): BlindedEvaluationResult {
  const parsed = BlindedEvaluationResultSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidBlindedResultIntegrityInputError("result", { cause: parsed.error });
  }
  return parsed.data;
}

function sameScope(
  left: { readonly scope: BlindedEvaluationPlan["scope"] },
  right: { readonly scope: BlindedEvaluationResult["scope"] },
): boolean {
  return (
    left.scope.tenantId === right.scope.tenantId &&
    left.scope.projectId === right.scope.projectId &&
    left.scope.environmentId === right.scope.environmentId
  );
}

function exactPlanReferenceMatches(
  plan: BlindedEvaluationPlan,
  result: BlindedEvaluationResult,
): boolean {
  return (
    result.plan.blindedPlanId === plan.blindedPlanId &&
    result.plan.blindedPlanVersionId === plan.blindedPlanVersionId &&
    result.plan.definitionSha256 === plan.definitionSha256
  );
}

function executionWithinPlan(
  plan: BlindedEvaluationPlan,
  result: BlindedEvaluationResult,
): boolean {
  return (
    Date.parse(plan.validFrom) <= Date.parse(result.startedAt) &&
    Date.parse(result.completedAt) < Date.parse(plan.validUntil)
  );
}

function sorted<T extends string>(values: ReadonlySet<T>): T[] {
  return [...values].sort();
}

/**
 * Reconstructs blind execution integrity from exact plan and result records.
 * Rationale variance and leakage remain evidence-backed attestations because this pure layer never
 * opens artifact content; attempt membership, metadata, failures, and verdict reversals are derived.
 */
export function evaluateBlindedResultIntegrity(
  planInput: unknown,
  resultInput: unknown,
): BlindedResultIntegrity {
  const plan = parsePlan(planInput);
  const result = parseResult(resultInput);
  const invalid = new Set<BlindedResultIntegrityReason>();
  const disagreement = new Set<BlindedResultIntegrityReason>();

  if (!sameScope(plan, result)) invalid.add("scope_mismatch");
  if (!exactPlanReferenceMatches(plan, result)) invalid.add("plan_reference_mismatch");
  if (plan.planStatus !== "valid") invalid.add("plan_invalid");
  if (!executionWithinPlan(plan, result)) invalid.add("plan_not_valid_for_execution");
  if (Date.parse(result.startedAt) < Date.parse(plan.publishedAt)) {
    invalid.add("result_before_plan_publication");
  }

  const plannedById = new Map(plan.attempts.map((attempt) => [attempt.attemptId, attempt]));
  const resultById = new Map(result.attempts.map((attempt) => [attempt.attemptId, attempt]));
  for (const planned of plan.attempts) {
    const attempt = resultById.get(planned.attemptId);
    if (!attempt) {
      invalid.add("attempt_missing");
      continue;
    }
    if (attempt.presentationId !== planned.presentationId || attempt.seed !== planned.seed) {
      invalid.add("attempt_metadata_mismatch");
    }
    if (attempt.status === "failed") invalid.add("attempt_failed");
  }
  if (result.attempts.some(({ attemptId }) => !plannedById.has(attemptId))) {
    invalid.add("unexpected_attempt");
  }

  const plansByPair = new Map<string, typeof plan.attempts>();
  for (const attempt of plan.attempts) {
    const pair = plansByPair.get(attempt.comparisonPairId) ?? [];
    plansByPair.set(attempt.comparisonPairId, [...pair, attempt]);
  }
  for (const pair of plansByPair.values()) {
    const completed = pair
      .map(({ attemptId }) => resultById.get(attemptId))
      .filter((attempt) => attempt?.status === "completed");
    if (
      completed.length === pair.length &&
      new Set(completed.map(({ verdict }) => verdict)).size > 1
    ) {
      disagreement.add("order_verdict_variance");
    }
  }

  if (result.disagreementReasons.includes("label_leakage")) disagreement.add("label_leakage");
  if (result.disagreementReasons.includes("order_rationale_variance")) {
    disagreement.add("order_rationale_variance");
  }

  const directlyObserved = new Map([
    ["attempt_missing", invalid.has("attempt_missing") || invalid.has("attempt_failed")],
    ["order_verdict_variance", disagreement.has("order_verdict_variance")],
    ["unexpected_attempt", invalid.has("unexpected_attempt")],
  ] as const);
  for (const [reason, observed] of directlyObserved) {
    if (result.disagreementReasons.includes(reason) !== observed) {
      invalid.add("status_declaration_mismatch");
    }
  }

  const derivedStatus =
    invalid.size > 0 ? "invalid" : disagreement.size > 0 ? "disagreement" : "consistent";
  if (result.status !== derivedStatus) invalid.add("status_declaration_mismatch");
  if (invalid.size > 0) {
    return { reasons: sorted(new Set([...invalid, ...disagreement])), status: "invalid" };
  }
  if (disagreement.size > 0) {
    return { reasons: sorted(disagreement), status: "disagreement" };
  }
  return {
    attemptIds: plan.attempts.map(({ attemptId }) => attemptId),
    comparisonPairIds: [...plansByPair.keys()].sort(),
    status: "consistent",
  };
}
