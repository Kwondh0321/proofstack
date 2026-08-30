import { createHash } from "node:crypto";
import {
  type EvidenceScope,
  EvidenceScopeSchema,
  type RecordedInteractionFixtureVersion,
  type ReplayArtifactContentReference,
  type ReplayPlanDefinition,
  ReplayPlanDefinitionSchema,
  type TargetRelease,
  type TargetReleaseDefinition,
  TargetReleaseDefinitionSchema,
} from "@proofstack/contracts";
import {
  digestRecordedBoundaryReplayInvocationDefinition,
  digestTargetReleaseDefinition,
} from "@proofstack/replay";
import type { ResolvedPreinstalledTarget } from "@proofstack/replay-worker";
import {
  DURABLE_REPLAY_BOUNDARIES,
  DURABLE_REPLAY_HOLD_ENVIRONMENT_NAME,
  DURABLE_REPLAY_WORKER_PROTOCOL,
  PROVIDER_NEUTRAL_DURABLE_TARGET_ADAPTER,
} from "./target-source.js";

const REPOSITORY_URL = "https://github.com/Kwondh0321/proofstack" as const;
const SOURCE_REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SUFFIX_PATTERN = /^[0-9a-f]{12}$/;
const encoder = new TextEncoder();

export interface DurableReplayDatasetReference {
  readonly datasetId: string;
  readonly datasetVersionId: string;
  readonly definitionSha256: string;
}

export interface CreateDurableReplayDefinitionsInput {
  readonly captureStartedAt: Date;
  readonly dataset: DurableReplayDatasetReference;
  readonly fixture: Pick<
    RecordedInteractionFixtureVersion,
    "definitionSha256" | "fixtureId" | "fixtureVersionId"
  >;
  readonly scope: EvidenceScope;
  readonly sourceRevision: string;
  readonly suffix: string;
  readonly targetSource: string;
}

export interface DurableReplayDefinitions {
  readonly provenanceContent: Uint8Array;
  readonly provenanceReference: ReplayArtifactContentReference;
  readonly replayPlanDefinition: ReplayPlanDefinition;
  readonly targetReleaseDefinition: TargetReleaseDefinition;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function currentPlatform(): "darwin" | "linux" {
  /* v8 ignore next 3 -- The package engine only supports Node platforms represented by the public release contract. */
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new TypeError("The durable replay example requires a supported worker platform");
  }
  return process.platform;
}

function currentArchitecture(): "arm64" | "x64" {
  /* v8 ignore next 3 -- The package engine only supports Node architectures represented by the public release contract. */
  if (process.arch !== "arm64" && process.arch !== "x64") {
    throw new TypeError("The durable replay example requires a supported worker architecture");
  }
  return process.arch;
}

function requireInput(input: CreateDurableReplayDefinitionsInput): void {
  if (!SUFFIX_PATTERN.test(input.suffix)) {
    throw new TypeError(
      "Definition suffix must contain exactly 12 lowercase hexadecimal characters",
    );
  }
  if (!SOURCE_REVISION_PATTERN.test(input.sourceRevision)) {
    throw new TypeError("Source revision must be an exact Git object identifier");
  }
  if (
    !(input.captureStartedAt instanceof Date) ||
    !Number.isFinite(input.captureStartedAt.getTime())
  ) {
    throw new TypeError("Capture start time must be a valid Date");
  }
  if (typeof input.targetSource !== "string" || input.targetSource.length < 1) {
    throw new TypeError("Target source must not be empty");
  }
}

function runtimeEvidenceSha256(value: unknown): string {
  return sha256(JSON.stringify(value));
}

