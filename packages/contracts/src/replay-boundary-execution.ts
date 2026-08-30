import { z } from "zod";
import { MAX_ARTIFACT_CONTENT_BYTES } from "./artifact.js";
import { OpaqueIdSchema, Sha256Schema } from "./primitives.js";
import {
  RecordedBoundaryResponseSchema,
  ReplayBase64UrlBytesSchema,
  ReplayTargetAdapterReferenceSchema,
} from "./replay.js";
import { REPLAY_BUDGET_DIMENSIONS, ReplayUsageMeasurementSchema } from "./replay-accounting.js";
import { ReplayEffectRetrySafetySchema } from "./replay-job.js";
import {
  ReplayBoundaryDeclarationSchema,
  ReplayBoundaryKindSchema,
  ReplayBoundaryModeSchema,
} from "./replay-plan.js";

export const REPLAY_BOUNDARY_EXECUTION_SCHEMA_VERSION = "0.1" as const;

export const ReplayBoundaryExecutionRequestSchema = z
  .object({
    boundaryRequestId: OpaqueIdSchema,
    kind: ReplayBoundaryKindSchema,
    normalizedRequest: z
      .object({
        adapter: ReplayTargetAdapterReferenceSchema,
        bytes: ReplayBase64UrlBytesSchema,
        encoding: z.literal("base64url"),
      })
      .strict(),
    schemaVersion: z.literal(REPLAY_BOUNDARY_EXECUTION_SCHEMA_VERSION),
  })
  .strict();

export const ReplayBoundaryActualRequestMetadataSchema = z
  .object({
    adapter: ReplayTargetAdapterReferenceSchema,
    boundaryRequestId: OpaqueIdSchema,
    kind: ReplayBoundaryKindSchema,
    normalizedRequestSha256: Sha256Schema,
    sizeBytes: z.number().int().positive().max(MAX_ARTIFACT_CONTENT_BYTES),
  })
  .strict();

export const ReplayBoundaryNormalizedResponseSchema = z
  .object({
    adapter: ReplayTargetAdapterReferenceSchema,
    bytes: ReplayBase64UrlBytesSchema,
    encoding: z.literal("base64url"),
    normalizedResponseSha256: Sha256Schema,
    sizeBytes: z.number().int().positive().max(MAX_ARTIFACT_CONTENT_BYTES),
  })
  .strict();

export const ReplayBoundaryExecutionUsageSchema = z
  .array(
    z
      .object({
        dimension: z.enum(REPLAY_BUDGET_DIMENSIONS),
        usage: ReplayUsageMeasurementSchema,
      })
      .strict(),
  )
  .max(REPLAY_BUDGET_DIMENSIONS.length)
  .refine(
    (values) =>
      values.every(
        ({ dimension }, index) => index === 0 || (values[index - 1]?.dimension ?? "") < dimension,
      ),
    "Boundary usage measurements must be unique and sorted by dimension",
  );

const ReplayRecordedBoundaryOutputSchema = z
  .object({
    kind: z.literal("recorded_artifacts"),
    response: RecordedBoundaryResponseSchema,
  })
  .strict();

const ReplayResolvedBoundaryOutputSchema = z
  .object({
    kind: z.literal("normalized_response"),
    response: ReplayBoundaryNormalizedResponseSchema,
  })
  .strict();

export const ReplayBoundaryExecutionOutputSchema = z.discriminatedUnion("kind", [
  ReplayRecordedBoundaryOutputSchema,
  ReplayResolvedBoundaryOutputSchema,
]);

const executionOriginByMode = {
  live_provider: "live",
  recorded_stub: "recorded",
  simulation: "simulated",
} as const;

