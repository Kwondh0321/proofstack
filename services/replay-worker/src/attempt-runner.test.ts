import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EvidenceScope,
  type RecordedBoundaryResponse,
  RecordedBoundaryResponseSchema,
  type ReplayPlan,
  type ReplayPlanDefinition,
  ReplayPlanDefinitionSchema,
  ReplayPlanSchema,
  type ReplayWorkerMutationFence,
  type TargetRelease,
  type TargetReleaseDefinition,
  TargetReleaseDefinitionSchema,
  TargetReleaseSchema,
} from "@proofstack/contracts";
import {
  digestReplayPlanDefinition,
  digestTargetReleaseDefinition,
  type ReplayDefinitionRepository,
  type ReplayJobRepository,
  type ReplayJobSnapshot,
} from "@proofstack/replay";
import {
  MemoryReplayDefinitionRepository,
  MemoryReplayJobRepository,
} from "@proofstack/replay/testing";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runClaimedReplayAttempt, type RunClaimedReplayAttemptOptions } from "./attempt-runner.js";
import type { PublishReplayAttemptReportCommand } from "./attempt-report.js";
import type { ResolvedPreinstalledTarget } from "./target-launch.js";

const sha = (digit: string): string => digit.repeat(64);
const normalizedBytes = "e30";
const normalizedSha256 = createHash("sha256")
  .update(Buffer.from(normalizedBytes, "base64url"))
  .digest("hex");
const temporaryDirectories: string[] = [];
const scope: EvidenceScope = {
  environmentId: "env_runner",
  projectId: "prj_runner",
  tenantId: "ten_runner",
};
let basePlanDefinition: ReplayPlanDefinition;
let baseReleaseDefinition: TargetReleaseDefinition;

function currentPlatform(): "darwin" | "linux" {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("Replay runner tests require a supported platform");
  }
  return process.platform;
}

function currentArchitecture(): "arm64" | "x64" {
  if (process.arch !== "arm64" && process.arch !== "x64") {
    throw new Error("Replay runner tests require a supported architecture");
  }
  return process.arch;
}

function targetSource(mode: "boundary" | "complete" | "exit_nonzero"): string {
  return String.raw`
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";

const mode = ${JSON.stringify(mode)};
const input = createReadStream("/dev/null", { autoClose: false, fd: Number(process.env.PROOFSTACK_WORKER_PROTOCOL_INPUT_FD) });
const output = createWriteStream("/dev/null", { autoClose: false, fd: Number(process.env.PROOFSTACK_WORKER_PROTOCOL_OUTPUT_FD) });
const hold = setInterval(() => undefined, 1_000);
const send = (message) => output.write(JSON.stringify(message) + "\n");
const finish = (code) => {
  clearInterval(hold);
  process.exitCode = code;
  input.destroy();
  output.end();
};

createInterface({ crlfDelay: Infinity, input }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "start") {
    send({
      schemaVersion: "0.1",
      sessionId: message.sessionId,
      targetAdapter: message.targetRelease.targetAdapter,
      type: "ready",
      workerProtocol: message.targetRelease.workerProtocol,
    });
    if (mode === "exit_nonzero") {
      finish(7);
      return;
    }
    if (mode === "boundary") {
      send({
        boundaryId: "bnd_vector_model",
        request: {
          boundaryRequestId: "brr_runner_001",
          kind: "model",
          normalizedRequest: {
            adapterName: "proofstack.reference.model",
            adapterVersion: "1.0.0",
            bytes: "e30",
            encoding: "base64url",
          },
          schemaVersion: "0.1",
        },
        requestSequence: 0,
        schemaVersion: "0.1",
        sessionId: message.sessionId,
        type: "boundary_request",
      });
      return;
    }
    send({ requestCount: 0, schemaVersion: "0.1", sessionId: message.sessionId, type: "completed" });
    finish(0);
    return;
  }
  if (message.type === "boundary_response") {
    send({ requestCount: 1, schemaVersion: "0.1", sessionId: message.sessionId, type: "completed" });
    finish(0);
    return;
  }
  if (message.type === "stop" || message.type === "abort") finish(0);
});
`;
}

