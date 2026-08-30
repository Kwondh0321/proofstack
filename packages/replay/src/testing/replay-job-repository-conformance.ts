import type {
  EvidenceScope,
  ReplayBoundaryDeclaration,
  ReplayPlan,
  ReplayPlanDefinition,
  ReplayUsageMeasurement,
  TargetRelease,
  TargetReleaseDefinition,
} from "@proofstack/contracts";
import {
  REPLAY_BUDGET_DIMENSIONS,
  ReplayPlanSchema,
  TargetReleaseSchema,
} from "@proofstack/contracts";
import {
  DurableReplayAccountingError,
  DurableReplayStateError,
  ReplayDefinitionLineageError,
  ReplayJobConflictError,
  ReplayJobNotFoundError,
  ReplayRepositoryContractError,
} from "../errors.js";
import type { ReplayDefinitionRepository } from "../replay-definition-repository.js";
import {
  digestReplayPlanDefinition,
  digestTargetReleaseDefinition,
} from "../replay-definition-digest.js";
import type { ReplayJobOutboxIntent } from "../replay-job-outbox.js";
import type {
  ClaimDurableReplayJobCommand,
  ReplayJobRepository,
} from "../replay-job-repository.js";
import { digestRecordedBoundaryReplayInvocationDefinition } from "../replay-digest.js";
import type { ReplayJobIntentKind } from "./memory-replay-job-repository.js";

export interface ReplayJobRepositoryTestHarness {
  readonly definitions: ReplayDefinitionRepository;
  readonly dispose?: () => Promise<void>;
  readonly failNextIntent: (kind: ReplayJobIntentKind) => Promise<void> | void;
  readonly hideNextDefinitionLookup: (kind: "replay_plan" | "target_release") => void;
  readonly publishedIntents: (tenantId: string) => Promise<readonly ReplayJobOutboxIntent[]>;
  readonly removeIntent: (
    kind: ReplayJobIntentKind,
    tenantId: string,
    jobId: string,
  ) => Promise<void> | void;
  readonly repository: ReplayJobRepository;
  readonly setNow: (value: string) => void;
}

export type ReplayJobRepositoryTestFactory = (
  namespace: string,
) => Promise<ReplayJobRepositoryTestHarness> | ReplayJobRepositoryTestHarness;

export interface ReplayJobRepositoryConformanceCase {
  readonly name: string;
  readonly run: (factory: ReplayJobRepositoryTestFactory) => Promise<void>;
}

