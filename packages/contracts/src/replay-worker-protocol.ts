import { z } from "zod";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";
import {
  ReplayBase64UrlBytesSchema,
  RecordedBoundaryReplayInvocationDefinitionSchema,
  RecordedBoundaryRequestSchema,
  RecordedBoundaryResponseSchema,
} from "./replay.js";
import {
  MAX_REPLAY_BOUNDARIES,
  ReplayReleaseTargetAdapterReferenceSchema,
  TargetReleaseReferenceSchema,
  WorkerProtocolReferenceSchema,
} from "./replay-plan.js";

export const REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION = "0.1" as const;
export const MAX_REPLAY_TARGET_REQUEST_SEQUENCE = Number.MAX_SAFE_INTEGER;
export const MAX_REPLAY_TARGET_RANDOM_BYTES_PER_REQUEST = 65_536;

const RequestSequenceSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_REPLAY_TARGET_REQUEST_SEQUENCE);

export const ReplayTargetProcessStopReasonSchema = z.enum([
  "cancellation_requested",
  "deadline_reached",
  "lease_lost",
  "worker_shutdown",
]);

export const ReplayTargetProcessAbortCodeSchema = z.enum([
  "boundary_contract_rejected",
  "boundary_mismatch",
  "session_contract_rejected",
  "worker_internal_error",
]);

export const RecordedReplayProcessBoundarySchema = z
  .object({
    boundaryId: OpaqueIdSchema,
    invocation: RecordedBoundaryReplayInvocationDefinitionSchema,
    invocationDefinitionSha256: Sha256Schema,
  })
  .strict();

const RecordedReplayProcessBoundariesSchema = z
  .array(RecordedReplayProcessBoundarySchema)
  .min(1)
  .max(MAX_REPLAY_BOUNDARIES)
  .superRefine((boundaries, context) => {
    for (const [index, boundary] of boundaries.entries()) {
      if (index > 0 && (boundaries[index - 1]?.boundaryId ?? "") >= boundary.boundaryId) {
        context.addIssue({
          code: "custom",
          message: "Recorded process boundaries must be unique and sorted by boundaryId",
          path: [index, "boundaryId"],
        });
      }
    }
  });

export const ReplayWorkerStartTargetMessageSchema = z
  .object({
    boundaries: RecordedReplayProcessBoundariesSchema,
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    targetRelease: TargetReleaseReferenceSchema,
    type: z.literal("start"),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [index, boundary] of value.boundaries.entries()) {
      const targetAdapter = value.targetRelease.targetAdapter;
      const invocationAdapter = boundary.invocation.targetAdapter;
      if (
        targetAdapter.name !== invocationAdapter.name ||
        targetAdapter.version !== invocationAdapter.version
      ) {
        context.addIssue({
          code: "custom",
          message: "Every recorded invocation must match the exact target release adapter",
          path: ["boundaries", index, "invocation", "targetAdapter"],
        });
      }
    }
  });

export const ReplayWorkerBoundaryResponseMessageSchema = z
  .object({
    boundaryId: OpaqueIdSchema,
    requestSequence: RequestSequenceSchema,
    response: RecordedBoundaryResponseSchema,
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    type: z.literal("boundary_response"),
  })
  .strict();

export const ReplayWorkerClockResponseMessageSchema = z
  .object({
    boundaryId: OpaqueIdSchema,
    instant: UtcMillisecondTimestampSchema,
    requestId: OpaqueIdSchema,
    requestSequence: RequestSequenceSchema,
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    type: z.literal("clock_response"),
  })
  .strict();

export const ReplayWorkerRandomResponseMessageSchema = z
  .object({
    boundaryId: OpaqueIdSchema,
    bytes: ReplayBase64UrlBytesSchema,
    encoding: z.literal("base64url"),
    requestId: OpaqueIdSchema,
    requestSequence: RequestSequenceSchema,
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    type: z.literal("random_response"),
  })
  .strict();

export const ReplayWorkerStopTargetMessageSchema = z
  .object({
    reason: ReplayTargetProcessStopReasonSchema,
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    type: z.literal("stop"),
  })
  .strict();

export const ReplayWorkerAbortTargetMessageSchema = z
  .object({
    code: ReplayTargetProcessAbortCodeSchema,
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    type: z.literal("abort"),
  })
  .strict();

