import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import {
  CriterionReferenceSchema,
  CriterionVersionSelectorSchema,
  EvaluationRiskTierSchema,
} from "./evaluation-criteria.js";
import { EvaluationDatasetVersionReferenceSchema } from "./evaluation-run.js";
import { QualificationReportReferenceSchema } from "./evaluation-spec.js";
import { EvidenceScopeSchema, evidenceTimestampOrderKey } from "./evidence.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";
import { AssuranceRationaleSchema, AssuranceSummarySchema } from "./evaluation-source.js";

export const MODEL_EVALUATOR_PROFILE_SCHEMA_VERSION = "0.1" as const;
export const INDEPENDENCE_DECLARATION_SCHEMA_VERSION = "0.1" as const;
export const CALIBRATION_REPORT_SCHEMA_VERSION = "0.1" as const;
export const MAX_CALIBRATION_BINS = 100;
export const MAX_SELECTIVE_RISK_POINTS = 100;
export const MAX_MODEL_PROFILE_PROMPTS = 5;
export const MAX_MODEL_PROFILE_TOOL_CONTRACTS = 16;

function isStrictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function exactArtifactKey(reference: z.infer<typeof ArtifactContentReferenceSchema>): string {
  return `${reference.artifactId}:${reference.sha256}`;
}

function exactArtifacts(maximum: number, label: string) {
  return z
    .array(ArtifactContentReferenceSchema)
    .max(maximum)
    .refine((references) => isStrictlySortedUnique(references.map(exactArtifactKey)), {
      message: `${label} must be unique and ordered by exact artifact reference`,
    });
}

function sortedUniqueText(maximum: number, label: string) {
  return z
    .array(AssuranceSummarySchema)
    .max(maximum)
    .refine(isStrictlySortedUnique, {
      message: `${label} must be unique and ordered`,
    });
}

export const ModelEvaluatorSelectorSchema = z
  .object({
    evaluatorId: OpaqueIdSchema,
    evaluatorVersionId: OpaqueIdSchema,
  })
  .strict();

export const ModelEvaluatorProfileReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    modelProfileId: OpaqueIdSchema,
    modelProfileVersionId: OpaqueIdSchema,
  })
  .strict();

export const ModelEvaluatorProfilePredecessorSchema = z
  .object({
    definitionSha256: Sha256Schema,
    modelProfileId: OpaqueIdSchema,
    modelProfileVersionId: OpaqueIdSchema,
  })
  .strict();

export const ModelResolutionSchema = z.discriminatedUnion("status", [
  z
    .object({
      resolutionEvidence: ArtifactContentReferenceSchema,
      resolvedModelVersion: AssuranceSummarySchema,
      status: z.literal("exact"),
    })
    .strict(),
  z
    .object({
      limitation: AssuranceRationaleSchema,
      status: z.literal("provider_alias_only"),
    })
    .strict(),
]);

export const ModelProviderDeclarationSchema = z
  .object({
    adapterId: OpaqueIdSchema,
    adapterVersionId: OpaqueIdSchema,
    baseModelFamily: AssuranceSummarySchema,
    fineTuneLineage: sortedUniqueText(32, "Fine-tune lineage"),
    modelResolution: ModelResolutionSchema,
    providerId: OpaqueIdSchema,
    providerModelId: AssuranceSummarySchema,
    trainingDataRelationship: z.enum(["declared_distinct", "declared_shared", "unknown"]),
  })
  .strict();

export const ModelPromptPurposeSchema = z.enum([
  "counteranalysis",
  "output_repair",
  "rubric",
  "system",
  "task",
]);

export const ModelPromptTemplateSchema = z
  .object({
    purpose: ModelPromptPurposeSchema,
    template: ArtifactContentReferenceSchema,
  })
  .strict();

