import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  EvidenceScopeSchema,
  type RecordedBoundaryRequest,
  type RecordedBoundaryResponse,
  type ReplayCancellationAcknowledgement,
  ReplayJobSchema,
  type ReplayPlan,
  type ReplayWorkerMutationFence,
  ReplayWorkerMutationFenceSchema,
  type TargetRelease,
} from "@proofstack/contracts";
import type {
  ReplayDefinitionRepository,
  ReplayJobRepository,
  ReplayJobSnapshot,
} from "@proofstack/replay";
import {
  measureRecordedStubAttemptUsage,
  reconcileReplayAttemptBudget,
  reserveReplayAttemptBudget,
} from "./attempt-accounting.js";
import { acknowledgeReplayAttemptCancellation } from "./attempt-cancellation.js";
import { completeSupervisedReplayAttempt } from "./attempt-completion.js";
import { recordSupervisedExecutionObservations } from "./attempt-observation-recorder.js";
import { preflightReplayTargetSession } from "./attempt-preflight.js";
import {
  publishSuccessfulReplayAttemptReport,
  type ReplayAttemptReportPublisher,
} from "./attempt-report.js";
import { BoundedReplayTargetOutput } from "./bounded-output.js";
import {
  ReplayAttemptReportError,
  ReplayAttemptRunnerError,
  ReplayTargetLaunchError,
  type ReplayTargetSupervisorFailureCode,
} from "./errors.js";
import { runUnderReplayLease } from "./lease-heartbeat.js";
import { type PreinstalledTargetRegistry, prepareTargetLaunch } from "./target-launch.js";
import {
  superviseReplayTargetProcess,
  type ReplayTargetProcessResult,
} from "./target-process-supervisor.js";

const RUNNER_NAMESPACE = "proofstack.claimed-replay-attempt-runner.v1";
const ISOLATION_CONTROLS = [
  "environment_allowlist",
  "filesystem_mounts",
  "network_policy",
  "no_new_privileges",
  "output_limits",
  "process_boundary",
  "resource_limits",
  "subprocess_policy",
] as const;

export interface ResolveClaimedReplayBoundaryInput {
  readonly boundaryId: string;
  readonly plan: ReplayPlan;
  readonly request: RecordedBoundaryRequest;
  readonly scope: ReturnType<typeof EvidenceScopeSchema.parse>;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly targetRelease: TargetRelease;
  readonly workerFence: ReplayWorkerMutationFence;
}

export interface ClaimedReplayBoundaryResolver {
  resolve(input: ResolveClaimedReplayBoundaryInput): Promise<RecordedBoundaryResponse>;
}

export interface RunClaimedReplayAttemptOptions {
  readonly availableEnvironment: Readonly<Record<string, string | undefined>>;
  readonly boundaryResolver: ClaimedReplayBoundaryResolver;
  readonly definitions: ReplayDefinitionRepository;
  readonly heartbeatIntervalMilliseconds: number;
  readonly leaseDurationMilliseconds: number;
  readonly registry: PreinstalledTargetRegistry;
  readonly reportPublisher: ReplayAttemptReportPublisher;
  readonly repository: ReplayJobRepository;
  readonly scope: unknown;
  readonly signal?: AbortSignal;
  readonly snapshot: ReplayJobSnapshot;
  readonly terminationGraceMilliseconds?: number;
  readonly workerFence: unknown;
  readonly workspaceParent: string;
}

export interface RunClaimedReplayAttemptResult {
  readonly processResult: ReplayTargetProcessResult;
  readonly reservationId?: string;
  readonly sessionId: string;
  readonly snapshot: ReplayJobSnapshot;
}

interface RunnerContext {
  readonly scope: ReturnType<typeof EvidenceScopeSchema.parse>;
  readonly snapshot: ReplayJobSnapshot;
  readonly workerFence: ReplayWorkerMutationFence;
}

