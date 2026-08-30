import type {
  ReplayExecutionObservationPayload,
  ReplayWorkerMutationFence,
} from "@proofstack/contracts";
import type { ReplayJobRepository, ReplayJobSnapshot } from "@proofstack/replay";
import { describe, expect, it, vi } from "vitest";
import { recordSupervisedExecutionObservations } from "./attempt-observation-recorder.js";

const scope = {
  environmentId: "env_observation",
  projectId: "prj_observation",
  tenantId: "ten_observation",
} as const;

const workerFence: ReplayWorkerMutationFence = {
  attemptId: "att_observation_001",
  fencingToken: 7,
  jobId: "job_observation_001",
  leaseId: "lea_observation_001",
  recoveryEpoch: 0,
  workerId: "wrk_observation_001",
};

const targetStarted: ReplayExecutionObservationPayload = {
  afterCancellationRequest: false,
  evidenceSha256: "a".repeat(64),
  event: "started",
  kind: "target",
};

const targetExited: ReplayExecutionObservationPayload = {
  afterCancellationRequest: false,
  evidenceSha256: "b".repeat(64),
  event: "exited",
  exitCode: 0,
  kind: "target",
};

const isolation: Extract<ReplayExecutionObservationPayload, { kind: "isolation" }> = {
  control: "process_boundary",
  evidenceSha256: "c".repeat(64),
  kind: "isolation",
  verdict: "verified",
};

function repository(snapshot: ReplayJobSnapshot) {
  const appendExecutionObservation = vi.fn(
    async (_command: Parameters<ReplayJobRepository["appendExecutionObservation"]>[0]) => snapshot,
  );
  const heartbeatJob = vi.fn(
    async (_command: Parameters<ReplayJobRepository["heartbeatJob"]>[0]) => snapshot,
  );
  const mocks = { appendExecutionObservation, heartbeatJob };
  return mocks as typeof mocks & ReplayJobRepository;
}

describe("recordSupervisedExecutionObservations", () => {
  it("renews authority before every stable, ordered observation", async () => {
    const snapshot = { job: { jobId: workerFence.jobId } } as ReplayJobSnapshot;
    const firstRepository = repository(snapshot);
    const options = {
      leaseDurationMilliseconds: 1_000,
      processResult: {
        executionObservations: [targetStarted, targetExited],
        isolation: [isolation],
      },
      repository: firstRepository,
      scope,
      workerFence,
    } as const;
    await expect(recordSupervisedExecutionObservations(options)).resolves.toBe(snapshot);
    expect(firstRepository.heartbeatJob).toHaveBeenCalledTimes(3);
    expect(firstRepository.appendExecutionObservation).toHaveBeenCalledTimes(3);
    const firstIds = firstRepository.appendExecutionObservation.mock.calls.map(
      ([command]) => command.observationId,
    );
    expect(new Set(firstIds).size).toBe(3);
    expect(
      firstRepository.appendExecutionObservation.mock.calls.map(([command]) => command.payload),
    ).toEqual([targetStarted, targetExited, isolation]);

    const retryRepository = repository(snapshot);
    await recordSupervisedExecutionObservations({ ...options, repository: retryRepository });
    expect(
      retryRepository.appendExecutionObservation.mock.calls.map(
        ([command]) => command.observationId,
      ),
    ).toEqual(firstIds);
  });

  it("still proves the current lease when there is no observation to append", async () => {
    const snapshot = { job: { jobId: workerFence.jobId } } as ReplayJobSnapshot;
    const emptyRepository = repository(snapshot);
    await expect(
      recordSupervisedExecutionObservations({
        leaseDurationMilliseconds: 1_000,
        processResult: { executionObservations: [], isolation: [] },
        repository: emptyRepository,
        scope,
        workerFence,
      }),
    ).resolves.toBe(snapshot);
    expect(emptyRepository.heartbeatJob).toHaveBeenCalledTimes(1);
    expect(emptyRepository.appendExecutionObservation).not.toHaveBeenCalled();
  });

  it("rejects invalid policy and batches before any repository mutation", async () => {
    const snapshot = { job: { jobId: workerFence.jobId } } as ReplayJobSnapshot;
    for (const leaseDurationMilliseconds of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalidRepository = repository(snapshot);
      await expect(
        recordSupervisedExecutionObservations({
          leaseDurationMilliseconds,
          processResult: { executionObservations: [], isolation: [] },
          repository: invalidRepository,
          scope,
          workerFence,
        }),
      ).rejects.toMatchObject({ code: "invalid_lease_policy" });
      expect(invalidRepository.heartbeatJob).not.toHaveBeenCalled();
    }

    for (const processResult of [
      { executionObservations: [isolation], isolation: [] },
      { executionObservations: [], isolation: [targetStarted] },
      { executionObservations: [{ nope: true }], isolation: [] },
    ]) {
      const invalidRepository = repository(snapshot);
      await expect(
        recordSupervisedExecutionObservations({
          leaseDurationMilliseconds: 1_000,
          processResult: processResult as never,
          repository: invalidRepository,
          scope,
          workerFence,
        }),
      ).rejects.toMatchObject({ code: "invalid_observation_batch" });
      expect(invalidRepository.heartbeatJob).not.toHaveBeenCalled();
    }

    const invalidScopeRepository = repository(snapshot);
    await expect(
      recordSupervisedExecutionObservations({
        leaseDurationMilliseconds: 1_000,
        processResult: { executionObservations: [], isolation: [] },
        repository: invalidScopeRepository,
        scope: { tenantId: "invalid" },
        workerFence,
      }),
    ).rejects.toMatchObject({ code: "invalid_observation_batch" });
  });
});
