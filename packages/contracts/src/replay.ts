import { z } from "zod";
import { type ArtifactContentReferenceSchema, MAX_ARTIFACT_CONTENT_BYTES } from "./artifact.js";
import type { DataClassificationSchema } from "./evidence.js";
import {
  InteractionArtifactBindingSchema,
  type InteractionArtifactRoleSchema,
  type InteractionAttemptOutcomeSchema,
  type InteractionSideEffectSchema,
  MAX_CAPTURE_ATTEMPTS,
  ModelInteractionAttemptSchema,
  ToolInteractionAttemptSchema,
} from "./interaction.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";

export const RECORDED_BOUNDARY_REPLAY_SCHEMA_VERSION = "0.1" as const;
export const RECORDED_BOUNDARY_REPLAY_DIGEST_SCHEMA_VERSION = "0.1" as const;
export const MAX_REPLAY_OBSERVATIONS = MAX_CAPTURE_ATTEMPTS + 1;
export const MAX_REPLAY_RETURNED_ARTIFACTS = 3;

const ProtocolTokenSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+:/@-]{0,255}$/);

const ProtocolVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/);

const LocaleSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);

const TimeZoneSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9._+-]+)+)$/);

function isCanonicalBase64Url(value: string): boolean {
  const remainder = value.length % 4;
  if (remainder === 1) return false;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const lastIndex = alphabet.indexOf(value.at(-1) ?? "");
  return remainder === 2 ? lastIndex % 16 === 0 : remainder !== 3 || lastIndex % 4 === 0;
}

function decodedBase64UrlSize(value: string): number {
  const remainder = value.length % 4;
  return Math.floor(value.length / 4) * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
}

export const ReplayBase64UrlBytesSchema = z
  .string()
  .min(2)
  .max(Math.ceil((MAX_ARTIFACT_CONTENT_BYTES * 4) / 3))
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine(isCanonicalBase64Url, {
    message: "base64url bytes must use canonical unpadded encoding",
  });

export const ReplayTargetAdapterReferenceSchema = z
  .object({
    name: ProtocolTokenSchema,
    version: ProtocolVersionSchema,
  })
  .strict();

export const RecordedFixtureReplayReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    fixtureId: OpaqueIdSchema,
    fixtureVersionId: OpaqueIdSchema,
  })
  .strict();

