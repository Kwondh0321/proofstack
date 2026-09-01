import { mkdir } from "node:fs/promises";
import {
  createPostgresPool,
  PostgresReplayDefinitionRepository,
  PostgresReplayJobWorkerRepository,
  validatePostgresConnectionString,
} from "@proofstack/postgres";
import {
  DurableReplayStateError,
  prepareRecordedBoundaryReplay,
  RecordedBoundaryResolver,
} from "@proofstack/replay";
import { runClaimedReplayAttemptV2 } from "@proofstack/replay-worker";
import { recordedReplayTargetAdapter, resolveDurableReplayTarget } from "./definitions.js";
import { requestDurableReplayReportPublication } from "./report-publication.js";
import {
  createLocalReplayReportPublisher,
  type DurableReplayWorkerCommand,
  loadDurableReplayWorkerCommand,
} from "./worker-input.js";

function inputArgument(): string {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--input" || !args[1]) {
    throw new TypeError("Usage: worker --input /absolute/private-command.json");
  }
  return args[1];
}

function emit(event: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function exactInvocation(
  command: Extract<DurableReplayWorkerCommand, { command: "run" }>,
  plan: Awaited<ReturnType<PostgresReplayDefinitionRepository["findReplayPlan"]>>,
) {
  if (!plan) throw new TypeError("The exact replay plan is unavailable to the worker");
  const recorded = plan.boundaries.filter((boundary) => boundary.mode === "recorded_stub");
  if (
    recorded.length !== plan.boundaries.length ||
    recorded.length < 1 ||
    recorded.some(
      (boundary) => JSON.stringify(boundary.invocation) !== JSON.stringify(recorded[0]?.invocation),
    )
  ) {
    throw new TypeError("The reference worker accepts one exact recorded invocation only");
  }
  const invocation = recorded[0]?.invocation;
  if (!invocation) throw new TypeError("The exact recorded invocation is unavailable");
  return prepareRecordedBoundaryReplay({
    contentExport: command.contentExport,
    invocation,
    targetAdapter: recordedReplayTargetAdapter(plan.targetRelease),
  });
}

async function claim(
  command: Extract<DurableReplayWorkerCommand, { command: "claim" | "run" }>,
  repository: PostgresReplayJobWorkerRepository,
) {
  return await repository.claimJob({
    attemptId: command.claim.attemptId,
    jobId: command.jobId,
    leaseDurationMilliseconds: command.leaseDurationMilliseconds,
    leaseId: command.claim.leaseId,
    scope: command.scope,
    workerBuildSha256: command.claim.workerBuildSha256,
    workerId: command.claim.workerId,
    workerProtocol: command.claim.workerProtocol,
  });
}

async function execute(command: DurableReplayWorkerCommand): Promise<void> {
  validatePostgresConnectionString(command.databaseUrl, { allowPlaintextLoopback: true });
  const pool = createPostgresPool({
    applicationName: `proofstack-durable-example-${command.command}`,
    connectionString: command.databaseUrl,
    maxConnections: 2,
    onIdleError: () => {
      process.exitCode = 1;
    },
  });
  try {
    const repository = new PostgresReplayJobWorkerRepository(pool);
    if (command.command === "probe_stale_fence") {
      try {
        await repository.heartbeatJob({
          leaseDurationMilliseconds: command.leaseDurationMilliseconds,
          scope: command.scope,
          workerFence: command.workerFence,
        });
      } catch (error) {
        if (error instanceof DurableReplayStateError && error.code === "stale_fence") {
          emit({ event: "stale_fence_rejected", jobId: command.workerFence.jobId });
          return;
        }
        throw error;
      }
      throw new TypeError("The stale worker fence was unexpectedly accepted");
    }

    const claimed = await claim(command, repository);
    if (!claimed.claimed) {
      emit({ event: "claim_rejected", jobId: command.jobId, reason: claimed.reason });
      return;
    }
    emit({
      event: "claimed",
      jobId: command.jobId,
      workerFence: claimed.workerFence,
    });
    if (command.command === "claim") return;

    await mkdir(command.workspaceParent, { mode: 0o700, recursive: true });
    const definitions = new PostgresReplayDefinitionRepository(pool);
    const plan = await definitions.findReplayPlan(
      command.scope,
      claimed.snapshot.job.plan.planVersionId,
    );
    if (!plan) throw new TypeError("The claimed replay plan is unavailable");
    const release = await definitions.findTargetRelease(
      command.scope,
      plan.targetRelease.targetReleaseId,
    );
    if (!release) throw new TypeError("The claimed target release is unavailable");
    const prepared = exactInvocation(command, plan);
    const resolver = new RecordedBoundaryResolver(prepared);
    const resolvedTarget = resolveDurableReplayTarget(release, command.targetEntryPointPath);
    const localReportPublisher = await createLocalReplayReportPublisher(command.reportDirectory);
    const reportPublisher = {
      publish: async (publication: Parameters<typeof localReportPublisher.publish>[0]) => {
        const reference = await localReportPublisher.publish(publication);
        await requestDurableReplayReportPublication({
          contentReference: publication.contentReference,
          emit,
          input: process.stdin,
          scope: publication.scope,
          signal: publication.signal,
        });
        return reference;
      },
    };
    const result = await runClaimedReplayAttemptV2({
      availableEnvironment: {
        PROOFSTACK_EXAMPLE_HOLD_MILLISECONDS: String(command.targetHoldMilliseconds),
      },
      boundaryResolver: {
        resolve: async ({ request }) => await resolver.resolve(request),
      },
      definitions,
      heartbeatIntervalMilliseconds: command.heartbeatIntervalMilliseconds,
      leaseDurationMilliseconds: command.leaseDurationMilliseconds,
      registry: {
        resolve: async (implementationId) =>
          implementationId === resolvedTarget.implementationId ? resolvedTarget : null,
      },
      reportPublisher,
      repository,
      scope: command.scope,
      snapshot: claimed.snapshot,
      terminationGraceMilliseconds: command.terminationGraceMilliseconds,
      workerFence: claimed.workerFence,
      workspaceParent: command.workspaceParent,
    });
    emit({
      attemptCount: result.snapshot.attempts.length,
      budgetEntryCount: result.snapshot.budgetLedger.length,
      event: "terminal",
      executionObservationCount: result.snapshot.executionObservations.length,
      jobId: command.jobId,
      status: result.snapshot.job.status,
      usageObservationCount: result.snapshot.usageObservations.length,
    });
  } finally {
    await pool.end();
  }
}

try {
  const command = await loadDurableReplayWorkerCommand(inputArgument());
  await execute(command);
} catch {
  process.stderr.write("ProofStack durable replay worker failed closed.\n");
  process.exitCode = 1;
}
