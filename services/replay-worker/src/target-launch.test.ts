import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type TargetRelease,
  type TargetReleaseDefinition,
  TargetReleaseSchema,
} from "@proofstack/contracts";
import {
  digestRecordedBoundaryReplayInvocationDefinition,
  digestTargetReleaseDefinition,
} from "@proofstack/replay";
import { afterEach, describe, expect, it } from "vitest";
import { ReplayTargetLaunchError } from "./errors.js";
import {
  MAX_TARGET_ENVIRONMENT_TOTAL_BYTES,
  MAX_TARGET_ENVIRONMENT_VALUE_BYTES,
  MAX_TARGET_LAUNCH_ARGUMENTS,
  prepareTargetLaunch,
  type PrepareTargetLaunchOptions,
  type ResolvedPreinstalledTarget,
  targetLaunchEntryPointBasename,
} from "./target-launch.js";

const temporaryDirectories: string[] = [];

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha(digit: string): string {
  return digit.repeat(64);
}

function currentPlatform(): "darwin" | "linux" {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("Replay worker launch tests require a supported platform");
  }
  return process.platform;
}

function currentArchitecture(): "arm64" | "x64" {
  if (process.arch !== "arm64" && process.arch !== "x64") {
    throw new Error("Replay worker launch tests require a supported architecture");
  }
  return process.arch;
}

interface Fixture {
  readonly entryPointPath: string;
  readonly entryPointSource: string;
  readonly launcherPath: string;
  readonly options: PrepareTargetLaunchOptions;
  readonly release: TargetRelease;
  readonly resolved: ResolvedPreinstalledTarget;
  readonly root: string;
  readonly startMessage: ReturnType<typeof startFor>;
  readonly workspaceParent: string;
}

function releaseDefinition(
  entryPointSha256: string,
  overrides: Partial<TargetReleaseDefinition> = {},
): TargetReleaseDefinition {
  const base: TargetReleaseDefinition = {
    build: {
      builderId: "proofstack.reference_builder",
      dependencySnapshotSha256: sha("1"),
      executableSha256: entryPointSha256,
      invocationSha256: sha("2"),
      provenance: {
        artifactId: "art_launch_provenance",
        classification: "internal",
        mediaType: "application/json",
        sha256: sha("3"),
        sizeBytes: 128,
      },
    },
    environmentVariableNames: ["ALLOWED_TOKEN"],
    execution: {
      implementationId: "impl_launch_target",
      implementationSha256: sha("4"),
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
      entryPoint: "dist/target.mjs",
      family: "node",
      platform: currentPlatform(),
      version: process.versions.node,
    },
    schemaVersion: "0.1",
    scope: {
      environmentId: "env_launch",
      projectId: "prj_launch",
      tenantId: "ten_launch",
    },
    source: {
      repositoryUrl: "https://github.com/Kwondh0321/proofstack",
      revision: "5".repeat(40),
    },
    subprocessPolicy: { mode: "denied" },
    supportedBoundaryKinds: ["tool"],
    supportedBoundaryModes: ["recorded_stub"],
    targetAdapter: {
      name: "proofstack.launch_target",
      protocolVersion: "0.1",
      version: "1.0.0",
    },
    targetId: "target_launch",
    targetReleaseId: "trg_launch_001",
    workerProtocol: { name: "proofstack.replay-worker", version: "0.1" },
  };
  return { ...base, ...overrides } as TargetReleaseDefinition;
}

function releaseFromDefinition(definition: TargetReleaseDefinition): TargetRelease {
  return TargetReleaseSchema.parse({
    createdAt: "2026-08-30T00:00:00.000Z",
    createdByPrincipalId: "usr_launch_publisher",
    definitionSha256: digestTargetReleaseDefinition(definition),
    ...definition,
  });
}

