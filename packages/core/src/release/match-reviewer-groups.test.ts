import { describe, expect, it } from "vitest";
import {
  InvalidReviewerGroupGraphError,
  MAX_RELEASE_QUORUM_REVIEWERS,
  matchDistinctReviewerGroups,
  type ReviewerGroupAssignmentInput,
} from "./match-reviewer-groups.js";

/** Independent exhaustive enumeration; no assignment costs, potentials or augmenting paths. */
function oracle(graph: ReviewerGroupAssignmentInput): number {
  let best = 0;
  function visit(groupIndex: number, used: Set<number>, count: number, human: boolean): void {
    if (groupIndex === graph.groupIds.length) {
      if (graph.humanGroupIds.length === 0 || human) best = Math.max(best, count);
      return;
    }
    visit(groupIndex + 1, used, count, human);
    const group = graph.groupIds[groupIndex] ?? "";
    for (const [index, reviewer] of graph.reviewers.entries()) {
      if (used.has(index) || !reviewer.groupIds.includes(group)) continue;
      used.add(index);
      visit(
        groupIndex + 1,
        used,
        count + 1,
        human || (reviewer.human && graph.humanGroupIds.includes(group)),
      );
      used.delete(index);
    }
  }
  visit(0, new Set(), 0, false);
  return best;
}

