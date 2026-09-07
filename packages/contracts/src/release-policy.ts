import { z } from "zod";
import { ArtifactContentReferenceSchema, ArtifactMediaTypeSchema } from "./artifact.js";
import { AssessmentReferenceSchema } from "./evaluation-assessment.js";
import {
  COMPARISON_COUNT_METRIC_UNITS,
  COMPARISON_REPLAY_USAGE_UNITS,
  ComparisonDefinitionReferenceSchema,
} from "./evaluation-comparison.js";
import {
  CriterionSeveritySchema,
  EvaluationRiskTierSchema,
  ExactDecimalSchema,
  QualifiedSourceReferenceSchema,
} from "./evaluation-criteria.js";
import { ModelAssuranceAssessmentReferenceSchema } from "./evaluation-model-assessment.js";
import {
  AssuranceRationaleSchema,
  AssuranceSummarySchema,
  SourceJurisdictionSchema,
  SourceLocaleSchema,
} from "./evaluation-source.js";
import {
  DataClassificationSchema,
  EvidenceScopeSchema,
  evidenceTimestampOrderKey,
} from "./evidence.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";

export const POLICY_INSTALLATION_BINDING_SCHEMA_VERSION = "0.1" as const;
export const RELEASE_POLICY_SCHEMA_VERSION = "0.1" as const;
export const RELEASE_POLICY_LIFECYCLE_SCHEMA_VERSION = "0.1" as const;
export const MAX_POLICY_APPLICABILITY_VALUES = 64;
export const MAX_POLICY_APPROVAL_GROUPS = 32;
export const MAX_POLICY_APPROVAL_ROLES = 32;
export const MAX_POLICY_RULES = 128;
export const MAX_POLICY_SOURCES = 64;
export const MAX_POLICY_TEXT_VALUES = 64;

const MAX_POLICY_COUNT = Number.MAX_SAFE_INTEGER;

function isStrictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function sortedUniqueStrings<T extends z.ZodType<string>>(
  item: T,
  minimum: number,
  maximum: number,
  label: string,
) {
  return z
    .array(item)
    .min(minimum)
    .max(maximum)
    .refine(isStrictlySortedUnique, { message: `${label} values must be unique and ordered` });
}

function qualifiedSourceKey(value: z.infer<typeof QualifiedSourceReferenceSchema>): string {
  return [
    value.source.sourceSnapshotId,
    value.source.definitionSha256,
    value.review.sourceReviewId,
    value.review.definitionSha256,
  ].join(":");
}

function sortedQualifiedSources(minimum: number, label: string) {
  return z
    .array(QualifiedSourceReferenceSchema)
    .min(minimum)
    .max(MAX_POLICY_SOURCES)
    .refine((values) => isStrictlySortedUnique(values.map(qualifiedSourceKey)), {
      message: `${label} must be unique and ordered by exact source and review identity`,
    });
}