export const ModelSamplingPolicySchema = z
  .object({
    maximumOutputTokens: z.number().int().positive().max(1_000_000),
    seed: z.discriminatedUnion("status", [
      z.object({ status: z.literal("not_supported") }).strict(),
      z
        .object({
          status: z.literal("fixed"),
          value: z.number().int().nonnegative().max(4_294_967_295),
        })
        .strict(),
    ]),
    temperatureMilli: z.number().int().min(0).max(2_000),
    topPBasisPoints: z.number().int().min(1).max(10_000),
  })
  .strict();

export const ModelExecutionBudgetSchema = z
  .object({
    elapsedMilliseconds: z.number().int().positive().max(3_600_000),
    inputBytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
    inputTokens: z.number().int().positive().max(4_000_000),
    maximumCostMicrousd: z.number().int().nonnegative().max(1_000_000_000),
    outputBytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
    outputTokens: z.number().int().positive().max(1_000_000),
    requests: z.number().int().positive().max(128),
  })
  .strict();

export const ModelDataPolicySchema = z
  .object({
    artifactPlaintext: z.enum(["denied", "selected_evidence_only"]),
    dataEgress: z.enum(["metadata_only", "selected_evidence"]),
    geographicRegions: sortedUniqueText(16, "Provider geographic regions"),
    logging: z.enum(["disabled", "provider_declared_metadata_only"]),
    network: z.literal("registered_provider_only"),
    providerRetention: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("zero_retention") }).strict(),
      z
        .object({
          maximumDays: z.number().int().positive().max(365),
          mode: z.literal("declared_bounded"),
        })
        .strict(),
    ]),
    redirects: z.literal("denied"),
    toolRequests: z.literal("record_only"),
  })
  .strict();

const modelEvaluatorProfileDefinitionShape = {
  budgets: ModelExecutionBudgetSchema,
  changeRationale: AssuranceRationaleSchema,
  dataPolicy: ModelDataPolicySchema,
  evaluator: ModelEvaluatorSelectorSchema,
  knownLimitations: sortedUniqueText(64, "Model evaluator limitations"),
  locale: z.string().regex(/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/),
  malformedOutputPolicy: z.literal("error"),
  modelProfileId: OpaqueIdSchema,
  modelProfileVersionId: OpaqueIdSchema,
  outputSchema: ArtifactContentReferenceSchema,
  predecessor: ModelEvaluatorProfilePredecessorSchema.optional(),
  prompts: z
    .array(ModelPromptTemplateSchema)
    .min(4)
    .max(MAX_MODEL_PROFILE_PROMPTS)
    .refine((prompts) => isStrictlySortedUnique(prompts.map(({ purpose }) => purpose)), {
      message: "Model prompts must be unique and ordered by purpose",
    }),
  provider: ModelProviderDeclarationSchema,
  reproducibility: z.enum(["best_effort", "bounded"]),
  riskTiers: z
    .array(z.enum(["high", "low", "medium"]))
    .min(1)
    .max(3)
    .refine(isStrictlySortedUnique, {
      message: "Model evaluator risk tiers must be unique and ordered",
    }),
  sampling: ModelSamplingPolicySchema,
  supportedCriteria: z
    .array(CriterionVersionSelectorSchema)
    .min(1)
    .max(100)
    .refine(
      (selectors) =>
        isStrictlySortedUnique(
          selectors.map(
            ({ criterionId, criterionSetId, criterionSetVersionId }) =>
              `${criterionSetId}:${criterionSetVersionId}:${criterionId}`,
          ),
        ),
      { message: "Model evaluator criteria must be unique and ordered" },
    ),
  toolContracts: exactArtifacts(MAX_MODEL_PROFILE_TOOL_CONTRACTS, "Model tool contracts"),
  validFrom: UtcMillisecondTimestampSchema,
  validUntil: UtcMillisecondTimestampSchema,
};