describe("distinct reviewer/group assignment", () => {
  it("finds the unique full-length 32-group alternating cycle", () => {
    const groupIds = Array.from({ length: 32 }, (_, i) => `group_${i.toString().padStart(3, "0")}`);
    const reviewers = groupIds.map((_, i) => ({
      principalId: `reviewer_${i.toString().padStart(3, "0")}`,
      human: true,
      groupIds: i === 31 ? [groupIds[0] ?? ""] : [groupIds[i] ?? "", groupIds[i + 1] ?? ""],
    }));
    const result = matchDistinctReviewerGroups({
      groupIds,
      reviewers,
      quorum: 32,
      humanGroupIds: [groupIds[31] ?? ""],
    });
    expect(result.status).toBe("matched");
    expect(result.matched).toEqual(
      groupIds.map((groupId, i) => ({
        groupId,
        principalId: `reviewer_${(i === 0 ? 31 : i - 1).toString().padStart(3, "0")}`,
        humanGroup: i === 31,
      })),
    );
  });
  it("returns unique real witnesses independent of caller ordering", () => {
    const graph = {
      groupIds: ["group_one", "group_two", "group_three"],
      quorum: 2,
      humanGroupIds: ["group_one", "group_three"],
      reviewers: [
        { principalId: "reviewer_b", human: true, groupIds: ["group_one", "group_two"] },
        { principalId: "reviewer_a", human: false, groupIds: ["group_three", "group_one"] },
        { principalId: "reviewer_c", human: true, groupIds: ["group_three", "group_two"] },
      ],
    };
    const original = structuredClone(graph);
    const result = matchDistinctReviewerGroups(graph);
    expect(result.status).toBe("matched");
    expect(new Set(result.matched.map(({ principalId }) => principalId)).size).toBe(
      result.matched.length,
    );
    expect(new Set(result.matched.map(({ groupId }) => groupId)).size).toBe(result.matched.length);
    for (const match of result.matched) {
      const reviewer = graph.reviewers.find(({ principalId }) => principalId === match.principalId);
      expect(graph.groupIds).toContain(match.groupId);
      expect(reviewer?.groupIds).toContain(match.groupId);
      expect(match.humanGroup).toBe(
        reviewer?.human === true && graph.humanGroupIds.includes(match.groupId),
      );
    }
    expect(
      matchDistinctReviewerGroups({
        ...graph,
        groupIds: [...graph.groupIds].reverse(),
        humanGroupIds: [...graph.humanGroupIds].reverse(),
        reviewers: [...graph.reviewers]
          .reverse()
          .map((reviewer) => ({ ...reviewer, groupIds: [...reviewer.groupIds].reverse() })),
      }),
    ).toEqual(result);
    expect(graph).toEqual(original);
  });
  it("never turns one person's memberships or impossible edges into a larger quorum", () => {
    const graph = {
      groupIds: ["group_one", "group_two"],
      quorum: 2,
      humanGroupIds: [],
      reviewers: [
        { principalId: "reviewer_one", human: true, groupIds: ["group_one", "group_two"] },
      ],
    };
    expect(matchDistinctReviewerGroups(graph).status).toBe("shortfall");
    const reviewer = graph.reviewers[0];
    if (!reviewer) throw new Error("Missing reviewer fixture");
    expect(
      matchDistinctReviewerGroups({
        ...graph,
        reviewers: [{ ...reviewer, groupIds: ["group_unrelated"] }],
      }),
    ).toEqual({ status: "shortfall", matched: [] });
    expect(matchDistinctReviewerGroups({ ...graph, reviewers: [] })).toEqual({
      status: "shortfall",
      matched: [],
    });
  });
  it("bounds the full 512-person, 32-group graph", () => {
    const groupIds = Array.from({ length: 32 }, (_, i) => `group_${i.toString().padStart(3, "0")}`);
    const graph = {
      groupIds,
      quorum: 32,
      humanGroupIds: groupIds,
      reviewers: Array.from({ length: MAX_RELEASE_QUORUM_REVIEWERS }, (_, i) => ({
        principalId: `reviewer_${i.toString().padStart(3, "0")}`,
        human: true,
        groupIds,
      })),
    };
    const result = matchDistinctReviewerGroups(graph);
    expect(result.status).toBe("matched");
    expect(result.matched).toHaveLength(32);
    expect(new Set(result.matched.map(({ principalId }) => principalId)).size).toBe(32);
    expect(() =>
      matchDistinctReviewerGroups({
        ...graph,
        reviewers: [...graph.reviewers, { principalId: "reviewer_extra", human: true, groupIds }],
      }),
    ).toThrow(InvalidReviewerGroupGraphError);
  });
  it("rejects duplicate actors, invalid membership, truthy flags and forged authority", () => {
    const graph = {
      groupIds: ["group_one"],
      quorum: 1,
      humanGroupIds: [],
      reviewers: [{ principalId: "reviewer_one", human: true, groupIds: ["group_one"] }],
    };
    const malformed: unknown[] = [
      null,
      [],
      {},
      { ...graph, approved: true },
      { ...graph, quorum: 0 },
      { ...graph, quorum: 2 },
      { ...graph, quorum: 1.5 },
      { ...graph, quorum: Number.NaN },
      { ...graph, quorum: "1" },
      { ...graph, groupIds: [] },
      { ...graph, groupIds: "untrusted" },
      { ...graph, humanGroupIds: null },
      { ...graph, groupIds: ["group_one", "group_one"] },
      { ...graph, groupIds: Array.from({ length: 33 }, (_, i) => `group_${i}`) },
      { ...graph, groupIds: ["invalid ID"] },
      { ...graph, humanGroupIds: ["group_other"] },
      { ...graph, reviewers: "untrusted" },
      { ...graph, reviewers: [null] },
      { ...graph, reviewers: [graph.reviewers[0], graph.reviewers[0]] },
      { ...graph, reviewers: [{ ...graph.reviewers[0], principalId: "invalid ID" }] },
      { ...graph, reviewers: [{ ...graph.reviewers[0], human: "true" }] },
      { ...graph, reviewers: [{ ...graph.reviewers[0], currentAuthority: true }] },
      { ...graph, reviewers: [{ ...graph.reviewers[0], groupIds: ["group_one", "group_one"] }] },
    ];
    for (const value of malformed)
      expect(() => matchDistinctReviewerGroups(value as never)).toThrow(
        InvalidReviewerGroupGraphError,
      );
  });
  it.each(Array.from({ length: 8 }, (_, index) => index))(
    "agrees with exhaustive 3x3 graph/required-group/quorum enumeration for human mask %i",
    (humanMask) => {
      const groups = ["group_0", "group_1", "group_2"];
      for (let edgeMask = 0; edgeMask < 512; edgeMask += 1) {
        const reviewers = Array.from({ length: 3 }, (_, reviewer) => ({
          principalId: `reviewer_${reviewer}`,
          human: (humanMask & (1 << reviewer)) !== 0,
          groupIds: groups.filter((_, group) => (edgeMask & (1 << (reviewer * 3 + group))) !== 0),
        }));
        for (let requiredMask = 0; requiredMask < 8; requiredMask += 1) {
          const graph = {
            groupIds: groups,
            reviewers,
            quorum: 1,
            humanGroupIds: groups.filter((_, group) => (requiredMask & (1 << group)) !== 0),
          };
          const maximum = oracle(graph);
          for (let quorum = 1; quorum <= 3; quorum += 1) {
            const actual = matchDistinctReviewerGroups({ ...graph, quorum }).status;
            const expected = maximum >= quorum ? "matched" : "shortfall";
            if (actual !== expected)
              throw new Error(
                `Independent assignment mismatch: edges=${edgeMask}, humans=${humanMask}, required=${requiredMask}, quorum=${quorum}, expected=${expected}, actual=${actual}`,
              );
          }
        }
      }
    },
  );
  it("finds the assignment a greedy flexible reviewer would consume", () => {
    const result = matchDistinctReviewerGroups({
      groupIds: ["group_one", "group_two"],
      quorum: 2,
      humanGroupIds: [],
      reviewers: [
        { principalId: "reviewer_flexible", groupIds: ["group_one", "group_two"], human: true },
        { principalId: "reviewer_single", groupIds: ["group_one"], human: true },
      ],
    });
    expect(result.status).toBe("matched");
    expect(result.matched).toEqual([
      { principalId: "reviewer_single", groupId: "group_one", humanGroup: false },
      { principalId: "reviewer_flexible", groupId: "group_two", humanGroup: false },
    ]);
  });
  it("satisfies the actual quorum with a required human rather than maximizing unrelated seats", () => {
    const graph = {
      groupIds: ["group_one", "group_two"],
      quorum: 1,
      humanGroupIds: ["group_one"],
      reviewers: [
        { principalId: "reviewer_regular", groupIds: ["group_one"], human: false },
        { principalId: "reviewer_human", groupIds: ["group_one", "group_two"], human: true },
      ],
    };
    expect(matchDistinctReviewerGroups(graph).status).toBe("matched");
    expect(matchDistinctReviewerGroups({ ...graph, quorum: 2 }).status).toBe("shortfall");
  });
});
