import {
  ReplayPlanDefinitionSchema,
  TargetReleaseDefinitionSchema,
  TargetReleaseSchema,
} from "@proofstack/contracts";
import { digestReplayPlanDefinition, digestTargetReleaseDefinition } from "@proofstack/replay";
import { describe, expect, it } from "vitest";
import { createDurableReplayDefinitions, resolveDurableReplayTarget } from "./definitions.js";
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

describe("durable replay definitions", () => {
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
