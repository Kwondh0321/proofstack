import type {
  ComparisonDefinition,
  EvidenceScope,
  ReplayPlanDefinition,
  TargetReleaseDefinition,
} from "@proofstack/contracts";
import {
  RegressionDatasetVersionDefinitionSchema,
  RegressionDatasetVersionSchema,
  RegressionFixtureVersionDefinitionSchema,
  RegressionFixtureVersionSchema,
  ReplayPlanSchema,
  TargetReleaseSchema,
} from "@proofstack/contracts";
import { ComparisonSourceUnavailableError, MemoryEvidenceRepository } from "@proofstack/core";
import {
  digestRegressionDatasetVersionDefinition,
  digestRegressionFixtureVersionDefinition,
} from "@proofstack/datasets";
import { MemoryRegressionVersionRepository } from "@proofstack/datasets/testing";
import { digestReplayPlanDefinition, digestTargetReleaseDefinition } from "@proofstack/replay";
import {
  MemoryReplayDefinitionRepository,
  MemoryReplayJobRepository,
} from "@proofstack/replay/testing";
import { describe, expect, it } from "vitest";
import { RepositoryComparisonEvidenceResolver } from "./repository-comparison-evidence-resolver.js";

const sha = (digit: string): string => digit.repeat(64);
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const scope: EvidenceScope = {
  environmentId: "env_comparison_resolver",
  projectId: "prj_comparison_resolver",
  tenantId: "ten_comparison_resolver",
};

function releaseDefinition(): TargetReleaseDefinition {
  return {
    build: {
      builderId: "proofstack.test_builder",
      dependencySnapshotSha256: sha("1"),
      executableSha256: sha("2"),
      invocationSha256: sha("3"),
      provenance: {
        artifactId: "art_build_provenance",
        classification: "internal",
        mediaType: "application/json",
        sha256: sha("4"),
        sizeBytes: 64,
      },
    },
    environmentVariableNames: [],
    execution: {
      implementationId: "impl_comparison_target",
      implementationSha256: sha("5"),
      kind: "preinstalled",
    },
    mounts: [],
    outputLimits: {
      emittedArtifactBytes: 1_024,
      stderrBytes: 1_024,
      stdoutBytes: 1_024,
    },
    runtime: {
      architecture: "x64",
      entryPoint: "dist/target.js",
      family: "node",
      platform: "linux",
      version: "24.0.0",
    },
    schemaVersion: "0.1",
    scope,
    source: {
      repositoryUrl: "https://github.com/Kwondh0321/proofstack",
      revision: "6".repeat(40),
    },
    subprocessPolicy: { mode: "denied" },
    supportedBoundaryKinds: ["model"],
    supportedBoundaryModes: ["live_provider"],
    targetAdapter: {
      name: "proofstack.test_target",
      protocolVersion: "1.0.0",
      version: "1.0.0",
    },
    targetId: "target_comparison",
    targetReleaseId: "release_comparison_v1",
    workerProtocol: { name: "proofstack.worker", version: "1.0.0" },
  };
}

function planDefinition(
  target: ReturnType<typeof TargetReleaseSchema.parse>,
  dataset: ReturnType<typeof RegressionDatasetVersionSchema.parse>,
): ReplayPlanDefinition {
  const budget = Object.fromEntries(
    [
      "concurrentInteractions",
      "elapsedMilliseconds",
      "emittedArtifactBytes",
      "inputTokens",
      "jobAttempts",
      "modelRequests",
      "outputTokens",
      "providerCostMicrounits",
      "retrievedBytes",
      "toolCalls",
    ].map((dimension) => [
      dimension,
      { limit: dimension === "elapsedMilliseconds" ? 10_000 : 100, measurement: "measured" },
    ]),
  ) as ReplayPlanDefinition["budget"];
  return {
    boundaries: [
      {
        boundaryId: "boundary_model",
        credential: {
          credentialId: "credential_test",
          credentialVersionId: "credential_test_v1",
        },
        destination: { hostname: "api.example.com", port: 443, scheme: "https" },
        endpointProfile: {
          definitionSha256: sha("7"),
          endpointProfileId: "endpoint_test",
          endpointProfileVersion: "1.0.0",
        },
        kind: "model",
        mode: "live_provider",
        operation: "generate",
        requestLimits: { requestBytes: 1_024, responseBytes: 1_024 },
        sideEffect: { kind: "read_only" },
        usageSource: "measured",
      },
    ],
    budget,
    dataset: {
      datasetId: dataset.datasetId,
      datasetVersionId: dataset.datasetVersionId,
      definitionSha256: dataset.definitionSha256,
    },
    isolationProfile: {
      definitionSha256: sha("8"),
      id: "isolation_test",
      kind: "local_child_process",
      version: "1.0.0",
    },
    planId: "plan_comparison",
    planVersionId: "plan_comparison_v1",
    retryPolicy: {
      automatic: false,
      backoff: { kind: "none" },
      idempotencyRequirement: "read_only",
      maxAttempts: 1,
      perAttemptTimeoutMilliseconds: 2_000,
      retryableErrors: [],
      totalDeadlineMilliseconds: 5_000,
    },
    runtimeProfile: {
      definitionSha256: sha("9"),
      family: "node",
      id: "runtime_test",
      version: "1.0.0",
    },
    schemaVersion: "0.1",
    scope,
    targetRelease: {
      definitionSha256: target.definitionSha256,
      targetAdapter: target.targetAdapter,
      targetId: target.targetId,
      targetReleaseId: target.targetReleaseId,
      workerProtocol: target.workerProtocol,
    },
    workerProtocol: target.workerProtocol,
  };
}

