import { describe, expect, it, vi } from "vitest";
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

  it("offers bounded redacted failure diagnostics only to an explicit observer", async () => {
    const onFailure = vi.fn();
    const diagnosticRunner = new NativePostgresCommandRunner({ onFailure });
    const secret = "postgresql://operator:secret@example.test/proofstack";
    await expect(
      diagnosticRunner.run({
        ...nodeCommand(
          "process.stderr.write('connection ' + process.env.PGDATABASE); process.exit(2)",
        ),
        environment: { PATH: processEnvironmentValue("PATH") ?? "", PGDATABASE: secret },
      }),
    ).rejects.toBeInstanceOf(RecoveryOperationError);
    expect(onFailure).toHaveBeenCalledWith({
      exitCode: 2,
      signal: null,
      stderr: "connection [redacted]",
      stdout: "",
    });
  });

  it("does not let a diagnostic observer replace the command failure", async () => {
    const diagnosticRunner = new NativePostgresCommandRunner({
      onFailure: () => {
        throw new Error("observer failed");
      },
    });
    await expect(diagnosticRunner.run(nodeCommand("process.exit(9)"))).rejects.toEqual(
      expect.objectContaining({ reason: "command exited with status 9" }),
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
