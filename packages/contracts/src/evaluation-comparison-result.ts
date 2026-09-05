import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { RegressionFixtureVersionReferenceSchema } from "./dataset.js";
import {
  COMPARISON_METRIC_KINDS,
  COMPARISON_COUNT_METRIC_UNITS,
  ComparisonArtifactAvailabilitySchema,
  ComparisonDefinitionReferenceSchema,
  ComparisonEvidenceSnapshotReferenceSchema,
  type ComparisonExactValue,
  ComparisonExactValueSchema,
  ComparisonUsageSourceSchema,
  ComparisonUsageUnavailableReasonSchema,
  ComparisonVerdictCountsSchema,
  MAX_COMPARISON_ARTIFACTS,
  MAX_COMPARISON_METRICS,
  MAX_COMPARISON_SUBJECT_ASSESSMENTS,
  MAX_COMPARISON_SUBJECT_FIXTURES,
} from "./evaluation-comparison.js";
import { CriterionReferenceSchema } from "./evaluation-criteria.js";
import { EvaluationVerdictSchema } from "./evaluation-run.js";
import { AssuranceSummarySchema } from "./evaluation-source.js";
import { EvidenceScopeSchema, evidenceTimestampOrderKey } from "./evidence.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";

export const COMPARISON_RESULT_SCHEMA_VERSION = "0.5" as const;
export const MAX_COMPARISON_RESULT_REASONS = 32;
export const MAX_COMPARISON_RESULT_TRANSITIONS = 4_096;
export const MAX_COMPARISON_RESULT_DISTRIBUTIONS = MAX_COMPARISON_METRICS * 2;
const MAX_COMPARISON_COUNT = Number.MAX_SAFE_INTEGER;

const SafeComparisonCountSchema = z.number().int().nonnegative().max(MAX_COMPARISON_COUNT);
const SignedComparisonCountSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

function isStrictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function exactDecimalParts(value: string): { integer: bigint; scale: number } {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const integer = BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n);
  return { integer, scale: fraction.length };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function exactFraction(value: ComparisonExactValue): { denominator: bigint; numerator: bigint } {
  if (value.representation === "rational") {
    return { denominator: BigInt(value.denominator), numerator: BigInt(value.numerator) };
  }
  const parts = exactDecimalParts(value.value);
  const denominator = 10n ** BigInt(parts.scale);
  const divisor = greatestCommonDivisor(parts.integer, denominator);
  return { denominator: denominator / divisor, numerator: parts.integer / divisor };
}

function exactDelta(
  baseline: ComparisonExactValue,
  candidate: ComparisonExactValue,
  delta: ComparisonExactValue,
): { matches: boolean; sign: -1 | 0 | 1 } {
  const baselineFraction = exactFraction(baseline);
  const candidateFraction = exactFraction(candidate);
  const deltaFraction = exactFraction(delta);
  const expectedNumerator =
    candidateFraction.numerator * baselineFraction.denominator -
    baselineFraction.numerator * candidateFraction.denominator;
  const expectedDenominator = candidateFraction.denominator * baselineFraction.denominator;
  const suppliedNumerator = deltaFraction.numerator;
  const suppliedDenominator = deltaFraction.denominator;
  const matches =
    expectedNumerator * suppliedDenominator === suppliedNumerator * expectedDenominator;
  return {
    matches,
    sign: suppliedNumerator === 0n ? 0 : suppliedNumerator < 0n ? -1 : 1,
  };
}

function exactCriterionKey(value: z.infer<typeof CriterionReferenceSchema>): string {
  return [
    value.criterionSet.criterionSetId,
    value.criterionSet.criterionSetVersionId,
    value.criterionSet.definitionSha256,
    value.criterionId,
  ].join(":");
}

export const ComparisonMissingCaseReasonSchema = z.enum([
  "fixture_absent",
  "snapshot_omission",
  "source_unavailable",
]);

export const ComparisonInvalidCaseReasonSchema = z.enum([
  "ambiguous_pairing",
  "digest_mismatch",
  "invalid_source_integrity",
  "nonterminal_replay",
  "scope_mismatch",
  "unresolved_lineage",
]);

