import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  PolicyEvaluationRuleResultSchema,
  ReleasePolicyRuleSchema,
  type PolicyEvaluationRuleResult,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  classifyReleaseRule,
  InvalidReleaseRuleObservationError,
  type ReleaseRuleClassificationInput,
} from "./classify-release-rule.js";

const policies = JSON.parse(
  readFileSync(
    new URL("../../../contracts/vectors/release-policy-definition-v1.json", import.meta.url),
    "utf8",
  ),
) as { vectors: { kind: string; input: { definition: { rules?: unknown[] } } }[] };
const policyRules = policies.vectors
  .find((vector) => vector.kind === "release_policy")
  ?.input.definition.rules?.map((rule) => ReleasePolicyRuleSchema.parse(rule));
if (!policyRules) throw new Error("Missing seven-predicate policy fixture");
const results = JSON.parse(
  readFileSync(
    new URL("../../../contracts/vectors/policy-evaluation-result-v1.json", import.meta.url),
    "utf8",
  ),
) as { definition: { rules: PolicyEvaluationRuleResult[] } };
type Input = ReleaseRuleClassificationInput;
const oracle = JSON.parse(
  readFileSync(new URL("./fixtures/release-rule-oracle-v1.json", import.meta.url), "utf8"),
) as {
  policyStates: Input["originalPolicyState"][];
  reviewStates: Input["normalApproval"][];
  applicability: Input["applicability"][];
  candidateAuthority: Input["candidateAuthority"][];
  nonWaivable: boolean[];
  vectors: {
    predicateKind: Input["result"]["predicateKind"];
    originalOutcome: Input["result"]["outcome"];
    cases: number;
    classificationCounts: Record<string, number>;
    sha256: string;
  }[];
};

function result(
  kind: Input["result"]["predicateKind"],
  outcome: Input["result"]["outcome"],
): PolicyEvaluationRuleResult {
  const template = results.definition.rules.find((rule) => rule.predicateKind === kind);
  if (!template) throw new Error("Missing predicate result fixture");
  const value = structuredClone(template);
  value.outcome = outcome;
  if (outcome === "indeterminate")
    value.evidence = {
      kind: "not_evaluated",
      reason: kind === "approval_required" ? "approval_not_evaluated" : "metric_missing",
    };
  else if (outcome === "not_applicable") value.evidence = { kind: "applicability_mismatch" };
  else {
    const pass = outcome === "satisfied";
    switch (value.evidence.kind) {
      case "exact_threshold":
        value.evidence.value = {
          representation: "rational",
          numerator: pass ? "-1" : "0",
          denominator: pass ? "3" : "1",
          unit: "basis_points",
        };
        value.evidence.order = pass ? -1 : 1;
        break;
      case "count_floor":
        value.evidence.observedCount = pass ? 3 : 2;
        value.evidence.order = pass ? 0 : -1;
        break;
      case "uncertainty_bound":
        value.evidence.value = pass ? "0.5" : "0.4";
        value.evidence.order = pass ? 0 : -1;
        break;
      case "eligibility":
        value.evidence.eligibility = pass ? "eligible" : "ineligible";
        break;
      case "artifact":
        value.evidence.status = pass ? "verified" : "component_missing";
        value.evidence.reference = pass
          ? {
              artifactId: "artifact_reference",
              sha256: "a".repeat(64),
              classification: "internal",
              mediaType: "application/json",
              sizeBytes: 1,
            }
          : null;
        break;
      case "safety_ceiling":
        value.evidence.observedCount = pass ? 0 : 1;
        value.evidence.order = pass ? 0 : 1;
        value.evidence.candidatePopulationComplete = true;
        break;
      default:
        throw new Error("Unexpected computed fixture kind");
    }
  }
  return PolicyEvaluationRuleResultSchema.parse(value);
}

function input(
  kind: Input["result"]["predicateKind"] = "approval_required",
  outcome: Input["result"]["outcome"] = "indeterminate",
): Input {
  const original = result(kind, outcome);
  const rule = policyRules?.find((rule) => rule.predicate.kind === kind);
  if (!rule) throw new Error("Missing policy predicate fixture");
  return {
    rule: { ...structuredClone(rule), ruleId: original.ruleId },
    result: original,
    applicability: "match",
    candidateAuthority: "qualified",
    originalPolicyState: "active",
    currentPolicyState: "active",
    normalApproval: "matched",
    ruleException: "matched",
  };
}

