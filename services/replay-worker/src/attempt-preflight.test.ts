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
import { preflightReplayTargetSession } from "./attempt-preflight.js";
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
    ...overrides,
  });
  return TargetReleaseSchema.parse({
    createdAt: "2026-08-30T00:00:00.000Z",
    createdByPrincipalId: "usr_preflight",
    definitionSha256: digestTargetReleaseDefinition(definition),
    ...definition,
  });
}

function publishPlan(
  release: TargetRelease,
  overrides: Partial<ReplayPlanDefinition> = {},
): ReplayPlan {
  const definition = ReplayPlanDefinitionSchema.parse({
    ...basePlanDefinition,
    scope: release.scope,
    targetRelease: releaseReference(release),
    workerProtocol: release.workerProtocol,
    ...overrides,
  });
  return ReplayPlanSchema.parse({
    createdAt: "2026-08-30T00:01:00.000Z",
    createdByPrincipalId: "usr_preflight",
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

describe("preflightReplayTargetSession", () => {
  it("builds one exact sorted target-process session", () => {
    const release = publishRelease();
    const plan = publishPlan(release);
    const result = preflightReplayTargetSession({
      plan,
      sessionId: "rts_preflight_001",
      targetRelease: release,
    });
    expect(result.plan).toEqual(plan);
    expect(result.targetRelease).toEqual(release);
    expect(result.startMessage).toEqual({
      boundaries: plan.boundaries.map((boundary) => {
        if (boundary.mode !== "recorded_stub") throw new Error("Expected recorded boundary");
        return {
          boundaryId: boundary.boundaryId,
          invocation: boundary.invocation,
          invocationDefinitionSha256: boundary.invocationDefinitionSha256,
        };
      }),
      schemaVersion: "0.1",
      sessionId: "rts_preflight_001",
      targetRelease: releaseReference(release),
      type: "start",
    });
  });

  it("rejects invalid plan and release publication envelopes", () => {
    const release = publishRelease();
    const plan = publishPlan(release);
    expectPreflightCode(
      () =>
        preflightReplayTargetSession({
          plan: { ...plan, definitionSha256: sha("f") },
          sessionId: "rts_preflight_001",
          targetRelease: release,
        }),
      "invalid_plan",
    );
    expectPreflightCode(
      () =>
        preflightReplayTargetSession({
          plan,
          sessionId: "rts_preflight_001",
          targetRelease: { ...release, definitionSha256: sha("f") },
        }),
      "invalid_target_release",
    );
  });

  it("binds scope and the complete immutable target reference", () => {
    const release = publishRelease();
    const plan = publishPlan(release);
    const otherScopeRelease = publishRelease({
      scope: { ...release.scope, environmentId: "env_other" },
    });
    expectPreflightCode(
      () =>
        preflightReplayTargetSession({
          plan,
          sessionId: "rts_preflight_001",
          targetRelease: otherScopeRelease,
        }),
      "scope_mismatch",
    );
    const otherTarget = publishRelease({ targetId: "target_other" });
    expectPreflightCode(
      () =>
        preflightReplayTargetSession({
          plan,
          sessionId: "rts_preflight_001",
          targetRelease: otherTarget,
        }),
      "target_reference_mismatch",
    );
  });

  it("requires matching local runtime and a safely schedulable timeout", () => {
    const runtimeRelease = publishRelease({
      runtime: { ...baseReleaseDefinition.runtime, family: "other_runtime" },
    });
    expectPreflightCode(
      () =>
        preflightReplayTargetSession({
          plan: publishPlan(runtimeRelease),
          sessionId: "rts_preflight_001",
          targetRelease: runtimeRelease,
        }),
      "runtime_profile_mismatch",
    );

    const release = publishRelease();
    expectPreflightCode(
      () =>
        preflightReplayTargetSession({
          plan: publishPlan(release, {
            isolationProfile: { ...basePlanDefinition.isolationProfile, kind: "container" },
          }),
          sessionId: "rts_preflight_001",
          targetRelease: release,
        }),
      "isolation_profile_unsupported",
    );
    const timeout = MAX_REPLAY_TARGET_TIMER_DELAY_MS + 1;
    expectPreflightCode(
      () =>
        preflightReplayTargetSession({
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
          sessionId: "rts_preflight_001",
          targetRelease: release,
        }),
      "attempt_timeout_unsupported",
    );
  });

  it("rejects non-recorded and undeclared boundary capabilities", () => {
    const release = publishRelease();
    const recorded = basePlanDefinition.boundaries[0];
    if (recorded?.mode !== "recorded_stub") throw new Error("Expected vector boundary");
    const simulation = {
      boundaryId: recorded.boundaryId,
      configurationSha256: sha("1"),
      kind: "retrieval" as const,
      mode: "simulation" as const,
      qualification: {
        artifactId: "art_simulation_qualification",
        classification: "internal" as const,
        mediaType: "application/json",
        sha256: sha("2"),
        sizeBytes: 32,
      },
      seedHex: sha("3"),
      simulatorRelease: releaseReference(release),
    };
    expectPreflightCode(
      () =>
        preflightReplayTargetSession({
          plan: publishPlan(release, { boundaries: [simulation] }),
          sessionId: "rts_preflight_001",
          targetRelease: release,
        }),
      "unsupported_boundary_mode",
    );

    const unsupportedModeRelease = publishRelease({ supportedBoundaryModes: ["simulation"] });
    expectPreflightCode(
      () =>
        preflightReplayTargetSession({
          plan: publishPlan(unsupportedModeRelease),
          sessionId: "rts_preflight_001",
          targetRelease: unsupportedModeRelease,
        }),
      "unsupported_boundary_mode",
    );

    const unsupportedKindRelease = publishRelease({ supportedBoundaryKinds: ["tool"] });
    expectPreflightCode(
      () =>
        preflightReplayTargetSession({
          plan: publishPlan(unsupportedKindRelease),
          sessionId: "rts_preflight_001",
          targetRelease: unsupportedKindRelease,
        }),
      "unsupported_boundary_kind",
    );
  });

  it("rehashes every invocation and validates the final session envelope", () => {
    const release = publishRelease();
    const boundary = basePlanDefinition.boundaries[0];
    if (boundary?.mode !== "recorded_stub") throw new Error("Expected vector boundary");
    expect(digestRecordedBoundaryReplayInvocationDefinition(boundary.invocation)).toBe(
      boundary.invocationDefinitionSha256,
    );
    expectPreflightCode(
      () =>
        preflightReplayTargetSession({
          plan: publishPlan(release, {
            boundaries: [{ ...boundary, invocationDefinitionSha256: sha("f") }],
          }),
          sessionId: "rts_preflight_001",
          targetRelease: release,
        }),
      "invocation_digest_mismatch",
    );
    expectPreflightCode(
      () =>
        preflightReplayTargetSession({
          plan: publishPlan(release),
          sessionId: "x",
          targetRelease: release,
        }),
      "session_invalid",
    );
  });
});
