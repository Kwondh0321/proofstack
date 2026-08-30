import { createHash } from "node:crypto";
import {
  ArtifactContentReferenceSchema,
  EvidenceScopeSchema,
  RecordedBoundaryReplayRuntimeEvidenceSchema,
  type ReplayArtifactContentReference,
  type ReplayBoundaryExecutionResult,
  ReplayBoundaryExecutionResultSchema,
  ReplayExecutionObservationPayloadSchema,
  ReplayWorkerMutationFenceSchema,
  ReplayWorkerStartTargetMessageSchema,
  type ReplayWorkerStartTargetV2Message,
  ReplayWorkerStartTargetV2MessageSchema,
} from "@proofstack/contracts";
import { measureReplayAttemptUsage } from "./attempt-usage.js";
import type { ReplayTargetOutputEvidence } from "./bounded-output.js";
import { ReplayAttemptReportError } from "./errors.js";
import type { ReplayTargetProcessResult } from "./target-process-supervisor.js";

export const REPLAY_ATTEMPT_REPORT_MEDIA_TYPE =
  "application/vnd.proofstack.replay-attempt-report+json" as const;

const REPORT_NAMESPACE_BY_VERSION = {
  "0.1": "proofstack.replay-attempt-report.v1",
  "0.2": "proofstack.replay-attempt-report.v2",
} as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
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

export interface PublishReplayAttemptReportCommand {
  readonly content: Uint8Array;
  readonly contentReference: ReplayArtifactContentReference;
  readonly signal: AbortSignal;
  readonly scope: ReturnType<typeof EvidenceScopeSchema.parse>;
}

export interface ReplayAttemptReportPublisher {
  publish(command: PublishReplayAttemptReportCommand): Promise<unknown>;
}

export interface PublishSuccessfulReplayAttemptReportOptions {
  readonly maximumBytes: number;
  readonly processResult: ReplayTargetProcessResult;
  readonly publisher: ReplayAttemptReportPublisher;
  readonly reservationId: string;
  readonly signal: AbortSignal;
  readonly scope: unknown;
  readonly startMessage: unknown;
  readonly workerFence: unknown;
}

export interface PublishedReplayAttemptReport {
  readonly contentReference: ReplayArtifactContentReference;
  readonly emittedArtifactBytes: number;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function artifactId(
  workerFence: ReturnType<typeof ReplayWorkerMutationFenceSchema.parse>,
  schemaVersion: keyof typeof REPORT_NAMESPACE_BY_VERSION,
): string {
  return `art_${digest(
    JSON.stringify({
      attemptId: workerFence.attemptId,
      fencingToken: workerFence.fencingToken,
      jobId: workerFence.jobId,
      namespace: REPORT_NAMESPACE_BY_VERSION[schemaVersion],
    }),
  ).slice(0, 40)}`;
}

function validateMaximumBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ReplayAttemptReportError("invalid_report_size");
  }
}

function outputEvidence(
  candidate: ReplayTargetOutputEvidence,
  expectedStream: "stderr" | "stdout",
): ReplayTargetOutputEvidence {
  const validNumbers = [
    candidate.capturedBytes,
    candidate.limitBytes,
    candidate.observedAtLeastBytes,
  ].every((value) => Number.isSafeInteger(value) && value >= 0);
  const shape = {
    capturedBytes: candidate.capturedBytes,
    contentSha256: candidate.contentSha256,
    limitBytes: candidate.limitBytes,
    observedAtLeastBytes: candidate.observedAtLeastBytes,
    stream: candidate.stream,
    truncated: candidate.truncated,
  };
  const validBounds = candidate.truncated
    ? candidate.capturedBytes === candidate.limitBytes &&
      candidate.observedAtLeastBytes === candidate.limitBytes + 1
    : candidate.capturedBytes === candidate.observedAtLeastBytes;
  if (
    !validNumbers ||
    candidate.stream !== expectedStream ||
    typeof candidate.truncated !== "boolean" ||
    !SHA256_PATTERN.test(candidate.contentSha256) ||
    !SHA256_PATTERN.test(candidate.evidenceSha256) ||
    candidate.capturedBytes > candidate.limitBytes ||
    !validBounds ||
    digest(JSON.stringify(shape)) !== candidate.evidenceSha256
  ) {
    throw new ReplayAttemptReportError("invalid_process_result");
  }
  return Object.freeze({ ...shape, evidenceSha256: candidate.evidenceSha256 });
}

