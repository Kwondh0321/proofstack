import { createHash } from "node:crypto";
import {
  REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
  type RecordedBoundaryRequest,
  RecordedBoundaryResponseSchema,
  type ReplayTargetBoundaryRequestMessage,
  type ReplayTargetClockRequestMessage,
  type ReplayTargetProcessAbortCode,
  ReplayTargetProcessAbortCodeSchema,
  type ReplayTargetProcessStopReason,
  ReplayTargetProcessStopReasonSchema,
  type ReplayTargetRandomRequestMessage,
  type ReplayTargetToWorkerMessage,
  ReplayTargetToWorkerMessageSchema,
  type ReplayWorkerAbortTargetMessage,
  ReplayWorkerAbortTargetMessageSchema,
  type ReplayWorkerBoundaryResponseMessage,
  ReplayWorkerBoundaryResponseMessageSchema,
  type ReplayWorkerClockResponseMessage,
  ReplayWorkerClockResponseMessageSchema,
  type ReplayWorkerRandomResponseMessage,
  ReplayWorkerRandomResponseMessageSchema,
  type ReplayWorkerStartTargetMessage,
  ReplayWorkerStartTargetMessageSchema,
  type ReplayWorkerStopTargetMessage,
  ReplayWorkerStopTargetMessageSchema,
} from "@proofstack/contracts";
import {
  ReplayTargetProcessProtocolError,
  type ReplayTargetProcessProtocolErrorCode,
} from "./errors.js";

export type ReplayTargetProcessSessionStatus =
  | "aborted"
  | "awaiting_ready"
  | "awaiting_response"
  | "completed"
  | "created"
  | "failed"
  | "ready"
  | "stopped";

export type ReplayTargetProcessPendingRequestType =
  | "boundary_request"
  | "clock_request"
  | "random_request";

export interface ReplayTargetProcessSessionSnapshot {
  readonly acceptedRequestCount: number;
  readonly pendingRequestType: ReplayTargetProcessPendingRequestType | null;
  readonly sessionId: string;
  readonly status: ReplayTargetProcessSessionStatus;
}

type PendingRequest =
  | ReplayTargetBoundaryRequestMessage
  | ReplayTargetClockRequestMessage
  | ReplayTargetRandomRequestMessage;

const CLOSED_STATUSES = new Set<ReplayTargetProcessSessionStatus>([
  "aborted",
  "completed",
  "failed",
  "stopped",
]);

