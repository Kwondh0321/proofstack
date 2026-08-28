import { describe, expect, it } from "vitest";
import { RecoveryOperationError } from "./errors.js";
import { NativePostgresCommandRunner } from "./postgres-command.js";

const runner = new NativePostgresCommandRunner();

function processEnvironmentValue(name: string): string | undefined {
  return process.env[name];
}

function nodeCommand(source: string, timeoutMs?: number) {
  return {
    arguments: ["-e", source],
    environment: { PATH: processEnvironmentValue("PATH") ?? "" },
    executable: process.execPath,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

describe("native PostgreSQL command runner", () => {
  it("captures bounded standard output and error", async () => {
    await expect(
      runner.run(nodeCommand("process.stdout.write('ready'); process.stderr.write('notice')")),
    ).resolves.toEqual({ stderr: "notice", stdout: "ready" });
  });

  it("reports a non-zero exit without reflecting child output", async () => {
    await expect(
      runner.run(nodeCommand("process.stderr.write('sensitive child detail'); process.exit(7)")),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "recovery_operation_failed",
        reason: "command exited with status 7",
      }),
    );
  });

  it("reports signal termination", async () => {
    await expect(runner.run(nodeCommand("process.kill(process.pid, 'SIGTERM')"))).rejects.toEqual(
      expect.objectContaining({ reason: expect.stringMatching(/^command terminated by signal /u) }),
    );
  });

  it("kills a command after its declared timeout", async () => {
    await expect(runner.run(nodeCommand("setInterval(() => {}, 1000)", 25))).rejects.toEqual(
      expect.objectContaining({ reason: "command timed out" }),
    );
  });

  it.each(["stdout", "stderr"])(
    "kills a command whose %s exceeds the output bound",
    async (stream) => {
      await expect(
        runner.run(nodeCommand(`process.${stream}.write('x'.repeat(70_000))`)),
      ).rejects.toEqual(
        expect.objectContaining({ reason: "command output exceeded the safety limit" }),
      );
    },
  );

  it("reports an executable that cannot be started and preserves the cause", async () => {
    try {
      await runner.run({
        arguments: [],
        environment: {},
        executable: "/proofstack/not/a/real/executable",
        timeoutMs: 1_000,
      });
      expect.fail("expected command startup to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveryOperationError);
      expect(error).toEqual(
        expect.objectContaining({
          reason: "command could not be started",
          cause: expect.any(Error),
        }),
      );
    }
  });
});
