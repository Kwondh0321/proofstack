import {
  EvidenceScopeSchema,
  EnqueuePolicyEvaluationRequestSchema,
  OpaqueIdSchema,
  PrincipalContextSchema,
  PolicyEvaluationCancellationSchema,
  PolicyEvaluationUsageSchema,
  PolicyEvaluationWorkerMutationFenceSchema,
  PolicyEvaluationRequestSchema,
  PolicyEvaluationJobSnapshotSchema,
  RequestPolicyEvaluationCancellationSchema,
  PolicyEvaluationJobHistoryHeadSchema,
  PolicyEvaluationJobHistoryPageIndexSchema,
  UtcMillisecondTimestampSchema,
  serializeEvaluationCanonicalJson,
  type EvidenceScope,
  type PrincipalContext,
  type PolicyEvaluationJobSnapshot,
} from "@proofstack/contracts";
import { requireCapability, requireEnvironmentAccess } from "../auth/authorization.js";
import type { Clock } from "../clock.js";
import { ForbiddenError } from "../errors.js";
import type {
  PolicyEvaluationJobControlRepository,
  PolicyEvaluationJobReader,
  PolicyEvaluationJobWorkerRepository,
} from "./policy-evaluation-job-repository.js";
import { digestPolicyEvaluationRequestDefinition } from "./policy-evaluation-request-record-validation.js";
import {
  InvalidPolicyEvaluationJobGraphError,
  validatePolicyEvaluationJobSnapshotRecord,
} from "./policy-evaluation-job-record-validation.js";
import { requirePolicyEvaluationExecution } from "./policy-evaluation-worker-authorization.js";
import {
  PolicyEvaluationJobHistoryError,
  validatePolicyEvaluationJobHistoryPage,
} from "./policy-evaluation-job-history.js";

export class PolicyEvaluationCancellationConflictError extends Error {
  readonly code = "policy_evaluation_cancellation_conflict";
  constructor() {
    super("Cancellation intent already binds another actor or reason");
    this.name = "PolicyEvaluationCancellationConflictError";
  }
}

