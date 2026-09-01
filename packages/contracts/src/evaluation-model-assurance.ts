import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { CriterionVersionSelectorSchema } from "./evaluation-criteria.js";
import { EvidenceScopeSchema, evidenceTimestampOrderKey } from "./evidence.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";
import { AssuranceRationaleSchema, AssuranceSummarySchema } from "./evaluation-source.js";

export const MODEL_EVALUATOR_PROFILE_SCHEMA_VERSION = "0.1" as const;
export const INDEPENDENCE_DECLARATION_SCHEMA_VERSION = "0.1" as const;
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
