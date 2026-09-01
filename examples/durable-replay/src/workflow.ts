import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  type EvidenceScope,
  EvidenceScopeSchema,
  type ReplayArtifactContentReference,
  type ReplayJobSnapshot,
  ReplayWorkerMutationFenceSchema,
} from "@proofstack/contracts";
import { createProviderNeutralCapture } from "@proofstack/example-interaction-capture/capture";
import {
  createSpanId,
  createTraceId,
  ProofStackClient,
  ProofStackRegressionClient,
  ProofStackReplayClient,
} from "@proofstack/sdk";
import { z } from "zod";
import { createDurableReplayDefinitions } from "./definitions.js";
import {
  DurableReplayReportPublicationAcknowledgementSchema,
  type DurableReplayReportPublicationRequest,
  DurableReplayReportPublicationRequestSchema,
} from "./report-publication.js";
import {
  createProviderNeutralDurableTargetSource,
  DURABLE_REPLAY_WORKER_PROTOCOL,
} from "./target-source.js";
import {
  type DurableReplayWorkerCommand,
  DurableReplayWorkerCommandSchema,
  MAX_DURABLE_REPLAY_WORKER_INPUT_BYTES,
  readLocalReplayReport,
} from "./worker-input.js";

const MAX_WORKER_STDOUT_BYTES = 1024 * 1024;
const MAX_WORKER_STDERR_BYTES = 64 * 1024;
const MAX_REPLAY_REPORT_BYTES = 1024 * 1024;
const WORKER_EVENT_TIMEOUT_MILLISECONDS = 20_000;
const SOURCE_REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const ClaimedWorkerEventSchema = z
  .object({
    event: z.literal("claimed"),
    jobId: z.string(),
    workerFence: ReplayWorkerMutationFenceSchema,
  })
  .strict();
const WorkerEventSchema = z.discriminatedUnion("event", [
  ClaimedWorkerEventSchema,
  DurableReplayReportPublicationRequestSchema,
  z
    .object({
      event: z.literal("claim_rejected"),
      jobId: z.string(),
      reason: z.enum(["retry_not_ready", "terminalized"]),
    })
    .strict(),
  z
    .object({
      attemptCount: z.number().int().nonnegative(),
      budgetEntryCount: z.number().int().nonnegative(),
      event: z.literal("terminal"),
      executionObservationCount: z.number().int().nonnegative(),
      jobId: z.string(),
      status: z.enum(["budget_exhausted", "cancelled", "failed", "succeeded", "timed_out"]),
      usageObservationCount: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ event: z.literal("stale_fence_rejected"), jobId: z.string() }).strict(),
]);

type WorkerEvent = z.infer<typeof WorkerEventSchema>;

export interface RunDurableReplayExampleOptions {
  readonly apiUrl: string;
  readonly environmentId: string;
  readonly outputRoot: string;
  readonly projectId: string;
  readonly sourceRevision: string;
  readonly tenantId: string;
  readonly workerDatabaseUrl: string;
  readonly workerEntryPointPath: string;
}

export interface DurableReplayJobSummary {
  readonly attemptStatuses: readonly string[];
  readonly budgetEntryCount: number;
  readonly cancellationAcknowledgementCount: number;
  readonly executionObservationCount: number;
  readonly jobId: string;
  readonly status: ReplayJobSnapshot["job"]["status"];
  readonly usageObservationCount: number;
}

export interface DurableReplayExampleSummary {
  readonly dataset: {
    readonly datasetId: string;
    readonly datasetVersionId: string;
    readonly definitionSha256: string;
  };
  readonly fixture: {
    readonly fixtureId: string;
    readonly fixtureVersionId: string;
    readonly definitionSha256: string;
  };
  readonly jobs: {
    readonly cancellation: DurableReplayJobSummary;
    readonly staleFenceRecovery: DurableReplayJobSummary & {
      readonly recoveredFencingToken: number;
      readonly rejectedFencingToken: number;
    };
    readonly success: DurableReplayJobSummary;
  };
  readonly replayPlan: {
    readonly definitionSha256: string;
    readonly planId: string;
    readonly planVersionId: string;
  };
  readonly scope: EvidenceScope;
  readonly targetRelease: {
    readonly definitionSha256: string;
    readonly targetId: string;
    readonly targetReleaseId: string;
  };
  readonly traceId: string;
}