export const ComparisonCaseSchema = z
  .discriminatedUnion("state", [
    z
      .object({
        baseline: RegressionFixtureVersionReferenceSchema,
        candidate: RegressionFixtureVersionReferenceSchema,
        fixtureId: OpaqueIdSchema,
        state: z.literal("paired"),
      })
      .strict(),
    z
      .object({
        baseline: RegressionFixtureVersionReferenceSchema,
        candidateMissingReason: ComparisonMissingCaseReasonSchema,
        fixtureId: OpaqueIdSchema,
        state: z.literal("baseline_only"),
      })
      .strict(),
    z
      .object({
        baselineMissingReason: ComparisonMissingCaseReasonSchema,
        candidate: RegressionFixtureVersionReferenceSchema,
        fixtureId: OpaqueIdSchema,
        state: z.literal("candidate_only"),
      })
      .strict(),
    z
      .object({
        baseline: RegressionFixtureVersionReferenceSchema.optional(),
        candidate: RegressionFixtureVersionReferenceSchema.optional(),
        fixtureId: OpaqueIdSchema,
        reasons: z
          .array(ComparisonInvalidCaseReasonSchema)
          .min(1)
          .max(ComparisonInvalidCaseReasonSchema.options.length)
          .refine(isStrictlySortedUnique, {
            message: "Invalid-case reasons must be unique and ordered",
          }),
        state: z.literal("invalid"),
      })
      .strict()
      .refine((value) => value.baseline !== undefined || value.candidate !== undefined, {
        message: "An invalid case must retain at least one exact fixture reference",
      }),
  ])
  .superRefine((value, context) => {
    const baseline = "baseline" in value ? value.baseline : undefined;
    const candidate = "candidate" in value ? value.candidate : undefined;
    if (
      (baseline && baseline.fixtureId !== value.fixtureId) ||
      (candidate && candidate.fixtureId !== value.fixtureId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Comparison case references must retain the logical fixture identity",
        path: ["fixtureId"],
      });
    }
  });

export const ComparisonPairingSummarySchema = z
  .object({
    baselineOnlyCount: SafeComparisonCountSchema,
    candidateOnlyCount: SafeComparisonCountSchema,
    invalidCount: SafeComparisonCountSchema,
    pairedCount: SafeComparisonCountSchema,
    requestedCount: SafeComparisonCountSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const reconstructed =
      value.baselineOnlyCount + value.candidateOnlyCount + value.invalidCount + value.pairedCount;
    if (!Number.isSafeInteger(reconstructed) || reconstructed !== value.requestedCount) {
      context.addIssue({
        code: "custom",
        message: "Pairing counts must reconstruct the exact requested count",
        path: ["requestedCount"],
      });
    }
  });

export const ComparisonComparabilityReasonSchema = z.enum([
  "calibration_mismatch",
  "criterion_mismatch",
  "dataset_mismatch",
  "fixture_mismatch",
  "insufficient_paired_coverage",
  "invalid_source_integrity",
  "method_mismatch",
  "missing_source_evidence",
  "population_mismatch",
  "unit_mismatch",
  "unresolved_critical_counterevidence",
  "unsupported_statistical_assumptions",
]);

export const ComparisonComparabilitySchema = z
  .object({
    reasons: z
      .array(ComparisonComparabilityReasonSchema)
      .max(MAX_COMPARISON_RESULT_REASONS)
      .refine(isStrictlySortedUnique, {
        message: "Comparability reasons must be unique and ordered",
      }),
    status: z.enum(["comparable", "incomparable", "partially_comparable"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.status === "comparable" && value.reasons.length !== 0) ||
      (value.status !== "comparable" && value.reasons.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Comparability status and reasons must agree",
        path: ["reasons"],
      });
    }
  });

export const ComparisonMetricUnavailableReasonSchema = z.enum([
  "baseline_missing",
  "candidate_missing",
  "insufficient_observations",
  "invalid_observations",
  "measurement_unavailable",
  "source_over_limit",
]);

const orderedMetricUnavailableReasons = z
  .array(ComparisonMetricUnavailableReasonSchema)
  .min(1)
  .max(ComparisonMetricUnavailableReasonSchema.options.length)
  .refine(isStrictlySortedUnique, {
    message: "Unavailable metric reasons must be unique and ordered",
  });

