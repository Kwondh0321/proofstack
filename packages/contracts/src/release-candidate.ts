import { z } from "zod";
import { ArtifactContentReferenceSchema } from "./artifact.js";
import { AssessmentReferenceSchema } from "./evaluation-assessment.js";
import { ModelAssuranceAssessmentReferenceSchema } from "./evaluation-model-assessment.js";
import { EvaluationRiskTierSchema } from "./evaluation-criteria.js";
import { EvaluationDatasetVersionReferenceSchema } from "./evaluation-run.js";
import {
  AssuranceRationaleSchema,
  AssuranceSummarySchema,
  SourceJurisdictionSchema,
  SourceLocaleSchema,
} from "./evaluation-source.js";
import { DataClassificationSchema, EvidenceScopeSchema } from "./evidence.js";
import { OpaqueIdSchema, Sha256Schema, UtcMillisecondTimestampSchema } from "./primitives.js";
import { TargetReleaseReferenceSchema } from "./replay-plan.js";

export const RELEASE_CANDIDATE_SCHEMA_VERSION = "0.1" as const;
export const MAX_RELEASE_CANDIDATE_ASSESSMENTS = 128;
export const MAX_RELEASE_CANDIDATE_ARTIFACTS = 64;
export const MAX_RELEASE_CANDIDATE_COMPARISONS = 64;
export const MAX_RELEASE_CANDIDATE_COMPONENTS = 128;
export const MAX_RELEASE_CANDIDATE_DATASETS = 64;
export const MAX_RELEASE_CANDIDATE_LIMITATIONS = 64;
export const MAX_RELEASE_CANDIDATE_OMISSIONS = 128;
export const MAX_RELEASE_CANDIDATE_POPULATION_TAGS = 64;

function isStrictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function sortedUnique<Schema extends z.ZodType>(
  schema: Schema,
  minimum: number,
  maximum: number,
  key: (value: z.infer<Schema>) => string,
  label: string,
) {
  return z
    .array(schema)
    .min(minimum)
    .max(maximum)
    .refine((values) => isStrictlySortedUnique(values.map(key)), {
      message: `${label} must be unique and ordered by exact identity`,
    });
}

const HttpsRepositoryUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .superRefine((value, context) => {
    if (!value.startsWith("https://")) {
      context.addIssue({ code: "custom", message: "Repository URL must use HTTPS" });
    }
    const authorityStart = "https://".length;
    const relativeAuthorityEnd = value.slice(authorityStart).search(/[/?#]/u);
    const authorityEnd =
      relativeAuthorityEnd < 0 ? undefined : authorityStart + relativeAuthorityEnd;
    const authority = value.slice(authorityStart, authorityEnd);
    if (authority.includes("@") || value.includes("?") || value.includes("#")) {
      context.addIssue({
        code: "custom",
        message: "Repository URL cannot contain credentials, query parameters, or fragments",
      });
    }
    if (
      authorityEnd === undefined ||
      value[authorityEnd] !== "/" ||
      !value
        .slice(authorityEnd + 1)
        .split("/")
        .some((segment) => segment.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Repository URL must identify a repository path",
      });
    }
  });

export const GitObjectDigestSchema = z.discriminatedUnion("algorithm", [
  z.object({ algorithm: z.literal("sha1"), value: z.string().regex(/^[0-9a-f]{40}$/) }).strict(),
  z.object({ algorithm: z.literal("sha256"), value: Sha256Schema }).strict(),
]);

export const ReleaseCandidateSourceSchema = z
  .object({
    commit: GitObjectDigestSchema,
    repositoryUrl: HttpsRepositoryUrlSchema,
    tree: GitObjectDigestSchema,
  })
  .strict();

export const ReleaseCandidateReferenceSchema = z
  .object({
    candidateId: OpaqueIdSchema,
    candidateVersionId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
  })
  .strict();

export const ReleaseCandidatePredecessorSchema = ReleaseCandidateReferenceSchema;

export const ReleaseCandidateComparisonReferenceSchema = z
  .object({
    definitionSha256: Sha256Schema,
    resultId: OpaqueIdSchema,
  })
  .strict();

export const ReleaseCandidateBuildArtifactSchema = z
  .object({
    artifact: ArtifactContentReferenceSchema,
    role: OpaqueIdSchema,
  })
  .strict();

const ReleaseCandidateAdapterReferenceSchema = z
  .object({
    adapterId: OpaqueIdSchema,
    adapterVersionId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
  })
  .strict();

export const ReleaseCandidateModelResolutionSchema = z.discriminatedUnion("status", [
  z
    .object({
      resolutionEvidence: ArtifactContentReferenceSchema,
      resolvedModelVersion: AssuranceSummarySchema,
      status: z.literal("exact"),
    })
    .strict(),
  z
    .object({
      declaredAlias: AssuranceSummarySchema,
      limitation: AssuranceRationaleSchema,
      status: z.literal("provider_alias_only"),
    })
    .strict(),
]);

export const ReleaseCandidateRuntimeComponentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      content: ArtifactContentReferenceSchema,
      kind: z.literal("prompt"),
      role: OpaqueIdSchema,
    })
    .strict(),
  z
    .object({
      content: ArtifactContentReferenceSchema,
      kind: z.literal("tool_contract"),
      role: OpaqueIdSchema,
    })
    .strict(),
  z
    .object({
      adapter: ReleaseCandidateAdapterReferenceSchema,
      kind: z.literal("model"),
      providerId: OpaqueIdSchema,
      providerModelId: AssuranceSummarySchema,
      resolution: ReleaseCandidateModelResolutionSchema,
      role: OpaqueIdSchema,
    })
    .strict(),
]);

