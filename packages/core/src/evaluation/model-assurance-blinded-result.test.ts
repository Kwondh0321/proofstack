import { readFileSync } from "node:fs";
import type {
  BlindedEvaluationPlan,
  BlindedEvaluationPlanDefinition,
  BlindedEvaluationResult,
  BlindedEvaluationResultDefinition,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  evaluateBlindedResultIntegrity,
  InvalidBlindedResultIntegrityInputError,
} from "./model-assurance-blinded-result.js";

interface DefinitionVector<T> {
  readonly input: {
    readonly definition: T;
    readonly scope: BlindedEvaluationPlan["scope"];
  };
  readonly sha256: string;
}

function readVector<T>(name: string): DefinitionVector<T> {
  const document = JSON.parse(
    readFileSync(new URL(`../../../contracts/vectors/${name}`, import.meta.url), "utf8"),
  ) as { readonly vectors: readonly DefinitionVector<T>[] };
  const vector = document.vectors[0];
  if (!vector) throw new Error(`Expected vector ${name}`);
  return vector;
}

function plan(): BlindedEvaluationPlan {
  const vector = readVector<BlindedEvaluationPlanDefinition>(
    "evaluation-blinded-plan-definition-v1.json",
  );
  return {
    ...structuredClone(vector.input.definition),
    definitionSha256: vector.sha256,
    publishedAt: "2026-09-02T00:29:59.000Z",
    publishedByPrincipalId: "usr_blind_plan_publisher",
    schemaVersion: "0.1",
    scope: structuredClone(vector.input.scope),
  };
}

function result(): BlindedEvaluationResult {
  const vector = readVector<BlindedEvaluationResultDefinition>(
    "evaluation-blinded-result-definition-v1.json",
  );
  return {
    ...structuredClone(vector.input.definition),
    definitionSha256: vector.sha256,
    recordedAt: "2026-09-02T00:45:02.000Z",
    recordedByPrincipalId: "usr_blind_result_recorder",
    schemaVersion: "0.1",
    scope: structuredClone(vector.input.scope),
  };
}

function addStatusEvidence(value: BlindedEvaluationResult): void {
  value.disagreementEvidence = [structuredClone(value.orderComparison)];
}