interface ExecutedAttempt {
  readonly emittedArtifactBytes: number;
  readonly processResult: ReplayTargetProcessResult;
  readonly result?: Awaited<
    ReturnType<typeof publishSuccessfulReplayAttemptReport>
  >["contentReference"];
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function sessionId(workerFence: ReplayWorkerMutationFence): string {
  return `rts_${digest({
    attemptId: workerFence.attemptId,
    fencingToken: workerFence.fencingToken,
    jobId: workerFence.jobId,
    namespace: RUNNER_NAMESPACE,
  }).slice(0, 40)}`;
}

function validatePolicy(options: RunClaimedReplayAttemptOptions): void {
  const { heartbeatIntervalMilliseconds: interval, leaseDurationMilliseconds: duration } = options;
  const grace = options.terminationGraceMilliseconds;
  if (
    !Number.isSafeInteger(interval) ||
    interval < 1 ||
    !Number.isSafeInteger(duration) ||
    duration < 2 ||
    interval > Math.floor(duration / 2) ||
    (grace !== undefined && (!Number.isSafeInteger(grace) || grace < 1))
  ) {
    throw new ReplayAttemptRunnerError("invalid_runner_policy");
  }
}

function validateContext(options: RunClaimedReplayAttemptOptions): RunnerContext {
  try {
    const scope = EvidenceScopeSchema.parse(options.scope);
    const workerFence = ReplayWorkerMutationFenceSchema.parse(options.workerFence);
    const job = ReplayJobSchema.parse(options.snapshot.job);
    if (
      job.status !== "running" ||
      job.jobId !== workerFence.jobId ||
      !sameJson(job.scope, scope) ||
      !sameJson(job.currentLease?.mutationFence, workerFence)
    ) {
      throw new TypeError("Runner does not own the current fenced replay attempt");
    }
    return { scope, snapshot: { ...options.snapshot, job }, workerFence };
  } catch (error) {
    throw new ReplayAttemptRunnerError("invalid_runner_context", { cause: error });
  }
}

function isolationEvidence() {
  return Object.freeze(
    ISOLATION_CONTROLS.map((control) =>
      Object.freeze({
        control,
        evidenceSha256: digest({ control, verdict: "not_verified" }),
        kind: "isolation" as const,
        verdict: "not_verified" as const,
      }),
    ),
  );
}

function failedProcessResult(
  failureCode: ReplayTargetSupervisorFailureCode,
  release?: TargetRelease,
): ReplayTargetProcessResult {
  const stderrLimit = release?.outputLimits.stderrBytes ?? 1;
  const stdoutLimit = release?.outputLimits.stdoutBytes ?? 1;
  return Object.freeze({
    executionObservations: Object.freeze([]),
    exitCode: -1,
    failureCode,
    isolation: isolationEvidence(),
    runtime: Object.freeze([]),
    signal: null,
    status: failureCode === "worker_cancelled" ? ("cancelled" as const) : ("failed" as const),
    stderr: new BoundedReplayTargetOutput("stderr", stderrLimit).finish(),
    stdout: new BoundedReplayTargetOutput("stdout", stdoutLimit).finish(),
  });
}

function withFailure(
  processResult: ReplayTargetProcessResult,
  failureCode: ReplayTargetSupervisorFailureCode,
): ReplayTargetProcessResult {
  return Object.freeze({
    ...processResult,
    failureCode,
    status: failureCode === "worker_cancelled" ? ("cancelled" as const) : ("failed" as const),
  });
}

function thrownProcessResult(error: unknown, release: TargetRelease): ReplayTargetProcessResult {
  if (error instanceof ReplayTargetLaunchError) {
    return failedProcessResult(
      error.code === "launch_cancelled" ? "worker_cancelled" : "spawn_failed",
      release,
    );
  }
  return failedProcessResult("invalid_supervisor_options", release);
}

function reportFailure(
  processResult: ReplayTargetProcessResult,
  error: unknown,
): ReplayTargetProcessResult {
  /* v8 ignore next 3 -- The report boundary wraps every reachable validation and publisher failure. */
  if (!(error instanceof ReplayAttemptReportError)) {
    return withFailure(processResult, "invalid_supervisor_options");
  }
  if (error.code === "publish_cancelled") {
    return withFailure(processResult, "worker_cancelled");
  }
  if (error.code === "publish_failed") {
    return withFailure(processResult, "result_publication_failed");
  }
  if (error.code === "invalid_report_size") {
    return withFailure(processResult, "output_limit_exceeded");
  }
  return withFailure(processResult, "invalid_supervisor_options");
}

function exactPlan(snapshot: ReplayJobSnapshot, plan: ReplayPlan): boolean {
  return (
    sameJson(snapshot.job.scope, plan.scope) &&
    sameJson(snapshot.job.plan, {
      definitionSha256: plan.definitionSha256,
      planId: plan.planId,
      planVersionId: plan.planVersionId,
    })
  );
}

function cancellationAcknowledged(
  snapshot: ReplayJobSnapshot,
  workerFence: ReplayWorkerMutationFence,
): boolean {
  return snapshot.cancellationAcknowledgements.some(
    (acknowledgement) =>
      acknowledgement.cancellationId === snapshot.cancellationRequest?.cancellationId &&
      sameJson(acknowledgement.mutationFence, workerFence),
  );
}

function cancellationAction(
  processResult: ReplayTargetProcessResult,
): ReplayCancellationAcknowledgement["action"] {
  if (processResult.status === "completed") return "observed_after_uninterruptible_completion";
  if (
    processResult.isolation.some(
      ({ control, verdict }) => control === "process_boundary" && verdict === "verified",
    )
  ) {
    return "stop_requested";
  }
  return "stopped_before_target_start";
}

async function acknowledgeCancellationIfRequired(options: {
  readonly context: RunnerContext;
  readonly leaseDurationMilliseconds: number;
  readonly processResult: ReplayTargetProcessResult;
  readonly repository: ReplayJobRepository;
  readonly snapshot: ReplayJobSnapshot;
}): Promise<ReplayJobSnapshot> {
  if (
    options.snapshot.cancellationRequest === null ||
    cancellationAcknowledged(options.snapshot, options.context.workerFence)
  ) {
    return options.snapshot;
  }
  return await acknowledgeReplayAttemptCancellation({
    action: cancellationAction(options.processResult),
    leaseDurationMilliseconds: options.leaseDurationMilliseconds,
    repository: options.repository,
    scope: options.context.scope,
    snapshot: options.snapshot,
    workerFence: options.context.workerFence,
  });
}

async function completeWithCancellationRace(options: {
  readonly context: RunnerContext;
  readonly leaseDurationMilliseconds: number;
  readonly processResult: ReplayTargetProcessResult;
  readonly repository: ReplayJobRepository;
  readonly result?: ExecutedAttempt["result"];
  readonly snapshot: ReplayJobSnapshot;
}): Promise<ReplayJobSnapshot> {
  const complete = (snapshot: ReplayJobSnapshot) =>
    completeSupervisedReplayAttempt({
      leaseDurationMilliseconds: options.leaseDurationMilliseconds,
      processResult: options.processResult,
      repository: options.repository,
      ...(options.result ? { result: options.result } : {}),
      scope: options.context.scope,
      snapshot,
      workerFence: options.context.workerFence,
    });
  try {
    return await complete(options.snapshot);
  } catch (error) {
    const latest = await options.repository.heartbeatJob({
      leaseDurationMilliseconds: options.leaseDurationMilliseconds,
      scope: options.context.scope,
      workerFence: options.context.workerFence,
    });
    if (
      latest.cancellationRequest === null ||
      cancellationAcknowledged(latest, options.context.workerFence)
    ) {
      throw error;
    }
    const acknowledged = await acknowledgeCancellationIfRequired({
      context: options.context,
      leaseDurationMilliseconds: options.leaseDurationMilliseconds,
      processResult: options.processResult,
      repository: options.repository,
      snapshot: latest,
    });
    return await complete(acknowledged);
  }
}

async function finishWithoutReservation(options: {
  readonly context: RunnerContext;
  readonly leaseDurationMilliseconds: number;
  readonly processResult: ReplayTargetProcessResult;
  readonly repository: ReplayJobRepository;
  readonly sessionId: string;
  readonly snapshot: ReplayJobSnapshot;
}): Promise<RunClaimedReplayAttemptResult> {
  let snapshot = await recordSupervisedExecutionObservations({
    leaseDurationMilliseconds: options.leaseDurationMilliseconds,
    processResult: options.processResult,
    repository: options.repository,
    scope: options.context.scope,
    workerFence: options.context.workerFence,
  });
  snapshot = await acknowledgeCancellationIfRequired({ ...options, snapshot });
  snapshot = await completeWithCancellationRace({ ...options, snapshot });
  return Object.freeze({
    processResult: options.processResult,
    sessionId: options.sessionId,
    snapshot,
  });
}

async function executeReservedAttempt(options: {
  readonly context: RunnerContext;
  readonly input: RunClaimedReplayAttemptOptions & { readonly signal: AbortSignal };
  readonly plan: ReplayPlan;
  readonly release: TargetRelease;
  readonly reservationId: string;
  readonly reservationMaximumArtifactBytes: number;
  readonly sessionId: string;
  readonly startMessage: ReturnType<typeof preflightReplayTargetSession>["startMessage"];
}): Promise<ExecutedAttempt> {
  let processResult: ReplayTargetProcessResult;
  const signal = options.input.signal;
  try {
    const launch = await prepareTargetLaunch({
      availableEnvironment: options.input.availableEnvironment,
      registry: options.input.registry,
      signal,
      startMessage: options.startMessage,
      targetRelease: options.release,
      workspaceParent: options.input.workspaceParent,
    });
    processResult = await superviseReplayTargetProcess({
      cancellationRequested: () => signal.aborted,
      deadlineAtMs: Math.min(
        Date.now() + options.plan.retryPolicy.perAttemptTimeoutMilliseconds,
        Date.parse(options.context.snapshot.job.startedAt as string) +
          options.plan.retryPolicy.totalDeadlineMilliseconds,
      ),
      launch,
      resolveBoundary: async ({ boundaryId, request }) =>
        await options.input.boundaryResolver.resolve({
          boundaryId,
          plan: options.plan,
          request,
          scope: options.context.scope,
          sessionId: options.sessionId,
          signal,
          targetRelease: options.release,
          workerFence: options.context.workerFence,
        }),
      signal,
      ...(options.input.terminationGraceMilliseconds === undefined
        ? {}
        : { terminationGraceMs: options.input.terminationGraceMilliseconds }),
    });
  } catch (error) {
    return Object.freeze({
      emittedArtifactBytes: 0,
      processResult: thrownProcessResult(error, options.release),
    });
  }

  if (processResult.status !== "completed") {
    return Object.freeze({ emittedArtifactBytes: 0, processResult });
  }
  const maximumReportBytes = Math.min(
    options.release.outputLimits.emittedArtifactBytes,
    options.reservationMaximumArtifactBytes,
  );
  try {
    const published = await publishSuccessfulReplayAttemptReport({
      maximumBytes: maximumReportBytes,
      processResult,
      publisher: options.input.reportPublisher,
      reservationId: options.reservationId,
      signal,
      scope: options.context.scope,
      startMessage: options.startMessage,
      workerFence: options.context.workerFence,
    });
    return Object.freeze({
      emittedArtifactBytes: published.emittedArtifactBytes,
      processResult,
      result: published.contentReference,
    });
  } catch (error) {
    const publicationMayHaveEmittedContent =
      error instanceof ReplayAttemptReportError &&
      ["publish_cancelled", "publish_failed", "publisher_mismatch"].includes(error.code);
    return Object.freeze({
      emittedArtifactBytes: publicationMayHaveEmittedContent ? maximumReportBytes : 0,
      processResult: reportFailure(processResult, error),
    });
  }
}

export async function runClaimedReplayAttempt(
  options: RunClaimedReplayAttemptOptions,
): Promise<RunClaimedReplayAttemptResult> {
  validatePolicy(options);
  const context = validateContext(options);
  const exactSessionId = sessionId(context.workerFence);
  let snapshot = await options.repository.heartbeatJob({
    leaseDurationMilliseconds: options.leaseDurationMilliseconds,
    scope: context.scope,
    workerFence: context.workerFence,
  });
  if (snapshot.cancellationRequest !== null) {
    return await finishWithoutReservation({
      context,
      leaseDurationMilliseconds: options.leaseDurationMilliseconds,
      processResult: failedProcessResult("worker_cancelled"),
      repository: options.repository,
      sessionId: exactSessionId,
      snapshot,
    });
  }

  const plan = await options.definitions.findReplayPlan(
    context.scope,
    context.snapshot.job.plan.planVersionId,
  );
  if (!plan || !exactPlan(context.snapshot, plan)) {
    return await finishWithoutReservation({
      context,
      leaseDurationMilliseconds: options.leaseDurationMilliseconds,
      processResult: failedProcessResult("protocol_failed"),
      repository: options.repository,
      sessionId: exactSessionId,
      snapshot,
    });
  }
  const release = await options.definitions.findTargetRelease(
    context.scope,
    plan.targetRelease.targetReleaseId,
  );
  if (!release) {
    return await finishWithoutReservation({
      context,
      leaseDurationMilliseconds: options.leaseDurationMilliseconds,
      processResult: failedProcessResult("spawn_failed"),
      repository: options.repository,
      sessionId: exactSessionId,
      snapshot,
    });
  }

  let preflight: ReturnType<typeof preflightReplayTargetSession>;
  try {
    preflight = preflightReplayTargetSession({
      plan,
      sessionId: exactSessionId,
      targetRelease: release,
    });
  } catch {
    return await finishWithoutReservation({
      context,
      leaseDurationMilliseconds: options.leaseDurationMilliseconds,
      processResult: failedProcessResult("protocol_failed", release),
      repository: options.repository,
      sessionId: exactSessionId,
      snapshot,
    });
  }

  const reserved = await reserveReplayAttemptBudget({
    leaseDurationMilliseconds: options.leaseDurationMilliseconds,
    plan: preflight.plan,
    repository: options.repository,
    scope: context.scope,
    snapshot,
    workerFence: context.workerFence,
  });
  snapshot = reserved.snapshot;
  const startedAt = performance.now();
  const leased = await runUnderReplayLease({
    execute: async (signal) =>
      await executeReservedAttempt({
        context,
        input: { ...options, signal },
        plan: preflight.plan,
        release: preflight.targetRelease,
        reservationId: reserved.reservationId,
        reservationMaximumArtifactBytes: reserved.requested.emittedArtifactBytes,
        sessionId: exactSessionId,
        startMessage: preflight.startMessage,
      }),
    heartbeat: async () => {
      const latest = await options.repository.heartbeatJob({
        leaseDurationMilliseconds: options.leaseDurationMilliseconds,
        scope: context.scope,
        workerFence: context.workerFence,
      });
      return latest;
    },
    heartbeatIntervalMilliseconds: options.heartbeatIntervalMilliseconds,
    leaseDurationMilliseconds: options.leaseDurationMilliseconds,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  snapshot = leased.latestSnapshot;
  const executed = leased.result;

  snapshot = await recordSupervisedExecutionObservations({
    leaseDurationMilliseconds: options.leaseDurationMilliseconds,
    processResult: executed.processResult,
    repository: options.repository,
    scope: context.scope,
    workerFence: context.workerFence,
  });
  snapshot = await acknowledgeCancellationIfRequired({
    context,
    leaseDurationMilliseconds: options.leaseDurationMilliseconds,
    processResult: executed.processResult,
    repository: options.repository,
    snapshot,
  });
  const actual = measureRecordedStubAttemptUsage({
    elapsedMilliseconds: Math.ceil(performance.now() - startedAt),
    emittedArtifactBytes: executed.emittedArtifactBytes,
    executionObservations: executed.processResult.executionObservations,
  });
  snapshot = await reconcileReplayAttemptBudget({
    actual,
    leaseDurationMilliseconds: options.leaseDurationMilliseconds,
    plan: preflight.plan,
    repository: options.repository,
    reservationId: reserved.reservationId,
    scope: context.scope,
    workerFence: context.workerFence,
  });
  snapshot = await acknowledgeCancellationIfRequired({
    context,
    leaseDurationMilliseconds: options.leaseDurationMilliseconds,
    processResult: executed.processResult,
    repository: options.repository,
    snapshot,
  });
  snapshot = await completeWithCancellationRace({
    context,
    leaseDurationMilliseconds: options.leaseDurationMilliseconds,
    processResult: executed.processResult,
    repository: options.repository,
    ...(executed.result ? { result: executed.result } : {}),
    snapshot,
  });
  return Object.freeze({
    processResult: executed.processResult,
    reservationId: reserved.reservationId,
    sessionId: exactSessionId,
    snapshot,
  });
}
