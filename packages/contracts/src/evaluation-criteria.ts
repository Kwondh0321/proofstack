import { z } from "zod";
import { RegressionFixtureVersionReferenceSchema } from "./dataset.js";
import { EvidenceScopeSchema, evidenceTimestampOrderKey } from "./evidence.js";
import {
  AssuranceRationaleSchema,
  AssuranceSummarySchema,
  SourceApplicabilityScopeSchema,
  SourceJurisdictionSchema,
  SourceLocaleSchema,
  SourceReferenceSchema,
  SourceReviewReferenceSchema,
} from "./evaluation-source.js";
import {
  OpaqueIdSchema,
  PostgresTimestampSchema,
  Sha256Schema,
  UtcMillisecondTimestampSchema,
} from "./primitives.js";

export const CRITERION_SET_SCHEMA_VERSION = "0.1" as const;
export const CRITERION_SET_STATUS_SCHEMA_VERSION = "0.1" as const;
export const MAX_CRITERIA_PER_SET = 100;
export const MAX_APPLICABILITY_DEPTH = 8;
export const MAX_APPLICABILITY_NODES = 128;
export const MAX_APPLICABILITY_OPERANDS = 8;

function isStrictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function sortedUnique<T extends z.ZodType<string>>(item: T, maximum: number, label: string) {
  return z
    .array(item)
    .max(maximum)
    .refine(isStrictlySortedUnique, { message: `${label} values must be unique and ordered` });
}

export const EvaluationRiskTierSchema = z.enum(["low", "moderate", "high", "critical"]);
export const CriterionSeveritySchema = z.enum([
  "informational",
  "low",
  "moderate",
  "high",
  "critical",
]);

export const ApplicabilityContextSchema = z
  .object({
    environmentId: OpaqueIdSchema.optional(),
    jurisdiction: SourceJurisdictionSchema.optional(),
    locale: SourceLocaleSchema.optional(),
    populationTags: sortedUnique(AssuranceSummarySchema, 64, "Applicability population tag"),
    riskTier: EvaluationRiskTierSchema.optional(),
    taskKind: OpaqueIdSchema.optional(),
  })
  .strict();

const ApplicabilityEqualsLeafSchema = z.discriminatedUnion("field", [
  z
    .object({
      field: z.literal("environment_id"),
      operator: z.literal("equals"),
      value: OpaqueIdSchema,
    })
    .strict(),
  z
    .object({
      field: z.literal("jurisdiction"),
      operator: z.literal("equals"),
      value: SourceJurisdictionSchema,
    })
    .strict(),
  z
    .object({
      field: z.literal("locale"),
      operator: z.literal("equals"),
      value: SourceLocaleSchema,
    })
    .strict(),
  z
    .object({
      field: z.literal("risk_tier"),
      operator: z.literal("equals"),
      value: EvaluationRiskTierSchema,
    })
    .strict(),
  z
    .object({
      field: z.literal("task_kind"),
      operator: z.literal("equals"),
      value: OpaqueIdSchema,
    })
    .strict(),
]);

const ApplicabilityContainsLeafSchema = z
  .object({
    field: z.literal("population_tags"),
    operator: z.literal("contains"),
    value: AssuranceSummarySchema,
  })
  .strict();

export type ApplicabilityExpression =
  | {
      readonly operands: readonly ApplicabilityExpression[];
      readonly operator: "allOf" | "anyOf";
    }
  | { readonly operand: ApplicabilityExpression; readonly operator: "not" }
  | z.infer<typeof ApplicabilityEqualsLeafSchema>
  | z.infer<typeof ApplicabilityContainsLeafSchema>;

const ApplicabilityExpressionRecursiveSchema: z.ZodType<ApplicabilityExpression> = z.lazy(() =>
  z.union([
    ApplicabilityEqualsLeafSchema,
    ApplicabilityContainsLeafSchema,
    z
      .object({
        operands: z
          .array(ApplicabilityExpressionRecursiveSchema)
          .min(1)
          .max(MAX_APPLICABILITY_OPERANDS),
        operator: z.enum(["allOf", "anyOf"]),
      })
      .strict(),
    z
      .object({
        operand: ApplicabilityExpressionRecursiveSchema,
        operator: z.literal("not"),
      })
      .strict(),
  ]),
);

