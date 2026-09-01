import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { AssessmentReferenceSchema } from "./evaluation-assessment.js";
import {
  CriterionReferenceSchema,
  CriterionVersionSelectorSchema,
  EvaluatorReferenceSchema,
  EvaluationRiskTierSchema,
} from "./evaluation-criteria.js";
import {
  EvaluationDatasetVersionReferenceSchema,
  RawObservationReferenceSchema,
} from "./evaluation-run.js";
import {
  QualificationFixtureSetReferenceSchema,
  QualificationReportReferenceSchema,
} from "./evaluation-spec.js";
import { EvidenceScopeSchema, evidenceTimestampOrderKey } from "./evidence.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";
import { AssuranceRationaleSchema, AssuranceSummarySchema } from "./evaluation-source.js";

export const MODEL_EVALUATOR_PROFILE_SCHEMA_VERSION = "0.1" as const;
export const INDEPENDENCE_DECLARATION_SCHEMA_VERSION = "0.1" as const;
export const CALIBRATION_REPORT_SCHEMA_VERSION = "0.1" as const;
export const MODEL_ASSISTED_EVALUATOR_SPEC_SCHEMA_VERSION = "0.1" as const;
export const BLINDED_EVALUATION_PLAN_SCHEMA_VERSION = "0.1" as const;
export const INDEPENDENT_CRITIQUE_SCHEMA_VERSION = "0.1" as const;
export const HUMAN_REVIEW_PROTOCOL_SCHEMA_VERSION = "0.1" as const;
export const HUMAN_REVIEW_RECORD_SCHEMA_VERSION = "0.1" as const;
export const HUMAN_REVIEWER_INDEPENDENCE_SCHEMA_VERSION = "0.1" as const;
export const MAX_BLINDED_ATTEMPTS = 16;
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
    .array(EvaluationRiskTierSchema)
    .min(1)
    .max(EvaluationRiskTierSchema.options.length)
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

const modelAssistedEvaluatorSpecDefinitionShape = {
  changeRationale: AssuranceRationaleSchema,
  configurationSha256: Sha256Schema,
  evaluatorId: OpaqueIdSchema,
  evaluatorVersionId: OpaqueIdSchema,
  inputSchema: ArtifactContentReferenceSchema,
  kind: z.literal("model_assisted"),
  knownLimitations: sortedUniqueText(64, "Model-assisted evaluator limitations"),
  modelProfile: ModelEvaluatorProfileReferenceSchema,
  outputSchema: ArtifactContentReferenceSchema,
  predecessor: EvaluatorReferenceSchema.optional(),
  qualificationFixtureSet: QualificationFixtureSetReferenceSchema,
  resultSemantics: AssuranceRationaleSchema,
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
      { message: "Model-assisted evaluator criteria must be unique and ordered" },
    ),
};

