import { createHash } from "node:crypto";
import {
  type CriterionSetStatusRecord,
  type EvidenceScope,
  EvidenceScopeSchema,
  encodeEvaluationCanonicalJson,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
} from "@proofstack/contracts";
import { validateEvaluationRecord } from "./evaluation-record-validation.js";
import { EvaluationRepositoryContractError } from "./evaluation-repository-errors.js";

export interface CriterionStatusHistoryLimits {
  readonly maxRecords: number;
  readonly maxRecordBytes: number;
}

/** Complete exact-scope control history, not a latest-status lookup or publication authority. */
export interface CriterionStatusHistoryRepository {
  listCriterionSetStatuses(
    scope: EvidenceScope,
    limits: CriterionStatusHistoryLimits,
  ): Promise<readonly CriterionSetStatusRecord[]>;
}

export class CriterionStatusHistoryLimitError extends Error {
  readonly code = "criterion_status_history_limit";
  constructor(readonly limit: "records" | "bytes") {
    super(`Complete criterion status history exceeds its ${limit} limit`);
    this.name = "CriterionStatusHistoryLimitError";
  }
}

export function requireCriterionStatusHistoryLimits(
  input: CriterionStatusHistoryLimits,
): CriterionStatusHistoryLimits {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== "maxRecords" && key !== "maxRecordBytes") ||
    !Number.isSafeInteger(input.maxRecords) ||
    input.maxRecords < 0 ||
    input.maxRecords > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS ||
    !Number.isSafeInteger(input.maxRecordBytes) ||
    input.maxRecordBytes < 2 ||
    input.maxRecordBytes > MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES
  )
    throw new TypeError("Invalid complete criterion status history limits");
  return { maxRecords: input.maxRecords, maxRecordBytes: input.maxRecordBytes };
}

/**
 * Shared response admission. Complete scope enumeration comes from the owning repository and,
 * for sealing, its still-held source barrier. This validator cannot prove a supplied list complete.
 * Byte accounting is the canonical UTF-8 array, not a bound on database transport or server work.
 */
export function admitCriterionStatusHistory(
  scopeInput: EvidenceScope,
  input: readonly unknown[],
  limitsInput: CriterionStatusHistoryLimits,
): readonly CriterionSetStatusRecord[] {
  const scope = EvidenceScopeSchema.parse(scopeInput);
  const limits = requireCriterionStatusHistoryLimits(limitsInput);
  if (!Array.isArray(input))
    throw new EvaluationRepositoryContractError("Criterion history must be an array");
  if (input.length > limits.maxRecords) throw new CriterionStatusHistoryLimitError("records");
  let bytes = 2;
  let previous = "";
  const records: CriterionSetStatusRecord[] = [];
  for (const raw of input) {
    let record: CriterionSetStatusRecord;
    try {
      record = validateEvaluationRecord("criterion_set_status", raw) as CriterionSetStatusRecord;
      if (
        record.scope.tenantId !== scope.tenantId ||
        record.scope.projectId !== scope.projectId ||
        record.scope.environmentId !== scope.environmentId ||
        record.statusRecordId <= previous
      )
        throw new Error("Criterion history scope, ordering or identity is invalid");
    } catch (cause) {
      throw new EvaluationRepositoryContractError("Stored criterion history is invalid", { cause });
    }
    previous = record.statusRecordId;
    // Normalize only schema-admitted optional undefined fields, as in other owning inspectors.
    const normalized = JSON.parse(JSON.stringify(record)) as CriterionSetStatusRecord;
    bytes += encodeEvaluationCanonicalJson(normalized).byteLength + Number(records.length > 0);
    if (bytes > limits.maxRecordBytes) throw new CriterionStatusHistoryLimitError("bytes");
    records.push(normalized);
  }
  return records;
}

/** Owning full-record/history digests after complete response admission, not a completeness proof. */
export function inspectCriterionStatusHistory(
  scopeInput: EvidenceScope,
  input: readonly unknown[],
  limits: CriterionStatusHistoryLimits,
): {
  readonly historySha256: string;
  readonly history: readonly {
    readonly record: CriterionSetStatusRecord;
    readonly recordSha256: string;
  }[];
} {
  const scope = EvidenceScopeSchema.parse(scopeInput);
  const records = admitCriterionStatusHistory(scope, input, limits);
  const digest = (value: unknown) =>
    createHash("sha256").update(encodeEvaluationCanonicalJson(value)).digest("hex");
  return {
    historySha256: digest({ format: "proofstack.criterion-status-history.v1", scope, records }),
    history: records.map((record) => ({ record, recordSha256: digest(record) })),
  };
}