export const ReleaseCandidateOmissionKindSchema = z.enum([
  "assessment",
  "build_artifact",
  "comparison_result",
  "dataset",
  "model",
  "model_assurance_assessment",
  "prompt",
  "tool_contract",
]);

export const ReleaseCandidateOmissionSchema = z
  .object({
    kind: ReleaseCandidateOmissionKindSchema,
    reason: z.enum(["intentionally_not_used", "not_supported", "source_unavailable"]),
    rationale: AssuranceRationaleSchema,
    role: OpaqueIdSchema,
  })
  .strict();

export const ReleaseCandidateTargetSchema = z
  .object({
    environmentId: OpaqueIdSchema,
    jurisdiction: SourceJurisdictionSchema.optional(),
    locale: SourceLocaleSchema.optional(),
    maximumDataClassification: DataClassificationSchema,
    populationTags: z
      .array(AssuranceSummarySchema)
      .max(MAX_RELEASE_CANDIDATE_POPULATION_TAGS)
      .refine(isStrictlySortedUnique, {
        message: "Candidate population tags must be unique and ordered",
      }),
    purpose: AssuranceRationaleSchema,
    riskTier: EvaluationRiskTierSchema,
    taskKind: OpaqueIdSchema,
  })
  .strict();

const releaseCandidateSharedShape = {
  assessments: sortedUnique(
    AssessmentReferenceSchema,
    1,
    MAX_RELEASE_CANDIDATE_ASSESSMENTS,
    ({ assessmentId }) => assessmentId,
    "Candidate assessments",
  ),
  buildArtifacts: sortedUnique(
    ReleaseCandidateBuildArtifactSchema,
    1,
    MAX_RELEASE_CANDIDATE_ARTIFACTS,
    ({ role }) => role,
    "Candidate build artifacts",
  ),
  comparisons: sortedUnique(
    ReleaseCandidateComparisonReferenceSchema,
    1,
    MAX_RELEASE_CANDIDATE_COMPARISONS,
    ({ resultId }) => resultId,
    "Candidate comparisons",
  ),
  contentProjection: z.literal("artifact_references_only"),
  datasets: sortedUnique(
    EvaluationDatasetVersionReferenceSchema,
    1,
    MAX_RELEASE_CANDIDATE_DATASETS,
    ({ datasetId, datasetVersionId }) => `${datasetId}:${datasetVersionId}`,
    "Candidate datasets",
  ),
  description: AssuranceSummarySchema.optional(),
  knownLimitations: z
    .array(AssuranceSummarySchema)
    .max(MAX_RELEASE_CANDIDATE_LIMITATIONS)
    .refine(isStrictlySortedUnique, {
      message: "Candidate limitations must be unique and ordered",
    }),
  modelAssuranceAssessments: sortedUnique(
    ModelAssuranceAssessmentReferenceSchema,
    0,
    MAX_RELEASE_CANDIDATE_ASSESSMENTS,
    ({ assessmentExtensionId }) => assessmentExtensionId,
    "Candidate model-assurance assessments",
  ),
  name: AssuranceSummarySchema,
  omissions: sortedUnique(
    ReleaseCandidateOmissionSchema,
    0,
    MAX_RELEASE_CANDIDATE_OMISSIONS,
    ({ kind, role }) => `${kind}:${role}`,
    "Candidate omissions",
  ),
  runtimeComponents: sortedUnique(
    ReleaseCandidateRuntimeComponentSchema,
    1,
    MAX_RELEASE_CANDIDATE_COMPONENTS,
    ({ kind, role }) => `${kind}:${role}`,
    "Candidate runtime components",
  ),
  source: ReleaseCandidateSourceSchema,
  target: ReleaseCandidateTargetSchema,
  targetRelease: TargetReleaseReferenceSchema,
};

const classificationRank = {
  confidential: 2,
  internal: 1,
  metadata: 0,
  restricted: 3,
} as const;

type CandidateShared = z.infer<z.ZodObject<typeof releaseCandidateSharedShape>>;

