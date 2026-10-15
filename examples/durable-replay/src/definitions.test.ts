import {
  ReplayPlanDefinitionSchema,
  ReplayTargetAdapterReferenceSchema,
  TargetReleaseDefinitionSchema,
  TargetReleaseSchema,
} from "@proofstack/contracts";
import { digestReplayPlanDefinition, digestTargetReleaseDefinition } from "@proofstack/replay";
import { describe, expect, it } from "vitest";
import {
  createDurableReplayDefinitions,
  bindDurableReplayProfiles,
  recordedReplayTargetAdapter,
  resolveDurableReplayTarget,
} from "./definitions.js";
import { createProviderNeutralDurableTargetSource } from "./target-source.js";

const scope = {
  environmentId: "env_durable_example",
  projectId: "prj_durable_example",
  tenantId: "ten_durable_example",
} as const;

function definitions() {
  const targetSource = createProviderNeutralDurableTargetSource({
    modelNormalizedRequest: Buffer.from("model", "utf8"),
    toolNormalizedRequest: Buffer.from("tool", "utf8"),
  });
  return createDurableReplayDefinitions({
    captureStartedAt: new Date("2026-08-31T00:00:00.000Z"),
    dataset: {
      datasetId: "dat_durable_example",
      datasetVersionId: "dsv_durable_example_001",
      definitionSha256: "1".repeat(64),
    },
    fixture: {
      definitionSha256: "2".repeat(64),
      fixtureId: "fix_durable_example",
      fixtureVersionId: "fiv_durable_example_001",
    },
    scope,
    sourceRevision: "3".repeat(40),
    suffix: "a1b2c3d4e5f6",
    targetSource,
  });
}

describe("new canonical contributor profile binding", () => {
  it("changes the new plan identity while retaining exact execution, budget, lineage and original definitions", () => {
    const original = definitions().replayPlanDefinition;
    const retained = structuredClone(original);
    const profiles = {
      runtimeProfile: {
        ...original.runtimeProfile,
        id: "runtime_canonical",
        definitionSha256: "a".repeat(64),
      },
      isolationProfile: {
        ...original.isolationProfile,
        id: "isolation_canonical",
        definitionSha256: "b".repeat(64),
      },
    };
    const result = bindDurableReplayProfiles(original, profiles);
    expect(digestReplayPlanDefinition(result)).not.toBe(digestReplayPlanDefinition(original));
    expect(original).toEqual(retained);
    expect({
      ...result,
      runtimeProfile: original.runtimeProfile,
      isolationProfile: original.isolationProfile,
    }).toEqual(original);
    profiles.runtimeProfile.definitionSha256 = "c".repeat(64);
    expect(result.runtimeProfile.definitionSha256).toBe("a".repeat(64));
    expect(result.isolationProfile.definitionSha256).toBe("b".repeat(64));
  });
  it.each(["runtime_digest", "isolation_digest", "unknown_reference_field", "invalid_parent"])(
    "rejects malformed %s before publishing a plan",
    (fault) => {
      const original = definitions().replayPlanDefinition;
      const profiles = {
        runtimeProfile: { ...original.runtimeProfile },
        isolationProfile: { ...original.isolationProfile },
      };
      if (fault === "runtime_digest") profiles.runtimeProfile.definitionSha256 = "invalid";
      if (fault === "isolation_digest") profiles.isolationProfile.definitionSha256 = "invalid";
      if (fault === "unknown_reference_field")
        Object.assign(profiles.runtimeProfile, { executable: "caller-command" });
      if (fault === "invalid_parent") original.scope.tenantId = "invalid tenant";
      expect(() => bindDurableReplayProfiles(original, profiles)).toThrow();
    },
  );
});

