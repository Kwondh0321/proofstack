import { describe, expect, it } from "vitest";
import {
  PolicyEvaluationRecordOriginSchema,
  PolicyEvaluationRecordWitnessSchema,
  PolicyEvaluationSnapshotRecordInputsSchema,
  type PolicyEvaluationSnapshotRecordInputs,
  policyEvaluationRecordOriginKey,
} from "./policy-evaluation-snapshot-records.js";

const hash = "a".repeat(64);
const cut = "2026-10-03T00:00:00.000000000000000000000000000001Z";
function input(): PolicyEvaluationSnapshotRecordInputs {
  return {
    schemaVersion: "0.1",
    request: { evaluationRequestId: "request_snapshot", definitionSha256: hash },
    scope: {
      tenantId: "tenant_snapshot",
      projectId: "project_snapshot",
      environmentId: "env_snapshot",
    },
    evaluationTime: cut,
    records: [0, 1].map((index) => ({
      entry: {
        source: {
          kind: "assessment",
          reference: { assessmentId: `assessment_${index}`, definitionSha256: hash },
        },
        observation: { status: "verified", recordSha256: hash },
      },
      storage: { recordSha256: hash, receiptTime: cut },
      origins: [{ kind: "stored_node", nodeIndex: index }],
    })),
  };
}