function boundaryResponse(): RecordedBoundaryResponse {
  return {
    artifacts: [],
    resolution: {
      actualRequest: {
        adapterName: "proofstack.reference.model",
        adapterVersion: "1.0.0",
        boundaryRequestId: "brr_runner_001",
        kind: "model",
        normalizedRequestSha256: normalizedSha256,
        sizeBytes: 2,
      },
      expectedRequest: {
        adapterName: "proofstack.reference.model",
        adapterVersion: "1.0.0",
        attemptId: "att_recorded_runner_001",
        attemptSequence: 0,
        interactionId: "int_recorded_runner_001",
        interactionSequence: 0,
        kind: "model",
        normalizedRequestSha256: normalizedSha256,
      },
      recordedAttempt: {
        attempt: {
          artifacts: {
            inputMessagesArtifactId: "art_runner_input",
            providerConfigurationArtifactId: "art_runner_provider_configuration",
            providerRequestArtifactId: "art_runner_request",
          },
          attemptId: "att_recorded_runner_001",
          endedAt: "2026-08-30T00:00:01.000Z",
          errorType: "recorded_failure",
          normalizedRequest: {
            adapterName: "proofstack.reference.model",
            adapterVersion: "1.0.0",
            artifactId: "art_runner_normalized",
            sha256: normalizedSha256,
          },
          outcome: "failed",
          provider: {
            endpointProfileId: "end_runner_recorded",
            endpointProfileVersion: "2026-08-30",
            name: "recorded-runner-provider",
            operation: "chat",
            requestedModel: "recorded-runner-model",
            returnedModel: "recorded-runner-model",
          },
          providerMayHaveProcessed: true,
          sequence: 0,
          startedAt: "2026-08-30T00:00:00.000Z",
          streaming: false,
        },
        interactionId: "int_recorded_runner_001",
        interactionSequence: 0,
        kind: "model",
      },
      returnedArtifacts: [],
    },
    schemaVersion: "0.1",
  };
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

function publishedRelease(source: string, emittedArtifactBytes = 1_048_576): TargetRelease {
  const definition = TargetReleaseDefinitionSchema.parse({
    ...baseReleaseDefinition,
    build: {
      ...baseReleaseDefinition.build,
      executableSha256: createHash("sha256").update(source).digest("hex"),
    },
    outputLimits: { ...baseReleaseDefinition.outputLimits, emittedArtifactBytes },
    runtime: {
      architecture: currentArchitecture(),
      entryPoint: "target.mjs",
      family: "node",
      platform: currentPlatform(),
      version: process.versions.node,
    },
    scope,
  });
  return TargetReleaseSchema.parse({
    createdAt: "2026-08-30T00:00:00.000Z",
    createdByPrincipalId: "usr_runner",
    definitionSha256: digestTargetReleaseDefinition(definition),
    ...definition,
  });
}

function publishedPlan(release: TargetRelease, emittedArtifactBytes = 1_048_576): ReplayPlan {
  const definition = ReplayPlanDefinitionSchema.parse({
    ...basePlanDefinition,
    budget: {
      ...basePlanDefinition.budget,
      elapsedMilliseconds: { limit: 10_000, measurement: "measured" },
      emittedArtifactBytes: { limit: emittedArtifactBytes, measurement: "measured" },
    },
    retryPolicy: {
      ...basePlanDefinition.retryPolicy,
      perAttemptTimeoutMilliseconds: 1_000,
      totalDeadlineMilliseconds: 5_000,
    },
    runtimeProfile: { ...basePlanDefinition.runtimeProfile, family: release.runtime.family },
    scope,
    targetRelease: releaseReference(release),
    workerProtocol: release.workerProtocol,
  });
  return ReplayPlanSchema.parse({
    createdAt: "2026-08-30T00:00:00.000Z",
    createdByPrincipalId: "usr_runner",
    definitionSha256: digestReplayPlanDefinition(definition),
    ...definition,
  });
}

function repositoryPort(
  repository: ReplayJobRepository,
  overrides: Partial<ReplayJobRepository> = {},
): ReplayJobRepository {
  return {
    acknowledgeCancellation: repository.acknowledgeCancellation.bind(repository),
    appendExecutionObservation: repository.appendExecutionObservation.bind(repository),
    appendUsageObservation: repository.appendUsageObservation.bind(repository),
    claimJob: repository.claimJob.bind(repository),
    completeJob: repository.completeJob.bind(repository),
    createJob: repository.createJob.bind(repository),
    findJob: repository.findJob.bind(repository),
    heartbeatJob: repository.heartbeatJob.bind(repository),
    reconcileBudget: repository.reconcileBudget.bind(repository),
    requestCancellation: repository.requestCancellation.bind(repository),
    reserveBudget: repository.reserveBudget.bind(repository),
    ...overrides,
  };
}

function definitionPort(
  definitions: ReplayDefinitionRepository,
  overrides: Partial<ReplayDefinitionRepository> = {},
): ReplayDefinitionRepository {
  return {
    findReplayPlan: definitions.findReplayPlan.bind(definitions),
    findTargetRelease: definitions.findTargetRelease.bind(definitions),
    publishReplayPlan: definitions.publishReplayPlan.bind(definitions),
    publishTargetRelease: definitions.publishTargetRelease.bind(definitions),
    ...overrides,
  };
}

function emittedArtifactUsage(snapshot: ReplayJobSnapshot) {
  const reconciliation = snapshot.budgetLedger.find(
    (entry) => entry.entryType === "reconciliation",
  );
  if (!reconciliation) throw new Error("Replay reconciliation is unavailable");
  return reconciliation.dimensions.emittedArtifactBytes.actualUsage;
}

interface Fixture {
  readonly definitions: MemoryReplayDefinitionRepository;
  readonly jobRepository: MemoryReplayJobRepository;
  readonly options: RunClaimedReplayAttemptOptions;
  readonly plan: ReplayPlan;
  readonly publish: ReturnType<
    typeof vi.fn<(command: PublishReplayAttemptReportCommand) => Promise<unknown>>
  >;
  readonly release: TargetRelease;
}

async function fixture(
  mode: "boundary" | "complete" | "exit_nonzero" = "complete",
  emittedArtifactBytes = 1_048_576,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "proofstack-attempt-runner-test-"));
  temporaryDirectories.push(root);
  const workspaceParent = join(root, "workspaces");
  await mkdir(workspaceParent);
  const source = targetSource(mode);
  const targetPath = join(root, "target.mjs");
  await writeFile(targetPath, source);
  const release = publishedRelease(source, emittedArtifactBytes);
  const plan = publishedPlan(release, emittedArtifactBytes);
  const definitions = new MemoryReplayDefinitionRepository();
  await definitions.publishTargetRelease(release);
  await definitions.publishReplayPlan(plan);
  const now = new Date().toISOString();
  const jobRepository = new MemoryReplayJobRepository({ definitions, now: () => now });
  const created = await jobRepository.createJob({
    createdByPrincipalId: "usr_runner",
    jobId: "job_runner_001",
    plan: {
      definitionSha256: plan.definitionSha256,
      planId: plan.planId,
      planVersionId: plan.planVersionId,
    },
    scope,
  });
  const claimed = await jobRepository.claimJob({
    attemptId: "att_runner_001",
    jobId: created.snapshot.job.jobId,
    leaseDurationMilliseconds: 200,
    leaseId: "lea_runner_001",
    scope,
    workerBuildSha256: sha("c"),
    workerId: "wrk_runner_001",
    workerProtocol: plan.workerProtocol,
  });
  if (!claimed.claimed) throw new Error("Runner fixture claim failed");
  const resolved: ResolvedPreinstalledTarget = {
    entryPointPath: targetPath,
    executableSha256: release.build.executableSha256,
    implementationId:
      release.execution.kind === "preinstalled" ? release.execution.implementationId : "",
    implementationSha256:
      release.execution.kind === "preinstalled" ? release.execution.implementationSha256 : "",
    invocationSha256: release.build.invocationSha256,
    launcherArguments: [],
    launcherPath: process.execPath,
    releaseDefinitionSha256: release.definitionSha256,
    runtime: release.runtime,
  };
  const publish = vi.fn(
    async (command: PublishReplayAttemptReportCommand): Promise<unknown> =>
      command.contentReference,
  );
  return {
    definitions,
    jobRepository,
    options: {
      availableEnvironment: {},
      boundaryResolver: {
        resolve: async () => {
          throw new Error("The zero-request runner fixture cannot resolve a boundary");
        },
      },
      definitions,
      heartbeatIntervalMilliseconds: 20,
      leaseDurationMilliseconds: 200,
      registry: { resolve: async () => resolved },
      reportPublisher: { publish },
      repository: jobRepository,
      scope,
      snapshot: claimed.snapshot,
      terminationGraceMilliseconds: 10,
      workerFence: claimed.workerFence,
      workspaceParent,
    },
    plan,
    publish,
    release,
  };
}