function refineModelAssistedEvaluatorSpec(
  value: {
    readonly evaluatorId: string;
    readonly evaluatorVersionId: string;
    readonly predecessor?:
      | { readonly evaluatorId: string; readonly evaluatorVersionId: string }
      | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (!value.predecessor) return;
  if (value.predecessor.evaluatorId !== value.evaluatorId) {
    context.addIssue({
      code: "custom",
      message: "A model-assisted evaluator predecessor must retain the logical evaluatorId",
      path: ["predecessor", "evaluatorId"],
    });
  }
  if (value.predecessor.evaluatorVersionId === value.evaluatorVersionId) {
    context.addIssue({
      code: "custom",
      message: "A model-assisted evaluator cannot name itself as predecessor",
      path: ["predecessor", "evaluatorVersionId"],
    });
  }
}

export const ModelAssistedEvaluatorSpecDefinitionSchema = z
  .object(modelAssistedEvaluatorSpecDefinitionShape)
  .strict()
  .superRefine(refineModelAssistedEvaluatorSpec);

export const ModelAssistedEvaluatorSpecSchema = z
  .object({
    ...modelAssistedEvaluatorSpecDefinitionShape,
    definitionSha256: Sha256Schema,
    publishedAt: UtcMillisecondTimestampSchema,
    publishedByPrincipalId: OpaqueIdSchema,
    schemaVersion: z.literal(MODEL_ASSISTED_EVALUATOR_SPEC_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineModelAssistedEvaluatorSpec);

export type ModelAssistedEvaluatorSpecDefinition = z.infer<
  typeof ModelAssistedEvaluatorSpecDefinitionSchema
>;
export type ModelAssistedEvaluatorSpec = z.infer<typeof ModelAssistedEvaluatorSpecSchema>;

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

export const BlindedEvaluationPlanReferenceSchema = z
  .object({
    blindedPlanId: OpaqueIdSchema,
    blindedPlanVersionId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
  })
  .strict();

const NonRevealingLabelSchema = AssuranceSummarySchema.refine(
  (value) => !/(?:baseline|candidate|control|treatment|new|old|left|right)/iu.test(value),
  { message: "Blind labels cannot reveal subject identity or position" },
);

export const BlindedPresentationSchema = z
  .object({
    labels: z.array(NonRevealingLabelSchema).length(2),
    presentationId: OpaqueIdSchema,
  })
  .strict();

export const BlindLeakageCheckSchema = z
  .object({
    checkId: OpaqueIdSchema,
    evidence: ArtifactContentReferenceSchema,
    kind: z.enum(["content", "identifier", "metadata"]),
    status: z.enum(["failed", "passed"]),
  })
  .strict();

const blindedEvaluationPlanDefinitionShape = {
  attempts: z
    .array(
      z
        .object({
          attemptId: OpaqueIdSchema,
          presentationId: OpaqueIdSchema,
          seed: z.number().int().nonnegative().max(4_294_967_295),
        })
        .strict(),
    )
    .min(2)
    .max(MAX_BLINDED_ATTEMPTS),
  attemptsPerOrder: z
    .number()
    .int()
    .positive()
    .max(MAX_BLINDED_ATTEMPTS / 2),
  blindMap: ArtifactContentReferenceSchema,
  blindedPlanId: OpaqueIdSchema,
  blindedPlanVersionId: OpaqueIdSchema,
  calibrationReport: CalibrationReportReferenceSchema,
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
      { message: "Blinded evaluation criteria must be unique and ordered" },
    ),
  evaluator: z
    .object({
      definitionSha256: Sha256Schema,
      evaluatorId: OpaqueIdSchema,
      evaluatorVersionId: OpaqueIdSchema,
    })
    .strict(),
  independenceDeclaration: IndependenceDeclarationReferenceSchema,
  leakageChecks: z.array(BlindLeakageCheckSchema).min(3).max(32),
  maskingMethod: AssuranceRationaleSchema,
  modelProfile: ModelEvaluatorProfileReferenceSchema,
  opaqueLabels: z.array(NonRevealingLabelSchema).length(2),
  planStatus: z.enum(["invalid", "valid"]),
  presentations: z.array(BlindedPresentationSchema).length(2),
  predecessor: BlindedEvaluationPlanReferenceSchema.optional(),
  redactionReport: ArtifactContentReferenceSchema,
  statusReasons: sortedUniqueText(32, "Blinded-plan status reasons"),
  subjectArtifacts: exactArtifacts(2, "Blinded subject artifacts").length(2),
  validFrom: UtcMillisecondTimestampSchema,
  validUntil: UtcMillisecondTimestampSchema,
};

function refineBlindedEvaluationPlan(
  value: {
    readonly attempts: readonly {
      readonly attemptId: string;
      readonly presentationId: string;
    }[];
    readonly attemptsPerOrder: number;
    readonly blindMap: { readonly classification: string };
    readonly blindedPlanId: string;
    readonly blindedPlanVersionId: string;
    readonly leakageChecks: readonly {
      readonly checkId: string;
      readonly kind: "content" | "identifier" | "metadata";
      readonly status: "failed" | "passed";
    }[];
    readonly opaqueLabels: readonly string[];
    readonly planStatus: "invalid" | "valid";
    readonly presentations: readonly {
      readonly labels: readonly string[];
      readonly presentationId: string;
    }[];
    readonly predecessor?:
      | { readonly blindedPlanId: string; readonly blindedPlanVersionId: string }
      | undefined;
    readonly statusReasons: readonly string[];
    readonly validFrom: string;
    readonly validUntil: string;
  },
  context: z.RefinementCtx,
): void {
  if (!isStrictlySortedUnique(value.opaqueLabels)) {
    context.addIssue({
      code: "custom",
      message: "Opaque labels must be unique and ordered",
      path: ["opaqueLabels"],
    });
  }
  const [firstLabel, secondLabel] = value.opaqueLabels;
  const [firstPresentation, secondPresentation] = value.presentations;
  if (
    !firstLabel ||
    !secondLabel ||
    !firstPresentation ||
    !secondPresentation ||
    firstPresentation.labels[0] !== firstLabel ||
    firstPresentation.labels[1] !== secondLabel ||
    secondPresentation.labels[0] !== secondLabel ||
    secondPresentation.labels[1] !== firstLabel ||
    firstPresentation.presentationId >= secondPresentation.presentationId
  ) {
    context.addIssue({
      code: "custom",
      message: "Blinded presentations must be ordered exact reversals of two opaque labels",
      path: ["presentations"],
    });
  }
  const attemptIds = value.attempts.map(({ attemptId }) => attemptId);
  if (!isStrictlySortedUnique(attemptIds)) {
    context.addIssue({
      code: "custom",
      message: "Blinded attempts must be unique and ordered by attemptId",
      path: ["attempts"],
    });
  }
  for (const presentation of value.presentations) {
    if (
      value.attempts.filter(({ presentationId }) => presentationId === presentation.presentationId)
        .length !== value.attemptsPerOrder
    ) {
      context.addIssue({
        code: "custom",
        message: "Every blinded order requires the predeclared number of attempts",
        path: ["attempts"],
      });
    }
  }
  if (
    value.attempts.some(
      ({ presentationId }) =>
        !value.presentations.some((presentation) => presentation.presentationId === presentationId),
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "A blinded attempt must reference a declared presentation",
      path: ["attempts"],
    });
  }
  const checkIds = value.leakageChecks.map(({ checkId }) => checkId);
  const checkKinds = new Set(value.leakageChecks.map(({ kind }) => kind));
  if (
    !isStrictlySortedUnique(checkIds) ||
    !["content", "identifier", "metadata"].every((kind) => checkKinds.has(kind as never))
  ) {
    context.addIssue({
      code: "custom",
      message: "Leakage checks must be ordered and cover content, identifier, and metadata",
      path: ["leakageChecks"],
    });
  }
  const valid =
    value.blindMap.classification === "restricted" &&
    value.leakageChecks.every(({ status }) => status === "passed");
  if (value.planStatus === "valid" && (!valid || value.statusReasons.length !== 0)) {
    context.addIssue({
      code: "custom",
      message: "A valid blinded plan requires a restricted map, passed checks, and no reasons",
      path: ["planStatus"],
    });
  }
  if (value.planStatus === "invalid" && value.statusReasons.length === 0) {
    context.addIssue({
      code: "custom",
      message: "An invalid blinded plan requires at least one status reason",
      path: ["statusReasons"],
    });
  }
  if (evidenceTimestampOrderKey(value.validUntil) <= evidenceTimestampOrderKey(value.validFrom)) {
    context.addIssue({
      code: "custom",
      message: "Blinded-plan validity must have a positive interval",
      path: ["validUntil"],
    });
  }
  if (
    value.predecessor?.blindedPlanId === value.blindedPlanId &&
    value.predecessor.blindedPlanVersionId === value.blindedPlanVersionId
  ) {
    context.addIssue({
      code: "custom",
      message: "A blinded plan cannot name itself as predecessor",
      path: ["predecessor", "blindedPlanVersionId"],
    });
  }
}

export const BlindedEvaluationPlanDefinitionSchema = z
  .object(blindedEvaluationPlanDefinitionShape)
  .strict()
  .superRefine(refineBlindedEvaluationPlan);

export const BlindedEvaluationPlanSchema = z
  .object({
    ...blindedEvaluationPlanDefinitionShape,
    definitionSha256: Sha256Schema,
    publishedAt: UtcMillisecondTimestampSchema,
    publishedByPrincipalId: OpaqueIdSchema,
    schemaVersion: z.literal(BLINDED_EVALUATION_PLAN_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineBlindedEvaluationPlan);

export type BlindedEvaluationPlanReference = z.infer<typeof BlindedEvaluationPlanReferenceSchema>;
export type BlindedEvaluationPlanDefinition = z.infer<typeof BlindedEvaluationPlanDefinitionSchema>;
export type BlindedEvaluationPlan = z.infer<typeof BlindedEvaluationPlanSchema>;

export const IndependentCritiqueReferenceSchema = z
  .object({
    critiqueId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
  })
  .strict();

export const CritiqueFindingSchema = z
  .object({
    evidence: exactArtifacts(16, "Critique finding evidence").min(1),
    findingId: OpaqueIdSchema,
    impact: z.enum(["opposes", "supports", "uncertain"]),
    kind: z.enum([
      "alternative_interpretation",
      "counterexample",
      "injection_signal",
      "missing_evidence",
      "scope_error",
    ]),
    summary: AssuranceRationaleSchema,
  })
  .strict();

export const IndependentCritiqueOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      findings: z
        .array(CritiqueFindingSchema)
        .min(1)
        .max(64)
        .refine((findings) => isStrictlySortedUnique(findings.map(({ findingId }) => findingId)), {
          message: "Critique findings must be unique and ordered by findingId",
        }),
      output: ArtifactContentReferenceSchema,
      status: z.literal("produced"),
    })
    .strict(),
  z
    .object({
      evidence: exactArtifacts(16, "Critique abstention evidence").min(1),
      reasons: sortedUniqueText(16, "Critique abstention reasons").min(1),
      status: z.literal("abstained"),
    })
    .strict(),
  z
    .object({
      code: z.enum([
        "budget_exhausted",
        "deadline_exceeded",
        "input_unavailable",
        "output_malformed",
        "provider_unavailable",
      ]),
      evidence: exactArtifacts(16, "Critique error evidence"),
      reason: AssuranceRationaleSchema,
      status: z.literal("error"),
    })
    .strict(),
]);

