import {
  encodeEvaluationCanonicalJson,
  PolicyEvaluationManifestEntrySchema,
  policyEvaluationTimestampOrderKey,
  REPLAY_BUDGET_DIMENSIONS,
  serializeEvaluationCanonicalJson,
  type ReplayAttempt,
  type ReplayAttemptError,
  type ReplayJobSnapshot,
  type ReplayPlan,
} from "@proofstack/contracts";
import {
  PolicyEvaluationEvidenceReferenceError,
  type PolicyEvaluationEvidenceReferenceLimits,
  PolicyEvaluationReferenceCollector,
  revalidatePolicyEvaluationCapturedRecord,
  revalidatePolicyEvaluationCapturedStorage,
} from "@proofstack/core";
import {
  inspectPolicyEvaluationReplayDefinition,
  inspectPolicyEvaluationReplayDefinitionCapture,
  type PolicyEvaluationReplayDefinitionCapture,
  type PolicyEvaluationReplayDefinitionRead,
} from "./policy-evaluation-replay-definition-reader.js";
import {
  inspectPolicyEvaluationReplayResult,
  inspectPolicyEvaluationReplayResultCapture,
  type PolicyEvaluationReplayResultCapture,
  type PolicyEvaluationReplayResultRead,
  type PolicyEvaluationReplayResultReadInput,
  type PolicyEvaluationReplayResultSource,
} from "./policy-evaluation-replay-result-reader.js";
import { summarizeReplayBudgetLedger } from "./replay-budget.js";
import { decideReplayRetry } from "./replay-retry.js";

export interface PolicyReplayResultCheck {
  readonly kind:
    | "plan_receipt"
    | "start_receipt"
    | "attempt_count"
    | "target_release"
    | "runtime_profile"
    | "isolation_profile"
    | "worker_protocol"
    | "retry_declaration"
    | "retry_timing"
    | "budget_policy"
    | "budget_reconciliation_receipt"
    | "budget_boundary"
    | "execution_boundary"
    | "usage_boundary"
    | "history_receipt"
    | "budget_closed"
    | "budget_overrun"
    | "budget_usage";
  readonly path: string;
  readonly observation:
    | { readonly status: "matched" | "mismatch" }
    | {
        readonly status: "unavailable";
        readonly reason: "plan_unavailable" | "lease_expiry_unretained" | "usage_unavailable";
      };
}

export interface PolicyReplayResultBindings {
  readonly source: PolicyEvaluationReplayResultRead["source"];
  readonly recordSha256: string;
  readonly plan: {
    readonly source: Extract<
      PolicyEvaluationReplayDefinitionRead["source"],
      { kind: "replay_plan" }
    >;
    readonly recordObservation: PolicyEvaluationReplayDefinitionRead["observation"];
  };
  readonly checks: readonly PolicyReplayResultCheck[];
}

export interface PolicyStoredReplayResultBindings {
  readonly authorityBoundary: "stored_relationships_only";
  readonly scope: PolicyEvaluationReplayResultReadInput["scope"];
  readonly evaluationTime: string;
  readonly source: PolicyEvaluationReplayResultSource;
  readonly recordSha256: string;
  readonly receiptTime: string;
  readonly recordObservation: PolicyEvaluationReplayResultRead["observation"];
  readonly plan: {
    readonly source: PolicyReplayResultBindings["plan"]["source"];
    readonly recordObservation: PolicyEvaluationReplayDefinitionRead["observation"];
    readonly storage: { readonly recordSha256: string; readonly receiptTime: string } | null;
  };
  readonly checks: readonly PolicyReplayResultCheck[];
  readonly inspectionUsage: { readonly references: number; readonly referenceBytes: number };
}

