import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PolicyInstallationBindingDefinitionSchema,
  PolicyInstallationBindingSchema,
  PublishReleasePolicyLifecycleRequestSchema,
  PublishReleasePolicyRequestSchema,
  ReleasePolicyDefinitionSchema,
  ReleasePolicyExactDecimalSchema,
  ReleasePolicyLifecycleEventSchema,
  ReleasePolicySchema,
} from "./release-policy.js";

interface RawVector {
  readonly input: { readonly definition: unknown; readonly scope: unknown };
  readonly kind: "policy_installation_binding" | "release_policy";
  readonly sha256: string;
}

const vectors = (
  JSON.parse(
    readFileSync(new URL("../vectors/release-policy-definition-v1.json", import.meta.url), "utf8"),
  ) as { readonly vectors: readonly RawVector[] }
).vectors;

function rawVector(kind: RawVector["kind"]): RawVector {
  const vector = vectors.find((candidate) => candidate.kind === kind);
  if (!vector) throw new Error(`Missing ${kind} vector`);
  return vector;
}

function validBindingDefinition() {
  return PolicyInstallationBindingDefinitionSchema.parse(
    structuredClone(rawVector("policy_installation_binding").input.definition),
  );
}

function validPolicyDefinition() {
  return ReleasePolicyDefinitionSchema.parse(
    structuredClone(rawVector("release_policy").input.definition),
  );
}