export const RecordedBoundaryReplayRuntimeProfileSchema = z
  .object({
    boundaryMode: z.literal("recorded_stub"),
    clock: z
      .object({
        instant: UtcMillisecondTimestampSchema,
        mode: z.literal("fixed"),
      })
      .strict(),
    isolation: z
      .object({
        mode: z.literal("cooperative_in_process"),
      })
      .strict(),
    locale: LocaleSchema,
    network: z
      .object({
        policy: z.literal("deny_fallback"),
      })
      .strict(),
    random: z
      .object({
        algorithm: z.literal("hmac_sha256_counter_v1"),
        mode: z.literal("seeded"),
        seedHex: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    timeZone: TimeZoneSchema,
  })
  .strict();

export const RecordedBoundaryReplayInvocationDefinitionSchema = z
  .object({
    fixture: RecordedFixtureReplayReferenceSchema,
    invocationId: OpaqueIdSchema,
    runtime: RecordedBoundaryReplayRuntimeProfileSchema,
    schemaVersion: z.literal(RECORDED_BOUNDARY_REPLAY_SCHEMA_VERSION),
    targetAdapter: ReplayTargetAdapterReferenceSchema,
  })
  .strict();

export const RecordedBoundaryRequestSchema = z
  .object({
    boundaryRequestId: OpaqueIdSchema,
    kind: z.enum(["model", "tool"]),
    normalizedRequest: z
      .object({
        adapterName: ProtocolTokenSchema,
        adapterVersion: ProtocolVersionSchema,
        bytes: ReplayBase64UrlBytesSchema,
        encoding: z.literal("base64url"),
      })
      .strict(),
    schemaVersion: z.literal(RECORDED_BOUNDARY_REPLAY_SCHEMA_VERSION),
  })
  .strict();

export const RecordedBoundaryActualRequestMetadataSchema = z
  .object({
    adapterName: ProtocolTokenSchema,
    adapterVersion: ProtocolVersionSchema,
    boundaryRequestId: OpaqueIdSchema,
    kind: z.enum(["model", "tool"]),
    normalizedRequestSha256: Sha256Schema,
    sizeBytes: z.number().int().positive().max(MAX_ARTIFACT_CONTENT_BYTES),
  })
  .strict();

const RecordedModelAttemptSchema = z
  .object({
    attempt: ModelInteractionAttemptSchema,
    interactionId: OpaqueIdSchema,
    interactionSequence: z.number().int().nonnegative(),
    kind: z.literal("model"),
  })
  .strict();

const RecordedToolAttemptSchema = z
  .object({
    attempt: ToolInteractionAttemptSchema,
    callId: ProtocolTokenSchema,
    interactionId: OpaqueIdSchema,
    interactionSequence: z.number().int().nonnegative(),
    kind: z.literal("tool"),
  })
  .strict();

export const RecordedBoundaryAttemptSchema = z.discriminatedUnion("kind", [
  RecordedModelAttemptSchema,
  RecordedToolAttemptSchema,
]);

export const RecordedBoundaryExpectedRequestSchema = z
  .object({
    adapterName: ProtocolTokenSchema,
    adapterVersion: ProtocolVersionSchema,
    attemptId: OpaqueIdSchema,
    attemptSequence: z.number().int().nonnegative(),
    interactionId: OpaqueIdSchema,
    interactionSequence: z.number().int().nonnegative(),
    kind: z.enum(["model", "tool"]),
    normalizedRequestSha256: Sha256Schema,
  })
  .strict();

const ReturnedBindingsSchema = z
  .array(InteractionArtifactBindingSchema)
  .max(MAX_REPLAY_RETURNED_ARTIFACTS)
  .superRefine((values, context) => {
    const artifactIds = values.map(({ contentReference }) => contentReference.artifactId);
    if (new Set(artifactIds).size !== artifactIds.length) {
      context.addIssue({ code: "custom", message: "Returned artifact IDs must be unique" });
    }
    if (
      artifactIds.some(
        (artifactId, index) => index > 0 && (artifactIds[index - 1] ?? "") >= artifactId,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Returned artifacts must be ordered by artifactId",
      });
    }
  });

export const RecordedBoundaryResolutionMetadataSchema = z
  .object({
    actualRequest: RecordedBoundaryActualRequestMetadataSchema,
    expectedRequest: RecordedBoundaryExpectedRequestSchema,
    recordedAttempt: RecordedBoundaryAttemptSchema,
    returnedArtifacts: ReturnedBindingsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const expected = value.expectedRequest;
    const recorded = value.recordedAttempt;
    if (
      expected.kind !== recorded.kind ||
      expected.interactionId !== recorded.interactionId ||
      expected.interactionSequence !== recorded.interactionSequence ||
      expected.attemptId !== recorded.attempt.attemptId ||
      expected.attemptSequence !== recorded.attempt.sequence ||
      expected.adapterName !== recorded.attempt.normalizedRequest.adapterName ||
      expected.adapterVersion !== recorded.attempt.normalizedRequest.adapterVersion ||
      expected.normalizedRequestSha256 !== recorded.attempt.normalizedRequest.sha256
    ) {
      context.addIssue({
        code: "custom",
        message: "Expected request must preserve the exact recorded attempt lineage",
        path: ["expectedRequest"],
      });
    }
    if (
      value.actualRequest.kind !== expected.kind ||
      value.actualRequest.adapterName !== expected.adapterName ||
      value.actualRequest.adapterVersion !== expected.adapterVersion ||
      value.actualRequest.normalizedRequestSha256 !== expected.normalizedRequestSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "A resolution requires an exact normalized boundary request match",
        path: ["actualRequest"],
      });
    }
    const allowedRoles =
      recorded.kind === "model"
        ? new Set(["model.output_messages", "model.provider_response", "model.streaming_frames"])
        : new Set(["tool.result"]);
    if (value.returnedArtifacts.some(({ role }) => !allowedRoles.has(role))) {
      context.addIssue({
        code: "custom",
        message: "A resolution can return only response-side artifacts for its boundary kind",
        path: ["returnedArtifacts"],
      });
    }
    const returnedIds = new Set(
      value.returnedArtifacts.map(({ contentReference }) => contentReference.artifactId),
    );
    if (recorded.kind === "model") {
      const declared = [
        recorded.attempt.artifacts.outputMessagesArtifactId,
        recorded.attempt.artifacts.providerResponseArtifactId,
        recorded.attempt.artifacts.streamingFramesArtifactId,
      ].filter((artifactId): artifactId is string => artifactId !== undefined);
      if (
        returnedIds.size !== declared.length ||
        declared.some((artifactId) => !returnedIds.has(artifactId))
      ) {
        context.addIssue({
          code: "custom",
          message: "Model resolution artifacts must match the recorded response-side artifacts",
          path: ["returnedArtifacts"],
        });
      }
    } else {
      const resultArtifactId = recorded.attempt.artifacts.resultArtifactId;
      if (
        returnedIds.size !== (resultArtifactId === undefined ? 0 : 1) ||
        (resultArtifactId !== undefined && !returnedIds.has(resultArtifactId))
      ) {
        context.addIssue({
          code: "custom",
          message: "Tool resolution artifacts must match the recorded result artifact",
          path: ["returnedArtifacts"],
        });
      }
    }
  });