interface WorkerEventWaiter {
  readonly event: WorkerEvent["event"];
  readonly reject: (error: Error) => void;
  readonly resolve: (event: WorkerEvent) => void;
  readonly timer: NodeJS.Timeout;
}

interface RunningWorker {
  readonly completion: Promise<readonly WorkerEvent[]>;
  stop(): void;
  waitForEvent<EventName extends WorkerEvent["event"]>(
    event: EventName,
  ): Promise<Extract<WorkerEvent, { readonly event: EventName }>>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function addMilliseconds(instant: Date, milliseconds: number): string {
  return new Date(instant.getTime() + milliseconds).toISOString();
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameContentReference(
  left: ReplayArtifactContentReference,
  right: ReplayArtifactContentReference,
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.classification === right.classification &&
    left.mediaType === right.mediaType &&
    left.redactedAt === right.redactedAt &&
    left.sha256 === right.sha256 &&
    left.sizeBytes === right.sizeBytes
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function privateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

async function preparePrivateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new TypeError("Durable replay output paths must be absolute");
  }
  await mkdir(path, { mode: 0o700, recursive: true });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !privateMode(metadata.mode)) {
    throw new TypeError("Durable replay output directories must be private real directories");
  }
}

function exactScope(options: RunDurableReplayExampleOptions): EvidenceScope {
  if (options.tenantId !== "ten_local") {
    throw new TypeError("The development-authenticated example requires tenant ten_local");
  }
  if (!SOURCE_REVISION_PATTERN.test(options.sourceRevision)) {
    throw new TypeError("sourceRevision must be an exact Git object identifier");
  }
  if (
    !isAbsolute(options.workerEntryPointPath) ||
    options.workerEntryPointPath.includes("\0") ||
    !isAbsolute(options.outputRoot) ||
    options.outputRoot.includes("\0")
  ) {
    throw new TypeError("Worker and output paths must be absolute");
  }
  return EvidenceScopeSchema.parse({
    environmentId: options.environmentId,
    projectId: options.projectId,
    tenantId: options.tenantId,
  });
}

