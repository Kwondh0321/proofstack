import {
  MAX_POLICY_APPROVAL_GROUPS,
  MAX_RELEASE_DECISION_APPROVAL_READS,
  OpaqueIdSchema,
} from "@proofstack/contracts";

export const MAX_RELEASE_QUORUM_REVIEWERS = MAX_RELEASE_DECISION_APPROVAL_READS;

export class InvalidReviewerGroupGraphError extends Error {
  readonly code = "invalid_reviewer_group_graph";
  constructor() {
    super("Reviewer group assignment does not satisfy its bounded input contract");
    this.name = "InvalidReviewerGroupGraphError";
  }
}
interface Reviewer {
  readonly principalId: string;
  readonly groupIds: readonly string[];
  readonly human: boolean;
}
export interface ReviewerGroupAssignmentInput {
  readonly groupIds: readonly string[];
  readonly reviewers: readonly Reviewer[];
  readonly quorum: number;
  readonly humanGroupIds: readonly string[];
}
export interface ReviewerGroupAssignment {
  readonly status: "matched" | "shortfall";
  readonly matched: readonly {
    readonly principalId: string;
    readonly groupId: string;
    readonly humanGroup: boolean;
  }[];
}

function object<const Key extends string>(
  value: unknown,
  keys: readonly Key[],
): Record<Key, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    throw new InvalidReviewerGroupGraphError();
  return value as Record<Key, unknown>;
}
function ids(value: unknown, minimum: number, maximum: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum ||
    !value.every((id) => OpaqueIdSchema.safeParse(id).success) ||
    new Set(value).size !== value.length
  )
    throw new InvalidReviewerGroupGraphError();
  return [...value].sort();
}
function parse(input: unknown): ReviewerGroupAssignmentInput {
  const value = object(input, ["groupIds", "reviewers", "quorum", "humanGroupIds"]);
  const groupIds = ids(value.groupIds, 1, MAX_POLICY_APPROVAL_GROUPS);
  const humanGroupIds = ids(value.humanGroupIds, 0, MAX_POLICY_APPROVAL_GROUPS);
  if (
    humanGroupIds.some((id) => !groupIds.includes(id)) ||
    typeof value.quorum !== "number" ||
    !Number.isInteger(value.quorum) ||
    value.quorum < 1 ||
    value.quorum > groupIds.length ||
    !Array.isArray(value.reviewers) ||
    value.reviewers.length > MAX_RELEASE_QUORUM_REVIEWERS
  )
    throw new InvalidReviewerGroupGraphError();
  const reviewers = value.reviewers
    .map((raw): Reviewer => {
      const reviewer = object(raw, ["principalId", "groupIds", "human"]);
      const principal = OpaqueIdSchema.safeParse(reviewer.principalId);
      if (!principal.success || typeof reviewer.human !== "boolean")
        throw new InvalidReviewerGroupGraphError();
      return {
        principalId: principal.data,
        groupIds: ids(reviewer.groupIds, 0, MAX_POLICY_APPROVAL_GROUPS),
        human: reviewer.human,
      };
    })
    .sort((left, right) =>
      left.principalId < right.principalId ? -1 : left.principalId > right.principalId ? 1 : 0,
    );
  if (new Set(reviewers.map(({ principalId }) => principalId)).size !== reviewers.length)
    throw new InvalidReviewerGroupGraphError();
  return { groupIds, humanGroupIds, reviewers, quorum: value.quorum };
}

/**
 * Internal combinatorial witness only. Callers must independently establish complete current
 * subject/actor/session/role/authority/independence eligibility under held publication guards.
 * This function authenticates nobody, reads no clock and grants no approval or release power.
 */