const orderedMetricIncomparabilityReasons = z
  .array(ComparisonComparabilityReasonSchema)
  .min(1)
  .max(MAX_COMPARISON_RESULT_REASONS)
  .refine(isStrictlySortedUnique, {
    message: "Incomparable metric reasons must be unique and ordered",
  });

export const ComparisonMetricSampleCountsSchema = z
  .object({
    baselineInvalidCount: SafeComparisonCountSchema,
    baselineMissingCount: SafeComparisonCountSchema,
    baselineObservedCount: SafeComparisonCountSchema,
    baselineTotalCount: SafeComparisonCountSchema,
    baselineUnavailableCount: SafeComparisonCountSchema,
    candidateInvalidCount: SafeComparisonCountSchema,
    candidateMissingCount: SafeComparisonCountSchema,
    candidateObservedCount: SafeComparisonCountSchema,
    candidateTotalCount: SafeComparisonCountSchema,
    candidateUnavailableCount: SafeComparisonCountSchema,
    pairedInvalidCount: SafeComparisonCountSchema,
    pairedMissingCount: SafeComparisonCountSchema,
    pairedObservedCount: SafeComparisonCountSchema,
    pairedTotalCount: SafeComparisonCountSchema,
    pairedUnavailableCount: SafeComparisonCountSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.pairedObservedCount > value.baselineObservedCount ||
      value.pairedObservedCount > value.candidateObservedCount
    ) {
      context.addIssue({
        code: "custom",
        message: "Paired observations cannot exceed either role-specific observation count",
        path: ["pairedObservedCount"],
      });
    }
    const baselineTotal =
      value.baselineInvalidCount +
      value.baselineMissingCount +
      value.baselineObservedCount +
      value.baselineUnavailableCount;
    const candidateTotal =
      value.candidateInvalidCount +
      value.candidateMissingCount +
      value.candidateObservedCount +
      value.candidateUnavailableCount;
    const pairedTotal =
      value.pairedInvalidCount +
      value.pairedMissingCount +
      value.pairedObservedCount +
      value.pairedUnavailableCount;
    if (
      !Number.isSafeInteger(baselineTotal) ||
      baselineTotal !== value.baselineTotalCount ||
      !Number.isSafeInteger(candidateTotal) ||
      candidateTotal !== value.candidateTotalCount ||
      !Number.isSafeInteger(pairedTotal) ||
      pairedTotal !== value.pairedTotalCount
    ) {
      context.addIssue({
        code: "custom",
        message: "Metric sample classes must reconstruct every exact denominator",
        path: ["baselineTotalCount"],
      });
    }
    if (
      value.pairedTotalCount > value.baselineTotalCount ||
      value.pairedTotalCount > value.candidateTotalCount
    ) {
      context.addIssue({
        code: "custom",
        message: "The paired metric population cannot exceed either role-specific population",
        path: ["pairedTotalCount"],
      });
    }
    if (
      value.pairedMissingCount > value.baselineMissingCount + value.candidateMissingCount ||
      value.pairedUnavailableCount >
        value.baselineUnavailableCount + value.candidateUnavailableCount ||
      value.pairedInvalidCount > value.baselineInvalidCount + value.candidateInvalidCount
    ) {
      context.addIssue({
        code: "custom",
        message: "Paired non-observation classes require a matching role-specific classification",
        path: ["pairedMissingCount"],
      });
    }
  });

export const ComparisonMetricValueSchema = z.discriminatedUnion("status", [
  z
    .object({
      baseline: ComparisonExactValueSchema,
      candidate: ComparisonExactValueSchema,
      delta: ComparisonExactValueSchema,
      direction: z.enum(["decreased", "increased", "unchanged"]),
      status: z.literal("available"),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.baseline.unit !== value.candidate.unit ||
        value.baseline.unit !== value.delta.unit
      ) {
        context.addIssue({
          code: "custom",
          message: "Available comparison values must use one exact unit",
          path: ["delta", "unit"],
        });
      }
      const derivedDelta = exactDelta(value.baseline, value.candidate, value.delta);
      if (!derivedDelta.matches) {
        context.addIssue({
          code: "custom",
          message: "Metric delta must equal candidate minus baseline exactly",
          path: ["delta", "value"],
        });
      }
      const expectedDirection =
        derivedDelta.sign === 0 ? "unchanged" : derivedDelta.sign < 0 ? "decreased" : "increased";
      if (value.direction !== expectedDirection) {
        context.addIssue({
          code: "custom",
          message: "Metric direction must agree with the canonical signed delta",
          path: ["direction"],
        });
      }
    }),
  z
    .object({
      reasons: orderedMetricUnavailableReasons,
      status: z.literal("unavailable"),
    })
    .strict(),
  z
    .object({
      baseline: ComparisonExactValueSchema.optional(),
      candidate: ComparisonExactValueSchema.optional(),
      reasons: orderedMetricIncomparabilityReasons,
      status: z.literal("incomparable"),
    })
    .strict(),
]);