function compareTimestamp(left: string, right: string): number {
  const leftKey = evidenceTimestampOrderKey(left);
  const rightKey = evidenceTimestampOrderKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export const ReleasePolicyModeSchema = z.enum(["advisory", "mandatory"]);

export const PolicyInstallationBindingReferenceSchema = z
  .object({
    bindingVersionId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
    installationId: OpaqueIdSchema,
  })
  .strict();

const policyInstallationBindingDefinitionShape = {
  allowedModes: sortedUniqueStrings(
    ReleasePolicyModeSchema,
    1,
    ReleasePolicyModeSchema.options.length,
    "Allowed policy mode",
  ),
  authorityEvidence: ArtifactContentReferenceSchema,
  authorizedIssuerPrincipalIds: sortedUniqueStrings(
    OpaqueIdSchema,
    1,
    64,
    "Authorized policy issuer",
  ),
  bindingVersionId: OpaqueIdSchema,
  effectiveAt: UtcMillisecondTimestampSchema,
  expiresAt: UtcMillisecondTimestampSchema,
  installationId: OpaqueIdSchema,
  scope: EvidenceScopeSchema,
};

function refinePositiveValidityInterval(
  value: { readonly effectiveAt: string; readonly expiresAt: string },
  context: z.RefinementCtx,
): void {
  if (compareTimestamp(value.effectiveAt, value.expiresAt) >= 0) {
    context.addIssue({
      code: "custom",
      message: "The effective policy interval must end after it begins",
      path: ["expiresAt"],
    });
  }
}

export const PolicyInstallationBindingDefinitionSchema = z
  .object(policyInstallationBindingDefinitionShape)
  .strict()
  .superRefine(refinePositiveValidityInterval);

export const PolicyInstallationBindingSchema = z
  .object({
    ...policyInstallationBindingDefinitionShape,
    definitionSha256: Sha256Schema,
    registeredAt: UtcMillisecondTimestampSchema,
    registeredByPrincipalId: OpaqueIdSchema,
    schemaVersion: z.literal(POLICY_INSTALLATION_BINDING_SCHEMA_VERSION),
  })
  .strict()
  .superRefine((value, context) => {
    refinePositiveValidityInterval(value, context);
    if (compareTimestamp(value.registeredAt, value.expiresAt) >= 0) {
      context.addIssue({
        code: "custom",
        message: "An installation binding cannot be registered at or after its expiry",
        path: ["registeredAt"],
      });
    }
  });

const policySemanticVersionPattern =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[a-z-][0-9a-z-]*)(?:\.(?:0|[1-9][0-9]*|[a-z-][0-9a-z-]*))*)?$/u;

export const ReleasePolicySemanticVersionSchema = z
  .string()
  .max(128)
  .regex(policySemanticVersionPattern, {
    message: "Policy versions must use normalized SemVer without build metadata",
  });

export const ReleasePolicyExactDecimalSchema = ExactDecimalSchema.refine(
  (value) => {
    const unsigned = value.startsWith("-") ? value.slice(1) : value;
    const [whole, fraction] = unsigned.split(".");
    if (whole === "0" && (!fraction || /^0+$/u.test(fraction)) && value.startsWith("-")) {
      return false;
    }
    return fraction === undefined || !fraction.endsWith("0");
  },
  {
    message:
      "Policy decimals must use the unique exact representation without negative zero or trailing fractional zeros",
  },
);

function scalarSelector<T extends z.ZodType<string>>(item: T, label: string) {
  return z.discriminatedUnion("operator", [
    z.object({ operator: z.literal("any") }).strict(),
    z.object({ operator: z.literal("equals"), value: item }).strict(),
    z
      .object({
        operator: z.literal("one_of"),
        values: sortedUniqueStrings(item, 1, MAX_POLICY_APPLICABILITY_VALUES, label),
      })
      .strict(),
  ]);
}

function optionalScalarSelector<T extends z.ZodType<string>>(item: T, label: string) {
  return z.discriminatedUnion("operator", [
    z.object({ operator: z.literal("any") }).strict(),
    z.object({ operator: z.literal("absent") }).strict(),
    z.object({ operator: z.literal("equals"), value: item }).strict(),
    z
      .object({
        operator: z.literal("one_of"),
        values: sortedUniqueStrings(item, 1, MAX_POLICY_APPLICABILITY_VALUES, label),
      })
      .strict(),
  ]);
}

export const PolicyPopulationSelectorSchema = z.discriminatedUnion("operator", [
  z.object({ operator: z.literal("any") }).strict(),
  z
    .object({
      operator: z.literal("contains_all"),
      values: sortedUniqueStrings(
        AssuranceSummarySchema,
        1,
        MAX_POLICY_APPLICABILITY_VALUES,
        "Required population label",
      ),
    })
    .strict(),
  z
    .object({
      operator: z.literal("exactly"),
      values: sortedUniqueStrings(
        AssuranceSummarySchema,
        0,
        MAX_POLICY_APPLICABILITY_VALUES,
        "Exact population label",
      ),
    })
    .strict(),
]);

