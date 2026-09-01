import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { RegressionFixtureVersionReferenceSchema } from "./dataset.js";
import {
  ApplicabilityContextSchema,
  CriterionReferenceSchema,
  CriterionSetStatusReferenceSchema,
  EvaluatorReferenceSchema,
  ExactDecimalSchema,
  OracleReferenceSchema,
} from "./evaluation-criteria.js";
import {
  EvaluationExecutionBudgetSchema,
  EvaluationRuntimePolicySchema,
  QualificationReportReferenceSchema,
  RegisteredEvaluationImplementationSchema,
} from "./evaluation-spec.js";
import {
  AssuranceRationaleSchema,
  AssuranceSummarySchema,
  SourceReferenceSchema,
  SourceReviewReferenceSchema,
} from "./evaluation-source.js";
import { EvidenceScopeSchema, evidenceTimestampOrderKey } from "./evidence.js";
import {
  OpaqueIdSchema,
  PostgresTimestampSchema,
  Sha256Schema,
  UtcMillisecondTimestampSchema,
} from "./primitives.js";
import { ReplayPlanJobReferenceSchema } from "./replay-job.js";
import { TargetReleaseReferenceSchema } from "./replay-plan.js";

export const EVALUATION_RUN_SCHEMA_VERSION = "0.1" as const;
export const EVALUATION_RUN_REJECTION_SCHEMA_VERSION = "0.1" as const;
export const RAW_OBSERVATION_SCHEMA_VERSION = "0.1" as const;
export const EVALUATION_RUN_RESULT_SCHEMA_VERSION = "0.1" as const;
export const MAX_EVALUATION_ATTEMPTS = 16;
export const MAX_EVALUATION_EVIDENCE_REFERENCES = 64;

function isStrictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function exactArtifacts(minimum: number, maximum: number, label: string) {
  return z
    .array(ArtifactContentReferenceSchema)
    .min(minimum)
    .max(maximum)
    .refine(
      (references) =>
        isStrictlySortedUnique(
          references.map(({ artifactId, sha256 }) => `${artifactId}:${sha256}`),
        ),
      { message: `${label} must be unique and ordered by exact artifact reference` },
    );
}

function exactSourceReviews(label: string) {
  return z
    .array(SourceReviewReferenceSchema)
    .min(1)
    .max(64)
    .refine(
      (references) =>
        isStrictlySortedUnique(
          references.map(
            ({ sourceReviewId, definitionSha256 }) => `${sourceReviewId}:${definitionSha256}`,
          ),
        ),
      { message: `${label} must be unique and ordered by exact review reference` },
    );
}

export const EvaluationVerdictSchema = z.enum([
  "abstain",
  "error",
  "fail",
  "not_applicable",
  "pass",
]);

export const EvaluationRunReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    evaluationRunId: OpaqueIdSchema,
  })
  .strict();

export const EvaluationAggregationPolicyReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    policyId: OpaqueIdSchema,
    policyVersionId: OpaqueIdSchema,
  })
  .strict();

export const EvaluationDatasetVersionReferenceSchema = z
  .object({
    datasetId: OpaqueIdSchema,
    datasetVersionId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
  })
  .strict();

export const EvaluationReplayResultReferenceSchema = z
  .object({
    attemptId: OpaqueIdSchema,
    completedAt: PostgresTimestampSchema,
    jobId: OpaqueIdSchema,
    plan: ReplayPlanJobReferenceSchema,
    result: ArtifactContentReferenceSchema,
    targetRelease: TargetReleaseReferenceSchema,
    terminalCode: z.literal("completed"),
    terminalStatus: z.literal("succeeded"),
  })
  .strict();

const ApplicabilityRuntimePolicySchema = EvaluationRuntimePolicySchema.superRefine(
  (value, context) => {
    if (value.clock.mode !== "not_available" || value.seed.mode !== "not_used") {
      context.addIssue({
        code: "custom",
        message: "Applicability evaluation cannot read clocks or randomness",
      });
    }
  },
);

