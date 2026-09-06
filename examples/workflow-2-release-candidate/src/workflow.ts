import { createHash } from "node:crypto";
import {
  type EvidenceScope,
  type PublishReleaseCandidateRequest,
  PublishReleaseCandidateRequestSchema,
  type PublishReleaseCandidateResponse,
  type ReadReleaseCandidateResponse,
  type RecordedInteractionFixtureVersion,
  type ReleaseCandidate,
  type ReleaseCandidateAdapterReference,
  type ReleaseCandidateBuildArtifact,
  type ReleaseCandidateModelDeclaration,
  type ReleaseCandidateSource,
  type TargetRelease,
} from "@proofstack/contracts";

const REFERENCE_ADAPTER_DEFINITION = `${JSON.stringify({
  boundary: "model",
  input: "proofstack.recorded-provider-neutral.v1",
  name: "proofstack.reference.model",
  output: "proofstack.recorded-provider-neutral.v1",
  version: "1.0.0",
})}\n`;

export const WORKFLOW_2_REFERENCE_MODEL_DECLARATION: ReleaseCandidateModelDeclaration = {
  providerId: "provider_neutral_reference",
  providerModelId: "reference-model-v1",
  resolution: {
    declaredAlias: "reference-model-v1",
    limitation: "The reference provider does not expose an immutable served-model identifier.",
    status: "provider_alias_only",
  },
};

export const WORKFLOW_2_REFERENCE_MODEL_ADAPTER: ReleaseCandidateAdapterReference = {
  adapterId: "adapter_proofstack_reference_model",
  adapterVersionId: "adapter_proofstack_reference_model_v1",
  definitionSha256: createHash("sha256").update(REFERENCE_ADAPTER_DEFINITION).digest("hex"),
};

interface RecordedFixtureReader {
  readRecordedInteractionFixtureMetadata(input: {
    readonly fixtureId: string;
    readonly fixtureVersionId: string;
  }): Promise<{ readonly version: RecordedInteractionFixtureVersion }>;
}

interface TargetReleaseReader {
  readTargetRelease(input: {
    readonly targetId: string;
    readonly targetReleaseId: string;
  }): Promise<{ readonly release: TargetRelease }>;
}

interface ReleaseCandidateClient {
  publishCandidate(input: {
    readonly candidateId: string;
    readonly request: PublishReleaseCandidateRequest;
  }): Promise<PublishReleaseCandidateResponse>;
  readCandidate(input: {
    readonly candidateId: string;
    readonly candidateVersionId: string;
  }): Promise<ReadReleaseCandidateResponse>;
}

/**
 * Minimal retained Workflow 1 projection required to construct a release candidate. Keeping this
 * structural boundary local prevents either workflow package from owning the other workflow's
 * complete acceptance result or creating a package dependency cycle.
 */
export interface Workflow1CandidateSources {
  readonly durableReplay: {
    readonly dataset: {
      readonly datasetId: string;
      readonly datasetVersionId: string;
      readonly definitionSha256: string;
    };
    readonly fixture: {
      readonly fixtureId: string;
      readonly fixtureVersionId: string;
      readonly definitionSha256: string;
    };
    readonly targetRelease: {
      readonly targetId: string;
      readonly targetReleaseId: string;
      readonly definitionSha256: string;
    };
  };
  readonly evaluation: {
    readonly assessment: {
      readonly assessmentId: string;
      readonly definitionSha256: string;
    };
  };
  readonly modelAssurance: {
    readonly assessment: {
      readonly assessmentExtensionId: string;
      readonly definitionSha256: string;
    };
  };
  readonly result: {
    readonly definitionSha256: string;
    readonly resultId: string;
  };
  readonly scope: EvidenceScope;
}

export interface RunWorkflow2ReleaseCandidateOptions {
  readonly candidateClient: ReleaseCandidateClient;
  readonly fixtureReader: RecordedFixtureReader;
  readonly namespace: string;
  readonly source: ReleaseCandidateSource;
  readonly targetReleaseReader: TargetReleaseReader;
  readonly workflow1: Workflow1CandidateSources;
}

