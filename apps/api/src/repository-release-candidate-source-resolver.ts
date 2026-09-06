import type { ArtifactCatalogRepository } from "@proofstack/artifacts";
import {
  ArtifactMetadataSchema,
  type Assessment,
  type ComparisonResult,
  type EvidenceScope,
  type ModelAssuranceAssessment,
  type RegressionDatasetVersion,
  type TargetRelease,
} from "@proofstack/contracts";
import {
  type ComparisonRepository,
  type CriteriaTrustArtifactResolver,
  type EvaluationRepository,
  type ModelAssuranceRepository,
  type ReleaseCandidateSourceReference,
  type ReleaseCandidateSourceResolver,
  validateComparisonRecord,
  validateEvaluationRecord,
  validateModelAssuranceRecord,
} from "@proofstack/core";
import {
  type RegressionVersionRepository,
  validateAndProjectRegressionDatasetVersion,
} from "@proofstack/datasets";
import {
  type ReplayDefinitionRepository,
  validateAndProjectTargetRelease,
} from "@proofstack/replay";

type ArtifactReference = Extract<
  ReleaseCandidateSourceReference,
  {
    readonly kind: "build_artifact" | "model_resolution_evidence" | "prompt" | "tool_contract";
  }
>;
type AssessmentReference = Extract<
  ReleaseCandidateSourceReference,
  { readonly kind: "assessment" }
>["assessment"];
type ModelAssuranceAssessmentReference = Extract<
  ReleaseCandidateSourceReference,
  { readonly kind: "model_assurance_assessment" }
>["assessment"];
export type ReleaseCandidateRevisionReference = Extract<
  ReleaseCandidateSourceReference,
  { readonly kind: "source_revision" }
>;
export type ReleaseCandidateRuntimeReference = Extract<
  ReleaseCandidateSourceReference,
  { readonly kind: "model_declaration" | "runtime_adapter" }
>;

export interface ReleaseCandidateRevisionAuthority {
  /** Resolves an exact repository, commit, and tree from an operator-owned source authority. */
  isAvailable(scope: EvidenceScope, reference: ReleaseCandidateRevisionReference): Promise<boolean>;
}

export interface ReleaseCandidateRuntimeAuthority {
  /** Resolves exact provider declarations and adapter versions from an operator-owned registry. */
  isAvailable(scope: EvidenceScope, reference: ReleaseCandidateRuntimeReference): Promise<boolean>;
}

export interface ReleaseCandidateArtifactSources {
  readonly catalog: Pick<ArtifactCatalogRepository, "find">;
  readonly verifier: CriteriaTrustArtifactResolver;
}

export interface RepositoryReleaseCandidateSourceResolverDependencies {
  readonly artifacts?: ReleaseCandidateArtifactSources;
  readonly comparisonRepository: Pick<ComparisonRepository, "findComparisonResult">;
  readonly evaluationRepository: Pick<EvaluationRepository, "findAssessment">;
  readonly modelAssuranceRepository: Pick<ModelAssuranceRepository, "find">;
  readonly regressionVersionRepository: Pick<RegressionVersionRepository, "findDatasetVersion">;
  readonly replayDefinitionRepository: Pick<ReplayDefinitionRepository, "findTargetRelease">;
  readonly revisionAuthority?: ReleaseCandidateRevisionAuthority;
  readonly runtimeAuthority?: ReleaseCandidateRuntimeAuthority;
}

function sameScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function sameArtifact(
  left: ArtifactReference["artifact"],
  right: ArtifactReference["artifact"],
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

async function artifactAvailable(
  sources: ReleaseCandidateArtifactSources | undefined,
  scope: EvidenceScope,
  reference: ArtifactReference,
): Promise<boolean> {
  if (!sources) return false;
  const entry = await sources.catalog.find(structuredClone(scope), reference.artifact.artifactId);
  if (!entry) return false;
  const metadata = ArtifactMetadataSchema.parse(entry.metadata);
  if (
    metadata.state !== "available" ||
    metadata.retention.mode !== "retain" ||
    !sameScope(metadata.scope, scope) ||
    !sameArtifact(metadata.contentReference, reference.artifact)
  ) {
    return false;
  }
  const availability = await sources.verifier.resolve({
    references: [
      {
        artifactId: reference.artifact.artifactId,
        sha256: reference.artifact.sha256,
      },
    ],
    scope: structuredClone(scope),
  });
  const resolved = availability[0];
  return (
    availability.length === 1 &&
    resolved?.artifactId === reference.artifact.artifactId &&
    resolved.sha256 === reference.artifact.sha256 &&
    resolved.state === "available"
  );
}

function exactAssessment(
  record: Assessment,
  scope: EvidenceScope,
  reference: AssessmentReference,
): boolean {
  return (
    sameScope(record.scope, scope) &&
    record.assessmentId === reference.assessmentId &&
    record.definitionSha256 === reference.definitionSha256
  );
}

function exactModelAssuranceAssessment(
  record: ModelAssuranceAssessment,
  scope: EvidenceScope,
  reference: ModelAssuranceAssessmentReference,
): boolean {
  return (
    sameScope(record.scope, scope) &&
    record.assessmentExtensionId === reference.assessmentExtensionId &&
    record.definitionSha256 === reference.definitionSha256
  );
}

function exactComparison(
  record: ComparisonResult,
  scope: EvidenceScope,
  reference: { readonly definitionSha256: string; readonly resultId: string },
): boolean {
  return (
    sameScope(record.scope, scope) &&
    record.resultId === reference.resultId &&
    record.definitionSha256 === reference.definitionSha256
  );
}

function exactDataset(
  record: RegressionDatasetVersion,
  scope: EvidenceScope,
  reference: {
    readonly datasetId: string;
    readonly datasetVersionId: string;
    readonly definitionSha256: string;
  },
): boolean {
  return (
    sameScope(record.scope, scope) &&
    record.datasetId === reference.datasetId &&
    record.datasetVersionId === reference.datasetVersionId &&
    record.definitionSha256 === reference.definitionSha256
  );
}

function exactTargetRelease(
  record: TargetRelease,
  scope: EvidenceScope,
  reference: Extract<
    ReleaseCandidateSourceReference,
    { readonly kind: "target_release" }
  >["targetRelease"],
): boolean {
  return (
    sameScope(record.scope, scope) &&
    record.targetId === reference.targetId &&
    record.targetReleaseId === reference.targetReleaseId &&
    record.definitionSha256 === reference.definitionSha256 &&
    record.targetAdapter.name === reference.targetAdapter.name &&
    record.targetAdapter.protocolVersion === reference.targetAdapter.protocolVersion &&
    record.targetAdapter.version === reference.targetAdapter.version &&
    record.workerProtocol.name === reference.workerProtocol.name &&
    record.workerProtocol.version === reference.workerProtocol.version
  );
}

/**
 * Resolves candidate inputs from authoritative Workflow 1 repositories and explicit external
 * authorities. Every lookup is exact-scope, digest checked, and fail closed. Search results,
 * requester assertions, and merely reserved or expiring artifact metadata are never sufficient.
 */
export class RepositoryReleaseCandidateSourceResolver implements ReleaseCandidateSourceResolver {
  constructor(
    private readonly dependencies: RepositoryReleaseCandidateSourceResolverDependencies,
  ) {}

  async isAvailable(
    scope: EvidenceScope,
    reference: ReleaseCandidateSourceReference,
  ): Promise<boolean> {
    try {
      switch (reference.kind) {
        case "source_revision":
          return (
            (await this.dependencies.revisionAuthority?.isAvailable(
              structuredClone(scope),
              structuredClone(reference),
            )) === true
          );
        case "build_artifact":
        case "model_resolution_evidence":
        case "prompt":
        case "tool_contract":
          return await artifactAvailable(this.dependencies.artifacts, scope, reference);
        case "dataset_version": {
          const input = await this.dependencies.regressionVersionRepository.findDatasetVersion(
            structuredClone(scope),
            reference.dataset.datasetVersionId,
          );
          if (!input) return false;
          const record = validateAndProjectRegressionDatasetVersion(input).version;
          return exactDataset(record, scope, reference.dataset);
        }
        case "assessment": {
          const input = await this.dependencies.evaluationRepository.findAssessment(
            structuredClone(scope),
            reference.assessment.assessmentId,
          );
          if (!input) return false;
          const record = validateEvaluationRecord("assessment", input) as Assessment;
          return exactAssessment(record, scope, reference.assessment);
        }
        case "model_assurance_assessment": {
          const input = await this.dependencies.modelAssuranceRepository.find(
            structuredClone(scope),
            "model_assurance_assessment",
            reference.assessment.assessmentExtensionId,
          );
          if (!input) return false;
          const record = validateModelAssuranceRecord(
            "model_assurance_assessment",
            input,
          ) as ModelAssuranceAssessment;
          return exactModelAssuranceAssessment(record, scope, reference.assessment);
        }
        case "comparison_result": {
          const input = await this.dependencies.comparisonRepository.findComparisonResult(
            structuredClone(scope),
            reference.comparison.resultId,
          );
          if (!input) return false;
          const record = validateComparisonRecord("comparison_result", input) as ComparisonResult;
          return exactComparison(record, scope, reference.comparison);
        }
        case "model_declaration":
        case "runtime_adapter":
          return (
            (await this.dependencies.runtimeAuthority?.isAvailable(
              structuredClone(scope),
              structuredClone(reference),
            )) === true
          );
        case "target_release": {
          const input = await this.dependencies.replayDefinitionRepository.findTargetRelease(
            structuredClone(scope),
            reference.targetRelease.targetReleaseId,
          );
          if (!input) return false;
          const record = validateAndProjectTargetRelease(input).release;
          return exactTargetRelease(record, scope, reference.targetRelease);
        }
      }
    } catch {
      return false;
    }
  }
}
