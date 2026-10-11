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
import type {
  PolicyEvaluationDefinitionCapture,
  PolicyEvaluationDefinitionRead,
} from "@proofstack/core";
import type { ReplayJobControlRepository } from "./replay-job-repository.js";

export type PolicyEvaluationReplayResultSource = Extract<
  PolicyEvaluationSourceReference,
  { readonly kind: "replay_result" }
>;

export type PolicyEvaluationReplayResultRead = PolicyEvaluationDefinitionRead<
  ReplayJobSnapshot,
  PolicyEvaluationReplayResultSource
>;
export type PolicyEvaluationReplayResultCapture = PolicyEvaluationDefinitionCapture<
  ReplayJobSnapshot,
  PolicyEvaluationReplayResultSource
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
): Promise<PolicyEvaluationReplayResultRead> {
  return (await readReplayResultCapture(input, repository, false)).read;
}

/** Original complete successful history, not execution, current authority or snapshot sealing. */
export function readPolicyEvaluationReplayResultCapture(
  input: PolicyEvaluationReplayResultReadInput,
  repository: Pick<ReplayJobControlRepository, "findJob">,
): Promise<PolicyEvaluationReplayResultCapture> {
  return readReplayResultCapture(input, repository, true);
}

async function readReplayResultCapture(
  input: PolicyEvaluationReplayResultReadInput,
  repository: Pick<ReplayJobControlRepository, "findJob">,
  retainStorage: boolean,
): Promise<PolicyEvaluationReplayResultCapture> {
  const captured = captureInput(input);
  const raw = await repository.findJob(
    structuredClone(captured.scope),
    captured.source.reference.jobId,
  );
  return inspectCapturedReplayResult(captured, raw, retainStorage);
}

/**
 * Reinspect a materialized job history without repository I/O or replay execution. A supplied
 * value (including null) cannot establish that storage was consulted or its history is complete.
 * This computes a new observation; capture integrity additionally requires comparing it with
 * the original source and full-record hash before dependency traversal.
 */
export function inspectPolicyEvaluationReplayResult(
  input: PolicyEvaluationReplayResultReadInput,
  raw: unknown,
): PolicyEvaluationReplayResultRead {
  return inspectCapturedReplayResult(captureInput(input), raw, false).read;
}

/** Revalidates whole original storage and receipts at the unchanged original semantic cut. */
export function inspectPolicyEvaluationReplayResultCapture(
  input: PolicyEvaluationReplayResultReadInput,
  raw: unknown,
): PolicyEvaluationReplayResultCapture {
  return inspectCapturedReplayResult(captureInput(input), raw, true);
}

function inspectCapturedReplayResult(
  { evaluationTime, limits, scope, source }: PolicyEvaluationReplayResultReadInput,
  raw: unknown,
  retainStorage: boolean,
): PolicyEvaluationReplayResultCapture {
  const unavailable = (
    observation: Exclude<PolicyEvaluationReplayResultRead["observation"], { status: "verified" }>,
  ): PolicyEvaluationReplayResultCapture => ({
    read: { observation, record: null, source },
    storage: null,
  });
  if (raw === null) return unavailable({ status: "missing" });
  checkHistoryCount(raw, limits.maximumRecords);
  const parsed = ReplayJobSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    return unavailable({ reason: "record_invalid", status: "unavailable" });
  }

  // A materialized port can expose changing getters. The pre-parse check rejects oversized
  // arrays before element access; also admit the complete owned parsed history, so a smaller
  // first observation cannot authorize additional returned rows. This is response admission,
  // not a bounded wire decoder or an interruption guarantee for the originating I/O.
  checkHistoryCount(parsed.data, limits.maximumRecords);

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
    return unavailable({ reason: "reference_mismatch", status: "unavailable" });
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
  // Keep the exact text of the latest actual constituent receipt. Equal instants keep the first
  // original occurrence; never synthesize a cut/completion clock or round a timestamp through Date.
  let receiptTime = record.job.createdAt;
  let latestReceipt = policyEvaluationTimestampOrderKey(receiptTime);
  for (const timestamp of timestamps) {
    const order = policyEvaluationTimestampOrderKey(timestamp);
    if (order > latestReceipt) {
      latestReceipt = order;
      receiptTime = timestamp;
    }
  }
  const future = latestReceipt > cut;
  if (future && !retainStorage)
    return unavailable({ reason: "not_yet_available", status: "unavailable" });
  const recordSha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    read: future
      ? unavailable({ reason: "not_yet_available", status: "unavailable" }).read
      : { observation: { recordSha256, status: "verified" }, record, source },
    storage: retainStorage ? { record: structuredClone(record), recordSha256, receiptTime } : null,
  };
}