export const ReplayBoundaryExecutionResultSchema = z
  .object({
    actualRequest: ReplayBoundaryActualRequestMetadataSchema,
    boundaryId: OpaqueIdSchema,
    declaration: ReplayBoundaryDeclarationSchema,
    effectCertainty: z.enum(["confirmed", "may_have_occurred", "none"]),
    effectRetrySafety: ReplayEffectRetrySafetySchema.optional(),
    executionOrigin: z.enum(["live", "recorded", "simulated"]),
    mode: ReplayBoundaryModeSchema,
    output: ReplayBoundaryExecutionOutputSchema,
    schemaVersion: z.literal(REPLAY_BOUNDARY_EXECUTION_SCHEMA_VERSION),
    usage: ReplayBoundaryExecutionUsageSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.boundaryId !== value.declaration.boundaryId ||
      value.actualRequest.kind !== value.declaration.kind
    ) {
      context.addIssue({
        code: "custom",
        message: "Boundary result identity must match the immutable declaration",
        path: ["declaration"],
      });
    }
    if (
      value.mode !== value.declaration.mode ||
      value.executionOrigin !== executionOriginByMode[value.declaration.mode]
    ) {
      context.addIssue({
        code: "custom",
        message: "Boundary result mode and origin must preserve the immutable declaration",
        path: ["mode"],
      });
    }
    const recordedOutput = value.output.kind === "recorded_artifacts";
    if (recordedOutput !== (value.declaration.mode === "recorded_stub")) {
      context.addIssue({
        code: "custom",
        message: "Only a recorded boundary can return recorded artifact lineage",
        path: ["output"],
      });
    }
    if ((value.effectCertainty === "none") === (value.effectRetrySafety !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "External effect certainty requires one explicit retry-safety decision",
        path: ["effectRetrySafety"],
      });
    }
    if (value.declaration.mode !== "live_provider" && value.effectCertainty !== "none") {
      context.addIssue({
        code: "custom",
        message: "Recorded and simulated boundaries cannot report a live external effect",
        path: ["effectCertainty"],
      });
    }
    if (value.declaration.mode === "live_provider") {
      const sideEffect = value.declaration.sideEffect;
      if (sideEffect.kind === "read_only" && value.effectCertainty !== "none") {
        context.addIssue({
          code: "custom",
          message: "A read-only live boundary cannot report a write effect",
          path: ["effectCertainty"],
        });
      }
      if (
        sideEffect.kind === "idempotent_write" &&
        (value.effectCertainty !== "confirmed" ||
          value.effectRetrySafety?.kind !== "destination_idempotency_verified")
      ) {
        context.addIssue({
          code: "custom",
          message: "A successful idempotent write requires confirmed destination idempotency",
          path: ["effectRetrySafety"],
        });
      }
      if (
        sideEffect.kind === "non_idempotent_write" &&
        (value.effectCertainty !== "confirmed" || value.effectRetrySafety?.kind !== "not_retryable")
      ) {
        context.addIssue({
          code: "custom",
          message: "A successful non-idempotent write must remain explicitly non-retryable",
          path: ["effectRetrySafety"],
        });
      }
      for (const [index, measurement] of value.usage.entries()) {
        const source = value.declaration.usageSource;
        const matches =
          source === "unavailable"
            ? measurement.usage.status === "unavailable"
            : measurement.usage.status === "observed" && measurement.usage.source === source;
        if (!matches) {
          context.addIssue({
            code: "custom",
            message: "Live usage evidence must preserve the declared measurement source",
            path: ["usage", index, "usage"],
          });
        }
      }
    }
  });

export type ReplayBoundaryActualRequestMetadata = z.infer<
  typeof ReplayBoundaryActualRequestMetadataSchema
>;
export type ReplayBoundaryExecutionOutput = z.infer<typeof ReplayBoundaryExecutionOutputSchema>;
export type ReplayBoundaryExecutionRequest = z.infer<typeof ReplayBoundaryExecutionRequestSchema>;
export type ReplayBoundaryExecutionResult = z.infer<typeof ReplayBoundaryExecutionResultSchema>;
export type ReplayBoundaryExecutionUsage = z.infer<typeof ReplayBoundaryExecutionUsageSchema>;
export type ReplayBoundaryNormalizedResponse = z.infer<
  typeof ReplayBoundaryNormalizedResponseSchema
>;
