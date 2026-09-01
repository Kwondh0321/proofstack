import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { RegressionFixtureVersionReferenceSchema } from "./dataset.js";
import { EvidenceScopeSchema, evidenceTimestampOrderKey } from "./evidence.js";
import {
  CriterionReferenceSchema,
  EvaluatorReferenceSchema,
  OracleReferenceSchema,
} from "./evaluation-criteria.js";
import { AssuranceRationaleSchema, AssuranceSummarySchema } from "./evaluation-source.js";
import {
  OpaqueIdSchema,
  PostgresTimestampSchema,
  Sha256Schema,
  UtcMillisecondTimestampSchema,
} from "./primitives.js";
import { ProofStackRevisionSchema } from "./recovery.js";

export const ORACLE_SPEC_SCHEMA_VERSION = "0.1" as const;
export const EVALUATOR_SPEC_SCHEMA_VERSION = "0.1" as const;
export const QUALIFICATION_FIXTURE_SET_SCHEMA_VERSION = "0.1" as const;
export const QUALIFICATION_REPORT_SCHEMA_VERSION = "0.1" as const;
export const MAX_QUALIFICATION_CASES = 512;

function isStrictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function exactArtifactReferences(minimum: number, maximum: number, label: string) {
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

function exactCriterionReferences(label: string) {
  return z
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
      { message: `${label} must be unique and ordered by exact criterion reference` },
    );
}

export const RegisteredEvaluationImplementationSchema = z
  .object({
    dependencySnapshotSha256: Sha256Schema,
    entryPointId: OpaqueIdSchema,
    implementationId: OpaqueIdSchema,
    implementationSha256: Sha256Schema,
    implementationVersionId: OpaqueIdSchema,
    runtime: z
      .object({
        architecture: z.enum(["arm64", "wasm32", "x64"]),
        family: z.enum(["node", "python", "wasm"]),
        platform: z.enum(["darwin", "linux", "portable"]),
        version: AssuranceSummarySchema,
      })
      .strict(),
    sourceRevision: ProofStackRevisionSchema,
  })
  .strict();

export const EvaluationExecutionBudgetSchema = z
  .object({
    elapsedMilliseconds: z.number().int().positive().max(3_600_000),
    inputBytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
    memoryBytes: z
      .number()
      .int()
      .positive()
      .max(8 * 1024 * 1024 * 1024),
    outputBytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
  })
  .strict();

export const EvaluationRuntimePolicySchema = z
  .object({
    clock: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("not_available") }).strict(),
      z
        .object({
          instant: PostgresTimestampSchema,
          mode: z.literal("fixed"),
        })
        .strict(),
    ]),
    dataEgress: z.literal("denied"),
    locale: z.string().regex(/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/),
    network: z.literal("denied"),
    seed: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("not_used") }).strict(),
      z
        .object({
          mode: z.literal("fixed"),
          value: z.number().int().nonnegative().max(4_294_967_295),
        })
        .strict(),
    ]),
    sideEffects: z.literal("denied"),
  })
  .strict();

export const QualificationFixtureSetReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    fixtureSetId: OpaqueIdSchema,
    fixtureSetVersionId: OpaqueIdSchema,
  })
  .strict();

const oracleSpecDefinitionShape = {
  budgets: EvaluationExecutionBudgetSchema,
  configurationSha256: Sha256Schema,
  implementation: RegisteredEvaluationImplementationSchema,
  inputSchema: ArtifactContentReferenceSchema,
  kind: z.enum([
    "exact",
    "metamorphic",
    "property",
    "reference_interpreter",
    "reference_label",
    "schema",
  ]),
  knownLimitations: z.array(AssuranceSummarySchema).max(64).refine(isStrictlySortedUnique, {
    message: "Oracle limitations must be unique and ordered",
  }),
  oracleId: OpaqueIdSchema,
  oracleVersionId: OpaqueIdSchema,
  outputSchema: ArtifactContentReferenceSchema,
  predecessor: OracleReferenceSchema.optional(),
  qualificationFixtureSet: QualificationFixtureSetReferenceSchema,
  resultSemantics: AssuranceRationaleSchema,
  runtimePolicy: EvaluationRuntimePolicySchema,
  supportedCriteria: exactCriterionReferences("Oracle criteria"),
};

