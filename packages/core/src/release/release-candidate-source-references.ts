import type {
  ReleaseCandidateDefinition,
  ReleaseCandidateRuntimeComponent,
} from "@proofstack/contracts";
import { ReleaseCandidateDefinitionSchema } from "@proofstack/contracts";

type ModelComponent = Extract<ReleaseCandidateRuntimeComponent, { readonly kind: "model" }>;
type ArtifactContentReference = ReleaseCandidateDefinition["buildArtifacts"][number]["artifact"];
type AssessmentReference = ReleaseCandidateDefinition["assessments"][number];
type DatasetReference = ReleaseCandidateDefinition["datasets"][number];
type ModelAssuranceAssessmentReference =
  ReleaseCandidateDefinition["modelAssuranceAssessments"][number];
type ComparisonReference = ReleaseCandidateDefinition["comparisons"][number];
type SourceReference = ReleaseCandidateDefinition["source"];
type TargetReleaseReference = ReleaseCandidateDefinition["targetRelease"];

export type ReleaseCandidateSourceReference =
  | { readonly kind: "source_revision"; readonly source: SourceReference }
  | {
      readonly artifact: ArtifactContentReference;
      readonly kind: "build_artifact";
      readonly role: string;
    }
  | {
      readonly dataset: DatasetReference;
      readonly kind: "dataset_version";
    }
  | { readonly assessment: AssessmentReference; readonly kind: "assessment" }
  | {
      readonly assessment: ModelAssuranceAssessmentReference;
      readonly kind: "model_assurance_assessment";
    }
  | {
      readonly comparison: ComparisonReference;
      readonly kind: "comparison_result";
    }
  | {
      readonly kind: "model_declaration";
      readonly providerId: string;
      readonly providerModelId: string;
      readonly resolution: ModelComponent["resolution"];
      readonly role: string;
    }
  | {
      readonly adapter: ModelComponent["adapter"];
      readonly kind: "runtime_adapter";
      readonly role: string;
    }
  | {
      readonly artifact: ArtifactContentReference;
      readonly kind: "model_resolution_evidence";
      readonly role: string;
    }
  | {
      readonly artifact: ArtifactContentReference;
      readonly kind: "prompt";
      readonly role: string;
    }
  | {
      readonly artifact: ArtifactContentReference;
      readonly kind: "tool_contract";
      readonly role: string;
    }
  | { readonly kind: "target_release"; readonly targetRelease: TargetReleaseReference };

/**
 * Expands one strict candidate definition into every external source that publication must resolve.
 * Category order is fixed and source arrays already require exact-identity ordering.
 */
export function releaseCandidateSourceReferences(
  definition: ReleaseCandidateDefinition,
): readonly ReleaseCandidateSourceReference[] {
  const parsed = ReleaseCandidateDefinitionSchema.parse(definition);
  const references: ReleaseCandidateSourceReference[] = [
    { kind: "source_revision", source: parsed.source },
    ...parsed.buildArtifacts.map(({ artifact, role }) => ({
      artifact,
      kind: "build_artifact" as const,
      role,
    })),
    ...parsed.datasets.map((dataset) => ({ dataset, kind: "dataset_version" as const })),
    ...parsed.assessments.map((assessment) => ({ assessment, kind: "assessment" as const })),
    ...parsed.modelAssuranceAssessments.map((assessment) => ({
      assessment,
      kind: "model_assurance_assessment" as const,
    })),
    ...parsed.comparisons.map((comparison) => ({
      comparison,
      kind: "comparison_result" as const,
    })),
  ];

  for (const component of parsed.runtimeComponents) {
    if (component.kind === "model") {
      references.push(
        {
          kind: "model_declaration",
          providerId: component.providerId,
          providerModelId: component.providerModelId,
          resolution: component.resolution,
          role: component.role,
        },
        { adapter: component.adapter, kind: "runtime_adapter", role: component.role },
      );
      if (component.resolution.status === "exact") {
        references.push({
          artifact: component.resolution.resolutionEvidence,
          kind: "model_resolution_evidence",
          role: component.role,
        });
      }
    } else {
      references.push({ artifact: component.content, kind: component.kind, role: component.role });
    }
  }
  references.push({ kind: "target_release", targetRelease: parsed.targetRelease });
  return references;
}

export function releaseCandidateSourceReferenceId(
  reference: ReleaseCandidateSourceReference,
): string {
  switch (reference.kind) {
    case "source_revision":
      return `${reference.source.commit.algorithm}:${reference.source.commit.value}`;
    case "build_artifact":
    case "model_resolution_evidence":
    case "prompt":
    case "tool_contract":
      return reference.artifact.artifactId;
    case "dataset_version":
      return reference.dataset.datasetVersionId;
    case "assessment":
      return reference.assessment.assessmentId;
    case "model_assurance_assessment":
      return reference.assessment.assessmentExtensionId;
    case "comparison_result":
      return reference.comparison.resultId;
    case "model_declaration":
      return `${reference.providerId}:${reference.role}`;
    case "runtime_adapter":
      return reference.adapter.adapterVersionId;
    case "target_release":
      return reference.targetRelease.targetReleaseId;
  }
}