interface ApplicabilityTraversalFrame {
  readonly depth: number;
  readonly leaving?: boolean;
  readonly value: unknown;
}

function applicabilityComplexityViolation(value: unknown): string | undefined {
  const activeObjects = new WeakSet<object>();
  const stack: ApplicabilityTraversalFrame[] = [{ depth: 0, value }];
  let nodes = 0;

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    if (frame.leaving) {
      if (typeof frame.value === "object" && frame.value !== null) {
        activeObjects.delete(frame.value);
      }
      continue;
    }

    nodes += 1;
    if (nodes > MAX_APPLICABILITY_NODES) {
      return `Applicability expressions cannot exceed ${MAX_APPLICABILITY_NODES} nodes`;
    }
    if (frame.depth > MAX_APPLICABILITY_DEPTH) {
      return `Applicability expressions cannot exceed ${MAX_APPLICABILITY_DEPTH} levels`;
    }
    if (typeof frame.value !== "object" || frame.value === null) continue;
    if (activeObjects.has(frame.value)) return "Applicability expressions cannot contain cycles";

    activeObjects.add(frame.value);
    stack.push({ ...frame, leaving: true });
    const children = Array.isArray(frame.value) ? frame.value : Object.values(frame.value);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ depth: frame.depth + 1, value: children[index] });
    }
  }
  return undefined;
}

export const ApplicabilityExpressionSchema: z.ZodType<ApplicabilityExpression> = z.preprocess(
  (value, context) => {
    const violation = applicabilityComplexityViolation(value);
    if (!violation) return value;
    context.addIssue({ code: "custom", message: violation });
    return null;
  },
  ApplicabilityExpressionRecursiveSchema,
) as z.ZodType<ApplicabilityExpression>;

export const ApplicabilityResultSchema = z.enum(["applicable", "not_applicable", "undetermined"]);

export const ExactDecimalSchema = z
  .string()
  .max(64)
  .regex(/^-?(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/);

export const MetricExpectationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      direction: z.enum(["at_least", "at_most", "equal", "greater_than", "less_than"]),
      kind: z.literal("numeric"),
      metricName: AssuranceSummarySchema,
      threshold: ExactDecimalSchema,
      unit: AssuranceSummarySchema,
    })
    .strict(),
  z
    .object({
      expected: z.boolean(),
      kind: z.literal("boolean"),
      metricName: AssuranceSummarySchema,
    })
    .strict(),
  z
    .object({
      allowedValues: z.array(AssuranceSummarySchema).min(1).max(64).refine(isStrictlySortedUnique, {
        message: "Categorical metric values must be unique and ordered",
      }),
      kind: z.literal("categorical"),
      metricName: AssuranceSummarySchema,
    })
    .strict(),
]);

export const EvidenceClassSchema = z.enum([
  "artifact",
  "deterministic_oracle",
  "human_review",
  "model_assisted_observation",
  "replay_result",
  "source_snapshot",
  "statistical_aggregate",
]);

export const OracleReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    oracleId: OpaqueIdSchema,
    oracleVersionId: OpaqueIdSchema,
  })
  .strict();

export const EvaluatorReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    evaluatorId: OpaqueIdSchema,
    evaluatorVersionId: OpaqueIdSchema,
  })
  .strict();

export const QualifiedSourceReferenceSchema = z
  .object({
    review: SourceReviewReferenceSchema,
    source: SourceReferenceSchema,
  })
  .strict();

export const CriterionQualificationFixtureSchema = z
  .object({
    caseKind: z.enum(["boundary", "negative", "not_applicable", "positive"]),
    expectedVerdict: z.enum(["fail", "not_applicable", "pass"]),
    fixture: RegressionFixtureVersionReferenceSchema,
    fixtureCaseId: OpaqueIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.caseKind === "positive" && value.expectedVerdict !== "pass") {
      context.addIssue({
        code: "custom",
        message: "A positive qualification fixture must expect pass",
        path: ["expectedVerdict"],
      });
    }
    if (value.caseKind === "negative" && value.expectedVerdict !== "fail") {
      context.addIssue({
        code: "custom",
        message: "A negative qualification fixture must expect fail",
        path: ["expectedVerdict"],
      });
    }
    if (value.caseKind === "not_applicable" && value.expectedVerdict !== "not_applicable") {
      context.addIssue({
        code: "custom",
        message: "A not-applicable qualification fixture must preserve that outcome",
        path: ["expectedVerdict"],
      });
    }
  });

