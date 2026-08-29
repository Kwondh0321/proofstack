import type {
  ReplayBoundaryDeclaration,
  ReplayPlanDefinition,
  TargetReleaseDefinition,
} from "@proofstack/contracts";
import { describe, expect, it } from "vitest";
import {
  digestReplayPlanDefinition,
  digestTargetReleaseDefinition,
  encodeReplayPlanDefinition,
  encodeTargetReleaseDefinition,
  REPLAY_PLAN_DEFINITION_DOMAIN,
  TARGET_RELEASE_DEFINITION_DOMAIN,
} from "./replay-definition-digest.js";

const sha = (digit: string): string => digit.repeat(64);

const scope = {
  environmentId: "env_vector",
  projectId: "prj_vector",
  tenantId: "ten_vector",
};

function artifact(artifactId: string, digit: string, redactedAt?: "ingest") {
  return {
    artifactId,
    classification: "internal" as const,
    mediaType: "application/octet-stream",
    redactedAt,
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

function targetReleaseDefinition(): TargetReleaseDefinition {
  return {
    build: {
      builderId: "proofstack.reference_builder",
      dependencySnapshotSha256: sha("1"),
      executableSha256: sha("2"),
      invocationSha256: sha("3"),
      provenance: artifact("art_provenance", "4", "ingest"),
    },
    environmentVariableNames: ["MODEL_ENDPOINT", "OUTPUT_PATH"],
    execution: {
      artifact: artifact("art_executable", "5"),
      bundleFormat: "tar_gzip",
      kind: "artifact",
    },
    mounts: [
      {
        access: "read_only",
        mountId: "mount_inputs",
        targetPath: "/proofstack/inputs",
      },
      {
        access: "read_write",
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
      architecture: "arm64",
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
    subprocessPolicy: {
      allowedImplementations: [
        { executableSha256: sha("7"), implementationId: "impl_helper_a" },
        { executableSha256: sha("8"), implementationId: "impl_helper_b" },
      ],
      mode: "allowlisted",
    },
    supportedBoundaryKinds: ["data", "model", "retrieval", "tool"],
    supportedBoundaryModes: ["live_provider", "recorded_stub", "simulation"],
    targetAdapter,
    targetId: "target_vector",
    targetReleaseId: "trg_vector_001",
    workerProtocol,
  };
}

const targetReference = {
  definitionSha256: sha("9"),
  targetAdapter,
  targetId: "target_vector",
  targetReleaseId: "trg_vector_001",
  workerProtocol,
};

const recordedInvocation = {
  fixture: {
    definitionSha256: sha("a"),
    fixtureId: "fix_vector",
    fixtureVersionId: "fiv_vector_001",
  },
  invocationId: "rpi_vector_001",
  runtime: {
    boundaryMode: "recorded_stub" as const,
    clock: { instant: "2026-08-29T00:00:00.000Z", mode: "fixed" as const },
    isolation: { mode: "cooperative_in_process" as const },
    locale: "en-US",
    network: { policy: "deny_fallback" as const },
    random: {
      algorithm: "hmac_sha256_counter_v1" as const,
      mode: "seeded" as const,
      seedHex: sha("b"),
    },
    timeZone: "UTC",
  },
  schemaVersion: "0.1" as const,
  targetAdapter: { name: targetAdapter.name, version: targetAdapter.version },
};

function liveBoundary(
  boundaryId: string,
  sideEffect:
    | { readonly kind: "read_only" }
    | {
        readonly idempotencyKeyScheme: string;
        readonly kind: "idempotent_write";
        readonly sandboxDestination: true;
      }
    | {
        readonly automaticRetry: false;
        readonly kind: "non_idempotent_write";
        readonly riskAcceptance: ReturnType<typeof artifact>;
      },
): ReplayBoundaryDeclaration {
  return {
    boundaryId,
    credential: {
      credentialId: "cred_vector",
      credentialVersionId: "crv_vector_001",
    },
    destination: { hostname: "api.example.com", port: 443, scheme: "https" },
    endpointProfile: {
      definitionSha256: sha("c"),
      endpointProfileId: "end_vector",
      endpointProfileVersion: "1.0.0",
    },
    kind: "tool",
    mode: "live_provider",
    operation: "execute",
    requestLimits: { requestBytes: 4_096, responseBytes: 65_536 },
    sideEffect,
    usageSource: "provider_reported",
  };
}

function replayPlanDefinition(): ReplayPlanDefinition {
  return {
    boundaries: [
      liveBoundary("bnd_live_idempotent", {
        idempotencyKeyScheme: "header.idempotency-key",
        kind: "idempotent_write",
        sandboxDestination: true,
      }),
      liveBoundary("bnd_live_non_idempotent", {
        automaticRetry: false,
        kind: "non_idempotent_write",
        riskAcceptance: artifact("art_risk_acceptance", "d"),
      }),
      liveBoundary("bnd_live_read", { kind: "read_only" }),
      {
        boundaryId: "bnd_recorded",
        invocation: recordedInvocation,
        invocationDefinitionSha256: sha("e"),
        kind: "model",
        mode: "recorded_stub",
      },
      {
        boundaryId: "bnd_simulation",
        configurationSha256: sha("f"),
        kind: "retrieval",
        mode: "simulation",
        qualification: artifact("art_qualification", "0"),
        seedHex: sha("1"),
        simulatorRelease: {
          ...targetReference,
          definitionSha256: sha("2"),
          targetId: "target_simulator",
          targetReleaseId: "trg_simulator_001",
        },
      },
    ],
    budget: {
      concurrentInteractions: { limit: 2, measurement: "measured" },
      elapsedMilliseconds: { limit: 10_000, measurement: "measured" },
      emittedArtifactBytes: { limit: 1_000_000, measurement: "measured" },
      inputTokens: { limit: 4_096, measurement: "provider_reported" },
      jobAttempts: { limit: 1, measurement: "measured" },
      modelRequests: { limit: 4, measurement: "measured" },
      outputTokens: { limit: 4_096, measurement: "provider_reported" },
      providerCostMicrounits: { limit: 1_000_000, measurement: "estimated" },
      retrievedBytes: { limit: 1_000_000, measurement: "measured" },
      toolCalls: { limit: 4, measurement: "measured" },
    },
    dataset: {
      datasetId: "dat_vector",
      datasetVersionId: "dsv_vector_001",
      definitionSha256: sha("3"),
    },
    isolationProfile: {
      definitionSha256: sha("4"),
      id: "iso_local_child",
      kind: "local_child_process",
      version: "1.0.0",
    },
    planId: "plan_vector",
    planVersionId: "plv_vector_001",
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
      definitionSha256: sha("5"),
      family: "node",
      id: "run_node_24",
      version: "1.0.0",
    },
    schemaVersion: "0.1",
    scope,
    targetRelease: targetReference,
    workerProtocol,
  };
}

describe("replay definition binary encodings", () => {
  it("uses stable domain separation and exact parsed definitions", () => {
    expect(TARGET_RELEASE_DEFINITION_DOMAIN).toBe("proofstack.target-release.v1");
    expect(REPLAY_PLAN_DEFINITION_DOMAIN).toBe("proofstack.replay-plan.v1");
    expect(encodeTargetReleaseDefinition(targetReleaseDefinition()).byteLength).toBeGreaterThan(0);
    expect(encodeReplayPlanDefinition(replayPlanDefinition()).byteLength).toBeGreaterThan(0);
    expect(digestTargetReleaseDefinition(targetReleaseDefinition())).toMatch(/^[0-9a-f]{64}$/);
    expect(digestReplayPlanDefinition(replayPlanDefinition())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("encodes both target execution and subprocess policy variants", () => {
    const original = targetReleaseDefinition();
    const alternative: TargetReleaseDefinition = {
      ...original,
      execution: {
        implementationId: "impl_vector",
        implementationSha256: sha("a"),
        kind: "preinstalled",
      },
      subprocessPolicy: { mode: "denied" },
    };
    expect(digestTargetReleaseDefinition(alternative)).not.toBe(
      digestTargetReleaseDefinition(original),
    );
  });

  it("encodes none, fixed, and exponential retry backoff variants", () => {
    const original = replayPlanDefinition();
    const readBoundary = liveBoundary("bnd_live_read", { kind: "read_only" });
    const fixed: ReplayPlanDefinition = {
      ...original,
      boundaries: [readBoundary],
      budget: { ...original.budget, jobAttempts: { limit: 3, measurement: "measured" } },
      retryPolicy: {
        ...original.retryPolicy,
        automatic: true,
        backoff: { delayMilliseconds: 100, kind: "fixed" },
        idempotencyRequirement: "read_only",
        maxAttempts: 3,
        retryableErrors: ["boundary_rate_limited"],
      },
    };
    const exponential: ReplayPlanDefinition = {
      ...fixed,
      retryPolicy: {
        ...fixed.retryPolicy,
        backoff: {
          initialDelayMilliseconds: 100,
          kind: "exponential",
          maximumDelayMilliseconds: 1_000,
          multiplier: 2,
        },
      },
    };
    const digests = [original, fixed, exponential].map(digestReplayPlanDefinition);
    expect(new Set(digests).size).toBe(3);
  });

  it("rejects non-contract input before producing definition bytes", () => {
    expect(() =>
      encodeTargetReleaseDefinition({ ...targetReleaseDefinition(), latest: true } as never),
    ).toThrow();
    expect(() =>
      encodeReplayPlanDefinition({ ...replayPlanDefinition(), fallback: "live" } as never),
    ).toThrow();
  });
});

describe("target release digest sensitivity", () => {
  it("changes across every semantic target-release group", () => {
    const original = targetReleaseDefinition();
    const firstMount = original.mounts[0];
    const secondMount = original.mounts[1];
    if (
      original.execution.kind !== "artifact" ||
      original.subprocessPolicy.mode !== "allowlisted" ||
      !firstMount ||
      !secondMount
    ) {
      throw new Error("Expected the rich target-release fixture");
    }
    const secondSubprocess = original.subprocessPolicy.allowedImplementations[1];
    if (!secondSubprocess) throw new Error("Expected the second subprocess fixture");
    const mutations: readonly TargetReleaseDefinition[] = [
      { ...original, scope: { ...original.scope, tenantId: "ten_changed" } },
      { ...original, targetId: "target_changed" },
      { ...original, targetReleaseId: "trg_vector_002" },
      {
        ...original,
        targetAdapter: { ...original.targetAdapter, protocolVersion: "2.0.0" },
      },
      {
        ...original,
        source: { ...original.source, revision: "a".repeat(40) },
      },
      {
        ...original,
        build: { ...original.build, dependencySnapshotSha256: sha("b") },
      },
      {
        ...original,
        build: {
          ...original.build,
          provenance: { ...original.build.provenance, artifactId: "art_changed" },
        },
      },
      {
        ...original,
        execution: { ...original.execution, bundleFormat: "zip" },
      },
      { ...original, runtime: { ...original.runtime, version: "24.8.0" } },
      { ...original, environmentVariableNames: ["MODEL_ENDPOINT", "RESULT_PATH"] },
      {
        ...original,
        mounts: [{ ...firstMount, targetPath: "/proofstack/inputs/model" }, secondMount],
      },
      {
        ...original,
        subprocessPolicy: {
          allowedImplementations: [
            { executableSha256: sha("9"), implementationId: "impl_helper_a" },
            secondSubprocess,
          ],
          mode: "allowlisted",
        },
      },
      {
        ...original,
        outputLimits: { ...original.outputLimits, stdoutBytes: 65_537 },
      },
      { ...original, supportedBoundaryKinds: ["model", "retrieval", "tool"] },
      { ...original, supportedBoundaryModes: ["recorded_stub", "simulation"] },
      { ...original, workerProtocol: { ...original.workerProtocol, version: "1.0.1" } },
    ];
    const originalDigest = digestTargetReleaseDefinition(original);
    expect(new Set(mutations.map(digestTargetReleaseDefinition)).size).toBe(mutations.length);
    for (const mutation of mutations) {
      expect(digestTargetReleaseDefinition(mutation)).not.toBe(originalDigest);
    }
  });
});

describe("replay plan digest sensitivity", () => {
  it("changes across lineage, profiles, budgets, retries, boundaries, and protocol", () => {
    const original = replayPlanDefinition();
    const firstBoundary = original.boundaries[0];
    if (firstBoundary?.mode !== "live_provider") {
      throw new Error("Expected the live public boundary fixture");
    }
    const mutations: readonly ReplayPlanDefinition[] = [
      { ...original, scope: { ...original.scope, environmentId: "env_changed" } },
      { ...original, planId: "plan_changed" },
      { ...original, planVersionId: "plv_vector_002" },
      {
        ...original,
        targetRelease: { ...original.targetRelease, definitionSha256: sha("6") },
      },
      { ...original, dataset: { ...original.dataset, definitionSha256: sha("7") } },
      {
        ...original,
        runtimeProfile: { ...original.runtimeProfile, definitionSha256: sha("8") },
      },
      {
        ...original,
        isolationProfile: { ...original.isolationProfile, definitionSha256: sha("9") },
      },
      {
        ...original,
        budget: {
          ...original.budget,
          inputTokens: { ...original.budget.inputTokens, limit: 4_097 },
        },
      },
      {
        ...original,
        retryPolicy: {
          ...original.retryPolicy,
          perAttemptTimeoutMilliseconds: 2_001,
        },
      },
      {
        ...original,
        boundaries: [
          {
            ...firstBoundary,
            endpointProfile: { ...firstBoundary.endpointProfile, definitionSha256: sha("a") },
          },
          ...original.boundaries.slice(1),
        ],
      },
      {
        ...original,
        targetRelease: {
          ...original.targetRelease,
          workerProtocol: { ...original.targetRelease.workerProtocol, version: "1.0.1" },
        },
        workerProtocol: { ...original.workerProtocol, version: "1.0.1" },
      },
    ];
    const originalDigest = digestReplayPlanDefinition(original);
    expect(new Set(mutations.map(digestReplayPlanDefinition)).size).toBe(mutations.length);
    for (const mutation of mutations) {
      expect(digestReplayPlanDefinition(mutation)).not.toBe(originalDigest);
    }
  });
});