async function graph() {
  const evidence = new MemoryEvidenceRepository();
  await evidence.append(
    ["evt_agent_start", "evt_guardrail"].map((eventId, index) => ({
      evidence: {
        attributes: {},
        contentReferences: [],
        eventId,
        extensions: {},
        kind: index === 0 ? ("agent.run" as const) : ("guardrail.check" as const),
        name: index === 0 ? "Agent started" : "Policy evaluated",
        sequence: index,
        source: {
          sdkName: "proofstack.test",
          sdkVersion: "1.0.0",
          serviceName: "comparison-resolver-test",
        },
        spanId: index === 0 ? "00f067aa0ba902b7" : "b7ad6b7169203331",
        startedAt: `2026-09-05T00:00:0${index}.000Z`,
        status: "ok" as const,
        traceId,
      },
      receivedAt: `2026-09-05T00:00:0${index}.100Z`,
      schemaVersion: "0.1" as const,
      scope,
    })),
  );

  const regression = new MemoryRegressionVersionRepository();
  const fixtureDefinition = RegressionFixtureVersionDefinitionSchema.parse({
    fixtureId: "fixture_comparison",
    fixtureVersionId: "fixture_comparison_v1",
    name: "Comparison fixture",
    replayability: "evidence_only",
    schemaVersion: "0.1",
    scope,
    source: {
      eventIds: ["evt_agent_start", "evt_guardrail"],
      kind: "trace_snapshot",
      observedEventCount: 2,
      sourceCompleteness: "observed_snapshot",
      traceId,
    },
  });
  const fixture = RegressionFixtureVersionSchema.parse({
    createdAt: "2026-09-05T00:00:02.000Z",
    createdByPrincipalId: "usr_test",
    definitionSha256: digestRegressionFixtureVersionDefinition(fixtureDefinition),
    ...fixtureDefinition,
    source: { capturedAt: "2026-09-05T00:00:01.500Z", ...fixtureDefinition.source },
  });
  await regression.publishFixtureVersion(fixture);
  const datasetDefinition = RegressionDatasetVersionDefinitionSchema.parse({
    datasetId: "dataset_comparison",
    datasetVersionId: "dataset_comparison_v1",
    fixtureVersions: [
      {
        definitionSha256: fixture.definitionSha256,
        fixtureId: fixture.fixtureId,
        fixtureVersionId: fixture.fixtureVersionId,
      },
    ],
    name: "Comparison dataset",
    schemaVersion: "0.1",
    scope,
  });
  const dataset = RegressionDatasetVersionSchema.parse({
    createdAt: "2026-09-05T00:00:03.000Z",
    createdByPrincipalId: "usr_test",
    definitionSha256: digestRegressionDatasetVersionDefinition(datasetDefinition),
    ...datasetDefinition,
  });
  await regression.publishDatasetVersion(dataset);

  const definitions = new MemoryReplayDefinitionRepository();
  const targetDefinition = releaseDefinition();
  const target = TargetReleaseSchema.parse({
    createdAt: "2026-09-05T00:00:04.000Z",
    createdByPrincipalId: "usr_test",
    definitionSha256: digestTargetReleaseDefinition(targetDefinition),
    ...targetDefinition,
  });
  await definitions.publishTargetRelease(target);
  const replayDefinition = planDefinition(target, dataset);
  const plan = ReplayPlanSchema.parse({
    createdAt: "2026-09-05T00:00:05.000Z",
    createdByPrincipalId: "usr_test",
    definitionSha256: digestReplayPlanDefinition(replayDefinition),
    ...replayDefinition,
  });
  await definitions.publishReplayPlan(plan);
  let now = "2026-09-05T00:00:06.000Z";
  const replay = new MemoryReplayJobRepository({ definitions, now: () => now });
  const planReference = {
    definitionSha256: plan.definitionSha256,
    planId: plan.planId,
    planVersionId: plan.planVersionId,
  };
  await replay.createJob({
    createdByPrincipalId: "usr_test",
    jobId: "job_comparison",
    plan: planReference,
    scope,
  });
  now = "2026-09-05T00:00:07.000Z";
  const claim = await replay.claimJob({
    attemptId: "attempt_comparison",
    jobId: "job_comparison",
    leaseDurationMilliseconds: 2_000,
    leaseId: "lease_comparison",
    scope,
    workerBuildSha256: sha("a"),
    workerId: "worker_comparison",
    workerProtocol: plan.workerProtocol,
  });
  if (!claim.claimed) throw new Error("Expected replay claim");
  now = "2026-09-05T00:00:07.500Z";
  await replay.appendUsageObservation({
    measurements: [
      {
        dimension: "elapsedMilliseconds",
        usage: { amount: 25, source: "measured", status: "observed" },
      },
    ],
    observationId: "usage_comparison",
    scope,
    sourceEventSha256: sha("b"),
    workerFence: claim.workerFence,
  });
  const result = {
    artifactId: "art_replay_result",
    classification: "internal" as const,
    mediaType: "application/json",
    sha256: sha("c"),
    sizeBytes: 128,
  };
  now = "2026-09-05T00:00:08.000Z";
  const terminal = await replay.completeJob({
    code: "completed",
    result,
    scope,
    status: "succeeded",
    workerFence: claim.workerFence,
  });
  const attempt = terminal.attempts[0];
  if (!attempt?.endedAt) throw new Error("Expected completed replay attempt");
  const subject = {
    dataset: {
      datasetId: dataset.datasetId,
      datasetVersionId: dataset.datasetVersionId,
      definitionSha256: dataset.definitionSha256,
    },
    fixtures: [
      {
        assessments: [],
        fixture: {
          definitionSha256: fixture.definitionSha256,
          fixtureId: fixture.fixtureId,
          fixtureVersionId: fixture.fixtureVersionId,
        },
        modelAssuranceAssessments: [],
        replay: {
          attemptId: attempt.attemptId,
          completedAt: attempt.endedAt,
          jobId: terminal.job.jobId,
          plan: planReference,
          result,
          targetRelease: plan.targetRelease,
          terminalCode: "completed" as const,
          terminalStatus: "succeeded" as const,
        },
      },
    ],
  };
  const comparison = { baseline: subject, candidate: subject } as unknown as ComparisonDefinition;
  return {
    comparison,
    evidence,
    regression,
    replay,
    resolver: new RepositoryComparisonEvidenceResolver({
      evidenceRepository: evidence,
      interactionRepository: regression,
      replayRepository: replay,
    }),
  };
}

