import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES,
  type PolicyEvaluationJobSnapshot,
} from "@proofstack/contracts";
import { exhaustPolicyEvaluationJobHistory } from "./policy-evaluation-history-limit.js";
const vector = JSON.parse(
  readFileSync(
    new URL("../../../contracts/vectors/policy-evaluation-job-history-v1.json", import.meta.url),
    "utf8",
  ),
);
function atLimit() {
  const snapshot: PolicyEvaluationJobSnapshot = structuredClone(vector.vectors[1].snapshot);
  snapshot.job.stateVersion = MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES - 1;
  snapshot.usage.artifactReadBytes = MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES - 3;
  return snapshot;
}
describe("fixed history capacity terminal receipt", () => {
  it("uses the reserved final entry without refund, new attempt or changed request", () => {
    const original = atLimit();
    const result = exhaustPolicyEvaluationJobHistory(original, original.job.updatedAt);
    expect(result.job.status).toBe("budget_exhausted");
    expect(result.job.stateVersion).toBe(MAX_POLICY_EVALUATION_JOB_HISTORY_ENTRIES);
    expect(result.job.currentLease).toBeNull();
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.usageAtClose).toEqual(original.usage);
    expect(result.usage).toEqual(original.usage);
    expect(result.request).toEqual(original.request);
    expect(original.job.status).toBe("acquiring");
  });
  it.each(["early", "late", "clock_backwards", "terminal"])(
    "rejects invalid exhaustion %s",
    (kind) => {
      const snapshot = atLimit();
      let now = snapshot.job.updatedAt;
      if (kind === "early") snapshot.job.stateVersion--;
      else if (kind === "late") snapshot.job.stateVersion++;
      else if (kind === "clock_backwards") now = "2026-09-07T12:00:00.000Z";
      else {
        const terminal = exhaustPolicyEvaluationJobHistory(snapshot, now);
        expect(() => exhaustPolicyEvaluationJobHistory(terminal, now)).toThrow();
        return;
      }
      expect(() => exhaustPolicyEvaluationJobHistory(snapshot, now)).toThrow();
    },
  );
});
