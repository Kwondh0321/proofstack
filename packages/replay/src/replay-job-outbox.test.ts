import { describe, expect, it } from "vitest";
import { ReplayJobConflictError, ReplayJobNotFoundError } from "./errors.js";
import {
  buildReplayJobCancellationRequestedOutboxIntent,
  buildReplayJobCreatedOutboxIntent,
  buildReplayJobTerminalOutboxIntent,
} from "./replay-job-outbox.js";
import {
  claimReplayJob,
  completeReplayAttempt,
  createQueuedReplayJob,
  requestReplayCancellation,
} from "./replay-job-state.js";

const sha = (digit: string): string => digit.repeat(64);
const scope = {
  environmentId: "env_job_outbox",
  projectId: "prj_job_outbox",
  tenantId: "ten_job_outbox",
};
const workerProtocol = { name: "proofstack.replay-worker", version: "1.0.0" };

function queuedJob() {
  return createQueuedReplayJob({
    createdAt: "2026-08-29T12:00:00.000Z",
    createdByPrincipalId: "usr_job_outbox",
    request: {
      jobId: "job_outbox_001",
      plan: {
        definitionSha256: sha("1"),
        planId: "plan_job_outbox",
        planVersionId: "plv_job_outbox_001",
      },
    },
    scope,
  });
}

function claimedJob() {
  return claimReplayJob(queuedJob(), {
    attemptId: "att_job_outbox_001",
    isolationProfile: {
      definitionSha256: sha("2"),
      id: "iso_job_outbox",
      kind: "local_child_process",
      version: "1.0.0",
    },
    leaseDurationMilliseconds: 30_000,
    leaseId: "lea_job_outbox_001",
    maxAttempts: 1,
    now: "2026-08-29T12:00:01.000Z",
    runtimeProfile: {
      definitionSha256: sha("3"),
      family: "node",
      id: "run_job_outbox",
      version: "1.0.0",
    },
    targetRelease: {
      definitionSha256: sha("4"),
      targetAdapter: {
        name: "proofstack.reference_target",
        protocolVersion: "1.0.0",
        version: "1.0.0",
      },
      targetId: "target_job_outbox",
      targetReleaseId: "trg_job_outbox_001",
      workerProtocol,
    },
    workerBuildSha256: sha("5"),
    workerId: "wrk_job_outbox",
    workerProtocol,
  });
}

describe("replay job outbox intents", () => {
  it("publishes only exact queued-job coordinates", () => {
    expect(buildReplayJobCreatedOutboxIntent(queuedJob())).toEqual({
      aggregateId: "job_outbox_001",
      aggregateType: "replay.job",
      createdAt: "2026-08-29T12:00:00.000Z",
      eventType: "replay.job.created",
      payload: {
        definitionSha256: sha("1"),
        environmentId: scope.environmentId,
        jobId: "job_outbox_001",
        planId: "plan_job_outbox",
        planVersionId: "plv_job_outbox_001",
        projectId: scope.projectId,
      },
      schemaVersion: "0.1",
      tenantId: scope.tenantId,
    });
  });

  it("publishes one cancellation locator without the human reason", () => {
    const job = queuedJob();
    const cancellation = requestReplayCancellation(job, {
      input: {
        cancellationId: "can_job_outbox_001",
        reason: "Operator stopped the queued replay.",
        reasonCode: "operator_request",
      },
      now: "2026-08-29T12:00:02.000Z",
      requestedByPrincipalId: "usr_job_outbox",
    });
    expect(
      buildReplayJobCancellationRequestedOutboxIntent(cancellation.job, cancellation.request),
    ).toEqual({
      aggregateId: job.jobId,
      aggregateType: "replay.job",
      createdAt: "2026-08-29T12:00:02.000Z",
      eventType: "replay.job.cancellation-requested",
      payload: {
        cancellationId: "can_job_outbox_001",
        environmentId: scope.environmentId,
        jobId: job.jobId,
        projectId: scope.projectId,
        reasonCode: "operator_request",
      },
      schemaVersion: "0.1",
      tenantId: scope.tenantId,
    });
    expect(() =>
      buildReplayJobCancellationRequestedOutboxIntent(cancellation.job, {
        ...cancellation.request,
        scope: { ...scope, projectId: "prj_other" },
      }),
    ).toThrow(TypeError);
  });

  it("publishes one terminal locator from an authoritative terminal job", () => {
    const claimed = claimedJob();
    const completed = completeReplayAttempt(
      claimed.job,
      claimed.attempt,
      claimed.lease.mutationFence,
      {
        cancellationRequested: false,
        code: "completed",
        now: "2026-08-29T12:00:03.000Z",
        result: {
          artifactId: "art_job_outbox_result",
          classification: "internal",
          mediaType: "application/json",
          sha256: sha("6"),
          sizeBytes: 128,
        },
        status: "succeeded",
      },
    );
    expect(buildReplayJobTerminalOutboxIntent(completed.job)).toMatchObject({
      aggregateId: "job_outbox_001",
      createdAt: "2026-08-29T12:00:03.000Z",
      eventType: "replay.job.terminal",
      payload: {
        code: "completed",
        jobId: "job_outbox_001",
        stateVersion: 3,
        status: "succeeded",
      },
    });
    expect(() => buildReplayJobTerminalOutboxIntent(queuedJob())).toThrow(TypeError);
  });

  it("exposes stable job repository conflict and not-found errors", () => {
    expect(new ReplayJobConflictError()).toMatchObject({
      code: "replay_job_conflict",
      name: "ReplayJobConflictError",
    });
    expect(new ReplayJobNotFoundError()).toMatchObject({
      code: "replay_job_not_found",
      name: "ReplayJobNotFoundError",
    });
  });
});