function equalReferences(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requestId(message: PendingRequest): string {
  return message.type === "boundary_request"
    ? message.request.boundaryRequestId
    : message.requestId;
}

function expectedActualRequest(request: RecordedBoundaryRequest) {
  const bytes = Buffer.from(request.normalizedRequest.bytes, "base64url");
  return {
    adapterName: request.normalizedRequest.adapterName,
    adapterVersion: request.normalizedRequest.adapterVersion,
    boundaryRequestId: request.boundaryRequestId,
    kind: request.kind,
    normalizedRequestSha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

export class ReplayTargetProcessSession {
  private acceptedRequestCount = 0;
  private readonly boundaryById: ReadonlyMap<
    string,
    ReplayWorkerStartTargetMessage["boundaries"][number]
  >;
  private pendingRequest: PendingRequest | undefined;
  private readonly seenRequestIds = new Set<string>();
  private readonly startMessageValue: ReplayWorkerStartTargetMessage;
  private statusValue: ReplayTargetProcessSessionStatus = "created";

  constructor(input: unknown) {
    const parsed = ReplayWorkerStartTargetMessageSchema.safeParse(input);
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

  start(): ReplayWorkerStartTargetMessage {
    if (this.statusValue !== "created") this.fail("unexpected_message");
    this.statusValue = "awaiting_ready";
    return structuredClone(this.startMessageValue);
  }

  acceptTargetMessage(input: unknown): ReplayTargetToWorkerMessage {
    this.requireOpenTargetSession();
    const parsed = ReplayTargetToWorkerMessageSchema.safeParse(input);
    if (!parsed.success) this.fail("invalid_target_message", parsed.error);
    const message = parsed.data;
    if (message.sessionId !== this.startMessageValue.sessionId) this.fail("session_mismatch");

    if (message.type === "ready") {
      if (this.statusValue !== "awaiting_ready") this.fail("unexpected_message");
      if (
        !equalReferences(message.targetAdapter, this.startMessageValue.targetRelease.targetAdapter)
      ) {
        this.fail("target_adapter_mismatch");
      }
      if (
        !equalReferences(
          message.workerProtocol,
          this.startMessageValue.targetRelease.workerProtocol,
        )
      ) {
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

  respondToBoundary(input: unknown): ReplayWorkerBoundaryResponseMessage {
    const pending = this.requirePending("boundary_request");
    const response = RecordedBoundaryResponseSchema.safeParse(input);
    if (!response.success) this.fail("invalid_worker_message", response.error);
    if (
      !equalReferences(
        response.data.resolution.actualRequest,
        expectedActualRequest(pending.request),
      )
    ) {
      this.fail("boundary_response_mismatch");
    }
    const message = ReplayWorkerBoundaryResponseMessageSchema.parse({
      boundaryId: pending.boundaryId,
      requestSequence: pending.requestSequence,
      response: response.data,
      schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
      sessionId: this.startMessageValue.sessionId,
      type: "boundary_response",
    });
    this.finishPendingRequest();
    return structuredClone(message);
  }

  respondToClock(): ReplayWorkerClockResponseMessage {
    const pending = this.requirePending("clock_request");
    const boundary = this.requireBoundary(pending.boundaryId);
    const message = ReplayWorkerClockResponseMessageSchema.parse({
      boundaryId: pending.boundaryId,
      instant: boundary.invocation.runtime.clock.instant,
      requestId: pending.requestId,
      requestSequence: pending.requestSequence,
      schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
      sessionId: this.startMessageValue.sessionId,
      type: "clock_response",
    });
    this.finishPendingRequest();
    return structuredClone(message);
  }

  respondToRandom(bytes: Uint8Array): ReplayWorkerRandomResponseMessage {
    const pending = this.requirePending("random_request");
    if (bytes.byteLength !== pending.length) this.fail("random_response_mismatch");
    const message = ReplayWorkerRandomResponseMessageSchema.parse({
      boundaryId: pending.boundaryId,
      bytes: Buffer.from(bytes).toString("base64url"),
      encoding: "base64url",
      requestId: pending.requestId,
      requestSequence: pending.requestSequence,
      schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
      sessionId: this.startMessageValue.sessionId,
      type: "random_response",
    });
    this.finishPendingRequest();
    return structuredClone(message);
  }

  stop(reason: ReplayTargetProcessStopReason): ReplayWorkerStopTargetMessage {
    this.requireStartedWorkerSession();
    const parsedReason = ReplayTargetProcessStopReasonSchema.safeParse(reason);
    if (!parsedReason.success) this.fail("invalid_worker_message", parsedReason.error);
    const message = ReplayWorkerStopTargetMessageSchema.parse({
      reason: parsedReason.data,
      schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
      sessionId: this.startMessageValue.sessionId,
      type: "stop",
    });
    this.close("stopped");
    return structuredClone(message);
  }

  abort(code: ReplayTargetProcessAbortCode): ReplayWorkerAbortTargetMessage {
    this.requireStartedWorkerSession();
    const parsedCode = ReplayTargetProcessAbortCodeSchema.safeParse(code);
    if (!parsedCode.success) this.fail("invalid_worker_message", parsedCode.error);
    const message = ReplayWorkerAbortTargetMessageSchema.parse({
      code: parsedCode.data,
      schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
      sessionId: this.startMessageValue.sessionId,
      type: "abort",
    });
    this.close("aborted");
    return structuredClone(message);
  }

  protocolFailureMessage(): ReplayWorkerAbortTargetMessage {
    if (this.statusValue !== "failed") {
      throw new ReplayTargetProcessProtocolError("unexpected_message");
    }
    return ReplayWorkerAbortTargetMessageSchema.parse({
      code: "session_contract_rejected",
      schemaVersion: REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION,
      sessionId: this.startMessageValue.sessionId,
      type: "abort",
    });
  }

  snapshot(): ReplayTargetProcessSessionSnapshot {
    return Object.freeze({
      acceptedRequestCount: this.acceptedRequestCount,
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
    this.requireBoundary(message.boundaryId);
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
  ): ReplayWorkerStartTargetMessage["boundaries"][number] {
    const boundary = this.boundaryById.get(boundaryId);
    if (!boundary) this.fail("unknown_boundary");
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