const ComparisonMetricKindSchema = z.enum(COMPARISON_METRIC_KINDS);

export const ComparisonUsageMetricRoleProvenanceSchema = z
  .object({
    completeCount: SafeComparisonCountSchema,
    observedSources: z
      .array(ComparisonUsageSourceSchema)
      .max(ComparisonUsageSourceSchema.options.length)
      .refine(isStrictlySortedUnique, {
        message: "Usage observation sources must be unique and ordered",
      }),
    partialCount: SafeComparisonCountSchema,
    unavailableCount: SafeComparisonCountSchema,
    unavailableReasons: z
      .array(ComparisonUsageUnavailableReasonSchema)
      .max(ComparisonUsageUnavailableReasonSchema.options.length)
      .refine(isStrictlySortedUnique, {
        message: "Usage unavailability reasons must be unique and ordered",
      }),
  })
  .strict()
  .superRefine((value, context) => {
    const hasObservedUsage = value.completeCount > 0 || value.partialCount > 0;
    const hasUnavailableUsage = value.partialCount > 0 || value.unavailableCount > 0;
    if (!Number.isSafeInteger(value.completeCount + value.partialCount + value.unavailableCount)) {
      context.addIssue({
        code: "custom",
        message: "Usage provenance counts must remain within safe integer bounds",
        path: ["completeCount"],
      });
    }
    if (hasObservedUsage !== value.observedSources.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Observed usage requires its exact measurement source set",
        path: ["observedSources"],
      });
    }
    if (hasUnavailableUsage !== value.unavailableReasons.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Partial or unavailable usage requires its exact unavailability reasons",
        path: ["unavailableReasons"],
      });
    }
  });

export const ComparisonUsageMetricProvenanceSchema = z
  .object({
    baseline: ComparisonUsageMetricRoleProvenanceSchema,
    candidate: ComparisonUsageMetricRoleProvenanceSchema,
  })
  .strict();

export const ComparisonMetricResultSchema = z
  .object({
    kind: ComparisonMetricKindSchema,
    metricId: OpaqueIdSchema,
    samples: ComparisonMetricSampleCountsSchema,
    unit: AssuranceSummarySchema,
    usageProvenance: ComparisonUsageMetricProvenanceSchema.optional(),
    value: ComparisonMetricValueSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const canonicalCountUnit =
      COMPARISON_COUNT_METRIC_UNITS[value.kind as keyof typeof COMPARISON_COUNT_METRIC_UNITS];
    if (canonicalCountUnit !== undefined && value.unit !== canonicalCountUnit) {
      context.addIssue({
        code: "custom",
        message: "Count-like metric results must retain their canonical unit",
        path: ["unit"],
      });
    }
    const exactValues: readonly {
      readonly field: "baseline" | "candidate" | "delta";
      readonly value: ComparisonExactValue;
    }[] =
      value.value.status === "available"
        ? [
            { field: "baseline", value: value.value.baseline },
            { field: "candidate", value: value.value.candidate },
            { field: "delta", value: value.value.delta },
          ]
        : value.value.status === "incomparable"
          ? [
              ...(value.value.baseline
                ? [{ field: "baseline" as const, value: value.value.baseline }]
                : []),
              ...(value.value.candidate
                ? [{ field: "candidate" as const, value: value.value.candidate }]
                : []),
            ]
          : [];
    for (const exactValue of exactValues) {
      if (exactValue.value.unit !== value.unit) {
        context.addIssue({
          code: "custom",
          message: "Metric result values must agree with the declared result unit",
          path: ["value", exactValue.field, "unit"],
        });
      }
    }
    if (value.value.status === "available" && value.samples.pairedObservedCount === 0) {
      context.addIssue({
        code: "custom",
        message: "An available paired metric requires at least one paired observation",
        path: ["samples", "pairedObservedCount"],
      });
    }
    if (value.kind === "replay_usage" && !value.usageProvenance) {
      context.addIssue({
        code: "custom",
        message: "Replay usage metrics must retain role-specific measurement provenance",
        path: ["usageProvenance"],
      });
    }
    if (value.kind !== "replay_usage" && value.usageProvenance) {
      context.addIssue({
        code: "custom",
        message: "Usage provenance belongs only to replay usage metrics",
        path: ["usageProvenance"],
      });
    }
    if (value.usageProvenance) {
      for (const role of ["baseline", "candidate"] as const) {
        const provenance = value.usageProvenance[role];
        if (
          provenance.completeCount !== value.samples[`${role}ObservedCount`] ||
          provenance.partialCount + provenance.unavailableCount !==
            value.samples[`${role}UnavailableCount`]
        ) {
          context.addIssue({
            code: "custom",
            message: "Usage provenance classes must reconstruct the role-specific metric samples",
            path: ["usageProvenance", role],
          });
        }
      }
    }
  });