export const ReleasePolicyApplicabilitySchema = z
  .object({
    jurisdiction: optionalScalarSelector(SourceJurisdictionSchema, "Policy jurisdiction"),
    locale: optionalScalarSelector(SourceLocaleSchema, "Policy locale"),
    maximumDataClassification: scalarSelector(
      DataClassificationSchema,
      "Policy data classification",
    ),
    populationTags: PolicyPopulationSelectorSchema,
    purpose: scalarSelector(AssuranceRationaleSchema, "Policy purpose"),
    riskTier: scalarSelector(EvaluationRiskTierSchema, "Policy risk tier"),
    taskKind: scalarSelector(OpaqueIdSchema, "Policy task kind"),
  })
  .strict();

export const ReleasePolicyUnitSchema = z.enum([
  "artifacts",
  "assurance_records",
  "attempts",
  "basis_points",
  "bytes",
  "calls",
  "cases",
  "evaluation_outcomes",
  "events",
  "interactions",
  "milliseconds",
  "provider_cost_microunits",
  "requests",
  "tokens",
]);

const policyComparisonMetricKinds = [
  "artifact_set",
  "assurance_state_count",
  "coverage_count",
  "evaluation_verdict_count",
  "replay_usage",
  "safety_event_count",
  "trace_event_count",
] as const;

export const ReleasePolicyComparisonMetricKindSchema = z.enum(policyComparisonMetricKinds);

const allowedUnitsByMetricKind: Readonly<
  Record<(typeof policyComparisonMetricKinds)[number], Set<string>>
> = {
  artifact_set: new Set([COMPARISON_COUNT_METRIC_UNITS.artifact_set]),
  assurance_state_count: new Set([COMPARISON_COUNT_METRIC_UNITS.assurance_state_count]),
  coverage_count: new Set([COMPARISON_COUNT_METRIC_UNITS.coverage_count]),
  evaluation_verdict_count: new Set([COMPARISON_COUNT_METRIC_UNITS.evaluation_verdict_count]),
  replay_usage: new Set(Object.values(COMPARISON_REPLAY_USAGE_UNITS)),
  safety_event_count: new Set([COMPARISON_COUNT_METRIC_UNITS.safety_event_count]),
  trace_event_count: new Set([COMPARISON_COUNT_METRIC_UNITS.trace_event_count]),
};

export const ReleasePolicyComparatorSchema = z.enum([
  "equal",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
  "not_equal",
]);

const PolicyComparisonThresholdPredicateSchema = z
  .object({
    comparator: ReleasePolicyComparatorSchema,
    comparison: ComparisonDefinitionReferenceSchema,
    kind: z.literal("comparison_threshold"),
    metricId: OpaqueIdSchema,
    metricKind: ReleasePolicyComparisonMetricKindSchema,
    operand: z.enum(["baseline", "candidate", "delta"]),
    threshold: ReleasePolicyExactDecimalSchema,
    unit: ReleasePolicyUnitSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!allowedUnitsByMetricKind[value.metricKind].has(value.unit)) {
      context.addIssue({
        code: "custom",
        message: "Policy threshold unit is incompatible with the selected comparison metric kind",
        path: ["unit"],
      });
    }
  });

