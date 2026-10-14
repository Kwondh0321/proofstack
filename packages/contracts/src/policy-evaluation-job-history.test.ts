import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  encodePolicyEvaluationJobHistoryEntry,
  PolicyEvaluationJobHistoryEntryDefinitionSchema,
  PolicyEvaluationJobHistoryPageSchema,
  MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES,
  type PolicyEvaluationJobHistoryEntryDefinition,
} from "./policy-evaluation-job-history.js";

const vectors = JSON.parse(
  readFileSync(
    new URL("../vectors/policy-evaluation-job-history-v1.json", import.meta.url),
    "utf8",
  ),
).vectors as {
  name: string;
  entry: { definition: PolicyEvaluationJobHistoryEntryDefinition; entrySha256: string };
  canonicalUtf8: string;
  byteLength: number;
  sha256: string;
}[];
describe("bounded job history contracts", () => {
  it.each(vectors)("matches independent Python canonical bytes/digest: $name", (vector) => {
    const bytes = encodePolicyEvaluationJobHistoryEntry(vector.entry.definition);
    expect(Buffer.from(bytes).toString("utf8")).toBe(vector.canonicalUtf8);
    expect(bytes.byteLength).toBe(vector.byteLength);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(vector.sha256);
  });
  it.each([
    "sequence",
    "previous_entry",
    "previous_graph",
    "previous_status",
    "claim_job",
    "empty_work",
    "creation_status",
  ])("rejects invalid retained history %s", (kind) => {
    const value = structuredClone(
      vectors[kind === "creation_status" ? 0 : kind === "empty_work" ? 2 : 1]!.entry.definition,
    );
    if (kind === "sequence") value.stateVersion++;
    else if (kind === "previous_entry") value.predecessorEntrySha256 = null;
    else if (kind === "previous_graph") value.previousGraphSha256 = null;
    else if (kind === "previous_status") value.previousStatus = null;
    else if (kind === "claim_job" && value.operation.kind === "claim")
      value.operation.fence.jobId = "job_other";
    else if (kind === "empty_work" && value.operation.kind === "reserve")
      for (const key of Object.keys(
        value.operation.delta,
      ) as (keyof typeof value.operation.delta)[])
        value.operation.delta[key] = 0;
    else if (kind === "creation_status") value.status = "acquiring";
    expect(PolicyEvaluationJobHistoryEntryDefinitionSchema.safeParse(value).success).toBe(false);
  });
  it("accepts the last fixed sequence and rejects one more without unsafe counters", () => {
    const value = structuredClone(vectors[1]!.entry.definition);
    value.sequence = MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES - 1;
    value.stateVersion = MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES;
    expect(PolicyEvaluationJobHistoryEntryDefinitionSchema.safeParse(value).success).toBe(true);
    value.sequence++;
    value.stateVersion++;
    expect(PolicyEvaluationJobHistoryEntryDefinitionSchema.safeParse(value).success).toBe(false);
  });
  it("rejects an oversized page before inspecting any child entry", () => {
    const read = vi.fn(() => {
      throw new Error("Child must not be inspected");
    });
    const child = Object.defineProperty({}, "definition", { get: read });
    expect(
      PolicyEvaluationJobHistoryPageSchema.safeParse({ entries: Array(101).fill(child) }).success,
    ).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
});
