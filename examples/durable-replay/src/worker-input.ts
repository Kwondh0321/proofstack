import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  ArtifactContentReferenceSchema,
  EvidenceScopeSchema,
  OpaqueIdSchema,
  RecordedInteractionFixtureContentExportSchema,
  ReplayWorkerMutationFenceSchema,
  Sha256Schema,
  WorkerProtocolReferenceSchema,
} from "@proofstack/contracts";
import type {
  PublishReplayAttemptReportCommand,
  ReplayAttemptReportPublisher,
} from "@proofstack/replay-worker";
import { z } from "zod";

export const MAX_DURABLE_REPLAY_WORKER_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_DATABASE_URL_CHARACTERS = 4_096;
const MAX_PATH_CHARACTERS = 4_096;

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_CHARACTERS)
  .refine((value) => isAbsolute(value) && !value.includes("\0"), "Path must be absolute");
const LeaseDurationSchema = z.number().int().min(100).max(60_000);
const DatabaseUrlSchema = z.string().min(1).max(MAX_DATABASE_URL_CHARACTERS);
const ClaimIdentitySchema = z
  .object({
    attemptId: OpaqueIdSchema,
    leaseId: OpaqueIdSchema,
    workerBuildSha256: Sha256Schema,
    workerId: OpaqueIdSchema,
    workerProtocol: WorkerProtocolReferenceSchema,
  })
  .strict();
const CommonClaimSchema = {
  claim: ClaimIdentitySchema,
  databaseUrl: DatabaseUrlSchema,
  jobId: OpaqueIdSchema,
  leaseDurationMilliseconds: LeaseDurationSchema,
  schemaVersion: z.literal("0.1"),
  scope: EvidenceScopeSchema,
} as const;

export const DurableReplayWorkerCommandSchema = z.discriminatedUnion("command", [
  z
    .object({
      ...CommonClaimSchema,
      command: z.literal("claim"),
    })
    .strict(),
  z
    .object({
      ...CommonClaimSchema,
      command: z.literal("run"),
      contentExport: RecordedInteractionFixtureContentExportSchema,
      heartbeatIntervalMilliseconds: z.number().int().min(25).max(10_000),
      reportDirectory: AbsolutePathSchema,
      targetEntryPointPath: AbsolutePathSchema,
      targetHoldMilliseconds: z.number().int().min(0).max(10_000),
      terminationGraceMilliseconds: z.number().int().min(10).max(10_000),
      workspaceParent: AbsolutePathSchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (value.heartbeatIntervalMilliseconds > Math.floor(value.leaseDurationMilliseconds / 2)) {
        context.addIssue({
          code: "custom",
          message: "Heartbeat interval must not exceed half the lease duration",
          path: ["heartbeatIntervalMilliseconds"],
        });
      }
    }),
  z
    .object({
      command: z.literal("probe_stale_fence"),
      databaseUrl: DatabaseUrlSchema,
      leaseDurationMilliseconds: LeaseDurationSchema,
      schemaVersion: z.literal("0.1"),
      scope: EvidenceScopeSchema,
      workerFence: ReplayWorkerMutationFenceSchema,
    })
    .strict(),
]);

export type DurableReplayWorkerCommand = z.infer<typeof DurableReplayWorkerCommandSchema>;

function privateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

export async function loadDurableReplayWorkerCommand(
  inputPath: string,
): Promise<DurableReplayWorkerCommand> {
  if (!isAbsolute(inputPath) || inputPath.includes("\0")) {
    throw new TypeError("Worker input path must be absolute");
  }
  const before = await lstat(inputPath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !privateMode(before.mode) ||
    before.size < 2 ||
    before.size > MAX_DURABLE_REPLAY_WORKER_INPUT_BYTES
  ) {
    throw new TypeError("Worker input must be a private bounded regular file");
  }
  const handle = await open(inputPath, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    /* v8 ignore next 7 -- This is a fail-closed TOCTOU guard after O_NOFOLLOW; deterministic tests cannot replace an open inode portably. */
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    ) {
      throw new TypeError("Worker input changed during secure open");
    }
    const bytes = await handle.readFile();
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new TypeError("Worker input must contain valid JSON", { cause: error });
    }
    return DurableReplayWorkerCommandSchema.parse(parsed);
  } finally {
    await handle.close();
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function requirePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !privateMode(metadata.mode)) {
    throw new TypeError("Replay report directory must be private and must not be a symlink");
  }
}

export async function createLocalReplayReportPublisher(
  directory: string,
): Promise<ReplayAttemptReportPublisher> {
  if (!isAbsolute(directory) || directory.includes("\0")) {
    throw new TypeError("Replay report directory must be absolute");
  }
  await requirePrivateDirectory(directory);
  return Object.freeze({
    publish: async (command: PublishReplayAttemptReportCommand): Promise<unknown> => {
      const reference = command.contentReference;
      if (
        command.signal.aborted ||
        command.content.byteLength !== reference.sizeBytes ||
        sha256(command.content) !== reference.sha256
      ) {
        throw new TypeError("Replay report does not match its immutable content reference");
      }
      const path = join(directory, `${reference.artifactId}.json`);
      let handle: FileHandle | undefined;
      try {
        handle = await open(
          path,
          fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_WRONLY,
          0o600,
        );
        await handle.writeFile(command.content);
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : undefined;
        if (code !== "EEXIST") throw error;
        const existing = await readFile(path);
        if (!existing.equals(Buffer.from(command.content))) {
          throw new TypeError("Replay report identifier is already bound to different bytes");
        }
      } finally {
        await handle?.close();
      }
      return reference;
    },
  });
}

export async function readLocalReplayReport(
  directory: string,
  inputReference: unknown,
): Promise<Uint8Array> {
  if (!isAbsolute(directory) || directory.includes("\0")) {
    throw new TypeError("Replay report directory must be absolute");
  }
  const reference = ArtifactContentReferenceSchema.parse(inputReference);
  const directoryMetadata = await lstat(directory);
  if (
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink() ||
    !privateMode(directoryMetadata.mode)
  ) {
    throw new TypeError("Replay report directory must be a private real directory");
  }
  const path = join(directory, `${reference.artifactId}.json`);
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !privateMode(before.mode) ||
    before.size !== reference.sizeBytes
  ) {
    throw new TypeError("Replay report must be an exact private regular file");
  }
  const handle = await open(path, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    ) {
      throw new TypeError("Replay report changed during secure open");
    }
    const content = await handle.readFile();
    if (content.byteLength !== reference.sizeBytes || sha256(content) !== reference.sha256) {
      throw new TypeError("Replay report does not match its immutable content reference");
    }
    return Uint8Array.from(content);
  } finally {
    await handle.close();
  }
}