function refineOracleSpec(
  value: {
    readonly oracleId: string;
    readonly oracleVersionId: string;
    readonly predecessor?:
      | { readonly oracleId: string; readonly oracleVersionId: string }
      | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (!value.predecessor) return;
  if (value.predecessor.oracleId !== value.oracleId) {
    context.addIssue({
      code: "custom",
      message: "An oracle predecessor must retain the logical oracleId",
      path: ["predecessor", "oracleId"],
    });
  }
  if (value.predecessor.oracleVersionId === value.oracleVersionId) {
    context.addIssue({
      code: "custom",
      message: "An oracle version cannot name itself as predecessor",
      path: ["predecessor", "oracleVersionId"],
    });
  }
}

export const OracleSpecDefinitionSchema = z
  .object(oracleSpecDefinitionShape)
  .strict()
  .superRefine(refineOracleSpec);

export const OracleSpecSchema = z
  .object({
    ...oracleSpecDefinitionShape,
    definitionSha256: Sha256Schema,
    publishedAt: UtcMillisecondTimestampSchema,
    publishedByPrincipalId: OpaqueIdSchema,
    schemaVersion: z.literal(ORACLE_SPEC_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineOracleSpec);

export const IndependenceGroupSchema = z
  .object({
    groupId: OpaqueIdSchema,
    implementationAuthors: z
      .array(AssuranceSummarySchema)
      .min(1)
      .max(32)
      .refine(isStrictlySortedUnique, {
        message: "Implementation authors must be unique and ordered",
      }),
    labelSourceIds: z.array(OpaqueIdSchema).max(32).refine(isStrictlySortedUnique, {
      message: "Label source identifiers must be unique and ordered",
    }),
    organization: AssuranceSummarySchema,
  })
  .strict();

const StatisticalAggregationSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("descriptive_counts"),
    })
    .strict(),
  z
    .object({
      confidenceLevelBasisPoints: z.number().int().min(5_000).max(9_999),
      method: z.literal("wilson_score_interval"),
    })
    .strict(),
]);

const EvaluatorKindSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("deterministic") }).strict(),
  z
    .object({
      aggregation: StatisticalAggregationSchema,
      kind: z.literal("statistical"),
    })
    .strict(),
  z
    .object({
      components: z
        .array(EvaluatorReferenceSchema)
        .min(2)
        .max(16)
        .refine(
          (references) =>
            isStrictlySortedUnique(
              references.map(
                ({ evaluatorId, evaluatorVersionId }) => `${evaluatorId}:${evaluatorVersionId}`,
              ),
            ),
          { message: "Composite evaluator components must be unique and ordered" },
        ),
      kind: z.literal("composite"),
    })
    .strict(),
]);

const evaluatorSpecDefinitionShape = {
  budgets: EvaluationExecutionBudgetSchema,
  configurationSha256: Sha256Schema,
  evaluatorId: OpaqueIdSchema,
  evaluatorVersionId: OpaqueIdSchema,
  implementation: RegisteredEvaluationImplementationSchema,
  independenceGroup: IndependenceGroupSchema,
  inputSchema: ArtifactContentReferenceSchema,
  kindDeclaration: EvaluatorKindSchema,
  knownLimitations: z.array(AssuranceSummarySchema).max(64).refine(isStrictlySortedUnique, {
    message: "Evaluator limitations must be unique and ordered",
  }),
  oracles: z
    .array(OracleReferenceSchema)
    .min(1)
    .max(32)
    .refine(
      (references) =>
        isStrictlySortedUnique(
          references.map(({ oracleId, oracleVersionId }) => `${oracleId}:${oracleVersionId}`),
        ),
      { message: "Evaluator oracles must be unique and ordered" },
    ),
  outputSchema: ArtifactContentReferenceSchema,
  predecessor: EvaluatorReferenceSchema.optional(),
  qualificationFixtureSet: QualificationFixtureSetReferenceSchema,
  reproducibility: z.enum(["best_effort", "bounded", "exact"]),
  runtimePolicy: EvaluationRuntimePolicySchema,
  supportedCriteria: exactCriterionReferences("Evaluator criteria"),
};

