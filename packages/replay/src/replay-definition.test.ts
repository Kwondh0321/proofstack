import {
  type ReplayPlan,
  type ReplayPlanDefinition,
  ReplayPlanSchema,
  type TargetRelease,
  type TargetReleaseDefinition,
  TargetReleaseSchema,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  InvalidReplayDefinitionInputError,
  ReplayDefinitionConflictError,
  ReplayDefinitionLineageError,
  ReplayRepositoryContractError,
} from "./errors.js";
import {
  areReplayPlanDefinitionsEqual,
  areTargetReleaseDefinitionsEqual,
  validateAndProjectReplayPlan,
  validateAndProjectTargetRelease,
} from "./replay-definition.js";
import {
  digestReplayPlanDefinition,
  digestTargetReleaseDefinition,
} from "./replay-definition-digest.js";
import {
  buildReplayPlanPublishedOutboxIntent,
  buildTargetReleasePublishedOutboxIntent,
} from "./replay-definition-publication-outbox.js";
import { digestRecordedBoundaryReplayInvocationDefinition } from "./replay-digest.js";

const sha = (digit: string): string => digit.repeat(64);
const scope = {
  environmentId: "env_definition",
  projectId: "prj_definition",
  tenantId: "ten_definition",
};
const targetAdapter = {
  name: "proofstack.reference_target",
  protocolVersion: "1.0.0",
  version: "1.0.0",
};
const workerProtocol = { name: "proofstack.replay-worker", version: "1.0.0" };

function targetDefinition(
  overrides: Partial<TargetReleaseDefinition> = {},
): TargetReleaseDefinition {
  return {
    build: {
      builderId: "proofstack.reference_builder",
      dependencySnapshotSha256: sha("1"),
      executableSha256: sha("2"),
      invocationSha256: sha("3"),
      provenance: {
        artifactId: "art_definition_provenance",
        classification: "internal",
        mediaType: "application/json",
        sha256: sha("4"),
        sizeBytes: 128,
      },
    },
    environmentVariableNames: [],
    execution: {
      implementationId: "impl_definition_target",
      implementationSha256: sha("5"),
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
      revision: "6".repeat(40),
    },
    subprocessPolicy: { mode: "denied" },
    supportedBoundaryKinds: ["model"],
    supportedBoundaryModes: ["recorded_stub"],
    targetAdapter,
    targetId: "target_definition",
    targetReleaseId: "trg_definition_001",
    workerProtocol,
    ...overrides,
  };
}

function targetRelease(overrides: Partial<TargetReleaseDefinition> = {}): TargetRelease {
  const definition = targetDefinition(overrides);
  return TargetReleaseSchema.parse({
    createdAt: "2026-08-29T10:00:00.000Z",
    createdByPrincipalId: "usr_definition",
    definitionSha256: digestTargetReleaseDefinition(definition),
    ...definition,
  });
}

function planDefinition(
  release = targetRelease(),
  overrides: Partial<ReplayPlanDefinition> = {},
): ReplayPlanDefinition {
  const invocation = {
    fixture: {
      definitionSha256: sha("7"),
      fixtureId: "fix_definition",
      fixtureVersionId: "fiv_definition_001",
    },
    invocationId: "rpi_definition_001",
    runtime: {
      boundaryMode: "recorded_stub" as const,
      clock: { instant: "2026-08-29T00:00:00.000Z", mode: "fixed" as const },
      isolation: { mode: "cooperative_in_process" as const },
      locale: "en-US",
      network: { policy: "deny_fallback" as const },
      random: {
        algorithm: "hmac_sha256_counter_v1" as const,
        mode: "seeded" as const,
        seedHex: sha("8"),
      },
      timeZone: "UTC",
    },
    schemaVersion: "0.1" as const,
    targetAdapter: {
      name: release.targetAdapter.name,
      version: release.targetAdapter.version,
    },
  };
  return {
    boundaries: [
      {
        boundaryId: "bnd_definition_model",
        invocation,
        invocationDefinitionSha256: digestRecordedBoundaryReplayInvocationDefinition(invocation),
        kind: "model",
        mode: "recorded_stub",
      },
    ],
    budget: {
      concurrentInteractions: { limit: 1, measurement: "measured" },
      elapsedMilliseconds: { limit: 10_000, measurement: "measured" },
      emittedArtifactBytes: { limit: 1_048_576, measurement: "measured" },
      inputTokens: { limit: 4_096, measurement: "provider_reported" },
      jobAttempts: { limit: 1, measurement: "measured" },
      modelRequests: { limit: 4, measurement: "measured" },
      outputTokens: { limit: 4_096, measurement: "provider_reported" },
      providerCostMicrounits: { limit: 1_000_000, measurement: "unavailable" },
      retrievedBytes: { limit: 1_048_576, measurement: "measured" },
      toolCalls: { limit: 1, measurement: "measured" },
    },
    dataset: {
      datasetId: "dat_definition",
      datasetVersionId: "dsv_definition_001",
      definitionSha256: sha("9"),
    },
    isolationProfile: {
      definitionSha256: sha("a"),
      id: "iso_local_child",
      kind: "local_child_process",
      version: "1.0.0",
    },
    planId: "plan_definition",
    planVersionId: "plv_definition_001",
    retryPolicy: {
      automatic: false,
      backoff: { kind: "none" },
      idempotencyRequirement: "no_external_effect",
      maxAttempts: 1,
      perAttemptTimeoutMilliseconds: 2_000,
      retryableErrors: [],
      totalDeadlineMilliseconds: 5_000,
    },
    runtimeProfile: {
      definitionSha256: sha("b"),
      family: "node",
      id: "run_node_24",
      version: "1.0.0",
    },
    schemaVersion: "0.1",
    scope: release.scope,
    targetRelease: {
      definitionSha256: release.definitionSha256,
      targetAdapter: release.targetAdapter,
      targetId: release.targetId,
      targetReleaseId: release.targetReleaseId,
      workerProtocol: release.workerProtocol,
    },
    workerProtocol: release.workerProtocol,
    ...overrides,
  };
}