const criterionShape = {
  applicability: ApplicabilityExpressionSchema,
  assumptions: sortedUnique(AssuranceSummarySchema, 64, "Criterion assumption"),
  claim: AssuranceRationaleSchema,
  counterevidence: z
    .array(SourceReferenceSchema)
    .max(64)
    .refine(
      (references) =>
        isStrictlySortedUnique(
          references.map(
            ({ definitionSha256, sourceSnapshotId }) => `${sourceSnapshotId}:${definitionSha256}`,
          ),
        ),
      { message: "Criterion counterevidence must be unique and ordered" },
    ),
  counterexamples: sortedUnique(AssuranceSummarySchema, 64, "Criterion counterexample"),
  criterionId: OpaqueIdSchema,
  disqualifyingConditions: sortedUnique(
    AssuranceSummarySchema,
    64,
    "Criterion disqualifying condition",
  ),
  evaluator: EvaluatorReferenceSchema,
  independentQuorum: z.number().int().positive().max(16),
  knownAmbiguities: sortedUnique(AssuranceSummarySchema, 64, "Criterion ambiguity"),
  metric: MetricExpectationSchema,
  oracle: OracleReferenceSchema,
  qualificationFixtures: z.array(CriterionQualificationFixtureSchema).min(4).max(256),
  requiredEvidenceClasses: z
    .array(EvidenceClassSchema)
    .min(1)
    .max(EvidenceClassSchema.options.length)
    .refine(isStrictlySortedUnique, {
      message: "Required evidence classes must be unique and ordered",
    }),
  severity: CriterionSeveritySchema,
  thresholdRationale: AssuranceRationaleSchema,
};

function refineCriterion(
  value: {
    readonly qualificationFixtures: readonly {
      readonly caseKind: "boundary" | "negative" | "not_applicable" | "positive";
      readonly fixture: { readonly fixtureVersionId: string };
      readonly fixtureCaseId: string;
    }[];
  },
  context: z.RefinementCtx,
): void {
  const caseIds = value.qualificationFixtures.map(({ fixtureCaseId }) => fixtureCaseId);
  if (!isStrictlySortedUnique(caseIds)) {
    context.addIssue({
      code: "custom",
      message: "Qualification fixture case identifiers must be unique and ordered",
      path: ["qualificationFixtures"],
    });
  }
  const fixtureVersionIds = value.qualificationFixtures.map(
    ({ fixture }) => fixture.fixtureVersionId,
  );
  if (new Set(fixtureVersionIds).size !== fixtureVersionIds.length) {
    context.addIssue({
      code: "custom",
      message: "Qualification fixtures must use distinct exact fixture versions",
      path: ["qualificationFixtures"],
    });
  }
  const kinds = new Set(value.qualificationFixtures.map(({ caseKind }) => caseKind));
  for (const requiredKind of ["positive", "negative", "boundary", "not_applicable"] as const) {
    if (!kinds.has(requiredKind)) {
      context.addIssue({
        code: "custom",
        message: `Criterion qualification requires a ${requiredKind} fixture`,
        path: ["qualificationFixtures"],
      });
    }
  }
}

export const CriterionDefinitionSchema = z
  .object(criterionShape)
  .strict()
  .superRefine(refineCriterion);

export const CriterionSetReferenceSchema = z
  .object({
    criterionSetId: OpaqueIdSchema,
    criterionSetVersionId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
  })
  .strict();

export const CriterionReferenceSchema = z
  .object({
    criterionId: OpaqueIdSchema,
    criterionSet: CriterionSetReferenceSchema,
  })
  .strict();