function startFor(release: TargetRelease) {
  const invocation = {
    fixture: {
      definitionSha256: sha("6"),
      fixtureId: "fix_launch",
      fixtureVersionId: "fiv_launch_001",
    },
    invocationId: "rpi_launch_001",
    runtime: {
      boundaryMode: "recorded_stub" as const,
      clock: { instant: "2026-08-30T00:00:00.000Z", mode: "fixed" as const },
      isolation: { mode: "cooperative_in_process" as const },
      locale: "en-US",
      network: { policy: "deny_fallback" as const },
      random: {
        algorithm: "hmac_sha256_counter_v1" as const,
        mode: "seeded" as const,
        seedHex: sha("7"),
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
        boundaryId: "bnd_launch",
        invocation,
        invocationDefinitionSha256: digestRecordedBoundaryReplayInvocationDefinition(invocation),
      },
    ],
    schemaVersion: "0.1",
    sessionId: "rts_launch_001",
    targetRelease: {
      definitionSha256: release.definitionSha256,
      targetAdapter: release.targetAdapter,
      targetId: release.targetId,
      targetReleaseId: release.targetReleaseId,
      workerProtocol: release.workerProtocol,
    },
    type: "start",
  } as const;
}

function rebindResolvedTarget(
  resolved: ResolvedPreinstalledTarget,
  release: TargetRelease,
): ResolvedPreinstalledTarget {
  if (release.execution.kind !== "preinstalled") {
    throw new Error("Expected a preinstalled target release");
  }
  return {
    ...resolved,
    executableSha256: release.build.executableSha256,
    implementationId: release.execution.implementationId,
    implementationSha256: release.execution.implementationSha256,
    invocationSha256: release.build.invocationSha256,
    releaseDefinitionSha256: release.definitionSha256,
    runtime: release.runtime,
  };
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "proofstack-target-launch-test-"));
  temporaryDirectories.push(root);
  const workspaceParent = join(root, "workspaces");
  await mkdir(workspaceParent);
  const entryPointPath = join(root, "source-target.mjs");
  const launcherPath = join(root, "runtime-launcher");
  const entryPointSource = "export const proofstackTarget = true;\n";
  await writeFile(entryPointPath, entryPointSource);
  await writeFile(launcherPath, "#!/bin/sh\nexit 0\n");
  await chmod(launcherPath, 0o500);
  const release = releaseFromDefinition(releaseDefinition(sha256(entryPointSource)));
  const startMessage = startFor(release);
  const resolved: ResolvedPreinstalledTarget = {
    entryPointPath,
    executableSha256: release.build.executableSha256,
    implementationId:
      release.execution.kind === "preinstalled" ? release.execution.implementationId : "",
    implementationSha256:
      release.execution.kind === "preinstalled" ? release.execution.implementationSha256 : "",
    invocationSha256: release.build.invocationSha256,
    launcherArguments: ["--proofstack-target"],
    launcherPath,
    releaseDefinitionSha256: release.definitionSha256,
    runtime: release.runtime,
  };
  const options: PrepareTargetLaunchOptions = {
    availableEnvironment: { ALLOWED_TOKEN: "fixture-token", AMBIENT_SECRET: "must-not-pass" },
    registry: { resolve: async () => resolved },
    startMessage,
    targetRelease: release,
    workspaceParent,
  };
  return {
    entryPointPath,
    entryPointSource,
    launcherPath,
    options,
    release,
    resolved,
    root,
    startMessage,
    workspaceParent,
  };
}