export const ReplayWorkerToTargetMessageSchema = z.discriminatedUnion("type", [
  ReplayWorkerAbortTargetMessageSchema,
  ReplayWorkerBoundaryResponseMessageSchema,
  ReplayWorkerClockResponseMessageSchema,
  ReplayWorkerRandomResponseMessageSchema,
  ReplayWorkerStartTargetMessageSchema,
  ReplayWorkerStopTargetMessageSchema,
]);

export const ReplayTargetReadyMessageSchema = z
  .object({
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    targetAdapter: ReplayReleaseTargetAdapterReferenceSchema,
    type: z.literal("ready"),
    workerProtocol: WorkerProtocolReferenceSchema,
  })
  .strict();

export const ReplayTargetBoundaryRequestMessageSchema = z
  .object({
    boundaryId: OpaqueIdSchema,
    request: RecordedBoundaryRequestSchema,
    requestSequence: RequestSequenceSchema,
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    type: z.literal("boundary_request"),
  })
  .strict();

export const ReplayTargetClockRequestMessageSchema = z
  .object({
    boundaryId: OpaqueIdSchema,
    requestId: OpaqueIdSchema,
    requestSequence: RequestSequenceSchema,
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    type: z.literal("clock_request"),
  })
  .strict();

export const ReplayTargetRandomRequestMessageSchema = z
  .object({
    boundaryId: OpaqueIdSchema,
    length: z.number().int().positive().max(MAX_REPLAY_TARGET_RANDOM_BYTES_PER_REQUEST),
    requestId: OpaqueIdSchema,
    requestSequence: RequestSequenceSchema,
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    type: z.literal("random_request"),
  })
  .strict();

export const ReplayTargetCompletedMessageSchema = z
  .object({
    requestCount: RequestSequenceSchema,
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    type: z.literal("completed"),
  })
  .strict();

export const ReplayTargetToWorkerMessageSchema = z.discriminatedUnion("type", [
  ReplayTargetBoundaryRequestMessageSchema,
  ReplayTargetClockRequestMessageSchema,
  ReplayTargetCompletedMessageSchema,
  ReplayTargetRandomRequestMessageSchema,
  ReplayTargetReadyMessageSchema,
]);

export type RecordedReplayProcessBoundary = z.infer<typeof RecordedReplayProcessBoundarySchema>;
export type ReplayTargetBoundaryRequestMessage = z.infer<
  typeof ReplayTargetBoundaryRequestMessageSchema
>;
export type ReplayTargetCompletedMessage = z.infer<typeof ReplayTargetCompletedMessageSchema>;
export type ReplayTargetClockRequestMessage = z.infer<typeof ReplayTargetClockRequestMessageSchema>;
export type ReplayTargetProcessAbortCode = z.infer<typeof ReplayTargetProcessAbortCodeSchema>;
export type ReplayTargetProcessStopReason = z.infer<typeof ReplayTargetProcessStopReasonSchema>;
export type ReplayTargetReadyMessage = z.infer<typeof ReplayTargetReadyMessageSchema>;
export type ReplayTargetRandomRequestMessage = z.infer<
  typeof ReplayTargetRandomRequestMessageSchema
>;
export type ReplayTargetToWorkerMessage = z.infer<typeof ReplayTargetToWorkerMessageSchema>;
export type ReplayWorkerAbortTargetMessage = z.infer<typeof ReplayWorkerAbortTargetMessageSchema>;
export type ReplayWorkerBoundaryResponseMessage = z.infer<
  typeof ReplayWorkerBoundaryResponseMessageSchema
>;
export type ReplayWorkerClockResponseMessage = z.infer<
  typeof ReplayWorkerClockResponseMessageSchema
>;
export type ReplayWorkerRandomResponseMessage = z.infer<
  typeof ReplayWorkerRandomResponseMessageSchema
>;
export type ReplayWorkerStartTargetMessage = z.infer<typeof ReplayWorkerStartTargetMessageSchema>;
export type ReplayWorkerStopTargetMessage = z.infer<typeof ReplayWorkerStopTargetMessageSchema>;
export type ReplayWorkerToTargetMessage = z.infer<typeof ReplayWorkerToTargetMessageSchema>;