describe("RepositoryComparisonEvidenceResolver", () => {
  it("projects exact retained trace, replay, usage, artifact, and safety evidence", async () => {
    const test = await graph();
    const resolution = await test.resolver.resolve({
      comparison: test.comparison,
      role: "baseline",
      scope,
    });

    expect(resolution.integrity).toBe("verified");
    expect(resolution.fixtures[0]?.trace).toMatchObject({ eventCount: 2 });
    expect(resolution.fixtures[0]?.safetyEvents).toHaveLength(1);
    expect(
      resolution.fixtures[0]?.usage.find(({ dimension }) => dimension === "jobAttempts"),
    ).toMatchObject({ value: { amount: 1, status: "available" } });
    expect(
      resolution.fixtures[0]?.usage.find(({ dimension }) => dimension === "elapsedMilliseconds"),
    ).toMatchObject({ value: { amount: 25, status: "available" } });
    expect(resolution.fixtures[0]?.artifacts).toEqual([
      {
        artifact: test.comparison.baseline.fixtures[0]?.replay.result,
        availability: "unavailable",
      },
    ]);
    expect(resolution.omissions).toEqual([
      {
        artifactId: "art_replay_result",
        fixtureId: "fixture_comparison",
        reason: "artifact_unavailable",
        sourceKind: "artifact",
      },
      {
        fixtureId: "fixture_comparison",
        projectionKey: "classified_content",
        reason: "classified_content_excluded",
        sourceKind: "classified_content",
      },
    ]);
    expect(resolution.sourceCutoff).toBe("2026-09-05T00:00:08.000Z");
  });

  it("fails closed when an exact trace event is unavailable", async () => {
    const test = await graph();
    const missing = structuredClone(test.comparison);
    const hiddenEvidence = {
      append: test.evidence.append.bind(test.evidence),
      listByTrace: test.evidence.listByTrace.bind(test.evidence),
      resolveExactEvents: async () => null,
    };
    const resolver = new RepositoryComparisonEvidenceResolver({
      evidenceRepository: hiddenEvidence,
      interactionRepository: test.regression,
      replayRepository: test.replay,
    });
    await expect(
      resolver.resolve({ comparison: missing, role: "baseline", scope }),
    ).rejects.toBeInstanceOf(ComparisonSourceUnavailableError);
  });

  it("rejects a comparison that cherry-picks only part of the exact dataset", async () => {
    const test = await graph();
    const changed = structuredClone(test.comparison);
    changed.baseline.fixtures = [];
    await expect(
      test.resolver.resolve({ comparison: changed, role: "baseline", scope }),
    ).rejects.toMatchObject({ sourceKind: "regression_dataset_membership" });
  });
});
