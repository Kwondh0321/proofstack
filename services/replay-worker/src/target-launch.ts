import { createHash } from "node:crypto";
import { constants as fileConstants, createReadStream, type Stats } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  type ReplayWorkerStartTargetMessage,
  ReplayWorkerStartTargetMessageSchema,
  type TargetRelease,
} from "@proofstack/contracts";
import {
  digestRecordedBoundaryReplayInvocationDefinition,
  validateAndProjectTargetRelease,
} from "@proofstack/replay";
import { ReplayTargetLaunchError } from "./errors.js";

export const MAX_TARGET_ENVIRONMENT_VALUE_BYTES = 32_768;
export const MAX_TARGET_ENVIRONMENT_TOTAL_BYTES = 131_072;
export const MAX_TARGET_LAUNCH_ARGUMENTS = 64;
export const MAX_TARGET_LAUNCH_ARGUMENT_BYTES = 4_096;
export const REPLAY_WORKER_ENVIRONMENT_PREFIX = "PROOFSTACK_WORKER_" as const;

export interface ResolvedPreinstalledTarget {
  readonly entryPointPath: string;
  readonly executableSha256: string;
  readonly implementationId: string;
  readonly implementationSha256: string;
  readonly invocationSha256: string;
  readonly launcherArguments: readonly string[];
  readonly launcherPath: string;
  readonly releaseDefinitionSha256: string;
  readonly runtime: TargetRelease["runtime"];
}

export interface PreinstalledTargetRegistry {
  resolve(implementationId: string): Promise<ResolvedPreinstalledTarget | null>;
}

export interface PrepareTargetLaunchOptions {
  readonly availableEnvironment: Readonly<Record<string, string | undefined>>;
  readonly registry: PreinstalledTargetRegistry;
  readonly startMessage: unknown;
  readonly targetRelease: unknown;
  readonly workspaceParent: string;
}

export interface PreparedTargetLaunch {
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly executablePath: string;
  readonly startMessage: ReplayWorkerStartTargetMessage;
  readonly targetRelease: TargetRelease;
  readonly verifiedEntryPointPath: string;
  readonly workspacePath: string;
  cleanup(): Promise<void>;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function targetReference(release: TargetRelease): ReplayWorkerStartTargetMessage["targetRelease"] {
  return {
    definitionSha256: release.definitionSha256,
    targetAdapter: release.targetAdapter,
    targetId: release.targetId,
    targetReleaseId: release.targetReleaseId,
    workerProtocol: release.workerProtocol,
  };
}

function safeLaunchText(value: string, maximumBytes: number): boolean {
  return !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function validateArguments(values: readonly string[]): void {
  if (
    values.length > MAX_TARGET_LAUNCH_ARGUMENTS ||
    values.some((value) => !safeLaunchText(value, MAX_TARGET_LAUNCH_ARGUMENT_BYTES))
  ) {
    throw new ReplayTargetLaunchError("implementation_mismatch");
  }
}

function validateEnvironment(
  release: TargetRelease,
  available: Readonly<Record<string, string | undefined>>,
  workspacePath: string,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    PROOFSTACK_WORKER_PROTOCOL_INPUT_FD: "3",
    PROOFSTACK_WORKER_PROTOCOL_OUTPUT_FD: "4",
    PROOFSTACK_WORKER_WORKSPACE: workspacePath,
  };
  let totalBytes = Object.entries(environment).reduce(
    (total, [name, value]) => total + Buffer.byteLength(name) + Buffer.byteLength(value),
    0,
  );
  for (const name of release.environmentVariableNames) {
    const value = available[name];
    if (
      name.startsWith(REPLAY_WORKER_ENVIRONMENT_PREFIX) ||
      value === undefined ||
      !safeLaunchText(value, MAX_TARGET_ENVIRONMENT_VALUE_BYTES)
    ) {
      throw new ReplayTargetLaunchError("environment_invalid");
    }
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (totalBytes > MAX_TARGET_ENVIRONMENT_TOTAL_BYTES) {
      throw new ReplayTargetLaunchError("environment_invalid");
    }
    environment[name] = value;
  }
  return Object.freeze(environment);
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

async function requireRegularFile(path: string, accessMode: number): Promise<Stats> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new ReplayTargetLaunchError("executable_invalid");
  }
  let metadata: Stats;
  try {
    metadata = await lstat(path);
    await access(path, accessMode);
  } catch (error) {
    throw new ReplayTargetLaunchError("executable_invalid", { cause: error });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ReplayTargetLaunchError("executable_invalid");
  }
  return metadata;
}