function expectLaunchCode(promise: Promise<unknown>, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error("Expected target launch failure");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(ReplayTargetLaunchError);
      expect((error as ReplayTargetLaunchError).code).toBe(code);
    },
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("prepareTargetLaunch", () => {
  it("copies and verifies one exact entry point into a fresh allowlisted environment", async () => {
    const value = await fixture();
    const launch = await prepareTargetLaunch(value.options);
    expect(launch.executablePath).toBe(value.launcherPath);
    expect(launch.arguments).toEqual(["--proofstack-target", launch.verifiedEntryPointPath]);
    expect(targetLaunchEntryPointBasename(launch)).toBe("target.mjs");
    expect(await readFile(launch.verifiedEntryPointPath, "utf8")).toBe(value.entryPointSource);
    expect((await lstat(launch.verifiedEntryPointPath)).mode & 0o777).toBe(0o500);
    expect(launch.environment).toEqual({
      ALLOWED_TOKEN: "fixture-token",
      PROOFSTACK_WORKER_PROTOCOL_INPUT_FD: "3",
      PROOFSTACK_WORKER_PROTOCOL_OUTPUT_FD: "4",
      PROOFSTACK_WORKER_WORKSPACE: launch.workspacePath,
    });
    expect(launch.environment).not.toHaveProperty("AMBIENT_SECRET");
    await launch.cleanup();
    await launch.cleanup();
    await expect(lstat(launch.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an invalid release and any start-message lineage change", async () => {
    const value = await fixture();
    await expectLaunchCode(
      prepareTargetLaunch({
        ...value.options,
        targetRelease: { ...value.release, hidden: true },
      }),
      "invalid_target_release",
    );
    await expectLaunchCode(
      prepareTargetLaunch({
        ...value.options,
        startMessage: { ...value.startMessage, shell: true },
      }),
      "start_message_mismatch",
    );
    await expectLaunchCode(
      prepareTargetLaunch({
        ...value.options,
        startMessage: {
          ...value.startMessage,
          targetRelease: { ...value.startMessage.targetRelease, targetId: "target_other" },
        },
      }),
      "start_message_mismatch",
    );
    const boundary = value.startMessage.boundaries[0];
    if (!boundary) throw new Error("Expected launch boundary");
    await expectLaunchCode(
      prepareTargetLaunch({
        ...value.options,
        startMessage: {
          ...value.startMessage,
          boundaries: [{ ...boundary, invocationDefinitionSha256: sha("f") }],
        },
      }),
      "start_message_mismatch",
    );
  });

  it("rejects execution profiles the local child supervisor cannot enforce", async () => {
    const value = await fixture();
    const artifactDefinition = releaseDefinition(value.release.build.executableSha256, {
      execution: {
        artifact: {
          artifactId: "art_target_bundle",
          classification: "internal",
          mediaType: "application/zip",
          sha256: sha("8"),
          sizeBytes: 1_024,
        },
        bundleFormat: "zip",
        kind: "artifact",
      },
    });
    const mountedDefinition = releaseDefinition(value.release.build.executableSha256, {
      mounts: [{ access: "read_only", mountId: "mnt_input", targetPath: "/proofstack/inputs" }],
    });
    const subprocessDefinition = releaseDefinition(value.release.build.executableSha256, {
      subprocessPolicy: {
        allowedImplementations: [{ executableSha256: sha("9"), implementationId: "impl_helper" }],
        mode: "allowlisted",
      },
    });
    const otherArchitecture = currentArchitecture() === "arm64" ? "x64" : "arm64";
    const runtimeDefinition = releaseDefinition(value.release.build.executableSha256, {
      runtime: { ...value.release.runtime, architecture: otherArchitecture },
    });
    for (const [definition, code] of [
      [artifactDefinition, "unsupported_execution"],
      [mountedDefinition, "unsupported_mounts"],
      [subprocessDefinition, "unsupported_subprocess_policy"],
      [runtimeDefinition, "runtime_incompatible"],
    ] as const) {
      const release = releaseFromDefinition(definition);
      await expectLaunchCode(
        prepareTargetLaunch({
          ...value.options,
          startMessage: startFor(release),
          targetRelease: release,
        }),
        code,
      );
    }
  });

  it("requires one exact trusted implementation registry binding", async () => {
    const value = await fixture();
    await expectLaunchCode(
      prepareTargetLaunch({
        ...value.options,
        registry: { resolve: async () => null },
      }),
      "implementation_unavailable",
    );
    const mismatches: ResolvedPreinstalledTarget[] = [
      { ...value.resolved, releaseDefinitionSha256: sha("a") },
      { ...value.resolved, implementationId: "impl_other" },
      { ...value.resolved, implementationSha256: sha("b") },
      { ...value.resolved, executableSha256: sha("c") },
      { ...value.resolved, invocationSha256: sha("d") },
      { ...value.resolved, runtime: { ...value.resolved.runtime, version: "0.0.1" } },
      {
        ...value.resolved,
        launcherArguments: Array.from({ length: MAX_TARGET_LAUNCH_ARGUMENTS + 1 }, () => "x"),
      },
      { ...value.resolved, launcherArguments: ["x".repeat(4_097)] },
      { ...value.resolved, launcherArguments: ["bad\0argument"] },
    ];
    for (const resolved of mismatches) {
      await expectLaunchCode(
        prepareTargetLaunch({
          ...value.options,
          registry: { resolve: async () => resolved },
        }),
        "implementation_mismatch",
      );
    }
  });

  it("requires regular absolute source, launcher, and workspace paths", async () => {
    const value = await fixture();
    const directoryPath = join(value.root, "entry-directory");
    await mkdir(directoryPath);
    const linkPath = join(value.root, "entry-link");
    await symlink(value.entryPointPath, linkPath);
    for (const resolved of [
      { ...value.resolved, entryPointPath: "relative-target.mjs" },
      { ...value.resolved, entryPointPath: join(value.root, "missing") },
      { ...value.resolved, entryPointPath: directoryPath },
      { ...value.resolved, entryPointPath: linkPath },
      { ...value.resolved, launcherPath: "relative-launcher" },
    ]) {
      await expectLaunchCode(
        prepareTargetLaunch({
          ...value.options,
          registry: { resolve: async () => resolved },
        }),
        "executable_invalid",
      );
    }
    const nonExecutableLauncher = join(value.root, "non-executable-launcher");
    await writeFile(nonExecutableLauncher, "#!/bin/sh\nexit 0\n");
    await chmod(nonExecutableLauncher, 0o400);
    await expectLaunchCode(
      prepareTargetLaunch({
        ...value.options,
        registry: {
          resolve: async () => ({ ...value.resolved, launcherPath: nonExecutableLauncher }),
        },
      }),
      "executable_invalid",
    );
    await expectLaunchCode(
      prepareTargetLaunch({ ...value.options, workspaceParent: "relative-workspaces" }),
      "executable_invalid",
    );
  });

  it("removes the fresh workspace when copied entry-point integrity fails", async () => {
    const value = await fixture();
    await writeFile(value.entryPointPath, "tampered after publication\n");
    await expectLaunchCode(prepareTargetLaunch(value.options), "executable_mismatch");
    expect(await readdir(value.workspaceParent)).toEqual([]);
  });

  it("requires every declared environment value and caps individual and aggregate bytes", async () => {
    const value = await fixture();
    await expectLaunchCode(
      prepareTargetLaunch({ ...value.options, availableEnvironment: {} }),
      "environment_invalid",
    );
    await expectLaunchCode(
      prepareTargetLaunch({
        ...value.options,
        availableEnvironment: { ALLOWED_TOKEN: "bad\0value" },
      }),
      "environment_invalid",
    );
    await expectLaunchCode(
      prepareTargetLaunch({
        ...value.options,
        availableEnvironment: { ALLOWED_TOKEN: "x".repeat(MAX_TARGET_ENVIRONMENT_VALUE_BYTES + 1) },
      }),
      "environment_invalid",
    );

    const reservedDefinition = releaseDefinition(value.release.build.executableSha256, {
      environmentVariableNames: ["PROOFSTACK_WORKER_OVERRIDE"],
    });
    const reservedRelease = releaseFromDefinition(reservedDefinition);
    await expectLaunchCode(
      prepareTargetLaunch({
        ...value.options,
        availableEnvironment: { PROOFSTACK_WORKER_OVERRIDE: "3" },
        registry: { resolve: async () => rebindResolvedTarget(value.resolved, reservedRelease) },
        startMessage: startFor(reservedRelease),
        targetRelease: reservedRelease,
      }),
      "environment_invalid",
    );

    const names = ["VALUE_A", "VALUE_B", "VALUE_C", "VALUE_D", "VALUE_E"];
    const aggregateDefinition = releaseDefinition(value.release.build.executableSha256, {
      environmentVariableNames: names,
    });
    const aggregateRelease = releaseFromDefinition(aggregateDefinition);
    await expectLaunchCode(
      prepareTargetLaunch({
        ...value.options,
        availableEnvironment: Object.fromEntries(
          names.map((name) => [name, "x".repeat(MAX_TARGET_ENVIRONMENT_VALUE_BYTES)]),
        ),
        registry: { resolve: async () => rebindResolvedTarget(value.resolved, aggregateRelease) },
        startMessage: startFor(aggregateRelease),
        targetRelease: aggregateRelease,
      }),
      "environment_invalid",
    );
    expect(MAX_TARGET_ENVIRONMENT_TOTAL_BYTES).toBeLessThan(
      names.length * MAX_TARGET_ENVIRONMENT_VALUE_BYTES,
    );
  });
});