export function createDurableReplayDefinitions(
  input: CreateDurableReplayDefinitionsInput,
): DurableReplayDefinitions {
  requireInput(input);
  const scope = EvidenceScopeSchema.parse(input.scope);
  const executableSha256 = sha256(input.targetSource);
  const dependencySnapshotSha256 = runtimeEvidenceSha256({
    dependencies: [],
    node: process.versions.node,
    targetImports: ["node:fs", "node:readline"],
  });
  const invocationSha256 = runtimeEvidenceSha256({
    launcher: "node",
    launcherArguments: [],
    verifiedEntryPointAppended: true,
  });
  const implementationId = `impl_${input.suffix}_durable_target`;
  const implementationSha256 = runtimeEvidenceSha256({
    executableSha256,
    implementationId,
    invocationSha256,
    runtime: { family: "node", version: process.versions.node },
  });
  const provenanceContent = encoder.encode(
    `${JSON.stringify({
      builderId: "proofstack.reference_builder",
      dependencySnapshotSha256,
      executableSha256,
      implementationId,
      implementationSha256,
      invocationSha256,
      repositoryUrl: REPOSITORY_URL,
      sourceRevision: input.sourceRevision,
    })}\n`,
  );
  const provenanceReference: ReplayArtifactContentReference = {
    artifactId: `art_${input.suffix}_durable_target_provenance`,
    classification: "internal",
    mediaType: "application/json",
    sha256: sha256(provenanceContent),
    sizeBytes: provenanceContent.byteLength,
  };
  const targetReleaseDefinition = TargetReleaseDefinitionSchema.parse({
    build: {
      builderId: "proofstack.reference_builder",
      dependencySnapshotSha256,
      executableSha256,
      invocationSha256,
      provenance: provenanceReference,
    },
    environmentVariableNames: [DURABLE_REPLAY_HOLD_ENVIRONMENT_NAME],
    execution: {
      implementationId,
      implementationSha256,
      kind: "preinstalled",
    },
    mounts: [],
    outputLimits: {
      emittedArtifactBytes: 1_048_576,
      stderrBytes: 65_536,
      stdoutBytes: 65_536,
    },
    runtime: {
      architecture: currentArchitecture(),
      entryPoint: "target.mjs",
      family: "node",
      platform: currentPlatform(),
      version: process.versions.node,
    },
    schemaVersion: "0.1",
    scope,
    source: { repositoryUrl: REPOSITORY_URL, revision: input.sourceRevision },
    subprocessPolicy: { mode: "denied" },
    supportedBoundaryKinds: ["model", "tool"],
    supportedBoundaryModes: ["recorded_stub"],
    targetAdapter: PROVIDER_NEUTRAL_DURABLE_TARGET_ADAPTER,
    targetId: `target_${input.suffix}_durable_agent`,
    targetReleaseId: `trg_${input.suffix}_durable_001`,
    workerProtocol: DURABLE_REPLAY_WORKER_PROTOCOL,
  });
  const targetReleaseReference = {
    definitionSha256: digestTargetReleaseDefinition(targetReleaseDefinition),
    targetAdapter: targetReleaseDefinition.targetAdapter,
    targetId: targetReleaseDefinition.targetId,
    targetReleaseId: targetReleaseDefinition.targetReleaseId,
    workerProtocol: targetReleaseDefinition.workerProtocol,
  };
  const invocation = {
    fixture: {
      definitionSha256: input.fixture.definitionSha256,
      fixtureId: input.fixture.fixtureId,
      fixtureVersionId: input.fixture.fixtureVersionId,
    },
    invocationId: `rpi_${input.suffix}_durable_exact`,
    runtime: {
      boundaryMode: "recorded_stub" as const,
      clock: { instant: input.captureStartedAt.toISOString(), mode: "fixed" as const },
      isolation: { mode: "cooperative_in_process" as const },
      locale: "en-US",
      network: { policy: "deny_fallback" as const },
      random: {
        algorithm: "hmac_sha256_counter_v1" as const,
        mode: "seeded" as const,
        seedHex: sha256(`proofstack-durable-replay:${input.suffix}`),
      },
      timeZone: "UTC",
    },
    schemaVersion: "0.1" as const,
    targetAdapter: {
      name: targetReleaseDefinition.targetAdapter.name,
      version: targetReleaseDefinition.targetAdapter.version,
    },
  };
  const invocationDefinitionSha256 = digestRecordedBoundaryReplayInvocationDefinition(invocation);
  const unavailable = { limit: 1, measurement: "unavailable" as const };
  const replayPlanDefinition = ReplayPlanDefinitionSchema.parse({
    boundaries: [
      {
        boundaryId: DURABLE_REPLAY_BOUNDARIES.model,
        invocation,
        invocationDefinitionSha256,
        kind: "model",
        mode: "recorded_stub",
      },
      {
        boundaryId: DURABLE_REPLAY_BOUNDARIES.tool,
        invocation,
        invocationDefinitionSha256,
        kind: "tool",
        mode: "recorded_stub",
      },
    ],
    budget: {
      concurrentInteractions: { limit: 1, measurement: "measured" },
      elapsedMilliseconds: { limit: 60_000, measurement: "measured" },
      emittedArtifactBytes: { limit: 1_048_576, measurement: "measured" },
      inputTokens: { ...unavailable, limit: 4_096 },
      jobAttempts: { limit: 2, measurement: "measured" },
      modelRequests: { limit: 1, measurement: "measured" },
      outputTokens: { ...unavailable, limit: 4_096 },
      providerCostMicrounits: { ...unavailable, limit: 1_000_000 },
      retrievedBytes: { ...unavailable, limit: 1_048_576 },
      toolCalls: { limit: 1, measurement: "measured" },
    },
    dataset: input.dataset,
    isolationProfile: {
      definitionSha256: runtimeEvidenceSha256({
        controls: [
          "environment_allowlist",
          "output_limits",
          "process_boundary",
          "subprocess_policy",
        ],
        kind: "local_child_process",
      }),
      id: "iso_reference_local_child",
      kind: "local_child_process",
      version: "1.0.0",
    },
    planId: `plan_${input.suffix}_durable`,
    planVersionId: `plv_${input.suffix}_durable_001`,
    retryPolicy: {
      automatic: true,
      backoff: { delayMilliseconds: 100, kind: "fixed" },
      idempotencyRequirement: "no_external_effect",
      maxAttempts: 2,
      perAttemptTimeoutMilliseconds: 15_000,
      retryableErrors: ["target_process_interrupted"],
      totalDeadlineMilliseconds: 45_000,
    },
    runtimeProfile: {
      definitionSha256: runtimeEvidenceSha256({
        architecture: targetReleaseDefinition.runtime.architecture,
        family: "node",
        platform: targetReleaseDefinition.runtime.platform,
        version: process.versions.node,
      }),
      family: "node",
      id: "run_reference_node_24",
      version: "1.0.0",
    },
    schemaVersion: "0.1",
    scope,
    targetRelease: targetReleaseReference,
    workerProtocol: DURABLE_REPLAY_WORKER_PROTOCOL,
  });
  return Object.freeze({
    provenanceContent,
    provenanceReference,
    replayPlanDefinition,
    targetReleaseDefinition,
  });
}

export function resolveDurableReplayTarget(
  release: TargetRelease,
  entryPointPath: string,
): ResolvedPreinstalledTarget {
  if (release.execution.kind !== "preinstalled") {
    throw new TypeError("The durable replay example requires a preinstalled target release");
  }
  return Object.freeze({
    entryPointPath,
    executableSha256: release.build.executableSha256,
    implementationId: release.execution.implementationId,
    implementationSha256: release.execution.implementationSha256,
    invocationSha256: release.build.invocationSha256,
    launcherArguments: [],
    launcherPath: process.execPath,
    releaseDefinitionSha256: release.definitionSha256,
    runtime: release.runtime,
  });
}