export const ComparisonVerdictTransitionSchema = z
  .object({
    baseline: EvaluationVerdictSchema,
    candidate: EvaluationVerdictSchema,
    count: z.number().int().positive().max(MAX_COMPARISON_COUNT),
    criterion: CriterionReferenceSchema,
  })
  .strict();

export const ComparisonVerdictMarginalSchema = z
  .object({
    baseline: ComparisonVerdictCountsSchema,
    candidate: ComparisonVerdictCountsSchema,
    criterion: CriterionReferenceSchema,
    pairedCount: SafeComparisonCountSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.pairedCount <= value.baseline.total && value.pairedCount <= value.candidate.total,
    { message: "Paired verdict count cannot exceed either complete marginal" },
  );

export const ComparisonDistributionMethodSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.enum(["maximum", "mean", "median", "minimum", "sum"]),
      methodVersion: z.literal("1.0.0"),
    })
    .strict(),
  z
    .object({
      basisPoints: z.number().int().min(1).max(10_000),
      method: z.literal("nearest_rank_quantile"),
      methodVersion: z.literal("1.0.0"),
    })
    .strict(),
]);

export const ComparisonDistributionSummarySchema = z
  .object({
    invalidCount: SafeComparisonCountSchema,
    method: ComparisonDistributionMethodSchema,
    metricId: OpaqueIdSchema,
    missingCount: SafeComparisonCountSchema,
    observedCount: z.number().int().positive().max(MAX_COMPARISON_COUNT),
    role: z.enum(["baseline", "candidate"]),
    totalCount: z.number().int().positive().max(MAX_COMPARISON_COUNT),
    unavailableCount: SafeComparisonCountSchema,
    value: ComparisonExactValueSchema,
  })
  .strict()
  .refine(
    (value) =>
      Number.isSafeInteger(
        value.invalidCount + value.missingCount + value.observedCount + value.unavailableCount,
      ) &&
      value.invalidCount + value.missingCount + value.observedCount + value.unavailableCount ===
        value.totalCount,
    {
      message: "Distribution sample classes must reconstruct the exact denominator",
      path: ["totalCount"],
    },
  );