const independentCritiqueDefinitionShape = {
  accessAttestation: z
    .object({
      attestedAt: UtcMillisecondTimestampSchema,
      evidence: ArtifactContentReferenceSchema,
      status: z.literal("original_judgment_withheld"),
    })
    .strict(),
  allowedEvidence: exactArtifacts(64, "Critique allowed evidence").min(1),
  calibrationReport: CalibrationReportReferenceSchema,
  completedAt: UtcMillisecondTimestampSchema,
  criterion: CriterionReferenceSchema,
  critiqueId: OpaqueIdSchema,
  evaluator: z
    .object({
      definitionSha256: Sha256Schema,
      evaluatorId: OpaqueIdSchema,
      evaluatorVersionId: OpaqueIdSchema,
    })
    .strict(),
  evidenceAccessManifest: ArtifactContentReferenceSchema,
  independenceDeclaration: IndependenceDeclarationReferenceSchema,
  modelProfile: ModelEvaluatorProfileReferenceSchema,
  observation: RawObservationReferenceSchema,
  outcome: IndependentCritiqueOutcomeSchema,
  qualificationReport: QualificationReportReferenceSchema,
  question: ArtifactContentReferenceSchema,
  rationaleAccess: z.literal("withheld_until_critique_recorded"),
  selectedAt: UtcMillisecondTimestampSchema,
  startedAt: UtcMillisecondTimestampSchema,
};

