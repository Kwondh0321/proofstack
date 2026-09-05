import { describe, expect, it } from "vitest";
import {
  ComparisonLineageError,
  ComparisonRecordConflictError,
  ComparisonRepositoryContractError,
  ComparisonResourceConflictError,
  InvalidComparisonRecordInputError,
} from "./comparison-repository-errors.js";

describe("comparison repository errors", () => {
  it("exposes stable machine codes and bounded record context", () => {
    const conflict = new ComparisonRecordConflictError(
      "comparison_evidence_snapshot",
      "snapshot_reference",
    );
    expect(conflict).toMatchObject({
      code: "comparison_record_conflict",
      name: "ComparisonRecordConflictError",
      recordId: "snapshot_reference",
      recordKind: "comparison_evidence_snapshot",
    });

    const resource = new ComparisonResourceConflictError("comparison_reference");
    expect(resource).toMatchObject({
      code: "comparison_resource_conflict",
      comparisonId: "comparison_reference",
      name: "ComparisonResourceConflictError",
    });

    const lineage = new ComparisonLineageError(
      "comparison_result",
      "result_reference",
      "comparison_definition",
      "comparison_reference_v1",
    );
    expect(lineage).toMatchObject({
      code: "comparison_lineage_invalid",
      name: "ComparisonLineageError",
      recordId: "result_reference",
      recordKind: "comparison_result",
      referenceId: "comparison_reference_v1",
      referenceKind: "comparison_definition",
    });
  });

  it("preserves typed input and adapter contract failures", () => {
    const cause = new Error("strict parse failed");
    expect(new InvalidComparisonRecordInputError("invalid record", { cause })).toMatchObject({
      cause,
      code: "comparison_record_input_invalid",
      name: "InvalidComparisonRecordInputError",
    });
    expect(
      new ComparisonRepositoryContractError("adapter violated the contract", { cause }),
    ).toMatchObject({
      cause,
      code: "comparison_repository_contract_violation",
      name: "ComparisonRepositoryContractError",
    });
  });
});