function exactArtifactReferenceEqual(
  left: z.infer<typeof ArtifactContentReferenceSchema>,
  right: z.infer<typeof ArtifactContentReferenceSchema>,
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

export const ComparisonArtifactChangeSchema = z
  .object({
    artifactId: OpaqueIdSchema,
    baseline: ArtifactContentReferenceSchema.optional(),
    baselineAvailability: ComparisonArtifactAvailabilitySchema.optional(),
    candidate: ArtifactContentReferenceSchema.optional(),
    candidateAvailability: ComparisonArtifactAvailabilitySchema.optional(),
    status: z.enum(["added", "metadata_changed", "removed", "unchanged", "unavailable"]),
  })
  .strict()
  .superRefine((value, context) => {
    const hasBaseline = value.baseline !== undefined;
    const hasCandidate = value.candidate !== undefined;
    const hasBaselineAvailability = value.baselineAvailability !== undefined;
    const hasCandidateAvailability = value.candidateAvailability !== undefined;
    if (hasBaseline !== hasBaselineAvailability || hasCandidate !== hasCandidateAvailability) {
      context.addIssue({
        code: "custom",
        message: "Artifact references must retain their exact role-specific availability",
        path: [
          hasBaseline !== hasBaselineAvailability
            ? "baselineAvailability"
            : "candidateAvailability",
        ],
      });
    }
    const baselineAvailable = value.baselineAvailability === "available";
    const candidateAvailable = value.candidateAvailability === "available";
    const hasUnavailableRole =
      (hasBaselineAvailability && !baselineAvailable) ||
      (hasCandidateAvailability && !candidateAvailable);
    const validShape =
      (value.status === "added" && !hasBaseline && hasCandidate && candidateAvailable) ||
      (value.status === "removed" && hasBaseline && baselineAvailable && !hasCandidate) ||
      (["metadata_changed", "unchanged"].includes(value.status) &&
        hasBaseline &&
        baselineAvailable &&
        hasCandidate &&
        candidateAvailable) ||
      (value.status === "unavailable" && (hasBaseline || hasCandidate) && hasUnavailableRole);
    if (!validShape) {
      context.addIssue({
        code: "custom",
        message: "Artifact change status must agree with retained role references and availability",
        path: ["status"],
      });
    }
    if (
      (value.baseline && value.baseline.artifactId !== value.artifactId) ||
      (value.candidate && value.candidate.artifactId !== value.artifactId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Artifact change references must retain the declared artifact identity",
        path: ["artifactId"],
      });
    }
    if (value.baseline && value.candidate) {
      const referencesEqual = exactArtifactReferenceEqual(value.baseline, value.candidate);
      if (
        (value.status === "unchanged" && !referencesEqual) ||
        (value.status === "metadata_changed" && referencesEqual)
      ) {
        context.addIssue({
          code: "custom",
          message: "Artifact change status must agree with the exact retained references",
          path: ["status"],
        });
      }
    }
  });

export const ComparisonCountDeltaSchema = z
  .object({
    baseline: SafeComparisonCountSchema,
    candidate: SafeComparisonCountSchema,
    delta: SignedComparisonCountSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const expected = value.candidate - value.baseline;
    if (!Number.isSafeInteger(expected) || value.delta !== expected) {
      context.addIssue({
        code: "custom",
        message: "Count delta must equal candidate minus baseline exactly",
        path: ["delta"],
      });
    }
  });

export const ComparisonSafetyCountSchema = z
  .object({
    counts: ComparisonCountDeltaSchema,
    kind: z.enum(["guardrail_check", "replay_safety_intervention", "uncertain_side_effect"]),
  })
  .strict();

const comparisonResultDefinitionShape = {
  artifactChanges: z
    .array(ComparisonArtifactChangeSchema)
    .max(MAX_COMPARISON_ARTIFACTS)
    .refine((values) => isStrictlySortedUnique(values.map(({ artifactId }) => artifactId)), {
      message: "Artifact changes must be unique and ordered by artifactId",
    }),
  baselineSnapshot: ComparisonEvidenceSnapshotReferenceSchema,
  candidateSnapshot: ComparisonEvidenceSnapshotReferenceSchema,
  cases: z
    .array(ComparisonCaseSchema)
    .min(1)
    .max(MAX_COMPARISON_SUBJECT_FIXTURES)
    .refine((values) => isStrictlySortedUnique(values.map(({ fixtureId }) => fixtureId)), {
      message: "Comparison cases must be unique and ordered by logical fixture identity",
    }),
  comparability: ComparisonComparabilitySchema,
  comparison: ComparisonDefinitionReferenceSchema,
  distributions: z
    .array(ComparisonDistributionSummarySchema)
    .max(MAX_COMPARISON_RESULT_DISTRIBUTIONS)
    .refine(
      (values) => isStrictlySortedUnique(values.map(({ metricId, role }) => `${metricId}:${role}`)),
      { message: "Distribution summaries must be unique and ordered by metric and role" },
    ),
  knownLimitations: z.array(AssuranceSummarySchema).max(64).refine(isStrictlySortedUnique, {
    message: "Comparison result limitations must be unique and ordered",
  }),
  latestSourceCutoff: UtcMillisecondTimestampSchema,
  metricResults: z
    .array(ComparisonMetricResultSchema)
    .min(1)
    .max(MAX_COMPARISON_METRICS)
    .refine((values) => isStrictlySortedUnique(values.map(({ metricId }) => metricId)), {
      message: "Metric results must be unique and ordered by metricId",
    }),
  pairing: ComparisonPairingSummarySchema,
  resultId: OpaqueIdSchema,
  safetyCounts: z
    .array(ComparisonSafetyCountSchema)
    .max(3)
    .refine((values) => isStrictlySortedUnique(values.map(({ kind }) => kind)), {
      message: "Safety counts must be unique and ordered by kind",
    }),
  verdictTransitions: z
    .array(ComparisonVerdictTransitionSchema)
    .max(MAX_COMPARISON_RESULT_TRANSITIONS)
    .refine(
      (values) =>
        isStrictlySortedUnique(
          values.map(
            ({ baseline, candidate, criterion }) =>
              `${exactCriterionKey(criterion)}:${baseline}:${candidate}`,
          ),
        ),
      { message: "Verdict transitions must be unique and ordered" },
    ),
  verdictMarginals: z
    .array(ComparisonVerdictMarginalSchema)
    .max(MAX_COMPARISON_SUBJECT_ASSESSMENTS)
    .refine(
      (values) =>
        isStrictlySortedUnique(values.map(({ criterion }) => exactCriterionKey(criterion))),
      { message: "Verdict marginals must be unique and ordered by exact criterion" },
    ),
};

