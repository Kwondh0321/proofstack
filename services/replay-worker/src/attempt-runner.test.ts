import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EvidenceScope,
  type RecordedBoundaryResponse,
  RecordedBoundaryResponseSchema,
  type ReplayBoundaryDeclaration,
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
import type { PublishReplayAttemptReportCommand } from "./attempt-report.js";
import {
  type ResolveClaimedReplayBoundaryInput,
  type RunClaimedReplayAttemptOptions,
  type RunClaimedReplayAttemptV2Options,
  runClaimedReplayAttempt,
  runClaimedReplayAttemptV2,
} from "./attempt-runner.js";
import type { ReplayBoundaryExecutorPorts } from "./boundary-dispatch.js";
import type { ReplayLiveProviderInvocation } from "./live-provider-boundary.js";
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

function targetSourceV2(
  boundary: Pick<ReplayBoundaryDeclaration, "boundaryId" | "kind"> | null,
): string {
  const processBoundary =
    boundary === null ? null : { boundaryId: boundary.boundaryId, kind: boundary.kind };
  return String.raw`
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";

const boundary = ${JSON.stringify(processBoundary)};
const input = createReadStream("/dev/null", { autoClose: false, fd: Number(process.env.PROOFSTACK_WORKER_PROTOCOL_INPUT_FD) });
const output = createWriteStream("/dev/null", { autoClose: false, fd: Number(process.env.PROOFSTACK_WORKER_PROTOCOL_OUTPUT_FD) });
const hold = setInterval(() => undefined, 1_000);
const send = (message) => output.write(JSON.stringify(message) + "\n");
const finish = () => {
  clearInterval(hold);
  process.exitCode = 0;
  input.destroy();
  output.end();
};

createInterface({ crlfDelay: Infinity, input }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "start") {
    send({
      schemaVersion: "0.2",
      sessionId: message.sessionId,
      targetAdapter: message.targetRelease.targetAdapter,
      type: "ready",
      workerProtocol: message.targetRelease.workerProtocol,
    });
    if (boundary === null) {
      send({ requestCount: 0, schemaVersion: "0.2", sessionId: message.sessionId, type: "completed" });
      finish();
      return;
    }
    send({
      boundaryId: boundary.boundaryId,
      request: {
        boundaryRequestId: "brr_runner_001",
        kind: boundary.kind,
        normalizedRequest: {
          adapter: { name: "proofstack.reference.model", version: "1.0.0" },
          bytes: "e30",
          encoding: "base64url",
        },
        schemaVersion: "0.1",
      },
      requestSequence: 0,
      schemaVersion: "0.2",
      sessionId: message.sessionId,
      type: "boundary_request",
    });
    return;
  }
  if (message.type === "boundary_result") {
    send({ requestCount: 1, schemaVersion: "0.2", sessionId: message.sessionId, type: "completed" });
    finish();
    return;
  }
  if (message.type === "stop" || message.type === "abort") finish();
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

function publishedReleaseV2(source: string, emittedArtifactBytes = 1_048_576): TargetRelease {
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
    supportedBoundaryKinds: ["model", "retrieval", "tool"],
    supportedBoundaryModes: ["live_provider", "recorded_stub", "simulation"],
    workerProtocol: { name: "proofstack.replay-worker", version: "2.0.0" },
  });
  return TargetReleaseSchema.parse({
    createdAt: "2026-08-30T00:00:00.000Z",
    createdByPrincipalId: "usr_runner",
    definitionSha256: digestTargetReleaseDefinition(definition),
    ...definition,
  });
}

function recordedBoundaryV2(): ReplayBoundaryDeclaration {
  const boundary = basePlanDefinition.boundaries[0];
  if (boundary?.mode !== "recorded_stub") throw new Error("Expected recorded vector boundary");
  return boundary;
}

function simulationBoundaryV2(release: TargetRelease): ReplayBoundaryDeclaration {
  return {
    boundaryId: "bnd_simulation_model",
    configurationSha256: sha("1"),
    kind: "model",
    mode: "simulation",
    qualification: {
      artifactId: "art_runner_simulation_qualification",
      classification: "internal",
      mediaType: "application/json",
      sha256: sha("2"),
      sizeBytes: 64,
    },
    seedHex: sha("3"),
    simulatorRelease: releaseReference(release),
  };
}

function liveBoundaryV2(): ReplayBoundaryDeclaration {
  return {
    boundaryId: "bnd_live_model",
    credential: {
      credentialId: "cred_runner_provider",
      credentialVersionId: "crv_runner_provider_001",
    },
    destination: { hostname: "api.example.com", port: 443, scheme: "https" },
    endpointProfile: {
      definitionSha256: sha("4"),
      endpointProfileId: "end_runner_provider",
      endpointProfileVersion: "1.0.0",
    },
    kind: "model",
    mode: "live_provider",
    operation: "chat",
    requestLimits: { requestBytes: 64, responseBytes: 64 },
    sideEffect: { kind: "read_only" },
    usageSource: "provider_reported",
  };
}

function publishedPlanV2(
  release: TargetRelease,
  boundary: ReplayBoundaryDeclaration,
  emittedArtifactBytes = 1_048_576,
): ReplayPlan {
  const providerMeasured = boundary.mode === "live_provider";
  const definition = ReplayPlanDefinitionSchema.parse({
    ...basePlanDefinition,
    boundaries: [boundary],
    budget: {
      ...basePlanDefinition.budget,
      elapsedMilliseconds: { limit: 10_000, measurement: "measured" },
      emittedArtifactBytes: { limit: emittedArtifactBytes, measurement: "measured" },
      inputTokens: {
        ...basePlanDefinition.budget.inputTokens,
        measurement: providerMeasured ? "provider_reported" : "measured",
      },
      outputTokens: {
        ...basePlanDefinition.budget.outputTokens,
        measurement: providerMeasured ? "provider_reported" : "measured",
      },
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

function normalizedBoundaryResponse() {
  const bytes = Buffer.from("provider response", "utf8");
  return {
    adapter: { name: "proofstack.reference.model", version: "1.0.0" },
    bytes: bytes.toString("base64url"),
    encoding: "base64url" as const,
    normalizedResponseSha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
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

interface FixtureV2 {
  readonly boundary: ReplayBoundaryDeclaration;
  readonly definitions: MemoryReplayDefinitionRepository;
  readonly jobRepository: MemoryReplayJobRepository;
  readonly options: RunClaimedReplayAttemptV2Options;
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

async function fixtureV2(
  mode: "live_provider" | "recorded_stub" | "simulation",
  emittedArtifactBytes = 1_048_576,
): Promise<FixtureV2> {
  const root = await mkdtemp(join(tmpdir(), "proofstack-attempt-runner-v2-test-"));
  temporaryDirectories.push(root);
  const workspaceParent = join(root, "workspaces");
  await mkdir(workspaceParent);

  const provisionalBoundary =
    mode === "recorded_stub"
      ? recordedBoundaryV2()
      : mode === "live_provider"
        ? liveBoundaryV2()
        : null;
  const provisionalSource = targetSourceV2(
    provisionalBoundary ?? { boundaryId: "bnd_simulation_model", kind: "model" },
  );
  const release = publishedReleaseV2(provisionalSource, emittedArtifactBytes);
  const boundary =
    mode === "simulation"
      ? simulationBoundaryV2(release)
      : (provisionalBoundary as ReplayBoundaryDeclaration);
  const source = targetSourceV2(boundary);
  if (source !== provisionalSource) throw new Error("V2 target source projection is unstable");
  const targetPath = join(root, "target.mjs");
  await writeFile(targetPath, source);
  const plan = publishedPlanV2(release, boundary, emittedArtifactBytes);
  const definitions = new MemoryReplayDefinitionRepository();
  await definitions.publishTargetRelease(release);
  await definitions.publishReplayPlan(plan);
  const now = new Date().toISOString();
  const jobRepository = new MemoryReplayJobRepository({ definitions, now: () => now });
  const created = await jobRepository.createJob({
    createdByPrincipalId: "usr_runner",
    jobId: `job_runner_v2_${mode}`,
    plan: {
      definitionSha256: plan.definitionSha256,
      planId: plan.planId,
      planVersionId: plan.planVersionId,
    },
    scope,
  });
  const claimed = await jobRepository.claimJob({
    attemptId: `att_runner_v2_${mode}`,
    jobId: created.snapshot.job.jobId,
    leaseDurationMilliseconds: 200,
    leaseId: `lea_runner_v2_${mode}`,
    scope,
    workerBuildSha256: sha("d"),
    workerId: "wrk_runner_v2_001",
    workerProtocol: plan.workerProtocol,
  });
  if (!claimed.claimed) throw new Error("V2 runner fixture claim failed");
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
    boundary,
    definitions,
    jobRepository,
    options: {
      availableEnvironment: {},
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
    const resolve = vi.fn(async (_input: ResolveClaimedReplayBoundaryInput) => boundaryResponse());
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
  }, 30_000);

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

describe("runClaimedReplayAttemptV2", () => {
  it("runs one exact simulator and publishes only a source-bearing summary", async () => {
    const value = await fixtureV2("simulation");
    const resolve = vi.fn(
      async (
        query: Parameters<NonNullable<ReplayBoundaryExecutorPorts["simulation"]>["resolve"]>[0],
      ) => ({
        ...query,
        simulate: async () => ({
          response: normalizedBoundaryResponse(),
          usage: [
            {
              dimension: "inputTokens" as const,
              usage: { amount: 2, source: "measured" as const, status: "observed" as const },
            },
            {
              dimension: "modelRequests" as const,
              usage: { amount: 1, source: "measured" as const, status: "observed" as const },
            },
            {
              dimension: "outputTokens" as const,
              usage: { amount: 3, source: "measured" as const, status: "observed" as const },
            },
          ],
        }),
      }),
    );
    const { terminationGraceMilliseconds, ...withoutGrace } = value.options;
    void terminationGraceMilliseconds;
    const result = await runClaimedReplayAttemptV2({
      ...withoutGrace,
      boundaryPorts: { simulation: { resolve } },
    });

    expect(result.processResult).toMatchObject({
      boundaryResults: [
        {
          boundaryId: "bnd_simulation_model",
          executionOrigin: "simulated",
          mode: "simulation",
        },
      ],
      failureCode: null,
      status: "completed",
    });
    expect(result.snapshot.job.status).toBe("succeeded");
    expect(result.snapshot.budgetLedger.map(({ entryType }) => entryType)).toEqual([
      "reservation",
      "reconciliation",
    ]);
    expect(resolve).toHaveBeenCalledWith(
      {
        configurationSha256:
          value.boundary.mode === "simulation" ? value.boundary.configurationSha256 : "",
        qualification: value.boundary.mode === "simulation" ? value.boundary.qualification : {},
        simulatorRelease:
          value.boundary.mode === "simulation" ? value.boundary.simulatorRelease : {},
      },
      expect.any(AbortSignal),
    );
    const reportText = Buffer.from(value.publish.mock.calls[0]?.[0].content ?? []).toString("utf8");
    expect(reportText).not.toContain(normalizedBoundaryResponse().bytes);
    expect(JSON.parse(reportText)).toMatchObject({
      boundaryResults: {
        count: 1,
        entries: [
          {
            boundaryId: "bnd_simulation_model",
            executionOrigin: "simulated",
            mode: "simulation",
            usage: expect.arrayContaining([
              {
                dimension: "inputTokens",
                usage: { amount: 2, source: "measured", status: "observed" },
              },
            ]),
          },
        ],
      },
      schemaVersion: "0.2",
      session: {
        boundaries: [{ boundaryId: "bnd_simulation_model", kind: "model", mode: "simulation" }],
      },
    });
  });

  it("binds the v2 recorded adapter to the exact plan, release, scope, session, and fence", async () => {
    const value = await fixtureV2("recorded_stub");
    const resolve = vi.fn(async (_input: ResolveClaimedReplayBoundaryInput) => boundaryResponse());
    const result = await runClaimedReplayAttemptV2({
      ...value.options,
      boundaryResolver: { resolve },
    });

    expect(result.processResult).toMatchObject({
      boundaryResults: [
        {
          boundaryId: "bnd_vector_model",
          executionOrigin: "recorded",
          mode: "recorded_stub",
        },
      ],
      failureCode: null,
      status: "completed",
    });
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
    expect(resolve.mock.calls[0]?.[0].request).toMatchObject({
      boundaryRequestId: "brr_runner_001",
      normalizedRequest: {
        adapterName: "proofstack.reference.model",
        adapterVersion: "1.0.0",
      },
    });
  });

  it("executes an allowlisted read-only live provider without exposing credential values", async () => {
    const value = await fixtureV2("live_provider");
    const execute = vi.fn(async (_input: ReplayLiveProviderInvocation) => ({
      response: normalizedBoundaryResponse(),
      usage: [
        {
          dimension: "inputTokens" as const,
          usage: {
            amount: 5,
            source: "provider_reported" as const,
            status: "observed" as const,
          },
        },
        {
          dimension: "modelRequests" as const,
          usage: {
            amount: 1,
            source: "provider_reported" as const,
            status: "observed" as const,
          },
        },
        {
          dimension: "outputTokens" as const,
          usage: {
            amount: 7,
            source: "provider_reported" as const,
            status: "observed" as const,
          },
        },
      ],
    }));
    const registryResolve = vi.fn(
      async (
        query: Parameters<NonNullable<ReplayBoundaryExecutorPorts["liveProvider"]>["resolve"]>[0],
      ) => ({ ...query, execute }),
    );
    const result = await runClaimedReplayAttemptV2({
      ...value.options,
      boundaryPorts: { liveProvider: { resolve: registryResolve } },
    });

    expect(result.processResult).toMatchObject({
      boundaryResults: [
        {
          effectCertainty: "none",
          executionOrigin: "live",
          mode: "live_provider",
        },
      ],
      failureCode: null,
      status: "completed",
    });
    expect(result.snapshot.job.status).toBe("succeeded");
    expect(registryResolve).toHaveBeenCalledWith(
      {
        destination: value.boundary.mode === "live_provider" ? value.boundary.destination : {},
        endpointProfile:
          value.boundary.mode === "live_provider" ? value.boundary.endpointProfile : {},
        operation: value.boundary.mode === "live_provider" ? value.boundary.operation : "",
        sideEffect: value.boundary.mode === "live_provider" ? value.boundary.sideEffect : {},
      },
      expect.any(AbortSignal),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: value.boundary.mode === "live_provider" ? value.boundary.credential : undefined,
        scope,
      }),
    );
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty("idempotencyKey");
    const inputUsage = result.snapshot.usageObservations[0]?.measurements.find(
      ({ dimension }) => dimension === "inputTokens",
    );
    expect(inputUsage?.usage).toEqual({
      amount: 5,
      source: "provider_reported",
      status: "observed",
    });
  });

  it("fails without changing mode when the selected executor is unavailable", async () => {
    const value = await fixtureV2("simulation");
    const liveResolve = vi.fn();
    const recordedResolve = vi.fn(async () => boundaryResponse());
    const result = await runClaimedReplayAttemptV2({
      ...value.options,
      boundaryPorts: { liveProvider: { resolve: liveResolve } },
      boundaryResolver: { resolve: recordedResolve },
    });

    expect(result.processResult).toMatchObject({
      boundaryResults: [],
      failureCode: "boundary_resolution_failed",
      status: "failed",
    });
    expect(result.snapshot.job.status).toBe("failed");
    expect(result.snapshot.attempts[0]?.error?.code).toBe("fixture_unavailable");
    expect(liveResolve).not.toHaveBeenCalled();
    expect(recordedResolve).not.toHaveBeenCalled();
    expect(value.publish).not.toHaveBeenCalled();
    expect(result.snapshot.budgetLedger.map(({ entryType }) => entryType)).toEqual([
      "reservation",
      "reconciliation",
    ]);
  });

  it("fails closed before reservation for invalid v2 definitions and reconciles launch failure", async () => {
    const invalid = await fixtureV2("simulation");
    const invalidResult = await runClaimedReplayAttemptV2({
      ...invalid.options,
      definitions: definitionPort(invalid.definitions, {
        findTargetRelease: async () => ({
          ...invalid.release,
          supportedBoundaryModes: ["recorded_stub"],
        }),
      }),
    });
    expect(invalidResult.processResult).toMatchObject({
      boundaryResults: [],
      failureCode: "protocol_failed",
      status: "failed",
    });
    expect(invalidResult.snapshot.budgetLedger).toEqual([]);
    expect(invalid.publish).not.toHaveBeenCalled();

    const unavailable = await fixtureV2("simulation");
    const unavailableResult = await runClaimedReplayAttemptV2({
      ...unavailable.options,
      registry: { resolve: async () => null },
    });
    expect(unavailableResult.processResult).toMatchObject({
      boundaryResults: [],
      failureCode: "spawn_failed",
      status: "failed",
    });
    expect(unavailableResult.snapshot.job.status).toBe("failed");
    expect(unavailableResult.snapshot.budgetLedger.map(({ entryType }) => entryType)).toEqual([
      "reservation",
      "reconciliation",
    ]);
  });
});
