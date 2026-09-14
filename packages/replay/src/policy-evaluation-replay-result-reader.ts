import { createHash } from "node:crypto";
import {
  EvaluationReplayResultReferenceSchema,
  type EvidenceScope,
  EvidenceScopeSchema,
  encodeEvaluationCanonicalJson,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES,
  MAX_POLICY_EVALUATION_ACQUISITION_RECORDS,
  type PolicyEvaluationSourceReference,
  PolicyEvaluationSourceReferenceSchema,
  PolicyEvaluationTimeSchema,
  policyEvaluationTimestampOrderKey,
  type ReplayJobSnapshot,
  ReplayJobSnapshotSchema,
} from "@proofstack/contracts";
import type { PolicyEvaluationDefinitionRead } from "@proofstack/core";
import type { ReplayJobControlRepository } from "./replay-job-repository.js";

export type PolicyEvaluationReplayResultSource = Extract<
  PolicyEvaluationSourceReference,
  { readonly kind: "replay_result" }
>;

export interface PolicyEvaluationReplayResultReadInput {
  readonly evaluationTime: string;
  /** Per-read admission ceilings, supplied from the enclosing acquisition's remaining budget. */
  readonly limits: {
    readonly maximumRecordBytes: number;
    readonly maximumRecords: number;
  };
  readonly scope: EvidenceScope;
  readonly source: PolicyEvaluationReplayResultSource;
}

export class PolicyEvaluationReplayResultReadInputError extends TypeError {
  readonly code = "policy_evaluation_replay_result_read_input_invalid";

  constructor(options?: ErrorOptions) {
    super(
      "Replay result acquisition requires an exact source, scope, UTC time, and finite limits",
      options,
    );
    this.name = "PolicyEvaluationReplayResultReadInputError";
  }
}

export class PolicyEvaluationReplayResultReadLimitError extends RangeError {
  readonly code = "policy_evaluation_replay_result_read_limit_exceeded";

  constructor(readonly dimension: "records" | "record_bytes") {
    super(`Replay result acquisition exceeded its ${dimension} admission limit`);
    this.name = "PolicyEvaluationReplayResultReadLimitError";
  }
}

function captureInput(
  input: PolicyEvaluationReplayResultReadInput,
): PolicyEvaluationReplayResultReadInput {
  try {
    if (
      Object.keys(input).some(
        (key) => !["evaluationTime", "limits", "scope", "source"].includes(key),
      )
    ) {
      throw new TypeError("Unexpected acquisition input field");
    }
    const scope = EvidenceScopeSchema.parse(input.scope);
    const evaluationTime = PolicyEvaluationTimeSchema.parse(input.evaluationTime);
    const source = PolicyEvaluationSourceReferenceSchema.parse(input.source);
    if (source.kind !== "replay_result") throw new TypeError("Unsupported source kind");
    const { maximumRecordBytes, maximumRecords } = input.limits;
    if (
      Object.keys(input.limits).some(
        (key) => !["maximumRecordBytes", "maximumRecords"].includes(key),
      ) ||
      !Number.isSafeInteger(maximumRecordBytes) ||
      maximumRecordBytes < 1 ||
      maximumRecordBytes > MAX_POLICY_EVALUATION_ACQUISITION_RECORD_BYTES ||
      !Number.isSafeInteger(maximumRecords) ||
      maximumRecords < 2 ||
      maximumRecords > MAX_POLICY_EVALUATION_ACQUISITION_RECORDS
    )
      throw new TypeError("Invalid acquisition limits");
    return { evaluationTime, limits: { maximumRecordBytes, maximumRecords }, scope, source };
  } catch (cause) {
    throw new PolicyEvaluationReplayResultReadInputError({ cause });
  }
}

/** Count all retained rows before schema parsing; never truncate an oversized history. */
function checkHistoryCount(raw: unknown, maximumRecords: number): void {
  if (typeof raw !== "object" || raw === null) return;
  let count = 1; // The job root, including its embedded terminal receipt.
  if (Reflect.get(raw, "cancellationRequest") != null) count += 1;
  for (const key of [
    "attempts",
    "budgetLedger",
    "cancellationAcknowledgements",
    "executionObservations",
    "usageObservations",
  ]) {
    const rows: unknown = Reflect.get(raw, key);
    if (Array.isArray(rows)) count += rows.length;
  }
  if (count > maximumRecords) throw new PolicyEvaluationReplayResultReadLimitError("records");
}

