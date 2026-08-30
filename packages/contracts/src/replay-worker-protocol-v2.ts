import { z } from "zod";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";
import {
  RecordedBoundaryReplayInvocationDefinitionSchema,
  ReplayBase64UrlBytesSchema,
} from "./replay.js";
import {
  ReplayBoundaryExecutionOutputSchema,
  ReplayBoundaryExecutionRequestSchema,
} from "./replay-boundary-execution.js";
import {
  MAX_REPLAY_BOUNDARIES,
  ReplayBoundaryKindSchema,
  ReplayReleaseTargetAdapterReferenceSchema,
  TargetReleaseReferenceSchema,
  WorkerProtocolReferenceSchema,
} from "./replay-plan.js";
import {
  MAX_REPLAY_TARGET_RANDOM_BYTES_PER_REQUEST,
  MAX_REPLAY_TARGET_REQUEST_SEQUENCE,
  ReplayTargetProcessAbortCodeSchema,
  ReplayTargetProcessStopReasonSchema,
} from "./replay-worker-protocol.js";

export const REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION = "0.2" as const;

const RequestSequenceSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_REPLAY_TARGET_REQUEST_SEQUENCE);

const RecordedReplayProcessBoundaryV2Schema = z
  .object({
    boundaryId: OpaqueIdSchema,
    invocation: RecordedBoundaryReplayInvocationDefinitionSchema,
    invocationDefinitionSha256: Sha256Schema,
    kind: z.enum(["model", "tool"]),
    mode: z.literal("recorded_stub"),
  })
  .strict();

const OpaqueReplayProcessBoundaryV2Schema = z
  .object({
    boundaryId: OpaqueIdSchema,
    kind: ReplayBoundaryKindSchema,
    mode: z.enum(["live_provider", "simulation"]),
  })
  .strict();

export const ReplayProcessBoundaryV2Schema = z.discriminatedUnion("mode", [
  OpaqueReplayProcessBoundaryV2Schema,
  RecordedReplayProcessBoundaryV2Schema,
]);

const ReplayProcessBoundariesV2Schema = z
  .array(ReplayProcessBoundaryV2Schema)
  .min(1)
  .max(MAX_REPLAY_BOUNDARIES)
  .superRefine((boundaries, context) => {
    for (const [index, boundary] of boundaries.entries()) {
      if (index > 0 && (boundaries[index - 1]?.boundaryId ?? "") >= boundary.boundaryId) {
        context.addIssue({
          code: "custom",
          message: "Process boundaries must be unique and sorted by boundaryId",
          path: [index, "boundaryId"],
        });
      }
    }
  });

