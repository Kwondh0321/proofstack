import { describe, expect, it } from "vitest";
import { RECORDED_BOUNDARY_REPLAY_SCHEMA_VERSION } from "./replay.js";
import {
  MAX_REPLAY_BUDGET_VALUE,
  REPLAY_PLAN_SCHEMA_VERSION,
  ReplayBoundaryDeclarationSchema,
  ReplayBudgetSchema,
  ReplayPlanDefinitionSchema,
  ReplayPlanSchema,
  ReplayRetryPolicySchema,
  TARGET_RELEASE_SCHEMA_VERSION,
  TargetReleaseDefinitionSchema,
  TargetReleaseSchema,
} from "./replay-plan.js";

const sha = (digit: string): string => digit.repeat(64);

const scope = {
  environmentId: "env_reference",
  projectId: "prj_reference",
  tenantId: "ten_reference",
};

function artifact(artifactId: string, digit: string) {
  return {
    artifactId,
    classification: "internal" as const,
    mediaType: "application/octet-stream",
    sha256: sha(digit),
    sizeBytes: 128,
  };
}

const workerProtocol = { name: "proofstack.replay-worker", version: "1.0.0" };
const targetAdapter = {
  name: "proofstack.reference_target",
  protocolVersion: "1.0.0",
  version: "1.2.0",
};

function targetReleaseDefinition() {
  return {
    build: {
      builderId: "proofstack.reference_builder",
      dependencySnapshotSha256: sha("b"),
      executableSha256: sha("c"),
      invocationSha256: sha("d"),
      provenance: artifact("art_provenance", "e"),
    },
    environmentVariableNames: ["MODEL_ENDPOINT", "OUTPUT_PATH"],
    execution: {
      implementationId: "impl_reference",
      implementationSha256: sha("f"),
      kind: "preinstalled" as const,
    },
    mounts: [
      {
        access: "read_only" as const,
        mountId: "mount_inputs",
        targetPath: "/proofstack/inputs",
      },
      {
        access: "read_write" as const,
        mountId: "mount_outputs",
        targetPath: "/proofstack/outputs",
      },
    ],
    outputLimits: {
      emittedArtifactBytes: 1_000_000,
      stderrBytes: 65_536,
      stdoutBytes: 65_536,
    },
    runtime: {
      architecture: "arm64" as const,
      entryPoint: "dist/target.js",
      family: "node",
      platform: "linux" as const,
      version: "24.7.0",
    },
    schemaVersion: TARGET_RELEASE_SCHEMA_VERSION,
    scope,
    source: {
      repositoryUrl: "https://github.com/Kwondh0321/proofstack",
      revision: "1".repeat(40),
    },
    subprocessPolicy: { mode: "denied" as const },
    supportedBoundaryKinds: ["model", "tool"] as const,
    supportedBoundaryModes: ["recorded_stub", "simulation"] as const,
    targetAdapter,
    targetId: "target_reference",
    targetReleaseId: "trg_reference_001",
    workerProtocol,
  };
}

const recordedInvocation = {
  fixture: {
    definitionSha256: sha("2"),
    fixtureId: "fix_reference",
    fixtureVersionId: "fiv_reference_001",
  },
  invocationId: "rpi_reference_001",
  runtime: {
    boundaryMode: "recorded_stub" as const,
    clock: { instant: "2026-08-29T00:00:00.000Z", mode: "fixed" as const },
    isolation: { mode: "cooperative_in_process" as const },
    locale: "en-US",
    network: { policy: "deny_fallback" as const },
    random: {
      algorithm: "hmac_sha256_counter_v1" as const,
      mode: "seeded" as const,
      seedHex: sha("3"),
    },
    timeZone: "UTC",
  },
  schemaVersion: RECORDED_BOUNDARY_REPLAY_SCHEMA_VERSION,
  targetAdapter: {
    name: targetAdapter.name,
    version: targetAdapter.version,
  },
};

const budgetDimension = (limit: number) => ({ limit, measurement: "measured" as const });

