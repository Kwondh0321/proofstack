import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { EvidenceScopeSchema, evidenceTimestampOrderKey } from "./evidence.js";
import { CriterionVersionSelectorSchema } from "./evaluation-criteria.js";
import {
  BlindedEvaluationPlanReferenceSchema,
  CalibrationReportReferenceSchema,
  IndependenceDeclarationReferenceSchema,
  ModelEvaluatorProfileReferenceSchema,
} from "./evaluation-model-assurance.js";
import { EvaluationDatasetVersionReferenceSchema } from "./evaluation-run.js";
import { AssuranceRationaleSchema, AssuranceSummarySchema } from "./evaluation-source.js";
import {
  QualificationFixtureSetReferenceSchema,
  QualificationReportReferenceSchema,
} from "./evaluation-spec.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";

export const MODEL_QUALIFICATION_SUITE_SCHEMA_VERSION = "0.1" as const;
export const MODEL_QUALIFICATION_REPORT_SCHEMA_VERSION = "0.1" as const;
export const MAX_MODEL_QUALIFICATION_CASES = 10_000;

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

export const ModelQualificationReportReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    reportId: OpaqueIdSchema,
  })
  .strict();

const ModelQualificationCountSchema = z.number().int().nonnegative().max(100_000_000);

const modelQualificationReportDefinitionShape = {
  baseQualificationReport: QualificationReportReferenceSchema,
  calibrationReport: CalibrationReportReferenceSchema,
  completedAt: UtcMillisecondTimestampSchema,
  criticalScenarioFailures: z
    .array(ModelQualificationScenarioSchema)
    .max(ModelQualificationScenarioSchema.options.length)
    .refine(isStrictlySortedUnique, {
      message: "Critical model qualification failures must be unique and ordered",
    }),
  environmentEvidence: exactArtifacts(1, 16, "Model qualification environment evidence"),
  evaluator: z
    .object({
      definitionSha256: Sha256Schema,
      evaluatorId: OpaqueIdSchema,
      evaluatorVersionId: OpaqueIdSchema,
    })
    .strict(),
  executedByPrincipalId: OpaqueIdSchema,
  failureReasons: z.array(AssuranceSummarySchema).max(64).refine(isStrictlySortedUnique, {
    message: "Model qualification failure reasons must be unique and ordered",
  }),
  independenceDeclaration: IndependenceDeclarationReferenceSchema,
  knownLimitations: z.array(AssuranceSummarySchema).max(64).refine(isStrictlySortedUnique, {
    message: "Model qualification report limitations must be unique and ordered",
  }),
  modelProfile: ModelEvaluatorProfileReferenceSchema,
  predecessor: ModelQualificationReportReferenceSchema.optional(),
  reportId: OpaqueIdSchema,
  resultManifest: ArtifactContentReferenceSchema,
  resultManifestSchema: ArtifactContentReferenceSchema,
  scenarioCoverage: z
    .array(ModelQualificationScenarioSchema)
    .length(ModelQualificationScenarioSchema.options.length)
    .refine(isStrictlySortedUnique, {
      message: "Model qualification result coverage must be complete, unique, and ordered",
    }),
  startedAt: UtcMillisecondTimestampSchema,
  status: z.enum(["qualified", "unqualified"]),
  statusSummary: z
    .object({
      abstentionAttemptCount: ModelQualificationCountSchema,
      attemptCount: z.number().int().positive().max(100_000_000),
      caseCount: z.number().int().positive().max(MAX_MODEL_QUALIFICATION_CASES),
      disagreementAttemptCount: ModelQualificationCountSchema,
      errorAttemptCount: ModelQualificationCountSchema,
      matchedCaseCount: ModelQualificationCountSchema,
      mismatchedCaseCount: ModelQualificationCountSchema,
      refusalAttemptCount: ModelQualificationCountSchema,
      timeoutAttemptCount: ModelQualificationCountSchema,
      unresolvedDisagreementAttemptCount: ModelQualificationCountSchema,
    })
    .strict(),
  suite: ModelQualificationSuiteReferenceSchema,
  validationEvidence: exactArtifacts(1, 16, "Model qualification result validation evidence"),
  validFrom: UtcMillisecondTimestampSchema,
  validUntil: UtcMillisecondTimestampSchema,
};