beforeAll(async () => {
  const document = (await import("../../../packages/replay/vectors/replay-definition-v1.json", {
    with: { type: "json" },
  })) as { default: { vectors: readonly { input: unknown; kind: string }[] } };
  const releaseVector = document.default.vectors.find(({ kind }) => kind === "target_release");
  const planVector = document.default.vectors.find(({ kind }) => kind === "replay_plan");
  if (!releaseVector || !planVector) throw new Error("Replay definition vectors are incomplete");
  baseReleaseDefinition = TargetReleaseDefinitionSchema.parse(releaseVector.input);
  basePlanDefinition = ReplayPlanDefinitionSchema.parse(planVector.input);
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("runClaimedReplayAttempt", () => {
  it("runs one exact target, accounts for it, and commits its bounded report", async () => {
    const value = await fixture();
    const result = await runClaimedReplayAttempt(value.options);
    expect(result.sessionId).toMatch(/^rts_[0-9a-f]{40}$/);
    expect(result.reservationId).toMatch(/^rsv_[0-9a-f]{40}$/);
    expect(result.processResult).toMatchObject({
      exitCode: 0,
      failureCode: null,
      status: "completed",
    });
    expect(result.snapshot.job.status).toBe("succeeded");
    expect(result.snapshot.budgetLedger.map(({ entryType }) => entryType)).toEqual([
      "reservation",
      "reconciliation",
    ]);
    expect(result.snapshot.usageObservations).toHaveLength(1);
    expect(result.snapshot.executionObservations).toHaveLength(10);
    expect(value.publish).toHaveBeenCalledOnce();
    expect(value.publish.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("binds recorded boundary resolution to the exact fenced session", async () => {
    const value = await fixture("boundary");
    const resolve = vi.fn(async () => boundaryResponse());
    const parsedResponse = RecordedBoundaryResponseSchema.safeParse(boundaryResponse());
    if (!parsedResponse.success) throw parsedResponse.error;
    const { terminationGraceMilliseconds, ...withoutGrace } = value.options;
    void terminationGraceMilliseconds;
    const result = await runClaimedReplayAttempt({
      ...withoutGrace,
      boundaryResolver: { resolve },
    });
    expect(result.processResult).toMatchObject({ failureCode: null, status: "completed" });
    expect(result.snapshot.job.status).toBe("succeeded");
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        boundaryId: "bnd_vector_model",
        plan: value.plan,
        scope,
        sessionId: result.sessionId,
        targetRelease: value.release,
        workerFence: value.options.workerFence,
      }),
    );
    const modelUsage = result.snapshot.usageObservations[0]?.measurements.find(
      ({ dimension }) => dimension === "modelRequests",
    );
    expect(modelUsage?.usage).toEqual({ amount: 1, source: "measured", status: "observed" });
  });

  it("honors durable cancellation before resolving definitions or target content", async () => {
    const value = await fixture();
    await value.jobRepository.requestCancellation({
      input: {
        cancellationId: "can_runner_before_start",
        reason: "Stop before target preparation",
        reasonCode: "operator_request",
      },
      jobId: value.options.snapshot.job.jobId,
      requestedByPrincipalId: "usr_runner",
      scope,
    });
    const findReplayPlan = vi.fn(value.definitions.findReplayPlan.bind(value.definitions));
    const resolve = vi.fn(value.options.registry.resolve.bind(value.options.registry));
    const result = await runClaimedReplayAttempt({
      ...value.options,
      definitions: definitionPort(value.definitions, { findReplayPlan }),
      registry: { resolve },
    });
    expect(result.snapshot.job.status).toBe("cancelled");
    expect(result.snapshot.cancellationAcknowledgements).toEqual([
      expect.objectContaining({ action: "stopped_before_target_start" }),
    ]);
    expect(result.snapshot.budgetLedger).toEqual([]);
    expect(findReplayPlan).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(value.publish).not.toHaveBeenCalled();
  });

  it("fails closed when immutable definitions or preflight lineage are unavailable", async () => {
    for (const definitions of [
      (value: Fixture) => definitionPort(value.definitions, { findReplayPlan: async () => null }),
      (value: Fixture) =>
        definitionPort(value.definitions, { findTargetRelease: async () => null }),
      (value: Fixture) =>
        definitionPort(value.definitions, {
          findReplayPlan: async () => ({ ...value.plan, hidden: true }) as ReplayPlan,
        }),
      (value: Fixture) =>
        definitionPort(value.definitions, {
          findReplayPlan: async () =>
            ({
              ...value.plan,
              scope: { ...value.plan.scope, projectId: "prj_other" },
            }) as ReplayPlan,
        }),
      (value: Fixture) =>
        definitionPort(value.definitions, {
          findReplayPlan: async () => ({ ...value.plan, planId: "plan_other" }) as ReplayPlan,
        }),
    ]) {
      const value = await fixture();
      const result = await runClaimedReplayAttempt({
        ...value.options,
        definitions: definitions(value),
      });
      expect(result.snapshot.job.status).toBe("failed");
      expect(result.snapshot.budgetLedger).toEqual([]);
      expect(value.publish).not.toHaveBeenCalled();
    }
  });

  it("reconciles launch, process, publication, and external cancellation failures", async () => {
    const launch = await fixture();
    const launchResult = await runClaimedReplayAttempt({
      ...launch.options,
      registry: { resolve: async () => null },
    });
    expect(launchResult.snapshot.attempts[0]?.error?.code).toBe("target_content_unavailable");

    const process = await fixture("exit_nonzero");
    const processResult = await runClaimedReplayAttempt(process.options);
    expect(processResult.snapshot.attempts[0]?.error?.code).toBe("target_process_interrupted");

    const publication = await fixture();
    const publicationResult = await runClaimedReplayAttempt({
      ...publication.options,
      reportPublisher: {
        publish: async () => {
          throw new Error("temporary artifact failure");
        },
      },
    });
    expect(publicationResult.snapshot.attempts[0]?.error?.code).toBe("target_temporary_failure");
    expect(emittedArtifactUsage(publicationResult.snapshot)).toMatchObject({
      amount: publication.plan.budget.emittedArtifactBytes.limit,
    });

    const dishonestPublication = await fixture();
    const dishonestResult = await runClaimedReplayAttempt({
      ...dishonestPublication.options,
      reportPublisher: { publish: async () => ({}) },
    });
    expect(dishonestResult.snapshot.attempts[0]?.error?.code).toBe("worker_internal_error");
    expect(emittedArtifactUsage(dishonestResult.snapshot)).toMatchObject({
      amount: dishonestPublication.plan.budget.emittedArtifactBytes.limit,
    });

    const oversizedReport = await fixture("complete", 1);
    const oversizedResult = await runClaimedReplayAttempt(oversizedReport.options);
    expect(oversizedResult.snapshot.attempts[0]?.error?.code).toBe("isolation_failed");
    expect(emittedArtifactUsage(oversizedResult.snapshot)).toMatchObject({ amount: 0 });

    const registryFailure = await fixture();
    const registryResult = await runClaimedReplayAttempt({
      ...registryFailure.options,
      registry: {
        resolve: async () => {
          throw new Error("registry unavailable");
        },
      },
    });
    expect(registryResult.snapshot.attempts[0]?.error?.code).toBe("worker_internal_error");

    const cancelled = await fixture();
    const controller = new AbortController();
    controller.abort("worker shutdown");
    const cancelledResult = await runClaimedReplayAttempt({
      ...cancelled.options,
      signal: controller.signal,
    });
    expect(cancelledResult.snapshot.attempts[0]?.error?.code).toBe("authority_denied");

    const publicationCancellation = await fixture();
    const publicationController = new AbortController();
    const publicationCancellationResult = await runClaimedReplayAttempt({
      ...publicationCancellation.options,
      reportPublisher: {
        publish: async () => {
          publicationController.abort("worker shutdown during publication");
          throw new Error("publication interrupted");
        },
      },
      signal: publicationController.signal,
    });
    expect(publicationCancellationResult.snapshot.attempts[0]?.error?.code).toBe(
      "authority_denied",
    );
    expect(emittedArtifactUsage(publicationCancellationResult.snapshot)).toMatchObject({
      amount: publicationCancellation.plan.budget.emittedArtifactBytes.limit,
    });

    for (const result of [
      launchResult,
      processResult,
      publicationResult,
      dishonestResult,
      oversizedResult,
      registryResult,
      cancelledResult,
      publicationCancellationResult,
    ]) {
      expect(result.snapshot.budgetLedger.map(({ entryType }) => entryType)).toEqual([
        "reservation",
        "reconciliation",
      ]);
    }
  });

  it("lets durable cancellation observed after publication win terminal ordering", async () => {
    const value = await fixture();
    const result = await runClaimedReplayAttempt({
      ...value.options,
      reportPublisher: {
        publish: async (command) => {
          await value.jobRepository.requestCancellation({
            input: {
              cancellationId: "can_runner_late",
              reason: "Stop while the report is being published",
              reasonCode: "safety_intervention",
            },
            jobId: value.options.snapshot.job.jobId,
            requestedByPrincipalId: "usr_runner",
            scope,
          });
          return command.contentReference;
        },
      },
    });
    expect(result.snapshot.job.status).toBe("cancelled");
    expect(result.snapshot.cancellationAcknowledgements).toEqual([
      expect.objectContaining({ action: "observed_after_uninterruptible_completion" }),
    ]);
    expect(result.snapshot.attempts[0]?.result).toBeUndefined();
    expect(result.snapshot.budgetLedger).toHaveLength(2);
  });

  it("requests a stop when durable cancellation arrives inside a recorded boundary", async () => {
    const value = await fixture("boundary");
    const result = await runClaimedReplayAttempt({
      ...value.options,
      boundaryResolver: {
        resolve: async () => {
          await value.jobRepository.requestCancellation({
            input: {
              cancellationId: "can_runner_boundary",
              reason: "Stop inside the recorded boundary",
              reasonCode: "safety_intervention",
            },
            jobId: value.options.snapshot.job.jobId,
            requestedByPrincipalId: "usr_runner",
            scope,
          });
          await new Promise((resolve) => setTimeout(resolve, 50));
          return boundaryResponse();
        },
      },
    });
    expect(result.snapshot.job.status).toBe("cancelled");
    expect(result.snapshot.cancellationAcknowledgements).toEqual([
      expect.objectContaining({ action: "stop_requested" }),
    ]);
    expect(result.processResult.status).toBe("cancelled");
  });

  it("recovers a cancellation that commits at the final completion boundary", async () => {
    const value = await fixture();
    let injected = false;
    const completeJob = async (command: Parameters<ReplayJobRepository["completeJob"]>[0]) => {
      if (!injected) {
        injected = true;
        await value.jobRepository.requestCancellation({
          input: {
            cancellationId: "can_runner_completion_race",
            reason: "Win the final completion race",
            reasonCode: "policy_intervention",
          },
          jobId: command.workerFence.jobId,
          requestedByPrincipalId: "usr_runner",
          scope,
        });
      }
      return await value.jobRepository.completeJob(command);
    };
    const result = await runClaimedReplayAttempt({
      ...value.options,
      repository: repositoryPort(value.jobRepository, { completeJob }),
    });
    expect(result.snapshot.job.status).toBe("cancelled");
    expect(result.snapshot.cancellationAcknowledgements).toHaveLength(1);
    expect(injected).toBe(true);
  });

  it("does not disguise unrelated or already-acknowledged completion failures", async () => {
    const unrelated = await fixture();
    await expect(
      runClaimedReplayAttempt({
        ...unrelated.options,
        repository: repositoryPort(unrelated.jobRepository, {
          completeJob: async () => {
            throw new Error("terminal outbox unavailable");
          },
        }),
      }),
    ).rejects.toThrow("terminal outbox unavailable");

    const acknowledged = await fixture();
    await expect(
      runClaimedReplayAttempt({
        ...acknowledged.options,
        reportPublisher: {
          publish: async (command) => {
            await acknowledged.jobRepository.requestCancellation({
              input: {
                cancellationId: "can_runner_acknowledged_failure",
                reason: "Preserve the acknowledged cancellation",
                reasonCode: "operator_request",
              },
              jobId: acknowledged.options.snapshot.job.jobId,
              requestedByPrincipalId: "usr_runner",
              scope,
            });
            return command.contentReference;
          },
        },
        repository: repositoryPort(acknowledged.jobRepository, {
          completeJob: async () => {
            throw new Error("terminal intent unavailable");
          },
        }),
      }),
    ).rejects.toThrow("terminal intent unavailable");
  });

  it("leaves an open reservation for fenced recovery when heartbeat authority is lost", async () => {
    const value = await fixture();
    let heartbeatCount = 0;
    const heartbeatJob = async (command: Parameters<ReplayJobRepository["heartbeatJob"]>[0]) => {
      heartbeatCount += 1;
      if (heartbeatCount === 3) throw new Error("lease storage unavailable");
      return await value.jobRepository.heartbeatJob(command);
    };
    await expect(
      runClaimedReplayAttempt({
        ...value.options,
        repository: repositoryPort(value.jobRepository, { heartbeatJob }),
      }),
    ).rejects.toMatchObject({ code: "heartbeat_failed", name: "ReplayLeaseHeartbeatError" });
    const snapshot = await value.jobRepository.findJob(scope, value.options.snapshot.job.jobId);
    expect(snapshot?.job.status).toBe("running");
    expect(snapshot?.budgetLedger.map(({ entryType }) => entryType)).toEqual(["reservation"]);
    expect(value.publish).not.toHaveBeenCalled();
  });

  it("rejects invalid policy and stale runner authority before mutation", async () => {
    const value = await fixture();
    const heartbeat = vi.spyOn(value.jobRepository, "heartbeatJob");
    for (const override of [
      { heartbeatIntervalMilliseconds: 0 },
      { leaseDurationMilliseconds: 1 },
      { heartbeatIntervalMilliseconds: 101 },
      { terminationGraceMilliseconds: 0 },
    ]) {
      await expect(
        runClaimedReplayAttempt({ ...value.options, ...override }),
      ).rejects.toMatchObject({ code: "invalid_runner_policy" });
    }
    for (const override of [
      { scope: { ...scope, projectId: "prj_other" } },
      {
        workerFence: {
          ...(value.options.workerFence as ReplayWorkerMutationFence),
          fencingToken: 99,
        },
      },
      {
        snapshot: {
          ...value.options.snapshot,
          job: { ...value.options.snapshot.job, hidden: true },
        },
      },
    ]) {
      await expect(
        runClaimedReplayAttempt({ ...value.options, ...override }),
      ).rejects.toMatchObject({ code: "invalid_runner_context" });
    }
    expect(heartbeat).not.toHaveBeenCalled();
  });
});