function refineModelEvaluatorProfile(
  value: {
    readonly modelProfileId: string;
    readonly modelProfileVersionId: string;
    readonly predecessor?:
      | {
          readonly modelProfileId: string;
          readonly modelProfileVersionId: string;
        }
      | undefined;
    readonly prompts: readonly { readonly purpose: z.infer<typeof ModelPromptPurposeSchema> }[];
    readonly validFrom: string;
    readonly validUntil: string;
  },
  context: z.RefinementCtx,
): void {
  const purposes = new Set(value.prompts.map(({ purpose }) => purpose));
  for (const purpose of ["counteranalysis", "rubric", "system", "task"] as const) {
    if (!purposes.has(purpose)) {
      context.addIssue({
        code: "custom",
        message: `Model evaluator profile requires a ${purpose} prompt`,
        path: ["prompts"],
      });
    }
  }
  if (evidenceTimestampOrderKey(value.validUntil) <= evidenceTimestampOrderKey(value.validFrom)) {
    context.addIssue({
      code: "custom",
      message: "Model evaluator profile validity must have a positive interval",
      path: ["validUntil"],
    });
  }
  if (!value.predecessor) return;
  if (value.predecessor.modelProfileId !== value.modelProfileId) {
    context.addIssue({
      code: "custom",
      message: "A model evaluator predecessor must retain the logical modelProfileId",
      path: ["predecessor", "modelProfileId"],
    });
  }
  if (value.predecessor.modelProfileVersionId === value.modelProfileVersionId) {
    context.addIssue({
      code: "custom",
      message: "A model evaluator profile cannot name itself as predecessor",
      path: ["predecessor", "modelProfileVersionId"],
    });
  }
}

export const ModelEvaluatorProfileDefinitionSchema = z
  .object(modelEvaluatorProfileDefinitionShape)
  .strict()
  .superRefine(refineModelEvaluatorProfile);

export const ModelEvaluatorProfileSchema = z
  .object({
    ...modelEvaluatorProfileDefinitionShape,
    definitionSha256: Sha256Schema,
    publishedAt: UtcMillisecondTimestampSchema,
    publishedByPrincipalId: OpaqueIdSchema,
    schemaVersion: z.literal(MODEL_EVALUATOR_PROFILE_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineModelEvaluatorProfile);

export type ModelEvaluatorSelector = z.infer<typeof ModelEvaluatorSelectorSchema>;
export type ModelEvaluatorProfileReference = z.infer<typeof ModelEvaluatorProfileReferenceSchema>;
export type ModelEvaluatorProfileDefinition = z.infer<typeof ModelEvaluatorProfileDefinitionSchema>;
export type ModelEvaluatorProfile = z.infer<typeof ModelEvaluatorProfileSchema>;

export const IndependenceDeclarationReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    independenceDeclarationId: OpaqueIdSchema,
  })
  .strict();

export const MaterialLineageDimensionSchema = z.discriminatedUnion("status", [
  z
    .object({
      identifiers: sortedUniqueText(32, "Material lineage identifiers").min(1),
      status: z.literal("declared"),
    })
    .strict(),
  z
    .object({
      reason: AssuranceRationaleSchema,
      status: z.literal("unknown"),
    })
    .strict(),
]);

export const IndependenceSubjectSchema = z
  .object({
    evaluator: z
      .object({
        definitionSha256: Sha256Schema,
        evaluatorId: OpaqueIdSchema,
        evaluatorVersionId: OpaqueIdSchema,
      })
      .strict(),
    modelProfile: ModelEvaluatorProfileReferenceSchema,
  })
  .strict();

