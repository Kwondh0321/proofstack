import { createHash } from "node:crypto";
import type {
  ArtifactCatalogEntry,
  ArtifactCatalogRepository,
  ArtifactContentDecryptor,
  ArtifactObjectStore,
} from "@proofstack/artifacts";
import {
  type Assessment,
  type EvidenceScope,
  RegressionDatasetVersionDefinitionSchema,
  RegressionDatasetVersionSchema,
  type ReleaseCandidate,
  type ReleaseCandidateDefinition,
  ReleaseCandidateDefinitionSchema,
  TargetReleaseDefinitionSchema,
  TargetReleaseSchema,
} from "@proofstack/contracts";
import {
  CreateModelAssuranceAssessment,
  type ReleaseCandidateSourceReference,
  releaseCandidateSourceReferences,
} from "@proofstack/core";
import {
  createComparisonRepositoryTestHarness,
  createModelAssuranceRepositoryTestHarness,
  publishComparisonFixture,
  releaseCandidateFixture,
} from "@proofstack/core/testing";
import { digestRegressionDatasetVersionDefinition } from "@proofstack/datasets";
import { digestTargetReleaseDefinition } from "@proofstack/replay";
import { describe, expect, it, vi } from "vitest";
import { RepositoryCriteriaTrustArtifactResolver } from "./repository-criteria-trust-artifact-resolver.js";
import {
  RepositoryReleaseCandidateSourceResolver,
  type RepositoryReleaseCandidateSourceResolverDependencies,
} from "./repository-release-candidate-source-resolver.js";

const scope: EvidenceScope = {
  environmentId: "env_release_sources_primary",
  projectId: "prj_release_sources_primary",
  tenantId: "ten_release_sources",
};