const sha = (digit: string): string => digit.repeat(64);
const workerProtocol = { name: "proofstack.replay-worker", version: "1.0.0" };
const targetAdapter = {
  name: "proofstack.reference_target",
  protocolVersion: "1.0.0",
  version: "1.0.0",
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`);
}

async function rejectsWith(
  operation: Promise<unknown>,
  ErrorType: abstract new (...arguments_: never[]) => Error,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    assert(error instanceof ErrorType, `Expected ${ErrorType.name}`);
    return;
  }
  throw new Error(`Expected ${ErrorType.name}`);
}

function scope(namespace: string, suffix = "primary"): EvidenceScope {
  return {
    environmentId: `env_${namespace}_${suffix}`,
    projectId: `prj_${namespace}_${suffix}`,
    tenantId: `ten_${namespace}`,
  };
}

function releaseDefinition(
  namespace: string,
  releaseScope: EvidenceScope,
): TargetReleaseDefinition {
  return {
    build: {
      builderId: "proofstack.reference_builder",
      dependencySnapshotSha256: sha("1"),
      executableSha256: sha("2"),
      invocationSha256: sha("3"),
      provenance: {
        artifactId: `art_${namespace}_provenance`,
        classification: "internal",
        mediaType: "application/json",
        sha256: sha("4"),
        sizeBytes: 128,
      },
    },
    environmentVariableNames: [],
    execution: {
      implementationId: `impl_${namespace}_target`,
      implementationSha256: sha("5"),
      kind: "preinstalled",
    },
    mounts: [],
    outputLimits: {
      emittedArtifactBytes: 1_048_576,
      stderrBytes: 65_536,
      stdoutBytes: 65_536,
    },
    runtime: {
      architecture: "x64",
      entryPoint: "dist/target.js",
      family: "node",
      platform: "linux",
      version: "24.7.0",
    },
    schemaVersion: "0.1",
    scope: releaseScope,
    source: {
      repositoryUrl: "https://github.com/Kwondh0321/proofstack",
      revision: "6".repeat(40),
    },
    subprocessPolicy: { mode: "denied" },
    supportedBoundaryKinds: ["model"],
    supportedBoundaryModes: ["live_provider", "recorded_stub"],
    targetAdapter,
    targetId: `target_${namespace}`,
    targetReleaseId: `trg_${namespace}_001`,
    workerProtocol,
  };
}

function release(namespace: string, releaseScope = scope(namespace)): TargetRelease {
  const definition = releaseDefinition(namespace, releaseScope);
  return TargetReleaseSchema.parse({
    createdAt: "2026-08-29T12:00:00.000Z",
    createdByPrincipalId: `usr_${namespace}`,
    definitionSha256: digestTargetReleaseDefinition(definition),
    ...definition,
  });
}

function recordedBoundary(namespace: string, target: TargetRelease): ReplayBoundaryDeclaration {
  const invocation = {
    fixture: {
      definitionSha256: sha("7"),
      fixtureId: `fix_${namespace}`,
      fixtureVersionId: `fiv_${namespace}_001`,
    },
    invocationId: `rpi_${namespace}_001`,
    runtime: {
      boundaryMode: "recorded_stub" as const,
      clock: { instant: "2026-08-29T00:00:00.000Z", mode: "fixed" as const },
      isolation: { mode: "cooperative_in_process" as const },
      locale: "en-US",
      network: { policy: "deny_fallback" as const },
      random: {
        algorithm: "hmac_sha256_counter_v1" as const,
        mode: "seeded" as const,
        seedHex: sha("8"),
      },
      timeZone: "UTC",
    },
    schemaVersion: "0.1" as const,
    targetAdapter: { name: target.targetAdapter.name, version: target.targetAdapter.version },
  };
  return {
    boundaryId: `bnd_${namespace}`,
    invocation,
    invocationDefinitionSha256: digestRecordedBoundaryReplayInvocationDefinition(invocation),
    kind: "model",
    mode: "recorded_stub",
  };
}

function liveBoundary(namespace: string, kind: "idempotent_write" | "read_only") {
  const sideEffect =
    kind === "read_only"
      ? { kind }
      : {
          idempotencyKeyScheme: "header.idempotency-key",
          kind,
          sandboxDestination: true as const,
        };
  return {
    boundaryId: `bnd_${namespace}`,
    credential: { credentialId: `cred_${namespace}`, credentialVersionId: `crv_${namespace}_001` },
    destination: { hostname: "api.example.com", port: 443 as const, scheme: "https" as const },
    endpointProfile: {
      definitionSha256: sha("c"),
      endpointProfileId: `end_${namespace}`,
      endpointProfileVersion: "1.0.0",
    },
    kind: "model" as const,
    mode: "live_provider" as const,
    operation: "generate",
    requestLimits: { requestBytes: 4_096, responseBytes: 65_536 },
    sideEffect,
    usageSource: "provider_reported" as const,
  } satisfies ReplayBoundaryDeclaration;
}

function planDefinition(
  namespace: string,
  target: TargetRelease,
  options: {
    readonly automatic?: boolean;
    readonly backoffMilliseconds?: number;
    readonly boundary?: ReplayBoundaryDeclaration;
    readonly maxAttempts?: number;
    readonly totalDeadlineMilliseconds?: number;
  } = {},
): ReplayPlanDefinition {
  const automatic = options.automatic ?? false;
  const maxAttempts = options.maxAttempts ?? 1;
  return {
    boundaries: [options.boundary ?? recordedBoundary(namespace, target)],
    budget: {
      concurrentInteractions: { limit: 4, measurement: "measured" },
      elapsedMilliseconds: { limit: 20_000, measurement: "measured" },
      emittedArtifactBytes: { limit: 1_048_576, measurement: "measured" },
      inputTokens: { limit: 4_096, measurement: "provider_reported" },
      jobAttempts: { limit: maxAttempts, measurement: "measured" },
      modelRequests: { limit: 4, measurement: "measured" },
      outputTokens: { limit: 4_096, measurement: "provider_reported" },
      providerCostMicrounits: { limit: 1_000_000, measurement: "unavailable" },
      retrievedBytes: { limit: 1_048_576, measurement: "measured" },
      toolCalls: { limit: 4, measurement: "measured" },
    },
    dataset: {
      datasetId: `dat_${namespace}`,
      datasetVersionId: `dsv_${namespace}_001`,
      definitionSha256: sha("9"),
    },
    isolationProfile: {
      definitionSha256: sha("a"),
      id: "iso_local_child",
      kind: "local_child_process",
      version: "1.0.0",
    },
    planId: `plan_${namespace}`,
    planVersionId: `plv_${namespace}_001`,
    retryPolicy: {
      automatic,
      backoff: automatic
        ? { delayMilliseconds: options.backoffMilliseconds ?? 1_000, kind: "fixed" }
        : { kind: "none" },
      idempotencyRequirement:
        options.boundary?.mode === "live_provider" &&
        options.boundary.sideEffect.kind === "idempotent_write"
          ? "destination_supported"
          : "no_external_effect",
      maxAttempts,
      perAttemptTimeoutMilliseconds: 2_000,
      retryableErrors: automatic ? ["target_process_interrupted"] : [],
      totalDeadlineMilliseconds: options.totalDeadlineMilliseconds ?? 10_000,
    },
    runtimeProfile: {
      definitionSha256: sha("b"),
      family: "node",
      id: "run_node_24",
      version: "1.0.0",
    },
    schemaVersion: "0.1",
    scope: target.scope,
    targetRelease: {
      definitionSha256: target.definitionSha256,
      targetAdapter: target.targetAdapter,
      targetId: target.targetId,
      targetReleaseId: target.targetReleaseId,
      workerProtocol: target.workerProtocol,
    },
    workerProtocol: target.workerProtocol,
  };
}

function plan(
  namespace: string,
  target: TargetRelease,
  options: Parameters<typeof planDefinition>[2] = {},
): ReplayPlan {
  const definition = planDefinition(namespace, target, options);
  return ReplayPlanSchema.parse({
    createdAt: "2026-08-29T12:00:01.000Z",
    createdByPrincipalId: `usr_${namespace}`,
    definitionSha256: digestReplayPlanDefinition(definition),
    ...definition,
  });
}

async function publishPlan(
  harness: ReplayJobRepositoryTestHarness,
  namespace: string,
  options: Parameters<typeof planDefinition>[2] = {},
): Promise<ReplayPlan> {
  const target = release(namespace);
  await harness.definitions.publishTargetRelease(target);
  const replayPlan = plan(namespace, target, options);
  await harness.definitions.publishReplayPlan(replayPlan);
  return replayPlan;
}

function planReference(replayPlan: ReplayPlan) {
  return {
    definitionSha256: replayPlan.definitionSha256,
    planId: replayPlan.planId,
    planVersionId: replayPlan.planVersionId,
  };
}

function createCommand(namespace: string, replayPlan: ReplayPlan, jobId = `job_${namespace}_001`) {
  return {
    createdByPrincipalId: `usr_${namespace}`,
    jobId,
    plan: planReference(replayPlan),
    scope: replayPlan.scope,
  };
}

function claimCommand(
  namespace: string,
  replayPlan: ReplayPlan,
  jobId = `job_${namespace}_001`,
  sequence = 1,
): ClaimDurableReplayJobCommand {
  return {
    attemptId: `att_${namespace}_${sequence.toString().padStart(3, "0")}`,
    jobId,
    leaseDurationMilliseconds: 2_000,
    leaseId: `lea_${namespace}_${sequence.toString().padStart(3, "0")}`,
    scope: replayPlan.scope,
    workerBuildSha256: sha("d"),
    workerId: `wrk_${namespace}_${sequence}`,
    workerProtocol,
  };
}

function amounts(overrides: Readonly<Record<string, number>> = {}) {
  return Object.fromEntries(
    REPLAY_BUDGET_DIMENSIONS.map((dimension) => [dimension, overrides[dimension] ?? 0]),
  ) as Record<(typeof REPLAY_BUDGET_DIMENSIONS)[number], number>;
}

function usage(overrides: Readonly<Record<string, ReplayUsageMeasurement>> = {}) {
  return Object.fromEntries(
    REPLAY_BUDGET_DIMENSIONS.map((dimension) => [
      dimension,
      overrides[dimension] ?? { amount: 0, source: "measured", status: "observed" },
    ]),
  ) as Record<(typeof REPLAY_BUDGET_DIMENSIONS)[number], ReplayUsageMeasurement>;
}

function resultArtifact(namespace: string) {
  return {
    artifactId: `art_${namespace}_result`,
    classification: "internal" as const,
    mediaType: "application/json",
    sha256: sha("e"),
    sizeBytes: 128,
  };
}

async function withHarness(
  factory: ReplayJobRepositoryTestFactory,
  namespace: string,
  test: (harness: ReplayJobRepositoryTestHarness) => Promise<void>,
): Promise<void> {
  const harness = await factory(namespace);
  try {
    await test(harness);
  } finally {
    await harness.dispose?.();
  }
}

export const replayJobRepositoryConformanceCases: readonly ReplayJobRepositoryConformanceCase[] = [
  {
    name: "creates exact-plan jobs idempotently with isolated ownership and atomic intent",
    async run(factory) {
      await withHarness(factory, "job_create", async (harness) => {
        const replayPlan = await publishPlan(harness, "job_create");
        const command = createCommand("job_create", replayPlan);
        const first = await harness.repository.createJob(command);
        equal(first.created, true, "job creation");
        equal((await harness.repository.createJob(command)).created, false, "job retry");
        equal(first.snapshot.job.status, "queued", "queued state");
        first.snapshot.job.createdByPrincipalId = "usr_mutated";
        equal(
          (await harness.repository.findJob(command.scope, command.jobId))?.job
            .createdByPrincipalId,
          "usr_job_create",
          "detached read",
        );
        equal(
          await harness.repository.findJob(scope("job_create", "other"), command.jobId),
          null,
          "scope hiding",
        );
        await rejectsWith(
          harness.repository.createJob({ ...command, createdByPrincipalId: "usr_other" }),
          ReplayJobConflictError,
        );
        await rejectsWith(
          harness.repository.createJob({
            ...command,
            jobId: "job_job_create_missing",
            plan: { ...command.plan, planVersionId: "plv_missing" },
          }),
          ReplayDefinitionLineageError,
        );
        equal((await harness.publishedIntents(command.scope.tenantId)).length, 1, "created intent");
        equal((await harness.publishedIntents("ten_unknown")).length, 0, "unknown tenant intents");
        await harness.removeIntent("job_created", "ten_unknown", "job_unknown");

        await harness.failNextIntent("job_created");
        const failed = { ...command, jobId: "job_job_create_failed" };
        await rejectsWith(harness.repository.createJob(failed), Error);
        equal(
          await harness.repository.findJob(command.scope, failed.jobId),
          null,
          "create rollback",
        );
        await harness.repository.createJob(failed);

        await harness.removeIntent("job_created", command.scope.tenantId, command.jobId);
        await rejectsWith(harness.repository.createJob(command), ReplayRepositoryContractError);
      });
    },
  },
  {
    name: "claims and heartbeats only exact current worker authority",
    async run(factory) {
      await withHarness(factory, "job_claim", async (harness) => {
        const replayPlan = await publishPlan(harness, "job_claim");
        const create = createCommand("job_claim", replayPlan);
        await harness.repository.createJob(create);
        const command = claimCommand("job_claim", replayPlan);
        await rejectsWith(
          harness.repository.claimJob({
            ...command,
            leaseDurationMilliseconds: replayPlan.retryPolicy.perAttemptTimeoutMilliseconds + 1,
          }),
          ReplayJobConflictError,
        );
        const claimed = await harness.repository.claimJob(command);
        assert(claimed.claimed, "first claim");
        equal(claimed.workerFence.fencingToken, 1, "first fence");
        equal(claimed.snapshot.attempts.length, 1, "first attempt");
        await rejectsWith(
          harness.repository.claimJob(claimCommand("job_claim", replayPlan, create.jobId, 2)),
          DurableReplayStateError,
        );
        await rejectsWith(harness.repository.claimJob(command), ReplayJobConflictError);
        await rejectsWith(
          harness.repository.claimJob({ ...command, jobId: "job_job_claim_missing" }),
          ReplayJobNotFoundError,
        );
        await rejectsWith(
          harness.repository.claimJob({
            ...claimCommand("job_claim", replayPlan, create.jobId, 4),
            scope: scope("job_claim", "other"),
          }),
          ReplayJobNotFoundError,
        );
        await rejectsWith(
          harness.repository.acknowledgeCancellation({
            acknowledgementId: "ack_job_claim_without_request",
            action: "stop_requested",
            scope: create.scope,
            workerFence: claimed.workerFence,
          }),
          ReplayJobConflictError,
        );
        await rejectsWith(
          harness.repository.claimJob({
            ...claimCommand("job_claim", replayPlan, create.jobId, 3),
            workerProtocol: { ...workerProtocol, version: "2.0.0" },
          }),
          ReplayDefinitionLineageError,
        );
        await rejectsWith(
          harness.repository.heartbeatJob({
            leaseDurationMilliseconds: 2_001,
            scope: create.scope,
            workerFence: claimed.workerFence,
          }),
          ReplayJobConflictError,
        );
        harness.setNow("2026-08-29T12:00:02.000Z");
        const heartbeat = await harness.repository.heartbeatJob({
          leaseDurationMilliseconds: 2_000,
          scope: create.scope,
          workerFence: claimed.workerFence,
        });
        equal(heartbeat.job.stateVersion, 3, "heartbeat state version");
        await rejectsWith(
          harness.repository.heartbeatJob({
            leaseDurationMilliseconds: 2_000,
            scope: create.scope,
            workerFence: { ...claimed.workerFence, fencingToken: 2 },
          }),
          DurableReplayStateError,
        );
      });

      await withHarness(factory, "job_claim_missing_plan", async (harness) => {
        const replayPlan = await publishPlan(harness, "job_claim_missing_plan");
        const create = createCommand("job_claim_missing_plan", replayPlan);
        await harness.repository.createJob(create);
        harness.hideNextDefinitionLookup("replay_plan");
        await rejectsWith(
          harness.repository.claimJob(claimCommand("job_claim_missing_plan", replayPlan)),
          ReplayDefinitionLineageError,
        );
      });

      await withHarness(factory, "job_claim_missing_target", async (harness) => {
        const replayPlan = await publishPlan(harness, "job_claim_missing_target");
        const create = createCommand("job_claim_missing_target", replayPlan);
        await harness.repository.createJob(create);
        harness.hideNextDefinitionLookup("target_release");
        await rejectsWith(
          harness.repository.claimJob(claimCommand("job_claim_missing_target", replayPlan)),
          ReplayDefinitionLineageError,
        );
      });
    },
  },
  {
    name: "records fenced budgets and observations before a successful terminal commit",
    async run(factory) {
      await withHarness(factory, "job_success", async (harness) => {
        const replayPlan = await publishPlan(harness, "job_success");
        const create = createCommand("job_success", replayPlan);
        await harness.repository.createJob(create);
        const claimed = await harness.repository.claimJob(claimCommand("job_success", replayPlan));
        assert(claimed.claimed, "success claim");
        const reserve = {
          requested: amounts({ inputTokens: 10, jobAttempts: 1 }),
          reservationId: "res_job_success_001",
          scope: create.scope,
          work: { kind: "attempt_start" as const },
          workerFence: claimed.workerFence,
        };
        const reserved = await harness.repository.reserveBudget(reserve);
        equal(reserved.budgetLedger.length, 1, "reservation append");
        equal(
          (await harness.repository.reserveBudget(reserve)).budgetLedger.length,
          1,
          "reservation retry",
        );
        await rejectsWith(
          harness.repository.reserveBudget({
            ...reserve,
            requested: amounts({ inputTokens: 11, jobAttempts: 1 }),
          }),
          ReplayJobConflictError,
        );

        const targetObservation = {
          observationId: "obs_job_success_target",
          payload: {
            afterCancellationRequest: false,
            evidenceSha256: sha("1"),
            event: "started" as const,
            kind: "target" as const,
          },
          scope: create.scope,
          workerFence: claimed.workerFence,
        };
        await harness.repository.appendExecutionObservation(targetObservation);
        await harness.repository.appendExecutionObservation(targetObservation);
        await rejectsWith(
          harness.repository.appendExecutionObservation({
            ...targetObservation,
            payload: { ...targetObservation.payload, evidenceSha256: sha("f") },
          }),
          ReplayJobConflictError,
        );
        const boundaryObservation = {
          observationId: "obs_job_success_boundary",
          payload: {
            afterCancellationRequest: false,
            boundaryId: replayPlan.boundaries[0]?.boundaryId ?? "missing",
            boundaryKind: "model" as const,
            effectCertainty: "none" as const,
            evidenceSha256: sha("2"),
            executionOrigin: "recorded" as const,
            kind: "boundary" as const,
            mode: "recorded_stub" as const,
            phase: "response_observed" as const,
          },
          scope: create.scope,
          workerFence: claimed.workerFence,
        };
        await harness.repository.appendExecutionObservation(boundaryObservation);
        await rejectsWith(
          harness.repository.appendExecutionObservation({
            ...boundaryObservation,
            observationId: "obs_job_success_boundary_bad",
            payload: { ...boundaryObservation.payload, boundaryId: "bnd_missing" },
          }),
          ReplayJobConflictError,
        );
        const usageObservation = {
          boundaryId: boundaryObservation.payload.boundaryId,
          measurements: [
            {
              dimension: "inputTokens" as const,
              usage: {
                amount: 4,
                source: "provider_reported" as const,
                status: "observed" as const,
              },
            },
          ],
          observationId: "obs_job_success_usage",
          scope: create.scope,
          sourceEventSha256: sha("3"),
          workerFence: claimed.workerFence,
        };
        await harness.repository.appendUsageObservation(usageObservation);
        await harness.repository.appendUsageObservation(usageObservation);
        await harness.repository.appendUsageObservation({
          measurements: [
            {
              dimension: "elapsedMilliseconds",
              usage: { amount: 1, source: "measured", status: "observed" },
            },
          ],
          observationId: "obs_job_success_usage_job",
          scope: create.scope,
          sourceEventSha256: sha("6"),
          workerFence: claimed.workerFence,
        });
        await rejectsWith(
          harness.repository.appendUsageObservation({
            ...usageObservation,
            sourceEventSha256: sha("f"),
          }),
          ReplayJobConflictError,
        );
        await rejectsWith(
          harness.repository.appendUsageObservation({
            ...usageObservation,
            observationId: "obs_job_success_usage_bad",
            boundaryId: "bnd_missing",
          }),
          ReplayJobConflictError,
        );

        const reconcile = {
          reconciliationId: "rec_job_success_001",
          reservationId: reserve.reservationId,
          scope: create.scope,
          usage: usage({
            inputTokens: { amount: 4, source: "provider_reported", status: "observed" },
            jobAttempts: { amount: 1, source: "measured", status: "observed" },
          }),
          workerFence: claimed.workerFence,
        };
        await harness.repository.reconcileBudget(reconcile);
        equal(
          (await harness.repository.reconcileBudget(reconcile)).budgetLedger.length,
          2,
          "reconciliation retry",
        );
        await rejectsWith(
          harness.repository.reconcileBudget({
            ...reconcile,
            usage: usage({
              inputTokens: { amount: 5, source: "provider_reported", status: "observed" },
              jobAttempts: { amount: 1, source: "measured", status: "observed" },
            }),
          }),
          ReplayJobConflictError,
        );
        await rejectsWith(
          harness.repository.reconcileBudget({
            ...reconcile,
            reconciliationId: "rec_job_success_missing",
            reservationId: "res_job_success_missing",
          }),
          ReplayJobConflictError,
        );
        const secondReservation = {
          ...reserve,
          reservationId: "res_job_success_002",
          requested: amounts({ toolCalls: 1 }),
        };
        await harness.repository.reserveBudget(secondReservation);
        await harness.repository.reconcileBudget({
          ...reconcile,
          reconciliationId: "rec_job_success_002",
          reservationId: secondReservation.reservationId,
          usage: usage({
            toolCalls: { amount: 1, source: "measured", status: "observed" },
          }),
        });
        await rejectsWith(
          harness.repository.reconcileBudget({
            ...reconcile,
            reconciliationId: "rec_job_success_003",
            reservationId: secondReservation.reservationId,
            usage: usage({
              toolCalls: { amount: 1, source: "measured", status: "observed" },
            }),
          }),
          ReplayJobConflictError,
        );
        harness.setNow("2026-08-29T12:00:02.500Z");
        const terminal = await harness.repository.completeJob({
          code: "completed",
          result: resultArtifact("job_success"),
          scope: create.scope,
          status: "succeeded",
          workerFence: claimed.workerFence,
        });
        equal(terminal.job.status, "succeeded", "terminal success");
        equal(terminal.attempts[0]?.status, "succeeded", "terminal attempt");
        equal(terminal.executionObservations.length, 2, "execution observations");
        equal(terminal.usageObservations[0]?.observationSequence, 2, "shared observation sequence");
        const lateCancellation = await harness.repository.requestCancellation({
          input: {
            cancellationId: "can_job_success_late",
            reason: "This request lost the terminal commit race.",
            reasonCode: "operator_request",
          },
          jobId: create.jobId,
          requestedByPrincipalId: create.createdByPrincipalId,
          scope: create.scope,
        });
        equal(lateCancellation.created, false, "late cancellation race");
        equal(lateCancellation.snapshot.cancellationRequest, null, "late cancellation absence");
      });
    },
  },
  {
    name: "blocks open accounting and preserves overruns as budget exhaustion",
    async run(factory) {
      await withHarness(factory, "job_overrun", async (harness) => {
        const replayPlan = await publishPlan(harness, "job_overrun");
        const create = createCommand("job_overrun", replayPlan);
        await harness.repository.createJob(create);
        const claimed = await harness.repository.claimJob(claimCommand("job_overrun", replayPlan));
        assert(claimed.claimed, "overrun claim");
        const reserve = {
          requested: amounts({ inputTokens: 2 }),
          reservationId: "res_job_overrun_001",
          scope: create.scope,
          work: { kind: "attempt_start" as const },
          workerFence: claimed.workerFence,
        };
        await harness.repository.reserveBudget(reserve);
        await rejectsWith(
          harness.repository.completeJob({
            code: "completed",
            result: resultArtifact("job_overrun"),
            scope: create.scope,
            status: "succeeded",
            workerFence: claimed.workerFence,
          }),
          DurableReplayAccountingError,
        );
        await harness.repository.reconcileBudget({
          reconciliationId: "rec_job_overrun_001",
          reservationId: reserve.reservationId,
          scope: create.scope,
          usage: usage({
            inputTokens: { amount: 3, source: "provider_reported", status: "observed" },
          }),
          workerFence: claimed.workerFence,
        });
        await rejectsWith(
          harness.repository.completeJob({
            code: "completed",
            result: resultArtifact("job_overrun"),
            scope: create.scope,
            status: "succeeded",
            workerFence: claimed.workerFence,
          }),
          DurableReplayAccountingError,
        );
        const exhausted = await harness.repository.completeJob({
          code: "budget_limit_reached",
          error: {
            code: "budget_exhausted",
            effectCertainty: "none",
            message: "Observed usage exceeded its complete reservation.",
          },
          scope: create.scope,
          status: "budget_exhausted",
          workerFence: claimed.workerFence,
        });
        equal(exhausted.job.status, "budget_exhausted", "overrun terminal");
      });
    },
  },
  {
    name: "orders queued and running cancellation atomically before terminal state",
    async run(factory) {
      await withHarness(factory, "job_cancel_queued", async (harness) => {
        const replayPlan = await publishPlan(harness, "job_cancel_queued");
        const create = createCommand("job_cancel_queued", replayPlan);
        await harness.repository.createJob(create);
        const cancel = {
          input: {
            cancellationId: "can_job_cancel_queued_001",
            reason: "Operator stopped the queued replay.",
            reasonCode: "operator_request" as const,
          },
          jobId: create.jobId,
          requestedByPrincipalId: create.createdByPrincipalId,
          scope: create.scope,
        };
        const result = await harness.repository.requestCancellation(cancel);
        equal(result.created, true, "queued cancellation");
        equal(result.snapshot.job.status, "cancelled", "queued terminal cancellation");
        equal(
          (await harness.repository.requestCancellation(cancel)).created,
          false,
          "cancel retry",
        );
        await rejectsWith(
          harness.repository.requestCancellation({
            ...cancel,
            input: { ...cancel.input, reason: "Different immutable reason." },
          }),
          DurableReplayStateError,
        );
        equal(
          (await harness.publishedIntents(create.scope.tenantId)).length,
          3,
          "queued cancel intents",
        );
        await harness.removeIntent("cancellation_requested", create.scope.tenantId, create.jobId);
        await rejectsWith(
          harness.repository.requestCancellation(cancel),
          ReplayRepositoryContractError,
        );
      });

      await withHarness(factory, "job_cancel_running", async (harness) => {
        const replayPlan = await publishPlan(harness, "job_cancel_running");
        const create = createCommand("job_cancel_running", replayPlan);
        await harness.repository.createJob(create);
        const claimed = await harness.repository.claimJob(
          claimCommand("job_cancel_running", replayPlan),
        );
        assert(claimed.claimed, "running cancellation claim");
        const cancel = {
          input: {
            cancellationId: "can_job_cancel_running_001",
            reason: "Operator stopped the running replay.",
            reasonCode: "operator_request" as const,
          },
          jobId: create.jobId,
          requestedByPrincipalId: create.createdByPrincipalId,
          scope: create.scope,
        };
        await harness.repository.requestCancellation(cancel);
        equal(
          (await harness.repository.requestCancellation(cancel)).created,
          false,
          "running cancellation retry",
        );
        await rejectsWith(
          harness.repository.completeJob({
            code: "cancellation_committed",
            error: {
              code: "cancelled",
              effectCertainty: "none",
              message: "Cancellation stopped the bounded worker.",
            },
            scope: create.scope,
            status: "cancelled",
            workerFence: claimed.workerFence,
          }),
          ReplayJobConflictError,
        );
        const acknowledgement = {
          acknowledgementId: "ack_job_cancel_running_001",
          action: "stopped_before_target_start" as const,
          scope: create.scope,
          workerFence: claimed.workerFence,
        };
        await harness.repository.acknowledgeCancellation(acknowledgement);
        await harness.repository.acknowledgeCancellation(acknowledgement);
        await rejectsWith(
          harness.repository.acknowledgeCancellation({
            ...acknowledgement,
            action: "stop_requested",
          }),
          ReplayJobConflictError,
        );
        await harness.repository.appendExecutionObservation({
          observationId: "obs_job_cancel_running_001",
          payload: {
            cancellationId: cancel.input.cancellationId,
            event: "stopped_before_target_start",
            evidenceSha256: sha("4"),
            kind: "cancellation",
          },
          scope: create.scope,
          workerFence: claimed.workerFence,
        });
        await rejectsWith(
          harness.repository.appendExecutionObservation({
            observationId: "obs_job_cancel_running_wrong",
            payload: {
              cancellationId: "can_wrong",
              event: "stop_requested",
              evidenceSha256: sha("5"),
              kind: "cancellation",
            },
            scope: create.scope,
            workerFence: claimed.workerFence,
          }),
          ReplayJobConflictError,
        );
        const terminal = await harness.repository.completeJob({
          code: "cancellation_committed",
          error: {
            code: "cancelled",
            effectCertainty: "none",
            message: "Cancellation stopped the bounded worker.",
          },
          scope: create.scope,
          status: "cancelled",
          workerFence: claimed.workerFence,
        });
        equal(terminal.job.status, "cancelled", "running terminal cancellation");
        equal(
          (await harness.repository.requestCancellation(cancel)).created,
          false,
          "terminal cancellation retry",
        );
      });
    },
  },
  {
    name: "rolls back cancellation and terminal state when their intents fail",
    async run(factory) {
      await withHarness(factory, "job_intent_failure", async (harness) => {
        const replayPlan = await publishPlan(harness, "job_intent_failure");
        const create = createCommand("job_intent_failure", replayPlan);
        await harness.repository.createJob(create);
        const cancel = {
          input: {
            cancellationId: "can_job_intent_failure_001",
            reason: "Exercise atomic cancellation publication.",
            reasonCode: "operator_request" as const,
          },
          jobId: create.jobId,
          requestedByPrincipalId: create.createdByPrincipalId,
          scope: create.scope,
        };
        await harness.failNextIntent("cancellation_requested");
        await rejectsWith(harness.repository.requestCancellation(cancel), Error);
        equal(
          (await harness.repository.findJob(create.scope, create.jobId))?.job.status,
          "queued",
          "cancel rollback",
        );
        await harness.failNextIntent("job_terminal");
        await rejectsWith(harness.repository.requestCancellation(cancel), Error);
        equal(
          (await harness.repository.findJob(create.scope, create.jobId))?.job.status,
          "queued",
          "terminal rollback",
        );
        await harness.repository.requestCancellation(cancel);
      });
    },
  },
  {
    name: "serializes conflicting claims and reservations under concurrent calls",
    async run(factory) {
      await withHarness(factory, "job_concurrent_claim", async (harness) => {
        const replayPlan = await publishPlan(harness, "job_concurrent_claim");
        const create = createCommand("job_concurrent_claim", replayPlan);
        await harness.repository.createJob(create);
        const claims = await Promise.allSettled([
          harness.repository.claimJob(claimCommand("job_concurrent_claim", replayPlan)),
          harness.repository.claimJob(
            claimCommand("job_concurrent_claim", replayPlan, create.jobId, 2),
          ),
        ]);
        equal(
          claims.filter(({ status }) => status === "fulfilled").length,
          1,
          "single claim winner",
        );
        equal(claims.filter(({ status }) => status === "rejected").length, 1, "single claim loser");
      });

      await withHarness(factory, "job_concurrent_budget", async (harness) => {
        const replayPlan = await publishPlan(harness, "job_concurrent_budget");
        const create = createCommand("job_concurrent_budget", replayPlan);
        await harness.repository.createJob(create);
        const claimed = await harness.repository.claimJob(
          claimCommand("job_concurrent_budget", replayPlan),
        );
        assert(claimed.claimed, "concurrent budget claim");
        const reservation = {
          requested: amounts({ inputTokens: 1 }),
          reservationId: "res_job_concurrent_budget_001",
          scope: create.scope,
          work: { kind: "attempt_start" as const },
          workerFence: claimed.workerFence,
        };
        const reservations = await Promise.allSettled([
          harness.repository.reserveBudget(reservation),
          harness.repository.reserveBudget({
            ...reservation,
            requested: amounts({ inputTokens: 2 }),
          }),
        ]);
        equal(
          reservations.filter(({ status }) => status === "fulfilled").length,
          1,
          "single reservation winner",
        );
        equal(
          reservations.filter(({ status }) => status === "rejected").length,
          1,
          "single reservation conflict",
        );
      });
    },
  },
  {
    name: "enforces backoff, preserves expired attempts, and fences reclaimed workers",
    async run(factory) {
      await withHarness(factory, "job_retry", async (harness) => {
        const replayPlan = await publishPlan(harness, "job_retry", {
          automatic: true,
          backoffMilliseconds: 1_000,
          maxAttempts: 2,
        });
        const create = createCommand("job_retry", replayPlan);
        await harness.repository.createJob(create);
        const first = await harness.repository.claimJob(claimCommand("job_retry", replayPlan));
        assert(first.claimed, "retry first claim");
        harness.setNow("2026-08-29T12:00:03.500Z");
        const waiting = await harness.repository.claimJob(
          claimCommand("job_retry", replayPlan, create.jobId, 2),
        );
        assert(!waiting.claimed, "retry backoff wait");
        equal(waiting.reason, "retry_not_ready", "retry backoff reason");
        harness.setNow("2026-08-29T12:00:04.000Z");
        const second = await harness.repository.claimJob(
          claimCommand("job_retry", replayPlan, create.jobId, 2),
        );
        assert(second.claimed, "retry second claim");
        equal(second.workerFence.fencingToken, 2, "reclaim fence");
        equal(second.snapshot.attempts[0]?.status, "lease_expired", "expired history");
        await rejectsWith(
          harness.repository.reserveBudget({
            requested: amounts({ jobAttempts: 1 }),
            reservationId: "res_job_retry_stale",
            scope: create.scope,
            work: { kind: "attempt_start" },
            workerFence: first.workerFence,
          }),
          DurableReplayStateError,
        );
        harness.setNow("2026-08-29T12:00:06.000Z");
        const terminal = await harness.repository.claimJob(
          claimCommand("job_retry", replayPlan, create.jobId, 3),
        );
        assert(!terminal.claimed, "retry exhaustion terminal");
        equal(terminal.reason, "terminalized", "retry exhaustion reason");
        equal(terminal.snapshot.job.status, "failed", "retry exhaustion status");
      });
    },
  },
  {
    name: "terminalizes unsafe work and reclaims only evidence-safe expired effects",
    async run(factory) {
      await withHarness(factory, "job_expired_cancel", async (harness) => {
        const replayPlan = await publishPlan(harness, "job_expired_cancel", {
          automatic: true,
          maxAttempts: 2,
        });
        const create = createCommand("job_expired_cancel", replayPlan);
        await harness.repository.createJob(create);
        await harness.repository.claimJob(claimCommand("job_expired_cancel", replayPlan));
        await harness.repository.requestCancellation({
          input: {
            cancellationId: "can_job_expired_cancel_001",
            reason: "Do not retry work after its worker lease expires.",
            reasonCode: "operator_request",
          },
          jobId: create.jobId,
          requestedByPrincipalId: create.createdByPrincipalId,
          scope: create.scope,
        });
        harness.setNow("2026-08-29T12:00:03.000Z");
        const terminal = await harness.repository.claimJob(
          claimCommand("job_expired_cancel", replayPlan, create.jobId, 2),
        );
        assert(!terminal.claimed, "expired cancellation terminal");
        equal(terminal.reason, "terminalized", "expired cancellation reason");
        equal(terminal.snapshot.job.status, "cancelled", "expired cancellation status");
        equal(terminal.snapshot.attempts[0]?.status, "lease_expired", "expired attempt status");
      });

      await withHarness(factory, "job_expired_accounting", async (harness) => {
        const replayPlan = await publishPlan(harness, "job_expired_accounting", {
          automatic: true,
          maxAttempts: 2,
        });
        const create = createCommand("job_expired_accounting", replayPlan);
        await harness.repository.createJob(create);
        const claimed = await harness.repository.claimJob(
          claimCommand("job_expired_accounting", replayPlan),
        );
        assert(claimed.claimed, "expired accounting first claim");
        const settledReservation = {
          requested: amounts({ jobAttempts: 1 }),
          reservationId: "res_job_expired_accounting_001",
          scope: create.scope,
          work: { kind: "attempt_start" },
          workerFence: claimed.workerFence,
        } as const;
        await harness.repository.reserveBudget(settledReservation);
        await harness.repository.reconcileBudget({
          reconciliationId: "rec_job_expired_accounting_001",
          reservationId: settledReservation.reservationId,
          scope: create.scope,
          usage: usage({
            jobAttempts: { amount: 1, source: "measured", status: "observed" },
          }),
          workerFence: claimed.workerFence,
        });
        await harness.repository.reserveBudget({
          requested: amounts({ jobAttempts: 1 }),
          reservationId: "res_job_expired_accounting_002",
          scope: create.scope,
          work: { kind: "attempt_start" },
          workerFence: claimed.workerFence,
        });
        harness.setNow("2026-08-29T12:00:03.000Z");
        const terminal = await harness.repository.claimJob(
          claimCommand("job_expired_accounting", replayPlan, create.jobId, 2),
        );
        assert(!terminal.claimed, "expired accounting terminal");
        equal(terminal.reason, "terminalized", "expired accounting reason");
        equal(terminal.snapshot.job.status, "failed", "expired accounting status");
        equal(terminal.snapshot.budgetLedger.length, 3, "open reservation preservation");
      });

      await withHarness(factory, "job_deadline", async (harness) => {
        const replayPlan = await publishPlan(harness, "job_deadline", {
          automatic: true,
          backoffMilliseconds: 4_000,
          maxAttempts: 2,
          totalDeadlineMilliseconds: 5_000,
        });
        const create = createCommand("job_deadline", replayPlan);
        await harness.repository.createJob(create);
        await harness.repository.claimJob(claimCommand("job_deadline", replayPlan));
        harness.setNow("2026-08-29T12:00:03.000Z");
        const terminal = await harness.repository.claimJob(
          claimCommand("job_deadline", replayPlan, create.jobId, 2),
        );
        assert(!terminal.claimed, "deadline terminal");
        equal(terminal.snapshot.job.status, "timed_out", "deadline status");
      });

      await withHarness(factory, "job_effect", async (harness) => {
        const target = release("job_effect");
        await harness.definitions.publishTargetRelease(target);
        const replayPlan = plan("job_effect", target, {
          automatic: true,
          boundary: liveBoundary("job_effect", "idempotent_write"),
          maxAttempts: 2,
        });
        await harness.definitions.publishReplayPlan(replayPlan);
        const create = createCommand("job_effect", replayPlan);
        await harness.repository.createJob(create);
        await harness.repository.claimJob(claimCommand("job_effect", replayPlan));
        harness.setNow("2026-08-29T12:00:03.000Z");
        const terminal = await harness.repository.claimJob(
          claimCommand("job_effect", replayPlan, create.jobId, 2),
        );
        assert(!terminal.claimed, "effect terminal");
        equal(terminal.snapshot.job.terminal?.code, "execution_failed", "effect terminal code");
        equal(
          terminal.snapshot.attempts[0]?.error?.effectRetrySafety?.kind,
          "not_retryable",
          "effect evidence",
        );
      });

      await withHarness(factory, "job_read_only_effect", async (harness) => {
        const target = release("job_read_only_effect");
        await harness.definitions.publishTargetRelease(target);
        const replayPlan = plan("job_read_only_effect", target, {
          automatic: true,
          boundary: liveBoundary("job_read_only_effect", "read_only"),
          maxAttempts: 2,
        });
        await harness.definitions.publishReplayPlan(replayPlan);
        const create = createCommand("job_read_only_effect", replayPlan);
        await harness.repository.createJob(create);
        await harness.repository.claimJob(claimCommand("job_read_only_effect", replayPlan));
        harness.setNow("2026-08-29T12:00:03.000Z");
        const waiting = await harness.repository.claimJob(
          claimCommand("job_read_only_effect", replayPlan, create.jobId, 2),
        );
        assert(!waiting.claimed, "read-only backoff wait");
        harness.setNow("2026-08-29T12:00:04.000Z");
        const reclaimed = await harness.repository.claimJob(
          claimCommand("job_read_only_effect", replayPlan, create.jobId, 2),
        );
        assert(reclaimed.claimed, "read-only effect reclaim");
        equal(
          reclaimed.snapshot.attempts[0]?.error?.effectRetrySafety?.kind,
          "read_only",
          "read-only retry evidence",
        );
      });
    },
  },
];