function executionSummary(processResult: ReplayTargetProcessResult) {
  try {
    const observations = processResult.executionObservations.map((candidate) => {
      const parsed = ReplayExecutionObservationPayloadSchema.parse(candidate);
      if (parsed.kind === "cancellation" || parsed.kind === "isolation") {
        throw new TypeError("Supervisor execution evidence contains a reserved observation kind");
      }
      return parsed;
    });
    return Object.freeze({
      count: observations.length,
      sha256: digest(JSON.stringify(observations)),
    });
  } catch (error) {
    throw new ReplayAttemptReportError("invalid_process_result", { cause: error });
  }
}

function isolationEvidence(processResult: ReplayTargetProcessResult) {
  try {
    const byControl = new Map(
      processResult.isolation.map((candidate) => {
        const parsed = ReplayExecutionObservationPayloadSchema.parse(candidate);
        if (
          parsed.kind !== "isolation" ||
          digest(JSON.stringify({ control: parsed.control, verdict: parsed.verdict })) !==
            parsed.evidenceSha256
        ) {
          throw new TypeError("Supervisor isolation evidence is invalid");
        }
        return [parsed.control, parsed] as const;
      }),
    );
    if (
      processResult.isolation.length !== ISOLATION_CONTROLS.length ||
      byControl.size !== ISOLATION_CONTROLS.length ||
      byControl.get("output_limits")?.verdict !== "verified" ||
      byControl.get("process_boundary")?.verdict !== "verified"
    ) {
      throw new TypeError("Successful process isolation evidence is incomplete");
    }
    return Object.freeze(
      ISOLATION_CONTROLS.map((control) =>
        Object.freeze(byControl.get(control) as NonNullable<ReturnType<typeof byControl.get>>),
      ),
    );
  } catch (error) {
    throw new ReplayAttemptReportError("invalid_process_result", { cause: error });
  }
}

function runtimeEvidence(processResult: ReplayTargetProcessResult, boundaryIds: readonly string[]) {
  try {
    const byBoundary = new Map(
      processResult.runtime.map((candidate) => {
        const evidence = RecordedBoundaryReplayRuntimeEvidenceSchema.parse(candidate.evidence);
        if (typeof candidate.violated !== "boolean") {
          throw new TypeError("Runtime control violation marker is invalid");
        }
        return [
          candidate.boundaryId,
          Object.freeze({
            boundaryId: candidate.boundaryId,
            evidence,
            violated: candidate.violated,
          }),
        ] as const;
      }),
    );
    const sortedBoundaryIds = [...boundaryIds].sort();
    if (
      processResult.runtime.length !== boundaryIds.length ||
      byBoundary.size !== boundaryIds.length ||
      sortedBoundaryIds.some((boundaryId) => !byBoundary.has(boundaryId)) ||
      [...byBoundary.values()].some(({ violated }) => violated)
    ) {
      throw new TypeError("Successful runtime control evidence is incomplete or violated");
    }
    return Object.freeze(
      sortedBoundaryIds.map(
        (boundaryId) =>
          byBoundary.get(boundaryId) as NonNullable<ReturnType<typeof byBoundary.get>>,
      ),
    );
  } catch (error) {
    throw new ReplayAttemptReportError("invalid_process_result", { cause: error });
  }
}

function processEvidence(processResult: ReplayTargetProcessResult, boundaryIds: readonly string[]) {
  if (
    processResult.status !== "completed" ||
    processResult.failureCode !== null ||
    processResult.exitCode !== 0 ||
    processResult.signal !== null
  ) {
    throw new ReplayAttemptReportError("invalid_process_result");
  }
  const stderr = outputEvidence(processResult.stderr, "stderr");
  const stdout = outputEvidence(processResult.stdout, "stdout");
  if (stderr.truncated || stdout.truncated) {
    throw new ReplayAttemptReportError("invalid_process_result");
  }
  const execution = executionSummary(processResult);
  return Object.freeze({
    executionObservationCount: execution.count,
    executionObservationsSha256: execution.sha256,
    exitCode: 0,
    failureCode: null,
    isolation: isolationEvidence(processResult),
    runtime: runtimeEvidence(processResult, boundaryIds),
    signal: null,
    status: "completed" as const,
    stderr,
    stdout,
  });
}

function reportTargetRelease(
  targetRelease:
    | ReturnType<typeof ReplayWorkerStartTargetMessageSchema.parse>["targetRelease"]
    | ReplayWorkerStartTargetV2Message["targetRelease"],
) {
  return {
    definitionSha256: targetRelease.definitionSha256,
    targetAdapter: {
      name: targetRelease.targetAdapter.name,
      protocolVersion: targetRelease.targetAdapter.protocolVersion,
      version: targetRelease.targetAdapter.version,
    },
    targetId: targetRelease.targetId,
    targetReleaseId: targetRelease.targetReleaseId,
    workerProtocol: {
      name: targetRelease.workerProtocol.name,
      version: targetRelease.workerProtocol.version,
    },
  };
}