function refineModelQualificationReport(
  value: {
    readonly completedAt: string;
    readonly criticalScenarioFailures: readonly string[];
    readonly failureReasons: readonly string[];
    readonly predecessor?: { readonly reportId: string } | undefined;
    readonly reportId: string;
    readonly scenarioCoverage: readonly z.infer<typeof ModelQualificationScenarioSchema>[];
    readonly startedAt: string;
    readonly status: "qualified" | "unqualified";
    readonly statusSummary: {
      readonly abstentionAttemptCount: number;
      readonly attemptCount: number;
      readonly caseCount: number;
      readonly disagreementAttemptCount: number;
      readonly errorAttemptCount: number;
      readonly matchedCaseCount: number;
      readonly mismatchedCaseCount: number;
      readonly refusalAttemptCount: number;
      readonly timeoutAttemptCount: number;
      readonly unresolvedDisagreementAttemptCount: number;
    };
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
      message: "Model qualification result coverage must include every registered scenario",
      path: ["scenarioCoverage"],
    });
  }
  const summary = value.statusSummary;
  if (summary.matchedCaseCount + summary.mismatchedCaseCount !== summary.caseCount) {
    context.addIssue({
      code: "custom",
      message: "Matched and mismatched model qualification cases must equal caseCount",
      path: ["statusSummary", "caseCount"],
    });
  }
  if (summary.attemptCount < summary.caseCount) {
    context.addIssue({
      code: "custom",
      message: "Model qualification attemptCount cannot be smaller than caseCount",
      path: ["statusSummary", "attemptCount"],
    });
  }
  for (const [field, count] of [
    ["abstentionAttemptCount", summary.abstentionAttemptCount],
    ["disagreementAttemptCount", summary.disagreementAttemptCount],
    ["errorAttemptCount", summary.errorAttemptCount],
    ["refusalAttemptCount", summary.refusalAttemptCount],
    ["timeoutAttemptCount", summary.timeoutAttemptCount],
    ["unresolvedDisagreementAttemptCount", summary.unresolvedDisagreementAttemptCount],
  ] as const) {
    if (count > summary.attemptCount) {
      context.addIssue({
        code: "custom",
        message: `${field} cannot exceed model qualification attemptCount`,
        path: ["statusSummary", field],
      });
    }
  }
  const mayQualify =
    summary.mismatchedCaseCount === 0 &&
    summary.unresolvedDisagreementAttemptCount === 0 &&
    value.criticalScenarioFailures.length === 0 &&
    value.failureReasons.length === 0;
  if (value.status === "qualified" && !mayQualify) {
    context.addIssue({
      code: "custom",
      message:
        "Qualified model status requires no mismatches, critical failures, or failure reasons",
      path: ["status"],
    });
  }
  if (value.status === "unqualified" && value.failureReasons.length === 0) {
    context.addIssue({
      code: "custom",
      message: "Unqualified model status requires at least one failure reason",
      path: ["failureReasons"],
    });
  }
  if (evidenceTimestampOrderKey(value.completedAt) < evidenceTimestampOrderKey(value.startedAt)) {
    context.addIssue({
      code: "custom",
      message: "Model qualification completion cannot precede its start",
      path: ["completedAt"],
    });
  }
  if (evidenceTimestampOrderKey(value.validFrom) < evidenceTimestampOrderKey(value.completedAt)) {
    context.addIssue({
      code: "custom",
      message: "Model qualification validity cannot begin before completion",
      path: ["validFrom"],
    });
  }
  if (evidenceTimestampOrderKey(value.validUntil) <= evidenceTimestampOrderKey(value.validFrom)) {
    context.addIssue({
      code: "custom",
      message: "Model qualification validity must have a positive interval",
      path: ["validUntil"],
    });
  }
  if (value.predecessor?.reportId === value.reportId) {
    context.addIssue({
      code: "custom",
      message: "A model qualification report cannot name itself as predecessor",
      path: ["predecessor", "reportId"],
    });
  }
}

export const ModelQualificationReportDefinitionSchema = z
  .object(modelQualificationReportDefinitionShape)
  .strict()
  .superRefine(refineModelQualificationReport);

export const ModelQualificationReportSchema = z
  .object({
    ...modelQualificationReportDefinitionShape,
    definitionSha256: Sha256Schema,
    recordedAt: UtcMillisecondTimestampSchema,
    schemaVersion: z.literal(MODEL_QUALIFICATION_REPORT_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineModelQualificationReport);

export type ModelQualificationReportReference = z.infer<
  typeof ModelQualificationReportReferenceSchema
>;
export type ModelQualificationReportDefinition = z.infer<
  typeof ModelQualificationReportDefinitionSchema
>;
export type ModelQualificationReport = z.infer<typeof ModelQualificationReportSchema>;