describe("release policy contracts", () => {
  it("accepts the finite declarative rule vocabulary and no other predicate", () => {
    const definition = validPolicyDefinition();
    expect(definition.rules.map(({ predicate }) => predicate.kind)).toEqual([
      "approval_required",
      "artifact_required",
      "comparison_threshold",
      "coverage_floor",
      "eligibility_required",
      "safety_event_ceiling",
      "uncertainty_bound",
    ]);

    const invalid = structuredClone(definition) as unknown as {
      rules: { predicate: Record<string, unknown> }[];
    };
    const firstRule = invalid.rules[0];
    if (!firstRule) throw new Error("Expected a policy rule");
    firstRule.predicate = {
      expression: "fetch('https://policy.example').then(execute)",
      kind: "javascript",
    };
    expect(ReleasePolicyDefinitionSchema.safeParse(invalid).success).toBe(false);
  });

  it("requires every explicit applicability dimension and rejects executable selectors", () => {
    const definition = validPolicyDefinition();
    for (const dimension of [
      "jurisdiction",
      "locale",
      "maximumDataClassification",
      "populationTags",
      "purpose",
      "riskTier",
      "taskKind",
    ] as const) {
      const invalid = structuredClone(definition) as unknown as {
        applicability: Record<string, unknown>;
      };
      delete invalid.applicability[dimension];
      expect(ReleasePolicyDefinitionSchema.safeParse(invalid).success).toBe(false);
    }

    const invalid = structuredClone(definition) as unknown as {
      applicability: Record<string, unknown>;
    };
    Object.assign(invalid.applicability, {
      customExpression: { operator: "regex", value: ".*" },
    });
    expect(ReleasePolicyDefinitionSchema.safeParse(invalid).success).toBe(false);
  });

  it("accepts explicit absent and empty-exact selectors without implicit defaults", () => {
    const definition = validPolicyDefinition();
    definition.applicability.jurisdiction = { operator: "absent" };
    definition.applicability.locale = { operator: "any" };
    definition.applicability.populationTags = { operator: "exactly", values: [] };
    definition.applicability.riskTier = { operator: "equals", value: "low" };
    definition.rules = definition.rules.filter(
      ({ predicate }) => predicate.kind !== "approval_required",
    );
    expect(ReleasePolicyDefinitionSchema.parse(definition).applicability).toEqual(
      definition.applicability,
    );
  });

  it("enforces normalized semantic versions, positive validity, and same-policy lineage", () => {
    for (const version of ["v1.0.0", "01.0.0", "1.0", "1.0.0+latest", "1.0.0-RC1"]) {
      const invalid = validPolicyDefinition();
      invalid.semanticVersion = version;
      expect(ReleasePolicyDefinitionSchema.safeParse(invalid).success).toBe(false);
    }

    const reversed = validPolicyDefinition();
    reversed.expiresAt = reversed.effectiveAt;
    expect(ReleasePolicyDefinitionSchema.safeParse(reversed).success).toBe(false);

    const wrongPredecessor = validPolicyDefinition();
    wrongPredecessor.predecessor = {
      definitionSha256: "9".repeat(64),
      policyId: "policy_other",
      policyVersionId: "policy_other_v1",
    };
    expect(ReleasePolicyDefinitionSchema.safeParse(wrongPredecessor).success).toBe(false);

    const selfPredecessor = validPolicyDefinition();
    selfPredecessor.predecessor = {
      definitionSha256: "9".repeat(64),
      policyId: selfPredecessor.policyId,
      policyVersionId: selfPredecessor.policyVersionId,
    };
    expect(ReleasePolicyDefinitionSchema.safeParse(selfPredecessor).success).toBe(false);
  });

  it("requires ordered rules and binds every rule source to the reviewed policy source set", () => {
    const unordered = validPolicyDefinition();
    unordered.rules = [...unordered.rules].reverse();
    expect(ReleasePolicyDefinitionSchema.safeParse(unordered).success).toBe(false);

    const unbound = validPolicyDefinition();
    const firstRule = unbound.rules[0];
    if (!firstRule) throw new Error("Expected a policy rule");
    firstRule.sources = [
      {
        review: {
          definitionSha256: "8".repeat(64),
          sourceReviewId: "review_unbound",
        },
        source: {
          definitionSha256: "7".repeat(64),
          sourceSnapshotId: "source_unbound",
        },
      },
    ];
    expect(ReleasePolicyDefinitionSchema.safeParse(unbound).success).toBe(false);

    const concealedConflict = validPolicyDefinition();
    concealedConflict.counterevidence = structuredClone(concealedConflict.sources);
    expect(ReleasePolicyDefinitionSchema.safeParse(concealedConflict).success).toBe(false);
  });

  it("rejects ambiguous units, floating thresholds, and incompatible coverage populations", () => {
    const incompatibleUnit = validPolicyDefinition();
    const thresholdRule = incompatibleUnit.rules.find(
      ({ predicate }) => predicate.kind === "comparison_threshold",
    );
    if (thresholdRule?.predicate.kind !== "comparison_threshold") {
      throw new Error("Expected a comparison threshold rule");
    }
    thresholdRule.predicate.unit = "tokens";
    expect(ReleasePolicyDefinitionSchema.safeParse(incompatibleUnit).success).toBe(false);

    const floatingThreshold = validPolicyDefinition() as unknown as {
      rules: { predicate: { kind?: unknown; threshold?: unknown } }[];
    };
    const floatingRule = floatingThreshold.rules.find(
      ({ predicate }) => predicate.kind === "comparison_threshold",
    );
    if (!floatingRule) throw new Error("Expected a comparison threshold rule");
    floatingRule.predicate.threshold = 0.5;
    expect(ReleasePolicyDefinitionSchema.safeParse(floatingThreshold).success).toBe(false);

    const incompatibleCoverage = validPolicyDefinition();
    const coverageRule = incompatibleCoverage.rules.find(
      ({ predicate }) => predicate.kind === "coverage_floor",
    );
    if (
      coverageRule?.predicate.kind !== "coverage_floor" ||
      coverageRule.predicate.sourceKind !== "comparison_metric_ratio"
    ) {
      throw new Error("Expected a comparison coverage rule");
    }
    coverageRule.predicate.denominator = "candidate_total";
    expect(ReleasePolicyDefinitionSchema.safeParse(incompatibleCoverage).success).toBe(false);
  });

  it("uses one exact decimal representation and a closed comparator set", () => {
    for (const accepted of ["-10", "-0.5", "0", "0.5", "10", "10.25"]) {
      expect(ReleasePolicyExactDecimalSchema.parse(accepted)).toBe(accepted);
    }
    for (const rejected of ["-0", "-0.0", "0.0", "00", "+1", "1.", "1.20", 1]) {
      expect(ReleasePolicyExactDecimalSchema.safeParse(rejected).success).toBe(false);
    }

    for (const comparator of [
      "equal",
      "greater_than",
      "greater_than_or_equal",
      "less_than",
      "less_than_or_equal",
      "not_equal",
    ] as const) {
      const definition = validPolicyDefinition();
      const rule = definition.rules.find(
        ({ predicate }) => predicate.kind === "comparison_threshold",
      );
      if (rule?.predicate.kind !== "comparison_threshold") {
        throw new Error("Expected a comparison threshold rule");
      }
      rule.predicate.comparator = comparator;
      expect(ReleasePolicyDefinitionSchema.safeParse(definition).success).toBe(true);
    }
  });

  it("requires bounded independent human approval whenever applicability reaches high risk", () => {
    const missingApproval = validPolicyDefinition();
    missingApproval.rules = missingApproval.rules.filter(
      ({ predicate }) => predicate.kind !== "approval_required",
    );
    expect(ReleasePolicyDefinitionSchema.safeParse(missingApproval).success).toBe(false);

    const noHumanGroup = validPolicyDefinition();
    const approvalRule = noHumanGroup.rules.find(
      ({ predicate }) => predicate.kind === "approval_required",
    );
    if (approvalRule?.predicate.kind !== "approval_required") {
      throw new Error("Expected an approval rule");
    }
    approvalRule.predicate.humanReviewerGroupIds = [];
    expect(ReleasePolicyDefinitionSchema.safeParse(noHumanGroup).success).toBe(false);

    const unboundHumanGroup = validPolicyDefinition();
    const unboundApproval = unboundHumanGroup.rules.find(
      ({ predicate }) => predicate.kind === "approval_required",
    );
    if (unboundApproval?.predicate.kind !== "approval_required") {
      throw new Error("Expected an approval rule");
    }
    unboundApproval.predicate.humanReviewerGroupIds = ["group_unbound"];
    expect(ReleasePolicyDefinitionSchema.safeParse(unboundHumanGroup).success).toBe(false);

    const excessiveQuorum = validPolicyDefinition();
    const excessiveApproval = excessiveQuorum.rules.find(
      ({ predicate }) => predicate.kind === "approval_required",
    );
    if (excessiveApproval?.predicate.kind !== "approval_required") {
      throw new Error("Expected an approval rule");
    }
    excessiveApproval.predicate.quorum = 3;
    expect(ReleasePolicyDefinitionSchema.safeParse(excessiveQuorum).success).toBe(false);

    const duplicateApproval = validPolicyDefinition();
    const existingApproval = duplicateApproval.rules.find(
      ({ predicate }) => predicate.kind === "approval_required",
    );
    if (!existingApproval) throw new Error("Expected an approval rule");
    duplicateApproval.rules = [
      existingApproval,
      { ...structuredClone(existingApproval), ruleId: "approval_gate_duplicate" },
      ...duplicateApproval.rules.filter(({ predicate }) => predicate.kind !== "approval_required"),
    ].sort((left, right) => left.ruleId.localeCompare(right.ruleId));
    expect(ReleasePolicyDefinitionSchema.safeParse(duplicateApproval).success).toBe(false);

    for (const riskTier of [
      { operator: "any" as const },
      { operator: "one_of" as const, values: ["high" as const, "moderate" as const] },
    ]) {
      const highRisk = validPolicyDefinition();
      highRisk.applicability.riskTier = riskTier;
      expect(ReleasePolicyDefinitionSchema.safeParse(highRisk).success).toBe(true);
    }
  });

  it("keeps public author requests free of server identity, time, outcomes, and credentials", () => {
    const definition = validPolicyDefinition();
    const {
      issuerPrincipalId: _issuerPrincipalId,
      policyId: _policyId,
      predecessor: _predecessor,
      ...shared
    } = definition;
    const request = PublishReleasePolicyRequestSchema.parse({
      ...shared,
      policyVersionId: definition.policyVersionId,
    });
    expect(request.policyVersionId).toBe(definition.policyVersionId);

    expect(
      PublishReleasePolicyRequestSchema.safeParse({
        ...request,
        predecessorVersionId: request.policyVersionId,
      }).success,
    ).toBe(false);

    for (const forbidden of [
      { approvedAt: "2026-09-07T00:00:00.000Z" },
      { decision: "proceed" },
      { issuerPrincipalId: definition.issuerPrincipalId },
      { policyId: definition.policyId },
      { publishedAt: "2026-09-07T00:00:00.000Z" },
      { secret: "credential" },
    ]) {
      expect(
        PublishReleasePolicyRequestSchema.safeParse({ ...request, ...forbidden }).success,
      ).toBe(false);
    }
  });

  it("separates operator installation authority from policy records", () => {
    const definition = validBindingDefinition();
    expect(definition.allowedModes).toEqual(["advisory", "mandatory"]);

    const binding = PolicyInstallationBindingSchema.parse({
      ...definition,
      definitionSha256: rawVector("policy_installation_binding").sha256,
      registeredAt: "2026-09-06T00:00:00.000Z",
      registeredByPrincipalId: "principal_operator",
      schemaVersion: "0.1",
    });
    expect(binding.scope.tenantId).toBe("tenant_example");

    expect(
      PolicyInstallationBindingDefinitionSchema.safeParse({
        ...definition,
        registryUrl: "https://mutable.example/policy.json",
      }).success,
    ).toBe(false);

    expect(
      PolicyInstallationBindingSchema.safeParse({
        ...binding,
        registeredAt: binding.expiresAt,
      }).success,
    ).toBe(false);

    const policy = validPolicyDefinition();
    expect(
      ReleasePolicySchema.safeParse({
        ...policy,
        definitionSha256: rawVector("release_policy").sha256,
        publishedAt: "2026-09-06T23:00:00.000Z",
        publishedByPrincipalId: "principal_other",
        schemaVersion: "0.1",
        scope: rawVector("release_policy").input.scope,
      }).success,
    ).toBe(false);

    expect(
      ReleasePolicySchema.safeParse({
        ...policy,
        definitionSha256: rawVector("release_policy").sha256,
        publishedAt: policy.expiresAt,
        publishedByPrincipalId: policy.issuerPrincipalId,
        schemaVersion: "0.1",
        scope: rawVector("release_policy").input.scope,
      }).success,
    ).toBe(false);
  });

  it("models withdrawal and supersession as strict append-only event inputs and records", () => {
    const policy = validPolicyDefinition();
    const exactPolicy = {
      definitionSha256: rawVector("release_policy").sha256,
      policyId: policy.policyId,
      policyVersionId: policy.policyVersionId,
    };
    const eventBase = {
      actorPrincipalId: policy.issuerPrincipalId,
      eventId: "policy_lifecycle_event_v1",
      occurredAt: "2026-10-01T00:00:00.000Z",
      policy: exactPolicy,
      reason: "The policy is replaced by a newly reviewed immutable version.",
      schemaVersion: "0.1" as const,
      scope: rawVector("release_policy").input.scope,
    };

    expect(ReleasePolicyLifecycleEventSchema.parse({ ...eventBase, kind: "withdrawn" }).kind).toBe(
      "withdrawn",
    );
    expect(
      PublishReleasePolicyLifecycleRequestSchema.parse({
        eventId: eventBase.eventId,
        kind: "superseded",
        reason: eventBase.reason,
        successorPolicyVersionId: "policy_checkout_staging_v2",
      }).kind,
    ).toBe("superseded");

    const successor = {
      definitionSha256: "9".repeat(64),
      policyId: exactPolicy.policyId,
      policyVersionId: "policy_checkout_staging_v2",
    };
    expect(
      ReleasePolicyLifecycleEventSchema.safeParse({
        ...eventBase,
        kind: "superseded",
        successor,
      }).success,
    ).toBe(true);
    expect(
      ReleasePolicyLifecycleEventSchema.safeParse({
        ...eventBase,
        kind: "superseded",
        successor: { ...successor, policyId: "policy_other" },
      }).success,
    ).toBe(false);
    expect(
      ReleasePolicyLifecycleEventSchema.safeParse({
        ...eventBase,
        kind: "superseded",
        successor: exactPolicy,
      }).success,
    ).toBe(false);

    expect(
      PublishReleasePolicyLifecycleRequestSchema.safeParse({
        actorPrincipalId: policy.issuerPrincipalId,
        eventId: eventBase.eventId,
        kind: "withdrawn",
        reason: eventBase.reason,
      }).success,
    ).toBe(false);
  });
});