export const EvaluationApplicabilityDecisionSchema = z.discriminatedUnion("result", [
  z
    .object({
      context: ApplicabilityContextSchema,
      contextSha256: Sha256Schema,
      evaluatedAt: PostgresTimestampSchema,
      interpreter: RegisteredEvaluationImplementationSchema,
      result: z.literal("applicable"),
      runtimePolicy: ApplicabilityRuntimePolicySchema,
    })
    .strict(),
  z
    .object({
      context: ApplicabilityContextSchema,
      contextSha256: Sha256Schema,
      evaluatedAt: PostgresTimestampSchema,
      interpreter: RegisteredEvaluationImplementationSchema,
      result: z.literal("not_applicable"),
      runtimePolicy: ApplicabilityRuntimePolicySchema,
    })
    .strict(),
]);

const EvaluationUndeterminedApplicabilitySchema = z
  .object({
    context: ApplicabilityContextSchema,
    contextSha256: Sha256Schema,
    evaluatedAt: PostgresTimestampSchema,
    interpreter: RegisteredEvaluationImplementationSchema,
    result: z.literal("undetermined"),
    runtimePolicy: ApplicabilityRuntimePolicySchema,
  })
  .strict();

export const EvaluationAttemptSeedSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("not_used") }).strict(),
  z
    .object({
      mode: z.literal("fixed"),
      value: z.number().int().nonnegative().max(4_294_967_295),
    })
    .strict(),
]);

export const EvaluationRetryableErrorCodeSchema = z.enum([
  "evaluator_temporarily_unavailable",
  "executor_interrupted",
]);

export const EvaluationErrorCodeSchema = z.enum([
  "budget_exhausted",
  "contract_mismatch",
  "deadline_exceeded",
  "evaluator_internal_error",
  "evaluator_temporarily_unavailable",
  "executor_interrupted",
  "input_unavailable",
  "isolation_failed",
  "output_malformed",
  "qualification_invalid",
  "source_invalid",
]);

export const EvaluationAttemptPlanSchema = z
  .object({
    attemptId: OpaqueIdSchema,
    attemptSequence: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_EVALUATION_ATTEMPTS - 1),
    budgets: EvaluationExecutionBudgetSchema,
    seed: EvaluationAttemptSeedSchema,
  })
  .strict();

const evaluationRunDefinitionShape = {
  aggregationPolicy: EvaluationAggregationPolicyReferenceSchema,
  applicability: EvaluationApplicabilityDecisionSchema,
  attempts: z.array(EvaluationAttemptPlanSchema).max(MAX_EVALUATION_ATTEMPTS),
  criterion: CriterionReferenceSchema,
  criterionStatus: CriterionSetStatusReferenceSchema,
  dataset: EvaluationDatasetVersionReferenceSchema,
  environmentEvidence: exactArtifacts(1, 16, "Evaluation environment evidence"),
  evaluationRunId: OpaqueIdSchema,
  evaluator: EvaluatorReferenceSchema,
  evaluatorQualification: QualificationReportReferenceSchema,
  fixture: RegressionFixtureVersionReferenceSchema,
  inputEvidence: exactArtifacts(1, MAX_EVALUATION_EVIDENCE_REFERENCES, "Evaluation input evidence"),
  oracle: OracleReferenceSchema,
  oracleQualification: QualificationReportReferenceSchema,
  replay: EvaluationReplayResultReferenceSchema,
  retryableErrors: z
    .array(EvaluationRetryableErrorCodeSchema)
    .max(EvaluationRetryableErrorCodeSchema.options.length)
    .refine(isStrictlySortedUnique, {
      message: "Evaluation retryable errors must be unique and ordered",
    }),
  sourceReviews: exactSourceReviews("Evaluation source reviews"),
};

