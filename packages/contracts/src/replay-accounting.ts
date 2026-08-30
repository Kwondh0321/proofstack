import { z } from "zod";
import { EvidenceScopeSchema } from "./evidence.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";
import { ReplayWorkerMutationFenceSchema } from "./replay-job.js";
import {
  ReplayBoundaryKindSchema,
  ReplayBoundaryModeSchema,
  ReplayBudgetMeasurementSchema,
} from "./replay-plan.js";

export const REPLAY_ACCOUNTING_SCHEMA_VERSION = "0.1" as const;
export const REPLAY_OBSERVATION_SCHEMA_VERSION = "0.1" as const;
export const MAX_REPLAY_ACCOUNTING_VALUE = Number.MAX_SAFE_INTEGER;

const SafePositiveIntegerSchema = z.number().int().positive().max(MAX_REPLAY_ACCOUNTING_VALUE);
const SafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_REPLAY_ACCOUNTING_VALUE);

export const REPLAY_BUDGET_DIMENSIONS = [
  "concurrentInteractions",
  "elapsedMilliseconds",
  "emittedArtifactBytes",
  "inputTokens",
  "jobAttempts",
  "modelRequests",
  "outputTokens",
  "providerCostMicrounits",
  "retrievedBytes",
  "toolCalls",
] as const;

export const ReplayBudgetDimensionSchema = z.enum(REPLAY_BUDGET_DIMENSIONS);

const replayBudgetReservationDimensionShape = {
  committedBefore: SafeNonnegativeIntegerSchema,
  limit: SafePositiveIntegerSchema,
  measurement: ReplayBudgetMeasurementSchema,
  reservedAmount: SafeNonnegativeIntegerSchema,
};

const ReplayBudgetReservationDimensionSchema = z
  .object(replayBudgetReservationDimensionShape)
  .strict()
  .superRefine((value, context) => {
    if (value.committedBefore > value.limit - value.reservedAmount) {
      context.addIssue({
        code: "custom",
        message: "Reservation would exceed the immutable plan limit",
        path: ["reservedAmount"],
      });
    }
  });

const budgetVectorShape = Object.fromEntries(
  REPLAY_BUDGET_DIMENSIONS.map((dimension) => [dimension, ReplayBudgetReservationDimensionSchema]),
) as Record<
  (typeof REPLAY_BUDGET_DIMENSIONS)[number],
  typeof ReplayBudgetReservationDimensionSchema
>;

export const ReplayBudgetReservationVectorSchema = z
  .object(budgetVectorShape)
  .strict()
  .superRefine((value, context) => {
    if (REPLAY_BUDGET_DIMENSIONS.every((dimension) => value[dimension].reservedAmount === 0)) {
      context.addIssue({
        code: "custom",
        message: "A reservation must reserve at least one budget dimension",
      });
    }
  });

export const ReplayBudgetWorkReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("attempt_start") }).strict(),
  z
    .object({
      boundaryId: OpaqueIdSchema,
      boundaryKind: ReplayBoundaryKindSchema,
      kind: z.literal("boundary_call"),
    })
    .strict(),
  z
    .object({
      artifactId: OpaqueIdSchema,
      kind: z.literal("artifact_emission"),
    })
    .strict(),
]);