export interface Workflow2ReleaseCandidateSummary {
  readonly candidate: ReleaseCandidate;
  readonly exactReferences: {
    readonly buildProvenanceArtifactId: string;
    readonly comparisonResultId: string;
    readonly datasetVersionId: string;
    readonly promptArtifactId: string;
    readonly targetReleaseId: string;
    readonly toolContractArtifactId: string;
  };
  readonly idempotentRetryConfirmed: true;
}

function sameScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

function exactArtifact(
  fixture: RecordedInteractionFixtureVersion,
  role: "prompt.template" | "tool.contract",
): ReleaseCandidateBuildArtifact["artifact"] {
  const matches = fixture.interactionCapture.artifacts.filter((binding) => binding.role === role);
  if (matches.length !== 1) {
    throw new TypeError(`Workflow 1 fixture must retain exactly one ${role} artifact`);
  }
  const [binding] = matches as [
    RecordedInteractionFixtureVersion["interactionCapture"]["artifacts"][number],
  ];
  return structuredClone(binding.contentReference);
}

function assertWorkflow1SourceGraph(
  workflow1: Workflow1CandidateSources,
  fixture: RecordedInteractionFixtureVersion,
  release: TargetRelease,
  source: ReleaseCandidateSource,
): void {
  if (
    !sameScope(workflow1.scope, fixture.scope) ||
    !sameScope(workflow1.scope, release.scope) ||
    fixture.fixtureId !== workflow1.durableReplay.fixture.fixtureId ||
    fixture.fixtureVersionId !== workflow1.durableReplay.fixture.fixtureVersionId ||
    fixture.definitionSha256 !== workflow1.durableReplay.fixture.definitionSha256
  ) {
    throw new TypeError("Workflow 1 fixture no longer matches the accepted exact source graph");
  }
  if (
    release.targetId !== workflow1.durableReplay.targetRelease.targetId ||
    release.targetReleaseId !== workflow1.durableReplay.targetRelease.targetReleaseId ||
    release.definitionSha256 !== workflow1.durableReplay.targetRelease.definitionSha256
  ) {
    throw new TypeError(
      "Workflow 1 target release no longer matches the accepted exact source graph",
    );
  }
  if (
    release.source.repositoryUrl !== source.repositoryUrl ||
    release.source.revision !== source.commit.value
  ) {
    throw new TypeError("Candidate source must equal the retained target release source revision");
  }
}

function assertCandidateResponse(
  response: PublishReleaseCandidateResponse | ReadReleaseCandidateResponse,
  expectedCandidateId: string,
  expectedVersionId: string,
  expectedDigest: string,
): void {
  const candidate = response.candidate;
  if (
    candidate.candidateId !== expectedCandidateId ||
    candidate.candidateVersionId !== expectedVersionId ||
    candidate.definitionSha256 !== expectedDigest
  ) {
    throw new TypeError("Release candidate read-back changed exact immutable identity");
  }
}

/**
 * Publishes the first Workflow 2 subject from retained Workflow 1 records. This example creates no
 * evidence, policy, approval, or deployment action: it reads exact upstream records, binds them to
 * one candidate, proves idempotent publication, and verifies the immutable read-back.
 */