type ComparisonResultDefinitionShape = z.infer<z.ZodObject<typeof comparisonResultDefinitionShape>>;

function refineComparisonResult(
  value: ComparisonResultDefinitionShape,
  context: z.RefinementCtx,
): void {
  if (value.baselineSnapshot.role !== "baseline") {
    context.addIssue({
      code: "custom",
      message: "The baseline snapshot reference must have the baseline role",
      path: ["baselineSnapshot", "role"],
    });
  }
  if (value.candidateSnapshot.role !== "candidate") {
    context.addIssue({
      code: "custom",
      message: "The candidate snapshot reference must have the candidate role",
      path: ["candidateSnapshot", "role"],
    });
  }
  if (value.baselineSnapshot.snapshotId === value.candidateSnapshot.snapshotId) {
    context.addIssue({
      code: "custom",
      message: "Baseline and candidate must reference distinct evidence snapshots",
      path: ["candidateSnapshot", "snapshotId"],
    });
  }
  const actual = {
    baselineOnlyCount: value.cases.filter(({ state }) => state === "baseline_only").length,
    candidateOnlyCount: value.cases.filter(({ state }) => state === "candidate_only").length,
    invalidCount: value.cases.filter(({ state }) => state === "invalid").length,
    pairedCount: value.cases.filter(({ state }) => state === "paired").length,
    requestedCount: value.cases.length,
  };
  const baselinePopulationCount = value.cases.filter(
    (entry) => "baseline" in entry && entry.baseline !== undefined,
  ).length;
  const candidatePopulationCount = value.cases.filter(
    (entry) => "candidate" in entry && entry.candidate !== undefined,
  ).length;
  for (const [key, count] of Object.entries(actual)) {
    if (value.pairing[key as keyof typeof actual] !== count) {
      context.addIssue({
        code: "custom",
        message: "Pairing summary must reconstruct the exact case list",
        path: ["pairing", key],
      });
    }
  }
  if (
    value.comparability.status === "comparable" &&
    (actual.baselineOnlyCount !== 0 || actual.candidateOnlyCount !== 0 || actual.invalidCount !== 0)
  ) {
    context.addIssue({
      code: "custom",
      message: "A fully comparable result cannot hide unpaired or invalid cases",
      path: ["comparability", "status"],
    });
  }
  value.metricResults.forEach((metric, index) => {
    if (
      metric.samples.baselineTotalCount > baselinePopulationCount ||
      metric.samples.candidateTotalCount > candidatePopulationCount ||
      metric.samples.pairedTotalCount > actual.pairedCount
    ) {
      context.addIssue({
        code: "custom",
        message: "Metric populations cannot exceed the retained exact comparison cases",
        path: ["metricResults", index, "samples"],
      });
    }
  });
  value.distributions.forEach((distribution, index) => {
    const rolePopulationCount =
      distribution.role === "baseline" ? baselinePopulationCount : candidatePopulationCount;
    if (distribution.totalCount > rolePopulationCount) {
      context.addIssue({
        code: "custom",
        message: "Distribution populations cannot exceed the retained role-specific cases",
        path: ["distributions", index, "totalCount"],
      });
    }
  });
  const marginalPairedCounts = new Map(
    value.verdictMarginals.map(({ criterion, pairedCount }) => [
      exactCriterionKey(criterion),
      pairedCount,
    ]),
  );
  const transitionCounts = new Map<string, number>();
  for (const transition of value.verdictTransitions) {
    const key = exactCriterionKey(transition.criterion);
    transitionCounts.set(key, (transitionCounts.get(key) ?? 0) + transition.count);
  }
  for (const [criterion, transitionCount] of transitionCounts) {
    if (marginalPairedCounts.get(criterion) !== transitionCount) {
      context.addIssue({
        code: "custom",
        message: "Verdict transitions must reconstruct the exact paired marginal count",
        path: ["verdictTransitions"],
      });
    }
  }
  for (const [criterion, pairedCount] of marginalPairedCounts) {
    if ((transitionCounts.get(criterion) ?? 0) !== pairedCount) {
      context.addIssue({
        code: "custom",
        message: "Every verdict marginal must have complete paired transitions",
        path: ["verdictMarginals"],
      });
    }
  }
}