interface JobRoute {
  readonly principal: PrincipalContext;
  readonly projectId: string;
  readonly environmentId: string;
}
function authorizedScope(
  command: JobRoute,
  capability: "policy:evaluate" | "policy:read" | "policy:evaluation:cancel",
) {
  const principal = PrincipalContextSchema.parse(command.principal);
  requireCapability(principal, capability);
  requireEnvironmentAccess(principal, command.projectId, command.environmentId);
  const scope = EvidenceScopeSchema.parse({
    tenantId: principal.tenantId,
    projectId: command.projectId,
    environmentId: command.environmentId,
  });
  return { principal, scope };
}
function returnedJob(
  raw: unknown,
  scope: EvidenceScope,
  jobId?: string,
): PolicyEvaluationJobSnapshot {
  // Extract identity only after bounded graph parsing in the owning validator. Query scope/ID
  // remain independent; request bindings are separately checked by enqueue below.
  const parsed = PolicyEvaluationJobSnapshotSchema.safeParse(raw);
  if (!parsed.success)
    throw new InvalidPolicyEvaluationJobGraphError("Stored policy job graph is malformed", {
      cause: parsed.error,
    });
  const record = parsed.data;
  return validatePolicyEvaluationJobSnapshotRecord({
    expected: {
      scope,
      job: { jobId: jobId ?? record.job.jobId, definitionSha256: record.job.definitionSha256 },
    },
    snapshot: raw,
  });
}
/** Caller never supplies receipts, scope overrides, job identity, worker identity or verdicts. */
export async function enqueuePolicyEvaluationJob(
  command: JobRoute & { readonly input: unknown },
  dependencies: {
    readonly repository: PolicyEvaluationJobControlRepository;
    readonly clock: Clock;
    readonly newJobId: () => string;
  },
) {
  const { principal, scope } = authorizedScope(command, "policy:evaluate");
  const definition = EnqueuePolicyEvaluationRequestSchema.parse(command.input);
  const request = PolicyEvaluationRequestSchema.parse({
    ...definition,
    scope,
    schemaVersion: "0.1",
    createdAt: UtcMillisecondTimestampSchema.parse(dependencies.clock.now().toISOString()),
    createdByPrincipalId: principal.principalId,
    definitionSha256: digestPolicyEvaluationRequestDefinition(scope, definition),
  });
  const jobId = OpaqueIdSchema.parse(dependencies.newJobId());
  const result = await dependencies.repository.createJob({ request, jobId });
  if (typeof result.created !== "boolean")
    throw new InvalidPolicyEvaluationJobGraphError(
      "Policy repository returned an invalid creation receipt",
    );
  const snapshot = returnedJob(result.snapshot, scope, result.created ? jobId : undefined);
  if (
    snapshot.request.evaluationRequestId !== request.evaluationRequestId ||
    snapshot.request.definitionSha256 !== request.definitionSha256
  )
    throw new InvalidPolicyEvaluationJobGraphError(
      "Policy repository substituted the original evaluation request",
    );
  return { created: result.created, snapshot };
}
export async function readPolicyEvaluationJob(
  command: JobRoute & { readonly jobId: string },
  repository: PolicyEvaluationJobReader,
) {
  const { scope } = authorizedScope(command, "policy:read");
  const jobId = OpaqueIdSchema.parse(command.jobId);
  const raw = await repository.findJob(scope, jobId);
  return raw === null ? null : returnedJob(raw, scope, jobId);
}
export async function readPolicyEvaluationJobHistoryHead(
  command: JobRoute & { readonly jobId: string },
  repository: PolicyEvaluationJobReader,
) {
  const { scope } = authorizedScope(command, "policy:read");
  const jobId = OpaqueIdSchema.parse(command.jobId);
  const raw = await repository.findHistoryHead(scope, jobId);
  if (raw === null) return null;
  const parsed = PolicyEvaluationJobHistoryHeadSchema.safeParse(raw);
  if (!parsed.success)
    throw new PolicyEvaluationJobHistoryError("Stored policy history head is malformed");
  const head = parsed.data;
  if (
    head.job.jobId !== jobId ||
    serializeEvaluationCanonicalJson(head.scope) !== serializeEvaluationCanonicalJson(scope)
  )
    throw new PolicyEvaluationJobHistoryError(
      "Policy history repository substituted exact query scope/job",
    );
  return head;
}
export async function readPolicyEvaluationJobHistoryPage(
  command: JobRoute & {
    readonly jobId: string;
    readonly head: unknown;
    readonly pageIndex: unknown;
  },
  repository: PolicyEvaluationJobReader,
) {
  const { scope } = authorizedScope(command, "policy:read");
  const jobId = OpaqueIdSchema.parse(command.jobId);
  const head = PolicyEvaluationJobHistoryHeadSchema.parse(command.head);
  if (
    head.job.jobId !== jobId ||
    serializeEvaluationCanonicalJson(head.scope) !== serializeEvaluationCanonicalJson(scope)
  )
    throw new ForbiddenError("Policy history head does not match authorized route scope/job");
  const pageIndex = PolicyEvaluationJobHistoryPageIndexSchema.parse(command.pageIndex);
  const raw = await repository.readHistoryPage(head, pageIndex);
  let page: ReturnType<typeof validatePolicyEvaluationJobHistoryPage>;
  try {
    page = validatePolicyEvaluationJobHistoryPage({ expected: head, page: raw });
  } catch (cause) {
    if (cause instanceof PolicyEvaluationJobHistoryError) throw cause;
    throw new PolicyEvaluationJobHistoryError("Stored policy history page is malformed");
  }
  if (page.pageIndex !== pageIndex)
    throw new PolicyEvaluationJobHistoryError(
      "Policy history repository substituted requested page index",
    );
  return page;
}
export async function cancelPolicyEvaluationJobRequest(
  command: JobRoute & { readonly jobId: string; readonly input: unknown },
  dependencies: {
    readonly repository: PolicyEvaluationJobControlRepository;
    readonly newCancellationId: () => string;
  },
) {
  const { principal, scope } = authorizedScope(command, "policy:evaluation:cancel");
  const jobId = OpaqueIdSchema.parse(command.jobId);
  // Reuse the public reason-only parser; ID, principal and receipt remain server-owned.
  const input = RequestPolicyEvaluationCancellationSchema.parse(command.input);
  const previousRaw = await dependencies.repository.findJob(scope, jobId);
  const previous =
    previousRaw === null ? null : returnedJob(previousRaw, scope, jobId).cancellation;
  if (
    previous !== null &&
    (previous.reason !== input.reason || previous.requestedByPrincipalId !== principal.principalId)
  )
    throw new PolicyEvaluationCancellationConflictError();
  const cancellationId =
    previous?.cancellationId ?? OpaqueIdSchema.parse(dependencies.newCancellationId());
  const raw = await dependencies.repository.cancelJob({
    scope,
    jobId,
    principalId: principal.principalId,
    cancellationId,
    reason: input.reason,
  });
  const snapshot = returnedJob(raw, scope, jobId);
  const parsedIntent = PolicyEvaluationCancellationSchema.safeParse(snapshot.cancellation);
  if (!parsedIntent.success)
    throw new InvalidPolicyEvaluationJobGraphError(
      "Policy cancellation omitted its original intent",
      {
        cause: parsedIntent.error,
      },
    );
  const intent = parsedIntent.data;
  if (
    (previous !== null && intent.cancellationId !== cancellationId) ||
    intent.reason !== input.reason ||
    intent.requestedByPrincipalId !== principal.principalId
  )
    throw new InvalidPolicyEvaluationJobGraphError(
      "Policy repository substituted cancellation intent",
    );
  return snapshot;
}
function workerScope(command: JobRoute) {
  const principal = PrincipalContextSchema.parse(command.principal);
  const scope = {
    tenantId: principal.tenantId,
    projectId: command.projectId,
    environmentId: command.environmentId,
  };
  requirePolicyEvaluationExecution(principal, scope);
  return { principal, scope: EvidenceScopeSchema.parse(scope) };
}
export async function claimPolicyEvaluationJobRequest(
  command: JobRoute & { readonly jobId: string },
  dependencies: {
    readonly repository: PolicyEvaluationJobWorkerRepository;
    readonly newAttemptId: () => string;
    readonly newLeaseId: () => string;
  },
) {
  const { principal, scope } = workerScope(command);
  const jobId = OpaqueIdSchema.parse(command.jobId);
  const attemptId = OpaqueIdSchema.parse(dependencies.newAttemptId());
  const leaseId = OpaqueIdSchema.parse(dependencies.newLeaseId());
  const raw = await dependencies.repository.claimJob({
    scope,
    jobId,
    workerId: principal.principalId,
    attemptId,
    leaseId,
  });
  const snapshot = returnedJob(raw, scope, jobId);
  if (snapshot.job.status === "budget_exhausted") return snapshot;
  const current = snapshot.job.currentLease?.mutationFence;
  if (
    current?.workerId !== principal.principalId ||
    current.attemptId !== attemptId ||
    current.leaseId !== leaseId
  )
    throw new Error("Policy repository substituted the authenticated worker");
  return snapshot;
}
/** Exact authenticated worker/fence precedes usage parsing and repository access. */
export async function mutatePolicyEvaluationWorkerJob(
  command: JobRoute & {
    readonly fence: unknown;
    readonly operation: "heartbeat" | "reserve" | "interrupt";
    readonly input?: unknown;
  },
  repository: PolicyEvaluationJobWorkerRepository,
) {
  const { principal, scope } = workerScope(command);
  const fence = PolicyEvaluationWorkerMutationFenceSchema.parse(command.fence);
  if (fence.workerId !== principal.principalId)
    throw new ForbiddenError("Policy fence belongs to another worker principal");
  let raw: PolicyEvaluationJobSnapshot;
  if (command.operation === "heartbeat") raw = await repository.heartbeatJob({ scope, fence });
  else if (command.operation === "reserve")
    raw = await repository.reserveUsage({
      scope,
      fence,
      delta: PolicyEvaluationUsageSchema.parse(command.input),
    });
  else if (command.operation === "interrupt") {
    const reason = command.input;
    if (
      reason !== "source_revision_changed" &&
      reason !== "source_temporarily_unavailable" &&
      reason !== "worker_interrupted"
    )
      throw new Error("Invalid fixed worker interruption reason");
    raw = await repository.interruptJob({ scope, fence, reason });
  } else throw new Error("Invalid fixed policy worker operation");
  const snapshot = returnedJob(raw, scope, fence.jobId);
  const latest = snapshot.attempts.at(-1);
  if (
    !latest ||
    serializeEvaluationCanonicalJson(latest.mutationFence) !==
      serializeEvaluationCanonicalJson(fence)
  )
    throw new Error("Policy repository substituted the exact mutation attempt");
  return snapshot;
}