const PolicyCoverageFloorPredicateSchema = z.discriminatedUnion("sourceKind", [
  z
    .object({
      comparison: ComparisonDefinitionReferenceSchema,
      kind: z.literal("coverage_floor"),
      metricId: OpaqueIdSchema,
      minimumCount: z.number().int().nonnegative().max(MAX_POLICY_COUNT),
      sampleClass: z.enum([
        "baseline_observed",
        "candidate_observed",
        "paired_observed",
        "paired_total",
      ]),
      sourceKind: z.literal("comparison_metric_samples"),
      unit: z.literal("cases"),
    })
    .strict(),
  z
    .object({
      comparison: ComparisonDefinitionReferenceSchema,
      denominator: z.enum(["baseline_total", "candidate_total", "paired_total"]),
      kind: z.literal("coverage_floor"),
      metricId: OpaqueIdSchema,
      minimumBasisPoints: z.number().int().min(1).max(10_000),
      numerator: z.enum(["baseline_observed", "candidate_observed", "paired_observed"]),
      sourceKind: z.literal("comparison_metric_ratio"),
      unit: z.literal("basis_points"),
    })
    .strict()
    .superRefine((value, context) => {
      const role = value.numerator.split("_")[0];
      if (role !== "paired" && value.denominator !== `${role}_total`) {
        context.addIssue({
          code: "custom",
          message: "Coverage numerator and denominator must use the same metric population",
          path: ["denominator"],
        });
      }
      if (role === "paired" && value.denominator !== "paired_total") {
        context.addIssue({
          code: "custom",
          message: "Paired coverage must use the paired metric population",
          path: ["denominator"],
        });
      }
    }),
  z
    .object({
      assessment: AssessmentReferenceSchema,
      kind: z.literal("coverage_floor"),
      minimumCount: z.number().int().nonnegative().max(MAX_POLICY_COUNT),
      sampleClass: z.enum(["decided", "observed"]),
      sourceKind: z.literal("assessment_samples"),
      unit: z.literal("cases"),
    })
    .strict(),
]);

const PolicyUncertaintyBoundPredicateSchema = z
  .object({
    assessment: AssessmentReferenceSchema,
    bound: z.enum(["lower", "upper"]),
    comparator: z.enum(["at_least", "at_most"]),
    confidenceLevelBasisPoints: z.number().int().min(5_000).max(9_999),
    intervalMethod: z.literal("wilson_score_interval"),
    intervalMethodVersion: z.literal("1.0.0"),
    kind: z.literal("uncertainty_bound"),
    thresholdBasisPoints: z.number().int().min(0).max(10_000),
    unit: z.literal("basis_points"),
  })
  .strict();

const PolicyEligibilityRequiredPredicateSchema = z.discriminatedUnion("assessmentClass", [
  z
    .object({
      assessment: AssessmentReferenceSchema,
      assessmentClass: z.literal("evaluation"),
      expected: z.literal("eligible"),
      kind: z.literal("eligibility_required"),
    })
    .strict(),
  z
    .object({
      assessment: ModelAssuranceAssessmentReferenceSchema,
      assessmentClass: z.literal("model_assurance"),
      expected: z.literal("eligible"),
      kind: z.literal("eligibility_required"),
    })
    .strict(),
]);

const PolicyArtifactRequiredPredicateSchema = z
  .object({
    allowedMediaTypes: sortedUniqueStrings(
      ArtifactMediaTypeSchema,
      1,
      32,
      "Allowed policy artifact media type",
    ),
    componentKind: z.enum(["build_artifact", "model_resolution", "prompt", "tool_contract"]),
    kind: z.literal("artifact_required"),
    maximumDataClassification: DataClassificationSchema,
    requireDigest: z.literal(true),
    role: OpaqueIdSchema,
  })
  .strict();

const PolicySafetyEventCeilingPredicateSchema = z
  .object({
    comparison: ComparisonDefinitionReferenceSchema,
    eventClass: z.enum(["guardrail_check", "replay_safety_intervention", "uncertain_side_effect"]),
    kind: z.literal("safety_event_ceiling"),
    maximumCount: z.number().int().nonnegative().max(MAX_POLICY_COUNT),
    metricId: OpaqueIdSchema,
    unit: z.literal("events"),
  })
  .strict();

