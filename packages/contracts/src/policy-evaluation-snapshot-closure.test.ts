import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PolicyEvaluationSnapshotInputsSchema,
  type PolicyEvaluationSnapshotInputs,
} from "./policy-evaluation-snapshot-inputs.js";
import { PolicyEvaluationSnapshotClosureSchema } from "./policy-evaluation-snapshot-closure.js";
const fixture = JSON.parse(
  readFileSync(
    new URL("../vectors/policy-evaluation-snapshot-inputs-v2.fixture.json", import.meta.url),
    "utf8",
  ),
) as Extract<PolicyEvaluationSnapshotInputs, { schemaVersion: "0.2" }>;
describe("strict versioned snapshot relationship closure", () => {
  it("retains semantic/stored distinctions, unavailable parent and every original rule", () => {
    const parsed = PolicyEvaluationSnapshotInputsSchema.parse(fixture);
    expect(parsed).toEqual(fixture);
    expect(fixture.closure.checks.map((check) => [check.context, check.status])).toEqual([
      ["semantic", "matched"],
      ["stored", "mismatch"],
      ["semantic", "unavailable"],
    ]);
    expect(fixture.closure.checks[2]!.parentRecordSha256).toBeNull();
    expect(fixture.closure.rules.map((rule) => rule.ruleId)).toEqual(
      fixture.rules.rules.map(({ rule }) => rule.ruleId),
    );
  });
  it.each([
    "version",
    "closure_missing",
    "extra",
    "parent",
    "owner",
    "related",
    "hash",
    "domain",
    "kind",
    "matched_absence",
    "coordinate",
    "duplicate",
    "order",
    "omitted_rule",
    "rule_identity",
    "unknown_check",
    "omitted_check",
    "foreign_kind",
  ])("rejects substituted %s before becoming sealed input", (kind) => {
    const value = structuredClone(fixture),
      check = value.closure.checks[0]!;
    if (kind === "version") Object.assign(value, { schemaVersion: "0.1" });
    if (kind === "closure_missing") Reflect.deleteProperty(value, "closure");
    if (kind === "extra") Object.assign(value.closure, { workerCredential: "forbidden" });
    if (kind === "parent")
      Object.assign(check.parent.reference, { definitionSha256: "0".repeat(64) });
    if (kind === "owner")
      Object.assign(check.owner.reference, { definitionSha256: "0".repeat(64) });
    if (kind === "related")
      Object.assign(check.relatedSource!.reference, { definitionSha256: "0".repeat(64) });
    if (kind === "hash") check.parentRecordSha256 = "0".repeat(64);
    if (kind === "domain") check.domain = "replay_plan";
    if (kind === "kind") Object.assign(check, { kind: "unknown_semantic_kind" });
    if (kind === "matched_absence") value.closure.checks[2]!.status = "matched";
    if (kind === "coordinate")
      value.closure.rootContext.sourceIndexes.push(value.sources.records.records.length);
    if (kind === "duplicate") value.closure.checks.push(structuredClone(check));
    if (kind === "order") value.closure.rules.reverse();
    if (kind === "omitted_rule") value.closure.rules.pop();
    if (kind === "rule_identity") value.closure.rules[0]!.ruleId = "rule_other";
    if (kind === "unknown_check")
      value.closure.rules[0]!.checkIndexes.push(value.closure.checks.length);
    if (kind === "omitted_check") value.closure.rules[0]!.checkIndexes.pop();
    if (kind === "foreign_kind") check.kind = "human_quorum";
    expect(PolicyEvaluationSnapshotInputsSchema.safeParse(value).success).toBe(false);
  });
  it("requires unique original occurrence coordinates and bounded reasons", () => {
    const value = structuredClone(fixture.closure);
    value.checks[0]!.reasons = ["x".repeat(257)];
    expect(PolicyEvaluationSnapshotClosureSchema.safeParse(value).success).toBe(false);
  });
});