const criterionSetDefinitionShape = {
  applicabilityScope: SourceApplicabilityScopeSchema,
  assumptions: sortedUnique(AssuranceSummarySchema, 64, "Criterion set assumption"),
  changeRationale: AssuranceRationaleSchema,
  criteria: z.array(CriterionDefinitionSchema).min(1).max(MAX_CRITERIA_PER_SET),
  criterionSetId: OpaqueIdSchema,
  criterionSetVersionId: OpaqueIdSchema,
  exclusions: sortedUnique(AssuranceSummarySchema, 64, "Criterion set exclusion"),
  intendedUse: AssuranceRationaleSchema,
  issuer: AssuranceSummarySchema,
  knownLimitations: sortedUnique(AssuranceSummarySchema, 64, "Criterion set limitation"),
  predecessor: CriterionSetReferenceSchema.optional(),
  purpose: AssuranceRationaleSchema,
  riskTier: EvaluationRiskTierSchema,
  sources: z.array(QualifiedSourceReferenceSchema).min(1).max(64),
};

function refineCriterionSet(
  value: {
    readonly criteria: readonly {
      readonly counterevidence: readonly {
        readonly definitionSha256: string;
        readonly sourceSnapshotId: string;
      }[];
      readonly criterionId: string;
    }[];
    readonly criterionSetId: string;
    readonly criterionSetVersionId: string;
    readonly predecessor?:
      | { readonly criterionSetId: string; readonly criterionSetVersionId: string }
      | undefined;
    readonly sources: readonly {
      readonly review: { readonly sourceReviewId: string };
      readonly source: { readonly definitionSha256: string; readonly sourceSnapshotId: string };
    }[];
  },
  context: z.RefinementCtx,
): void {
  const criterionIds = value.criteria.map(({ criterionId }) => criterionId);
  if (!isStrictlySortedUnique(criterionIds)) {
    context.addIssue({
      code: "custom",
      message: "Criteria must be unique and ordered by criterionId",
      path: ["criteria"],
    });
  }
  const sourceIdentities = value.sources.map(
    ({ review, source }) => `${source.sourceSnapshotId}:${review.sourceReviewId}`,
  );
  if (!isStrictlySortedUnique(sourceIdentities)) {
    context.addIssue({
      code: "custom",
      message: "Qualified sources must be unique and ordered",
      path: ["sources"],
    });
  }
  const sourceIds = value.sources.map(({ source }) => source.sourceSnapshotId);
  const reviewIds = value.sources.map(({ review }) => review.sourceReviewId);
  if (
    new Set(sourceIds).size !== sourceIds.length ||
    new Set(reviewIds).size !== reviewIds.length
  ) {
    context.addIssue({
      code: "custom",
      message: "A criterion set must bind each source and review exactly once",
      path: ["sources"],
    });
  }
  const availableSources = new Map(
    value.sources.map(({ source }) => [source.sourceSnapshotId, source.definitionSha256]),
  );
  value.criteria.forEach((criterion, criterionIndex) => {
    criterion.counterevidence.forEach(
      ({ definitionSha256, sourceSnapshotId }, counterevidenceIndex) => {
        if (availableSources.get(sourceSnapshotId) !== definitionSha256) {
          context.addIssue({
            code: "custom",
            message: "Criterion counterevidence must match an exact criterion set source",
            path: ["criteria", criterionIndex, "counterevidence", counterevidenceIndex],
          });
        }
      },
    );
  });
  if (value.predecessor) {
    if (value.predecessor.criterionSetId !== value.criterionSetId) {
      context.addIssue({
        code: "custom",
        message: "A criterion set predecessor must retain the logical criterionSetId",
        path: ["predecessor", "criterionSetId"],
      });
    }
    if (value.predecessor.criterionSetVersionId === value.criterionSetVersionId) {
      context.addIssue({
        code: "custom",
        message: "A criterion set version cannot name itself as predecessor",
        path: ["predecessor", "criterionSetVersionId"],
      });
    }
  }
}

export const CriterionSetDefinitionSchema = z
  .object(criterionSetDefinitionShape)
  .strict()
  .superRefine(refineCriterionSet);

export const CriterionSetSchema = z
  .object({
    ...criterionSetDefinitionShape,
    definitionSha256: Sha256Schema,
    publishedAt: UtcMillisecondTimestampSchema,
    publishedByPrincipalId: OpaqueIdSchema,
    schemaVersion: z.literal(CRITERION_SET_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineCriterionSet);

export const CriterionSetStatusReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    statusRecordId: OpaqueIdSchema,
  })
  .strict();