function refineEvaluationRun(
  value: {
    readonly applicability: { readonly result: "applicable" | "not_applicable" };
    readonly attempts: readonly { readonly attemptId: string; readonly attemptSequence: number }[];
  },
  context: z.RefinementCtx,
): void {
  const applicable = value.applicability.result === "applicable";
  if ((applicable && value.attempts.length === 0) || (!applicable && value.attempts.length !== 0)) {
    context.addIssue({
      code: "custom",
      message: "Applicable runs require attempts and not-applicable runs forbid execution attempts",
      path: ["attempts"],
    });
  }
  const attemptIds = value.attempts.map(({ attemptId }) => attemptId);
  if (!isStrictlySortedUnique(attemptIds)) {
    context.addIssue({
      code: "custom",
      message: "Predeclared attempt identifiers must be unique and ordered",
      path: ["attempts"],
    });
  }
  value.attempts.forEach(({ attemptSequence }, index) => {
    if (attemptSequence !== index) {
      context.addIssue({
        code: "custom",
        message: "Predeclared attempt sequences must be contiguous from zero",
        path: ["attempts", index, "attemptSequence"],
      });
    }
  });
}

export const EvaluationRunDefinitionSchema = z
  .object(evaluationRunDefinitionShape)
  .strict()
  .superRefine(refineEvaluationRun);

export const EvaluationRunSchema = z
  .object({
    ...evaluationRunDefinitionShape,
    createdAt: UtcMillisecondTimestampSchema,
    createdByPrincipalId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
    schemaVersion: z.literal(EVALUATION_RUN_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineEvaluationRun)
  .superRefine((value, context) => {
    if (
      evidenceTimestampOrderKey(value.createdAt) <
        evidenceTimestampOrderKey(value.applicability.evaluatedAt) ||
      evidenceTimestampOrderKey(value.createdAt) <
        evidenceTimestampOrderKey(value.replay.completedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Evaluation run creation cannot precede applicability or replay evidence",
        path: ["createdAt"],
      });
    }
  });

export const EvaluationRunRejectionSchema = z
  .object({
    applicability: EvaluationUndeterminedApplicabilitySchema,
    criterion: CriterionReferenceSchema,
    criterionStatus: CriterionSetStatusReferenceSchema,
    definitionSha256: Sha256Schema,
    reasons: z.array(AssuranceSummarySchema).min(1).max(32).refine(isStrictlySortedUnique, {
      message: "Evaluation rejection reasons must be unique and ordered",
    }),
    recordedAt: UtcMillisecondTimestampSchema,
    rejectionId: OpaqueIdSchema,
    requestedByPrincipalId: OpaqueIdSchema,
    resolution: z.enum(["require_approval", "unverifiable"]),
    schemaVersion: z.literal(EVALUATION_RUN_REJECTION_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
    sourceReviews: exactSourceReviews("Evaluation rejection source reviews"),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      evidenceTimestampOrderKey(value.recordedAt) <
      evidenceTimestampOrderKey(value.applicability.evaluatedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Evaluation rejection cannot precede its applicability decision",
        path: ["recordedAt"],
      });
    }
  });

export const EvaluationEvidenceReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      artifact: ArtifactContentReferenceSchema,
      kind: z.literal("artifact"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("replay_result"),
      replay: EvaluationReplayResultReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("source_snapshot"),
      source: SourceReferenceSchema,
    })
    .strict(),
]);

function evidenceReferenceKey(
  reference: z.infer<typeof EvaluationEvidenceReferenceSchema>,
): string {
  if (reference.kind === "artifact") {
    return `artifact:${reference.artifact.artifactId}:${reference.artifact.sha256}`;
  }
  if (reference.kind === "source_snapshot") {
    return `source_snapshot:${reference.source.sourceSnapshotId}:${reference.source.definitionSha256}`;
  }
  return `replay_result:${reference.replay.jobId}:${reference.replay.attemptId}:${reference.replay.result.sha256}`;
}

function exactEvidenceReferences(label: string) {
  return z
    .array(EvaluationEvidenceReferenceSchema)
    .max(MAX_EVALUATION_EVIDENCE_REFERENCES)
    .refine((references) => isStrictlySortedUnique(references.map(evidenceReferenceKey)), {
      message: `${label} must be unique and ordered by exact evidence reference`,
    });
}

