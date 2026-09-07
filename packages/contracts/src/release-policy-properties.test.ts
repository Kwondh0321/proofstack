import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_POLICY_APPLICABILITY_VALUES,
  MAX_POLICY_APPROVAL_GROUPS,
  MAX_POLICY_APPROVAL_ROLES,
  MAX_POLICY_RULES,
  MAX_POLICY_SOURCES,
  MAX_POLICY_TEXT_VALUES,
  PolicyApprovalRequirementSchema,
  PolicyInstallationBindingDefinitionSchema,
  PolicyPopulationSelectorSchema,
  type ReleasePolicyApplicability,
  ReleasePolicyApplicabilitySchema,
  ReleasePolicyDefinitionSchema,
  ReleasePolicyExactDecimalSchema,
  type ReleasePolicyPredicate,
  ReleasePolicyPredicateSchema,
  ReleasePolicyUnitSchema,
} from "./release-policy.js";
import {
  encodePolicyInstallationBindingDefinition,
  encodeReleasePolicyDefinition,
  type ScopedPolicyInstallationBindingDefinition,
  type ScopedReleasePolicyDefinition,
} from "./release-policy-definition-encoding.js";

const document = JSON.parse(
  readFileSync(new URL("../vectors/release-policy-definition-v1.json", import.meta.url), "utf8"),
) as {
  readonly vectors: readonly [
    { readonly input: ScopedPolicyInstallationBindingDefinition; readonly sha256: string },
    { readonly input: ScopedReleasePolicyDefinition; readonly sha256: string },
  ];
};
const [bindingVector, policyVector] = document.vectors;

function definition() {
  return ReleasePolicyDefinitionSchema.parse(structuredClone(policyVector.input.definition));
}

function predicate<Kind extends ReleasePolicyPredicate["kind"]>(kind: Kind) {
  const value = definition().rules.find(({ predicate }) => predicate.kind === kind)?.predicate;
  if (!value || value.kind !== kind) throw new Error(`Missing ${kind} fixture`);
  return value as Extract<ReleasePolicyPredicate, { kind: Kind }>;
}

function labels(length: number, prefix: string): string[] {
  return Array.from({ length }, (_, index) => `${prefix}_${index.toString().padStart(3, "0")}`);
}

// Fixed seeds make every generated permutation reproducible; arrays retain semantic order.
function reorderedObjects(value: unknown, seed: number): unknown {
  let state = seed;
  function reorder(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(reorder);
    if (input === null || typeof input !== "object") return input;
    const entries = Object.entries(input);
    for (let index = entries.length - 1; index > 0; index -= 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const other = state % (index + 1);
      const left = entries[index];
      const right = entries[other];
      if (!left || !right) throw new Error("Invalid permutation index");
      entries[index] = right;
      entries[other] = left;
    }
    return Object.fromEntries(entries.map(([key, item]) => [key, reorder(item)]));
  }
  return reorder(value);
}

const selectorVariants = {
  jurisdiction: [
    { operator: "any" },
    { operator: "absent" },
    { operator: "equals", value: "us" },
    { operator: "one_of", values: ["gb", "us"] },
  ],
  locale: [
    { operator: "any" },
    { operator: "absent" },
    { operator: "equals", value: "en-us" },
    { operator: "one_of", values: ["en-us", "ko-kr"] },
  ],
  maximumDataClassification: [
    { operator: "any" },
    { operator: "equals", value: "internal" },
    { operator: "one_of", values: ["internal", "metadata"] },
  ],
  populationTags: [
    { operator: "any" },
    { operator: "contains_all", values: ["alpha", "beta"] },
    { operator: "exactly", values: [] },
  ],
  purpose: [
    { operator: "any" },
    { operator: "equals", value: "Review the agent." },
    { operator: "one_of", values: ["Analyze the agent.", "Review the agent."] },
  ],
  riskTier: [
    { operator: "any" },
    { operator: "equals", value: "low" },
    { operator: "one_of", values: ["high", "low"] },
  ],
  taskKind: [
    { operator: "any" },
    { operator: "equals", value: "agent_a" },
    { operator: "one_of", values: ["agent_a", "agent_b"] },
  ],
} satisfies {
  [Key in keyof ReleasePolicyApplicability]: readonly ReleasePolicyApplicability[Key][];
};

