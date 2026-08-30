import { readFile } from "node:fs/promises";
import {
  type ReplayPlan,
  type ReplayPlanDefinition,
  ReplayPlanDefinitionSchema,
  ReplayPlanSchema,
  type TargetRelease,
  type TargetReleaseDefinition,
  TargetReleaseDefinitionSchema,
  TargetReleaseSchema,
} from "@proofstack/contracts";
import {
  digestRecordedBoundaryReplayInvocationDefinition,
  digestReplayPlanDefinition,
  digestTargetReleaseDefinition,
} from "@proofstack/replay";
import { beforeAll, describe, expect, it } from "vitest";
import { preflightReplayTargetV2Session } from "./attempt-preflight-v2.js";
import { MAX_REPLAY_TARGET_TIMER_DELAY_MS } from "./target-process-supervisor.js";

const sha = (digit: string): string => digit.repeat(64);
let basePlanDefinition: ReplayPlanDefinition;
let baseReleaseDefinition: TargetReleaseDefinition;

function releaseReference(release: TargetRelease): ReplayPlan["targetRelease"] {
  return {
    definitionSha256: release.definitionSha256,
    targetAdapter: release.targetAdapter,
    targetId: release.targetId,
    targetReleaseId: release.targetReleaseId,
    workerProtocol: release.workerProtocol,
  };
}

function publishRelease(overrides: Partial<TargetReleaseDefinition> = {}): TargetRelease {
  const definition = TargetReleaseDefinitionSchema.parse({
    ...baseReleaseDefinition,
    supportedBoundaryKinds: ["model", "retrieval", "tool"],
    supportedBoundaryModes: ["live_provider", "recorded_stub", "simulation"],
    ...overrides,
  });
  return TargetReleaseSchema.parse({
    createdAt: "2026-08-30T00:00:00.000Z",
    createdByPrincipalId: "usr_preflight_v2",
    definitionSha256: digestTargetReleaseDefinition(definition),
    ...definition,
  });
}

function recordedBoundary() {
  const boundary = basePlanDefinition.boundaries[0];
  if (boundary?.mode !== "recorded_stub") throw new Error("Expected vector boundary");
  return boundary;
}

function mixedBoundaries(release: TargetRelease): ReplayPlanDefinition["boundaries"] {
  const recorded = recordedBoundary();
  return [
    {
      boundaryId: "bnd_live_model",
      credential: {
        credentialId: "cred_preflight",
        credentialVersionId: "crv_preflight_001",
      },
      destination: { hostname: "api.example.com", port: 443, scheme: "https" },
      endpointProfile: {
        definitionSha256: sha("1"),
        endpointProfileId: "end_preflight",
        endpointProfileVersion: "1.0.0",
      },
      kind: "model",
      mode: "live_provider",
      operation: "chat",
      requestLimits: { requestBytes: 1_024, responseBytes: 4_096 },
      sideEffect: { kind: "read_only" },
      usageSource: "provider_reported",
    },
    {
      ...recorded,
      boundaryId: "bnd_recorded_model",
    },
    {
      boundaryId: "bnd_simulation_retrieval",
      configurationSha256: sha("2"),
      kind: "retrieval",
      mode: "simulation",
      qualification: {
        artifactId: "art_simulation_qualification",
        classification: "internal",
        mediaType: "application/json",
        sha256: sha("3"),
        sizeBytes: 128,
      },
      seedHex: sha("4"),
      simulatorRelease: releaseReference(release),
    },
  ];
}

function publishPlan(
  release: TargetRelease,
  overrides: Partial<ReplayPlanDefinition> = {},
): ReplayPlan {
  const definition = ReplayPlanDefinitionSchema.parse({
    ...basePlanDefinition,
    boundaries: mixedBoundaries(release),
    scope: release.scope,
    targetRelease: releaseReference(release),
    workerProtocol: release.workerProtocol,
    ...overrides,
  });
  return ReplayPlanSchema.parse({
    createdAt: "2026-08-30T00:01:00.000Z",
    createdByPrincipalId: "usr_preflight_v2",
    definitionSha256: digestReplayPlanDefinition(definition),
    ...definition,
  });
}

function expectPreflightCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected replay attempt preflight failure");
  } catch (error) {
    expect(error).toMatchObject({ code, name: "ReplayAttemptPreflightError" });
  }
}

beforeAll(async () => {
  const document = JSON.parse(
    await readFile(
      new URL("../../../packages/replay/vectors/replay-definition-v1.json", import.meta.url),
      "utf8",
    ),
  ) as { readonly vectors: readonly { readonly input: unknown; readonly kind: string }[] };
  const releaseVector = document.vectors.find(({ kind }) => kind === "target_release");
  const planVector = document.vectors.find(({ kind }) => kind === "replay_plan");
  if (!releaseVector || !planVector) throw new Error("Replay definition vectors are incomplete");
  baseReleaseDefinition = TargetReleaseDefinitionSchema.parse(releaseVector.input);
  basePlanDefinition = ReplayPlanDefinitionSchema.parse(planVector.input);
});