export const EvaluationMeasurementSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("boolean"),
      metricName: AssuranceSummarySchema,
      value: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("categorical"),
      metricName: AssuranceSummarySchema,
      value: AssuranceSummarySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("numeric"),
      metricName: AssuranceSummarySchema,
      unit: AssuranceSummarySchema,
      value: ExactDecimalSchema,
    })
    .strict(),
]);

export const EvaluationBudgetUsageSchema = z
  .object({
    elapsedMilliseconds: z.number().int().nonnegative().max(3_600_000),
    inputBytes: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024 * 1024),
    peakMemoryBytes: z
      .number()
      .int()
      .nonnegative()
      .max(8 * 1024 * 1024 * 1024),
    outputBytes: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024 * 1024),
  })
  .strict();

export const EvaluationObservationOutputSchema = z.discriminatedUnion("produced", [
  z.object({ produced: z.literal(false) }).strict(),
  z
    .object({
      artifact: ArtifactContentReferenceSchema.optional(),
      produced: z.literal(true),
      sha256: Sha256Schema,
    })
    .strict()
    .superRefine((value, context) => {
      if (value.artifact && value.artifact.sha256 !== value.sha256) {
        context.addIssue({
          code: "custom",
          message: "Observation output artifact digest must match the declared output digest",
          path: ["artifact", "sha256"],
        });
      }
    }),
]);

export const EvaluationObservationErrorSchema = z
  .object({
    code: EvaluationErrorCodeSchema,
    detailsSha256: Sha256Schema.optional(),
    message: AssuranceRationaleSchema,
  })
  .strict();

export const EvaluationAbstentionSchema = z
  .object({
    code: z.enum([
      "ambiguous_measurement",
      "contractual_abstention",
      "insufficient_evidence",
      "outside_supported_scope",
    ]),
    rationale: AssuranceRationaleSchema,
  })
  .strict();

const rawObservationShape = {
  abstention: EvaluationAbstentionSchema.optional(),
  attemptId: OpaqueIdSchema,
  attemptSequence: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_EVALUATION_ATTEMPTS - 1),
  budgetUsage: EvaluationBudgetUsageSchema,
  completedAt: PostgresTimestampSchema,
  counterevidence: exactEvidenceReferences("Observation counterevidence"),
  error: EvaluationObservationErrorSchema.optional(),
  evidence: exactEvidenceReferences("Observation evidence"),
  executedByPrincipalId: OpaqueIdSchema,
  inputSha256: Sha256Schema,
  measurement: EvaluationMeasurementSchema.optional(),
  observationId: OpaqueIdSchema,
  outOfDistribution: z.enum(["in_distribution", "not_assessed", "out_of_distribution"]),
  output: EvaluationObservationOutputSchema,
  run: EvaluationRunReferenceSchema,
  startedAt: PostgresTimestampSchema,
  verdict: z.enum(["abstain", "error", "fail", "pass"]),
};

function refineRawObservation(
  value: {
    readonly abstention?: unknown;
    readonly completedAt: string;
    readonly error?: unknown;
    readonly measurement?: unknown;
    readonly outOfDistribution: "in_distribution" | "not_assessed" | "out_of_distribution";
    readonly output: { readonly produced: boolean };
    readonly recordedAt: string;
    readonly startedAt: string;
    readonly verdict: "abstain" | "error" | "fail" | "pass";
  },
  context: z.RefinementCtx,
): void {
  if (evidenceTimestampOrderKey(value.completedAt) < evidenceTimestampOrderKey(value.startedAt)) {
    context.addIssue({
      code: "custom",
      message: "Observation completion cannot precede its start",
      path: ["completedAt"],
    });
  }
  if (evidenceTimestampOrderKey(value.recordedAt) < evidenceTimestampOrderKey(value.completedAt)) {
    context.addIssue({
      code: "custom",
      message: "Observation recording cannot precede completion",
      path: ["recordedAt"],
    });
  }
  if (value.verdict === "error") {
    if (
      value.error === undefined ||
      value.abstention !== undefined ||
      value.measurement !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Error observations require only a typed error outcome",
        path: ["verdict"],
      });
    }
  } else if (value.verdict === "abstain") {
    if (value.abstention === undefined || value.error !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Abstaining observations require an abstention and no error",
        path: ["verdict"],
      });
    }
  } else if (
    value.measurement === undefined ||
    value.error !== undefined ||
    value.abstention !== undefined ||
    !value.output.produced
  ) {
    context.addIssue({
      code: "custom",
      message: "Pass and fail observations require a measurement and produced output only",
      path: ["verdict"],
    });
  }
  if (value.outOfDistribution === "out_of_distribution" && value.verdict !== "abstain") {
    context.addIssue({
      code: "custom",
      message: "Out-of-distribution observations must abstain",
      path: ["outOfDistribution"],
    });
  }
}