const criterionSetStatusShape = {
  criterionSet: CriterionSetReferenceSchema,
  effectiveAt: PostgresTimestampSchema,
  expiresAt: PostgresTimestampSchema.optional(),
  previousStatus: CriterionSetStatusReferenceSchema.optional(),
  rationale: AssuranceRationaleSchema,
  status: z.enum(["approved", "contested", "draft", "qualified", "superseded", "withdrawn"]),
  statusRecordId: OpaqueIdSchema,
  supersededBy: CriterionSetReferenceSchema.optional(),
};

function refineCriterionSetStatus(
  value: {
    readonly criterionSet: {
      readonly criterionSetId: string;
      readonly criterionSetVersionId: string;
    };
    readonly effectiveAt: string;
    readonly expiresAt?: string | undefined;
    readonly previousStatus?: { readonly statusRecordId: string } | undefined;
    readonly status: "approved" | "contested" | "draft" | "qualified" | "superseded" | "withdrawn";
    readonly statusRecordId: string;
    readonly supersededBy?:
      | { readonly criterionSetId: string; readonly criterionSetVersionId: string }
      | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (
    value.expiresAt &&
    evidenceTimestampOrderKey(value.expiresAt) <= evidenceTimestampOrderKey(value.effectiveAt)
  ) {
    context.addIssue({
      code: "custom",
      message: "Criterion set status expiry must be after its effective time",
      path: ["expiresAt"],
    });
  }
  if (value.status === "superseded" && !value.supersededBy) {
    context.addIssue({
      code: "custom",
      message: "A superseded criterion set status requires the exact successor",
      path: ["supersededBy"],
    });
  }
  if (value.status === "draft" && value.previousStatus) {
    context.addIssue({
      code: "custom",
      message: "The initial draft status cannot name a previous status",
      path: ["previousStatus"],
    });
  }
  if (value.status !== "draft" && !value.previousStatus) {
    context.addIssue({
      code: "custom",
      message: "A non-draft criterion set status requires the exact previous status",
      path: ["previousStatus"],
    });
  }
  if (value.previousStatus?.statusRecordId === value.statusRecordId) {
    context.addIssue({
      code: "custom",
      message: "A criterion set status cannot name itself as its previous status",
      path: ["previousStatus", "statusRecordId"],
    });
  }
  if (value.status !== "superseded" && value.supersededBy) {
    context.addIssue({
      code: "custom",
      message: "Only a superseded criterion set status may name a successor",
      path: ["supersededBy"],
    });
  }
  if (value.supersededBy?.criterionSetVersionId === value.criterionSet.criterionSetVersionId) {
    context.addIssue({
      code: "custom",
      message: "A criterion set version cannot supersede itself",
      path: ["supersededBy", "criterionSetVersionId"],
    });
  }
  if (
    value.supersededBy &&
    value.supersededBy.criterionSetId !== value.criterionSet.criterionSetId
  ) {
    context.addIssue({
      code: "custom",
      message: "A superseding version must retain the logical criterionSetId",
      path: ["supersededBy", "criterionSetId"],
    });
  }
}

export const CriterionSetStatusDefinitionSchema = z
  .object(criterionSetStatusShape)
  .strict()
  .superRefine(refineCriterionSetStatus);

export const CriterionSetStatusRecordSchema = z
  .object({
    ...criterionSetStatusShape,
    definitionSha256: Sha256Schema,
    recordedAt: UtcMillisecondTimestampSchema,
    recordedByPrincipalId: OpaqueIdSchema,
    schemaVersion: z.literal(CRITERION_SET_STATUS_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineCriterionSetStatus);

export type ApplicabilityContext = z.infer<typeof ApplicabilityContextSchema>;
export type ApplicabilityResult = z.infer<typeof ApplicabilityResultSchema>;
export type CriterionDefinition = z.infer<typeof CriterionDefinitionSchema>;
export type CriterionSet = z.infer<typeof CriterionSetSchema>;
export type CriterionSetDefinition = z.infer<typeof CriterionSetDefinitionSchema>;
export type CriterionSetReference = z.infer<typeof CriterionSetReferenceSchema>;
export type CriterionSetStatusRecord = z.infer<typeof CriterionSetStatusRecordSchema>;
export type EvaluatorReference = z.infer<typeof EvaluatorReferenceSchema>;
export type OracleReference = z.infer<typeof OracleReferenceSchema>;