function validateResolvedTarget(
  release: TargetRelease & {
    readonly execution: Extract<TargetRelease["execution"], { readonly kind: "preinstalled" }>;
  },
  resolved: ResolvedPreinstalledTarget,
): void {
  if (
    resolved.releaseDefinitionSha256 !== release.definitionSha256 ||
    resolved.implementationId !== release.execution.implementationId ||
    resolved.implementationSha256 !== release.execution.implementationSha256 ||
    resolved.executableSha256 !== release.build.executableSha256 ||
    resolved.invocationSha256 !== release.build.invocationSha256 ||
    !sameJson(resolved.runtime, release.runtime)
  ) {
    throw new ReplayTargetLaunchError("implementation_mismatch");
  }
  validateArguments(resolved.launcherArguments);
}

function validateStart(release: TargetRelease, input: unknown): ReplayWorkerStartTargetMessage {
  const parsed = ReplayWorkerStartTargetMessageSchema.safeParse(input);
  if (!parsed.success || !sameJson(parsed.data.targetRelease, targetReference(release))) {
    throw new ReplayTargetLaunchError("start_message_mismatch", {
      ...(parsed.success ? {} : { cause: parsed.error }),
    });
  }
  for (const boundary of parsed.data.boundaries) {
    if (
      digestRecordedBoundaryReplayInvocationDefinition(boundary.invocation) !==
      boundary.invocationDefinitionSha256
    ) {
      throw new ReplayTargetLaunchError("start_message_mismatch");
    }
  }
  return parsed.data;
}

function validateReleaseForLocalChild(release: TargetRelease): asserts release is TargetRelease & {
  readonly execution: Extract<TargetRelease["execution"], { readonly kind: "preinstalled" }>;
} {
  if (release.execution.kind !== "preinstalled") {
    throw new ReplayTargetLaunchError("unsupported_execution");
  }
  if (release.mounts.length > 0) throw new ReplayTargetLaunchError("unsupported_mounts");
  if (release.subprocessPolicy.mode !== "denied") {
    throw new ReplayTargetLaunchError("unsupported_subprocess_policy");
  }
  if (
    release.runtime.platform !== process.platform ||
    release.runtime.architecture !== process.arch
  ) {
    throw new ReplayTargetLaunchError("runtime_incompatible");
  }
}

export async function prepareTargetLaunch(
  options: PrepareTargetLaunchOptions,
): Promise<PreparedTargetLaunch> {
  let release: TargetRelease;
  try {
    release = validateAndProjectTargetRelease(options.targetRelease).release;
  } catch (error) {
    throw new ReplayTargetLaunchError("invalid_target_release", { cause: error });
  }
  validateReleaseForLocalChild(release);
  const startMessage = validateStart(release, options.startMessage);
  const execution = release.execution;
  const resolved = await options.registry.resolve(execution.implementationId);
  if (!resolved) throw new ReplayTargetLaunchError("implementation_unavailable");
  validateResolvedTarget(release, resolved);
  await requireRegularFile(resolved.entryPointPath, fileConstants.R_OK);
  await requireRegularFile(resolved.launcherPath, fileConstants.R_OK | fileConstants.X_OK);
  if (!isAbsolute(options.workspaceParent) || options.workspaceParent.includes("\0")) {
    throw new ReplayTargetLaunchError("executable_invalid");
  }

  const workspacePath = await mkdtemp(join(options.workspaceParent, "proofstack-target-"));
  try {
    await chmod(workspacePath, 0o700);
    const verifiedEntryPointPath = join(workspacePath, "target", release.runtime.entryPoint);
    await mkdir(dirname(verifiedEntryPointPath), { mode: 0o700, recursive: true });
    await copyFile(resolved.entryPointPath, verifiedEntryPointPath, fileConstants.COPYFILE_EXCL);
    await chmod(verifiedEntryPointPath, 0o500);
    if ((await sha256File(verifiedEntryPointPath)) !== release.build.executableSha256) {
      throw new ReplayTargetLaunchError("executable_mismatch");
    }
    const environment = validateEnvironment(release, options.availableEnvironment, workspacePath);
    let cleaned = false;
    return Object.freeze({
      arguments: Object.freeze([...resolved.launcherArguments, verifiedEntryPointPath]),
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await rm(workspacePath, { force: true, recursive: true });
      },
      environment,
      executablePath: resolved.launcherPath,
      startMessage,
      targetRelease: release,
      verifiedEntryPointPath,
      workspacePath,
    });
  } catch (error) {
    await rm(workspacePath, { force: true, recursive: true });
    throw error;
  }
}

export function targetLaunchEntryPointBasename(launch: PreparedTargetLaunch): string {
  return basename(launch.verifiedEntryPointPath);
}