export const RawObservationSchema = z
  .object({
    ...rawObservationShape,
    definitionSha256: Sha256Schema,
    recordedAt: UtcMillisecondTimestampSchema,
    schemaVersion: z.literal(RAW_OBSERVATION_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineRawObservation);

export const RawObservationReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    observationId: OpaqueIdSchema,
  })
  .strict();

const evaluationRunResultShape = {
  completedAt: PostgresTimestampSchema,
  evaluationRunId: OpaqueIdSchema,
  observations: z.array(RawObservationReferenceSchema).max(MAX_EVALUATION_ATTEMPTS),
  resultId: OpaqueIdSchema,
  terminalReason: z.enum([
    "attempts_exhausted",
    "completed",
    "non_retryable_error",
    "not_applicable",
  ]),
  verdict: EvaluationVerdictSchema,
};

export const EvaluationRunResultSchema = z
  .object({
    ...evaluationRunResultShape,
    definitionSha256: Sha256Schema,
    recordedAt: UtcMillisecondTimestampSchema,
    recordedByPrincipalId: OpaqueIdSchema,
    schemaVersion: z.literal(EVALUATION_RUN_RESULT_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      evidenceTimestampOrderKey(value.recordedAt) < evidenceTimestampOrderKey(value.completedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Evaluation result recording cannot precede completion",
        path: ["recordedAt"],
      });
    }
  });

export const EvaluationRunResultReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    evaluationRunId: OpaqueIdSchema,
    resultId: OpaqueIdSchema,
  })
  .strict();

