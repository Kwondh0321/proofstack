import {
  type CriterionSetStatusRecord,
  policyEvaluationTimestampOrderKey,
} from "@proofstack/contracts";

export interface CriterionHistoryProjection {
  readonly at: string;
  readonly status: "unresolved" | "empty" | "ambiguous" | "head";
  /** Indexes refer to the complete retained history, never a filtered/latest response. */
  readonly active: readonly number[];
  readonly heads: readonly { readonly historyIndex: number; readonly expired: boolean }[];
  readonly inactivePredecessors: readonly number[];
}

export type CriterionStatusSelection =
  | "approved_head"
  | "history_unresolved"
  | "history_empty"
  | "history_ambiguous"
  | "selected_status_unavailable"
  | "selected_status_not_head"
  | "head_expired"
  | "head_not_approved";

/** Internal policy projection, not a mutation transition machine or an approval grant. */
export function projectCriterionHistory(
  history: readonly CriterionSetStatusRecord[],
  indexes: readonly number[],
  at: string,
  unresolved: boolean,
): CriterionHistoryProjection {
  const cut = policyEvaluationTimestampOrderKey(at);
  const active: number[] = [];
  const activeIds = new Set<string>();
  for (const index of indexes) {
    const record = history[index] as CriterionSetStatusRecord;
    if (
      policyEvaluationTimestampOrderKey(record.recordedAt) <= cut &&
      policyEvaluationTimestampOrderKey(record.effectiveAt) <= cut
    ) {
      active.push(index);
      activeIds.add(record.statusRecordId);
    }
  }
  const replaced = new Set<string>();
  const inactivePredecessors: number[] = [];
  for (const index of active) {
    const previous = history[index]?.previousStatus;
    if (!previous) continue;
    if (activeIds.has(previous.statusRecordId)) replaced.add(previous.statusRecordId);
    else inactivePredecessors.push(index);
  }
  const heads = active
    .filter((index) => !replaced.has((history[index] as CriterionSetStatusRecord).statusRecordId))
    .map((historyIndex) => {
      const expiry = history[historyIndex]?.expiresAt;
      return {
        historyIndex,
        expired: expiry !== undefined && policyEvaluationTimestampOrderKey(expiry) <= cut,
      };
    });
  return {
    at,
    active,
    heads,
    inactivePredecessors,
    status:
      unresolved || inactivePredecessors.length > 0 || (active.length > 0 && heads.length === 0)
        ? "unresolved"
        : heads.length === 0
          ? "empty"
          : heads.length === 1
            ? "head"
            : "ambiguous",
  };
}

/** The exact retained selection must itself be the unique, unexpired approved head. */
export function inspectCriterionStatusSelection(
  history: readonly CriterionSetStatusRecord[],
  selectedIndex: number | undefined,
  projection: CriterionHistoryProjection,
): CriterionStatusSelection {
  if (projection.status === "unresolved") return "history_unresolved";
  if (projection.status === "empty") return "history_empty";
  if (projection.status === "ambiguous") return "history_ambiguous";
  if (selectedIndex === undefined) return "selected_status_unavailable";
  const head = projection.heads[0];
  if (head?.historyIndex !== selectedIndex) return "selected_status_not_head";
  if (head.expired) return "head_expired";
  if (history[selectedIndex]?.status !== "approved") return "head_not_approved";
  return "approved_head";
}