const independenceDeclarationDefinitionShape = {
  declaredConflicts: sortedUniqueText(32, "Declared independence conflicts"),
  dimensions: z
    .object({
      baseModelFamilies: MaterialLineageDimensionSchema,
      criterionAuthors: MaterialLineageDimensionSchema,
      evaluatorDevelopers: MaterialLineageDimensionSchema,
      evaluatorImplementations: MaterialLineageDimensionSchema,
      fineTuneLineage: MaterialLineageDimensionSchema,
      labelSources: MaterialLineageDimensionSchema,
      operatingOrganizations: MaterialLineageDimensionSchema,
      promptAuthors: MaterialLineageDimensionSchema,
      providers: MaterialLineageDimensionSchema,
      sharedInfrastructure: MaterialLineageDimensionSchema,
    })
    .strict(),
  independenceDeclarationId: OpaqueIdSchema,
  knownLimitations: sortedUniqueText(32, "Independence declaration limitations"),
  predecessor: IndependenceDeclarationReferenceSchema.optional(),
  reviewBasis: exactArtifacts(16, "Independence review basis").min(1),
  reviewStatus: z.enum(["rejected", "unverifiable", "verified"]),
  reviewedAt: UtcMillisecondTimestampSchema,
  reviewedByPrincipalId: OpaqueIdSchema,
  subject: IndependenceSubjectSchema,
  validFrom: UtcMillisecondTimestampSchema,
  validUntil: UtcMillisecondTimestampSchema,
};

function refineIndependenceDeclaration(
  value: {
    readonly dimensions: Record<string, { readonly status: "declared" | "unknown" }>;
    readonly independenceDeclarationId: string;
    readonly predecessor?: { readonly independenceDeclarationId: string } | undefined;
    readonly reviewStatus: "rejected" | "unverifiable" | "verified";
    readonly reviewedAt: string;
    readonly validFrom: string;
    readonly validUntil: string;
  },
  context: z.RefinementCtx,
): void {
  const hasUnknown = Object.values(value.dimensions).some(({ status }) => status === "unknown");
  if (value.reviewStatus === "verified" && hasUnknown) {
    context.addIssue({
      code: "custom",
      message: "A verified independence declaration cannot contain unknown material lineage",
      path: ["reviewStatus"],
    });
  }
  if (value.reviewStatus === "unverifiable" && !hasUnknown) {
    context.addIssue({
      code: "custom",
      message: "An unverifiable independence declaration requires unknown material lineage",
      path: ["reviewStatus"],
    });
  }
  if (evidenceTimestampOrderKey(value.validFrom) < evidenceTimestampOrderKey(value.reviewedAt)) {
    context.addIssue({
      code: "custom",
      message: "Independence validity cannot begin before review",
      path: ["validFrom"],
    });
  }
  if (evidenceTimestampOrderKey(value.validUntil) <= evidenceTimestampOrderKey(value.validFrom)) {
    context.addIssue({
      code: "custom",
      message: "Independence validity must have a positive interval",
      path: ["validUntil"],
    });
  }
  if (value.predecessor?.independenceDeclarationId === value.independenceDeclarationId) {
    context.addIssue({
      code: "custom",
      message: "An independence declaration cannot name itself as predecessor",
      path: ["predecessor", "independenceDeclarationId"],
    });
  }
}

export const IndependenceDeclarationDefinitionSchema = z
  .object(independenceDeclarationDefinitionShape)
  .strict()
  .superRefine(refineIndependenceDeclaration);