function replayPlanDefinition() {
  return {
    boundaries: [
      {
        boundaryId: "bnd_model",
        invocation: recordedInvocation,
        invocationDefinitionSha256: sha("4"),
        kind: "model" as const,
        mode: "recorded_stub" as const,
      },
    ],
    budget: {
      concurrentInteractions: budgetDimension(2),
      elapsedMilliseconds: budgetDimension(10_000),
      emittedArtifactBytes: budgetDimension(1_000_000),
      inputTokens: budgetDimension(4_096),
      jobAttempts: budgetDimension(1),
      modelRequests: budgetDimension(4),
      outputTokens: budgetDimension(4_096),
      providerCostMicrounits: budgetDimension(1_000_000),
      retrievedBytes: budgetDimension(1_000_000),
      toolCalls: budgetDimension(4),
    },
    dataset: {
      datasetId: "dat_reference",
      datasetVersionId: "dsv_reference_001",
      definitionSha256: sha("5"),
    },
    isolationProfile: {
      definitionSha256: sha("6"),
      id: "iso_local_child",
      kind: "local_child_process" as const,
      version: "1.0.0",
    },
    planId: "plan_reference",
    planVersionId: "plv_reference_001",
    retryPolicy: {
      automatic: false,
      backoff: { kind: "none" as const },
      idempotencyRequirement: "no_external_effect" as const,
      maxAttempts: 1,
      perAttemptTimeoutMilliseconds: 2_000,
      retryableErrors: [],
      totalDeadlineMilliseconds: 5_000,
    },
    runtimeProfile: {
      definitionSha256: sha("7"),
      family: "node",
      id: "run_node_24",
      version: "1.0.0",
    },
    schemaVersion: REPLAY_PLAN_SCHEMA_VERSION,
    scope,
    targetRelease: {
      definitionSha256: sha("8"),
      targetAdapter,
      targetId: "target_reference",
      targetReleaseId: "trg_reference_001",
      workerProtocol,
    },
    workerProtocol,
  };
}

function stored<T extends Record<string, unknown>>(definition: T, digit: string) {
  return {
    ...definition,
    createdAt: "2026-08-29T00:00:00.000Z",
    createdByPrincipalId: "usr_publisher",
    definitionSha256: sha(digit),
  };
}

describe("target release contracts", () => {
  it("accepts exact immutable definitions and stored provenance", () => {
    const definition = targetReleaseDefinition();
    expect(TargetReleaseDefinitionSchema.parse(definition)).toEqual(definition);
    expect(TargetReleaseSchema.parse(stored(definition, "9"))).toEqual(stored(definition, "9"));
  });

  it("accepts artifact execution and exact allowlisted subprocesses", () => {
    const definition = targetReleaseDefinition();
    const candidate = {
      ...definition,
      execution: {
        artifact: artifact("art_executable", "a"),
        bundleFormat: "tar_gzip" as const,
        kind: "artifact" as const,
      },
      subprocessPolicy: {
        allowedImplementations: [
          { executableSha256: sha("b"), implementationId: "impl_helper_a" },
          { executableSha256: sha("c"), implementationId: "impl_helper_b" },
        ],
        mode: "allowlisted" as const,
      },
    };
    expect(TargetReleaseDefinitionSchema.safeParse(candidate).success).toBe(true);
  });

  it.each([
    [
      "mutable field",
      (value: ReturnType<typeof targetReleaseDefinition>) => ({ ...value, latest: true }),
    ],
    [
      "non-HTTPS source",
      (value: ReturnType<typeof targetReleaseDefinition>) => ({
        ...value,
        source: { ...value.source, repositoryUrl: "http://example.com/source" },
      }),
    ],
    [
      "symbolic revision",
      (value: ReturnType<typeof targetReleaseDefinition>) => ({
        ...value,
        source: { ...value.source, revision: "main" },
      }),
    ],
    [
      "absolute entry point",
      (value: ReturnType<typeof targetReleaseDefinition>) => ({
        ...value,
        runtime: { ...value.runtime, entryPoint: "/bin/sh" },
      }),
    ],
    [
      "parent traversal",
      (value: ReturnType<typeof targetReleaseDefinition>) => ({
        ...value,
        runtime: { ...value.runtime, entryPoint: "../target.js" },
      }),
    ],
    [
      "ambient mount path",
      (value: ReturnType<typeof targetReleaseDefinition>) => ({
        ...value,
        mounts: [{ ...value.mounts[0], targetPath: "/Users/operator/secrets" }],
      }),
    ],
    [
      "writable input mount",
      (value: ReturnType<typeof targetReleaseDefinition>) => ({
        ...value,
        mounts: [{ ...value.mounts[0], access: "read_write" }],
      }),
    ],
    [
      "unsorted environment allowlist",
      (value: ReturnType<typeof targetReleaseDefinition>) => ({
        ...value,
        environmentVariableNames: ["OUTPUT_PATH", "MODEL_ENDPOINT"],
      }),
    ],
    [
      "duplicate mount target",
      (value: ReturnType<typeof targetReleaseDefinition>) => ({
        ...value,
        mounts: [value.mounts[0], { ...value.mounts[1], targetPath: "/proofstack/inputs" }],
      }),
    ],
    [
      "unsorted modes",
      (value: ReturnType<typeof targetReleaseDefinition>) => ({
        ...value,
        supportedBoundaryModes: ["simulation", "recorded_stub"],
      }),
    ],
    [
      "duplicate subprocess implementation",
      (value: ReturnType<typeof targetReleaseDefinition>) => ({
        ...value,
        subprocessPolicy: {
          allowedImplementations: [
            { executableSha256: sha("1"), implementationId: "impl_same" },
            { executableSha256: sha("2"), implementationId: "impl_same" },
          ],
          mode: "allowlisted",
        },
      }),
    ],
  ])("rejects %s", (_name, mutate) => {
    expect(TargetReleaseDefinitionSchema.safeParse(mutate(targetReleaseDefinition())).success).toBe(
      false,
    );
  });
});