export const ReplayWorkerStartTargetV2MessageSchema = z
  .object({
    boundaries: ReplayProcessBoundariesV2Schema,
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    targetRelease: TargetReleaseReferenceSchema,
    type: z.literal("start"),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [index, boundary] of value.boundaries.entries()) {
      if (boundary.mode !== "recorded_stub") continue;
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

export const ReplayWorkerBoundaryResultV2MessageSchema = z
  .object({
    boundaryId: OpaqueIdSchema,
    output: ReplayBoundaryExecutionOutputSchema,
    requestSequence: RequestSequenceSchema,
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    type: z.literal("boundary_result"),
  })
  .strict();

export const ReplayWorkerClockResponseV2MessageSchema = z
  .object({
    boundaryId: OpaqueIdSchema,
    instant: UtcMillisecondTimestampSchema,
    requestId: OpaqueIdSchema,
    requestSequence: RequestSequenceSchema,
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    type: z.literal("clock_response"),
  })
  .strict();

export const ReplayWorkerRandomResponseV2MessageSchema = z
  .object({
    boundaryId: OpaqueIdSchema,
    bytes: ReplayBase64UrlBytesSchema,
    encoding: z.literal("base64url"),
    requestId: OpaqueIdSchema,
    requestSequence: RequestSequenceSchema,
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    type: z.literal("random_response"),
  })
  .strict();

export const ReplayWorkerStopTargetV2MessageSchema = z
  .object({
    reason: ReplayTargetProcessStopReasonSchema,
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    type: z.literal("stop"),
  })
  .strict();

export const ReplayWorkerAbortTargetV2MessageSchema = z
  .object({
    code: ReplayTargetProcessAbortCodeSchema,
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    type: z.literal("abort"),
  })
  .strict();

export const ReplayWorkerToTargetV2MessageSchema = z.discriminatedUnion("type", [
  ReplayWorkerAbortTargetV2MessageSchema,
  ReplayWorkerBoundaryResultV2MessageSchema,
  ReplayWorkerClockResponseV2MessageSchema,
  ReplayWorkerRandomResponseV2MessageSchema,
  ReplayWorkerStartTargetV2MessageSchema,
  ReplayWorkerStopTargetV2MessageSchema,
]);

export const ReplayTargetReadyV2MessageSchema = z
  .object({
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    targetAdapter: ReplayReleaseTargetAdapterReferenceSchema,
    type: z.literal("ready"),
    workerProtocol: WorkerProtocolReferenceSchema,
  })
  .strict();

export const ReplayTargetBoundaryRequestV2MessageSchema = z
  .object({
    boundaryId: OpaqueIdSchema,
    request: ReplayBoundaryExecutionRequestSchema,
    requestSequence: RequestSequenceSchema,
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    type: z.literal("boundary_request"),
  })
  .strict();

export const ReplayTargetClockRequestV2MessageSchema = z
  .object({
    boundaryId: OpaqueIdSchema,
    requestId: OpaqueIdSchema,
    requestSequence: RequestSequenceSchema,
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    type: z.literal("clock_request"),
  })
  .strict();

export const ReplayTargetRandomRequestV2MessageSchema = z
  .object({
    boundaryId: OpaqueIdSchema,
    length: z.number().int().positive().max(MAX_REPLAY_TARGET_RANDOM_BYTES_PER_REQUEST),
    requestId: OpaqueIdSchema,
    requestSequence: RequestSequenceSchema,
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    type: z.literal("random_request"),
  })
  .strict();

export const ReplayTargetCompletedV2MessageSchema = z
  .object({
    requestCount: RequestSequenceSchema,
    schemaVersion: z.literal(REPLAY_TARGET_PROCESS_V2_MESSAGE_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    type: z.literal("completed"),
  })
  .strict();

export const ReplayTargetToWorkerV2MessageSchema = z.discriminatedUnion("type", [
  ReplayTargetBoundaryRequestV2MessageSchema,
  ReplayTargetClockRequestV2MessageSchema,
  ReplayTargetCompletedV2MessageSchema,
  ReplayTargetRandomRequestV2MessageSchema,
  ReplayTargetReadyV2MessageSchema,
]);

export type ReplayProcessBoundaryV2 = z.infer<typeof ReplayProcessBoundaryV2Schema>;
export type ReplayTargetBoundaryRequestV2Message = z.infer<
  typeof ReplayTargetBoundaryRequestV2MessageSchema
>;
export type ReplayTargetClockRequestV2Message = z.infer<
  typeof ReplayTargetClockRequestV2MessageSchema
>;
export type ReplayTargetCompletedV2Message = z.infer<typeof ReplayTargetCompletedV2MessageSchema>;
export type ReplayTargetRandomRequestV2Message = z.infer<
  typeof ReplayTargetRandomRequestV2MessageSchema
>;
export type ReplayTargetReadyV2Message = z.infer<typeof ReplayTargetReadyV2MessageSchema>;
export type ReplayTargetToWorkerV2Message = z.infer<typeof ReplayTargetToWorkerV2MessageSchema>;
export type ReplayWorkerAbortTargetV2Message = z.infer<
  typeof ReplayWorkerAbortTargetV2MessageSchema
>;
export type ReplayWorkerBoundaryResultV2Message = z.infer<
  typeof ReplayWorkerBoundaryResultV2MessageSchema
>;
export type ReplayWorkerClockResponseV2Message = z.infer<
  typeof ReplayWorkerClockResponseV2MessageSchema
>;
export type ReplayWorkerRandomResponseV2Message = z.infer<
  typeof ReplayWorkerRandomResponseV2MessageSchema
>;
export type ReplayWorkerStartTargetV2Message = z.infer<
  typeof ReplayWorkerStartTargetV2MessageSchema
>;
export type ReplayWorkerStopTargetV2Message = z.infer<typeof ReplayWorkerStopTargetV2MessageSchema>;
export type ReplayWorkerToTargetV2Message = z.infer<typeof ReplayWorkerToTargetV2MessageSchema>;