export async function runWorkflow2ReleaseCandidate(
  options: RunWorkflow2ReleaseCandidateOptions,
): Promise<Workflow2ReleaseCandidateSummary> {
  const fixture = (
    await options.fixtureReader.readRecordedInteractionFixtureMetadata(
      options.workflow1.durableReplay.fixture,
    )
  ).version;
  const targetRelease = (
    await options.targetReleaseReader.readTargetRelease(
      options.workflow1.durableReplay.targetRelease,
    )
  ).release;
  assertWorkflow1SourceGraph(options.workflow1, fixture, targetRelease, options.source);

  const prompt = exactArtifact(fixture, "prompt.template");
  const toolContract = exactArtifact(fixture, "tool.contract");
  const candidateId = `candidate_${options.namespace}_workflow_1`;
  const candidateVersionId = `${candidateId}_v1`;
  const request = PublishReleaseCandidateRequestSchema.parse({
    assessments: [structuredClone(options.workflow1.evaluation.assessment)],
    buildArtifacts: [
      { artifact: structuredClone(targetRelease.build.provenance), role: "build_provenance" },
    ],
    candidateVersionId,
    comparisons: [
      {
        definitionSha256: options.workflow1.result.definitionSha256,
        resultId: options.workflow1.result.resultId,
      },
    ],
    contentProjection: "artifact_references_only",
    datasets: [structuredClone(options.workflow1.durableReplay.dataset)],
    description:
      "One exact retained Workflow 1 graph prepared for later release-policy evaluation.",
    knownLimitations: [
      "Model version resolution is provider alias only.",
      "No release policy, approval, attestation, CI status, or deployment action is included.",
    ].sort(),
    modelAssuranceAssessments: [
      {
        assessmentExtensionId: options.workflow1.modelAssurance.assessment.assessmentExtensionId,
        definitionSha256: options.workflow1.modelAssurance.assessment.definitionSha256,
      },
    ],
    name: "Workflow 1 reference release candidate",
    omissions: [],
    runtimeComponents: [
      {
        adapter: structuredClone(WORKFLOW_2_REFERENCE_MODEL_ADAPTER),
        kind: "model",
        ...structuredClone(WORKFLOW_2_REFERENCE_MODEL_DECLARATION),
        role: "primary_model",
      },
      { content: prompt, kind: "prompt", role: "system_prompt" },
      { content: toolContract, kind: "tool_contract", role: "inventory_lookup" },
    ],
    source: structuredClone(options.source),
    target: {
      environmentId: options.workflow1.scope.environmentId,
      maximumDataClassification: "confidential",
      populationTags: ["acceptance", "reference"],
      purpose:
        "Bind the retained reference agent and its evidence before selecting a release policy.",
      riskTier: "high",
      taskKind: "inventory_lookup_agent",
    },
    targetRelease: {
      definitionSha256: targetRelease.definitionSha256,
      targetAdapter: structuredClone(targetRelease.targetAdapter),
      targetId: targetRelease.targetId,
      targetReleaseId: targetRelease.targetReleaseId,
      workerProtocol: structuredClone(targetRelease.workerProtocol),
    },
  });

  const published = await options.candidateClient.publishCandidate({ candidateId, request });
  if (!published.created)
    throw new TypeError("First release candidate publication was not created");
  assertCandidateResponse(
    published,
    candidateId,
    candidateVersionId,
    published.candidate.definitionSha256,
  );

  const retry = await options.candidateClient.publishCandidate({ candidateId, request });
  if (retry.created) throw new TypeError("Identical release candidate retry created a new record");
  assertCandidateResponse(
    retry,
    candidateId,
    candidateVersionId,
    published.candidate.definitionSha256,
  );

  const readBack = await options.candidateClient.readCandidate({ candidateId, candidateVersionId });
  assertCandidateResponse(
    readBack,
    candidateId,
    candidateVersionId,
    published.candidate.definitionSha256,
  );

  return Object.freeze({
    candidate: structuredClone(readBack.candidate),
    exactReferences: {
      buildProvenanceArtifactId: targetRelease.build.provenance.artifactId,
      comparisonResultId: options.workflow1.result.resultId,
      datasetVersionId: options.workflow1.durableReplay.dataset.datasetVersionId,
      promptArtifactId: prompt.artifactId,
      targetReleaseId: targetRelease.targetReleaseId,
      toolContractArtifactId: toolContract.artifactId,
    },
    idempotentRetryConfirmed: true,
  });
}