function outputSummary(result: ReplayBoundaryExecutionResult) {
  const outputSha256 = digest(JSON.stringify(result.output));
  if (result.output.kind === "normalized_response") {
    return {
      adapter: result.output.response.adapter,
      contentSha256: result.output.response.normalizedResponseSha256,
      kind: result.output.kind,
      outputSha256,
      sizeBytes: result.output.response.sizeBytes,
    } as const;
  }
  return {
    artifactCount: result.output.response.artifacts.length,
    kind: result.output.kind,
    outputSha256,
    resolutionSha256: digest(JSON.stringify(result.output.response.resolution)),
    returnedArtifactsSha256: digest(
      JSON.stringify(result.output.response.resolution.returnedArtifacts),
    ),
  } as const;
}

function boundaryResultEntry(result: ReplayBoundaryExecutionResult) {
  return {
    actualRequest: result.actualRequest,
    boundaryId: result.boundaryId,
    declarationSha256: digest(JSON.stringify(result.declaration)),
    effectCertainty: result.effectCertainty,
    ...(result.effectRetrySafety === undefined
      ? {}
      : { effectRetrySafety: result.effectRetrySafety }),
    executionOrigin: result.executionOrigin,
    mode: result.mode,
    output: outputSummary(result),
    usage: result.usage,
  };
}

function boundaryResultsEvidence(
  processResult: ReplayTargetProcessResult,
  startMessage: ReplayWorkerStartTargetV2Message,
) {
  try {
    if (!("boundaryResults" in processResult) || !Array.isArray(processResult.boundaryResults)) {
      throw new TypeError("Protocol v2 process result is missing boundary results");
    }
    const results = Object.freeze(
      processResult.boundaryResults.map((candidate) =>
        ReplayBoundaryExecutionResultSchema.parse(candidate),
      ),
    );
    const byBoundary = new Map(
      startMessage.boundaries.map((boundary) => [boundary.boundaryId, boundary] as const),
    );
    for (const result of results) {
      const boundary = byBoundary.get(result.boundaryId);
      if (
        boundary === undefined ||
        boundary.kind !== result.actualRequest.kind ||
        boundary.mode !== result.mode
      ) {
        throw new TypeError("Boundary result does not match the projected process declaration");
      }
    }
    measureReplayAttemptUsage({
      boundaryResults: results,
      elapsedMilliseconds: 0,
      emittedArtifactBytes: 0,
      executionObservations: processResult.executionObservations,
    });
    const entries = Object.freeze(results.map(boundaryResultEntry));
    return Object.freeze({
      count: entries.length,
      entries,
      fullResultsSha256: digest(JSON.stringify(results)),
      summarySha256: digest(JSON.stringify(entries)),
    });
  } catch (error) {
    throw new ReplayAttemptReportError("invalid_process_result", { cause: error });
  }
}

type ReplayStartMessage =
  | ReturnType<typeof ReplayWorkerStartTargetMessageSchema.parse>
  | ReplayWorkerStartTargetV2Message;

function parseStartMessage(input: unknown): ReplayStartMessage {
  const v2 = ReplayWorkerStartTargetV2MessageSchema.safeParse(input);
  if (v2.success) return v2.data;
  return ReplayWorkerStartTargetMessageSchema.parse(input);
}

