import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { EvidenceScopeSchema, evidenceTimestampOrderKey } from "./evidence.js";
import { CriterionVersionSelectorSchema } from "./evaluation-criteria.js";
import {
  BlindedEvaluationPlanReferenceSchema,
  ModelEvaluatorProfileReferenceSchema,
} from "./evaluation-model-assurance.js";
import { EvaluationDatasetVersionReferenceSchema } from "./evaluation-run.js";
import { AssuranceRationaleSchema, AssuranceSummarySchema } from "./evaluation-source.js";
import { QualificationFixtureSetReferenceSchema } from "./evaluation-spec.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";

export const MODEL_QUALIFICATION_SUITE_SCHEMA_VERSION = "0.1" as const;
export const MAX_MODEL_QUALIFICATION_CASES = 10_000;

function isStrictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

export const ModelQualificationScenarioSchema = z.enum([
  "authority_bias",
  "bandwagon_bias",
  "budget_exhaustion",
  "direct_prompt_injection",
  "encoded_prompt_injection",
  "forged_citation",
  "indirect_prompt_injection",
  "judge_disagreement",
  "label_leakage",
  "late_response",
  "malformed_model_output",
  "multilingual_prompt_injection",
  "network_failure",
  "out_of_distribution",
  "partial_stream",
  "position_swap",
  "provider_refusal",
  "rate_limit",
  "retrieved_prompt_injection",
  "self_provider_correlation",
  "stochastic_variance",
  "style_bias",
  "tool_request_injection",
  "verbosity_bias",
]);

export const ModelQualificationSuiteReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    suiteId: OpaqueIdSchema,
    suiteVersionId: OpaqueIdSchema,
  })
  .strict();

const modelQualificationSuiteDefinitionShape = {
  baseQualificationFixtureSet: QualificationFixtureSetReferenceSchema,
  blindedPlan: BlindedEvaluationPlanReferenceSchema,
  caseCount: z
    .number()
    .int()
    .min(ModelQualificationScenarioSchema.options.length)
    .max(MAX_MODEL_QUALIFICATION_CASES),
  caseManifest: ArtifactContentReferenceSchema,
  caseManifestSchema: ArtifactContentReferenceSchema,
  changeRationale: AssuranceRationaleSchema,
  criteria: z
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
      { message: "Model qualification criteria must be unique and ordered" },
    ),
  dataset: EvaluationDatasetVersionReferenceSchema,
  evaluator: z
    .object({
      definitionSha256: Sha256Schema,
      evaluatorId: OpaqueIdSchema,
      evaluatorVersionId: OpaqueIdSchema,
    })
    .strict(),
  executionPolicy: z
    .object({
      defaultAttemptsPerCase: z.number().int().positive().max(16),
      fixedSeeds: ArtifactContentReferenceSchema,
      orderBiasAttemptsPerCase: z.number().int().min(2).max(16),
      retryUntilPass: z.literal(false),
      stochasticVarianceAttemptsPerCase: z.number().int().min(4).max(16),
    })
    .strict(),
  knownLimitations: z.array(AssuranceSummarySchema).max(64).refine(isStrictlySortedUnique, {
    message: "Model qualification limitations must be unique and ordered",
  }),
  manifestValidationEvidence: ArtifactContentReferenceSchema,
  modelProfile: ModelEvaluatorProfileReferenceSchema,
  predecessor: ModelQualificationSuiteReferenceSchema.optional(),
  scenarioCoverage: z
    .array(ModelQualificationScenarioSchema)
    .length(ModelQualificationScenarioSchema.options.length)
    .refine(isStrictlySortedUnique, {
      message: "Model qualification scenario coverage must be complete, unique, and ordered",
    }),
  suiteId: OpaqueIdSchema,
  suiteVersionId: OpaqueIdSchema,
  validFrom: UtcMillisecondTimestampSchema,
  validUntil: UtcMillisecondTimestampSchema,
};

function refineModelQualificationSuite(
  value: {
    readonly predecessor?:
      | { readonly suiteId: string; readonly suiteVersionId: string }
      | undefined;
    readonly scenarioCoverage: readonly z.infer<typeof ModelQualificationScenarioSchema>[];
    readonly suiteId: string;
    readonly suiteVersionId: string;
    readonly validFrom: string;
    readonly validUntil: string;
  },
  context: z.RefinementCtx,
): void {
  if (
    value.scenarioCoverage.some(
      (scenario, index) => scenario !== ModelQualificationScenarioSchema.options[index],
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Model qualification scenario coverage must include every registered scenario",
      path: ["scenarioCoverage"],
    });
  }
  if (evidenceTimestampOrderKey(value.validUntil) <= evidenceTimestampOrderKey(value.validFrom)) {
    context.addIssue({
      code: "custom",
      message: "Model qualification suite validity must have a positive interval",
      path: ["validUntil"],
    });
  }
  if (
    value.predecessor?.suiteId === value.suiteId &&
    value.predecessor.suiteVersionId === value.suiteVersionId
  ) {
    context.addIssue({
      code: "custom",
      message: "A model qualification suite cannot name itself as predecessor",
      path: ["predecessor", "suiteVersionId"],
    });
  }
}

export const ModelQualificationSuiteDefinitionSchema = z
  .object(modelQualificationSuiteDefinitionShape)
  .strict()
  .superRefine(refineModelQualificationSuite);

export const ModelQualificationSuiteSchema = z
  .object({
    ...modelQualificationSuiteDefinitionShape,
    definitionSha256: Sha256Schema,
    publishedAt: UtcMillisecondTimestampSchema,
    publishedByPrincipalId: OpaqueIdSchema,
    schemaVersion: z.literal(MODEL_QUALIFICATION_SUITE_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineModelQualificationSuite);

export type ModelQualificationScenario = z.infer<typeof ModelQualificationScenarioSchema>;
export type ModelQualificationSuiteReference = z.infer<
  typeof ModelQualificationSuiteReferenceSchema
>;
export type ModelQualificationSuiteDefinition = z.infer<
  typeof ModelQualificationSuiteDefinitionSchema
>;
export type ModelQualificationSuite = z.infer<typeof ModelQualificationSuiteSchema>;
