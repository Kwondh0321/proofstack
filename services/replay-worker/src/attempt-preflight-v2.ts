import {
  type ReplayPlan,
  type ReplayProcessBoundaryV2,
  type ReplayWorkerStartTargetV2Message,
  ReplayWorkerStartTargetV2MessageSchema,
  type TargetRelease,
} from "@proofstack/contracts";
import {
  digestRecordedBoundaryReplayInvocationDefinition,
  validateAndProjectReplayPlan,
  validateAndProjectTargetRelease,
} from "@proofstack/replay";
import { ReplayAttemptPreflightError } from "./errors.js";
import { MAX_REPLAY_TARGET_TIMER_DELAY_MS } from "./target-process-supervisor.js";

export interface ReplayAttemptPreflightV2Result {
  readonly plan: ReplayPlan;
  readonly startMessage: ReplayWorkerStartTargetV2Message;
  readonly targetRelease: TargetRelease;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function releaseReference(release: TargetRelease): ReplayPlan["targetRelease"] {
  return {
    definitionSha256: release.definitionSha256,
    targetAdapter: release.targetAdapter,
    targetId: release.targetId,
    targetReleaseId: release.targetReleaseId,
    workerProtocol: release.workerProtocol,
  };
}

function processBoundary(boundary: ReplayPlan["boundaries"][number]): ReplayProcessBoundaryV2 {
  if (boundary.mode !== "recorded_stub") {
    return {
      boundaryId: boundary.boundaryId,
      kind: boundary.kind,
      mode: boundary.mode,
    };
  }
  if (
    digestRecordedBoundaryReplayInvocationDefinition(boundary.invocation) !==
    boundary.invocationDefinitionSha256
  ) {
    throw new ReplayAttemptPreflightError("invocation_digest_mismatch");
  }
  return {
    boundaryId: boundary.boundaryId,
    invocation: boundary.invocation,
    invocationDefinitionSha256: boundary.invocationDefinitionSha256,
    kind: boundary.kind,
    mode: boundary.mode,
  };
}

export function preflightReplayTargetV2Session(input: {
  readonly plan: unknown;
  readonly sessionId: string;
  readonly targetRelease: unknown;
}): ReplayAttemptPreflightV2Result {
  let plan: ReplayPlan;
  try {
    plan = validateAndProjectReplayPlan(input.plan).plan;
  } catch (error) {
    throw new ReplayAttemptPreflightError("invalid_plan", { cause: error });
  }
  let release: TargetRelease;
  try {
    release = validateAndProjectTargetRelease(input.targetRelease).release;
  } catch (error) {
    throw new ReplayAttemptPreflightError("invalid_target_release", { cause: error });
  }
  if (!sameJson(plan.scope, release.scope)) {
    throw new ReplayAttemptPreflightError("scope_mismatch");
  }
  if (!sameJson(plan.targetRelease, releaseReference(release))) {
    throw new ReplayAttemptPreflightError("target_reference_mismatch");
  }
  if (plan.runtimeProfile.family !== release.runtime.family) {
    throw new ReplayAttemptPreflightError("runtime_profile_mismatch");
  }
  if (plan.isolationProfile.kind !== "local_child_process") {
    throw new ReplayAttemptPreflightError("isolation_profile_unsupported");
  }
  if (plan.retryPolicy.perAttemptTimeoutMilliseconds > MAX_REPLAY_TARGET_TIMER_DELAY_MS) {
    throw new ReplayAttemptPreflightError("attempt_timeout_unsupported");
  }

  const boundaries: ReplayProcessBoundaryV2[] = [];
  for (const boundary of plan.boundaries) {
    if (!release.supportedBoundaryModes.includes(boundary.mode)) {
      throw new ReplayAttemptPreflightError("unsupported_boundary_mode");
    }
    if (!release.supportedBoundaryKinds.includes(boundary.kind)) {
      throw new ReplayAttemptPreflightError("unsupported_boundary_kind");
    }
    boundaries.push(processBoundary(boundary));
  }

  const parsed = ReplayWorkerStartTargetV2MessageSchema.safeParse({
    boundaries,
    schemaVersion: "0.2",
    sessionId: input.sessionId,
    targetRelease: releaseReference(release),
    type: "start",
  });
  if (!parsed.success) {
    throw new ReplayAttemptPreflightError("session_invalid", { cause: parsed.error });
  }
  return Object.freeze({ plan, startMessage: parsed.data, targetRelease: release });
}