async function writeWorkerCommand(
  commandDirectory: string,
  command: DurableReplayWorkerCommand,
): Promise<string> {
  const validated = DurableReplayWorkerCommandSchema.parse(command);
  const content = `${JSON.stringify(validated)}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_DURABLE_REPLAY_WORKER_INPUT_BYTES) {
    throw new TypeError("The durable replay worker command exceeds its private-input limit");
  }
  const path = join(commandDirectory, `command-${randomUUID()}.json`);
  await writeFile(path, content, { flag: "wx", mode: 0o600 });
  return path;
}

async function startWorker(options: {
  readonly command: DurableReplayWorkerCommand;
  readonly commandDirectory: string;
  readonly publishReport: (request: DurableReplayReportPublicationRequest) => Promise<void>;
  readonly workerEntryPointPath: string;
}): Promise<RunningWorker> {
  const inputPath = await writeWorkerCommand(options.commandDirectory, options.command);
  const child = spawn(process.execPath, [options.workerEntryPointPath, "--input", inputPath], {
    detached: true,
    env: {
      LANG: "C",
      LC_ALL: "C",
      NODE_ENV: "production",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events: WorkerEvent[] = [];
  const waiters = new Set<WorkerEventWaiter>();
  let completed = false;
  let completionError: Error | undefined;
  let stdout = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let publicationRequested = false;
  const stop = (): void => {
    if (completed) return;
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  };

  const rejectWaiters = (error: Error): void => {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    waiters.clear();
  };
  const publish = (event: WorkerEvent): void => {
    events.push(event);
    if (event.event === "report_publication_requested") {
      if (publicationRequested || options.command.command !== "run") {
        fail(new Error("The durable replay worker requested an invalid report publication"));
        return;
      }
      publicationRequested = true;
      void options
        .publishReport(event)
        .then(() => {
          if (completed || child.stdin.destroyed) return;
          const acknowledgement = DurableReplayReportPublicationAcknowledgementSchema.parse({
            artifactId: event.contentReference.artifactId,
            command: "report_publication_accepted",
            sha256: event.contentReference.sha256,
          });
          child.stdin.end(`${JSON.stringify(acknowledgement)}\n`);
        })
        .catch(() => fail(new Error("The durable replay report publication was rejected")));
    }
    for (const waiter of waiters) {
      if (waiter.event !== event.event) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(event);
    }
  };
  const fail = (error: Error): void => {
    if (!completionError) completionError = error;
    stop();
  };
  const parseLine = (line: string): void => {
    if (line.length === 0) return;
    try {
      publish(WorkerEventSchema.parse(JSON.parse(line)));
    } catch {
      fail(new Error("The durable replay worker emitted an invalid control event"));
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > MAX_WORKER_STDOUT_BYTES) {
      fail(new Error("The durable replay worker exceeded its control-output limit"));
      return;
    }
    stdout += chunk.toString("utf8");
    while (true) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      parseLine(line);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > MAX_WORKER_STDERR_BYTES) {
      fail(new Error("The durable replay worker exceeded its diagnostic-output limit"));
      return;
    }
  });
  child.stdin.on("error", () => {
    if (!completed) fail(new Error("The durable replay worker control input failed"));
  });

  const completion = new Promise<readonly WorkerEvent[]>((resolve, reject) => {
    const timer = setTimeout(
      () => fail(new Error("The durable replay worker exceeded its bounded lifetime")),
      25_000,
    );
    child.once("error", (error) =>
      fail(new Error("The durable replay worker failed to start", { cause: error })),
    );
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (stdout.length > 0) parseLine(stdout);
      completed = true;
      completionError ??=
        code === 0
          ? undefined
          : new Error(
              `The durable replay worker exited unsuccessfully (code=${String(code)}, signal=${String(signal)}, diagnosticBytes=${stderrBytes})`,
            );
      if (completionError) {
        rejectWaiters(completionError);
        reject(completionError);
      } else {
        rejectWaiters(new Error("The durable replay worker exited before the requested event"));
        resolve(Object.freeze([...events]));
      }
    });
  }).finally(async () => {
    await unlink(inputPath);
  });
  void completion.catch(() => undefined);

  return {
    completion,
    stop,
    waitForEvent: async <EventName extends WorkerEvent["event"]>(event: EventName) => {
      const existing = events.find(
        (candidate): candidate is Extract<WorkerEvent, { readonly event: EventName }> =>
          candidate.event === event,
      );
      if (existing) return existing;
      if (completed) {
        throw completionError ?? new Error(`The worker exited before emitting ${event}`);
      }
      return await new Promise<Extract<WorkerEvent, { readonly event: EventName }>>(
        (resolve, reject) => {
          const waiter: WorkerEventWaiter = {
            event,
            reject,
            resolve: (value) =>
              resolve(value as Extract<WorkerEvent, { readonly event: EventName }>),
            timer: setTimeout(() => {
              waiters.delete(waiter);
              reject(new Error(`Timed out waiting for durable replay worker event ${event}`));
              stop();
            }, WORKER_EVENT_TIMEOUT_MILLISECONDS),
          };
          waiters.add(waiter);
        },
      );
    },
  };
}

function claimIdentity(
  suffix: string,
  scenario: "cancel" | "stale_old" | "stale_new" | "success",
  workerBuildSha256: string,
) {
  return {
    attemptId: `att_${suffix}_${scenario}`,
    leaseId: `lease_${suffix}_${scenario}`,
    workerBuildSha256,
    workerId: `worker_${suffix}_${scenario}`,
    workerProtocol: DURABLE_REPLAY_WORKER_PROTOCOL,
  } as const;
}

function summarize(snapshot: ReplayJobSnapshot): DurableReplayJobSummary {
  return Object.freeze({
    attemptStatuses: Object.freeze(snapshot.attempts.map(({ status }) => status)),
    budgetEntryCount: snapshot.budgetLedger.length,
    cancellationAcknowledgementCount: snapshot.cancellationAcknowledgements.length,
    executionObservationCount: snapshot.executionObservations.length,
    jobId: snapshot.job.jobId,
    status: snapshot.job.status,
    usageObservationCount: snapshot.usageObservations.length,
  });
}

function assertSuccessfulSnapshot(snapshot: ReplayJobSnapshot, expectedAttempts: number): void {
  assert(snapshot.job.status === "succeeded", "Durable replay must finish successfully");
  assert(
    snapshot.attempts.length === expectedAttempts,
    "Durable replay attempt count is incorrect",
  );
  assert(snapshot.budgetLedger.length >= 2, "Durable replay must reserve and reconcile budget");
  assert(
    snapshot.executionObservations.length > 0,
    "Durable replay must record execution evidence",
  );
  assert(snapshot.usageObservations.length > 0, "Durable replay must record measured usage");
  assert(
    snapshot.attempts.at(-1)?.result,
    "Durable replay must publish an immutable result report",
  );
}

function jobRequest(jobId: string, plan: DurableReplayExampleSummary["replayPlan"]) {
  return {
    jobId,
    plan: {
      definitionSha256: plan.definitionSha256,
      planId: plan.planId,
      planVersionId: plan.planVersionId,
    },
  } as const;
}

/**
 * Exercises the complete provider-neutral durable replay control and data plane.
 *
 * The API remains the only public mutation boundary. A separate least-privileged worker process
 * claims PostgreSQL jobs and launches a separately hashed target process. The target can only ask
 * for exact recorded model/tool boundaries and therefore performs no external provider action.
 */
export async function runDurableReplayExample(
  options: RunDurableReplayExampleOptions,
): Promise<DurableReplayExampleSummary> {
  const scope = exactScope(options);
  await preparePrivateDirectory(options.outputRoot);
  const commandDirectory = join(options.outputRoot, "commands");
  const reportDirectory = join(options.outputRoot, "reports");
  const workspaceParent = join(options.outputRoot, "workspaces");
  await Promise.all(
    [commandDirectory, reportDirectory, workspaceParent].map(preparePrivateDirectory),
  );

  const workerBytes = await readFile(options.workerEntryPointPath);
  const workerBuildSha256 = sha256(workerBytes);
  const traceId = createTraceId();
  const suffix = traceId.slice(0, 12);
  const captureStartedAt = new Date(Date.now() - 2_000);
  const capture = createProviderNeutralCapture(suffix, captureStartedAt);
  const fixtureId = `fix_${suffix}_durable`;
  const predecessorVersionId = `fixv_${suffix}_evidence`;
  const fixtureVersionId = `fixv_${suffix}_recorded`;
  const datasetId = `dat_${suffix}_durable`;
  const datasetVersionId = `datv_${suffix}_durable_001`;

  const telemetry = new ProofStackClient({
    endpoint: options.apiUrl,
    environmentId: scope.environmentId,
    failOpen: false,
    flushIntervalMs: 0,
    projectId: scope.projectId,
    source: {
      frameworkName: "provider-neutral-durable-replay",
      frameworkVersion: "1.0.0",
      serviceName: "durable-replay-example",
      serviceVersion: "0.0.0",
    },
  });
  const runSpanId = createSpanId();
  telemetry.emit({
    attributes: {
      "capture.boundary": "application_provider_and_tool",
      "capture.content_in_telemetry": false,
      "example.failure_class": "inventory_backend_unavailable",
    },
    endedAt: addMilliseconds(captureStartedAt, 1_700),
    kind: "agent.run",
    name: "durable-replay.failed-run",
    sequence: 0,
    spanId: runSpanId,
    startedAt: captureStartedAt.toISOString(),
    status: "error",
    traceId,
  });
  telemetry.emit({
    attributes: { "capture.outcome": "succeeded" },
    endedAt: addMilliseconds(captureStartedAt, 900),
    kind: "model.generate",
    name: "reference-model.chat",
    parentSpanId: runSpanId,
    sequence: 1,
    startedAt: addMilliseconds(captureStartedAt, 100),
    status: "ok",
    traceId,
  });
  telemetry.emit({
    attributes: { "capture.outcome": "failed", "capture.side_effect": "read_only" },
    endedAt: addMilliseconds(captureStartedAt, 1_500),
    kind: "tool.execute",
    name: "inventory.lookup",
    parentSpanId: runSpanId,
    sequence: 2,
    startedAt: addMilliseconds(captureStartedAt, 1_000),
    status: "error",
    traceId,
  });
  const delivery = await telemetry.close();
  assert(delivery.success, `Evidence delivery left ${delivery.pendingCount} event(s) pending`);

  const authentication = { mode: "development" as const };
  const regression = new ProofStackRegressionClient({
    authentication,
    endpoint: options.apiUrl,
    environmentId: scope.environmentId,
    projectId: scope.projectId,
  });
  const replay = new ProofStackReplayClient({
    authentication,
    endpoint: options.apiUrl,
    environmentId: scope.environmentId,
    projectId: scope.projectId,
  });

  const predecessor = await regression.publishFixtureVersion({
    fixtureId,
    request: {
      description: "Observed failure evidence before classified interaction capture was attached.",
      fixtureVersionId: predecessorVersionId,
      name: "Durable inventory lookup failure evidence",
      source: { kind: "trace_snapshot", traceId },
    },
  });
  assert(
    predecessor.version.replayability === "evidence_only",
    "Predecessor must be evidence-only",
  );

  for (const binding of capture.manifest.artifacts) {
    const content = capture.contentByArtifactId.get(binding.contentReference.artifactId);
    assert(content, `Missing captured content for ${binding.contentReference.artifactId}`);
    const reserved = await regression.reserveArtifact({
      request: {
        artifactId: binding.contentReference.artifactId,
        classification: binding.contentReference.classification,
        mediaType: binding.contentReference.mediaType,
        redaction: binding.redaction,
        retention: binding.retention,
        sha256: binding.contentReference.sha256,
        sizeBytes: binding.contentReference.sizeBytes,
      },
    });
    assert(reserved.metadata.state === "reserved", "Capture artifact must be newly reserved");
    const uploaded = await regression.uploadArtifactContent({
      artifactId: binding.contentReference.artifactId,
      content,
    });
    assert(uploaded.metadata.state === "available", "Capture artifact must become available");
  }

  const fixturePublication = await regression.publishRecordedInteractionFixtureVersion({
    fixtureId,
    request: {
      description: "Exact provider-neutral model and failed read-only tool interaction capture.",
      fixtureVersionId,
      interactionCapture: capture.manifest,
      name: "Durable inventory lookup interaction capture",
      predecessorVersionId,
    },
  });
  assert(fixturePublication.created, "Recorded fixture publication must create an exact version");
  const datasetPublication = await regression.publishDatasetVersion({
    datasetId,
    request: {
      datasetVersionId,
      description: "One exact incident fixture for provider-neutral durable replay.",
      fixtureVersions: [{ fixtureId, fixtureVersionId }],
      name: "Durable replay reference dataset",
    },
  });
  assert(datasetPublication.created, "Regression dataset publication must create an exact version");

  const contentExport = await regression.exportRecordedInteractionFixtureContent({
    acknowledgeSensitiveContent: true,
    fixtureId,
    fixtureVersionId,
  });
  for (const item of contentExport.export.artifacts) {
    const reference = item.artifact.binding.contentReference;
    const expected = capture.contentByArtifactId.get(reference.artifactId);
    assert(expected, `Content export returned unknown artifact ${reference.artifactId}`);
    assert(item.content.status === "available", "Durable replay requires available exact content");
    const actual = Buffer.from(item.content.bytes, "base64url");
    assert(actual.equals(Buffer.from(expected)), `Content export changed ${reference.artifactId}`);
    assert(
      sha256(actual) === reference.sha256,
      `Content export digest failed for ${reference.artifactId}`,
    );
  }

  const modelNormalizedRequest = capture.contentByArtifactId.get(`art_${suffix}_model_normalized`);
  const toolNormalizedRequest = capture.contentByArtifactId.get(`art_${suffix}_tool_normalized`);
  assert(modelNormalizedRequest, "Durable replay requires the normalized model request");
  assert(toolNormalizedRequest, "Durable replay requires the normalized tool request");
  const targetSource = createProviderNeutralDurableTargetSource({
    modelNormalizedRequest,
    toolNormalizedRequest,
  });
  const definitions = createDurableReplayDefinitions({
    captureStartedAt,
    dataset: {
      datasetId,
      datasetVersionId,
      definitionSha256: datasetPublication.version.definitionSha256,
    },
    fixture: {
      definitionSha256: fixturePublication.version.definitionSha256,
      fixtureId,
      fixtureVersionId,
    },
    scope,
    sourceRevision: options.sourceRevision,
    suffix,
    targetSource,
  });
  const targetEntryPointPath = join(options.outputRoot, "target.mjs");
  await writeFile(targetEntryPointPath, targetSource, { flag: "wx", mode: 0o500 });

  const provenanceReservation = await regression.reserveArtifact({
    request: {
      ...definitions.provenanceReference,
      redaction: { status: "not_required" },
      retention: { mode: "retain" },
    },
  });
  assert(provenanceReservation.metadata.state === "reserved", "Provenance must be newly reserved");
  const provenanceUpload = await regression.uploadArtifactContent({
    artifactId: definitions.provenanceReference.artifactId,
    content: definitions.provenanceContent,
  });
  assert(provenanceUpload.metadata.state === "available", "Provenance must become available");

  const releasePublication = await replay.publishTargetRelease({
    definition: definitions.targetReleaseDefinition,
  });
  assert(releasePublication.created, "Target release publication must create an exact release");
  const planPublication = await replay.publishReplayPlan({
    definition: definitions.replayPlanDefinition,
  });
  assert(planPublication.created, "Replay plan publication must create an exact plan");
  const replayPlan = {
    definitionSha256: planPublication.plan.definitionSha256,
    planId: planPublication.plan.planId,
    planVersionId: planPublication.plan.planVersionId,
  } as const;

  const baseRunCommand = (jobId: string, scenario: "cancel" | "stale_new" | "success") =>
    DurableReplayWorkerCommandSchema.parse({
      claim: claimIdentity(suffix, scenario, workerBuildSha256),
      command: "run",
      contentExport: contentExport.export,
      databaseUrl: options.workerDatabaseUrl,
      heartbeatIntervalMilliseconds: 100,
      jobId,
      leaseDurationMilliseconds: 2_000,
      reportDirectory,
      schemaVersion: "0.1",
      scope,
      targetEntryPointPath,
      targetHoldMilliseconds: scenario === "success" ? 0 : 1_000,
      terminationGraceMilliseconds: 100,
      workspaceParent,
    });

  const publishReport = async (request: DurableReplayReportPublicationRequest): Promise<void> => {
    assert(
      JSON.stringify(request.scope) === JSON.stringify(scope),
      "Replay report publication scope must match the running example",
    );
    assert(
      request.contentReference.classification === "internal" &&
        request.contentReference.mediaType ===
          "application/vnd.proofstack.replay-attempt-report+json" &&
        request.contentReference.sizeBytes <= MAX_REPLAY_REPORT_BYTES,
      "Replay report publication must use the declared internal report profile",
    );
    const content = await readLocalReplayReport(reportDirectory, request.contentReference);
    const reservation = await regression.reserveArtifact({
      request: {
        ...request.contentReference,
        redaction: { status: "not_required" },
        retention: { mode: "retain" },
      },
    });
    assert(
      sameContentReference(reservation.metadata.contentReference, request.contentReference) &&
        reservation.metadata.redaction.status === "not_required" &&
        reservation.metadata.retention.mode === "retain",
      "Replay report reservation must preserve its immutable descriptor",
    );
    if (reservation.metadata.state === "available") return;
    assert(reservation.metadata.state === "reserved", "Replay report must be publishable");
    const upload = await regression.uploadArtifactContent({
      artifactId: request.contentReference.artifactId,
      content,
    });
    assert(
      upload.metadata.state === "available" &&
        sameContentReference(upload.metadata.contentReference, request.contentReference),
      "Replay report upload must make the exact artifact available",
    );
  };

  const workers: RunningWorker[] = [];
  const launch = async (command: DurableReplayWorkerCommand): Promise<RunningWorker> => {
    const worker = await startWorker({
      command,
      commandDirectory,
      publishReport,
      workerEntryPointPath: options.workerEntryPointPath,
    });
    workers.push(worker);
    return worker;
  };

  try {
    const successJobId = `job_${suffix}_success`;
    await replay.createReplayJob({
      jobId: successJobId,
      request: jobRequest(successJobId, replayPlan),
    });
    const successfulWorker = await launch(baseRunCommand(successJobId, "success"));
    await successfulWorker.waitForEvent("terminal");
    await successfulWorker.completion;
    const successSnapshot = (await replay.readReplayJob({ jobId: successJobId })).snapshot;
    assertSuccessfulSnapshot(successSnapshot, 1);

    const cancellationJobId = `job_${suffix}_cancel`;
    await replay.createReplayJob({
      jobId: cancellationJobId,
      request: jobRequest(cancellationJobId, replayPlan),
    });
    const cancellationWorker = await launch(baseRunCommand(cancellationJobId, "cancel"));
    await cancellationWorker.waitForEvent("claimed");
    await replay.requestReplayCancellation({
      jobId: cancellationJobId,
      request: {
        cancellationId: `can_${suffix}_operator`,
        reason: "Stop the running reference replay and record worker acknowledgement.",
        reasonCode: "operator_request",
      },
    });
    await cancellationWorker.waitForEvent("terminal");
    await cancellationWorker.completion;
    const cancellationSnapshot = (await replay.readReplayJob({ jobId: cancellationJobId }))
      .snapshot;
    assert(
      cancellationSnapshot.job.status === "cancelled",
      "Cancellation must terminalize the job",
    );
    assert(cancellationSnapshot.cancellationRequest, "Cancellation request must be durable");
    assert(
      cancellationSnapshot.cancellationAcknowledgements.length > 0,
      "The current worker fence must acknowledge cancellation",
    );

    const staleJobId = `job_${suffix}_stale`;
    await replay.createReplayJob({
      jobId: staleJobId,
      request: jobRequest(staleJobId, replayPlan),
    });
    const staleClaimCommand = DurableReplayWorkerCommandSchema.parse({
      claim: claimIdentity(suffix, "stale_old", workerBuildSha256),
      command: "claim",
      databaseUrl: options.workerDatabaseUrl,
      jobId: staleJobId,
      leaseDurationMilliseconds: 300,
      schemaVersion: "0.1",
      scope,
    });
    const staleClaimWorker = await launch(staleClaimCommand);
    const staleClaim = await staleClaimWorker.waitForEvent("claimed");
    await staleClaimWorker.completion;
    await wait(600);

    const recoveryWorker = await launch(baseRunCommand(staleJobId, "stale_new"));
    const recoveredClaim = await recoveryWorker.waitForEvent("claimed");
    assert(
      recoveredClaim.workerFence.fencingToken > staleClaim.workerFence.fencingToken,
      "Lease recovery must advance the fencing token",
    );
    const staleProbe = await launch(
      DurableReplayWorkerCommandSchema.parse({
        command: "probe_stale_fence",
        databaseUrl: options.workerDatabaseUrl,
        leaseDurationMilliseconds: 2_000,
        schemaVersion: "0.1",
        scope,
        workerFence: staleClaim.workerFence,
      }),
    );
    await staleProbe.waitForEvent("stale_fence_rejected");
    await staleProbe.completion;
    await recoveryWorker.waitForEvent("terminal");
    await recoveryWorker.completion;
    const recoverySnapshot = (await replay.readReplayJob({ jobId: staleJobId })).snapshot;
    assertSuccessfulSnapshot(recoverySnapshot, 2);
    assert(
      recoverySnapshot.attempts[0]?.status === "lease_expired" &&
        recoverySnapshot.attempts[1]?.status === "succeeded",
      "Lease recovery must preserve expired and successful attempt history",
    );

    return Object.freeze({
      dataset: {
        datasetId,
        datasetVersionId,
        definitionSha256: datasetPublication.version.definitionSha256,
      },
      fixture: {
        definitionSha256: fixturePublication.version.definitionSha256,
        fixtureId,
        fixtureVersionId,
      },
      jobs: {
        cancellation: summarize(cancellationSnapshot),
        staleFenceRecovery: {
          ...summarize(recoverySnapshot),
          recoveredFencingToken: recoveredClaim.workerFence.fencingToken,
          rejectedFencingToken: staleClaim.workerFence.fencingToken,
        },
        success: summarize(successSnapshot),
      },
      replayPlan,
      scope,
      targetRelease: {
        definitionSha256: releasePublication.release.definitionSha256,
        targetId: releasePublication.release.targetId,
        targetReleaseId: releasePublication.release.targetReleaseId,
      },
      traceId,
    });
  } finally {
    for (const worker of workers) worker.stop();
    await Promise.allSettled(workers.map(({ completion }) => completion));
  }
}
