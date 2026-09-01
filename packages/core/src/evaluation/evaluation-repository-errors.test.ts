import { describe, expect, it } from "vitest";
import {
  EvaluationLineageError,
  EvaluationRecordConflictError,
  EvaluationRecordNotFoundError,
  EvaluationRepositoryContractError,
  EvaluationResourceConflictError,
} from "./evaluation-repository-errors.js";

describe("evaluation repository errors", () => {
  it("exposes stable machine codes and record identity without leaking hidden values", () => {
    const conflict = new EvaluationRecordConflictError("criterion_set", "csv_response_v1");
    const missing = new EvaluationRecordNotFoundError("source_review", "srv_primary");
    expect(conflict).toMatchObject({
      code: "evaluation_record_conflict",
      name: "EvaluationRecordConflictError",
      recordId: "csv_response_v1",
      recordKind: "criterion_set",
    });
    expect(missing).toMatchObject({
      code: "evaluation_record_not_found",
      name: "EvaluationRecordNotFoundError",
      recordId: "srv_primary",
      recordKind: "source_review",
    });
  });

  it("distinguishes resource binding, lineage, and adapter contract failures", () => {
    const binding = new EvaluationResourceConflictError("oracle", "orc_schema");
    const lineage = new EvaluationLineageError(
      "evaluation_run",
      "evr_schema",
      "qualification_report",
      "qlr_oracle",
    );
    const cause = new Error("storage unavailable");
    const contract = new EvaluationRepositoryContractError("Adapter violated atomicity", {
      cause,
    });
    expect(binding.code).toBe("evaluation_resource_conflict");
    expect(lineage).toMatchObject({
      code: "evaluation_lineage_invalid",
      recordId: "evr_schema",
      referenceId: "qlr_oracle",
    });
    expect(contract).toMatchObject({
      cause,
      code: "evaluation_repository_contract_violation",
      name: "EvaluationRepositoryContractError",
    });
  });
});