describe("preflightReplayTargetV2Session", () => {
  it("projects a sorted mixed-mode plan without worker-owned live or simulator fields", () => {
    const release = publishRelease();
    const plan = publishPlan(release);
    const result = preflightReplayTargetV2Session({
      plan,
      sessionId: "session_preflight_002",
      targetRelease: release,
    });
    expect(result.plan).toEqual(plan);
    expect(result.targetRelease).toEqual(release);
    expect(result.startMessage).toEqual({
      boundaries: [
        { boundaryId: "bnd_live_model", kind: "model", mode: "live_provider" },
        {
          boundaryId: "bnd_recorded_model",
          invocation: recordedBoundary().invocation,
          invocationDefinitionSha256: recordedBoundary().invocationDefinitionSha256,
          kind: "model",
          mode: "recorded_stub",
        },
        {
          boundaryId: "bnd_simulation_retrieval",
          kind: "retrieval",
          mode: "simulation",
        },
      ],
      schemaVersion: "0.2",
      sessionId: "session_preflight_002",
      targetRelease: releaseReference(release),
      type: "start",
    });
    const keys = new Set<string>();
    JSON.stringify(result.startMessage, (key, value: unknown) => {
      if (key !== "") keys.add(key);
      return value;
    });
    for (const forbidden of [
      "credential",
      "destination",
      "endpointProfile",
      "qualification",
      "simulatorRelease",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("rejects invalid publication envelopes, scope, and target references", () => {
    const release = publishRelease();
    const plan = publishPlan(release);
    expectPreflightCode(
      () =>
        preflightReplayTargetV2Session({
          plan: { ...plan, definitionSha256: sha("f") },
          sessionId: "session_preflight_002",
          targetRelease: release,
        }),
      "invalid_plan",
    );
    expectPreflightCode(
      () =>
        preflightReplayTargetV2Session({
          plan,
          sessionId: "session_preflight_002",
          targetRelease: { ...release, definitionSha256: sha("f") },
        }),
      "invalid_target_release",
    );
    const otherScope = publishRelease({
      scope: { ...release.scope, environmentId: "env_other" },
    });
    expectPreflightCode(
      () =>
        preflightReplayTargetV2Session({
          plan,
          sessionId: "session_preflight_002",
          targetRelease: otherScope,
        }),
      "scope_mismatch",
    );
    const otherTarget = publishRelease({ targetId: "target_other" });
    expectPreflightCode(
      () =>
        preflightReplayTargetV2Session({
          plan,
          sessionId: "session_preflight_002",
          targetRelease: otherTarget,
        }),
      "target_reference_mismatch",
    );
  });

  it("enforces runtime, isolation, and timer compatibility", () => {
    const otherRuntime = publishRelease({
      runtime: { ...baseReleaseDefinition.runtime, family: "other_runtime" },
    });
    expectPreflightCode(
      () =>
        preflightReplayTargetV2Session({
          plan: publishPlan(otherRuntime),
          sessionId: "session_preflight_002",
          targetRelease: otherRuntime,
        }),
      "runtime_profile_mismatch",
    );
    const release = publishRelease();
    expectPreflightCode(
      () =>
        preflightReplayTargetV2Session({
          plan: publishPlan(release, {
            isolationProfile: { ...basePlanDefinition.isolationProfile, kind: "container" },
          }),
          sessionId: "session_preflight_002",
          targetRelease: release,
        }),
      "isolation_profile_unsupported",
    );
    const timeout = MAX_REPLAY_TARGET_TIMER_DELAY_MS + 1;
    expectPreflightCode(
      () =>
        preflightReplayTargetV2Session({
          plan: publishPlan(release, {
            budget: {
              ...basePlanDefinition.budget,
              elapsedMilliseconds: { limit: timeout, measurement: "measured" },
            },
            retryPolicy: {
              ...basePlanDefinition.retryPolicy,
              perAttemptTimeoutMilliseconds: timeout,
              totalDeadlineMilliseconds: timeout,
            },
          }),
          sessionId: "session_preflight_002",
          targetRelease: release,
        }),
      "attempt_timeout_unsupported",
    );
  });

  it("enforces declared boundary capabilities and recorded invocation digests", () => {
    const unsupportedMode = publishRelease({ supportedBoundaryModes: ["recorded_stub"] });
    expectPreflightCode(
      () =>
        preflightReplayTargetV2Session({
          plan: publishPlan(unsupportedMode),
          sessionId: "session_preflight_002",
          targetRelease: unsupportedMode,
        }),
      "unsupported_boundary_mode",
    );
    const unsupportedKind = publishRelease({ supportedBoundaryKinds: ["model"] });
    expectPreflightCode(
      () =>
        preflightReplayTargetV2Session({
          plan: publishPlan(unsupportedKind),
          sessionId: "session_preflight_002",
          targetRelease: unsupportedKind,
        }),
      "unsupported_boundary_kind",
    );
    const release = publishRelease();
    const recorded = recordedBoundary();
    expect(digestRecordedBoundaryReplayInvocationDefinition(recorded.invocation)).toBe(
      recorded.invocationDefinitionSha256,
    );
    expectPreflightCode(
      () =>
        preflightReplayTargetV2Session({
          plan: publishPlan(release, {
            boundaries: mixedBoundaries(release).map((boundary) =>
              boundary.mode === "recorded_stub"
                ? { ...boundary, invocationDefinitionSha256: sha("f") }
                : boundary,
            ),
          }),
          sessionId: "session_preflight_002",
          targetRelease: release,
        }),
      "invocation_digest_mismatch",
    );
  });

  it("validates the final strict session envelope", () => {
    const release = publishRelease();
    expectPreflightCode(
      () =>
        preflightReplayTargetV2Session({
          plan: publishPlan(release),
          sessionId: "x",
          targetRelease: release,
        }),
      "session_invalid",
    );
  });
});