export const RecordedBoundaryArtifactPayloadSchema = z
  .object({
    binding: InteractionArtifactBindingSchema,
    bytes: ReplayBase64UrlBytesSchema,
    encoding: z.literal("base64url"),
  })
  .strict()
  .superRefine((value, context) => {
    if (decodedBase64UrlSize(value.bytes) !== value.binding.contentReference.sizeBytes) {
      context.addIssue({
        code: "custom",
        message: "Returned artifact bytes must match the declared byte size",
        path: ["bytes"],
      });
    }
  });

export const RecordedBoundaryResponseSchema = z
  .object({
    artifacts: z.array(RecordedBoundaryArtifactPayloadSchema).max(MAX_REPLAY_RETURNED_ARTIFACTS),
    resolution: RecordedBoundaryResolutionMetadataSchema,
    schemaVersion: z.literal(RECORDED_BOUNDARY_REPLAY_SCHEMA_VERSION),
  })
  .strict()
  .superRefine((value, context) => {
    const payloadIds = value.artifacts.map(({ binding }) => binding.contentReference.artifactId);
    const metadataIds = value.resolution.returnedArtifacts.map(
      ({ contentReference }) => contentReference.artifactId,
    );
    if (
      payloadIds.length !== metadataIds.length ||
      payloadIds.some((artifactId, index) => artifactId !== metadataIds[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Response payloads must cover the exact returned artifact metadata in order",
        path: ["artifacts"],
      });
    }
    for (const [index, payload] of value.artifacts.entries()) {
      const metadata = value.resolution.returnedArtifacts[index];
      if (metadata && JSON.stringify(payload.binding) !== JSON.stringify(metadata)) {
        context.addIssue({
          code: "custom",
          message: "Response payload bindings must equal the resolved artifact bindings",
          path: ["artifacts", index, "binding"],
        });
      }
    }
  });

export const RecordedBoundaryMismatchCodeSchema = z.enum([
  "extra_boundary_request",
  "wrong_boundary_kind",
  "wrong_adapter_name",
  "wrong_adapter_version",
  "normalized_request_digest_mismatch",
]);

const MatchedReplayObservationSchema = z
  .object({
    resolution: RecordedBoundaryResolutionMetadataSchema,
    sequence: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_REPLAY_OBSERVATIONS - 1),
    status: z.literal("matched"),
  })
  .strict();