function refineIndependentCritique(
  value: {
    readonly accessAttestation: { readonly attestedAt: string };
    readonly completedAt: string;
    readonly selectedAt: string;
    readonly startedAt: string;
  },
  context: z.RefinementCtx,
): void {
  const selected = evidenceTimestampOrderKey(value.selectedAt);
  const attested = evidenceTimestampOrderKey(value.accessAttestation.attestedAt);
  const started = evidenceTimestampOrderKey(value.startedAt);
  const completed = evidenceTimestampOrderKey(value.completedAt);
  if (attested < selected) {
    context.addIssue({
      code: "custom",
      message: "Critique withholding attestation cannot precede critic selection",
      path: ["accessAttestation", "attestedAt"],
    });
  }
  if (started < attested) {
    context.addIssue({
      code: "custom",
      message: "Critique execution cannot begin before withholding is attested",
      path: ["startedAt"],
    });
  }
  if (completed < started) {
    context.addIssue({
      code: "custom",
      message: "Critique completion cannot precede execution start",
      path: ["completedAt"],
    });
  }
}

export const IndependentCritiqueDefinitionSchema = z
  .object(independentCritiqueDefinitionShape)
  .strict()
  .superRefine(refineIndependentCritique);

export const IndependentCritiqueSchema = z
  .object({
    ...independentCritiqueDefinitionShape,
    definitionSha256: Sha256Schema,
    recordedAt: UtcMillisecondTimestampSchema,
    recordedByPrincipalId: OpaqueIdSchema,
    schemaVersion: z.literal(INDEPENDENT_CRITIQUE_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineIndependentCritique);

export type IndependentCritiqueReference = z.infer<typeof IndependentCritiqueReferenceSchema>;
export type IndependentCritiqueDefinition = z.infer<typeof IndependentCritiqueDefinitionSchema>;
export type IndependentCritique = z.infer<typeof IndependentCritiqueSchema>;

export const HumanReviewActionSchema = z.enum([
  "abstain",
  "oppose",
  "recuse",
  "request_changes",
  "require_escalation",
  "support",
]);

export const HumanReviewProtocolReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    protocolId: OpaqueIdSchema,
    protocolVersionId: OpaqueIdSchema,
  })
  .strict();