export const ComparisonResultDefinitionSchema = z
  .object(comparisonResultDefinitionShape)
  .strict()
  .superRefine(refineComparisonResult);

export const ComparisonResultSchema = z
  .object({
    ...comparisonResultDefinitionShape,
    createdAt: UtcMillisecondTimestampSchema,
    createdByPrincipalId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
    schemaVersion: z.literal(COMPARISON_RESULT_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    refineComparisonResult(value, context);
    if (
      evidenceTimestampOrderKey(value.createdAt) <
      evidenceTimestampOrderKey(value.latestSourceCutoff)
    ) {
      context.addIssue({
        code: "custom",
        message: "Comparison result creation cannot precede its latest source cutoff",
        path: ["createdAt"],
      });
    }
  });

export const DeriveComparisonResultRequestSchema = z
  .object({
    baselineSnapshot: ComparisonEvidenceSnapshotReferenceSchema,
    candidateSnapshot: ComparisonEvidenceSnapshotReferenceSchema,
    comparison: ComparisonDefinitionReferenceSchema,
    resultId: OpaqueIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.baselineSnapshot.role !== "baseline") {
      context.addIssue({
        code: "custom",
        message: "The baseline snapshot reference must have the baseline role",
        path: ["baselineSnapshot", "role"],
      });
    }
    if (value.candidateSnapshot.role !== "candidate") {
      context.addIssue({
        code: "custom",
        message: "The candidate snapshot reference must have the candidate role",
        path: ["candidateSnapshot", "role"],
      });
    }
    if (value.baselineSnapshot.snapshotId === value.candidateSnapshot.snapshotId) {
      context.addIssue({
        code: "custom",
        message: "Baseline and candidate must reference distinct evidence snapshots",
        path: ["candidateSnapshot", "snapshotId"],
      });
    }
  });

export type ComparisonArtifactChange = z.infer<typeof ComparisonArtifactChangeSchema>;
export type ComparisonCase = z.infer<typeof ComparisonCaseSchema>;
export type ComparisonComparability = z.infer<typeof ComparisonComparabilitySchema>;
export type ComparisonDistributionSummary = z.infer<typeof ComparisonDistributionSummarySchema>;
export type ComparisonMetricResult = z.infer<typeof ComparisonMetricResultSchema>;
export type ComparisonSafetyCount = z.infer<typeof ComparisonSafetyCountSchema>;
export type ComparisonUsageMetricProvenance = z.infer<typeof ComparisonUsageMetricProvenanceSchema>;
export type ComparisonResult = z.infer<typeof ComparisonResultSchema>;
export type ComparisonResultDefinition = z.infer<typeof ComparisonResultDefinitionSchema>;
export type ComparisonVerdictMarginal = z.infer<typeof ComparisonVerdictMarginalSchema>;
export type DeriveComparisonResultRequest = z.infer<typeof DeriveComparisonResultRequestSchema>;