describe("snapshot record input witness contract", () => {
  it("preserves full receipt precision and detached original metadata", () => {
    const original = input();
    const parsed = PolicyEvaluationSnapshotRecordInputsSchema.parse(original);
    expect(parsed).toEqual(original);
    expect(parsed.records[0]?.storage?.receiptTime).toBe(cut);
    parsed.records[0]!.origins.push({ kind: "semantic_node", nodeIndex: 0 });
    expect(original.records[0]!.origins).toHaveLength(1);
  });

  it.each(["before", "equal", "after"] as const)(
    "binds semantic availability at the %s receipt boundary",
    (boundary) => {
      const value = input();
      const record = value.records[0]!;
      record.storage!.receiptTime =
        boundary === "before"
          ? "2026-10-03T00:00:00.000000000000000000000000000000Z"
          : boundary === "equal"
            ? cut
            : "2026-10-03T00:00:00.000000000000000000000000000002Z";
      if (boundary === "after")
        record.entry.observation = { status: "unavailable", reason: "not_yet_available" };
      expect(PolicyEvaluationSnapshotRecordInputsSchema.safeParse(value).success).toBe(true);
      record.entry.observation =
        boundary === "after"
          ? { status: "verified", recordSha256: hash }
          : { status: "unavailable", reason: "not_yet_available" };
      expect(PolicyEvaluationSnapshotRecordInputsSchema.safeParse(value).success).toBe(false);
    },
  );

  it.each(["missing", "record_invalid", "reference_mismatch"] as const)(
    "preserves %s without fabricating a retained body",
    (status) => {
      const value = input();
      const record = value.records[0]!;
      record.entry.observation =
        status === "missing" ? { status } : { status: "unavailable", reason: status };
      expect(PolicyEvaluationSnapshotRecordInputsSchema.safeParse(value).success).toBe(false);
      record.storage = null;
      expect(PolicyEvaluationSnapshotRecordInputsSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each([
    "hash",
    "absent",
    "duplicate_origin",
    "shared_origin",
    "order",
    "same_identity",
    "extra",
  ] as const)("rejects inconsistent retained record metadata: %s", (fault) => {
    const value = input();
    const record = value.records[0]!;
    if (fault === "hash") record.storage!.recordSha256 = "b".repeat(64);
    else if (fault === "absent") record.storage = null;
    else if (fault === "duplicate_origin") record.origins.push({ ...record.origins[0]! });
    else if (fault === "shared_origin") value.records[1]!.origins = [{ ...record.origins[0]! }];
    else if (fault === "order") value.records.reverse();
    else if (fault === "same_identity") {
      value.records[1]!.entry.source = structuredClone(record.entry.source);
      Reflect.set(value.records[1]!.entry.source.reference, "definitionSha256", "b".repeat(64));
    } else Reflect.set(record.storage!, "authority", "verified");
    expect(PolicyEvaluationSnapshotRecordInputsSchema.safeParse(value).success).toBe(false);
  });

  it("requires the original body witness for a future record", () => {
    const value = input();
    value.records[0]!.entry.observation = { status: "unavailable", reason: "not_yet_available" };
    value.records[0]!.storage = null;
    expect(PolicyEvaluationRecordWitnessSchema.safeParse(value.records[0]).success).toBe(false);
  });

  it("preserves an original full-precision offset receipt without rounding or rewriting it", () => {
    const value = input();
    const original = "2026-10-03T09:00:00.000000000000000000000000000001+09:00";
    value.records[0]!.storage!.receiptTime = original;
    expect(
      PolicyEvaluationSnapshotRecordInputsSchema.parse(value).records[0]!.storage!.receiptTime,
    ).toBe(original);
  });

  it.each([
    null,
    "invalid",
    [],
    { records: "invalid" },
    { records: [null, []] },
    { records: [{}, {}] },
  ])(
    "rejects incomplete or malformed snapshot record input without inventing empty evidence: %j",
    (value) => {
      expect(PolicyEvaluationSnapshotRecordInputsSchema.safeParse(value).success).toBe(false);
    },
  );

  it("keeps origin kinds and every repeated target position distinct", () => {
    const origins = [
      { kind: "request_root", rootIndex: 0 },
      { kind: "semantic_node", nodeIndex: 0 },
      { kind: "stored_node", nodeIndex: 0 },
      { kind: "semantic_edge", edgeIndex: 0 },
      { kind: "semantic_edge_parent", edgeIndex: 0 },
      { kind: "stored_edge", edgeIndex: 0, targetIndex: 0 },
      { kind: "stored_edge", edgeIndex: 0, targetIndex: 1 },
      { kind: "stored_edge_parent", edgeIndex: 0 },
      { kind: "logical_root", bindingIndex: 0 },
      { kind: "logical_root_parent", bindingIndex: 0 },
    ].map((value) => PolicyEvaluationRecordOriginSchema.parse(value));
    expect(new Set(origins.map(policyEvaluationRecordOriginKey)).size).toBe(origins.length);
    const record = input().records[0]!;
    record.origins = origins;
    expect(PolicyEvaluationRecordWitnessSchema.parse(record).origins).toEqual(origins);
  });

  it.each([-1, 0.5, 100000, Number.MAX_SAFE_INTEGER, Number.NaN])(
    "rejects invalid original coordinates: %s",
    (nodeIndex) => {
      expect(
        PolicyEvaluationRecordOriginSchema.safeParse({ kind: "stored_node", nodeIndex }).success,
      ).toBe(false);
    },
  );

  it("admits exactly the fixed occurrence ceiling and rejects one more repeated use", () => {
    const value = input();
    value.records[0]!.origins = Array.from({ length: 99996 }, (_, edgeIndex) => ({
      kind: "semantic_edge",
      edgeIndex,
    }));
    expect(PolicyEvaluationSnapshotRecordInputsSchema.safeParse(value).success).toBe(true);
    value.records[0]!.origins.push({ kind: "semantic_edge", edgeIndex: 99996 });
    expect(PolicyEvaluationSnapshotRecordInputsSchema.safeParse(value).success).toBe(false);
  });

  it("rejects combined origin overflow before inspecting retained material", () => {
    const value = input();
    value.records[0]!.origins = Array.from({ length: 100000 }, (_, edgeIndex) => ({
      kind: "semantic_edge",
      edgeIndex,
    }));
    Object.defineProperty(value.records[0], "entry", {
      get() {
        throw new Error("Material inspected before admission");
      },
    });
    expect(PolicyEvaluationSnapshotRecordInputsSchema.safeParse(value).success).toBe(false);
  });
});
