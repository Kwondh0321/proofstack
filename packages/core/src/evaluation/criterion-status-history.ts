import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  type CriterionSetStatusRecord,
  type EvidenceScope,
  EvidenceScopeSchema,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
  serializeEvaluationCanonicalJson,
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
  return admitHistoryRecords(scope, input, limitsInput).map(({ record }) => record);
}

// Retain canonical text only within this admission call. Every call validates each current row.
function admitHistoryRecords(
  scope: EvidenceScope,
  input: readonly unknown[],
  limitsInput: CriterionStatusHistoryLimits,
): readonly { readonly record: CriterionSetStatusRecord; readonly canonical: string }[] {
  const limits = requireCriterionStatusHistoryLimits(limitsInput);
  if (!Array.isArray(input))
    throw new EvaluationRepositoryContractError("Criterion history must be an array");
  if (input.length > limits.maxRecords) throw new CriterionStatusHistoryLimitError("records");
  let bytes = 2;
  let previous = "";
  const records: { readonly record: CriterionSetStatusRecord; readonly canonical: string }[] = [];
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
    const canonical = serializeEvaluationCanonicalJson(normalized);
    bytes += Buffer.byteLength(canonical, "utf8") + Number(records.length > 0);
    if (bytes > limits.maxRecordBytes) throw new CriterionStatusHistoryLimitError("bytes");
    records.push({ record: normalized, canonical });
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
  const records = admitHistoryRecords(scope, input, limits);
  // Exact canonical envelope order is format, records, scope. Reuse each strictly admitted
  // row's text for full/per-row digests without serializing or trusting it in another call.
  const digest = createHash("sha256").update(
    '{"format":"proofstack.criterion-status-history.v1","records":[',
    "utf8",
  );
  const history: { readonly record: CriterionSetStatusRecord; readonly recordSha256: string }[] =
    [];
  for (const { record, canonical } of records) {
    if (history.length > 0) digest.update(",", "utf8");
    digest.update(canonical, "utf8");
    history.push({
      record,
      recordSha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
    });
  }
  digest.update('],"scope":', "utf8").update(serializeEvaluationCanonicalJson(scope), "utf8");
  return {
    historySha256: digest.update("}", "utf8").digest("hex"),
    history,
  };
}