export const HumanReviewerRoleRequirementSchema = z
  .object({
    credentialRequirements: exactArtifacts(16, "Reviewer credential requirements"),
    expertiseAreas: sortedUniqueText(32, "Reviewer expertise areas").min(1),
    minimumReviewers: z.number().int().positive().max(64),
    roleId: OpaqueIdSchema,
    trainingRequirements: exactArtifacts(16, "Reviewer training requirements"),
  })
  .strict();

const humanReviewProtocolDefinitionShape = {
  accessibility: z
    .object({
      accommodationProcess: ArtifactContentReferenceSchema,
      requiredLocales: z
        .array(z.string().regex(/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/))
        .min(1)
        .max(32)
        .refine(isStrictlySortedUnique, {
          message: "Human-review locales must be unique and ordered",
        }),
    })
    .strict(),
  allowedActions: z
    .array(HumanReviewActionSchema)
    .min(3)
    .max(HumanReviewActionSchema.options.length)
    .refine(isStrictlySortedUnique, {
      message: "Human-review actions must be unique and ordered",
    }),
  claim: z
    .object({
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
          { message: "Human-review criteria must be unique and ordered" },
        ),
      description: AssuranceRationaleSchema,
      evidenceBundle: exactArtifacts(64, "Human-review evidence bundle").min(1),
      riskTier: EvaluationRiskTierSchema,
    })
    .strict(),
  conflictPolicy: z
    .object({
      disclosureRequired: z.literal(true),
      forbiddenRelationships: sortedUniqueText(32, "Forbidden reviewer relationships").min(1),
      recusalRequiredOnConflict: z.literal(true),
      unverifiableIndependenceAction: z.literal("require_escalation"),
    })
    .strict(),
  dissentPolicy: z
    .object({
      adjudicationRules: ArtifactContentReferenceSchema,
      dissentPreservation: z.literal("append_only"),
      minorityRationaleRequired: z.literal(true),
      unresolvedDissentAction: z.literal("require_escalation"),
    })
    .strict(),
  escalationTriggers: z
    .array(
      z.enum([
        "critical_counterevidence",
        "material_conflict",
        "protocol_expired",
        "quorum_shortfall",
        "unresolved_dissent",
        "unverifiable_independence",
      ]),
    )
    .length(6)
    .refine(isStrictlySortedUnique, {
      message: "Human-review escalation triggers must be complete, unique, and ordered",
    }),
  independenceRequirements: z
    .object({
      declarationRequired: z.literal(true),
      minimumIndependentGroups: z.number().int().positive().max(64),
      modelOnlyQuorumPermitted: z.literal(false),
      sameOrganizationPermitted: z.boolean(),
    })
    .strict(),
  knownLimitations: sortedUniqueText(64, "Human-review protocol limitations"),
  predecessor: HumanReviewProtocolReferenceSchema.optional(),
  protocolId: OpaqueIdSchema,
  protocolVersionId: OpaqueIdSchema,
  quorum: z
    .object({
      abstentionsCountTowardQuorum: z.literal(false),
      minimumCompletedReviews: z.number().int().positive().max(64),
      recusalsCountTowardQuorum: z.literal(false),
    })
    .strict(),
  rationalePolicy: z
    .object({
      freeTextArtifactRequired: z.literal(true),
      minimumStructuredReasons: z.number().int().positive().max(32),
      sourceCitationsRequired: z.literal(true),
    })
    .strict(),
  reviewerRoles: z
    .array(HumanReviewerRoleRequirementSchema)
    .min(1)
    .max(32)
    .refine((roles) => isStrictlySortedUnique(roles.map(({ roleId }) => roleId)), {
      message: "Human-review roles must be unique and ordered by roleId",
    }),
  supersessionPolicy: z
    .object({
      correctionMode: z.literal("append_superseding_record"),
      originalVisibility: z.literal("retained"),
      protocolPinning: z.literal("exact_version"),
    })
    .strict(),
  timePolicy: z
    .object({
      maximumReviewMilliseconds: z.number().int().positive().max(604_800_000),
      reviewExpiryMilliseconds: z.number().int().positive().max(31_536_000_000),
    })
    .strict(),
  validFrom: UtcMillisecondTimestampSchema,
  validUntil: UtcMillisecondTimestampSchema,
};

