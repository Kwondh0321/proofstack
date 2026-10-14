import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  encodePolicyEvaluationJobHistoryEntry,
  type PolicyEvaluationJobSnapshot,
  type PolicyEvaluationJobHistoryEntry,
} from "@proofstack/contracts";
import {
  createPolicyEvaluationJobHistoryEntry,
  validatePolicyEvaluationJobHistoryEntry,
  policyEvaluationJobHistoryHead,
  digestPolicyEvaluationJobGraph,
} from "./policy-evaluation-job-history.js";
import { replayPolicyEvaluationJobHistoryEntry } from "./policy-evaluation-job-history-replay.js";

const vectors = JSON.parse(
  readFileSync(
    new URL("../../../contracts/vectors/policy-evaluation-job-history-v1.json", import.meta.url),
    "utf8",
  ),
).vectors as {
  name: string;
  previous: PolicyEvaluationJobSnapshot | null;
  snapshot: PolicyEvaluationJobSnapshot;
  entry: PolicyEvaluationJobHistoryEntry;
}[];
function rehash(entry: PolicyEvaluationJobHistoryEntry) {
  return {
    ...entry,
    entrySha256: createHash("sha256")
      .update(encodePolicyEvaluationJobHistoryEntry(entry.definition))
      .digest("hex"),
  };
}
describe("owning job history hash and independent transition reconstruction", () => {
  it.each(vectors)("recomputes the independently constructed $name entry and graph", (vector) => {
    const predecessor =
      vectors.find(
        (candidate) =>
          candidate.entry.entrySha256 === vector.entry.definition.predecessorEntrySha256,
      )?.entry ?? null;
    const entry = createPolicyEvaluationJobHistoryEntry({
      previous: vector.previous,
      previousEntry: predecessor,
      next: vector.snapshot,
      operation: vector.entry.definition.operation,
    });
    expect(entry).toEqual(vector.entry);
    expect(policyEvaluationJobHistoryHead(entry).graphSha256).toBe(
      digestPolicyEvaluationJobGraph(vector.snapshot),
    );
    if (vector.previous !== null)
      expect(replayPolicyEvaluationJobHistoryEntry(vector.previous, entry)).toEqual(
        vector.snapshot,
      );
  });
  it("rejects un-rehashed entry corruption", () => {
    const entry = structuredClone(vectors[2]!.entry);
    entry.definition.committedAt = "2026-09-07T12:00:01.123457Z";
    expect(() => validatePolicyEvaluationJobHistoryEntry(entry)).toThrow("digest mismatch");
  });
  it.each(["delta", "after_graph", "before_graph", "fence", "scope", "before_status"])(
    "rejects correctly rehashed but semantically substituted %s",
    (kind) => {
      const vector = vectors[kind === "fence" ? 1 : 2]!;
      const entry = structuredClone(vector.entry);
      if (kind === "delta" && entry.definition.operation.kind === "reserve")
        entry.definition.operation.delta.records++;
      else if (kind === "after_graph") entry.definition.graphSha256 = "0".repeat(64);
      else if (kind === "before_graph") entry.definition.previousGraphSha256 = "0".repeat(64);
      else if (kind === "scope") entry.definition.scope.tenantId = "tenant_other";
      else if (kind === "before_status") entry.definition.previousStatus = "retry_ready";
      else if (kind === "fence" && entry.definition.operation.kind === "claim")
        entry.definition.operation.fence.fencingToken++;
      expect(() =>
        replayPolicyEvaluationJobHistoryEntry(vector.previous!, rehash(entry)),
      ).toThrow();
    },
  );
  it("rejects a missing predecessor rather than starting another history root", () => {
    const vector = vectors[1]!;
    expect(() =>
      createPolicyEvaluationJobHistoryEntry({
        previous: vector.previous,
        previousEntry: null,
        next: vector.snapshot,
        operation: vector.entry.definition.operation,
      }),
    ).toThrow("predecessor");
  });
});