/** Full original successful history/plan binding; future material remains unavailable evidence. */
export function inspectPolicyEvaluationStoredReplayResultBindings(
  input: PolicyEvaluationReplayResultReadInput,
  evidence: PolicyEvaluationReplayResultCapture,
  planEvidence: PolicyEvaluationReplayDefinitionCapture,
  limits: PolicyEvaluationEvidenceReferenceLimits,
): PolicyStoredReplayResultBindings {
  try {
    new PolicyEvaluationReferenceCollector(limits);
    const ownedInput = structuredClone(input);
    let references = 0;
    let referenceBytes = 0;
    const admit = (value: unknown, count: number) => {
      if (count > limits.maxReferences - references)
        throw new PolicyEvaluationEvidenceReferenceError("reference_limit_exceeded");
      const bytes = Buffer.byteLength(serializeEvaluationCanonicalJson(value), "utf8");
      if (bytes > limits.maxReferenceBytes - referenceBytes)
        throw new PolicyEvaluationEvidenceReferenceError("reference_bytes_exceeded");
      references += count;
      referenceBytes += bytes;
    };
    const { limits: _readLimits, ...context } = ownedInput;
    admit(context, 1);
    admit(evidence, 1);
    const checked = revalidatePolicyEvaluationCapturedStorage(
      ownedInput,
      evidence,
      inspectPolicyEvaluationReplayResultCapture,
    );
    const history = checked.storage.record;
    for (const rows of [
      history.attempts,
      history.budgetLedger,
      history.cancellationAcknowledgements,
      history.executionObservations,
      history.usageObservations,
    ])
      for (const row of rows) admit(row, 1);
    const planSource = { kind: "replay_plan" as const, reference: checked.storage.record.job.plan };
    admit(planEvidence, 1);
    if (
      !planEvidence ||
      Reflect.ownKeys(planEvidence).length !== 2 ||
      !planEvidence.read ||
      Reflect.ownKeys(planEvidence.read).length !== 3
    )
      throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
    const planEntry = PolicyEvaluationManifestEntrySchema.parse({
      source: planEvidence.read.source,
      observation: planEvidence.read.observation,
    });
    if (!same(planEntry.source, planSource))
      throw new PolicyEvaluationEvidenceReferenceError("observation_mismatch");
    let plan: ReplayPlan | null = null;
    let storage: PolicyStoredReplayResultBindings["plan"]["storage"] = null;
    if (planEvidence.storage === null) {
      if (
        planEvidence.read.record !== null ||
        planEntry.observation.status === "verified" ||
        (planEntry.observation.status === "unavailable" &&
          planEntry.observation.reason === "not_yet_available")
      )
        throw new PolicyEvaluationEvidenceReferenceError("observation_mismatch");
    } else {
      const retained = revalidatePolicyEvaluationCapturedStorage(
        { scope: ownedInput.scope, evaluationTime: ownedInput.evaluationTime, source: planSource },
        planEvidence,
        inspectPolicyEvaluationReplayDefinitionCapture,
      );
      plan = retained.storage.record as ReplayPlan;
      storage = {
        recordSha256: retained.storage.recordSha256,
        receiptTime: retained.storage.receiptTime,
      };
    }
    const out = new PolicyEvaluationReferenceCollector({
      maxReferences: limits.maxReferences - references,
      maxReferenceBytes: limits.maxReferenceBytes - referenceBytes,
    });
    out.record("/job/plan", "replay_plan", planSource.reference);
    const usage = out.result();
    references += usage.references.length;
    referenceBytes += usage.referenceBytes;
    const report = {
      authorityBoundary: "stored_relationships_only" as const,
      scope: ownedInput.scope,
      evaluationTime: ownedInput.evaluationTime,
      source: checked.read.source,
      recordSha256: checked.storage.recordSha256,
      receiptTime: checked.storage.receiptTime,
      recordObservation: checked.read.observation,
      plan: { source: planSource, recordObservation: planEntry.observation, storage },
      checks: inspectResultChecks(checked.storage.record, plan),
    };
    admit(report, 0);
    return structuredClone({ ...report, inspectionUsage: { references, referenceBytes } });
  } catch (cause) {
    if (cause instanceof PolicyEvaluationEvidenceReferenceError) throw cause;
    throw new PolicyEvaluationEvidenceReferenceError("input_invalid", { cause });
  }
}

function same(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeEvaluationCanonicalJson(left)).equals(
    encodeEvaluationCanonicalJson(right),
  );
}

function strictRead(value: unknown): void {
  if (
    !value ||
    Reflect.ownKeys(value as object).length !== 3 ||
    !["record", "source", "observation"].every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && "value" in descriptor;
    })
  )
    throw new PolicyEvaluationEvidenceReferenceError("input_invalid");
}

/**
 * Relates one revalidated retained result to its exact plan, including prior unsuccessful attempts.
 * This is declared-history consistency, not execution/content/authority proof or a policy verdict.
 * Output is bounded by the admitted history rows, with a fixed number of checks per row.
 */
