import { createHash } from "node:crypto";
import {
  REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
  type ReplayBoundaryExecutionRequest,
  type ReplayBoundaryExecutionResult,
  ReplayBoundaryExecutionResultSchema,
  type ReplayTargetBoundaryRequestV2Message,
  type ReplayTargetClockRequestV2Message,
  type ReplayTargetProcessAbortCode,
  ReplayTargetProcessAbortCodeSchema,
  type ReplayTargetProcessStopReason,
  ReplayTargetProcessStopReasonSchema,
  type ReplayTargetRandomRequestV2Message,
  type ReplayTargetToWorkerV2Message,
  ReplayTargetToWorkerV2MessageSchema,
  type ReplayWorkerAbortTargetV2Message,
  ReplayWorkerAbortTargetV2MessageSchema,
  type ReplayWorkerBoundaryResultV2Message,
  ReplayWorkerBoundaryResultV2MessageSchema,
  type ReplayWorkerClockResponseV2Message,
  ReplayWorkerClockResponseV2MessageSchema,
  type ReplayWorkerRandomResponseV2Message,
  ReplayWorkerRandomResponseV2MessageSchema,
  type ReplayWorkerStartTargetV2Message,
  ReplayWorkerStartTargetV2MessageSchema,
  type ReplayWorkerStopTargetV2Message,
  ReplayWorkerStopTargetV2MessageSchema,
} from "@proofstack/contracts";
import {
  ReplayTargetProcessProtocolError,
  type ReplayTargetProcessProtocolErrorCode,
} from "./errors.js";

export type ReplayTargetProcessV2SessionStatus =
  | "aborted"
  | "awaiting_ready"
  | "awaiting_response"
  | "completed"
  | "created"
  | "failed"
  | "ready"
  | "stopped";

export type ReplayTargetProcessV2PendingRequestType =
  | "boundary_request"
  | "clock_request"
  | "random_request";

export interface ReplayTargetProcessV2SessionSnapshot {
  readonly acceptedRequestCount: number;
  readonly boundaryResultCount: number;
  readonly pendingRequestType: ReplayTargetProcessV2PendingRequestType | null;
  readonly sessionId: string;
  readonly status: ReplayTargetProcessV2SessionStatus;
}

type PendingRequest =
  | ReplayTargetBoundaryRequestV2Message
  | ReplayTargetClockRequestV2Message
  | ReplayTargetRandomRequestV2Message;

const CLOSED_STATUSES = new Set<ReplayTargetProcessV2SessionStatus>([
  "aborted",
  "completed",
  "failed",
  "stopped",
]);

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requestId(message: PendingRequest): string {
  return message.type === "boundary_request"
    ? message.request.boundaryRequestId
    : message.requestId;
}

