import { readFileSync } from "node:fs";
import type {
  BlindedEvaluationPlan,
  BlindedEvaluationPlanDefinition,
  EvidenceScope,
  IndependenceDeclaration,
  IndependenceDeclarationDefinition,
  IndependentCritique,
  IndependentCritiqueDefinition,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  evaluateIndependentCritiqueIntegrity,
  InvalidIndependentCritiqueIntegrityInputError,
} from "./model-assurance-critique.js";

interface DefinitionVector<T> {
  readonly input: { readonly definition: T; readonly scope: EvidenceScope };
  readonly sha256: string;
}

function vector<T>(name: string): DefinitionVector<T> {
  const document = JSON.parse(
    readFileSync(new URL(`../../../contracts/vectors/${name}`, import.meta.url), "utf8"),
  ) as { readonly vectors: readonly DefinitionVector<T>[] };
  const value = document.vectors[0];
  if (!value) throw new Error(`Expected vector ${name}`);
  return value;
}

interface CritiqueFixture {
  readonly critique: IndependentCritique;
  readonly critic: IndependenceDeclaration;
  readonly plan: BlindedEvaluationPlan;
  readonly primary: IndependenceDeclaration;
}

function fixture(): CritiqueFixture {
  const planVector = vector<BlindedEvaluationPlanDefinition>(
    "evaluation-blinded-plan-definition-v1.json",
  );
  const critiqueVector = vector<IndependentCritiqueDefinition>(
    "evaluation-independent-critique-definition-v1.json",
  );
  const independenceVector = vector<IndependenceDeclarationDefinition>(
    "evaluation-independence-definition-v1.json",
  );
  const scope = structuredClone(planVector.input.scope);
  const plan: BlindedEvaluationPlan = {
    ...structuredClone(planVector.input.definition),
    definitionSha256: planVector.sha256,
    publishedAt: "2026-09-02T00:29:59.000Z",
    publishedByPrincipalId: "usr_blind_plan_publisher",
    schemaVersion: "0.1",
    scope: structuredClone(scope),
  };
  const critique: IndependentCritique = {
    ...structuredClone(critiqueVector.input.definition),
    definitionSha256: critiqueVector.sha256,
    recordedAt: "2026-09-02T01:01:01.000Z",
    recordedByPrincipalId: "usr_critique_recorder",
    schemaVersion: "0.1",
    scope: structuredClone(scope),
  };
  const primary: IndependenceDeclaration = {
    ...structuredClone(independenceVector.input.definition),
    definitionSha256: independenceVector.sha256,
    recordedAt: "2026-09-02T00:10:01.000Z",
    schemaVersion: "0.1",
    scope: structuredClone(scope),
  };
  primary.subject.evaluator = structuredClone(plan.evaluator);
  primary.subject.modelProfile = structuredClone(plan.modelProfile);
  plan.independenceDeclaration = {
    definitionSha256: primary.definitionSha256,
    independenceDeclarationId: primary.independenceDeclarationId,
  };

  const critic = structuredClone(primary);
  critic.independenceDeclarationId = "ind_critic_v1";
  critic.definitionSha256 = "f".repeat(64);
  critic.subject.evaluator = structuredClone(critique.evaluator);
  critic.subject.modelProfile = structuredClone(critique.modelProfile);
  for (const [dimension, lineage] of Object.entries(critic.dimensions)) {
    if (lineage.status !== "declared") throw new Error("Expected declared critic lineage");
    lineage.identifiers = [`critic:${dimension}`];
  }
  critique.independenceDeclaration = {
    definitionSha256: critic.definitionSha256,
    independenceDeclarationId: critic.independenceDeclarationId,
  };
  critique.calibrationReport = structuredClone(plan.calibrationReport);
  const criterion = plan.criteria[0];
  if (!criterion) throw new Error("Expected a blind-plan criterion");
  critique.criterion = structuredClone(criterion);
  if (critique.outcome.status !== "produced") throw new Error("Expected produced critique");
  for (const finding of critique.outcome.findings) finding.impact = "supports";
  return { critique, critic, plan, primary };
}

function expected(value: CritiqueFixture) {
  return [
    {
      critiqueId: value.critique.critiqueId,
      definitionSha256: value.critique.definitionSha256,
    },
  ];
}

function evaluate(value: CritiqueFixture, at = "2026-09-02T01:02:00.000Z") {
  return evaluateIndependentCritiqueIntegrity(
    value.plan,
    expected(value),
    [value.critique],
    [value.primary, value.critic],
    at,
  );
}

