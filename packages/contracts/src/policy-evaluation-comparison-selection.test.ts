import { describe, expect, it } from "vitest";
import {
  type PolicyEvaluationCandidateComparisonMember,
  PolicyEvaluationCandidateComparisonMemberSchema,
  type PolicyEvaluationComparisonInventory,
  PolicyEvaluationComparisonInventorySchema,
} from "./policy-evaluation-comparison-selection.js";

const digest = (character: string) => character.repeat(64);
const scope = {
  environmentId: "environment_selection",
  projectId: "project_selection",
  tenantId: "tenant_selection",
};

function comparison(suffix: string) {
  return {
    comparisonId: `comparison_${suffix}`,
    comparisonVersionId: `comparison_version_${suffix}`,
    definitionSha256: digest(suffix),
  };
}

function reference(suffix: string) {
  return { definitionSha256: digest(suffix), resultId: `result_${suffix}` };
}

function verifiedMember(
  memberSuffix: string,
  comparisonSuffix: string,
): PolicyEvaluationCandidateComparisonMember {
  return {
    observation: {
      baselineSnapshot: {
        definitionSha256: digest("1"),
        role: "baseline",
        snapshotId: `snapshot_${memberSuffix}_baseline`,
      },
      candidateSnapshot: {
        definitionSha256: digest("2"),
        role: "candidate",
        snapshotId: `snapshot_${memberSuffix}_candidate`,
      },
      comparison: comparison(comparisonSuffix),
      latestSourceCutoff: "2026-09-07T12:00:00.000Z",
      recordSha256: digest("3"),
      status: "verified",
    },
    reference: reference(memberSuffix),
  };
}

function inventory(
  members: PolicyEvaluationCandidateComparisonMember[],
  policyComparisons: PolicyEvaluationComparisonInventory["policyComparisons"],
): PolicyEvaluationComparisonInventory {
  return {
    candidate: {
      candidateId: "candidate_selection",
      candidateVersionId: "candidate_version_selection",
      definitionSha256: digest("4"),
    },
    members,
    policy: {
      definitionSha256: digest("5"),
      policyId: "policy_selection",
      policyVersionId: "policy_version_selection",
    },
    policyComparisons,
    request: {
      definitionSha256: digest("6"),
      evaluationRequestId: "request_selection",
    },
    schemaVersion: "0.1",
    scope,
  };
}