function refineEvaluatorSpec(
  value: {
    readonly evaluatorId: string;
    readonly evaluatorVersionId: string;
    readonly kindDeclaration:
      | { readonly kind: "deterministic" | "statistical" }
      | {
          readonly components: readonly {
            readonly evaluatorId: string;
            readonly evaluatorVersionId: string;
          }[];
          readonly kind: "composite";
        };
    readonly predecessor?:
      | { readonly evaluatorId: string; readonly evaluatorVersionId: string }
      | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (value.predecessor) {
    if (value.predecessor.evaluatorId !== value.evaluatorId) {
      context.addIssue({
        code: "custom",
        message: "An evaluator predecessor must retain the logical evaluatorId",
        path: ["predecessor", "evaluatorId"],
      });
    }
    if (value.predecessor.evaluatorVersionId === value.evaluatorVersionId) {
      context.addIssue({
        code: "custom",
        message: "An evaluator version cannot name itself as predecessor",
        path: ["predecessor", "evaluatorVersionId"],
      });
    }
  }
  if (
    value.kindDeclaration.kind === "composite" &&
    value.kindDeclaration.components.some(
      ({ evaluatorId, evaluatorVersionId }) =>
        evaluatorId === value.evaluatorId && evaluatorVersionId === value.evaluatorVersionId,
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "A composite evaluator cannot include itself",
      path: ["kindDeclaration", "components"],
    });
  }
}

export const EvaluatorSpecDefinitionSchema = z
  .object(evaluatorSpecDefinitionShape)
  .strict()
  .superRefine(refineEvaluatorSpec);

export const EvaluatorSpecSchema = z
  .object({
    ...evaluatorSpecDefinitionShape,
    definitionSha256: Sha256Schema,
    publishedAt: UtcMillisecondTimestampSchema,
    publishedByPrincipalId: OpaqueIdSchema,
    schemaVersion: z.literal(EVALUATOR_SPEC_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineEvaluatorSpec);

export const QualificationCaseKindSchema = z.enum([
  "abstention",
  "boundary",
  "budget",
  "error",
  "malformed",
  "negative",
  "not_applicable",
  "positive",
  "timeout",
]);

export const QualificationExpectedOutcomeSchema = z.enum([
  "abstain",
  "error",
  "fail",
  "not_applicable",
  "pass",
]);

export const QualificationCaseSchema = z
  .object({
    caseId: OpaqueIdSchema,
    caseKind: QualificationCaseKindSchema,
    criterion: CriterionReferenceSchema,
    expectedOutcome: QualificationExpectedOutcomeSchema,
    fixture: RegressionFixtureVersionReferenceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const requiredOutcome = {
      abstention: "abstain",
      budget: "error",
      error: "error",
      malformed: "error",
      negative: "fail",
      not_applicable: "not_applicable",
      positive: "pass",
      timeout: "error",
    } as const;
    if (value.caseKind === "boundary") return;
    if (value.expectedOutcome !== requiredOutcome[value.caseKind]) {
      context.addIssue({
        code: "custom",
        message: `Qualification ${value.caseKind} case must expect ${requiredOutcome[value.caseKind]}`,
        path: ["expectedOutcome"],
      });
    }
  });

const qualificationFixtureSetDefinitionShape = {
  cases: z.array(QualificationCaseSchema).min(9).max(MAX_QUALIFICATION_CASES),
  changeRationale: AssuranceRationaleSchema,
  fixtureSetId: OpaqueIdSchema,
  fixtureSetVersionId: OpaqueIdSchema,
  predecessor: QualificationFixtureSetReferenceSchema.optional(),
};

function refineQualificationFixtureSet(
  value: {
    readonly cases: readonly {
      readonly caseId: string;
      readonly caseKind: z.infer<typeof QualificationCaseKindSchema>;
      readonly fixture: { readonly fixtureVersionId: string };
    }[];
    readonly fixtureSetId: string;
    readonly fixtureSetVersionId: string;
    readonly predecessor?:
      | { readonly fixtureSetId: string; readonly fixtureSetVersionId: string }
      | undefined;
  },
  context: z.RefinementCtx,
): void {
  const caseIds = value.cases.map(({ caseId }) => caseId);
  if (!isStrictlySortedUnique(caseIds)) {
    context.addIssue({
      code: "custom",
      message: "Qualification cases must be unique and ordered by caseId",
      path: ["cases"],
    });
  }
  const fixtureVersionIds = value.cases.map(({ fixture }) => fixture.fixtureVersionId);
  if (new Set(fixtureVersionIds).size !== fixtureVersionIds.length) {
    context.addIssue({
      code: "custom",
      message: "Qualification cases must use distinct exact fixture versions",
      path: ["cases"],
    });
  }
  const kinds = new Set(value.cases.map(({ caseKind }) => caseKind));
  for (const requiredKind of QualificationCaseKindSchema.options) {
    if (!kinds.has(requiredKind)) {
      context.addIssue({
        code: "custom",
        message: `Qualification fixture set requires a ${requiredKind} case`,
        path: ["cases"],
      });
    }
  }
  if (value.predecessor) {
    if (value.predecessor.fixtureSetId !== value.fixtureSetId) {
      context.addIssue({
        code: "custom",
        message: "A qualification predecessor must retain the logical fixtureSetId",
        path: ["predecessor", "fixtureSetId"],
      });
    }
    if (value.predecessor.fixtureSetVersionId === value.fixtureSetVersionId) {
      context.addIssue({
        code: "custom",
        message: "A qualification fixture set cannot name itself as predecessor",
        path: ["predecessor", "fixtureSetVersionId"],
      });
    }
  }
}

export const QualificationFixtureSetDefinitionSchema = z
  .object(qualificationFixtureSetDefinitionShape)
  .strict()
  .superRefine(refineQualificationFixtureSet);

export const QualificationFixtureSetSchema = z
  .object({
    ...qualificationFixtureSetDefinitionShape,
    definitionSha256: Sha256Schema,
    publishedAt: UtcMillisecondTimestampSchema,
    publishedByPrincipalId: OpaqueIdSchema,
    schemaVersion: z.literal(QUALIFICATION_FIXTURE_SET_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineQualificationFixtureSet);

export const QualificationSubjectReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("oracle"),
      oracle: OracleReferenceSchema,
    })
    .strict(),
  z
    .object({
      evaluator: EvaluatorReferenceSchema,
      kind: z.literal("evaluator"),
    })
    .strict(),
]);

