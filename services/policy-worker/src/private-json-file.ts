import { constants, type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";

export class PolicyWorkerConfigurationFileError extends Error {
  constructor(options?: ErrorOptions) {
    super("Policy worker configuration file is invalid", options);
    this.name = "PolicyWorkerConfigurationFileError";
  }
}
interface FilePorts {
  readonly open: typeof open;
  readonly ownerUid: (() => number) | undefined;
  readonly noFollow: number | undefined;
  readonly nonBlock: number | undefined;
}
const defaults: FilePorts = {
  open,
  ownerUid: process.getuid,
  noFollow: constants.O_NOFOLLOW,
  nonBlock: constants.O_NONBLOCK,
};
const metadata = (stat: BigIntStats) =>
  [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");

/** Bounded POSIX reference configuration, not a production secret store or OS isolation. */
export async function readPolicyWorkerJsonFile(
  filename: string,
  maximumBytes: number,
  overrides: Partial<FilePorts> = {},
): Promise<unknown> {
  const ports = { ...defaults, ...overrides };
  let handle: FileHandle | undefined;
  let failed = false,
    failure: unknown,
    result: unknown;
  try {
    if (
      !isAbsolute(filename) ||
      filename.length > 4096 ||
      filename.includes("\0") ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > 16 * 1024 * 1024
    )
      throw new PolicyWorkerConfigurationFileError();
    const uid = ports.ownerUid?.();
    if (
      uid === undefined ||
      !Number.isSafeInteger(uid) ||
      uid < 0 ||
      ports.noFollow === undefined ||
      ports.nonBlock === undefined
    )
      throw new PolicyWorkerConfigurationFileError();
    handle = await ports.open(filename, constants.O_RDONLY | ports.noFollow | ports.nonBlock);
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(uid) ||
      (before.mode & 0o077n) !== 0n ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(maximumBytes)
    )
      throw new PolicyWorkerConfigurationFileError();
    const bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > maximumBytes || length !== Number(before.size))
      throw new PolicyWorkerConfigurationFileError();
    const after = await handle.stat({ bigint: true });
    if (metadata(before) !== metadata(after)) throw new PolicyWorkerConfigurationFileError();
    result = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
    );
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (handle) {
    try {
      await handle.close();
    } catch (cleanupError) {
      if (failed)
        throw new PolicyWorkerConfigurationFileError({
          cause: new AggregateError(
            [failure, cleanupError],
            "Configuration read and cleanup failed",
          ),
        });
      throw new PolicyWorkerConfigurationFileError({ cause: cleanupError });
    }
  }
  if (failed) throw new PolicyWorkerConfigurationFileError({ cause: failure });
  return result;
}