describe("internal release rule classification", () => {
  it.each(oracle.vectors)(
    "matches independent oracle $predicateKind/$originalOutcome",
    (vector) => {
      const value = input(vector.predicateKind, vector.originalOutcome);
      const digest = createHash("sha256");
      const counts: Record<string, number> = {};
      let cases = 0;
      for (const original of oracle.policyStates)
        for (const current of oracle.policyStates)
          for (const candidateAuthority of oracle.candidateAuthority)
            for (const applicability of oracle.applicability)
              for (const normal of oracle.reviewStates)
                for (const exception of oracle.reviewStates)
                  for (const nonWaivable of oracle.nonWaivable) {
                    const observed = classifyReleaseRule({
                      ...value,
                      rule: { ...value.rule, nonWaivable },
                      originalPolicyState: original,
                      currentPolicyState: current,
                      applicability,
                      candidateAuthority,
                      normalApproval: normal,
                      ruleException: exception,
                    });
                    digest.update(
                      `${cases}|${observed.status}|${observed.reason}|${observed.originalOutcome}\n`,
                    );
                    counts[observed.status] = (counts[observed.status] ?? 0) + 1;
                    cases += 1;
                  }
      expect(cases).toBe(vector.cases);
      expect(counts).toEqual(vector.classificationCounts);
      expect(digest.digest("hex")).toBe(vector.sha256);
    },
  );

  it("never resolves an approval-only incompatible/unknown or unauthorized policy by matched reviews", () => {
    const value = input();
    for (const applicability of ["mismatch", "unknown"] as const)
      expect(classifyReleaseRule({ ...value, applicability }).status).toBe("unresolved");
    for (const state of oracle.policyStates.filter((state) => state !== "active")) {
      expect(classifyReleaseRule({ ...value, originalPolicyState: state }).status).toBe(
        "unresolved",
      );
      expect(classifyReleaseRule({ ...value, currentPolicyState: state }).status).toBe(
        "unresolved",
      );
    }
  });

  it("requires separately qualified original candidate authority even for approval-only policies", () => {
    const value = input();
    for (const candidateAuthority of ["unqualified", "unavailable"] as const)
      expect(classifyReleaseRule({ ...value, candidateAuthority })).toMatchObject({
        status: "unresolved",
        reason: "candidate_authority_unverified",
      });
    expect(() =>
      classifyReleaseRule({ ...value, candidateAuthority: true } as unknown as Input),
    ).toThrow(InvalidReleaseRuleObservationError);
  });

  it("preserves original approval indeterminacy while resolving only the decision prerequisite", () => {
    const value = input();
    expect(classifyReleaseRule(value)).toEqual({
      status: "satisfied",
      originalOutcome: "indeterminate",
      reason: "normal_approval_applied",
    });
    expect(value.result.outcome).toBe("indeterminate");
    expect(classifyReleaseRule({ ...value, normalApproval: "unavailable" })).toMatchObject({
      status: "unresolved",
      reason: "normal_approval_unavailable",
    });
  });

  it("does not use normal approval to waive violations or exception claims to waive unknown evidence", () => {
    const violation = input("coverage_floor", "violated");
    expect(
      classifyReleaseRule({
        ...violation,
        rule: { ...violation.rule, nonWaivable: false },
        ruleException: "unavailable",
      }),
    ).toMatchObject({ status: "unresolved", reason: "exception_unavailable" });
    expect(
      classifyReleaseRule({ ...violation, rule: { ...violation.rule, nonWaivable: true } }),
    ).toMatchObject({ status: "non_waivable_violation" });
    const unknown = input("artifact_required", "indeterminate");
    expect(classifyReleaseRule(unknown)).toMatchObject({
      status: "unresolved",
      reason: "evidence_indeterminate",
    });
  });

  it("rejects truthy states, mismatched original identities/kinds and injected report authority", () => {
    const value = input();
    const invalid = [
      null,
      [],
      { ...value, currentPolicyState: true },
      { ...value, normalApproval: "true" },
      { ...value, ruleException: {} },
      { ...value, applicability: "safe" },
      { ...value, originalPolicyState: null },
      { ...value, authority: true },
      { ...value, rule: { ...value.rule, ruleId: "rule_other" } },
      { ...value, result: { ...value.result, predicateKind: "artifact_required" } },
    ];
    for (const item of invalid)
      expect(() => classifyReleaseRule(item as Input)).toThrow(InvalidReleaseRuleObservationError);
  });
});