function reportContent(options: PublishSuccessfulReplayAttemptReportOptions): {
  readonly bytes: Uint8Array;
  readonly schemaVersion: "0.1" | "0.2";
  readonly scope: ReturnType<typeof EvidenceScopeSchema.parse>;
  readonly workerFence: ReturnType<typeof ReplayWorkerMutationFenceSchema.parse>;
} {
  let scope: ReturnType<typeof EvidenceScopeSchema.parse>;
  let workerFence: ReturnType<typeof ReplayWorkerMutationFenceSchema.parse>;
  let startMessage: ReplayStartMessage;
  try {
    scope = EvidenceScopeSchema.parse(options.scope);
    workerFence = ReplayWorkerMutationFenceSchema.parse(options.workerFence);
    startMessage = parseStartMessage(options.startMessage);
    if (!/^rsv_[a-z0-9_]{1,60}$/.test(options.reservationId)) {
      throw new TypeError("Attempt reservation identifier is invalid");
    }
  } catch (error) {
    throw new ReplayAttemptReportError("invalid_report_context", { cause: error });
  }
  if (startMessage.schemaVersion === "0.2") {
    const recordedBoundaryIds = startMessage.boundaries.flatMap((boundary) =>
      boundary.mode === "recorded_stub" ? [boundary.boundaryId] : [],
    );
    const process = processEvidence(options.processResult, recordedBoundaryIds);
    const boundaryResults = boundaryResultsEvidence(options.processResult, startMessage);
    const report = {
      attempt: {
        attemptId: workerFence.attemptId,
        fencingToken: workerFence.fencingToken,
        jobId: workerFence.jobId,
        leaseId: workerFence.leaseId,
        recoveryEpoch: workerFence.recoveryEpoch,
        workerId: workerFence.workerId,
      },
      boundaryResults,
      budgetReservationId: options.reservationId,
      process,
      schemaVersion: "0.2",
      scope: {
        environmentId: scope.environmentId,
        projectId: scope.projectId,
        tenantId: scope.tenantId,
      },
      session: {
        boundaries: startMessage.boundaries.map(({ boundaryId, kind, mode }) => ({
          boundaryId,
          kind,
          mode,
        })),
        boundaryIds: startMessage.boundaries.map(({ boundaryId }) => boundaryId),
        sessionId: startMessage.sessionId,
        targetRelease: reportTargetRelease(startMessage.targetRelease),
      },
    } as const;
    return {
      bytes: Buffer.from(JSON.stringify(report), "utf8"),
      schemaVersion: "0.2",
      scope,
      workerFence,
    };
  }
  const process = processEvidence(
    options.processResult,
    startMessage.boundaries.map(({ boundaryId }) => boundaryId),
  );
  const report = {
    attempt: {
      attemptId: workerFence.attemptId,
      fencingToken: workerFence.fencingToken,
      jobId: workerFence.jobId,
      leaseId: workerFence.leaseId,
      recoveryEpoch: workerFence.recoveryEpoch,
      workerId: workerFence.workerId,
    },
    budgetReservationId: options.reservationId,
    process,
    schemaVersion: "0.1",
    scope: {
      environmentId: scope.environmentId,
      projectId: scope.projectId,
      tenantId: scope.tenantId,
    },
    session: {
      boundaryIds: startMessage.boundaries.map(({ boundaryId }) => boundaryId),
      sessionId: startMessage.sessionId,
      targetRelease: reportTargetRelease(startMessage.targetRelease),
    },
  } as const;
  return {
    bytes: Buffer.from(JSON.stringify(report), "utf8"),
    schemaVersion: "0.1",
    scope,
    workerFence,
  };
}

export async function publishSuccessfulReplayAttemptReport(
  options: PublishSuccessfulReplayAttemptReportOptions,
): Promise<PublishedReplayAttemptReport> {
  validateMaximumBytes(options.maximumBytes);
  const content = reportContent(options);
  if (content.bytes.byteLength > options.maximumBytes) {
    throw new ReplayAttemptReportError("invalid_report_size");
  }
  const expected = ArtifactContentReferenceSchema.parse({
    artifactId: artifactId(content.workerFence, content.schemaVersion),
    classification: "internal",
    mediaType: REPLAY_ATTEMPT_REPORT_MEDIA_TYPE,
    sha256: digest(content.bytes),
    sizeBytes: content.bytes.byteLength,
  });
  if (options.signal.aborted) {
    throw new ReplayAttemptReportError("publish_cancelled", { cause: options.signal.reason });
  }
  let published: unknown;
  try {
    published = await options.publisher.publish({
      content: Uint8Array.from(content.bytes),
      contentReference: expected,
      signal: options.signal,
      scope: content.scope,
    });
  } catch (error) {
    if (options.signal.aborted) {
      throw new ReplayAttemptReportError("publish_cancelled", { cause: error });
    }
    throw new ReplayAttemptReportError("publish_failed", { cause: error });
  }
  if (options.signal.aborted) {
    throw new ReplayAttemptReportError("publish_cancelled", { cause: options.signal.reason });
  }
  let reference: ReplayArtifactContentReference;
  try {
    reference = ArtifactContentReferenceSchema.parse(published);
  } catch (error) {
    throw new ReplayAttemptReportError("publisher_mismatch", { cause: error });
  }
  if (!sameJson(reference, expected)) {
    throw new ReplayAttemptReportError("publisher_mismatch");
  }
  return Object.freeze({
    contentReference: reference,
    emittedArtifactBytes: content.bytes.byteLength,
  });
}
