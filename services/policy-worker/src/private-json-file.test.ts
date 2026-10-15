import {
  mkdtemp,
  writeFile,
  chmod,
  rm,
  open,
  symlink,
  link,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PolicyWorkerConfigurationFileError,
  readPolicyWorkerJsonFile,
} from "./private-json-file.js";

let root: string;
let sequence = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "proofstack-private-config-"));
  await chmod(root, 0o700);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
async function file(data: string | Uint8Array = '{"ok":true}') {
  const path = join(root, `config_${sequence++}.json`);
  await writeFile(path, data, { mode: 0o600, flag: "wx" });
  return path;
}
function intercepted(hook: (handle: FileHandle) => void) {
  return {
    open: (async (path: string, flags: number) => {
      const handle = await open(path, flags);
      hook(handle);
      return handle;
    }) as typeof open,
  };
}
describe("bounded owner-only configuration file reads", () => {
  it("reads complete strict UTF8 JSON at the exact byte ceiling and closes its descriptor", async () => {
    const path = await file();
    let handle!: FileHandle;
    expect(
      await readPolicyWorkerJsonFile(
        path,
        11,
        intercepted((value) => {
          handle = value;
        }),
      ),
    ).toEqual({ ok: true });
    await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
  });
  it("handles partial physical reads without treating a short read as EOF", async () => {
    const path = await file();
    let reads = 0;
    const ports = intercepted((handle) => {
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation((async (
        buffer: Buffer,
        offset: number,
        _length: number,
        position: number,
      ) => {
        reads++;
        return read(buffer, offset, 1, position);
      }) as never);
    });
    expect(await readPolicyWorkerJsonFile(path, 11, ports)).toEqual({ ok: true });
    expect(reads).toBeGreaterThan(2);
  });
  it.each(["relative.json", "/" + "x".repeat(4096), "/tmp/nul" + String.fromCharCode(0)])(
    "rejects invalid paths before opening %#",
    async (path) => {
      const open = vi.fn();
      await expect(readPolicyWorkerJsonFile(path, 64, { open })).rejects.toBeInstanceOf(
        PolicyWorkerConfigurationFileError,
      );
      expect(open).not.toHaveBeenCalled();
    },
  );
  it.each([0, -1, 1.5, NaN, 16 * 1024 * 1024 + 1])(
    "rejects invalid byte limits before opening %s",
    async (limit) => {
      const open = vi.fn();
      await expect(readPolicyWorkerJsonFile("/tmp/config", limit, { open })).rejects.toBeInstanceOf(
        PolicyWorkerConfigurationFileError,
      );
      expect(open).not.toHaveBeenCalled();
    },
  );
  it.each([
    { ownerUid: undefined },
    { ownerUid: () => NaN },
    { ownerUid: () => -1 },
    { noFollow: undefined },
    { nonBlock: undefined },
  ])(
    "fails closed if required POSIX ownership/open protections are unavailable %#",
    async (ports) => {
      const open = vi.fn();
      await expect(
        readPolicyWorkerJsonFile("/tmp/config", 64, { ...ports, open }),
      ).rejects.toBeInstanceOf(PolicyWorkerConfigurationFileError);
      expect(open).not.toHaveBeenCalled();
    },
  );
  it("refuses missing files without exposing their path in the public message", async () => {
    const path = join(root, "missing-private.json");
    const error = await readPolicyWorkerJsonFile(path, 64).catch((error) => error);
    expect(error).toBeInstanceOf(PolicyWorkerConfigurationFileError);
    if (!(error instanceof PolicyWorkerConfigurationFileError))
      throw new Error("Expected file rejection");
    expect(error.message).not.toContain(path);
  });
  it("refuses directories", async () => {
    await expect(readPolicyWorkerJsonFile(root, 64)).rejects.toBeInstanceOf(
      PolicyWorkerConfigurationFileError,
    );
  });
  it("does not follow a final symlink", async () => {
    const path = await file(),
      alias = join(root, `symlink_${sequence++}`);
    await symlink(path, alias);
    await expect(readPolicyWorkerJsonFile(alias, 64)).rejects.toBeInstanceOf(
      PolicyWorkerConfigurationFileError,
    );
  });
  it("does not block opening a FIFO as a regular configuration file", async () => {
    const path = join(root, `fifo_${sequence++}`);
    execFileSync("mkfifo", [path]);
    await chmod(path, 0o600);
    await expect(readPolicyWorkerJsonFile(path, 64)).rejects.toBeInstanceOf(
      PolicyWorkerConfigurationFileError,
    );
  });
  it("refuses a file owned by a different principal", async () => {
    const path = await file();
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("POSIX fixture uid is unavailable");
    await expect(
      readPolicyWorkerJsonFile(path, 64, { ownerUid: () => uid + 1 }),
    ).rejects.toBeInstanceOf(PolicyWorkerConfigurationFileError);
  });
  it.each([0o640, 0o620, 0o604, 0o602])("refuses group/other access mode %s", async (mode) => {
    const path = await file();
    await chmod(path, mode);
    await expect(readPolicyWorkerJsonFile(path, 64)).rejects.toBeInstanceOf(
      PolicyWorkerConfigurationFileError,
    );
  });
  it("refuses hard-linked credential/configuration files", async () => {
    const path = await file();
    await link(path, join(root, `hardlink_${sequence++}`));
    await expect(readPolicyWorkerJsonFile(path, 64)).rejects.toBeInstanceOf(
      PolicyWorkerConfigurationFileError,
    );
  });
  it.each(["", '"' + "x".repeat(64) + '"'])(
    "refuses empty or oversized files %#",
    async (content) => {
      await expect(readPolicyWorkerJsonFile(await file(content), 64)).rejects.toBeInstanceOf(
        PolicyWorkerConfigurationFileError,
      );
    },
  );
  it.each(["{", new Uint8Array([255])])("refuses invalid JSON or UTF8 %#", async (bytes) => {
    await expect(readPolicyWorkerJsonFile(await file(bytes), 64)).rejects.toBeInstanceOf(
      PolicyWorkerConfigurationFileError,
    );
  });
  it.each(["growth", "truncation", "metadata"])("refuses concurrent file %s", async (kind) => {
    const path = await file();
    let observed = 0;
    const ports = intercepted((handle) => {
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation((async () => {
        const value = await stat({ bigint: true });
        observed++;
        if (kind === "growth") value.size = 1n;
        if (kind === "truncation") value.size = 12n;
        if (kind === "metadata" && observed === 2) value.ctimeNs++;
        return value;
      }) as never);
    });
    await expect(
      readPolicyWorkerJsonFile(path, kind === "growth" ? 1 : 64, ports),
    ).rejects.toBeInstanceOf(PolicyWorkerConfigurationFileError);
  });
  it("closes after a read failure and preserves its cause", async () => {
    const failure = new Error("read_failed");
    let closed = false;
    const ports = intercepted((handle) => {
      vi.spyOn(handle, "read").mockRejectedValue(failure);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closed = true;
        await close();
      });
    });
    const error = await readPolicyWorkerJsonFile(await file(), 64, ports).catch((error) => error);
    if (!(error instanceof PolicyWorkerConfigurationFileError))
      throw new Error("Expected file rejection");
    expect(error.cause).toBe(failure);
    expect(closed).toBe(true);
  });
  it.each([false, true])("preserves cleanup failure with prior read failure=%s", async (failed) => {
    const readFailure = new Error("read_failed"),
      cleanupFailure = new Error("close_failed");
    const ports = intercepted((handle) => {
      if (failed) vi.spyOn(handle, "read").mockRejectedValue(readFailure);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        throw cleanupFailure;
      });
    });
    const error = await readPolicyWorkerJsonFile(await file(), 64, ports).catch((error) => error);
    expect(error).toBeInstanceOf(PolicyWorkerConfigurationFileError);
    if (!(error instanceof PolicyWorkerConfigurationFileError))
      throw new Error("Expected file rejection");
    if (failed) {
      if (!(error.cause instanceof AggregateError)) throw new Error("Expected both errors");
      expect(error.cause.errors).toEqual([readFailure, cleanupFailure]);
    } else expect(error.cause).toBe(cleanupFailure);
  });
});