describe("durable replay definitions", () => {
  it("projects the worker adapter into the strict recorded-replay reference", () => {
    const { targetReleaseDefinition } = definitions();
    expect(targetReleaseDefinition.targetAdapter.protocolVersion).toBe("0.2");
    expect(
      ReplayTargetAdapterReferenceSchema.safeParse(targetReleaseDefinition.targetAdapter).success,
    ).toBe(false);
    const reference = recordedReplayTargetAdapter(targetReleaseDefinition);
    expect(ReplayTargetAdapterReferenceSchema.parse(reference)).toEqual({
      name: targetReleaseDefinition.targetAdapter.name,
      version: targetReleaseDefinition.targetAdapter.version,
    });
  });

  it("binds the executable, provenance, fixture, release, plan, and runtime exactly", () => {
    const value = definitions();
    expect(TargetReleaseDefinitionSchema.parse(value.targetReleaseDefinition)).toEqual(
      value.targetReleaseDefinition,
    );
    expect(ReplayPlanDefinitionSchema.parse(value.replayPlanDefinition)).toEqual(
      value.replayPlanDefinition,
    );
    expect(value.provenanceContent.byteLength).toBe(value.provenanceReference.sizeBytes);
    expect(value.replayPlanDefinition.targetRelease.definitionSha256).toBe(
      digestTargetReleaseDefinition(value.targetReleaseDefinition),
    );
    expect(digestReplayPlanDefinition(value.replayPlanDefinition)).toMatch(/^[0-9a-f]{64}$/);
    expect(
      value.replayPlanDefinition.boundaries.map(({ boundaryId, kind, mode }) => ({
        boundaryId,
        kind,
        mode,
      })),
    ).toEqual([
      { boundaryId: "bnd_reference_model", kind: "model", mode: "recorded_stub" },
      { boundaryId: "bnd_reference_tool", kind: "tool", mode: "recorded_stub" },
    ]);
    expect(value.targetReleaseDefinition.environmentVariableNames).toEqual([
      "PROOFSTACK_EXAMPLE_HOLD_MILLISECONDS",
    ]);
    expect(value.replayPlanDefinition.retryPolicy).toEqual({
      automatic: true,
      backoff: { delayMilliseconds: 100, kind: "fixed" },
      idempotencyRequirement: "no_external_effect",
      maxAttempts: 2,
      perAttemptTimeoutMilliseconds: 15_000,
      retryableErrors: ["target_process_interrupted"],
      totalDeadlineMilliseconds: 45_000,
    });
  });

  it("projects the published preinstalled release into an exact local registry record", () => {
    const value = definitions();
    const release = TargetReleaseSchema.parse({
      ...value.targetReleaseDefinition,
      createdAt: "2026-08-31T00:00:01.000Z",
      createdByPrincipalId: "usr_durable_example",
      definitionSha256: digestTargetReleaseDefinition(value.targetReleaseDefinition),
    });
    expect(resolveDurableReplayTarget(release, "/tmp/proofstack/target.mjs")).toMatchObject({
      entryPointPath: "/tmp/proofstack/target.mjs",
      executableSha256: release.build.executableSha256,
      implementationId:
        release.execution.kind === "preinstalled" ? release.execution.implementationId : "",
      launcherArguments: [],
      launcherPath: process.execPath,
      releaseDefinitionSha256: release.definitionSha256,
    });
    expect(() =>
      resolveDurableReplayTarget(
        {
          ...release,
          execution: { artifact: value.provenanceReference, bundleFormat: "zip", kind: "artifact" },
        },
        "/tmp/proofstack/target.mjs",
      ),
    ).toThrow("preinstalled");
  });

  it.each([
    [{ suffix: "invalid" }, "suffix"],
    [{ sourceRevision: "invalid" }, "revision"],
    [{ captureStartedAt: new Date("invalid") }, "Capture start"],
    [{ captureStartedAt: "invalid" as unknown as Date }, "Capture start"],
    [{ targetSource: "" }, "Target source"],
    [{ targetSource: 1 as unknown as string }, "Target source"],
  ])("rejects incomplete authority input %#", (override, message) => {
    const targetSource = createProviderNeutralDurableTargetSource({
      modelNormalizedRequest: Buffer.from("model"),
      toolNormalizedRequest: Buffer.from("tool"),
    });
    expect(() =>
      createDurableReplayDefinitions({
        captureStartedAt: new Date("2026-08-31T00:00:00.000Z"),
        dataset: {
          datasetId: "dat_durable_example",
          datasetVersionId: "dsv_durable_example_001",
          definitionSha256: "1".repeat(64),
        },
        fixture: {
          definitionSha256: "2".repeat(64),
          fixtureId: "fix_durable_example",
          fixtureVersionId: "fiv_durable_example_001",
        },
        scope,
        sourceRevision: "3".repeat(40),
        suffix: "a1b2c3d4e5f6",
        targetSource,
        ...override,
      }),
    ).toThrow(message);
  });
});
