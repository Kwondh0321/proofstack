import { createHash } from "node:crypto";
import { encodeEvaluationCanonicalJson } from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import { criterionStatusHistoryConformanceCases } from "../testing/criterion-status-history-conformance.js";
import { createEvaluationRepositoryTestHarness } from "../testing/evaluation-repository-fixtures.js";
import { MemoryEvaluationRepository } from "../testing/memory-evaluation-repository.js";
import {
  admitCriterionStatusHistory,
  CriterionStatusHistoryLimitError,
  type CriterionStatusHistoryLimits,
  inspectCriterionStatusHistory,
  requireCriterionStatusHistoryLimits,
} from "./criterion-status-history.js";
import { EvaluationRepositoryContractError } from "./evaluation-repository-errors.js";

const harness = createEvaluationRepositoryTestHarness("history_admission");
const records = harness.records
  .filter((record) => record.kind === "criterion_set_status")
  .map(({ record }) => record)
  .sort((a, b) => (a.statusRecordId < b.statusRecordId ? -1 : 1));
const limits = {
  maxRecords: records.length,
  maxRecordBytes: encodeEvaluationCanonicalJson(records).byteLength,
};

describe("complete criterion status history admission", () => {
  it("hashes full receipts and scope-bound complete history after admission", () => {
    const observed = inspectCriterionStatusHistory(harness.scope, records, limits);
    expect(observed.history.map(({ record }) => record)).toEqual(records);
    for (const { record, recordSha256 } of observed.history)
      expect(recordSha256).toBe(
        createHash("sha256").update(encodeEvaluationCanonicalJson(record)).digest("hex"),
      );
    const changed = records.map((record) => ({
      ...record,
      recordedByPrincipalId: "other_recorder",
    }));
    const updated = inspectCriterionStatusHistory(harness.scope, changed, {
      ...limits,
      maxRecordBytes: 100000,
    });
    expect(updated.historySha256).not.toBe(observed.historySha256);
    expect(updated.history[0]?.recordSha256).not.toBe(observed.history[0]?.recordSha256);
    expect(updated.history[0]?.record.definitionSha256).toBe(
      observed.history[0]?.record.definitionSha256,
    );
    expect(observed.history[0]?.record).not.toBe(records[0]);
  });

  it("binds empty-history scope and rejects invalid/over-limit inputs before returning hashes", () => {
    const empty = { maxRecords: 0, maxRecordBytes: 2 };
    expect(inspectCriterionStatusHistory(harness.scope, [], empty).historySha256).not.toBe(
      inspectCriterionStatusHistory({ ...harness.scope, environmentId: "other" }, [], empty)
        .historySha256,
    );
    expect(() => inspectCriterionStatusHistory(harness.scope, records, empty)).toThrow(
      CriterionStatusHistoryLimitError,
    );
    expect(() =>
      inspectCriterionStatusHistory(harness.scope, [...records].reverse(), limits),
    ).toThrow(EvaluationRepositoryContractError);
  });
  for (const testCase of criterionStatusHistoryConformanceCases) {
    it(testCase.name, () =>
      testCase.run((namespace) => ({
        ...createEvaluationRepositoryTestHarness(namespace),
        repository: new MemoryEvaluationRepository(),
      })),
    );
  }

  it.each([
    null,
    false,
    [],
    {},
    { ...limits, other: true },
    { ...limits, maxRecords: -1 },
    { ...limits, maxRecords: 100001 },
    { ...limits, maxRecords: 1.5 },
    { ...limits, maxRecords: Number.NaN },
    { ...limits, maxRecordBytes: 1 },
    { ...limits, maxRecordBytes: 64 * 1024 * 1024 + 1 },
    { ...limits, maxRecordBytes: Number.POSITIVE_INFINITY },
  ])("rejects invalid finite limits %#", (input) => {
    expect(() =>
      requireCriterionStatusHistoryLimits(input as unknown as CriterionStatusHistoryLimits),
    ).toThrow(TypeError);
  });

  it("admits an empty complete scope with zero record allowance and the array's two bytes", () => {
    expect(
      admitCriterionStatusHistory(harness.scope, [], { maxRecords: 0, maxRecordBytes: 2 }),
    ).toEqual([]);
  });

  it.each([null, {}, "not a history"])("rejects a non-array repository response %#", (input) => {
    expect(() => admitCriterionStatusHistory(harness.scope, input as never, limits)).toThrow(
      EvaluationRepositoryContractError,
    );
  });

  it.each(["tenantId", "projectId", "environmentId"])("rejects scope substitution in %s", (key) => {
    expect(() =>
      admitCriterionStatusHistory({ ...harness.scope, [key]: "other_scope" }, records, limits),
    ).toThrow(EvaluationRepositoryContractError);
  });

  it("rejects duplicate, reordered and invalid bodies rather than returning a valid prefix", () => {
    for (const input of [
      [records[0], records[0]],
      [...records].reverse(),
      [records[0], { ...records[1], definitionSha256: "0".repeat(64) }],
    ]) {
      expect(() => admitCriterionStatusHistory(harness.scope, input, limits)).toThrow(
        EvaluationRepositoryContractError,
      );
    }
  });

  it("owns admitted limits and records, and preserves exact count/byte failure reasons", () => {
    const owned = requireCriterionStatusHistoryLimits(limits);
    expect(owned).toEqual(limits);
    expect(owned).not.toBe(limits);
    expect(admitCriterionStatusHistory(harness.scope, records, limits)).toEqual(records);
    expect(() =>
      admitCriterionStatusHistory(harness.scope, records, { ...limits, maxRecords: 1 }),
    ).toThrow(CriterionStatusHistoryLimitError);
    expect(() =>
      admitCriterionStatusHistory(harness.scope, records, {
        ...limits,
        maxRecordBytes: limits.maxRecordBytes - 1,
      }),
    ).toThrow(CriterionStatusHistoryLimitError);
  });
});
