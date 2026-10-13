import { describe, expect, it } from "vitest";
import {
  PolicyEvaluationAuthoritySuccessorSchema,
  PolicyEvaluationCriterionAuthorityInputsSchema,
  PolicyEvaluationCriterionHistoryProjectionSchema,
  type PolicyEvaluationCriterionAuthorityInputs,
} from "./policy-evaluation-criterion-authority.js";

const sha = "a".repeat(64);
const cut = "2026-10-03T00:00:00.000000000000000000000000000001Z";
const end = "2026-10-04T00:00:00.000000000000000000000000000001Z";
const scope = {
  tenantId: "tenant_criterion",
  projectId: "project_criterion",
  environmentId: "env_criterion",
};
const criterion = {
  kind: "criterion_set" as const,
  reference: {
    criterionSetId: "criterion_set_inputs",
    criterionSetVersionId: "criterion_set_inputs_v1",
    definitionSha256: sha,
  },
};
function input(): Extract<PolicyEvaluationCriterionAuthorityInputs, { status: "observed" }> {
  return {
    status: "observed",
    scope: structuredClone(scope),
    evaluationTime: cut,
    startedAt: "2026-10-04T00:00:00.000Z",
    completedAt: end,
    historySha256: sha,
    history: [
      {
        record: {
          criterionSet: structuredClone(criterion.reference),
          effectiveAt: "2026-10-02T00:00:00.000Z",
          rationale: "Retained original status",
          status: "draft",
          statusRecordId: "status_criterion_inputs",
          definitionSha256: sha,
          recordedAt: "2026-10-02T00:00:00.000Z",
          recordedByPrincipalId: "principal_criterion",
          schemaVersion: "0.1",
          scope: structuredClone(scope),
        },
        recordSha256: sha,
      },
    ],
    successors: [],
    selections: [],
    criteria: [
      {
        source: structuredClone(criterion),
        observation: { status: "verified", recordSha256: sha },
        historyIndexes: [0],
        issues: [],
        atEvaluation: {
          at: cut,
          status: "head",
          active: [0],
          heads: [{ historyIndex: 0, expired: false }],
          inactivePredecessors: [],
        },
        atCapture: {
          at: end,
          status: "head",
          active: [0],
          heads: [{ historyIndex: 0, expired: false }],
          inactivePredecessors: [],
        },
      },
    ],
  };
}

describe("strict original criterion authority coordinates", () => {
  it("preserves complete history and full-precision semantic/capture projections", () => {
    const value = input();
    expect(PolicyEvaluationCriterionAuthorityInputsSchema.parse(value)).toEqual(value);
    expect(
      PolicyEvaluationCriterionAuthorityInputsSchema.parse({ status: "not_required" }),
    ).toEqual({ status: "not_required" });
  });
  it.each([
    "scope",
    "future",
    "cut",
    "order",
    "semantic_cut",
    "capture_cut",
    "index",
    "issue",
    "active",
  ] as const)("rejects changed history %s", (fault) => {
    const value = input();
    if (fault === "scope") value.history[0]!.record.scope.tenantId = "tenant_other";
    else if (fault === "future") value.history[0]!.record.recordedAt = "2026-10-05T00:00:00.000Z";
    else if (fault === "cut") value.startedAt = "2026-10-01T00:00:00.000Z";
    else if (fault === "order") value.completedAt = "2026-10-01T00:00:00.000Z";
    else if (fault === "semantic_cut") value.criteria[0]!.atEvaluation.at = end;
    else if (fault === "capture_cut") value.criteria[0]!.atCapture.at = cut;
    else if (fault === "index") value.criteria[0]!.historyIndexes = [1];
    else if (fault === "issue")
      value.criteria[0]!.issues = [{ historyIndex: 1, reason: "history_cycle" }];
    else {
      value.criteria[0]!.historyIndexes = [];
    }
    expect(PolicyEvaluationCriterionAuthorityInputsSchema.safeParse(value).success).toBe(false);
  });
  it.each(["empty", "head", "ambiguous", "inactive", "foreign", "duplicate"] as const)(
    "rejects invented %s projection",
    (fault) => {
      const value = structuredClone(input().criteria[0]!.atEvaluation);
      if (fault === "empty") value.status = "empty";
      else if (fault === "head") value.heads = [];
      else if (fault === "ambiguous") value.status = "ambiguous";
      else if (fault === "inactive") value.inactivePredecessors = [1];
      else if (fault === "foreign") value.heads[0]!.historyIndex = 1;
      else value.heads.push(structuredClone(value.heads[0]!));
      expect(PolicyEvaluationCriterionHistoryProjectionSchema.safeParse(value).success).toBe(false);
    },
  );
  it("preserves original offset/precision in a successor storage witness", () => {
    const value = {
      source: criterion,
      observation: { status: "verified", recordSha256: sha },
      storage: {
        recordSha256: sha,
        receiptTime: "2026-10-03T09:00:00.000000000000000000000000000001+09:00",
      },
    };
    expect(PolicyEvaluationAuthoritySuccessorSchema.parse(value)).toEqual(value);
    expect(
      PolicyEvaluationAuthoritySuccessorSchema.safeParse({ ...value, storage: null }).success,
    ).toBe(false);
    expect(
      PolicyEvaluationAuthoritySuccessorSchema.safeParse({
        ...value,
        observation: { status: "missing" },
      }).success,
    ).toBe(false);
    expect(
      PolicyEvaluationAuthoritySuccessorSchema.safeParse({
        ...value,
        storage: { ...value.storage, recordSha256: "b".repeat(64) },
      }).success,
    ).toBe(false);
  });
  it("rejects total occurrence overflow before record material getters", () => {
    const value = input();
    value.history = Array.from({ length: 100000 }, () => value.history[0]!);
    Object.defineProperty(value.history[0], "record", {
      get() {
        throw new Error("Record material read before admission");
      },
    });
    expect(PolicyEvaluationCriterionAuthorityInputsSchema.safeParse(value).success).toBe(false);
  });
});