describe("independent critique integrity", () => {
  it("accepts complete critique coverage from a materially independent evaluator", () => {
    const value = fixture();
    expect(evaluate(value)).toEqual({
      critiqueIds: [value.critique.critiqueId],
      status: "satisfied",
    });
  });

  it("detects missing, unexpected, and duplicate critiques", () => {
    const value = fixture();
    expect(
      evaluateIndependentCritiqueIntegrity(
        value.plan,
        expected(value),
        [],
        [value.primary, value.critic],
        "2026-09-02T01:02:00.000Z",
      ),
    ).toEqual({ reasons: ["critique_missing"], status: "unsatisfied" });

    const unexpected = structuredClone(value.critique);
    unexpected.critiqueId = "crq_unexpected";
    unexpected.definitionSha256 = "e".repeat(64);
    expect(
      evaluateIndependentCritiqueIntegrity(
        value.plan,
        expected(value),
        [value.critique, unexpected],
        [value.primary, value.critic],
        "2026-09-02T01:02:00.000Z",
      ),
    ).toEqual({ reasons: ["critique_unexpected"], status: "unsatisfied" });

    expect(
      evaluateIndependentCritiqueIntegrity(
        value.plan,
        expected(value),
        [value.critique, value.critique],
        [value.primary, value.critic],
        "2026-09-02T01:02:00.000Z",
      ),
    ).toEqual({ reasons: ["critique_duplicate"], status: "unsatisfied" });
  });

  it("fails closed on correlated, unverifiable, or mismatched declaration lineage", () => {
    const correlated = fixture();
    correlated.critic.dimensions.providers = structuredClone(
      correlated.primary.dimensions.providers,
    );
    expect(evaluate(correlated)).toEqual({
      reasons: ["critique_correlated"],
      status: "unsatisfied",
    });

    const stale = fixture();
    stale.critic.validUntil = "2026-09-02T01:01:59.000Z";
    expect(evaluate(stale)).toEqual({
      reasons: ["critique_unverifiable"],
      status: "unsatisfied",
    });

    const mismatch = fixture();
    mismatch.critique.independenceDeclaration.definitionSha256 = "0".repeat(64);
    expect(evaluate(mismatch)).toEqual({
      reasons: ["declaration_mismatch"],
      status: "unsatisfied",
    });
  });

  it("preserves opposing and uncertain findings instead of averaging them away", () => {
    const value = fixture();
    if (value.critique.outcome.status !== "produced") throw new Error("Expected findings");
    const [first, second] = value.critique.outcome.findings;
    if (!first || !second) throw new Error("Expected two findings");
    first.impact = "opposes";
    second.impact = "uncertain";
    expect(evaluate(value)).toEqual({
      reasons: ["opposing_finding", "uncertain_finding"],
      status: "unsatisfied",
    });
  });

  it("does not count abstention as a completed independent critique", () => {
    const value = fixture();
    value.critique.outcome = {
      evidence: [structuredClone(value.critique.allowedEvidence[0] as never)],
      reasons: ["The evidence bundle is insufficient for an independent conclusion"],
      status: "abstained",
    };
    expect(evaluate(value)).toEqual({
      reasons: ["critique_incomplete"],
      status: "unsatisfied",
    });
  });

  it("checks plan scope, criterion, and completion time without requiring the primary calibration", () => {
    const scope = fixture();
    scope.critique.scope.environmentId = "env_other";
    expect(evaluate(scope)).toEqual({ reasons: ["scope_mismatch"], status: "unsatisfied" });

    const calibration = fixture();
    calibration.critique.calibrationReport.definitionSha256 = "0".repeat(64);
    expect(evaluate(calibration)).toEqual({
      critiqueIds: [calibration.critique.critiqueId],
      status: "satisfied",
    });

    const criterion = fixture();
    criterion.critique.criterion.criterionId = "crt_other";
    expect(evaluate(criterion)).toEqual({
      reasons: ["criterion_mismatch"],
      status: "unsatisfied",
    });

    const future = fixture();
    expect(evaluate(future, "2026-09-02T01:00:30.000Z")).toEqual({
      reasons: ["critique_incomplete"],
      status: "unsatisfied",
    });
  });

  it("rejects malformed inputs before evaluating", () => {
    const value = fixture();
    expect(() =>
      evaluateIndependentCritiqueIntegrity(
        {},
        expected(value),
        [value.critique],
        [value.primary, value.critic],
        "2026-09-02T01:02:00.000Z",
      ),
    ).toThrow(InvalidIndependentCritiqueIntegrityInputError);
    expect(() =>
      evaluateIndependentCritiqueIntegrity(
        value.plan,
        expected(value),
        [value.critique],
        [value.primary, value.critic],
        "later",
      ),
    ).toThrow(InvalidIndependentCritiqueIntegrityInputError);
  });
});