function refineHumanReviewProtocol(
  value: {
    readonly allowedActions: readonly z.infer<typeof HumanReviewActionSchema>[];
    readonly independenceRequirements: { readonly minimumIndependentGroups: number };
    readonly predecessor?:
      | { readonly protocolId: string; readonly protocolVersionId: string }
      | undefined;
    readonly protocolId: string;
    readonly protocolVersionId: string;
    readonly quorum: { readonly minimumCompletedReviews: number };
    readonly reviewerRoles: readonly { readonly minimumReviewers: number }[];
    readonly validFrom: string;
    readonly validUntil: string;
  },
  context: z.RefinementCtx,
): void {
  for (const required of ["abstain", "recuse", "require_escalation"] as const) {
    if (!value.allowedActions.includes(required)) {
      context.addIssue({
        code: "custom",
        message: `Human-review protocol requires the ${required} safeguard action`,
        path: ["allowedActions"],
      });
    }
  }
  const requiredReviewers = value.reviewerRoles.reduce(
    (total, role) => total + role.minimumReviewers,
    0,
  );
  if (value.quorum.minimumCompletedReviews < requiredReviewers) {
    context.addIssue({
      code: "custom",
      message: "Human-review quorum cannot be smaller than the required role counts",
      path: ["quorum", "minimumCompletedReviews"],
    });
  }
  if (
    value.independenceRequirements.minimumIndependentGroups > value.quorum.minimumCompletedReviews
  ) {
    context.addIssue({
      code: "custom",
      message: "Independent-group requirement cannot exceed the completed-review quorum",
      path: ["independenceRequirements", "minimumIndependentGroups"],
    });
  }
  if (evidenceTimestampOrderKey(value.validUntil) <= evidenceTimestampOrderKey(value.validFrom)) {
    context.addIssue({
      code: "custom",
      message: "Human-review protocol validity must have a positive interval",
      path: ["validUntil"],
    });
  }
  if (
    value.predecessor?.protocolId === value.protocolId &&
    value.predecessor.protocolVersionId === value.protocolVersionId
  ) {
    context.addIssue({
      code: "custom",
      message: "A human-review protocol cannot name itself as predecessor",
      path: ["predecessor", "protocolVersionId"],
    });
  }
}

export const HumanReviewProtocolDefinitionSchema = z
  .object(humanReviewProtocolDefinitionShape)
  .strict()
  .superRefine(refineHumanReviewProtocol);