describe("blinded result integrity", () => {
  it("reconstructs a complete same-seed order comparison", () => {
    expect(evaluateBlindedResultIntegrity(plan(), result())).toEqual({
      attemptIds: ["bat_01", "bat_02"],
      comparisonPairIds: ["bcp_01"],
      status: "consistent",
    });
  });

  it("derives order verdict variance instead of trusting the declared result", () => {
    const value = result();
    const second = value.attempts[1];
    if (second?.status !== "completed") throw new Error("Expected a completed attempt");
    second.verdict = "fail";
    value.disagreementReasons = ["order_verdict_variance"];
    addStatusEvidence(value);
    value.status = "disagreement";
    expect(evaluateBlindedResultIntegrity(plan(), value)).toEqual({
      reasons: ["order_verdict_variance"],
      status: "disagreement",
    });

    second.verdict = "pass";
    expect(evaluateBlindedResultIntegrity(plan(), value)).toEqual({
      reasons: ["status_declaration_mismatch"],
      status: "invalid",
    });
  });

  it("treats an exact failed attempt as invalid rather than averaging it away", () => {
    const value = result();
    value.attempts[1] = {
      attemptId: "bat_02",
      errorCode: "provider_unavailable",
      errorEvidence: [structuredClone(value.orderComparison)],
      presentationId: "prs_ba",
      seed: 11,
      status: "failed",
    };
    value.disagreementReasons = ["attempt_missing"];
    addStatusEvidence(value);
    value.status = "invalid";
    expect(evaluateBlindedResultIntegrity(plan(), value)).toEqual({
      reasons: ["attempt_failed"],
      status: "invalid",
    });
  });

  it("detects a missing attempt from a larger predeclared comparison set", () => {
    const expandedPlan = plan();
    expandedPlan.attempts = [
      ...expandedPlan.attempts,
      {
        attemptId: "bat_03",
        comparisonPairId: "bcp_02",
        presentationId: "prs_ab",
        seed: 22,
      },
      {
        attemptId: "bat_04",
        comparisonPairId: "bcp_02",
        presentationId: "prs_ba",
        seed: 22,
      },
    ];
    expandedPlan.attemptsPerOrder = 2;
    expandedPlan.definitionSha256 = "f".repeat(64);

    const incomplete = result();
    const first = incomplete.attempts[0];
    if (first?.status !== "completed") throw new Error("Expected a completed attempt");
    incomplete.attempts.push({
      ...structuredClone(first),
      attemptId: "bat_03",
      observation: { ...first.observation, observationId: "obs_second_pair" },
      seed: 22,
    });
    incomplete.plan.definitionSha256 = expandedPlan.definitionSha256;
    incomplete.disagreementReasons = ["attempt_missing"];
    addStatusEvidence(incomplete);
    incomplete.status = "invalid";
    expect(evaluateBlindedResultIntegrity(expandedPlan, incomplete)).toEqual({
      reasons: ["attempt_missing"],
      status: "invalid",
    });
  });

  it("rejects unexpected attempts and predeclared metadata drift", () => {
    const unexpected = result();
    const first = unexpected.attempts[0];
    if (first?.status !== "completed") throw new Error("Expected a completed attempt");
    unexpected.attempts.push({
      ...structuredClone(first),
      attemptId: "bat_03",
      observation: { ...first.observation, observationId: "obs_unexpected" },
    });
    unexpected.disagreementReasons = ["unexpected_attempt"];
    addStatusEvidence(unexpected);
    unexpected.status = "invalid";
    expect(evaluateBlindedResultIntegrity(plan(), unexpected)).toEqual({
      reasons: ["unexpected_attempt"],
      status: "invalid",
    });

    const drift = result();
    const second = drift.attempts[1];
    if (!second) throw new Error("Expected a second attempt");
    second.seed = 12;
    drift.disagreementReasons = ["attempt_missing"];
    addStatusEvidence(drift);
    drift.status = "invalid";
    expect(evaluateBlindedResultIntegrity(plan(), drift)).toEqual({
      reasons: ["attempt_metadata_mismatch", "status_declaration_mismatch"],
      status: "invalid",
    });
  });

  it("checks exact plan lineage, scope, publication, and execution validity", () => {
    const lineage = result();
    lineage.plan.definitionSha256 = "f".repeat(64);
    lineage.disagreementReasons = ["label_leakage"];
    addStatusEvidence(lineage);
    lineage.status = "invalid";
    expect(evaluateBlindedResultIntegrity(plan(), lineage)).toEqual({
      reasons: ["label_leakage", "plan_reference_mismatch"],
      status: "invalid",
    });

    const otherScope = result();
    otherScope.scope.environmentId = "env_other";
    otherScope.disagreementReasons = ["label_leakage"];
    addStatusEvidence(otherScope);
    otherScope.status = "invalid";
    expect(evaluateBlindedResultIntegrity(plan(), otherScope)).toEqual({
      reasons: ["label_leakage", "scope_mismatch"],
      status: "invalid",
    });

    const latePlan = plan();
    latePlan.publishedAt = "2026-09-02T00:40:01.000Z";
    const beforePublication = result();
    beforePublication.disagreementReasons = ["label_leakage"];
    addStatusEvidence(beforePublication);
    beforePublication.status = "invalid";
    expect(evaluateBlindedResultIntegrity(latePlan, beforePublication)).toEqual({
      reasons: ["label_leakage", "result_before_plan_publication"],
      status: "invalid",
    });

    const expiredPlan = plan();
    expiredPlan.validUntil = "2026-09-02T00:44:00.000Z";
    expect(evaluateBlindedResultIntegrity(expiredPlan, beforePublication)).toEqual({
      reasons: ["label_leakage", "plan_not_valid_for_execution"],
      status: "invalid",
    });

    const invalidPlan = plan();
    invalidPlan.planStatus = "invalid";
    invalidPlan.statusReasons = ["A post-publication leakage audit invalidated the plan"];
    const check = invalidPlan.leakageChecks[0];
    if (!check) throw new Error("Expected a leakage check");
    check.status = "failed";
    expect(evaluateBlindedResultIntegrity(invalidPlan, beforePublication)).toEqual({
      reasons: ["label_leakage", "plan_invalid"],
      status: "invalid",
    });
  });

  it("preserves evidence-backed rationale or leakage attestations as disagreement", () => {
    for (const reason of ["label_leakage", "order_rationale_variance"] as const) {
      const value = result();
      value.disagreementReasons = [reason];
      addStatusEvidence(value);
      value.status = "disagreement";
      expect(evaluateBlindedResultIntegrity(plan(), value)).toEqual({
        reasons: [reason],
        status: "disagreement",
      });
    }
  });

  it("rejects malformed inputs before evaluating them", () => {
    expect(() => evaluateBlindedResultIntegrity({}, result())).toThrow(
      InvalidBlindedResultIntegrityInputError,
    );
    expect(() => evaluateBlindedResultIntegrity(plan(), {})).toThrow(
      InvalidBlindedResultIntegrityInputError,
    );
  });
});