describe("policy evaluation comparison selection contracts", () => {
  it("accepts exact unique and missing resolutions after a complete readable inventory", () => {
    const first = verifiedMember("a", "a");
    const second = verifiedMember("b", "b");
    const value = inventory(
      [first, second],
      [
        { comparison: comparison("a"), result: first.reference, status: "unique" },
        { comparison: comparison("b"), result: second.reference, status: "unique" },
        { comparison: comparison("c"), status: "missing" },
      ],
    );

    expect(PolicyEvaluationComparisonInventorySchema.parse(value)).toEqual(value);
  });

  it("accepts ambiguity only with every match and every unreadable member retained", () => {
    const first = verifiedMember("a", "a");
    const second = verifiedMember("b", "a");
    const unreadable: PolicyEvaluationCandidateComparisonMember = {
      observation: { status: "missing" },
      reference: reference("c"),
    };
    const value = inventory(
      [first, second, unreadable],
      [
        {
          comparison: comparison("a"),
          matches: [first.reference, second.reference],
          status: "ambiguous",
          unresolvedMembers: [unreadable.reference],
        },
      ],
    );

    expect(PolicyEvaluationComparisonInventorySchema.parse(value)).toEqual(value);

    const omitted = structuredClone(value);
    if (omitted.policyComparisons[0]?.status !== "ambiguous") throw new Error("fixture drift");
    omitted.policyComparisons[0].unresolvedMembers = [];
    expect(PolicyEvaluationComparisonInventorySchema.safeParse(omitted).success).toBe(false);
  });

  it("accepts unresolved selection with zero or one known match and all unreadable members", () => {
    const match = verifiedMember("a", "a");
    const nonmatch = verifiedMember("b", "b");
    const unavailable: PolicyEvaluationCandidateComparisonMember = {
      observation: { reason: "record_invalid", status: "unavailable" },
      reference: reference("c"),
    };
    for (const members of [
      [match, unavailable],
      [nonmatch, unavailable],
    ]) {
      const knownMatches = members[0] === match ? [match.reference] : [];
      const value = inventory(members, [
        {
          comparison: comparison("a"),
          knownMatches,
          status: "unresolved",
          unresolvedMembers: [unavailable.reference],
        },
      ]);
      expect(PolicyEvaluationComparisonInventorySchema.parse(value)).toEqual(value);
    }
  });

  it("rejects a unique or missing claim that contradicts the complete member inventory", () => {
    const match = verifiedMember("a", "a");
    const unreadable: PolicyEvaluationCandidateComparisonMember = {
      observation: { reason: "reference_mismatch", status: "unavailable" },
      reference: reference("b"),
    };

    expect(
      PolicyEvaluationComparisonInventorySchema.safeParse(
        inventory(
          [match, unreadable],
          [{ comparison: comparison("a"), result: match.reference, status: "unique" }],
        ),
      ).success,
    ).toBe(false);
    expect(
      PolicyEvaluationComparisonInventorySchema.safeParse(
        inventory([match], [{ comparison: comparison("a"), status: "missing" }]),
      ).success,
    ).toBe(false);
  });

  it("rejects fabricated matches and incomplete unresolved membership", () => {
    const match = verifiedMember("a", "a");
    const unreadable: PolicyEvaluationCandidateComparisonMember = {
      observation: { reason: "not_yet_available", status: "unavailable" },
      reference: reference("b"),
    };
    expect(
      PolicyEvaluationComparisonInventorySchema.safeParse(
        inventory(
          [match, unreadable],
          [
            {
              comparison: comparison("a"),
              matches: [match.reference, reference("c")],
              status: "ambiguous",
              unresolvedMembers: [unreadable.reference],
            },
          ],
        ),
      ).success,
    ).toBe(false);
    expect(
      PolicyEvaluationComparisonInventorySchema.safeParse(
        inventory(
          [match, unreadable],
          [
            {
              comparison: comparison("a"),
              knownMatches: [match.reference],
              status: "unresolved",
              unresolvedMembers: [],
            },
          ],
        ),
      ).success,
    ).toBe(false);
  });

  it("rejects reordered members and reordered or duplicate policy comparison identities", () => {
    const first = verifiedMember("a", "a");
    const second = verifiedMember("b", "b");
    const resolutionA = {
      comparison: comparison("a"),
      result: first.reference,
      status: "unique" as const,
    };
    const resolutionB = {
      comparison: comparison("b"),
      result: second.reference,
      status: "unique" as const,
    };

    expect(
      PolicyEvaluationComparisonInventorySchema.safeParse(
        inventory([second, first], [resolutionA, resolutionB]),
      ).success,
    ).toBe(false);
    expect(
      PolicyEvaluationComparisonInventorySchema.safeParse(
        inventory([first, second], [resolutionB, resolutionA]),
      ).success,
    ).toBe(false);
    expect(
      PolicyEvaluationComparisonInventorySchema.safeParse(
        inventory([first, second], [resolutionA, resolutionA]),
      ).success,
    ).toBe(false);
  });

  it.each(["baseline", "candidate"])(
    "rejects a verified member with the wrong %s role",
    (field) => {
      const member = structuredClone(verifiedMember("a", "a"));
      if (member.observation.status !== "verified") throw new Error("fixture drift");
      if (field === "baseline") member.observation.baselineSnapshot.role = "candidate";
      else member.observation.candidateSnapshot.role = "baseline";

      expect(PolicyEvaluationCandidateComparisonMemberSchema.safeParse(member).success).toBe(false);
    },
  );
});