export const QualificationReportReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    qualificationReportId: OpaqueIdSchema,
  })
  .strict();

const QualificationCaseResultSchema = z
  .object({
    actualOutcome: QualificationExpectedOutcomeSchema,
    caseId: OpaqueIdSchema,
    caseKind: QualificationCaseKindSchema,
    expectedOutcome: QualificationExpectedOutcomeSchema,
    matched: z.boolean(),
    rawEvidence: exactArtifactReferences(1, 16, "Qualification case evidence"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.matched !== (value.actualOutcome === value.expectedOutcome)) {
      context.addIssue({
        code: "custom",
        message: "Qualification case matched must reflect exact expected and actual outcomes",
        path: ["matched"],
      });
    }
  });

const QualificationSummarySchema = z
  .object({
    unexpectedErrorCount: z.number().int().nonnegative().max(MAX_QUALIFICATION_CASES),
    matchedCount: z.number().int().nonnegative().max(MAX_QUALIFICATION_CASES),
    mismatchedCount: z.number().int().nonnegative().max(MAX_QUALIFICATION_CASES),
    totalCount: z.number().int().positive().max(MAX_QUALIFICATION_CASES),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.matchedCount + value.mismatchedCount !== value.totalCount) {
      context.addIssue({
        code: "custom",
        message: "Qualification summary matched and mismatched counts must equal totalCount",
        path: ["totalCount"],
      });
    }
    if (value.unexpectedErrorCount > value.mismatchedCount) {
      context.addIssue({
        code: "custom",
        message: "Qualification unexpectedErrorCount cannot exceed mismatchedCount",
        path: ["unexpectedErrorCount"],
      });
    }
  });

const qualificationReportShape = {
  caseResults: z.array(QualificationCaseResultSchema).min(9).max(MAX_QUALIFICATION_CASES),
  completedAt: PostgresTimestampSchema,
  environmentEvidence: exactArtifactReferences(1, 16, "Qualification environment evidence"),
  fixtureSet: QualificationFixtureSetReferenceSchema,
  knownLimitations: z.array(AssuranceSummarySchema).max(64).refine(isStrictlySortedUnique, {
    message: "Qualification report limitations must be unique and ordered",
  }),
  policy: z
    .object({
      definitionSha256: Sha256Schema,
      policyId: OpaqueIdSchema,
      policyVersionId: OpaqueIdSchema,
    })
    .strict(),
  qualificationReportId: OpaqueIdSchema,
  startedAt: PostgresTimestampSchema,
  status: z.enum(["qualified", "unqualified"]),
  subject: QualificationSubjectReferenceSchema,
  summary: QualificationSummarySchema,
  validFrom: PostgresTimestampSchema,
  validUntil: PostgresTimestampSchema,
};