export const IndependenceDeclarationSchema = z
  .object({
    ...independenceDeclarationDefinitionShape,
    definitionSha256: Sha256Schema,
    recordedAt: UtcMillisecondTimestampSchema,
    schemaVersion: z.literal(INDEPENDENCE_DECLARATION_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineIndependenceDeclaration);

export type IndependenceDeclarationReference = z.infer<
  typeof IndependenceDeclarationReferenceSchema
>;
export type IndependenceDeclarationDefinition = z.infer<
  typeof IndependenceDeclarationDefinitionSchema
>;
export type IndependenceDeclaration = z.infer<typeof IndependenceDeclarationSchema>;

const CalibrationCountSchema = z.number().int().nonnegative().max(10_000_000);
const UnitIntervalDecimalSchema = z.string().regex(/^(?:0(?:\.[0-9]{1,18})?|1(?:\.0{1,18})?)$/);
const NonnegativeDecimalSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/);

export const CalibrationReportReferenceSchema = z
  .object({
    calibrationReportId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
  })
  .strict();

export const CalibrationMethodSchema = z
  .object({
    configurationSha256: Sha256Schema,
    implementationSha256: Sha256Schema,
    kind: z.enum(["histogram_binning", "isotonic", "platt", "temperature_scaling"]),
    methodVersion: AssuranceSummarySchema,
  })
  .strict();

export const CalibrationReliabilityBinSchema = z
  .object({
    lowerBoundBasisPoints: z.number().int().min(0).max(9_999),
    meanPredictedProbability: z.discriminatedUnion("status", [
      z.object({ reason: z.literal("empty_bin"), status: z.literal("unavailable") }).strict(),
      z
        .object({
          status: z.literal("available"),
          value: UnitIntervalDecimalSchema,
        })
        .strict(),
    ]),
    observedPositiveFrequency: z.discriminatedUnion("status", [
      z.object({ reason: z.literal("empty_bin"), status: z.literal("unavailable") }).strict(),
      z
        .object({
          status: z.literal("available"),
          value: UnitIntervalDecimalSchema,
        })
        .strict(),
    ]),
    positiveCount: CalibrationCountSchema,
    sampleCount: CalibrationCountSchema,
    upperBoundBasisPoints: z.number().int().min(1).max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.lowerBoundBasisPoints >= value.upperBoundBasisPoints) {
      context.addIssue({
        code: "custom",
        message: "A calibration bin requires a positive interval",
        path: ["upperBoundBasisPoints"],
      });
    }
    if (value.positiveCount > value.sampleCount) {
      context.addIssue({
        code: "custom",
        message: "Calibration bin positiveCount cannot exceed sampleCount",
        path: ["positiveCount"],
      });
    }
    const available = value.sampleCount > 0;
    if (
      (value.meanPredictedProbability.status === "available") !== available ||
      (value.observedPositiveFrequency.status === "available") !== available
    ) {
      context.addIssue({
        code: "custom",
        message: "Calibration bin measurements are available exactly when the bin is non-empty",
        path: ["sampleCount"],
      });
    }
  });

export const SelectiveRiskPointSchema = z
  .object({
    errorCount: CalibrationCountSchema,
    selectedCount: CalibrationCountSchema,
    totalCount: CalibrationCountSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.selectedCount > value.totalCount) {
      context.addIssue({
        code: "custom",
        message: "Selective-risk selectedCount cannot exceed totalCount",
        path: ["selectedCount"],
      });
    }
    if (value.errorCount > value.selectedCount) {
      context.addIssue({
        code: "custom",
        message: "Selective-risk errorCount cannot exceed selectedCount",
        path: ["errorCount"],
      });
    }
  });

export const CalibrationDistributionShiftSchema = z.discriminatedUnion("status", [
  z
    .object({
      evidence: exactArtifacts(16, "Distribution-shift evidence").min(1),
      method: AssuranceSummarySchema,
      status: z.literal("no_shift_detected"),
    })
    .strict(),
  z
    .object({
      evidence: exactArtifacts(16, "Distribution-shift evidence").min(1),
      method: AssuranceSummarySchema,
      status: z.literal("shift_detected"),
    })
    .strict(),
  z
    .object({
      reason: AssuranceRationaleSchema,
      status: z.literal("not_assessed"),
    })
    .strict(),
]);