function candidateDefinition(candidate: ReleaseCandidate): ReleaseCandidateDefinition {
  const {
    createdAt: _createdAt,
    createdByPrincipalId: _createdByPrincipalId,
    definitionSha256: _definitionSha256,
    schemaVersion: _schemaVersion,
    scope: _scope,
    ...definition
  } = candidate;
  return ReleaseCandidateDefinitionSchema.parse(definition);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function unavailableDependencies(
  overrides: Partial<RepositoryReleaseCandidateSourceResolverDependencies> = {},
): RepositoryReleaseCandidateSourceResolverDependencies {
  return {
    comparisonRepository: { findComparisonResult: async () => null },
    evaluationRepository: { findAssessment: async () => null },
    modelAssuranceRepository: { find: async () => null },
    regressionVersionRepository: { findDatasetVersion: async () => null },
    replayDefinitionRepository: { findTargetRelease: async () => null },
    ...overrides,
  };
}

function recordOf<Record>(
  records: readonly { readonly kind: string; readonly record: unknown }[],
  kind: string,
): Record {
  const fixture = records.find((candidate) => candidate.kind === kind);
  if (!fixture) throw new Error(`Expected ${kind} fixture`);
  return fixture.record as Record;
}

function datasetVersion() {
  const definition = RegressionDatasetVersionDefinitionSchema.parse({
    datasetId: "dataset_release_sources",
    datasetVersionId: "dataset_release_sources_v1",
    fixtureVersions: [
      {
        definitionSha256: "1".repeat(64),
        fixtureId: "fixture_release_sources",
        fixtureVersionId: "fixture_release_sources_v1",
      },
    ],
    name: "Release source dataset",
    schemaVersion: "0.1",
    scope,
  });
  return RegressionDatasetVersionSchema.parse({
    ...definition,
    createdAt: "2026-09-06T00:00:00.000Z",
    createdByPrincipalId: "usr_release_sources",
    definitionSha256: digestRegressionDatasetVersionDefinition(definition),
  });
}

function targetRelease() {
  const definition = TargetReleaseDefinitionSchema.parse({
    build: {
      builderId: "proofstack.reference_builder",
      dependencySnapshotSha256: "2".repeat(64),
      executableSha256: "3".repeat(64),
      invocationSha256: "4".repeat(64),
      provenance: {
        artifactId: "artifact_target_provenance",
        classification: "internal",
        mediaType: "application/json",
        sha256: "5".repeat(64),
        sizeBytes: 128,
      },
    },
    environmentVariableNames: [],
    execution: {
      implementationId: "implementation_release_sources",
      implementationSha256: "6".repeat(64),
      kind: "preinstalled",
    },
    mounts: [],
    outputLimits: {
      emittedArtifactBytes: 1_048_576,
      stderrBytes: 65_536,
      stdoutBytes: 65_536,
    },
    runtime: {
      architecture: "x64",
      entryPoint: "dist/target.js",
      family: "node",
      platform: "linux",
      version: "24.7.0",
    },
    schemaVersion: "0.1",
    scope,
    source: {
      repositoryUrl: "https://github.com/Kwondh0321/proofstack",
      revision: "7".repeat(40),
    },
    subprocessPolicy: { mode: "denied" },
    supportedBoundaryKinds: ["model"],
    supportedBoundaryModes: ["recorded_stub"],
    targetAdapter: {
      name: "proofstack.reference_target",
      protocolVersion: "1.0.0",
      version: "1.0.0",
    },
    targetId: "target_release_sources",
    targetReleaseId: "target_release_sources_v1",
    workerProtocol: { name: "proofstack.replay-worker", version: "1.0.0" },
  });
  return TargetReleaseSchema.parse({
    ...definition,
    createdAt: "2026-09-06T00:00:00.000Z",
    createdByPrincipalId: "usr_release_sources",
    definitionSha256: digestTargetReleaseDefinition(definition),
  });
}

function targetReference(
  release: ReturnType<typeof targetRelease>,
): ReleaseCandidateSourceReference {
  return {
    kind: "target_release",
    targetRelease: {
      definitionSha256: release.definitionSha256,
      targetAdapter: release.targetAdapter,
      targetId: release.targetId,
      targetReleaseId: release.targetReleaseId,
      workerProtocol: release.workerProtocol,
    },
  };
}

function artifactSources(
  options: {
    readonly catalogError?: boolean;
    readonly classification?: "confidential" | "internal" | "metadata" | "restricted";
    readonly decrypted?: Uint8Array;
    readonly retention?:
      | { readonly expiresAt: string; readonly mode: "expire" }
      | { readonly mode: "retain" };
  } = {},
) {
  const plaintext = Buffer.from("retained release source", "utf8");
  const encrypted = Buffer.from("encrypted retained release source", "utf8");
  const artifact = {
    artifactId: "artifact_release_source",
    classification: "internal" as const,
    mediaType: "application/octet-stream",
    sha256: sha256(plaintext),
    sizeBytes: plaintext.byteLength,
  };
  const entry: ArtifactCatalogEntry = {
    createdByPrincipalId: "usr_release_sources",
    encryption: {
      contentNonce: Buffer.alloc(12).toString("base64url"),
      version: "a256gcm-v1",
      wrappedDataKey: {
        algorithm: "A256GCM",
        ciphertext: Buffer.alloc(32).toString("base64url"),
        keyId: "key_release_sources",
        nonce: Buffer.alloc(12).toString("base64url"),
        tag: Buffer.alloc(16).toString("base64url"),
      },
    },
    metadata: {
      availableAt: "2026-09-06T00:00:01.000Z",
      contentReference: {
        ...artifact,
        classification: options.classification ?? artifact.classification,
      },
      createdAt: "2026-09-06T00:00:00.000Z",
      redaction: { status: "not_required" },
      retention: options.retention ?? { mode: "retain" },
      schemaVersion: "0.1",
      scope,
      state: "available",
    },
    objectKey: "ten_release_sources/artifact_release_source",
    objectReceipt: { sha256: sha256(encrypted), sizeBytes: encrypted.byteLength },
  };
  const catalog: ArtifactCatalogRepository = {
    activate: vi.fn(),
    find: vi.fn(async () => {
      if (options.catalogError) throw new Error("catalog unavailable");
      return entry;
    }),
    findPurgeReceipt: vi.fn(),
    listAbandoned: vi.fn(),
    listExpired: vi.fn(),
    listKeyReferences: vi.fn(),
    listPendingPurge: vi.fn(),
    recordPurge: vi.fn(),
    reserve: vi.fn(),
    tombstone: vi.fn(),
  };
  const encryption: ArtifactContentDecryptor = {
    decrypt: vi.fn(async () => options.decrypted ?? plaintext),
  };
  const objects: ArtifactObjectStore = {
    delete: vi.fn(),
    get: vi.fn(async () => encrypted),
    putIfAbsent: vi.fn(),
  };
  return {
    artifact,
    sources: {
      catalog,
      verifier: new RepositoryCriteriaTrustArtifactResolver({ catalog, encryption, objects }),
    },
  };
}

describe("RepositoryReleaseCandidateSourceResolver", () => {
  it("proves exact retained artifact bytes instead of trusting catalog presence", async () => {
    const { artifact, sources } = artifactSources();
    const resolver = new RepositoryReleaseCandidateSourceResolver(
      unavailableDependencies({ artifacts: sources }),
    );

    await expect(
      resolver.isAvailable(scope, { artifact, kind: "build_artifact", role: "agent_bundle" }),
    ).resolves.toBe(true);
  });

  it("rejects expiring, descriptor-substituted, unreadable, or failed artifact sources", async () => {
    const expiring = artifactSources({
      retention: { expiresAt: "2027-09-06T00:00:00.000Z", mode: "expire" },
    });
    const substituted = artifactSources({ classification: "confidential" });
    const unreadable = artifactSources({ decrypted: Buffer.from("substituted bytes", "utf8") });
    const failed = artifactSources({ catalogError: true });

    for (const fixture of [expiring, substituted, unreadable, failed]) {
      const resolver = new RepositoryReleaseCandidateSourceResolver(
        unavailableDependencies({ artifacts: fixture.sources }),
      );
      await expect(
        resolver.isAvailable(scope, {
          artifact: fixture.artifact,
          kind: "build_artifact",
          role: "agent_bundle",
        }),
      ).resolves.toBe(false);
    }
  });

  it("validates repository records, canonical digests, and exact scope for Workflow 1 sources", async () => {
    const assurance = await createModelAssuranceRepositoryTestHarness("release_sources");
    const assessment = recordOf<Assessment>(assurance.evaluation.records, "assessment");
    const modelAssessment = (
      await new CreateModelAssuranceAssessment({
        clock: { now: () => new Date("2026-09-03T00:00:00.000Z") },
        evaluationRepository: assurance.evaluation.repository,
        modelAssuranceRepository: assurance.repository,
      }).execute(assurance.command)
    ).record;
    const comparisonHarness = createComparisonRepositoryTestHarness("release_sources");
    for (const fixture of comparisonHarness.records) {
      await publishComparisonFixture(comparisonHarness.repository, fixture);
    }
    const comparison = comparisonHarness.records.find(
      (fixture) => fixture.kind === "comparison_result",
    );
    if (comparison?.kind !== "comparison_result") {
      throw new Error("Expected comparison result fixture");
    }
    const dataset = datasetVersion();
    const target = targetRelease();
    const resolver = new RepositoryReleaseCandidateSourceResolver({
      comparisonRepository: comparisonHarness.repository,
      evaluationRepository: assurance.evaluation.repository,
      modelAssuranceRepository: assurance.repository,
      regressionVersionRepository: { findDatasetVersion: async () => dataset },
      replayDefinitionRepository: { findTargetRelease: async () => target },
    });
    const references: readonly ReleaseCandidateSourceReference[] = [
      {
        assessment: {
          assessmentId: assessment.assessmentId,
          definitionSha256: assessment.definitionSha256,
        },
        kind: "assessment",
      },
      {
        assessment: {
          assessmentExtensionId: modelAssessment.assessmentExtensionId,
          definitionSha256: modelAssessment.definitionSha256,
        },
        kind: "model_assurance_assessment",
      },
      {
        comparison: {
          definitionSha256: comparison.record.definitionSha256,
          resultId: comparison.record.resultId,
        },
        kind: "comparison_result",
      },
      {
        dataset: {
          datasetId: dataset.datasetId,
          datasetVersionId: dataset.datasetVersionId,
          definitionSha256: dataset.definitionSha256,
        },
        kind: "dataset_version",
      },
      targetReference(target),
    ];

    for (const reference of references) {
      await expect(resolver.isAvailable(scope, reference)).resolves.toBe(true);
    }

    await expect(
      resolver.isAvailable(
        { ...scope, environmentId: "env_hidden" },
        references[0] as ReleaseCandidateSourceReference,
      ),
    ).resolves.toBe(false);
    await expect(
      resolver.isAvailable(scope, {
        assessment: {
          assessmentId: assessment.assessmentId,
          definitionSha256: "f".repeat(64),
        },
        kind: "assessment",
      }),
    ).resolves.toBe(false);

    const forgedDigest = "e".repeat(64);
    const forged = new RepositoryReleaseCandidateSourceResolver(
      unavailableDependencies({
        evaluationRepository: {
          findAssessment: async () => ({ ...assessment, definitionSha256: forgedDigest }),
        },
      }),
    );
    await expect(
      forged.isAvailable(scope, {
        assessment: { assessmentId: assessment.assessmentId, definitionSha256: forgedDigest },
        kind: "assessment",
      }),
    ).resolves.toBe(false);
  });

  it("requires explicit source-control and runtime authorities and accepts only literal true", async () => {
    const candidate = releaseCandidateFixture("external_sources", scope);
    const references = releaseCandidateSourceReferences(candidateDefinition(candidate));
    const revision = references.find((reference) => reference.kind === "source_revision");
    const runtime = references.filter(
      (reference) => reference.kind === "model_declaration" || reference.kind === "runtime_adapter",
    );
    if (!revision || runtime.length !== 2) throw new Error("Expected external candidate sources");

    const unresolved = new RepositoryReleaseCandidateSourceResolver(unavailableDependencies());
    await expect(unresolved.isAvailable(scope, revision)).resolves.toBe(false);
    await expect(
      unresolved.isAvailable(scope, runtime[0] as ReleaseCandidateSourceReference),
    ).resolves.toBe(false);

    const revisionAuthority = { isAvailable: vi.fn(async () => true) };
    const runtimeAuthority = { isAvailable: vi.fn(async () => true) };
    const resolved = new RepositoryReleaseCandidateSourceResolver(
      unavailableDependencies({ revisionAuthority, runtimeAuthority }),
    );
    await expect(resolved.isAvailable(scope, revision)).resolves.toBe(true);
    for (const reference of runtime) {
      await expect(resolved.isAvailable(scope, reference)).resolves.toBe(true);
    }
    expect(revisionAuthority.isAvailable).toHaveBeenCalledWith(scope, revision);
    expect(runtimeAuthority.isAvailable).toHaveBeenCalledTimes(2);

    const ambiguous = new RepositoryReleaseCandidateSourceResolver(
      unavailableDependencies({
        runtimeAuthority: { isAvailable: async () => "truthy" as never },
      }),
    );
    await expect(
      ambiguous.isAvailable(scope, runtime[0] as ReleaseCandidateSourceReference),
    ).resolves.toBe(false);
  });

  it("fails closed on repository and authority errors", async () => {
    const candidate = releaseCandidateFixture("source_errors", scope);
    const source = releaseCandidateSourceReferences(candidateDefinition(candidate)).find(
      (reference) => reference.kind === "source_revision",
    );
    if (!source) throw new Error("Expected source revision");
    const resolver = new RepositoryReleaseCandidateSourceResolver(
      unavailableDependencies({
        evaluationRepository: {
          findAssessment: async () => {
            throw new Error("database unavailable");
          },
        },
        revisionAuthority: {
          isAvailable: async () => {
            throw new Error("source authority unavailable");
          },
        },
      }),
    );

    await expect(resolver.isAvailable(scope, source)).resolves.toBe(false);
    await expect(
      resolver.isAvailable(scope, {
        assessment: { assessmentId: "assessment_error", definitionSha256: "0".repeat(64) },
        kind: "assessment",
      }),
    ).resolves.toBe(false);
  });
});