describe("generated release policy contract invariants", () => {
  it("keeps the reviewed collection limits fixed", () => {
    expect({
      applicability: MAX_POLICY_APPLICABILITY_VALUES,
      groups: MAX_POLICY_APPROVAL_GROUPS,
      roles: MAX_POLICY_APPROVAL_ROLES,
      rules: MAX_POLICY_RULES,
      sources: MAX_POLICY_SOURCES,
      text: MAX_POLICY_TEXT_VALUES,
    }).toEqual({ applicability: 64, groups: 32, roles: 32, rules: 128, sources: 64, text: 64 });
  });

  it("accepts only canonical exact decimals across sign, precision, and scale boundaries", () => {
    for (let whole = 0; whole <= 20; whole += 1) {
      for (let fraction = 0; fraction <= 20; fraction += 1) {
        for (const sign of ["", "-"]) {
          const value = `${sign}${whole === 0 ? "0" : "1".repeat(whole)}${fraction === 0 ? "" : `.${"2".repeat(fraction)}`}`;
          const valid =
            whole <= 18 && fraction <= 18 && !(sign === "-" && whole === 0 && fraction === 0);
          const result = ReleasePolicyExactDecimalSchema.safeParse(value);
          expect(result.success, value).toBe(valid);
          if (result.success) {
            expect(result.data).toBe(value);
            const trailingZero = fraction === 0 ? `${value}.0` : `${value}0`;
            expect(ReleasePolicyExactDecimalSchema.safeParse(trailingZero).success).toBe(false);
            expect(ReleasePolicyExactDecimalSchema.safeParse(`${value}e0`).success).toBe(false);
            expect(ReleasePolicyExactDecimalSchema.safeParse(Number(value)).success).toBe(false);
          }
        }
      }
    }
  });

  it("preserves every declarative comparator and operand at exact threshold boundaries", () => {
    const base = predicate("comparison_threshold");
    const comparators = [
      "equal",
      "greater_than",
      "greater_than_or_equal",
      "less_than",
      "less_than_or_equal",
      "not_equal",
    ];
    for (const comparator of [...comparators, "<", "<=", "approximately", "javascript"]) {
      for (const operand of ["baseline", "candidate", "delta"]) {
        for (const threshold of [
          "-999999999999999999.999999999999999999",
          "-0.000000000000000001",
          "0",
          "0.000000000000000001",
          "999999999999999999.999999999999999999",
        ]) {
          const input = { ...base, comparator, operand, threshold };
          const parsed = ReleasePolicyPredicateSchema.safeParse(input);
          expect(parsed.success).toBe(comparators.includes(comparator));
          if (parsed.success) expect(parsed.data).toEqual(input);
        }
      }
    }
  });

  it("rejects implicit unit conversions for every comparison metric kind", () => {
    const allowed: Readonly<Record<string, readonly string[]>> = {
      artifact_set: ["artifacts"],
      assurance_state_count: ["assurance_records"],
      coverage_count: ["cases"],
      evaluation_verdict_count: ["evaluation_outcomes"],
      replay_usage: [
        "attempts",
        "bytes",
        "calls",
        "interactions",
        "milliseconds",
        "provider_cost_microunits",
        "requests",
        "tokens",
      ],
      safety_event_count: ["events"],
      trace_event_count: ["events"],
    };
    const base = predicate("comparison_threshold");
    for (const [metricKind, units] of Object.entries(allowed)) {
      for (const unit of [...ReleasePolicyUnitSchema.options, "seconds", "dollars", "percent"]) {
        expect(ReleasePolicyPredicateSchema.safeParse({ ...base, metricKind, unit }).success).toBe(
          units.includes(unit),
        );
      }
    }
  });

  it("binds every coverage ratio to one population and an integer basis-point floor", () => {
    const base = predicate("coverage_floor");
    if (base.sourceKind !== "comparison_metric_ratio") throw new Error("Missing ratio fixture");
    for (const numeratorRole of ["baseline", "candidate", "paired"]) {
      for (const denominatorRole of ["baseline", "candidate", "paired"]) {
        for (const minimumBasisPoints of [-1, 0, 1, 2, 9_999, 10_000, 10_001, 0.5]) {
          const valid =
            numeratorRole === denominatorRole &&
            Number.isInteger(minimumBasisPoints) &&
            minimumBasisPoints >= 1 &&
            minimumBasisPoints <= 10_000;
          expect(
            ReleasePolicyPredicateSchema.safeParse({
              ...base,
              numerator: `${numeratorRole}_observed`,
              denominator: `${denominatorRole}_total`,
              minimumBasisPoints,
            }).success,
          ).toBe(valid);
        }
      }
    }
    for (const minimumCount of [
      -1,
      0,
      1,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
      0.5,
    ]) {
      for (const sampleClass of [
        "baseline_observed",
        "candidate_observed",
        "paired_observed",
        "paired_total",
      ]) {
        expect(
          ReleasePolicyPredicateSchema.safeParse({
            comparison: base.comparison,
            kind: "coverage_floor",
            metricId: base.metricId,
            minimumCount,
            sampleClass,
            sourceKind: "comparison_metric_samples",
            unit: "cases",
          }).success,
        ).toBe(Number.isSafeInteger(minimumCount) && minimumCount >= 0);
      }
    }
  });

  it("keeps integer counts and interval thresholds inside their declared inclusive bounds", () => {
    const ceiling = predicate("safety_event_ceiling");
    for (const value of [
      -1,
      0,
      1,
      Number.MAX_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(
        ReleasePolicyPredicateSchema.safeParse({ ...ceiling, maximumCount: value }).success,
      ).toBe(Number.isSafeInteger(value) && value >= 0);
    }
    const interval = predicate("uncertainty_bound");
    for (const bound of ["lower", "upper"]) {
      for (const comparator of ["at_least", "at_most"]) {
        for (const confidenceLevelBasisPoints of [
          4_999, 5_000, 5_001, 9_998, 9_999, 10_000, 5_000.5,
        ]) {
          for (const thresholdBasisPoints of [-1, 0, 1, 9_999, 10_000, 10_001, 0.5]) {
            const expected =
              Number.isInteger(confidenceLevelBasisPoints) &&
              confidenceLevelBasisPoints >= 5_000 &&
              confidenceLevelBasisPoints <= 9_999 &&
              Number.isInteger(thresholdBasisPoints) &&
              thresholdBasisPoints >= 0 &&
              thresholdBasisPoints <= 10_000;
            expect(
              ReleasePolicyPredicateSchema.safeParse({
                ...interval,
                bound,
                comparator,
                confidenceLevelBasisPoints,
                thresholdBasisPoints,
              }).success,
            ).toBe(expected);
          }
        }
      }
    }
  });

  it("accepts the complete Cartesian product of explicit finite selector variants", () => {
    const dimensions = Object.entries(selectorVariants);
    const total = dimensions.reduce((count, [, choices]) => count * choices.length, 1);
    expect(total).toBe(3_888);
    for (let sample = 0; sample < total; sample += 1) {
      let position = sample;
      const applicability = Object.fromEntries(
        dimensions.map(([name, choices]) => {
          const choice = choices[position % choices.length];
          position = Math.floor(position / choices.length);
          return [name, choice];
        }),
      );
      expect(ReleasePolicyApplicabilitySchema.parse(applicability)).toEqual(applicability);
    }
  });

  it("rejects omissions and nested executable structure at every applicability dimension", () => {
    const applicability = definition().applicability;
    for (const dimension of Object.keys(selectorVariants)) {
      const omitted = { ...applicability } as Record<string, unknown>;
      delete omitted[dimension];
      expect(ReleasePolicyApplicabilitySchema.safeParse(omitted).success).toBe(false);
      let nested: unknown = { operator: "any" };
      for (let depth = 1; depth <= 128; depth += 1) {
        nested = { operator: "and", children: [nested] };
        for (const selector of [
          nested,
          { operator: "any", expression: nested },
          { operator: "equals", value: nested },
        ]) {
          expect(
            ReleasePolicyApplicabilitySchema.safeParse({
              ...applicability,
              [dimension]: selector,
            }).success,
          ).toBe(false);
        }
      }
    }
  });

  // Keep each generated count independently timed and reported on shared, coverage-enabled CI.
  it.each(Array.from({ length: 130 }, (_, count) => count))(
    "requires unique canonical rule order for %i rules",
    (count) => {
      const base = definition();
      base.applicability.riskTier = { operator: "equals", value: "low" };
      const rule = base.rules.find(({ predicate }) => predicate.kind === "safety_event_ceiling");
      if (!rule) throw new Error("Missing safety rule");
      const rules = labels(count, "rule").map((ruleId) => ({ ...rule, ruleId }));
      expect(ReleasePolicyDefinitionSchema.safeParse({ ...base, rules }).success).toBe(
        count >= 1 && count <= 128,
      );
      if (count >= 2 && count <= 128) {
        expect(
          ReleasePolicyDefinitionSchema.safeParse({ ...base, rules: [...rules].reverse() }).success,
        ).toBe(false);
        expect(
          ReleasePolicyDefinitionSchema.safeParse({
            ...base,
            rules: [rules[0], ...rules.slice(0, -1)],
          }).success,
        ).toBe(false);
      }
    },
  );

  it.each(["assumptions", "exclusions", "knownLimitations"] as const)(
    "bounds and orders every %s collection",
    (field) => {
      const base = definition();
      for (let count = 0; count <= 65; count += 1) {
        const values = labels(count, "statement");
        expect(ReleasePolicyDefinitionSchema.safeParse({ ...base, [field]: values }).success).toBe(
          count <= 64,
        );
        if (count >= 2 && count <= 64) {
          expect(
            ReleasePolicyDefinitionSchema.safeParse({ ...base, [field]: [...values].reverse() })
              .success,
          ).toBe(false);
          expect(
            ReleasePolicyDefinitionSchema.safeParse({
              ...base,
              [field]: [values[0], ...values.slice(0, -1)],
            }).success,
          ).toBe(false);
        }
      }
    },
  );

  it("bounds scalar and population selectors without silently sorting or deduplicating", () => {
    for (let count = 0; count <= 65; count += 1) {
      const values = labels(count, "label");
      for (const operator of ["exactly", "contains_all"] as const) {
        expect(PolicyPopulationSelectorSchema.safeParse({ operator, values }).success).toBe(
          count <= 64 && (operator === "exactly" || count > 0),
        );
        if (count >= 2 && count <= 64) {
          expect(
            PolicyPopulationSelectorSchema.safeParse({ operator, values: [...values].reverse() })
              .success,
          ).toBe(false);
          expect(
            PolicyPopulationSelectorSchema.safeParse({
              operator,
              values: [values[0], ...values.slice(0, -1)],
            }).success,
          ).toBe(false);
        }
      }
      expect(
        ReleasePolicyApplicabilitySchema.safeParse({
          ...definition().applicability,
          taskKind: { operator: "one_of", values },
        }).success,
      ).toBe(count > 0 && count <= 64);
    }
  });

  it("bounds exact source and counterevidence collections while preserving rule references", () => {
    const base = definition();
    const source = base.sources[0];
    if (!source) throw new Error("Missing source fixture");
    for (let count = 0; count <= 65; count += 1) {
      const sources = labels(count, "source_generated").map((sourceSnapshotId) => ({
        ...source,
        source: { ...source.source, sourceSnapshotId },
      }));
      const first = sources[0];
      const rules = base.rules.map((rule) => ({ ...rule, sources: first ? [first] : [] }));
      expect(ReleasePolicyDefinitionSchema.safeParse({ ...base, rules, sources }).success).toBe(
        count > 0 && count <= 64,
      );
      expect(
        ReleasePolicyDefinitionSchema.safeParse({ ...base, counterevidence: sources }).success,
      ).toBe(count <= 64);
    }
  });

  it("bounds installation issuers, approval roles, groups, and quorum independently", () => {
    for (let count = 0; count <= 65; count += 1) {
      expect(
        PolicyInstallationBindingDefinitionSchema.safeParse({
          ...bindingVector.input.definition,
          authorizedIssuerPrincipalIds: labels(count, "principal"),
        }).success,
      ).toBe(count > 0 && count <= 64);
    }
    const approval = predicate("approval_required");
    for (let count = 0; count <= 33; count += 1) {
      const groups = labels(count, "group");
      const groupInput = {
        ...approval,
        humanReviewerGroupIds: [],
        independenceGroupIds: groups,
        quorum: 1,
      };
      expect(PolicyApprovalRequirementSchema.safeParse(groupInput).success).toBe(
        count > 0 && count <= 32,
      );
      expect(
        PolicyApprovalRequirementSchema.safeParse({
          ...approval,
          reviewerRoleIds: labels(count, "role"),
        }).success,
      ).toBe(count > 0 && count <= 32);
      for (const quorum of [0, 1, count, count + 1]) {
        expect(PolicyApprovalRequirementSchema.safeParse({ ...groupInput, quorum }).success).toBe(
          count > 0 && count <= 32 && quorum >= 1 && quorum <= count,
        );
      }
    }
  });

  it("preserves fixed policy and installation digests across nested insertion-order permutations", () => {
    for (let seed = 1; seed <= 128; seed += 1) {
      const policy = reorderedObjects(policyVector.input, seed) as ScopedReleasePolicyDefinition;
      const binding = reorderedObjects(
        bindingVector.input,
        seed,
      ) as ScopedPolicyInstallationBindingDefinition;
      expect(createHash("sha256").update(encodeReleasePolicyDefinition(policy)).digest("hex")).toBe(
        policyVector.sha256,
      );
      expect(
        createHash("sha256")
          .update(encodePolicyInstallationBindingDefinition(binding))
          .digest("hex"),
      ).toBe(bindingVector.sha256);
    }
  });
});