function replayPlan(
  release = targetRelease(),
  overrides: Partial<ReplayPlanDefinition> = {},
): ReplayPlan {
  const definition = planDefinition(release, overrides);
  return ReplayPlanSchema.parse({
    createdAt: "2026-08-29T10:01:00.000Z",
    createdByPrincipalId: "usr_definition",
    definitionSha256: digestReplayPlanDefinition(definition),
    ...definition,
  });
}

describe("replay definition validation", () => {
  it("exposes stable repository failure classes", () => {
    expect(new ReplayDefinitionConflictError()).toMatchObject({
      code: "replay_definition_conflict",
      name: "ReplayDefinitionConflictError",
    });
    expect(new ReplayDefinitionLineageError()).toMatchObject({
      code: "replay_definition_lineage_invalid",
      name: "ReplayDefinitionLineageError",
    });
    expect(new ReplayRepositoryContractError("invalid adapter result")).toMatchObject({
      code: "replay_repository_contract_violation",
      name: "ReplayRepositoryContractError",
    });
  });

  it("projects exact target and plan semantics after verifying their digests", () => {
    const release = targetRelease();
    const plan = replayPlan(release);
    expect(validateAndProjectTargetRelease(release)).toEqual({
      definition: targetDefinition(),
      release,
    });
    expect(validateAndProjectReplayPlan(plan)).toEqual({
      definition: planDefinition(release),
      plan,
    });
  });

  it("rejects malformed definitions and mismatched semantic digests", () => {
    const release = targetRelease();
    const plan = replayPlan(release);
    for (const invalid of [
      { ...release, mutableAlias: "latest" },
      { ...release, definitionSha256: sha("f") },
      { ...plan, synchronousExecution: true },
      { ...plan, definitionSha256: sha("f") },
    ]) {
      const validate =
        "planId" in invalid ? validateAndProjectReplayPlan : validateAndProjectTargetRelease;
      expect(() => validate(invalid)).toThrow(InvalidReplayDefinitionInputError);
    }
  });

  it("compares canonical bytes instead of mutable publication provenance", () => {
    const target = targetDefinition();
    expect(areTargetReleaseDefinitionsEqual(target, { ...target })).toBe(true);
    expect(
      areTargetReleaseDefinitionsEqual(target, { ...target, targetId: "target_other_same" }),
    ).toBe(false);
    expect(areTargetReleaseDefinitionsEqual(target, { ...target, targetId: "short" })).toBe(false);

    const plan = planDefinition();
    expect(areReplayPlanDefinitionsEqual(plan, { ...plan })).toBe(true);
    expect(areReplayPlanDefinitionsEqual(plan, { ...plan, planId: "plan_other_same" })).toBe(false);
    expect(areReplayPlanDefinitionsEqual(plan, { ...plan, planId: "short" })).toBe(false);
  });
});

describe("replay definition publication intents", () => {
  it("contains only exact target-release read coordinates", () => {
    const release = targetRelease();
    expect(buildTargetReleasePublishedOutboxIntent(release)).toEqual({
      aggregateId: release.targetReleaseId,
      aggregateType: "replay.target-release",
      createdAt: release.createdAt,
      eventType: "replay.target-release.published",
      payload: {
        definitionSha256: release.definitionSha256,
        environmentId: scope.environmentId,
        projectId: scope.projectId,
        targetId: release.targetId,
        targetReleaseId: release.targetReleaseId,
      },
      schemaVersion: "0.1",
      tenantId: scope.tenantId,
    });
  });

  it("contains only exact replay-plan read coordinates", () => {
    const release = targetRelease();
    const plan = replayPlan(release);
    expect(buildReplayPlanPublishedOutboxIntent(plan)).toEqual({
      aggregateId: plan.planVersionId,
      aggregateType: "replay.plan",
      createdAt: plan.createdAt,
      eventType: "replay.plan.published",
      payload: {
        definitionSha256: plan.definitionSha256,
        environmentId: scope.environmentId,
        planId: plan.planId,
        planVersionId: plan.planVersionId,
        projectId: scope.projectId,
        targetReleaseId: release.targetReleaseId,
      },
      schemaVersion: "0.1",
      tenantId: scope.tenantId,
    });
  });
});