function expectedActualRequest(request: ReplayBoundaryExecutionRequest) {
  const bytes = Buffer.from(request.normalizedRequest.bytes, "base64url");
  return {
    adapter: request.normalizedRequest.adapter,
    boundaryRequestId: request.boundaryRequestId,
    kind: request.kind,
    normalizedRequestSha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

export class ReplayTargetProcessV2Session {
  private acceptedRequestCount = 0;
  private readonly boundaryById: ReadonlyMap<
    string,
    ReplayWorkerStartTargetV2Message["boundaries"][number]
  >;
  private readonly results: ReplayBoundaryExecutionResult[] = [];
  private pendingRequest: PendingRequest | undefined;
  private readonly seenRequestIds = new Set<string>();
  private readonly startMessageValue: ReplayWorkerStartTargetV2Message;
  private statusValue: ReplayTargetProcessV2SessionStatus = "created";

  constructor(input: unknown) {
    const parsed = ReplayWorkerStartTargetV2MessageSchema.safeParse(input);
    if (!parsed.success) {
      throw new ReplayTargetProcessProtocolError("invalid_start_message", {
        cause: parsed.error,
      });
    }
    this.startMessageValue = parsed.data;
    this.boundaryById = new Map(
      parsed.data.boundaries.map((boundary) => [boundary.boundaryId, boundary]),
    );
  }

  get boundaryResults(): readonly ReplayBoundaryExecutionResult[] {
    return structuredClone(this.results);
  }

  start(): ReplayWorkerStartTargetV2Message {
    if (this.statusValue !== "created") this.fail("unexpected_message");
    this.statusValue = "awaiting_ready";
    return structuredClone(this.startMessageValue);
  }

  acceptTargetMessage(input: unknown): ReplayTargetToWorkerV2Message {
    this.requireOpenTargetSession();
    const parsed = ReplayTargetToWorkerV2MessageSchema.safeParse(input);
    if (!parsed.success) this.fail("invalid_target_message", parsed.error);
    const message = parsed.data;
    if (message.sessionId !== this.startMessageValue.sessionId) this.fail("session_mismatch");

    if (message.type === "ready") {
      if (this.statusValue !== "awaiting_ready") this.fail("unexpected_message");
      if (!sameJson(message.targetAdapter, this.startMessageValue.targetRelease.targetAdapter)) {
        this.fail("target_adapter_mismatch");
      }
      if (!sameJson(message.workerProtocol, this.startMessageValue.targetRelease.workerProtocol)) {
        this.fail("worker_protocol_mismatch");
      }
      this.statusValue = "ready";
      return structuredClone(message);
    }

    if (message.type === "completed") {
      if (this.statusValue !== "ready") this.fail("unexpected_message");
      if (message.requestCount !== this.acceptedRequestCount) {
        this.fail("request_sequence_mismatch");
      }
      this.statusValue = "completed";
      return structuredClone(message);
    }

    this.acceptRequest(message);
    return structuredClone(message);
  }

  respondToBoundary(input: unknown): ReplayWorkerBoundaryResultV2Message {
    const pending = this.requirePending("boundary_request");
    const parsed = ReplayBoundaryExecutionResultSchema.safeParse(input);
    if (!parsed.success) this.fail("invalid_worker_message", parsed.error);
    const result = parsed.data;
    const boundary = this.requireBoundary(pending.boundaryId);
    const projectionMatches =
      result.boundaryId === boundary.boundaryId &&
      result.mode === boundary.mode &&
      result.declaration.kind === boundary.kind &&
      sameJson(result.actualRequest, expectedActualRequest(pending.request));
    const recordedDefinitionMatches =
      boundary.mode !== "recorded_stub" || sameJson(result.declaration, boundary);
    if (!projectionMatches || !recordedDefinitionMatches) {
      this.fail("boundary_result_mismatch");
    }
    const message = ReplayWorkerBoundaryResultV2MessageSchema.parse({
      boundaryId: pending.boundaryId,
      output: result.output,
      requestSequence: pending.requestSequence,
      schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
      sessionId: this.startMessageValue.sessionId,
      type: "boundary_result",
    });
    this.results.push(result);
    this.finishPendingRequest();
    return structuredClone(message);
  }

  respondToClock(): ReplayWorkerClockResponseV2Message {
    const pending = this.requirePending("clock_request");
    const boundary = this.requireRecordedBoundary(pending.boundaryId);
    const message = ReplayWorkerClockResponseV2MessageSchema.parse({
      boundaryId: pending.boundaryId,
      instant: boundary.invocation.runtime.clock.instant,
      requestId: pending.requestId,
      requestSequence: pending.requestSequence,
      schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
      sessionId: this.startMessageValue.sessionId,
      type: "clock_response",
    });
    this.finishPendingRequest();
    return structuredClone(message);
  }

  respondToRandom(bytes: Uint8Array): ReplayWorkerRandomResponseV2Message {
    const pending = this.requirePending("random_request");
    this.requireRecordedBoundary(pending.boundaryId);
    if (bytes.byteLength !== pending.length) this.fail("random_response_mismatch");
    const message = ReplayWorkerRandomResponseV2MessageSchema.parse({
      boundaryId: pending.boundaryId,
      bytes: Buffer.from(bytes).toString("base64url"),
      encoding: "base64url",
      requestId: pending.requestId,
      requestSequence: pending.requestSequence,
      schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
      sessionId: this.startMessageValue.sessionId,
      type: "random_response",
    });
    this.finishPendingRequest();
    return structuredClone(message);
  }

  stop(reason: ReplayTargetProcessStopReason): ReplayWorkerStopTargetV2Message {
    this.requireStartedWorkerSession();
    const parsed = ReplayTargetProcessStopReasonSchema.safeParse(reason);
    if (!parsed.success) this.fail("invalid_worker_message", parsed.error);
    const message = ReplayWorkerStopTargetV2MessageSchema.parse({
      reason: parsed.data,
      schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
      sessionId: this.startMessageValue.sessionId,
      type: "stop",
    });
    this.close("stopped");
    return structuredClone(message);
  }

  abort(code: ReplayTargetProcessAbortCode): ReplayWorkerAbortTargetV2Message {
    this.requireStartedWorkerSession();
    const parsed = ReplayTargetProcessAbortCodeSchema.safeParse(code);
    if (!parsed.success) this.fail("invalid_worker_message", parsed.error);
    const message = ReplayWorkerAbortTargetV2MessageSchema.parse({
      code: parsed.data,
      schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
      sessionId: this.startMessageValue.sessionId,
      type: "abort",
    });
    this.close("aborted");
    return structuredClone(message);
  }

  protocolFailureMessage(): ReplayWorkerAbortTargetV2Message {
    if (this.statusValue !== "failed") {
      throw new ReplayTargetProcessProtocolError("unexpected_message");
    }
    return ReplayWorkerAbortTargetV2MessageSchema.parse({
      code: "session_contract_rejected",
      schemaVersion: REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION,
      sessionId: this.startMessageValue.sessionId,
      type: "abort",
    });
  }

  snapshot(): ReplayTargetProcessV2SessionSnapshot {
    return Object.freeze({
      acceptedRequestCount: this.acceptedRequestCount,
      boundaryResultCount: this.results.length,
      pendingRequestType: this.pendingRequest?.type ?? null,
      sessionId: this.startMessageValue.sessionId,
      status: this.statusValue,
    });
  }

  private acceptRequest(message: PendingRequest): void {
    if (this.statusValue !== "ready") this.fail("unexpected_message");
    if (message.requestSequence !== this.acceptedRequestCount) {
      this.fail("request_sequence_mismatch");
    }
    const boundary = this.requireBoundary(message.boundaryId);
    if (message.type === "boundary_request" && message.request.kind !== boundary.kind) {
      this.fail("boundary_request_mismatch");
    }
    if (message.type !== "boundary_request" && boundary.mode !== "recorded_stub") {
      this.fail("runtime_control_unavailable");
    }
    const identity = requestId(message);
    if (this.seenRequestIds.has(identity)) this.fail("duplicate_request_id");
    this.seenRequestIds.add(identity);
    this.pendingRequest = message;
    this.statusValue = "awaiting_response";
  }

  private close(status: "aborted" | "stopped"): void {
    this.pendingRequest = undefined;
    this.statusValue = status;
  }

  private fail(code: ReplayTargetProcessProtocolErrorCode, cause?: unknown): never {
    this.pendingRequest = undefined;
    this.statusValue = "failed";
    throw new ReplayTargetProcessProtocolError(code, cause === undefined ? undefined : { cause });
  }

  private finishPendingRequest(): void {
    this.acceptedRequestCount += 1;
    this.pendingRequest = undefined;
    this.statusValue = "ready";
  }

  private requireBoundary(
    boundaryId: string,
  ): ReplayWorkerStartTargetV2Message["boundaries"][number] {
    const boundary = this.boundaryById.get(boundaryId);
    if (!boundary) this.fail("unknown_boundary");
    return boundary;
  }

  private requireRecordedBoundary(boundaryId: string) {
    const boundary = this.requireBoundary(boundaryId);
    /* v8 ignore next -- acceptRequest rejects opaque runtime-control requests before pending state. */
    if (boundary.mode !== "recorded_stub") this.fail("runtime_control_unavailable");
    return boundary;
  }

  private requireOpenTargetSession(): void {
    if (CLOSED_STATUSES.has(this.statusValue)) {
      throw new ReplayTargetProcessProtocolError("session_closed");
    }
    if (this.statusValue === "created") this.fail("unexpected_message");
  }

  private requirePending<TType extends PendingRequest["type"]>(
    type: TType,
  ): Extract<PendingRequest, { readonly type: TType }> {
    if (this.statusValue !== "awaiting_response" || this.pendingRequest?.type !== type) {
      this.fail("unexpected_message");
    }
    return this.pendingRequest as Extract<PendingRequest, { readonly type: TType }>;
  }

  private requireStartedWorkerSession(): void {
    if (CLOSED_STATUSES.has(this.statusValue)) {
      throw new ReplayTargetProcessProtocolError("session_closed");
    }
    if (this.statusValue === "created") this.fail("unexpected_message");
  }
}