const calibrationReportDefinitionShape = {
  calibrationEvidence: exactArtifacts(32, "Calibration evidence").min(1),
  calibrationReportId: OpaqueIdSchema,
  completedAt: UtcMillisecondTimestampSchema,
  criteria: z
    .array(CriterionReferenceSchema)
    .min(1)
    .max(100)
    .refine(
      (references) =>
        isStrictlySortedUnique(
          references.map(
            ({ criterionId, criterionSet }) =>
              `${criterionSet.criterionSetId}:${criterionSet.criterionSetVersionId}:${criterionId}`,
          ),
        ),
      { message: "Calibration criteria must be unique and ordered" },
    ),
  dataset: EvaluationDatasetVersionReferenceSchema,
  distributionShift: CalibrationDistributionShiftSchema,
  evaluator: z
    .object({
      definitionSha256: Sha256Schema,
      evaluatorId: OpaqueIdSchema,
      evaluatorVersionId: OpaqueIdSchema,
    })
    .strict(),
  executedByPrincipalId: OpaqueIdSchema,
  knownLimitations: sortedUniqueText(64, "Calibration limitations"),
  labelSources: exactArtifacts(16, "Calibration label sources").min(1),
  method: CalibrationMethodSchema,
  metrics: z
    .object({
      brierScore: UnitIntervalDecimalSchema,
      expectedCalibrationError: z
        .object({
          value: UnitIntervalDecimalSchema,
          variant: z.enum(["equal_frequency_absolute", "equal_width_absolute"]),
        })
        .strict(),
      logLoss: NonnegativeDecimalSchema,
      reliabilityBins: z.array(CalibrationReliabilityBinSchema).min(1).max(MAX_CALIBRATION_BINS),
      selectiveRisk: z.array(SelectiveRiskPointSchema).min(1).max(MAX_SELECTIVE_RISK_POINTS),
    })
    .strict(),
  modelProfile: ModelEvaluatorProfileReferenceSchema,
  population: z
    .object({
      locale: z.string().regex(/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/),
      populationTags: sortedUniqueText(64, "Calibration population tags"),
      riskTier: EvaluationRiskTierSchema,
      taskKindIds: z.array(OpaqueIdSchema).min(1).max(32).refine(isStrictlySortedUnique, {
        message: "Calibration task kinds must be unique and ordered",
      }),
    })
    .strict(),
  predecessor: CalibrationReportReferenceSchema.optional(),
  qualificationReport: QualificationReportReferenceSchema,
  sampleSummary: z
    .object({
      excludedCount: CalibrationCountSchema,
      includedCount: CalibrationCountSchema,
      minimumRequiredCount: z.number().int().positive().max(10_000_000),
      negativeCount: CalibrationCountSchema,
      positiveCount: CalibrationCountSchema,
      totalCount: z.number().int().positive().max(10_000_000),
    })
    .strict(),
  startedAt: UtcMillisecondTimestampSchema,
  status: z.enum(["calibrated", "unavailable"]),
  statusReasons: sortedUniqueText(32, "Calibration status reasons"),
  validFrom: UtcMillisecondTimestampSchema,
  validUntil: UtcMillisecondTimestampSchema,
};