export function inspectPolicyEvaluationReplayResultBindings(
  input: PolicyEvaluationReplayResultReadInput,
  evidence: PolicyEvaluationReplayResultRead,
  planEvidence: PolicyEvaluationReplayDefinitionRead,
): PolicyReplayResultBindings {
  try {
    const capturedInput = structuredClone(input);
    strictRead(evidence);
    strictRead(planEvidence);
    const checked = revalidatePolicyEvaluationCapturedRecord<
      PolicyEvaluationReplayResultReadInput,
      ReplayJobSnapshot,
      PolicyEvaluationReplayResultSource
    >(capturedInput, evidence, inspectPolicyEvaluationReplayResult);
    const { record, source } = checked;
    const planSource = { kind: "replay_plan" as const, reference: record.job.plan };
    const planEntry = PolicyEvaluationManifestEntrySchema.parse({
      source: planEvidence.source,
      observation: planEvidence.observation,
    });
    if (!same(planEntry.source, planSource))
      throw new PolicyEvaluationEvidenceReferenceError("observation_mismatch");
    let plan: ReplayPlan | null = null;
    if (planEntry.observation.status === "verified") {
      plan = revalidatePolicyEvaluationCapturedRecord(
        {
          scope: capturedInput.scope,
          evaluationTime: capturedInput.evaluationTime,
          source: planSource,
        },
        planEvidence,
        inspectPolicyEvaluationReplayDefinition,
      ).record as ReplayPlan;
    } else if (planEvidence.record !== null) {
      throw new PolicyEvaluationEvidenceReferenceError("observation_mismatch");
    }
    const checks = inspectResultChecks(record, plan);
    return {
      source,
      recordSha256: checked.observation.recordSha256,
      plan: { source: planSource, recordObservation: planEntry.observation },
      checks,
    };
  } catch (cause) {
    if (cause instanceof PolicyEvaluationEvidenceReferenceError) throw cause;
    throw new PolicyEvaluationEvidenceReferenceError("input_invalid", { cause });
  }
}