const MismatchedReplayObservationSchema = z
  .object({
    actualRequest: RecordedBoundaryActualRequestMetadataSchema,
    code: RecordedBoundaryMismatchCodeSchema,
    expectedRequest: RecordedBoundaryExpectedRequestSchema.nullable(),
    sequence: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_REPLAY_OBSERVATIONS - 1),
    status: z.literal("mismatch"),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.code === "extra_boundary_request") !== (value.expectedRequest === null)) {
      context.addIssue({
        code: "custom",
        message: "Only an extra boundary request can omit the expected request",
        path: ["expectedRequest"],
      });
    }
  });

export const RecordedBoundaryReplayObservationSchema = z.discriminatedUnion("status", [
  MatchedReplayObservationSchema,
  MismatchedReplayObservationSchema,
]);

export const RecordedBoundaryReplayVerifiedControlSchema = z.enum([
  "artifact_bytes_verified",
  "normalized_requests_matched",
  "recorded_attempt_order_consumed",
  "resolver_has_no_live_fallback",
  "runtime_interfaces_supplied",
]);

export const RecordedBoundaryReplayLimitationSchema = z.enum([
  "target_runtime_not_isolated",
  "ambient_filesystem_not_controlled",
  "process_egress_not_enforced",
  "dependency_snapshot_not_verified",
  "runtime_controls_are_cooperative",
  "boundary_request_mismatch",
  "recorded_attempts_unconsumed",
  "target_adapter_failed",
]);

function canonicalEnumValues<T extends string>(
  values: readonly T[],
  canonical: readonly T[],
): boolean {
  const ranks = new Map(canonical.map((value, index) => [value, index] as const));
  return (
    new Set(values).size === values.length &&
    values.every(
      (value, index) =>
        index === 0 || (ranks.get(values[index - 1] ?? value) ?? -1) < (ranks.get(value) ?? -1),
    )
  );
}

const VerifiedControlsSchema = z
  .array(RecordedBoundaryReplayVerifiedControlSchema)
  .max(RecordedBoundaryReplayVerifiedControlSchema.options.length)
  .refine(
    (values) => canonicalEnumValues(values, RecordedBoundaryReplayVerifiedControlSchema.options),
    { message: "Verified controls must be unique and use canonical order" },
  );

const ReplayLimitationsSchema = z
  .array(RecordedBoundaryReplayLimitationSchema)
  .min(1)
  .max(RecordedBoundaryReplayLimitationSchema.options.length)
  .refine((values) => canonicalEnumValues(values, RecordedBoundaryReplayLimitationSchema.options), {
    message: "Replay limitations must be unique and use canonical order",
  });

export const RecordedBoundaryReplayReproducibilitySchema = z
  .object({
    classification: z.enum(["bounded", "unknown"]),
    limitations: ReplayLimitationsSchema,
    verifiedControls: VerifiedControlsSchema,
  })
  .strict();

export const RecordedBoundaryReplayRuntimeEvidenceSchema = z
  .object({
    fixedClockReadCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    randomByteCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    randomRequestCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.randomRequestCount === 0 && value.randomByteCount !== 0) {
      context.addIssue({
        code: "custom",
        message: "Random bytes require at least one random request",
        path: ["randomByteCount"],
      });
    }
    if (value.randomRequestCount > value.randomByteCount) {
      context.addIssue({
        code: "custom",
        message: "Each random request must produce at least one byte",
        path: ["randomRequestCount"],
      });
    }
  });

export const RecordedBoundaryReplayResultStatusSchema = z.enum([
  "completed",
  "mismatch",
  "incomplete",
  "target_failed",
]);

const BASE_LIMITATIONS = [
  "target_runtime_not_isolated",
  "ambient_filesystem_not_controlled",
  "process_egress_not_enforced",
  "dependency_snapshot_not_verified",
  "runtime_controls_are_cooperative",
] as const;