function refineCalibrationReport(
  value: {
    readonly calibrationReportId: string;
    readonly completedAt: string;
    readonly distributionShift: { readonly status: string };
    readonly metrics: {
      readonly reliabilityBins: readonly {
        readonly lowerBoundBasisPoints: number;
        readonly positiveCount: number;
        readonly sampleCount: number;
        readonly upperBoundBasisPoints: number;
      }[];
      readonly selectiveRisk: readonly {
        readonly selectedCount: number;
        readonly totalCount: number;
      }[];
    };
    readonly predecessor?: { readonly calibrationReportId: string } | undefined;
    readonly sampleSummary: {
      readonly excludedCount: number;
      readonly includedCount: number;
      readonly minimumRequiredCount: number;
      readonly negativeCount: number;
      readonly positiveCount: number;
      readonly totalCount: number;
    };
    readonly startedAt: string;
    readonly status: "calibrated" | "unavailable";
    readonly statusReasons: readonly string[];
    readonly validFrom: string;
    readonly validUntil: string;
  },
  context: z.RefinementCtx,
): void {
  if (evidenceTimestampOrderKey(value.completedAt) < evidenceTimestampOrderKey(value.startedAt)) {
    context.addIssue({
      code: "custom",
      message: "Calibration completion cannot precede its start",
      path: ["completedAt"],
    });
  }
  if (evidenceTimestampOrderKey(value.validFrom) < evidenceTimestampOrderKey(value.completedAt)) {
    context.addIssue({
      code: "custom",
      message: "Calibration validity cannot begin before completion",
      path: ["validFrom"],
    });
  }
  if (evidenceTimestampOrderKey(value.validUntil) <= evidenceTimestampOrderKey(value.validFrom)) {
    context.addIssue({
      code: "custom",
      message: "Calibration validity must have a positive interval",
      path: ["validUntil"],
    });
  }
  const samples = value.sampleSummary;
  if (samples.includedCount + samples.excludedCount !== samples.totalCount) {
    context.addIssue({
      code: "custom",
      message: "Calibration included and excluded counts must equal totalCount",
      path: ["sampleSummary", "totalCount"],
    });
  }
  if (samples.positiveCount + samples.negativeCount !== samples.includedCount) {
    context.addIssue({
      code: "custom",
      message: "Calibration positive and negative counts must equal includedCount",
      path: ["sampleSummary", "includedCount"],
    });
  }
  const bins = value.metrics.reliabilityBins;
  const binSampleCount = bins.reduce((total, bin) => total + bin.sampleCount, 0);
  const binPositiveCount = bins.reduce((total, bin) => total + bin.positiveCount, 0);
  if (
    bins[0]?.lowerBoundBasisPoints !== 0 ||
    bins.at(-1)?.upperBoundBasisPoints !== 10_000 ||
    bins.some(
      (bin, index) =>
        index > 0 && bins[index - 1]?.upperBoundBasisPoints !== bin.lowerBoundBasisPoints,
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Calibration reliability bins must form one ordered complete partition",
      path: ["metrics", "reliabilityBins"],
    });
  }
  if (binSampleCount !== samples.includedCount || binPositiveCount !== samples.positiveCount) {
    context.addIssue({
      code: "custom",
      message: "Calibration reliability-bin counts must reconstruct included labels",
      path: ["metrics", "reliabilityBins"],
    });
  }
  if (
    value.metrics.selectiveRisk.some(
      (point, index) =>
        point.totalCount !== samples.includedCount ||
        (index > 0 &&
          (value.metrics.selectiveRisk[index - 1]?.selectedCount ?? -1) >= point.selectedCount),
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Selective-risk points must use the included denominator and increasing coverage",
      path: ["metrics", "selectiveRisk"],
    });
  }
  const mayBeCalibrated =
    samples.includedCount >= samples.minimumRequiredCount &&
    samples.positiveCount > 0 &&
    samples.negativeCount > 0 &&
    value.distributionShift.status === "no_shift_detected";
  if (value.status === "calibrated" && (!mayBeCalibrated || value.statusReasons.length !== 0)) {
    context.addIssue({
      code: "custom",
      message:
        "Calibrated status requires sufficient mixed labels, no detected shift, and no reasons",
      path: ["status"],
    });
  }
  if (value.status === "unavailable" && value.statusReasons.length === 0) {
    context.addIssue({
      code: "custom",
      message: "Unavailable calibration requires at least one status reason",
      path: ["statusReasons"],
    });
  }
  if (value.predecessor?.calibrationReportId === value.calibrationReportId) {
    context.addIssue({
      code: "custom",
      message: "A calibration report cannot name itself as predecessor",
      path: ["predecessor", "calibrationReportId"],
    });
  }
}

export const CalibrationReportDefinitionSchema = z
  .object(calibrationReportDefinitionShape)
  .strict()
  .superRefine(refineCalibrationReport);

export const CalibrationReportSchema = z
  .object({
    ...calibrationReportDefinitionShape,
    definitionSha256: Sha256Schema,
    recordedAt: UtcMillisecondTimestampSchema,
    schemaVersion: z.literal(CALIBRATION_REPORT_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineCalibrationReport);

export type CalibrationReportReference = z.infer<typeof CalibrationReportReferenceSchema>;
export type CalibrationReportDefinition = z.infer<typeof CalibrationReportDefinitionSchema>;
export type CalibrationReport = z.infer<typeof CalibrationReportSchema>;