function scopesEqual(
  left: z.infer<typeof EvidenceScopeSchema>,
  right: z.infer<typeof EvidenceScopeSchema>,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

export const EvaluationRunSnapshotSchema = z
  .object({
    observations: z.array(RawObservationSchema).max(MAX_EVALUATION_ATTEMPTS),
    result: EvaluationRunResultSchema.optional(),
    run: EvaluationRunSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const { observations, result, run } = value;
    if (!isStrictlySortedUnique(observations.map(({ observationId }) => observationId))) {
      context.addIssue({
        code: "custom",
        message: "Raw observations must be unique and ordered by observationId",
        path: ["observations"],
      });
    }

    for (const [index, observation] of observations.entries()) {
      const attempt = run.attempts[index];
      if (
        !attempt ||
        observation.attemptSequence !== index ||
        observation.attemptId !== attempt.attemptId ||
        observation.run.evaluationRunId !== run.evaluationRunId ||
        observation.run.definitionSha256 !== run.definitionSha256 ||
        !scopesEqual(observation.scope, run.scope)
      ) {
        context.addIssue({
          code: "custom",
          message: "Observations must be a contiguous exact prefix of the predeclared attempts",
          path: ["observations", index],
        });
        continue;
      }
      if (
        evidenceTimestampOrderKey(observation.startedAt) < evidenceTimestampOrderKey(run.createdAt)
      ) {
        context.addIssue({
          code: "custom",
          message: "An observation cannot start before evaluation-run creation",
          path: ["observations", index, "startedAt"],
        });
      }
      if (
        observation.budgetUsage.elapsedMilliseconds > attempt.budgets.elapsedMilliseconds ||
        observation.budgetUsage.inputBytes > attempt.budgets.inputBytes ||
        observation.budgetUsage.peakMemoryBytes > attempt.budgets.memoryBytes ||
        observation.budgetUsage.outputBytes > attempt.budgets.outputBytes
      ) {
        context.addIssue({
          code: "custom",
          message: "Observation usage cannot exceed its predeclared attempt budget",
          path: ["observations", index, "budgetUsage"],
        });
      }
      const previous = observations[index - 1];
      if (previous) {
        if (
          previous.verdict !== "error" ||
          !run.retryableErrors.includes(previous.error?.code as never)
        ) {
          context.addIssue({
            code: "custom",
            message: "Only a predeclared retryable error may be followed by another attempt",
            path: ["observations", index],
          });
        }
        if (
          evidenceTimestampOrderKey(observation.startedAt) <
          evidenceTimestampOrderKey(previous.completedAt)
        ) {
          context.addIssue({
            code: "custom",
            message: "Evaluation attempts cannot overlap or move backward in time",
            path: ["observations", index, "startedAt"],
          });
        }
      }
    }

    if (!result) return;
    if (evidenceTimestampOrderKey(result.completedAt) < evidenceTimestampOrderKey(run.createdAt)) {
      context.addIssue({
        code: "custom",
        message: "Evaluation-run completion cannot precede run creation",
        path: ["result", "completedAt"],
      });
    }
    if (
      result.evaluationRunId !== run.evaluationRunId ||
      !scopesEqual(result.scope, run.scope) ||
      result.observations.length !== observations.length ||
      result.observations.some(
        (reference, index) =>
          reference.observationId !== observations[index]?.observationId ||
          reference.definitionSha256 !== observations[index]?.definitionSha256,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "The run result must reference the exact ordered observation history",
        path: ["result", "observations"],
      });
    }

    if (run.applicability.result === "not_applicable") {
      if (
        observations.length !== 0 ||
        result.verdict !== "not_applicable" ||
        result.terminalReason !== "not_applicable"
      ) {
        context.addIssue({
          code: "custom",
          message: "A not-applicable run must close without execution observations",
          path: ["result"],
        });
      }
      return;
    }

    const last = observations.at(-1);
    if (!last || result.verdict !== last.verdict) {
      context.addIssue({
        code: "custom",
        message: "An applicable run result must preserve its final raw verdict",
        path: ["result", "verdict"],
      });
      return;
    }
    if (
      evidenceTimestampOrderKey(result.completedAt) < evidenceTimestampOrderKey(last.completedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Run completion cannot precede its final observation",
        path: ["result", "completedAt"],
      });
    }

    if (last.verdict !== "error") {
      if (result.terminalReason !== "completed") {
        context.addIssue({
          code: "custom",
          message: "A decided or abstained run must close as completed",
          path: ["result", "terminalReason"],
        });
      }
      return;
    }

    const retryable = run.retryableErrors.includes(last.error?.code as never);
    const exhausted = observations.length === run.attempts.length;
    if (
      (result.terminalReason === "attempts_exhausted" && (!retryable || !exhausted)) ||
      (result.terminalReason === "non_retryable_error" && retryable) ||
      !["attempts_exhausted", "non_retryable_error"].includes(result.terminalReason)
    ) {
      context.addIssue({
        code: "custom",
        message: "Error completion must distinguish exhausted retries from non-retryable failure",
        path: ["result", "terminalReason"],
      });
    }
  });

export type EvaluationRun = z.infer<typeof EvaluationRunSchema>;
export type EvaluationRunDefinition = z.infer<typeof EvaluationRunDefinitionSchema>;
export type EvaluationRunRejection = z.infer<typeof EvaluationRunRejectionSchema>;
export type EvaluationRunResult = z.infer<typeof EvaluationRunResultSchema>;
export type EvaluationVerdict = z.infer<typeof EvaluationVerdictSchema>;
export type RawObservation = z.infer<typeof RawObservationSchema>;