export const PolicyApprovalRequirementSchema = z
  .object({
    conflictRule: z.literal("reject_declared_conflict"),
    excludeCandidateAuthor: z.boolean(),
    excludePolicyAuthor: z.literal(true),
    humanReviewerGroupIds: sortedUniqueStrings(
      OpaqueIdSchema,
      0,
      MAX_POLICY_APPROVAL_GROUPS,
      "Human reviewer group",
    ),
    independenceGroupIds: sortedUniqueStrings(
      OpaqueIdSchema,
      1,
      MAX_POLICY_APPROVAL_GROUPS,
      "Approval independence group",
    ),
    kind: z.literal("approval_required"),
    quorum: z.number().int().positive().max(MAX_POLICY_APPROVAL_ROLES),
    reviewerRoleIds: sortedUniqueStrings(
      OpaqueIdSchema,
      1,
      MAX_POLICY_APPROVAL_ROLES,
      "Approval reviewer role",
    ),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.quorum > value.independenceGroupIds.length) {
      context.addIssue({
        code: "custom",
        message: "Approval quorum cannot exceed the number of eligible independence groups",
        path: ["quorum"],
      });
    }
    const independenceGroups = new Set(value.independenceGroupIds);
    if (value.humanReviewerGroupIds.some((groupId) => !independenceGroups.has(groupId))) {
      context.addIssue({
        code: "custom",
        message: "Every human reviewer group must be an eligible independence group",
        path: ["humanReviewerGroupIds"],
      });
    }
  });

export const ReleasePolicyPredicateSchema = z.union([
  PolicyComparisonThresholdPredicateSchema,
  PolicyCoverageFloorPredicateSchema,
  PolicyUncertaintyBoundPredicateSchema,
  PolicyEligibilityRequiredPredicateSchema,
  PolicyArtifactRequiredPredicateSchema,
  PolicySafetyEventCeilingPredicateSchema,
  PolicyApprovalRequirementSchema,
]);

export const ReleasePolicyRuleSchema = z
  .object({
    nonWaivable: z.boolean(),
    predicate: ReleasePolicyPredicateSchema,
    rationale: AssuranceRationaleSchema,
    ruleId: OpaqueIdSchema,
    severity: CriterionSeveritySchema,
    sources: sortedQualifiedSources(1, "Policy rule sources"),
  })
  .strict();

export const ReleasePolicyReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    policyId: OpaqueIdSchema,
    policyVersionId: OpaqueIdSchema,
  })
  .strict();

function applicabilityCoversHighRisk(
  selector: z.infer<typeof ReleasePolicyApplicabilitySchema>["riskTier"],
): boolean {
  if (selector.operator === "any") return true;
  if (selector.operator === "equals")
    return selector.value === "high" || selector.value === "critical";
  return selector.values.includes("high") || selector.values.includes("critical");
}

const releasePolicySharedShape = {
  applicability: ReleasePolicyApplicabilitySchema,
  assumptions: sortedUniqueStrings(
    AssuranceSummarySchema,
    0,
    MAX_POLICY_TEXT_VALUES,
    "Policy assumption",
  ),
  changeRationale: AssuranceRationaleSchema,
  contentProjection: z.literal("references_and_bounded_metadata_only"),
  counterevidence: sortedQualifiedSources(0, "Policy counterevidence"),
  description: AssuranceSummarySchema.optional(),
  effectiveAt: UtcMillisecondTimestampSchema,
  exclusions: sortedUniqueStrings(
    AssuranceSummarySchema,
    0,
    MAX_POLICY_TEXT_VALUES,
    "Policy exclusion",
  ),
  expiresAt: UtcMillisecondTimestampSchema,
  installationBinding: PolicyInstallationBindingReferenceSchema,
  knownLimitations: sortedUniqueStrings(
    AssuranceSummarySchema,
    0,
    MAX_POLICY_TEXT_VALUES,
    "Policy limitation",
  ),
  mode: ReleasePolicyModeSchema,
  name: AssuranceSummarySchema,
  rationale: AssuranceRationaleSchema,
  rules: z
    .array(ReleasePolicyRuleSchema)
    .min(1)
    .max(MAX_POLICY_RULES)
    .refine((rules) => isStrictlySortedUnique(rules.map(({ ruleId }) => ruleId)), {
      message: "Policy rules must be unique and ordered by ruleId",
    }),
  semanticVersion: ReleasePolicySemanticVersionSchema,
  sources: sortedQualifiedSources(1, "Policy sources"),
};

