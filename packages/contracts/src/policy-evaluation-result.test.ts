import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MAX_POLICY_RULES } from "./release-policy.js";
import {
  MAX_POLICY_EVALUATION_RESULT_RESPONSE_BYTES,
  PolicyEvaluationDefinitionSchema,
  PolicyEvaluationResultReferenceSchema,
  PolicyEvaluationRuleResultSchema,
  PolicyEvaluationSchema,
  type PolicyEvaluationDefinition,
  type PolicyEvaluationRuleResult,
} from "./policy-evaluation-result.js";
import { encodePolicyEvaluationDefinition } from "./policy-evaluation-result-encoding.js";
import type { EvidenceScope } from "./evidence.js";
import { ReadPolicyEvaluationResponseSchema } from "./policy-evaluation-result-api.js";

const vector = JSON.parse(
  readFileSync(new URL("../vectors/policy-evaluation-result-v1.json", import.meta.url), "utf8"),
) as {
  definition: PolicyEvaluationDefinition;
  scope: EvidenceScope;
  canonicalUtf8: string;
  byteLength: number;
  sha256: string;
};
const definition = () => structuredClone(vector.definition);
const frame = (index: number) => structuredClone(vector.definition.rules[index]!);
function record() {
  return {
    ...definition(),
    scope: { ...vector.scope },
    definitionSha256: vector.sha256,
    schemaVersion: "0.1",
    recordedAt: "2026-10-13T18:00:01.123456Z",
    recordedByPrincipalId: "principal_result",
    jobId: "job_result",
    attemptId: "attempt_result",
    workerId: "worker_result",
    leaseId: "lease_result",
    fencingToken: 1,
    recoveryEpoch: 0,
  };
}
describe("strict ordered policy result contracts", () => {
  it("retains all seven predicate kinds and all four outcomes in an independent vector", () => {
    expect(PolicyEvaluationDefinitionSchema.parse(definition())).toEqual(definition());
    expect(PolicyEvaluationSchema.parse(record())).toEqual(record());
    expect(new Set(vector.definition.rules.map((rule) => rule.predicateKind)).size).toBe(7);
    expect(new Set(vector.definition.rules.map((rule) => rule.outcome)).size).toBe(4);
    const bytes = encodePolicyEvaluationDefinition({
      definition: definition(),
      scope: vector.scope,
    });
    expect(new TextDecoder().decode(bytes)).toBe(vector.canonicalUtf8);
    expect(bytes.byteLength).toBe(vector.byteLength);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(vector.sha256);
    expect(
      PolicyEvaluationResultReferenceSchema.parse({
        evaluationId: definition().evaluationId,
        definitionSha256: vector.sha256,
      }),
    ).toEqual({ evaluationId: definition().evaluationId, definitionSha256: vector.sha256 });
  });
  it.each(["approval", "decision", "signature", "credential", "deployment", "score", "workerId"])(
    "rejects unsupported semantic field %s",
    (field) => {
      expect(
        PolicyEvaluationDefinitionSchema.safeParse({ ...definition(), [field]: true }).success,
      ).toBe(false);
    },
  );
  it("separates execution receipts from semantic result identity", () => {
    expect(PolicyEvaluationDefinitionSchema.safeParse(record()).success).toBe(false);
    expect(PolicyEvaluationSchema.safeParse(definition()).success).toBe(false);
    const retry = {
      ...record(),
      workerId: "worker_retry",
      leaseId: "lease_retry",
      fencingToken: 2,
      recordedAt: "2026-10-13T18:00:02.999999Z",
    };
    expect(PolicyEvaluationSchema.parse(retry)).toEqual(retry);
    expect(retry.definitionSha256).toBe(record().definitionSha256);
    expect(
      PolicyEvaluationSchema.safeParse({ ...record(), recordedAt: "2026-10-13T18:00:00.123455Z" })
        .success,
    ).toBe(false);
  });
  it.each(["omitted", "duplicate", "reordered", "index", "ruleCount", "outcomeCounts"])(
    "rejects incomplete or contradictory rule inventory: %s",
    (change) => {
      const input = definition();
      if (change === "omitted") input.rules.pop();
      else if (change === "duplicate") input.rules[1] = structuredClone(input.rules[0]!);
      else if (change === "reordered") input.rules.reverse();
      else if (change === "index") input.rules[0]!.ruleIndex = 1;
      else if (change === "ruleCount") input.ruleCount++;
      else input.outcomeCounts.satisfied++;
      expect(PolicyEvaluationDefinitionSchema.safeParse(input).success).toBe(false);
    },
  );
  it("rejects over-limit rules before reading nested evidence", () => {
    const getter = vi.fn(() => {
      throw new Error("nested evidence must not be read");
    });
    const input = {
      ...definition(),
      rules: Array.from({ length: MAX_POLICY_RULES + 1 }, () => ({
        get evidence() {
          return getter();
        },
      })),
    };
    expect(PolicyEvaluationDefinitionSchema.safeParse(input).success).toBe(false);
    expect(PolicyEvaluationSchema.safeParse({ ...record(), rules: input.rules }).success).toBe(
      false,
    );
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(["satisfied", "violated", "not_applicable"])(
    "never fabricates approval: %s",
    (outcome) => {
      expect(PolicyEvaluationRuleResultSchema.safeParse({ ...frame(8), outcome }).success).toBe(
        false,
      );
    },
  );
  it("rejects approval computed operands and unresolved evidence used as a verdict", () => {
    expect(
      PolicyEvaluationRuleResultSchema.safeParse({
        ...frame(0),
        predicateKind: "approval_required",
      }).success,
    ).toBe(false);
    expect(
      PolicyEvaluationRuleResultSchema.safeParse({ ...frame(8), predicateKind: "coverage_floor" })
        .success,
    ).toBe(false);
    expect(
      PolicyEvaluationRuleResultSchema.safeParse({ ...frame(9), outcome: "satisfied" }).success,
    ).toBe(false);
    expect(
      PolicyEvaluationRuleResultSchema.safeParse({
        ...frame(8),
        evidence: { kind: "applicability_mismatch" },
        outcome: "not_applicable",
      }).success,
    ).toBe(false);
  });
  const comparatorMatches = {
    equal: [false, true, false],
    not_equal: [true, false, true],
    greater_than: [false, false, true],
    greater_than_or_equal: [false, true, true],
    less_than: [true, false, false],
    less_than_or_equal: [true, true, false],
  } as const;
  it.each(
    Object.entries(comparatorMatches).flatMap(([comparator, matches]) =>
      [-1, 0, 1].map((order, index) => ({ comparator, order, matches: matches[index] })),
    ),
  )(
    "preserves comparator/order truth table $comparator/$order",
    ({ comparator, order, matches }) => {
      const original = frame(0);
      const evidence = {
        ...original.evidence,
        comparator,
        order,
        value: { representation: "decimal", value: String(order), unit: "basis_points" },
        threshold: "0",
      };
      const outcome = matches ? "satisfied" : "violated";
      expect(
        PolicyEvaluationRuleResultSchema.safeParse({ ...original, evidence, outcome }).success,
      ).toBe(true);
      expect(
        PolicyEvaluationRuleResultSchema.safeParse({
          ...original,
          evidence,
          outcome: matches ? "violated" : "satisfied",
        }).success,
      ).toBe(false);
    },
  );
  it("retains partial safety excess and refuses a partial-population pass", () => {
    const original = frame(6);
    expect(PolicyEvaluationRuleResultSchema.parse(original)).toEqual(original);
    const partial = {
      ...original,
      outcome: "indeterminate",
      evidence: { ...original.evidence, observedCount: 0, order: 0 },
    };
    expect(PolicyEvaluationRuleResultSchema.safeParse(partial).success).toBe(true);
    expect(
      PolicyEvaluationRuleResultSchema.safeParse({ ...partial, outcome: "satisfied" }).success,
    ).toBe(false);
    expect(
      PolicyEvaluationRuleResultSchema.safeParse({ ...original, limitations: [] }).success,
    ).toBe(false);
  });
  it.each([
    { index: 0, change: { unit: "events" } },
    { index: 1, change: { observedCount: -1 } },
    { index: 2, change: { denominator: 0 } },
    { index: 2, change: { numerator: 4 } },
    { index: 2, change: { denominatorPopulation: "candidateTotalCount" } },
    { index: 3, change: { successCount: 11 } },
    { index: 3, change: { method: "alternate_interval" } },
    { index: 3, change: { confidenceLevelBasisPoints: 10_000 } },
    { index: 5, change: { status: "verified" } },
    { index: 0, change: { order: 0 } },
    { index: 1, change: { order: 1 } },
    { index: 2, change: { order: 0 } },
    { index: 3, change: { order: 1 } },
    { index: 6, change: { order: 0 } },
  ])("rejects unsafe operands at frame $index: $change", ({ index, change }) => {
    const original = frame(index);
    expect(
      PolicyEvaluationRuleResultSchema.safeParse({
        ...original,
        evidence: { ...original.evidence, ...change },
      }).success,
    ).toBe(false);
  });
  it.each(["predicate", "outcome", "limitations", "field"])(
    "rejects changed rule semantics: %s",
    (change) => {
      const original = frame(1);
      const input =
        change === "predicate"
          ? { ...original, predicateKind: "artifact_required" }
          : change === "outcome"
            ? { ...original, outcome: "not_applicable" }
            : change === "limitations"
              ? {
                  ...original,
                  limitations: ["historical_observation_only", "historical_observation_only"],
                }
              : { ...original, scopeOverride: vector.scope };
      expect(PolicyEvaluationRuleResultSchema.safeParse(input).success).toBe(false);
    },
  );
  it("keeps the largest permitted compact operands and server metadata below response headroom", () => {
    const long = "a".repeat(64);
    const maximum = record();
    maximum.ruleCount = MAX_POLICY_RULES;
    maximum.rules = Array.from(
      { length: MAX_POLICY_RULES },
      (_, ruleIndex) =>
        ({
          ...frame(0),
          ruleIndex,
          ruleId: `rule_${String(ruleIndex).padStart(3, "0")}_${"a".repeat(55)}`,
          evidence: {
            kind: "exact_threshold",
            operand: "delta",
            unit: "basis_points",
            comparator: "less_than",
            value: {
              representation: "rational",
              numerator: `-${"9".repeat(127)}`,
              denominator: "1",
              unit: "basis_points",
            },
            threshold: "999999999999999999.999999999999999999",
            order: -1,
          },
          limitations: [
            "approval_not_evaluated",
            "declared_reference_authority_only",
            "external_object_observation_only",
            "historical_observation_only",
            "incomplete_candidate_population",
          ],
        }) as PolicyEvaluationRuleResult,
    );
    maximum.outcomeCounts = {
      satisfied: MAX_POLICY_RULES,
      violated: 0,
      indeterminate: 0,
      not_applicable: 0,
    };
    maximum.scope = { tenantId: long, projectId: long, environmentId: long };
    const parsed = PolicyEvaluationSchema.parse(maximum);
    expect(
      ReadPolicyEvaluationResponseSchema.parse({
        evaluation: parsed,
        requestId: "\u0000".repeat(128),
      }),
    ).toEqual({ evaluation: parsed, requestId: "\u0000".repeat(128) });
    expect(
      Buffer.byteLength(
        JSON.stringify({ evaluation: parsed, requestId: "\u0000".repeat(128) }),
        "utf8",
      ),
    ).toBeLessThan(MAX_POLICY_EVALUATION_RESULT_RESPONSE_BYTES);
    expect(
      PolicyEvaluationSchema.safeParse({ ...maximum, rules: [...maximum.rules, frame(0)] }).success,
    ).toBe(false);
  });
  it("rejects forged response metadata and oversized correlation identifiers", () => {
    expect(
      ReadPolicyEvaluationResponseSchema.safeParse({
        evaluation: record(),
        requestId: "x".repeat(129),
      }).success,
    ).toBe(false);
    expect(
      ReadPolicyEvaluationResponseSchema.safeParse({
        evaluation: record(),
        requestId: "request_result",
        workerToken: "forged",
      }).success,
    ).toBe(false);
  });
  it("normalizes omitted optional artifact metadata without inventing redaction", () => {
    const input = definition();
    const rule = {
      ...frame(5),
      outcome: "satisfied",
      evidence: {
        kind: "artifact",
        status: "verified",
        reference: {
          artifactId: "artifact_result",
          classification: "metadata",
          mediaType: "application/json",
          sha256: "b".repeat(64),
          sizeBytes: 1,
          redactedAt: undefined,
        },
      },
    };
    expect(PolicyEvaluationRuleResultSchema.safeParse(rule).success).toBe(true);
    input.rules[5] = rule as PolicyEvaluationRuleResult;
    input.outcomeCounts.satisfied++;
    input.outcomeCounts.violated--;
    const omitted = structuredClone(input);
    const artifact = omitted.rules[5]!.evidence;
    if (artifact.kind !== "artifact" || artifact.reference === null)
      throw new Error("Missing artifact fixture");
    delete artifact.reference.redactedAt;
    expect(encodePolicyEvaluationDefinition({ definition: input, scope: vector.scope })).toEqual(
      encodePolicyEvaluationDefinition({ definition: omitted, scope: vector.scope }),
    );
  });
});