const COMPLETED_CONTROLS = RecordedBoundaryReplayVerifiedControlSchema.options;

function hasEvery<T>(values: readonly T[], expected: readonly T[]): boolean {
  const found = new Set(values);
  return expected.every((value) => found.has(value));
}

export const RecordedBoundaryReplayResultSchema = z
  .object({
    consumedAttemptCount: z.number().int().nonnegative().max(MAX_CAPTURE_ATTEMPTS),
    expectedAttemptCount: z.number().int().positive().max(MAX_CAPTURE_ATTEMPTS),
    invocation: RecordedBoundaryReplayInvocationDefinitionSchema,
    invocationDefinitionSha256: Sha256Schema,
    observations: z.array(RecordedBoundaryReplayObservationSchema).max(MAX_REPLAY_OBSERVATIONS),
    reproducibility: RecordedBoundaryReplayReproducibilitySchema,
    runtimeEvidence: RecordedBoundaryReplayRuntimeEvidenceSchema,
    schemaVersion: z.literal(RECORDED_BOUNDARY_REPLAY_SCHEMA_VERSION),
    status: RecordedBoundaryReplayResultStatusSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.consumedAttemptCount > value.expectedAttemptCount) {
      context.addIssue({
        code: "custom",
        message: "Consumed attempts cannot exceed expected attempts",
        path: ["consumedAttemptCount"],
      });
    }
    const observationSequences = value.observations.map(({ sequence }) => sequence);
    if (observationSequences.some((sequence, index) => sequence !== index)) {
      context.addIssue({
        code: "custom",
        message: "Replay observations must use a contiguous zero-based sequence",
        path: ["observations"],
      });
    }
    const requestIds = value.observations.map((observation) =>
      observation.status === "matched"
        ? observation.resolution.actualRequest.boundaryRequestId
        : observation.actualRequest.boundaryRequestId,
    );
    if (new Set(requestIds).size !== requestIds.length) {
      context.addIssue({
        code: "custom",
        message: "Boundary request IDs must be unique inside one invocation",
        path: ["observations"],
      });
    }
    const matchedCount = value.observations.filter(({ status }) => status === "matched").length;
    if (matchedCount !== value.consumedAttemptCount) {
      context.addIssue({
        code: "custom",
        message: "Consumed attempt count must equal matched observations",
        path: ["consumedAttemptCount"],
      });
    }
    if (!hasEvery(value.reproducibility.limitations, BASE_LIMITATIONS)) {
      context.addIssue({
        code: "custom",
        message: "In-process replay results must disclose every base isolation limitation",
        path: ["reproducibility", "limitations"],
      });
    }

    const lastObservation = value.observations.at(-1);
    const statusLimitation = {
      incomplete: "recorded_attempts_unconsumed",
      mismatch: "boundary_request_mismatch",
      target_failed: "target_adapter_failed",
    } as const;
    const terminalLimitations = Object.values(statusLimitation);

    if (value.status === "completed") {
      if (
        value.consumedAttemptCount !== value.expectedAttemptCount ||
        value.observations.some(({ status }) => status !== "matched") ||
        value.reproducibility.classification !== "bounded" ||
        !hasEvery(value.reproducibility.verifiedControls, COMPLETED_CONTROLS) ||
        value.reproducibility.limitations.some((limitation) =>
          terminalLimitations.includes(limitation as never),
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "Completed replay requires exact consumption and bounded evidence",
          path: ["status"],
        });
      }
      return;
    }

    if (value.reproducibility.classification !== "unknown") {
      context.addIssue({
        code: "custom",
        message: "Non-completed replay results require unknown reproducibility",
        path: ["reproducibility", "classification"],
      });
    }
    const requiredLimitation = statusLimitation[value.status];
    if (
      !value.reproducibility.limitations.includes(requiredLimitation) ||
      value.reproducibility.limitations.some(
        (limitation) =>
          terminalLimitations.includes(limitation as never) && limitation !== requiredLimitation,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Replay result must disclose only its matching terminal limitation",
        path: ["reproducibility", "limitations"],
      });
    }
    const mismatchCount = value.observations.filter(({ status }) => status === "mismatch").length;
    if (
      value.status === "mismatch" &&
      (mismatchCount !== 1 ||
        lastObservation === undefined ||
        lastObservation.status !== "mismatch")
    ) {
      context.addIssue({
        code: "custom",
        message: "Mismatch status requires a terminal mismatch observation",
        path: ["observations"],
      });
    }
    if (
      value.status !== "mismatch" &&
      value.observations.some(({ status }) => status === "mismatch")
    ) {
      context.addIssue({
        code: "custom",
        message: "Only mismatch results can contain mismatch observations",
        path: ["observations"],
      });
    }
    if (value.status === "incomplete" && value.consumedAttemptCount >= value.expectedAttemptCount) {
      context.addIssue({
        code: "custom",
        message: "Incomplete replay must leave at least one recorded attempt unconsumed",
        path: ["consumedAttemptCount"],
      });
    }
  });