describe("replay budget and retry contracts", () => {
  it("requires every finite positive integer budget dimension", () => {
    const budget = replayPlanDefinition().budget;
    expect(ReplayBudgetSchema.safeParse(budget).success).toBe(true);
    expect(
      ReplayBudgetSchema.safeParse({ ...budget, elapsedMilliseconds: budgetDimension(0) }).success,
    ).toBe(false);
    expect(
      ReplayBudgetSchema.safeParse({
        ...budget,
        elapsedMilliseconds: budgetDimension(MAX_REPLAY_BUDGET_VALUE + 1),
      }).success,
    ).toBe(false);
    expect(ReplayBudgetSchema.safeParse({ ...budget, total: 10_000 }).success).toBe(false);
    const { toolCalls: _omitted, ...missingDimension } = budget;
    expect(ReplayBudgetSchema.safeParse(missingDimension).success).toBe(false);
  });

  it("accepts bounded fixed and exponential retry policies", () => {
    const fixed = {
      automatic: true,
      backoff: { delayMilliseconds: 100, kind: "fixed" as const },
      idempotencyRequirement: "read_only" as const,
      maxAttempts: 2,
      perAttemptTimeoutMilliseconds: 1_000,
      retryableErrors: ["boundary_rate_limited"] as const,
      totalDeadlineMilliseconds: 3_000,
    };
    expect(ReplayRetryPolicySchema.safeParse(fixed).success).toBe(true);
    expect(
      ReplayRetryPolicySchema.safeParse({
        ...fixed,
        backoff: {
          initialDelayMilliseconds: 100,
          kind: "exponential",
          maximumDelayMilliseconds: 1_000,
          multiplier: 2,
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    ["attempt timeout above deadline", { perAttemptTimeoutMilliseconds: 6_000 }],
    ["automatic single attempt", { automatic: true }],
    ["disabled retry with errors", { retryableErrors: ["target_temporary_failure"] }],
    ["disabled retry with backoff", { backoff: { delayMilliseconds: 10, kind: "fixed" } }],
  ])("rejects %s", (_name, patch) => {
    const policy = replayPlanDefinition().retryPolicy;
    expect(ReplayRetryPolicySchema.safeParse({ ...policy, ...patch }).success).toBe(false);
  });

  it("rejects an inverted exponential backoff range", () => {
    const policy = replayPlanDefinition().retryPolicy;
    expect(
      ReplayRetryPolicySchema.safeParse({
        ...policy,
        automatic: true,
        backoff: {
          initialDelayMilliseconds: 1_000,
          kind: "exponential",
          maximumDelayMilliseconds: 100,
          multiplier: 2,
        },
        maxAttempts: 2,
        retryableErrors: ["target_temporary_failure"],
      }).success,
    ).toBe(false);
  });
});

describe("replay boundary declarations", () => {
  it("accepts exact recorded, simulated, and live modes without fallback fields", () => {
    const recorded = replayPlanDefinition().boundaries[0];
    const simulated = {
      boundaryId: "bnd_simulated",
      configurationSha256: sha("a"),
      kind: "tool" as const,
      mode: "simulation" as const,
      qualification: artifact("art_qualification", "b"),
      seedHex: sha("c"),
      simulatorRelease: replayPlanDefinition().targetRelease,
    };
    const live = {
      boundaryId: "bnd_live",
      credential: {
        credentialId: "cred_reference",
        credentialVersionId: "crv_reference_001",
      },
      destination: { hostname: "api.example.com", port: 443 as const, scheme: "https" as const },
      endpointProfile: {
        definitionSha256: sha("d"),
        endpointProfileId: "end_reference",
        endpointProfileVersion: "1.0.0",
      },
      kind: "retrieval" as const,
      mode: "live_provider" as const,
      operation: "search",
      requestLimits: { requestBytes: 4_096, responseBytes: 65_536 },
      sideEffect: { kind: "read_only" as const },
      usageSource: "provider_reported" as const,
    };

    expect(ReplayBoundaryDeclarationSchema.safeParse(recorded).success).toBe(true);
    expect(
      ReplayBoundaryDeclarationSchema.safeParse({ ...recorded, kind: "retrieval" }).success,
    ).toBe(false);
    expect(ReplayBoundaryDeclarationSchema.safeParse(simulated).success).toBe(true);
    expect(ReplayBoundaryDeclarationSchema.safeParse(live).success).toBe(true);
    expect(
      ReplayBoundaryDeclarationSchema.safeParse({ ...recorded, fallbackMode: "live_provider" })
        .success,
    ).toBe(false);
  });

  it("requires exact HTTPS destinations and live effect evidence", () => {
    const live = {
      boundaryId: "bnd_live",
      credential: {
        credentialId: "cred_reference",
        credentialVersionId: "crv_reference_001",
      },
      destination: { hostname: "localhost", port: 80, scheme: "http" },
      endpointProfile: {
        definitionSha256: sha("d"),
        endpointProfileId: "end_reference",
        endpointProfileVersion: "1.0.0",
      },
      kind: "tool",
      mode: "live_provider",
      operation: "write",
      requestLimits: { requestBytes: 1, responseBytes: 1 },
      sideEffect: { kind: "non_idempotent_write" },
      usageSource: "unavailable",
    };
    expect(ReplayBoundaryDeclarationSchema.safeParse(live).success).toBe(false);
  });
});

describe("replay plan contracts", () => {
  it("accepts exact definitions and stored publication provenance", () => {
    const definition = replayPlanDefinition();
    expect(ReplayPlanDefinitionSchema.parse(definition)).toEqual(definition);
    expect(ReplayPlanSchema.parse(stored(definition, "a"))).toEqual(stored(definition, "a"));
  });

  it.each([
    [
      "worker protocol mismatch",
      (value: ReturnType<typeof replayPlanDefinition>) => ({
        ...value,
        workerProtocol: { ...value.workerProtocol, version: "2.0.0" },
      }),
    ],
    [
      "attempt count above budget",
      (value: ReturnType<typeof replayPlanDefinition>) => ({
        ...value,
        retryPolicy: { ...value.retryPolicy, maxAttempts: 2 },
      }),
    ],
    [
      "deadline above elapsed budget",
      (value: ReturnType<typeof replayPlanDefinition>) => ({
        ...value,
        retryPolicy: { ...value.retryPolicy, totalDeadlineMilliseconds: 20_000 },
      }),
    ],
    [
      "recorded target mismatch",
      (value: ReturnType<typeof replayPlanDefinition>) => {
        const boundary = value.boundaries[0];
        if (!boundary) return value;
        return {
          ...value,
          boundaries: [
            {
              ...boundary,
              invocation: {
                ...boundary.invocation,
                targetAdapter: {
                  ...boundary.invocation.targetAdapter,
                  version: "9.0.0",
                },
              },
            },
          ],
        };
      },
    ],
    [
      "unknown mutable alias",
      (value: ReturnType<typeof replayPlanDefinition>) => ({ ...value, latest: true }),
    ],
    [
      "duplicate boundary",
      (value: ReturnType<typeof replayPlanDefinition>) => ({
        ...value,
        boundaries: [value.boundaries[0], value.boundaries[0]],
      }),
    ],
  ])("rejects %s", (_name, mutate) => {
    expect(ReplayPlanDefinitionSchema.safeParse(mutate(replayPlanDefinition())).success).toBe(
      false,
    );
  });

  it("rejects retrying an idempotent live write without destination-supported idempotency", () => {
    const value = replayPlanDefinition();
    const boundary = {
      boundaryId: "bnd_write",
      credential: {
        credentialId: "cred_reference",
        credentialVersionId: "crv_reference_001",
      },
      destination: { hostname: "api.example.com", port: 443 as const, scheme: "https" as const },
      endpointProfile: {
        definitionSha256: sha("b"),
        endpointProfileId: "end_reference",
        endpointProfileVersion: "1.0.0",
      },
      kind: "tool" as const,
      mode: "live_provider" as const,
      operation: "write",
      requestLimits: { requestBytes: 1_024, responseBytes: 1_024 },
      sideEffect: {
        idempotencyKeyScheme: "header.idempotency-key",
        kind: "idempotent_write" as const,
        sandboxDestination: true as const,
      },
      usageSource: "measured" as const,
    };
    const candidate = {
      ...value,
      boundaries: [boundary],
      budget: { ...value.budget, jobAttempts: budgetDimension(2) },
      retryPolicy: {
        ...value.retryPolicy,
        automatic: true,
        backoff: { delayMilliseconds: 10, kind: "fixed" as const },
        idempotencyRequirement: "read_only" as const,
        maxAttempts: 2,
        retryableErrors: ["boundary_temporarily_unavailable"] as const,
      },
    };
    expect(ReplayPlanDefinitionSchema.safeParse(candidate).success).toBe(false);
    expect(
      ReplayPlanDefinitionSchema.safeParse({
        ...candidate,
        retryPolicy: {
          ...candidate.retryPolicy,
          idempotencyRequirement: "destination_supported",
        },
      }).success,
    ).toBe(true);
  });

  it("prohibits multi-attempt non-idempotent live writes", () => {
    const value = replayPlanDefinition();
    const boundary = {
      boundaryId: "bnd_write",
      credential: {
        credentialId: "cred_reference",
        credentialVersionId: "crv_reference_001",
      },
      destination: { hostname: "api.example.com", port: 443 as const, scheme: "https" as const },
      endpointProfile: {
        definitionSha256: sha("b"),
        endpointProfileId: "end_reference",
        endpointProfileVersion: "1.0.0",
      },
      kind: "tool" as const,
      mode: "live_provider" as const,
      operation: "write",
      requestLimits: { requestBytes: 1_024, responseBytes: 1_024 },
      sideEffect: {
        automaticRetry: false as const,
        kind: "non_idempotent_write" as const,
        riskAcceptance: artifact("art_risk_acceptance", "c"),
      },
      usageSource: "unavailable" as const,
    };
    const candidate = {
      ...value,
      boundaries: [boundary],
      budget: { ...value.budget, jobAttempts: budgetDimension(2) },
      retryPolicy: { ...value.retryPolicy, maxAttempts: 2 },
    };
    expect(ReplayPlanDefinitionSchema.safeParse(candidate).success).toBe(false);
    expect(
      ReplayPlanDefinitionSchema.safeParse({
        ...candidate,
        budget: { ...value.budget, jobAttempts: budgetDimension(1) },
        retryPolicy: { ...value.retryPolicy, maxAttempts: 1 },
      }).success,
    ).toBe(true);
  });
});
