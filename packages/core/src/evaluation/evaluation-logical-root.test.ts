import { describe, expect, it } from "vitest";
import { requireEvaluationLogicalRootKind } from "./evaluation-logical-root.js";
import { InvalidEvaluationRecordInputError } from "./evaluation-repository-errors.js";

describe("evaluation logical-root kind admission", () => {
  it.each([
    "aggregation_policy",
    "criterion_set",
    "evaluator_spec",
    "oracle_spec",
    "qualification_fixture_set",
  ])("admits the actual owning resource kind %s", (kind) => {
    expect(requireEvaluationLogicalRootKind(kind)).toBe(kind);
  });

  it.each([
    "assessment",
    "criterion_set_status",
    "discovery_record",
    "evaluation_aggregate",
    "evaluation_run",
    "evaluation_run_rejection",
    "evaluation_run_result",
    "qualification_report",
    "raw_observation",
    "source_review",
    "source_reviewer_qualification",
    "source_snapshot",
    "__proto__",
    "constructor",
    "evaluator",
    "oracle",
    "",
    null,
    undefined,
    1,
    {},
  ])("rejects unsupported or malformed runtime kinds %j", (kind) => {
    expect(() => requireEvaluationLogicalRootKind(kind)).toThrow(InvalidEvaluationRecordInputError);
  });
});