interface ReleasePolicyShared {
  readonly applicability: z.infer<typeof ReleasePolicyApplicabilitySchema>;
  readonly counterevidence: readonly z.infer<typeof QualifiedSourceReferenceSchema>[];
  readonly effectiveAt: string;
  readonly expiresAt: string;
  readonly rules: readonly z.infer<typeof ReleasePolicyRuleSchema>[];
  readonly sources: readonly z.infer<typeof QualifiedSourceReferenceSchema>[];
}

function refineReleasePolicyShared(value: ReleasePolicyShared, context: z.RefinementCtx): void {
  refinePositiveValidityInterval(value, context);

  const policySources = new Set(value.sources.map(qualifiedSourceKey));
  const counterevidence = new Set(value.counterevidence.map(qualifiedSourceKey));
  for (const [index, rule] of value.rules.entries()) {
    for (const source of rule.sources) {
      if (!policySources.has(qualifiedSourceKey(source))) {
        context.addIssue({
          code: "custom",
          message: "Every rule source must be present in the policy source set",
          path: ["rules", index, "sources"],
        });
      }
    }
  }
  for (const source of policySources) {
    if (counterevidence.has(source)) {
      context.addIssue({
        code: "custom",
        message:
          "A qualified source cannot simultaneously be supporting evidence and counterevidence",
        path: ["counterevidence"],
      });
      break;
    }
  }

  const approvalRules = value.rules.filter(
    ({ predicate }) => predicate.kind === "approval_required",
  );
  if (approvalRules.length > 1) {
    context.addIssue({
      code: "custom",
      message: "A policy definition can contain at most one approval requirement",
      path: ["rules"],
    });
  }
  if (applicabilityCoversHighRisk(value.applicability.riskTier)) {
    const approval = approvalRules[0]?.predicate;
    if (approval?.kind !== "approval_required" || approval.humanReviewerGroupIds.length === 0) {
      context.addIssue({
        code: "custom",
        message:
          "Policies applicable to high or critical risk require an independent human approval group",
        path: ["rules"],
      });
    }
  }
}

const releasePolicyDefinitionShape = {
  ...releasePolicySharedShape,
  issuerPrincipalId: OpaqueIdSchema,
  policyId: OpaqueIdSchema,
  policyVersionId: OpaqueIdSchema,
  predecessor: ReleasePolicyReferenceSchema.optional(),
};

function refineReleasePolicyDefinition(
  value: z.infer<z.ZodObject<typeof releasePolicyDefinitionShape>>,
  context: z.RefinementCtx,
): void {
  refineReleasePolicyShared(value, context);
  if (value.predecessor && value.predecessor.policyId !== value.policyId) {
    context.addIssue({
      code: "custom",
      message: "A policy predecessor must belong to the same logical policy identity",
      path: ["predecessor", "policyId"],
    });
  }
  if (value.predecessor?.policyVersionId === value.policyVersionId) {
    context.addIssue({
      code: "custom",
      message: "A policy version cannot name itself as its predecessor",
      path: ["predecessor", "policyVersionId"],
    });
  }
}

export const ReleasePolicyDefinitionSchema = z
  .object(releasePolicyDefinitionShape)
  .strict()
  .superRefine(refineReleasePolicyDefinition);