/**
 * Read-only record acquisition, not replay execution, recursive lineage, or snapshot sealing.
 * The caller must authorize the exact scope first. findJob must use read-only database authority;
 * this method pick does not make a control/worker credential safe to share with a policy worker.
 */
export async function readPolicyEvaluationReplayResult(
  input: PolicyEvaluationReplayResultReadInput,
  repository: Pick<ReplayJobControlRepository, "findJob">,
): Promise<PolicyEvaluationDefinitionRead<ReplayJobSnapshot, PolicyEvaluationReplayResultSource>> {
  const { evaluationTime, limits, scope, source } = captureInput(input);
  const raw = await repository.findJob(structuredClone(scope), source.reference.jobId);
  if (raw === null) return { observation: { status: "missing" }, record: null, source };
  checkHistoryCount(raw, limits.maximumRecords);
  const parsed = ReplayJobSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      observation: { reason: "record_invalid", status: "unavailable" },
      record: null,
      source,
    };
  }

  // Strict parsing has rejected unknown fields and invalid values. Normalize only schema-admitted
  // optional undefined properties to their absent JSON representation, as on database/HTTP reads.
  // In-memory state transitions legitimately leave optional fields such as currentLease undefined.
  const record = JSON.parse(JSON.stringify(parsed.data)) as ReplayJobSnapshot;
  const bytes = encodeEvaluationCanonicalJson(record);
  if (bytes.byteLength > limits.maximumRecordBytes) {
    throw new PolicyEvaluationReplayResultReadLimitError("record_bytes");
  }

  // A successful source must be the terminal, latest attempt, not a favorable historical attempt.
  // The shared snapshot schema checks root/attempt plans, terminal identity, history, and fences.
  const latest = record.attempts.at(-1);
  const retained = EvaluationReplayResultReferenceSchema.safeParse({
    attemptId: latest?.attemptId,
    completedAt: latest?.endedAt,
    jobId: record.job.jobId,
    plan: record.job.plan,
    result: latest?.result,
    targetRelease: latest?.targetRelease,
    terminalCode: record.job.terminal?.code,
    terminalStatus: record.job.status,
  });
  if (
    !retained.success ||
    record.job.scope.tenantId !== scope.tenantId ||
    record.job.scope.projectId !== scope.projectId ||
    record.job.scope.environmentId !== scope.environmentId ||
    policyEvaluationTimestampOrderKey(retained.data.completedAt) !==
      policyEvaluationTimestampOrderKey(source.reference.completedAt) ||
    !Buffer.from(encodeEvaluationCanonicalJson(retained.data)).equals(
      // Compare instants exactly above, without rewriting timestamps in the returned record/hash.
      encodeEvaluationCanonicalJson({
        ...source.reference,
        completedAt: retained.data.completedAt,
      }),
    )
  ) {
    return {
      observation: { reason: "reference_mismatch", status: "unavailable" },
      record: null,
      source,
    };
  }

  const timestamps = [
    record.job.createdAt,
    record.job.startedAt,
    record.job.terminal?.committedAt,
    ...record.attempts.flatMap((attempt) => [attempt.startedAt, attempt.endedAt]),
    ...record.budgetLedger.map((entry) =>
      entry.entryType === "reservation" ? entry.reservedAt : entry.reconciledAt,
    ),
    // Cancellation cannot coexist with a successful terminal result; the shared schema rejects it.
    ...record.executionObservations.map((entry) => entry.observedAt),
    ...record.usageObservations.map((entry) => entry.observedAt),
  ].filter((value): value is string => value !== undefined);
  const cut = policyEvaluationTimestampOrderKey(evaluationTime);
  if (timestamps.some((value) => policyEvaluationTimestampOrderKey(value) > cut)) {
    return {
      observation: { reason: "not_yet_available", status: "unavailable" },
      record: null,
      source,
    };
  }
  return {
    observation: {
      recordSha256: createHash("sha256").update(bytes).digest("hex"),
      status: "verified",
    },
    record,
    source,
  };
}