function refineQualificationReport(
  value: {
    readonly caseResults: readonly {
      readonly actualOutcome: string;
      readonly caseId: string;
      readonly caseKind: z.infer<typeof QualificationCaseKindSchema>;
      readonly matched: boolean;
    }[];
    readonly completedAt: string;
    readonly startedAt: string;
    readonly status: "qualified" | "unqualified";
    readonly summary: {
      readonly matchedCount: number;
      readonly mismatchedCount: number;
      readonly totalCount: number;
      readonly unexpectedErrorCount: number;
    };
    readonly validFrom: string;
    readonly validUntil: string;
  },
  context: z.RefinementCtx,
): void {
  if (evidenceTimestampOrderKey(value.completedAt) < evidenceTimestampOrderKey(value.startedAt)) {
    context.addIssue({
      code: "custom",
      message: "Qualification completion cannot precede its start",
      path: ["completedAt"],
    });
  }
  if (evidenceTimestampOrderKey(value.validUntil) <= evidenceTimestampOrderKey(value.validFrom)) {
    context.addIssue({
      code: "custom",
      message: "Qualification validity must have a positive interval",
      path: ["validUntil"],
    });
  }
  if (evidenceTimestampOrderKey(value.validFrom) < evidenceTimestampOrderKey(value.completedAt)) {
    context.addIssue({
      code: "custom",
      message: "Qualification validity cannot begin before completion",
      path: ["validFrom"],
    });
  }
  const caseIds = value.caseResults.map(({ caseId }) => caseId);
  if (!isStrictlySortedUnique(caseIds)) {
    context.addIssue({
      code: "custom",
      message: "Qualification case results must be unique and ordered",
      path: ["caseResults"],
    });
  }
  const kinds = new Set(value.caseResults.map(({ caseKind }) => caseKind));
  for (const requiredKind of QualificationCaseKindSchema.options) {
    if (!kinds.has(requiredKind)) {
      context.addIssue({
        code: "custom",
        message: `Qualification report requires a ${requiredKind} result`,
        path: ["caseResults"],
      });
    }
  }
  const matchedCount = value.caseResults.filter(({ matched }) => matched).length;
  const unexpectedErrorCount = value.caseResults.filter(
    ({ actualOutcome, matched }) => !matched && actualOutcome === "error",
  ).length;
  if (
    value.summary.totalCount !== value.caseResults.length ||
    value.summary.matchedCount !== matchedCount ||
    value.summary.mismatchedCount !== value.caseResults.length - matchedCount ||
    value.summary.unexpectedErrorCount !== unexpectedErrorCount
  ) {
    context.addIssue({
      code: "custom",
      message: "Qualification summary must reconstruct exactly from case results",
      path: ["summary"],
    });
  }
  if (
    value.status === "qualified" &&
    (value.summary.matchedCount !== value.summary.totalCount ||
      value.summary.unexpectedErrorCount !== 0)
  ) {
    context.addIssue({
      code: "custom",
      message: "Qualified status requires every predeclared case to match without unexpected error",
      path: ["status"],
    });
  }
}

export const QualificationReportSchema = z
  .object({
    ...qualificationReportShape,
    definitionSha256: Sha256Schema,
    executedByPrincipalId: OpaqueIdSchema,
    recordedAt: UtcMillisecondTimestampSchema,
    schemaVersion: z.literal(QUALIFICATION_REPORT_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine(refineQualificationReport);

export type EvaluatorSpec = z.infer<typeof EvaluatorSpecSchema>;
export type EvaluatorSpecDefinition = z.infer<typeof EvaluatorSpecDefinitionSchema>;
export type OracleSpec = z.infer<typeof OracleSpecSchema>;
export type OracleSpecDefinition = z.infer<typeof OracleSpecDefinitionSchema>;
export type QualificationFixtureSet = z.infer<typeof QualificationFixtureSetSchema>;
export type QualificationReport = z.infer<typeof QualificationReportSchema>;
export type QualificationReportReference = z.infer<typeof QualificationReportReferenceSchema>;