export const ReplayBudgetReservationSchema = z
  .object({
    dimensions: ReplayBudgetReservationVectorSchema,
    entryType: z.literal("reservation"),
    ledgerSequence: SafeNonnegativeIntegerSchema,
    mutationFence: ReplayWorkerMutationFenceSchema,
    reservationId: OpaqueIdSchema,
    reservedAt: UtcMillisecondTimestampSchema,
    schemaVersion: z.literal(REPLAY_ACCOUNTING_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
    work: ReplayBudgetWorkReferenceSchema,
  })
  .strict();

const ObservedUsageSchema = z
  .object({
    amount: SafeNonnegativeIntegerSchema,
    source: z.enum(["estimated", "measured", "provider_reported"]),
    status: z.literal("observed"),
  })
  .strict();

const UnavailableUsageSchema = z
  .object({
    reason: z.enum(["measurement_failed", "provider_did_not_report", "source_unavailable"]),
    status: z.literal("unavailable"),
  })
  .strict();

export const ReplayUsageMeasurementSchema = z.discriminatedUnion("status", [
  ObservedUsageSchema,
  UnavailableUsageSchema,
]);

const ReplayBudgetReconciliationDimensionSchema = z
  .object({
    actualUsage: ReplayUsageMeasurementSchema,
    disposition: z.enum(["disputed", "overrun", "settled"]),
    overrunAmount: SafeNonnegativeIntegerSchema,
    releasedAmount: SafeNonnegativeIntegerSchema,
    reservedAmount: SafeNonnegativeIntegerSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.actualUsage.status === "unavailable") {
      if (
        value.disposition !== "disputed" ||
        value.releasedAmount !== 0 ||
        value.overrunAmount !== 0
      ) {
        context.addIssue({
          code: "custom",
          message: "Unavailable usage remains fully reserved and disputed",
          path: ["disposition"],
        });
      }
      return;
    }

    if (value.actualUsage.amount <= value.reservedAmount) {
      if (
        value.disposition !== "settled" ||
        value.releasedAmount !== value.reservedAmount - value.actualUsage.amount ||
        value.overrunAmount !== 0
      ) {
        context.addIssue({
          code: "custom",
          message: "Settled usage must release exactly the unused reservation",
          path: ["releasedAmount"],
        });
      }
      return;
    }

    if (
      value.disposition !== "overrun" ||
      value.releasedAmount !== 0 ||
      value.overrunAmount !== value.actualUsage.amount - value.reservedAmount
    ) {
      context.addIssue({
        code: "custom",
        message: "Usage above reservation must preserve the complete overrun",
        path: ["overrunAmount"],
      });
    }
  });

const reconciliationVectorShape = Object.fromEntries(
  REPLAY_BUDGET_DIMENSIONS.map((dimension) => [
    dimension,
    ReplayBudgetReconciliationDimensionSchema,
  ]),
) as Record<
  (typeof REPLAY_BUDGET_DIMENSIONS)[number],
  typeof ReplayBudgetReconciliationDimensionSchema
>;

export const ReplayBudgetReconciliationVectorSchema = z.object(reconciliationVectorShape).strict();

