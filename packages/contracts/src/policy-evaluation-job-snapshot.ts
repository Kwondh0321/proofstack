import { z } from "zod";
import {
  PolicyEvaluationAttemptSchema,
  PolicyEvaluationCancellationSchema,
  PolicyEvaluationUsageSchema,
} from "./policy-evaluation-attempt.js";
import { PolicyEvaluationJobSchema } from "./policy-evaluation-job.js";
import {
  MAX_POLICY_EVALUATION_ATTEMPTS,
  PolicyEvaluationRequestSchema,
} from "./policy-evaluation-request.js";
import {
  POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND,
  policyEvaluationTimestampOrderKey,
} from "./policy-evaluation-time.js";
import { serializeEvaluationCanonicalJson } from "./evaluation-definition-encoding.js";
import { PolicyEvaluationAcquisitionAllowanceSchema } from "./policy-evaluation-acquisition-allowance.js";

/** Complete bounded scheduler graph. Store/fence/atomic-publication authority is separate. */
const JobSnapshotObjectSchema = z
  .object({
    request: PolicyEvaluationRequestSchema,
    job: PolicyEvaluationJobSchema,
    attempts: z.array(PolicyEvaluationAttemptSchema).max(MAX_POLICY_EVALUATION_ATTEMPTS),
    cancellation: PolicyEvaluationCancellationSchema.nullable(),
    usage: PolicyEvaluationUsageSchema,
    // Absence remains absence: never add a default field to historical canonical graphs.
    acquisitionAllowance: PolicyEvaluationAcquisitionAllowanceSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (context.issues.length > 0) return;
    const { request, job, attempts, cancellation, usage } = value;
    const time = policyEvaluationTimestampOrderKey;
    const same = (a: unknown, b: unknown) =>
      serializeEvaluationCanonicalJson(a) === serializeEvaluationCanonicalJson(b);
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    const allowance = value.acquisitionAllowance;
    if (allowance) {
      const before = allowance.usageAtReservation;
      if (
        job.status !== "acquiring" ||
        job.snapshot !== null ||
        cancellation !== null ||
        !same(allowance.mutationFence, job.currentLease?.mutationFence) ||
        time(allowance.reservedAt) > time(job.updatedAt) ||
        time(allowance.reservedAt) < time(attempts.at(-1)?.startedAt ?? job.createdAt) ||
        before.reads !== usage.reads ||
        before.records !== usage.records ||
        before.references !== usage.references ||
        before.recordBytes !== usage.recordBytes ||
        before.referenceBytes !== usage.referenceBytes ||
        allowance.limits.reads !== request.limits.maxAcquisitionRecords - before.reads ||
        allowance.limits.records !== request.limits.maxAcquisitionRecords - before.records ||
        allowance.limits.references !== request.limits.maxAcquisitionRecords - before.references ||
        allowance.limits.recordAndReferenceBytes !==
          request.limits.maxAcquisitionRecordBytes - before.recordBytes - before.referenceBytes
      )
        issue(
          "Acquisition allowance must bind one acquiring fence and its exact remaining frozen metadata budget",
        );
    }
    if (
      !same(request.scope, job.scope) ||
      request.evaluationRequestId !== job.request.evaluationRequestId ||
      request.definitionSha256 !== job.request.definitionSha256 ||
      time(job.createdAt) < time(request.createdAt) ||
      job.createdByPrincipalId !== request.createdByPrincipalId
    )
      issue("Job must preserve its exact request, scope and original creator");
    const deadline =
      time(request.createdAt) +
      BigInt(request.limits.totalDeadlineMilliseconds) *
        POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND;
    if (time(job.deadlineAt) !== deadline)
      issue("Job deadline derives once from the original request receipt and frozen limit");
    if (job.attemptCount !== attempts.length || attempts.length > request.limits.maxAttempts)
      issue("Every claimed attempt remains in complete original bounded history");
    if (job.status === "retry_ready" && attempts.length >= request.limits.maxAttempts)
      issue("Retry readiness cannot exceed the original finite attempt ceiling");
    if (
      usage.records > request.limits.maxAcquisitionRecords ||
      usage.reads > request.limits.maxAcquisitionRecords ||
      usage.references > request.limits.maxAcquisitionRecords ||
      usage.recordBytes + usage.referenceBytes > request.limits.maxAcquisitionRecordBytes ||
      usage.artifactReadBytes > request.limits.maxArtifactReadBytes ||
      usage.ruleEvaluations > request.limits.maxRuleEvaluations
    )
      issue("Cumulative job usage cannot exceed its original frozen request limits");
    let previousFence = 0;
    let previousEpoch = 0;
    let previousClosed: string | null = null;
    let boundSnapshot: unknown = null;
    const attemptIds = new Set<string>();
    const leaseIds = new Set<string>();
    for (const [index, attempt] of attempts.entries()) {
      if (
        attemptIds.has(attempt.mutationFence.attemptId) ||
        leaseIds.has(attempt.mutationFence.leaseId)
      )
        issue("Attempt and lease identities cannot be reused across history");
      attemptIds.add(attempt.mutationFence.attemptId);
      leaseIds.add(attempt.mutationFence.leaseId);
      if (
        !same(attempt.scope, job.scope) ||
        attempt.mutationFence.jobId !== job.jobId ||
        attempt.attemptSequence !== index ||
        attempt.mutationFence.fencingToken <= previousFence ||
        attempt.mutationFence.recoveryEpoch < previousEpoch ||
        attempt.mutationFence.recoveryEpoch > job.recoveryEpoch ||
        time(attempt.startedAt) < time(job.createdAt) ||
        time(attempt.startedAt) > time(job.updatedAt)
      )
        issue(
          "Attempt history requires exact scope/job, contiguous sequence and monotone fence/epoch",
        );
      if (index > 0 && (previousClosed === null || time(previousClosed) > time(attempt.startedAt)))
        issue("A replaced attempt must be closed no later than the next original start");
      const maximum =
        time(attempt.startedAt) +
        BigInt(request.limits.perAttemptTimeoutMilliseconds) *
          POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND;
      if (time(attempt.deadlineAt) !== (maximum < deadline ? maximum : deadline))
        issue(
          "Attempt timeout cannot be extended or selected independently of the original request",
        );
      if (attempt.closure !== null && time(attempt.closure.committedAt) > time(job.updatedAt))
        issue("Job receipt cannot precede a contained attempt closure");
      if (attempt.snapshot !== null) {
        if (boundSnapshot !== null && !same(attempt.snapshot, boundSnapshot))
          issue("Every post-seal attempt must reuse the same immutable snapshot");
        boundSnapshot = attempt.snapshot;
      } else if (boundSnapshot !== null)
        issue("Retries cannot return to source acquisition after sealing");
      if (attempt.usageAtClose !== null)
        for (const key of Object.keys(usage) as (keyof typeof usage)[])
          if (attempt.usageAtClose[key] > usage[key])
            issue("Job cannot discard a closed attempt's spent budget");
      for (const key of Object.keys(usage) as (keyof typeof usage)[])
        if (attempt.usageAtStart[key] > usage[key])
          issue("Job cannot discard an open attempt's starting budget");
      if (index > 0) {
        const prior = attempts[index - 1]!.usageAtClose;
        if (prior !== null)
          for (const key of Object.keys(usage) as (keyof typeof usage)[])
            if (attempt.usageAtStart[key] < prior[key])
              issue("Retries cannot reset cumulative usage");
      }
      previousFence = attempt.mutationFence.fencingToken;
      previousEpoch = attempt.mutationFence.recoveryEpoch;
      previousClosed = attempt.closure?.committedAt ?? null;
    }
    const latest = attempts.at(-1);
    if (
      latest &&
      (latest.mutationFence.fencingToken !== job.lastFencingToken ||
        !same(job.snapshot, boundSnapshot))
    )
      issue("Job must retain latest fence and immutable snapshot history");
    if (
      job.currentLease !== null &&
      (!latest ||
        latest.closure !== null ||
        !same(latest.mutationFence, job.currentLease.mutationFence) ||
        latest.deadlineAt !== job.currentLease.attemptDeadlineAt ||
        latest.startedAt !== job.currentLease.acquiredAt)
    )
      issue("Current lease must own the exact still-open latest attempt");
    if (
      job.currentLease !== null &&
      time(job.currentLease.expiresAt) - time(job.currentLease.heartbeatAt) >
        BigInt(request.limits.leaseDurationMilliseconds) *
          POLICY_EVALUATION_TIME_UNITS_PER_MILLISECOND
    )
      issue("Heartbeat cannot extend the original request's frozen lease duration");
    if (job.currentLease === null && latest?.closure === null)
      issue("An unleased job cannot leave its latest attempt open");
    if (
      job.terminal !== null &&
      job.terminal.attemptId !== null &&
      (!latest ||
        job.terminal.attemptId !== latest.mutationFence.attemptId ||
        latest.closure === null)
    )
      issue("Terminal receipt must identify the latest closed deciding attempt");
    if (job.status === "completed" && latest?.closure?.status !== "completed")
      issue("A completed job requires a completed computing attempt, not an interrupted one");
    if (
      latest?.closure?.status === "completed" &&
      time(latest.closure.committedAt) >= time(latest.deadlineAt)
    )
      issue("Completion cannot revive authority at or after the frozen attempt timeout");
    if (job.status === "cancelled" && cancellation === null)
      issue("Cancelled jobs require retained cancellation intent");
    if (
      cancellation !== null &&
      (!same(cancellation.scope, job.scope) ||
        cancellation.jobId !== job.jobId ||
        time(cancellation.requestedAt) < time(job.createdAt) ||
        time(cancellation.requestedAt) > time(job.updatedAt))
    )
      issue("Cancellation must preserve exact job/scope and its original receipt");
  });
export const PolicyEvaluationJobSnapshotSchema = z.preprocess((raw, context) => {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const attempts: unknown = Reflect.get(raw, "attempts");
    if (Array.isArray(attempts) && attempts.length > MAX_POLICY_EVALUATION_ATTEMPTS) {
      context.addIssue({
        code: "custom",
        message: "Attempt history exceeds its fixed admission ceiling",
        path: ["attempts"],
      });
      return z.NEVER;
    }
  }
  return raw;
}, JobSnapshotObjectSchema);
export type PolicyEvaluationJobSnapshot = z.infer<typeof PolicyEvaluationJobSnapshotSchema>;