/** Shared original history rules; never recaptures or changes the semantic cut. */
function inspectResultChecks(
  record: ReplayJobSnapshot,
  plan: ReplayPlan | null,
): PolicyReplayResultCheck[] {
  const checks: PolicyReplayResultCheck[] = [];
  const check = (
    kind: PolicyReplayResultCheck["kind"],
    path: string,
    match: boolean | null,
    reason: Extract<
      PolicyReplayResultCheck["observation"],
      { status: "unavailable" }
    >["reason"] = "plan_unavailable",
  ) => {
    checks.push({
      kind,
      path,
      observation:
        match === null
          ? { status: "unavailable", reason }
          : { status: match ? "matched" : "mismatch" },
    });
  };
  check(
    "plan_receipt",
    "/job/createdAt",
    plan
      ? policyEvaluationTimestampOrderKey(plan.createdAt) <=
          policyEvaluationTimestampOrderKey(record.job.createdAt)
      : null,
  );
  check(
    "start_receipt",
    "/job/startedAt",
    record.job.startedAt === (record.attempts[0] as ReplayAttempt).startedAt,
  );
  check(
    "attempt_count",
    "/attempts",
    plan ? record.attempts.length <= plan.retryPolicy.maxAttempts : null,
  );
  const attempts = new Map(record.attempts.map((a) => [a.attemptId, a]));
  const receipt = (path: string, at: string, attemptId: string) => {
    // The fixed result inspector proves all referenced attempts exist and are closed.
    const attempt = attempts.get(attemptId) as ReplayAttempt;
    const value = policyEvaluationTimestampOrderKey(at);
    check(
      "history_receipt",
      path,
      value >= policyEvaluationTimestampOrderKey(attempt.startedAt) &&
        value <= policyEvaluationTimestampOrderKey(attempt.endedAt as string),
    );
  };
  for (const [index, attempt] of record.attempts.entries()) {
    const path = `/attempts/${index}`;
    check(
      "target_release",
      `${path}/targetRelease`,
      plan ? same(attempt.targetRelease, plan.targetRelease) : null,
    );
    check(
      "runtime_profile",
      `${path}/runtimeProfile`,
      plan ? same(attempt.runtimeProfile, plan.runtimeProfile) : null,
    );
    check(
      "isolation_profile",
      `${path}/isolationProfile`,
      plan ? same(attempt.isolationProfile, plan.isolationProfile) : null,
    );
    check(
      "worker_protocol",
      `${path}/workerProtocol`,
      plan ? same(attempt.workerProtocol, plan.workerProtocol) : null,
    );
    const next = record.attempts[index + 1];
    if (!next) continue;
    const error = attempt.error;
    // The fixed attempt schema already rejects retry_scheduled with unsafe effect evidence.
    const declared = plan
      ? !!error &&
        (attempt.status === "failed" || attempt.status === "lease_expired") &&
        attempt.retryDisposition === "retry_scheduled" &&
        plan.retryPolicy.automatic &&
        plan.retryPolicy.retryableErrors.some(
          (code) =>
            code === (error.code === "lease_expired" ? "target_process_interrupted" : error.code),
        )
      : null;
    check("retry_declaration", `${path}/retryDisposition`, declared);
    if (!plan) check("retry_timing", path, null);
    else if (attempt.status === "lease_expired") {
      // endedAt is the replacement receipt, not the unretained lease-expiry instant used by
      // the scheduler. Reapplying backoff to endedAt would falsely reject legitimate retries.
      check("retry_timing", path, null, "lease_expiry_unretained");
    } else if (!declared) check("retry_timing", path, false);
    else {
      const retry = decideReplayRetry({
        attemptSequence: attempt.attemptSequence,
        error: error as ReplayAttemptError,
        evaluatedAt: next.startedAt,
        failedAt: attempt.endedAt as string,
        jobStartedAt: record.job.startedAt as string,
        policy: plan.retryPolicy,
      });
      check(
        "retry_timing",
        path,
        retry.eligible && Date.parse(next.startedAt) >= Date.parse(retry.notBefore),
      );
    }
  }
  const boundaries = new Map(plan?.boundaries.map((b) => [b.boundaryId, b]));
  const reservations = new Map<string, string>();
  for (const [index, entry] of record.budgetLedger.entries()) {
    const path = `/budgetLedger/${index}`;
    const at = entry.entryType === "reservation" ? "reservedAt" : "reconciledAt";
    receipt(
      `${path}/${at}`,
      entry.entryType === "reservation" ? entry.reservedAt : entry.reconciledAt,
      entry.mutationFence.attemptId,
    );
    if (entry.entryType !== "reservation") {
      check(
        "budget_reconciliation_receipt",
        `${path}/reconciledAt`,
        policyEvaluationTimestampOrderKey(entry.reconciledAt) >=
          policyEvaluationTimestampOrderKey(reservations.get(entry.reservationId) as string),
      );
      continue;
    }
    reservations.set(entry.reservationId, entry.reservedAt);
    for (const dimension of REPLAY_BUDGET_DIMENSIONS) {
      const value = entry.dimensions[dimension];
      check(
        "budget_policy",
        `${path}/dimensions/${dimension}`,
        plan
          ? value.limit === plan.budget[dimension].limit &&
              value.measurement === plan.budget[dimension].measurement
          : null,
      );
    }
    if (entry.work.kind === "boundary_call") {
      const boundary = boundaries.get(entry.work.boundaryId);
      check(
        "budget_boundary",
        `${path}/work`,
        plan ? boundary?.kind === entry.work.boundaryKind : null,
      );
    }
  }
  for (const [index, entry] of record.executionObservations.entries()) {
    const path = `/executionObservations/${index}`;
    receipt(`${path}/observedAt`, entry.observedAt, entry.mutationFence.attemptId);
    if (entry.payload.kind !== "boundary") continue;
    const boundary = boundaries.get(entry.payload.boundaryId);
    check(
      "execution_boundary",
      `${path}/payload`,
      plan
        ? boundary?.kind === entry.payload.boundaryKind && boundary?.mode === entry.payload.mode
        : null,
    );
  }
  for (const [index, entry] of record.usageObservations.entries()) {
    const path = `/usageObservations/${index}`;
    receipt(`${path}/observedAt`, entry.observedAt, entry.mutationFence.attemptId);
    if (entry.boundaryId !== undefined)
      check("usage_boundary", `${path}/boundaryId`, plan ? boundaries.has(entry.boundaryId) : null);
  }
  const budget = summarizeReplayBudgetLedger(record.budgetLedger);
  check("budget_closed", "/budgetLedger", budget.openReservationIds.length === 0);
  check("budget_overrun", "/budgetLedger", budget.overruns.length === 0);
  check(
    "budget_usage",
    "/budgetLedger",
    budget.disputed.length === 0 ? true : null,
    "usage_unavailable",
  );
  return checks;
}