export type RecordedBoundaryActualRequestMetadata = z.infer<
  typeof RecordedBoundaryActualRequestMetadataSchema
>;
export type RecordedBoundaryArtifactPayload = z.infer<typeof RecordedBoundaryArtifactPayloadSchema>;
export type RecordedBoundaryAttempt = z.infer<typeof RecordedBoundaryAttemptSchema>;
export type RecordedBoundaryExpectedRequest = z.infer<typeof RecordedBoundaryExpectedRequestSchema>;
export type RecordedBoundaryMismatchCode = z.infer<typeof RecordedBoundaryMismatchCodeSchema>;
export type RecordedBoundaryReplayInvocationDefinition = z.infer<
  typeof RecordedBoundaryReplayInvocationDefinitionSchema
>;
export type RecordedBoundaryReplayLimitation = z.infer<
  typeof RecordedBoundaryReplayLimitationSchema
>;
export type RecordedBoundaryReplayObservation = z.infer<
  typeof RecordedBoundaryReplayObservationSchema
>;
export type RecordedBoundaryReplayReproducibility = z.infer<
  typeof RecordedBoundaryReplayReproducibilitySchema
>;
export type RecordedBoundaryReplayResult = z.infer<typeof RecordedBoundaryReplayResultSchema>;
export type RecordedBoundaryReplayResultStatus = z.infer<
  typeof RecordedBoundaryReplayResultStatusSchema
>;
export type RecordedBoundaryReplayRuntimeEvidence = z.infer<
  typeof RecordedBoundaryReplayRuntimeEvidenceSchema
>;
export type RecordedBoundaryReplayRuntimeProfile = z.infer<
  typeof RecordedBoundaryReplayRuntimeProfileSchema
>;
export type RecordedBoundaryReplayVerifiedControl = z.infer<
  typeof RecordedBoundaryReplayVerifiedControlSchema
>;
export type RecordedBoundaryRequest = z.infer<typeof RecordedBoundaryRequestSchema>;
export type RecordedBoundaryResolutionMetadata = z.infer<
  typeof RecordedBoundaryResolutionMetadataSchema
>;
export type RecordedBoundaryResponse = z.infer<typeof RecordedBoundaryResponseSchema>;
export type RecordedFixtureReplayReference = z.infer<typeof RecordedFixtureReplayReferenceSchema>;
export type ReplayTargetAdapterReference = z.infer<typeof ReplayTargetAdapterReferenceSchema>;

export type ReplayArtifactContentReference = z.infer<typeof ArtifactContentReferenceSchema>;
export type ReplayArtifactRole = z.infer<typeof InteractionArtifactRoleSchema>;
export type ReplayAttemptOutcome = z.infer<typeof InteractionAttemptOutcomeSchema>;
export type ReplayDataClassification = z.infer<typeof DataClassificationSchema>;
export type ReplaySideEffect = z.infer<typeof InteractionSideEffectSchema>;