export const HumanReviewProtocolSchema = z
  .object({
    ...humanReviewProtocolDefinitionShape,
    definitionSha256: Sha256Schema,
    publishedAt: UtcMillisecondTimestampSchema,
    publishedByPrincipalId: OpaqueIdSchema,
    schemaVersion: z.literal(HUMAN_REVIEW_PROTOCOL_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineHumanReviewProtocol);

export type HumanReviewProtocolReference = z.infer<typeof HumanReviewProtocolReferenceSchema>;
export type HumanReviewProtocolDefinition = z.infer<typeof HumanReviewProtocolDefinitionSchema>;
export type HumanReviewProtocol = z.infer<typeof HumanReviewProtocolSchema>;

export const HumanReviewerIndependenceReferenceSchema = z
  .object({
    declarationId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
  })
  .strict();

const humanReviewerIndependenceDefinitionShape = {
  affiliations: sortedUniqueText(32, "Human reviewer affiliations").min(1),
  conflicts: sortedUniqueText(32, "Human reviewer independence conflicts"),
  declarationId: OpaqueIdSchema,
  independenceGroupIds: z.array(OpaqueIdSchema).min(1).max(32).refine(isStrictlySortedUnique, {
    message: "Human reviewer independence groups must be unique and ordered",
  }),
  predecessor: HumanReviewerIndependenceReferenceSchema.optional(),
  relationships: sortedUniqueText(32, "Human reviewer independence relationships"),
  reviewBasis: exactArtifacts(16, "Human reviewer independence basis").min(1),
  reviewedAt: UtcMillisecondTimestampSchema,
  reviewedByPrincipalId: OpaqueIdSchema,
  reviewerPrincipalId: OpaqueIdSchema,
  status: z.enum(["rejected", "unverifiable", "verified"]),
  statusReasons: sortedUniqueText(32, "Human reviewer independence reasons"),
  validFrom: UtcMillisecondTimestampSchema,
  validUntil: UtcMillisecondTimestampSchema,
};

function refineHumanReviewerIndependence(
  value: {
    readonly conflicts: readonly string[];
    readonly declarationId: string;
    readonly predecessor?: { readonly declarationId: string } | undefined;
    readonly reviewedAt: string;
    readonly status: "rejected" | "unverifiable" | "verified";
    readonly statusReasons: readonly string[];
    readonly validFrom: string;
    readonly validUntil: string;
  },
  context: z.RefinementCtx,
): void {
  if (
    value.status === "verified" &&
    (value.conflicts.length > 0 || value.statusReasons.length > 0)
  ) {
    context.addIssue({
      code: "custom",
      message: "Verified human reviewer independence cannot retain conflicts or status reasons",
      path: ["status"],
    });
  }
  if (value.status !== "verified" && value.statusReasons.length === 0) {
    context.addIssue({
      code: "custom",
      message: "Unverified human reviewer independence requires at least one status reason",
      path: ["statusReasons"],
    });
  }
  if (evidenceTimestampOrderKey(value.validFrom) < evidenceTimestampOrderKey(value.reviewedAt)) {
    context.addIssue({
      code: "custom",
      message: "Human reviewer independence validity cannot begin before review",
      path: ["validFrom"],
    });
  }
  if (evidenceTimestampOrderKey(value.validUntil) <= evidenceTimestampOrderKey(value.validFrom)) {
    context.addIssue({
      code: "custom",
      message: "Human reviewer independence validity must have a positive interval",
      path: ["validUntil"],
    });
  }
  if (value.predecessor?.declarationId === value.declarationId) {
    context.addIssue({
      code: "custom",
      message: "A human reviewer independence declaration cannot name itself as predecessor",
      path: ["predecessor", "declarationId"],
    });
  }
}

export const HumanReviewerIndependenceDefinitionSchema = z
  .object(humanReviewerIndependenceDefinitionShape)
  .strict()
  .superRefine(refineHumanReviewerIndependence);

export const HumanReviewerIndependenceSchema = z
  .object({
    ...humanReviewerIndependenceDefinitionShape,
    definitionSha256: Sha256Schema,
    recordedAt: UtcMillisecondTimestampSchema,
    schemaVersion: z.literal(HUMAN_REVIEWER_INDEPENDENCE_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineHumanReviewerIndependence);

export type HumanReviewerIndependenceReference = z.infer<
  typeof HumanReviewerIndependenceReferenceSchema
>;
export type HumanReviewerIndependenceDefinition = z.infer<
  typeof HumanReviewerIndependenceDefinitionSchema
>;
export type HumanReviewerIndependence = z.infer<typeof HumanReviewerIndependenceSchema>;

export const HumanReviewRecordReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    reviewId: OpaqueIdSchema,
  })
  .strict();

export const HumanReviewerSessionSchema = z
  .object({
    authenticatedAt: UtcMillisecondTimestampSchema,
    authenticationMethod: z.literal("oidc"),
    credentialId: OpaqueIdSchema,
    principalId: OpaqueIdSchema,
    principalType: z.literal("user"),
    requestId: z.string().min(8).max(128),
    sessionEvidence: ArtifactContentReferenceSchema,
    sessionId: OpaqueIdSchema,
  })
  .strict();

const humanReviewRecordDefinitionShape = {
  action: HumanReviewActionSchema,
  assessment: AssessmentReferenceSchema,
  completedAt: UtcMillisecondTimestampSchema,
  conflicts: sortedUniqueText(32, "Human reviewer conflicts"),
  counterevidence: exactArtifacts(64, "Human-review counterevidence"),
  credentialEvidence: exactArtifacts(16, "Human reviewer credential evidence"),
  critiques: z
    .array(IndependentCritiqueReferenceSchema)
    .max(32)
    .refine(
      (references) =>
        isStrictlySortedUnique(
          references.map(({ critiqueId, definitionSha256 }) => `${critiqueId}:${definitionSha256}`),
        ),
      { message: "Human-review critiques must be unique and ordered by exact reference" },
    ),
  evidenceAccessManifest: ArtifactContentReferenceSchema,
  expertiseEvidence: exactArtifacts(16, "Human reviewer expertise evidence").min(1),
  expiresAt: UtcMillisecondTimestampSchema,
  independenceDeclaration: HumanReviewerIndependenceReferenceSchema,
  observations: z
    .array(RawObservationReferenceSchema)
    .min(1)
    .max(64)
    .refine(
      (references) =>
        isStrictlySortedUnique(
          references.map(
            ({ observationId, definitionSha256 }) => `${observationId}:${definitionSha256}`,
          ),
        ),
      { message: "Human-review observations must be unique and ordered by exact reference" },
    ),
  protocol: HumanReviewProtocolReferenceSchema,
  rationale: ArtifactContentReferenceSchema,
  relationships: sortedUniqueText(32, "Human reviewer relationships"),
  reviewId: OpaqueIdSchema,
  reviewedArtifacts: exactArtifacts(64, "Human-reviewed artifacts").min(1),
  reviewer: HumanReviewerSessionSchema,
  reviewerRoleId: OpaqueIdSchema,
  sourceCitations: exactArtifacts(32, "Human-review source citations").min(1),
  startedAt: UtcMillisecondTimestampSchema,
  structuredReasons: sortedUniqueText(32, "Human-review structured reasons").min(1),
  supersedes: HumanReviewRecordReferenceSchema.optional(),
  trainingEvidence: exactArtifacts(16, "Human reviewer training evidence"),
};

function refineHumanReviewRecord(
  value: {
    readonly action: z.infer<typeof HumanReviewActionSchema>;
    readonly completedAt: string;
    readonly conflicts: readonly string[];
    readonly expiresAt: string;
    readonly reviewId: string;
    readonly reviewer: { readonly authenticatedAt: string };
    readonly startedAt: string;
    readonly supersedes?: { readonly reviewId: string } | undefined;
  },
  context: z.RefinementCtx,
): void {
  const authenticated = evidenceTimestampOrderKey(value.reviewer.authenticatedAt);
  const started = evidenceTimestampOrderKey(value.startedAt);
  const completed = evidenceTimestampOrderKey(value.completedAt);
  const expires = evidenceTimestampOrderKey(value.expiresAt);
  if (started < authenticated) {
    context.addIssue({
      code: "custom",
      message: "Human review cannot begin before reviewer authentication",
      path: ["startedAt"],
    });
  }
  if (completed < started) {
    context.addIssue({
      code: "custom",
      message: "Human review completion cannot precede its start",
      path: ["completedAt"],
    });
  }
  if (expires <= completed) {
    context.addIssue({
      code: "custom",
      message: "Human review expiry must follow completion",
      path: ["expiresAt"],
    });
  }
  if (value.action === "recuse" && value.conflicts.length === 0) {
    context.addIssue({
      code: "custom",
      message: "A recused human review requires at least one disclosed conflict",
      path: ["conflicts"],
    });
  }
  if (value.action !== "recuse" && value.conflicts.length > 0) {
    context.addIssue({
      code: "custom",
      message: "A human reviewer with a disclosed conflict must recuse",
      path: ["action"],
    });
  }
  if (value.supersedes?.reviewId === value.reviewId) {
    context.addIssue({
      code: "custom",
      message: "A human review cannot supersede itself",
      path: ["supersedes", "reviewId"],
    });
  }
}

export const HumanReviewRecordDefinitionSchema = z
  .object(humanReviewRecordDefinitionShape)
  .strict()
  .superRefine(refineHumanReviewRecord);

export const HumanReviewRecordSchema = z
  .object({
    ...humanReviewRecordDefinitionShape,
    definitionSha256: Sha256Schema,
    recordedAt: UtcMillisecondTimestampSchema,
    schemaVersion: z.literal(HUMAN_REVIEW_RECORD_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineHumanReviewRecord);

export type HumanReviewRecordReference = z.infer<typeof HumanReviewRecordReferenceSchema>;
export type HumanReviewRecordDefinition = z.infer<typeof HumanReviewRecordDefinitionSchema>;
export type HumanReviewRecord = z.infer<typeof HumanReviewRecordSchema>;