export const ReleasePolicySchema = z
  .object({
    ...releasePolicyDefinitionShape,
    definitionSha256: Sha256Schema,
    publishedAt: UtcMillisecondTimestampSchema,
    publishedByPrincipalId: OpaqueIdSchema,
    schemaVersion: z.literal(RELEASE_POLICY_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    refineReleasePolicyDefinition(value, context);
    if (value.publishedByPrincipalId !== value.issuerPrincipalId) {
      context.addIssue({
        code: "custom",
        message: "The authoritative policy issuer must equal the publishing principal",
        path: ["issuerPrincipalId"],
      });
    }
    if (compareTimestamp(value.publishedAt, value.expiresAt) >= 0) {
      context.addIssue({
        code: "custom",
        message: "A policy cannot be published at or after its immutable expiry",
        path: ["publishedAt"],
      });
    }
  });

export const PublishReleasePolicyRequestSchema = z
  .object({
    ...releasePolicySharedShape,
    policyVersionId: OpaqueIdSchema,
    predecessorVersionId: OpaqueIdSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    refineReleasePolicyShared(value, context);
    if (value.predecessorVersionId === value.policyVersionId) {
      context.addIssue({
        code: "custom",
        message: "A policy version cannot name itself as its predecessor",
        path: ["predecessorVersionId"],
      });
    }
  });

const releasePolicyLifecycleRecordShape = {
  actorPrincipalId: OpaqueIdSchema,
  eventId: OpaqueIdSchema,
  occurredAt: UtcMillisecondTimestampSchema,
  policy: ReleasePolicyReferenceSchema,
  reason: AssuranceRationaleSchema,
  schemaVersion: z.literal(RELEASE_POLICY_LIFECYCLE_SCHEMA_VERSION),
  scope: EvidenceScopeSchema,
};

export const ReleasePolicyLifecycleEventSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...releasePolicyLifecycleRecordShape,
        kind: z.literal("withdrawn"),
      })
      .strict(),
    z
      .object({
        ...releasePolicyLifecycleRecordShape,
        kind: z.literal("superseded"),
        successor: ReleasePolicyReferenceSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.kind !== "superseded") return;
    if (value.successor.policyId !== value.policy.policyId) {
      context.addIssue({
        code: "custom",
        message: "A superseding policy must retain the same logical policy identity",
        path: ["successor", "policyId"],
      });
    }
    if (value.successor.policyVersionId === value.policy.policyVersionId) {
      context.addIssue({
        code: "custom",
        message: "A policy version cannot supersede itself",
        path: ["successor", "policyVersionId"],
      });
    }
  });

export const PublishReleasePolicyLifecycleRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      eventId: OpaqueIdSchema,
      kind: z.literal("withdrawn"),
      reason: AssuranceRationaleSchema,
    })
    .strict(),
  z
    .object({
      eventId: OpaqueIdSchema,
      kind: z.literal("superseded"),
      reason: AssuranceRationaleSchema,
      successorPolicyVersionId: OpaqueIdSchema,
    })
    .strict(),
]);

export type PolicyInstallationBinding = z.infer<typeof PolicyInstallationBindingSchema>;
export type PolicyInstallationBindingDefinition = z.infer<
  typeof PolicyInstallationBindingDefinitionSchema
>;
export type PolicyInstallationBindingReference = z.infer<
  typeof PolicyInstallationBindingReferenceSchema
>;
export type PublishReleasePolicyRequest = z.infer<typeof PublishReleasePolicyRequestSchema>;
export type PublishReleasePolicyLifecycleRequest = z.infer<
  typeof PublishReleasePolicyLifecycleRequestSchema
>;
export type ReleasePolicy = z.infer<typeof ReleasePolicySchema>;
export type ReleasePolicyApplicability = z.infer<typeof ReleasePolicyApplicabilitySchema>;
export type ReleasePolicyComparator = z.infer<typeof ReleasePolicyComparatorSchema>;
export type ReleasePolicyDefinition = z.infer<typeof ReleasePolicyDefinitionSchema>;
export type ReleasePolicyPredicate = z.infer<typeof ReleasePolicyPredicateSchema>;
export type ReleasePolicyReference = z.infer<typeof ReleasePolicyReferenceSchema>;
export type ReleasePolicyRule = z.infer<typeof ReleasePolicyRuleSchema>;
export type ReleasePolicyLifecycleEvent = z.infer<typeof ReleasePolicyLifecycleEventSchema>;