export const ReplayBudgetReconciliationSchema = z
  .object({
    dimensions: ReplayBudgetReconciliationVectorSchema,
    entryType: z.literal("reconciliation"),
    ledgerSequence: SafeNonnegativeIntegerSchema,
    mutationFence: ReplayWorkerMutationFenceSchema,
    reconciledAt: UtcMillisecondTimestampSchema,
    reconciliationId: OpaqueIdSchema,
    reservationId: OpaqueIdSchema,
    schemaVersion: z.literal(REPLAY_ACCOUNTING_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict();

export const ReplayBudgetLedgerEntrySchema = z.discriminatedUnion("entryType", [
  ReplayBudgetReservationSchema,
  ReplayBudgetReconciliationSchema,
]);

export const ReplayUsageObservationSchema = z
  .object({
    boundaryId: OpaqueIdSchema.optional(),
    measurements: z
      .array(
        z
          .object({
            dimension: ReplayBudgetDimensionSchema,
            usage: ReplayUsageMeasurementSchema,
          })
          .strict(),
      )
      .min(1)
      .max(REPLAY_BUDGET_DIMENSIONS.length)
      .refine(
        (values) =>
          values.every(
            ({ dimension }, index) =>
              index === 0 || (values[index - 1]?.dimension ?? "") < dimension,
          ),
        "Usage measurements must be unique and sorted by dimension",
      ),
    mutationFence: ReplayWorkerMutationFenceSchema,
    observationId: OpaqueIdSchema,
    observationSequence: SafeNonnegativeIntegerSchema,
    observedAt: UtcMillisecondTimestampSchema,
    schemaVersion: z.literal(REPLAY_OBSERVATION_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
    sourceEventSha256: Sha256Schema,
  })
  .strict();

const BoundaryOutputOriginSchema = z.enum(["live", "recorded", "simulated"]);

const BoundaryExecutionObservationSchema = z
  .object({
    afterCancellationRequest: z.boolean(),
    boundaryId: OpaqueIdSchema,
    boundaryKind: ReplayBoundaryKindSchema,
    effectCertainty: z.enum(["confirmed", "may_have_occurred", "none"]),
    evidenceSha256: Sha256Schema,
    kind: z.literal("boundary"),
    mode: ReplayBoundaryModeSchema,
    executionOrigin: BoundaryOutputOriginSchema,
    phase: z.enum(["failed", "request_started", "response_observed"]),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedOrigin = {
      live_provider: "live",
      recorded_stub: "recorded",
      simulation: "simulated",
    } as const;
    if (value.executionOrigin !== expectedOrigin[value.mode]) {
      context.addIssue({
        code: "custom",
        message: "Boundary output origin must preserve the selected immutable mode",
        path: ["executionOrigin"],
      });
    }
    if (value.mode !== "live_provider" && value.effectCertainty !== "none") {
      context.addIssue({
        code: "custom",
        message: "Recorded and simulated boundaries cannot claim a live external effect",
        path: ["effectCertainty"],
      });
    }
  });

const TargetExecutionObservationSchema = z
  .object({
    afterCancellationRequest: z.boolean(),
    evidenceSha256: Sha256Schema,
    event: z.enum(["exited", "started", "stderr_capped", "stdout_capped"]),
    exitCode: z.number().int().min(-1).max(255).optional(),
    kind: z.literal("target"),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.event === "exited") !== (value.exitCode !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Only an exited target observation carries an exit code",
        path: ["exitCode"],
      });
    }
  });

const CancellationExecutionObservationSchema = z
  .object({
    cancellationId: OpaqueIdSchema,
    event: z.enum([
      "late_completion_observed",
      "request_observed",
      "stop_requested",
      "stopped_before_target_start",
    ]),
    evidenceSha256: Sha256Schema,
    kind: z.literal("cancellation"),
  })
  .strict();

const IsolationExecutionObservationSchema = z
  .object({
    control: z.enum([
      "environment_allowlist",
      "filesystem_mounts",
      "network_policy",
      "no_new_privileges",
      "output_limits",
      "process_boundary",
      "resource_limits",
      "subprocess_policy",
    ]),
    evidenceSha256: Sha256Schema,
    kind: z.literal("isolation"),
    verdict: z.enum(["failed", "not_verified", "verified"]),
  })
  .strict();

export const ReplayExecutionObservationPayloadSchema = z.discriminatedUnion("kind", [
  BoundaryExecutionObservationSchema,
  CancellationExecutionObservationSchema,
  IsolationExecutionObservationSchema,
  TargetExecutionObservationSchema,
]);

export const ReplayExecutionObservationSchema = z
  .object({
    mutationFence: ReplayWorkerMutationFenceSchema,
    observationId: OpaqueIdSchema,
    observationSequence: SafeNonnegativeIntegerSchema,
    observedAt: UtcMillisecondTimestampSchema,
    payload: ReplayExecutionObservationPayloadSchema,
    schemaVersion: z.literal(REPLAY_OBSERVATION_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict();

export type ReplayBudgetDimension = z.infer<typeof ReplayBudgetDimensionSchema>;
export type ReplayBudgetLedgerEntry = z.infer<typeof ReplayBudgetLedgerEntrySchema>;
export type ReplayBudgetReconciliation = z.infer<typeof ReplayBudgetReconciliationSchema>;
export type ReplayBudgetReconciliationVector = z.infer<
  typeof ReplayBudgetReconciliationVectorSchema
>;
export type ReplayBudgetReservation = z.infer<typeof ReplayBudgetReservationSchema>;
export type ReplayBudgetReservationVector = z.infer<typeof ReplayBudgetReservationVectorSchema>;
export type ReplayBudgetWorkReference = z.infer<typeof ReplayBudgetWorkReferenceSchema>;
export type ReplayExecutionObservation = z.infer<typeof ReplayExecutionObservationSchema>;
export type ReplayExecutionObservationPayload = z.infer<
  typeof ReplayExecutionObservationPayloadSchema
>;
export type ReplayUsageMeasurement = z.infer<typeof ReplayUsageMeasurementSchema>;
export type ReplayUsageObservation = z.infer<typeof ReplayUsageObservationSchema>;