function candidateArtifacts(
  value: CandidateShared,
): readonly z.infer<typeof ArtifactContentReferenceSchema>[] {
  const artifacts = value.buildArtifacts.map(({ artifact }) => artifact);
  for (const component of value.runtimeComponents) {
    if (component.kind === "model") {
      if (component.resolution.status === "exact") {
        artifacts.push(component.resolution.resolutionEvidence);
      }
    } else {
      artifacts.push(component.content);
    }
  }
  return artifacts;
}

function refineCandidateShared(value: CandidateShared, context: z.RefinementCtx): void {
  const maximumRank = classificationRank[value.target.maximumDataClassification];
  for (const artifact of candidateArtifacts(value)) {
    if (classificationRank[artifact.classification] > maximumRank) {
      context.addIssue({
        code: "custom",
        message: "Candidate artifact classification exceeds the declared maximum",
        path: ["target", "maximumDataClassification"],
      });
      break;
    }
  }

  const presentRoles = new Set([
    ...value.buildArtifacts.map(({ role }) => `build_artifact:${role}`),
    ...value.runtimeComponents.map(({ kind, role }) => `${kind}:${role}`),
  ]);
  for (const [index, omission] of value.omissions.entries()) {
    if (presentRoles.has(`${omission.kind}:${omission.role}`)) {
      context.addIssue({
        code: "custom",
        message: "A present candidate component cannot also be declared omitted",
        path: ["omissions", index],
      });
    }
  }
}

const releaseCandidateDefinitionShape = {
  ...releaseCandidateSharedShape,
  candidateId: OpaqueIdSchema,
  candidateVersionId: OpaqueIdSchema,
  predecessor: ReleaseCandidatePredecessorSchema.optional(),
};

function refineCandidateDefinition(
  value: z.infer<z.ZodObject<typeof releaseCandidateDefinitionShape>>,
  context: z.RefinementCtx,
): void {
  refineCandidateShared(value, context);
  if (
    value.predecessor?.candidateId !== undefined &&
    value.predecessor.candidateId !== value.candidateId
  ) {
    context.addIssue({
      code: "custom",
      message: "A candidate predecessor must belong to the same candidate identity",
      path: ["predecessor", "candidateId"],
    });
  }
  if (value.predecessor?.candidateVersionId === value.candidateVersionId) {
    context.addIssue({
      code: "custom",
      message: "A candidate version cannot name itself as its predecessor",
      path: ["predecessor", "candidateVersionId"],
    });
  }
}

export const ReleaseCandidateDefinitionSchema = z
  .object(releaseCandidateDefinitionShape)
  .strict()
  .superRefine(refineCandidateDefinition);

export const ReleaseCandidateSchema = z
  .object({
    ...releaseCandidateDefinitionShape,
    createdAt: UtcMillisecondTimestampSchema,
    createdByPrincipalId: OpaqueIdSchema,
    definitionSha256: Sha256Schema,
    schemaVersion: z.literal(RELEASE_CANDIDATE_SCHEMA_VERSION),
    scope: EvidenceScopeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    refineCandidateDefinition(value, context);
    if (value.scope.environmentId !== value.target.environmentId) {
      context.addIssue({
        code: "custom",
        message: "Candidate target environment must equal its authoritative scope",
        path: ["target", "environmentId"],
      });
    }
  });

export const PublishReleaseCandidateRequestSchema = z
  .object({
    ...releaseCandidateSharedShape,
    candidateVersionId: OpaqueIdSchema,
    predecessorVersionId: OpaqueIdSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    refineCandidateShared(value, context);
    if (value.predecessorVersionId === value.candidateVersionId) {
      context.addIssue({
        code: "custom",
        message: "A candidate version cannot name itself as its predecessor",
        path: ["predecessorVersionId"],
      });
    }
  });

export type GitObjectDigest = z.infer<typeof GitObjectDigestSchema>;
export type PublishReleaseCandidateRequest = z.infer<typeof PublishReleaseCandidateRequestSchema>;
export type ReleaseCandidate = z.infer<typeof ReleaseCandidateSchema>;
export type ReleaseCandidateBuildArtifact = z.infer<typeof ReleaseCandidateBuildArtifactSchema>;
export type ReleaseCandidateComparisonReference = z.infer<
  typeof ReleaseCandidateComparisonReferenceSchema
>;
export type ReleaseCandidateDefinition = z.infer<typeof ReleaseCandidateDefinitionSchema>;
export type ReleaseCandidateModelResolution = z.infer<typeof ReleaseCandidateModelResolutionSchema>;
export type ReleaseCandidateOmission = z.infer<typeof ReleaseCandidateOmissionSchema>;
export type ReleaseCandidateReference = z.infer<typeof ReleaseCandidateReferenceSchema>;
export type ReleaseCandidateRuntimeComponent = z.infer<
  typeof ReleaseCandidateRuntimeComponentSchema
>;
export type ReleaseCandidateSource = z.infer<typeof ReleaseCandidateSourceSchema>;
export type ReleaseCandidateTarget = z.infer<typeof ReleaseCandidateTargetSchema>;