export function matchDistinctReviewerGroups(
  input: ReviewerGroupAssignmentInput,
): ReviewerGroupAssignment {
  const graph = parse(input);
  const groups = graph.groupIds;
  const reviewers = graph.reviewers;
  const humanGroups = new Set(graph.humanGroupIds);
  const memberships = reviewers.map(({ groupIds }) => new Set(groupIds));
  // At most (groups - quorum) rows may use unmatched columns, so every feasible assignment
  // meets quorum. Additional unmatched columns only repair the matrix when too few people
  // exist to meet quorum at all. Among feasible assignments prefer required human-group edges.
  // An impossible edge costs more than every human bonus combined, so a human witness cannot
  // hide a missing person. Do not maximize seats at the expense of a valid smaller quorum.
  const rows = groups.length;
  const columns = reviewers.length + Math.max(rows - graph.quorum, rows - reviewers.length);
  const cost = (row: number, column: number): number => {
    const reviewer = reviewers[column - 1];
    if (!reviewer) return 0;
    const group = groups[row - 1] ?? "";
    if (!memberships[column - 1]?.has(group)) return rows + 1;
    return reviewer.human && humanGroups.has(group) ? -1 : 0;
  };
  const rowPotential = Array<number>(rows + 1).fill(0);
  const columnPotential = Array<number>(columns + 1).fill(0);
  const owner = Array<number>(columns + 1).fill(0);
  const previous = Array<number>(columns + 1).fill(0);
  for (let row = 1; row <= rows; row += 1) {
    owner[0] = row;
    let column = 0;
    const minimum = Array<number>(columns + 1).fill(Number.POSITIVE_INFINITY);
    const used = Array<boolean>(columns + 1).fill(false);
    do {
      used[column] = true;
      const currentRow = owner[column] ?? 0;
      let delta = Number.POSITIVE_INFINITY;
      let next = 0;
      for (let candidate = 1; candidate <= columns; candidate += 1) {
        if (used[candidate]) continue;
        const reduced =
          cost(currentRow, candidate) -
          (rowPotential[currentRow] ?? 0) -
          (columnPotential[candidate] ?? 0);
        if (reduced < (minimum[candidate] ?? Number.POSITIVE_INFINITY)) {
          minimum[candidate] = reduced;
          previous[candidate] = column;
        }
        if ((minimum[candidate] ?? Number.POSITIVE_INFINITY) < delta) {
          delta = minimum[candidate] ?? Number.POSITIVE_INFINITY;
          next = candidate;
        }
      }
      for (let candidate = 0; candidate <= columns; candidate += 1) {
        if (used[candidate]) {
          const assignedRow = owner[candidate] ?? 0;
          rowPotential[assignedRow] = (rowPotential[assignedRow] ?? 0) + delta;
          columnPotential[candidate] = (columnPotential[candidate] ?? 0) - delta;
        } else minimum[candidate] = (minimum[candidate] ?? Number.POSITIVE_INFINITY) - delta;
      }
      column = next;
    } while ((owner[column] ?? 0) !== 0);
    do {
      const predecessor = previous[column] ?? 0;
      owner[column] = owner[predecessor] ?? 0;
      column = predecessor;
    } while (column !== 0);
  }
  const matched: { principalId: string; groupId: string; humanGroup: boolean }[] = [];
  for (let column = 1; column <= reviewers.length; column += 1) {
    const row = owner[column] ?? 0;
    const reviewer = reviewers[column - 1];
    if (row === 0 || !reviewer) continue;
    const groupId = groups[row - 1] ?? "";
    // An infeasible graph may require a penalized placeholder; it is never supporting evidence.
    if (!memberships[column - 1]?.has(groupId)) continue;
    matched.push({
      principalId: reviewer.principalId,
      groupId,
      humanGroup: reviewer.human && humanGroups.has(groupId),
    });
  }
  matched.sort((left, right) =>
    left.groupId < right.groupId ? -1 : left.groupId > right.groupId ? 1 : 0,
  );
  return {
    status:
      matched.length >= graph.quorum &&
      (humanGroups.size === 0 || matched.some(({ humanGroup }) => humanGroup))
        ? "matched"
        : "shortfall",
    matched,
  };
}
